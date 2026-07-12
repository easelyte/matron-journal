#!/usr/bin/env node
// WAL/GC stall profiler — attributes the rare latency stalls found by
// tools/load-test.js (docs/load-test-results.md "Concern worth flagging
// honestly": isolated append-latency maxima of 0.5–3.7s tracking the
// event-loop-lag max 1:1, p99 unaffected).
//
// Reuses the load test's traffic generator verbatim (same agent mix, hot
// viewer, live-follower probe observer; no cold client — the baseline doc
// already established the stalls appear independent of the cold replay) and
// adds the instrumentation the load test deliberately lacks:
//
//   - every statement / transaction / pragma on the server's db handle is
//     timed; anything >= --slow-stmt ms is logged with the WAL-index state
//     (mxFrame/nBackfill) before and after, so a commit that ran SQLite's
//     auto-checkpoint is directly visible as an nBackfill jump / mxFrame
//     reset inside that statement's window.
//   - WAL-index state is read from the -shm file (readWalState below), NOT
//     via `PRAGMA wal_checkpoint`, which would RUN a checkpoint and
//     contaminate the measurement. A 25ms sampler provides the checkpoint
//     census and WAL-size bound independent of the slow-statement log.
//   - PerformanceObserver('gc') timestamps every GC with kind + duration
//     (no --expose-gc needed), so a stall coinciding with a major GC is
//     attributed to GC, not checkpointing.
//   - a 10ms-tick loop-stall logger timestamps every event-loop blockage
//     >= --loop-stall ms and records the process CPU consumed during the
//     blockage: a busy stall (cpu ~= wall) is JS/GC/SQLite work; an idle
//     stall (cpu << wall) is the thread blocked in a syscall (fsync) or
//     descheduled by the OS.
//
// Modes:
//   default        server + generator share one process (same bias as the
//                  load test — numbers comparable to the baseline doc).
//   --out-of-proc  server runs in a forked child (this same file with
//                  --child-server); the generator drives it over localhost
//                  ws from the parent. Append latency then includes real
//                  IPC, but server-side stalls are measured in a process
//                  the generator cannot pause — the honest split the
//                  baseline doc asked for. Generator-side GC/loop stalls
//                  are logged too, so a stall that exists only in the
//                  parent is attributed to the generator, not the server.
//
// Every append-latency sample > --stall-threshold ms is clustered (samples
// whose in-flight windows overlap belong to one blockage — a single 500ms
// pause delays every probe in flight, ~90 probes/s are in flight) and each
// cluster is attributed: checkpoint / gc / sqlite-stmt / generator /
// unknown, with the raw evidence printed. Server loop stalls that no probe
// happened to straddle get their own rows.
//
// Instrumentation gaps, disclosed: ws.js's cached `deviceExistsStmt`
// (prepared before instrumentation attaches) is not timed — it is a
// read-only point SELECT and cannot trigger a checkpoint. Timestamps are
// Date.now() epochs (shared clock across processes); 1ms granularity is
// ample for >=100ms stalls.
//
// Usage:
//   node tools/wal-profile.js [--duration=120] [--agents=10] [--convos=300]
//     [--out-of-proc] [--stall-threshold=100] [--slow-stmt=20]
//     [--loop-stall=50] [--json-out=path] [--keep-db]
//
// Mitigation experiment flags (applied to the SERVER's db handle so
// candidates can be measured before any src/ change is committed):
//   --wal-autocheckpoint=N   PRAGMA wal_autocheckpoint=N (0 disables)
//   --ckpt-interval=MS       run PRAGMA wal_checkpoint(PASSIVE) on a timer;
//                            every timer checkpoint's duration + result
//                            (busy/log/checkpointed) is logged, so the
//                            mitigation's own blocking cost gets a full
//                            distribution, not just its slow tail
//   --journal-size-limit=B   PRAGMA journal_size_limit=B (WAL truncates to
//                            <=B on reset instead of keeping its high-water
//                            size forever)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fork } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PerformanceObserver, performance, constants as perfConstants, monitorEventLoopDelay,
} from 'node:perf_hooks'
import { startServer } from '../src/server.js'
import { createUser, createAgent, login } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { openDb } from '../src/db.js'
import {
  DEFAULTS as LOAD_DEFAULTS, percentiles, makeLatencyTracker, connectWs,
  runAgentSession, assignConvoPools,
} from './load-test.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

// --- WAL-index reader (read-only; never checkpoints) -------------------------
// Field offsets per SQLite wal.c, stored in native byte order (LE on x86):
//   WalIndexHdr copy 1 @0 (48 bytes): isInit @12 (u8), mxFrame @16 (u32) —
//   the number of valid frames in the WAL; copy 2 @48 (mxFrame @64, used as
//   a torn-read guard). WalCkptInfo @96: nBackfill @96 (frames already
//   copied back into the main db), nBackfillAttempted @128.
// A checkpoint appears as nBackfill rising toward mxFrame; the WAL reset on
// the first write after a complete checkpoint appears as mxFrame dropping.
export function readWalState(dbPath) {
  let fd
  try {
    fd = fs.openSync(dbPath + '-shm', 'r')
  } catch {
    return null // no -shm yet (db not opened in WAL mode yet)
  }
  try {
    const buf = Buffer.alloc(136)
    let n = fs.readSync(fd, buf, 0, 136, 0)
    if (n < 136 || buf[12] === 0) return null
    if (buf.readUInt32LE(16) !== buf.readUInt32LE(64)) {
      n = fs.readSync(fd, buf, 0, 136, 0) // torn read: retry once
      if (n < 136) return null
    }
    const out = {
      mxFrame: buf.readUInt32LE(16),
      nBackfill: buf.readUInt32LE(96),
      nBackfillAttempted: buf.readUInt32LE(128),
      walBytes: 0,
    }
    try { out.walBytes = fs.statSync(dbPath + '-wal').size } catch { /* no wal file */ }
    return out
  } catch {
    return null
  } finally {
    try { fs.closeSync(fd) } catch { /* already closed */ }
  }
}

function makeWalSampler(dbPath, intervalMs = 25) {
  const samples = []
  const take = () => { const w = readWalState(dbPath); if (w) samples.push({ atMs: Date.now(), ...w }) }
  take()
  const iv = setInterval(take, intervalMs)
  iv.unref()
  return {
    samples,
    latestBefore(t) {
      for (let i = samples.length - 1; i >= 0; i--) if (samples[i].atMs <= t) return samples[i]
      return samples[0] ?? null
    },
    now: () => readWalState(dbPath),
    stop: () => { clearInterval(iv); take() },
  }
}

// Checkpoint census from the 25ms samples: every mxFrame drop between
// consecutive samples is a completed checkpoint + WAL reset (the only thing
// that shrinks mxFrame); nBackfill rises count backfill activity that did
// not (yet) reset the WAL. Also tracks the WAL high-water marks.
function checkpointCensus(samples) {
  let resets = 0
  let backfills = 0
  let maxWalBytes = 0
  let maxMxFrame = 0
  for (let i = 0; i < samples.length; i++) {
    maxWalBytes = Math.max(maxWalBytes, samples[i].walBytes)
    maxMxFrame = Math.max(maxMxFrame, samples[i].mxFrame)
    if (i === 0) continue
    if (samples[i].mxFrame < samples[i - 1].mxFrame) resets++
    else if (samples[i].nBackfill > samples[i - 1].nBackfill) backfills++
  }
  return { resets, backfills, maxWalBytes, maxMxFrame, sampleCount: samples.length }
}

// --- GC log -------------------------------------------------------------------
function gcKindName(kind) {
  const c = perfConstants
  if (kind === c.NODE_PERFORMANCE_GC_MAJOR) return 'major'
  if (kind === c.NODE_PERFORMANCE_GC_MINOR) return 'minor'
  if (kind === c.NODE_PERFORMANCE_GC_INCREMENTAL) return 'incremental'
  if (kind === c.NODE_PERFORMANCE_GC_WEAKCB) return 'weakcb'
  return `kind:${kind}`
}

function makeGcLog() {
  const entries = []
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const atMs = performance.timeOrigin + e.startTime
      entries.push({
        atMs: Math.round(atMs), endMs: Math.round(atMs + e.duration),
        durMs: +e.duration.toFixed(2), gcKind: gcKindName(e.detail?.kind),
      })
    }
  })
  obs.observe({ entryTypes: ['gc'] })
  return { entries, stop: () => obs.disconnect() }
}

// --- loop-stall log -----------------------------------------------------------
// A 10ms repeating timer; when a tick lands >= thresholdMs late the loop was
// blocked (or the process descheduled) for that long. cpuMs is the process
// CPU consumed across the blocked window: cpu ~= wall means the thread was
// BUSY (JS / GC / SQLite page copying); cpu << wall means it was BLOCKED
// (fsync, other syscall) or starved by the scheduler. The blockage start has
// +-tickMs uncertainty — irrelevant at the >=100ms scale under study.
function makeLoopStallLog({ thresholdMs = 50, tickMs = 10 } = {}) {
  const stalls = []
  let stopped = false
  let lastAt = Date.now()
  let lastCpu = process.cpuUsage()
  let timer = null
  const tick = () => {
    if (stopped) return
    const now = Date.now()
    const cpu = process.cpuUsage()
    const lagMs = now - lastAt - tickMs
    if (lagMs >= thresholdMs) {
      stalls.push({
        atMs: lastAt, endMs: now, lagMs,
        cpuMs: +((cpu.user + cpu.system - lastCpu.user - lastCpu.system) / 1000).toFixed(1),
      })
    }
    lastAt = now
    lastCpu = cpu
    timer = setTimeout(tick, tickMs)
    timer.unref()
  }
  timer = setTimeout(tick, tickMs)
  timer.unref()
  return { stalls, stop: () => { stopped = true; if (timer) clearTimeout(timer) } }
}

// --- db instrumentation ---------------------------------------------------------
// Wraps prepare()'s run/get/all, transaction(), and pragma() on the LIVE db
// handle. journal.js/auth.js/http.js call db.prepare() per invocation, so
// everything on the append path flows through the wrapper. SQLite's
// auto-checkpoint runs inside the COMMIT — i.e. inside a wrapped
// transaction() call or a wrapped autocommit run() — so a checkpoint stall
// lands in exactly one logged entry, with WAL state deltas as the
// fingerprint. walBefore comes from the 25ms sampler (<=25ms stale, only
// consulted for entries that were slow anyway); walAfter is a fresh read.
function instrumentDb(db, walSampler, { slowMs = 20 } = {}) {
  const slowStmts = []
  const record = (kind, sql, t0, t1) => {
    slowStmts.push({
      atMs: t0, endMs: t1, durMs: t1 - t0, kind,
      sql: String(sql).replace(/\s+/g, ' ').slice(0, 90),
      walBefore: walSampler.latestBefore(t0),
      walAfter: walSampler.now(),
    })
  }
  const wrapMethod = (obj, name, kind, sqlDesc) => {
    const orig = obj[name].bind(obj)
    obj[name] = (...args) => {
      const t0 = Date.now()
      const r = orig(...args)
      const t1 = Date.now()
      if (t1 - t0 >= slowMs) record(kind, sqlDesc ?? args[0], t0, t1)
      return r
    }
  }
  const origPrepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    const stmt = origPrepare(sql)
    for (const m of ['run', 'get', 'all']) wrapMethod(stmt, m, 'stmt', sql)
    return stmt
  }
  const origTx = db.transaction.bind(db)
  db.transaction = (fn) => {
    const inner = origTx(fn)
    const wrapped = (...args) => {
      const t0 = Date.now()
      const r = inner(...args)
      const t1 = Date.now()
      if (t1 - t0 >= slowMs) record('transaction', `[tx ${fn.name || 'anonymous'}]`, t0, t1)
      return r
    }
    wrapped.deferred = inner.deferred
    wrapped.immediate = inner.immediate
    wrapped.exclusive = inner.exclusive
    return wrapped
  }
  wrapMethod(db, 'pragma', 'pragma')
  return { slowStmts }
}

// --- mitigation experiment knobs -------------------------------------------------
// Applies candidate settings to the live server db handle and (optionally)
// runs the explicit PASSIVE-checkpoint timer that candidate B productizes.
// Every timer checkpoint is logged unconditionally (atMs, durMs, and
// SQLite's busy/log/checkpointed counters) — the mitigation still blocks the
// loop while it runs, so its full duration distribution is part of the data.
function applyExperiment(db, exp) {
  const applied = {}
  if (exp.walAutocheckpoint != null) {
    db.pragma(`wal_autocheckpoint = ${Number(exp.walAutocheckpoint)}`)
    applied.walAutocheckpoint = Number(exp.walAutocheckpoint)
  }
  if (exp.journalSizeLimit != null) {
    db.pragma(`journal_size_limit = ${Number(exp.journalSizeLimit)}`)
    applied.journalSizeLimit = Number(exp.journalSizeLimit)
  }
  const ckptLog = []
  let timer = null
  if (exp.ckptIntervalMs != null) {
    applied.ckptIntervalMs = Number(exp.ckptIntervalMs)
    timer = setInterval(() => {
      const t0 = Date.now()
      const r = db.pragma('wal_checkpoint(PASSIVE)')
      const t1 = Date.now()
      ckptLog.push({ atMs: t0, durMs: t1 - t0, ...(Array.isArray(r) ? r[0] : r) })
    }, applied.ckptIntervalMs)
    timer.unref()
  }
  return { applied, ckptLog, stop: () => { if (timer) clearInterval(timer) } }
}

// --- server-side instrumentation bundle ----------------------------------------
function attachServerInstrumentation(db, dbPath, { slowStmtMs, loopStallMs, experiment = {} }) {
  const walSampler = makeWalSampler(dbPath)
  const gc = makeGcLog()
  const loopLog = makeLoopStallLog({ thresholdMs: loopStallMs })
  const { slowStmts } = instrumentDb(db, walSampler, { slowMs: slowStmtMs })
  // after instrumentDb so the timer's pragma calls also hit the slow log
  const exp = applyExperiment(db, experiment)
  const loopDelay = monitorEventLoopDelay({ resolution: 2 })
  loopDelay.enable()
  return {
    stop() {
      loopDelay.disable()
      walSampler.stop()
      gc.stop()
      loopLog.stop()
      exp.stop()
      const p = (x) => +(loopDelay.percentile(x) / 1e6).toFixed(2)
      return {
        experiment: exp.applied,
        timerCheckpoints: exp.ckptLog,
        slowStmts,
        gc: gc.entries,
        loopStalls: loopLog.stalls,
        walSamples: walSampler.samples,
        eventLoopLagMs: { p50: p(50), p95: p(95), p99: p(99), max: +(loopDelay.max / 1e6).toFixed(2) },
        rssMb: +(process.memoryUsage().rss / 1e6).toFixed(1),
        pragmas: {
          synchronous: db.pragma('synchronous', { simple: true }),
          wal_autocheckpoint: db.pragma('wal_autocheckpoint', { simple: true }),
          journal_size_limit: db.pragma('journal_size_limit', { simple: true }),
          page_size: db.pragma('page_size', { simple: true }),
        },
      }
    },
  }
}

// --- provisioning (same shape as tools/load-test.js) ----------------------------
async function provision(db, { numAgents, numConvos }) {
  const password = `walprof-${crypto.randomBytes(8).toString('hex')}`
  const user = await createUser(db, 'walprof', password)
  const agents = []
  for (let i = 0; i < numAgents; i++) {
    agents.push({ idx: i, ...createAgent(db, user.id, `agent-${i}`) })
  }
  const clients = {
    hotViewer: (await login(db, { username: 'walprof', password, deviceName: 'hot-viewer' })).token,
    liveFollower: (await login(db, { username: 'walprof', password, deviceName: 'live-follower' })).token,
  }
  for (let i = 0; i < numConvos; i++) {
    upsertConversation(db, { id: `convo-${i}`, ownerUserId: user.id, title: `WAL Profile Convo ${i}`, sessionState: 'running' })
  }
  return { user, agents, clients }
}

// --- traffic (same mix as the load test, minus the cold client) -----------------
async function runTraffic({ base, agents, clients, numConvos, rates, durationMs, drainMs = 1500, ackIntervalMs = 1000 }) {
  const sockets = []
  const timers = []
  try {
    const hotConvoId = 'convo-0'
    const restConvos = Array.from({ length: Math.max(numConvos - 1, 0) }, (_, i) => `convo-${i + 1}`)
    const nonHotAgents = Math.max(agents.length - 1, 1)
    const pools = restConvos.length > 0 ? assignConvoPools(restConvos, nonHotAgents) : Array.from({ length: nonHotAgents }, () => [hotConvoId])

    const ephemeral = { streamSent: 0, activitySent: 0, streamReceived: 0, activityReceived: 0 }
    const hot = await connectWs(base, {
      token: clients.hotViewer, cursor: null,
      onFrame: (msg) => {
        if (msg.kind !== 'ephemeral' || msg.convo_id !== hotConvoId) return
        if (msg.activity) ephemeral.activityReceived++
        else ephemeral.streamReceived++
      },
    })
    sockets.push(hot.ws)
    hot.ws.send(JSON.stringify({ op: 'viewing', convo_id: hotConvoId }))

    const latency = makeLatencyTracker()
    let liveMaxSeq = 0
    const live = await connectWs(base, {
      token: clients.liveFollower, cursor: 0,
      onFrame: (msg) => {
        if (msg.kind !== 'journal') return
        if (msg.seq > liveMaxSeq) liveMaxSeq = msg.seq
        if (msg.payload && typeof msg.payload._probe === 'number') latency.observe(msg.payload._probe)
      },
    })
    sockets.push(live.ws)
    const ack = setInterval(() => {
      if (live.ws.readyState === 1) live.ws.send(JSON.stringify({ op: 'ack', cursor: liveMaxSeq }))
    }, ackIntervalMs)
    ack.unref()
    timers.push(ack)

    const agentConns = await Promise.all(agents.map(async (a) => {
      const c = await connectWs(base, { token: a.token, cursor: null })
      sockets.push(c.ws)
      return { ...a, ws: c.ws }
    }))

    const endAtMs = Number(process.hrtime.bigint()) / 1e6 + durationMs // runAgentSession's clock
    const startedAtEpoch = Date.now()
    await Promise.all(agentConns.map((a) => runAgentSession({
      id: a.idx, ws: a.ws, hot: a.idx === 0,
      convoIds: a.idx === 0 ? ['convo-0'] : pools[a.idx - 1],
      rates, endAtMs, latency, ephemeral,
    })))

    const drainDeadline = Date.now() + drainMs
    while (Date.now() < drainDeadline && latency.pendingCount() > 0) await sleep(50)

    return { latency, ephemeral, startedAtEpoch, endedAtEpoch: Date.now() }
  } finally {
    for (const t of timers) clearInterval(t)
    for (const ws of sockets) { try { ws.terminate() } catch { /* already dead */ } }
  }
}

// --- stall clustering + attribution ----------------------------------------------
const overlapMs = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))

// One event-loop blockage delays every probe in flight (~90/s are), so raw
// >threshold samples arrive in bursts sharing one cause. Interval-merge
// their [sentAt, observedAt] windows: each merged cluster is one stall
// event. maxLatencyMs is the worst sample in the cluster (the number the
// baseline doc reports as "max").
function clusterStallSamples(samples, thresholdMs) {
  const stalls = samples
    .filter((s) => s.latencyMs > thresholdMs)
    .sort((a, b) => a.sentAt - b.sentAt)
  const clusters = []
  for (const s of stalls) {
    const last = clusters[clusters.length - 1]
    if (last && s.sentAt <= last.endMs) {
      last.endMs = Math.max(last.endMs, s.observedAt)
      last.n++
      last.maxLatencyMs = Math.max(last.maxLatencyMs, s.latencyMs)
    } else {
      clusters.push({ atMs: s.sentAt, endMs: s.observedAt, n: 1, maxLatencyMs: s.latencyMs })
    }
  }
  return clusters
}

// Attribute one stall window. Evidence sources, in order of specificity:
// slow statements with WAL-state deltas (checkpoint fingerprint: nBackfill
// jumped or mxFrame reset INSIDE the statement), GC records, plain slow
// statements, server/generator loop stalls with their cpu profile.
function attributeStall(win, ev, { mode, pad = 15 }) {
  const w0 = win.atMs - pad
  const w1 = win.endMs + pad
  const within = (e) => overlapMs(w0, w1, e.atMs, e.endMs) > 0
  const dur = win.endMs - win.atMs

  const slow = (ev.slowStmts || []).filter(within)
  const isCkpt = (s) => s.walBefore && s.walAfter &&
    (s.walAfter.nBackfill > s.walBefore.nBackfill || s.walAfter.mxFrame < s.walBefore.mxFrame)
  const ckptStmts = slow.filter(isCkpt)
  const otherStmts = slow.filter((s) => !isCkpt(s))
  const gcs = (ev.gc || []).filter(within).filter((g) => g.durMs >= 10)
  const srvLoop = (ev.loopStalls || []).filter(within)
  const genLoop = (ev.genLoopStalls || []).filter(within)
  const genGcs = (ev.genGc || []).filter(within).filter((g) => g.durMs >= 10)

  const cover = (arr) => arr.reduce((m, e) => Math.max(m, overlapMs(w0, w1, e.atMs, e.endMs)), 0)
  const ckptMs = cover(ckptStmts)
  const gcMs = cover(gcs)
  const stmtMs = cover(otherStmts)
  const srvLoopMs = cover(srvLoop)

  const bits = []
  for (const s of ckptStmts) {
    bits.push(`ckpt-in-${s.kind} ${s.durMs}ms "${s.sql.slice(0, 40)}" wal ${s.walBefore.mxFrame}->${s.walAfter.mxFrame} frames, backfill ${s.walBefore.nBackfill}->${s.walAfter.nBackfill}`)
  }
  for (const g of gcs) bits.push(`server gc ${g.gcKind} ${g.durMs}ms`)
  for (const s of otherStmts) bits.push(`slow ${s.kind} ${s.durMs}ms "${s.sql.slice(0, 40)}"`)
  for (const l of srvLoop) bits.push(`server loop stall ${l.lagMs}ms (cpu ${l.cpuMs}ms)`)
  for (const l of genLoop) bits.push(`generator loop stall ${l.lagMs}ms (cpu ${l.cpuMs}ms)`)
  for (const g of genGcs) bits.push(`generator gc ${g.gcKind} ${g.durMs}ms`)

  let verdict
  const strongest = Math.max(ckptMs, gcMs, stmtMs)
  if (strongest >= dur * 0.4 || strongest >= 100) {
    verdict = ckptMs === strongest ? 'checkpoint' : gcMs === strongest ? 'gc' : 'sqlite-stmt'
  } else if (mode === 'out-of-proc' && srvLoopMs < dur * 0.3) {
    verdict = (genLoop.length > 0 || genGcs.length > 0) ? 'generator' : 'unknown (no server-side stall; client/transport side)'
  } else if (srvLoop.length > 0) {
    const busy = srvLoop.some((l) => l.cpuMs >= l.lagMs * 0.6)
    verdict = busy
      ? 'unknown (server loop busy — uninstrumented JS/native work)'
      : 'unknown (server loop blocked/descheduled — cpu idle during stall)'
  } else {
    verdict = mode === 'out-of-proc' ? 'unknown' : 'unknown (shared process; no instrumented cause)'
  }
  return { verdict, evidence: bits.join('; ') || 'no instrumented event overlapped the window' }
}

function buildStallTable({ latencySamples, serverData, genData, mode, stallThresholdMs, t0 }) {
  const ev = {
    slowStmts: serverData.slowStmts,
    gc: serverData.gc,
    loopStalls: serverData.loopStalls,
    genLoopStalls: genData ? genData.loopStalls : [],
    genGc: genData ? genData.gc : [],
  }
  const clusters = clusterStallSamples(latencySamples, stallThresholdMs)
  const rows = clusters.map((c) => ({
    tPlusS: +((c.atMs - t0) / 1000).toFixed(1),
    source: 'append-probe', durMs: Math.round(c.maxLatencyMs), samples: c.n,
    ...attributeStall(c, ev, { mode }),
  }))
  // Server loop stalls > threshold that no probe cluster straddled.
  for (const l of serverData.loopStalls.filter((l) => l.lagMs > stallThresholdMs)) {
    const covered = clusters.some((c) => overlapMs(c.atMs - 15, c.endMs + 15, l.atMs, l.endMs) > 0)
    if (covered) continue
    rows.push({
      tPlusS: +((l.atMs - t0) / 1000).toFixed(1),
      source: 'server-loop', durMs: l.lagMs, samples: 0,
      ...attributeStall(l, ev, { mode }),
    })
  }
  rows.sort((a, b) => a.tPlusS - b.tPlusS)
  return rows
}

// --- child-server role ------------------------------------------------------------
async function runChildServer(args) {
  const dbPath = args.db
  const s = await startServer({ dbPath, port: 0, bind: '127.0.0.1' })
  const instr = attachServerInstrumentation(s.db, dbPath, {
    slowStmtMs: Number(args['slow-stmt'] ?? 20),
    loopStallMs: Number(args['loop-stall'] ?? 50),
  })
  process.send({ op: 'ready', port: s.port, pid: process.pid })
  process.on('message', async (msg) => {
    if (!msg || msg.op !== 'finish') return
    const data = instr.stop()
    process.send({ op: 'result', data }, async () => {
      await s.close()
      process.exit(0)
    })
  })
}

// --- report -----------------------------------------------------------------------
function fmt(n, d = 1) { return n == null ? 'n/a' : Number(n).toFixed(d) }

function formatProfileReport(r) {
  const L = []
  L.push('=== matron-journal WAL/GC stall profile ===')
  L.push(`started: ${r.runStartedAt}  mode: ${r.mode}  duration: ${r.config.durationMs / 1000}s  agents: ${r.config.numAgents}  convos: ${r.config.numConvos}`)
  L.push(`server pragmas: ${Object.entries(r.server.pragmas).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  L.push('')
  L.push(`append latency ms: p50=${fmt(r.appendLatencyMs.p50)} p95=${fmt(r.appendLatencyMs.p95)} p99=${fmt(r.appendLatencyMs.p99)} max=${fmt(r.appendLatencyMs.max)} n=${r.appendLatencyMs.count}`)
  L.push(`server event-loop lag ms: p50=${fmt(r.server.eventLoopLagMs.p50, 2)} p95=${fmt(r.server.eventLoopLagMs.p95, 2)} p99=${fmt(r.server.eventLoopLagMs.p99, 2)} max=${fmt(r.server.eventLoopLagMs.max, 2)}`)
  L.push(`checkpoint census (25ms WAL-index sampling): ${r.checkpoints.resets} completed checkpoints (WAL resets), ${r.checkpoints.backfills} partial backfills, WAL high-water ${fmt(r.checkpoints.maxWalBytes / 1e6, 2)}MB / ${r.checkpoints.maxMxFrame} frames`)
  const gcByKind = {}
  for (const g of r.server.gc) { gcByKind[g.gcKind] = gcByKind[g.gcKind] || { n: 0, maxMs: 0 }; gcByKind[g.gcKind].n++; gcByKind[g.gcKind].maxMs = Math.max(gcByKind[g.gcKind].maxMs, g.durMs) }
  L.push(`server GC census: ${Object.entries(gcByKind).map(([k, v]) => `${k} n=${v.n} max=${fmt(v.maxMs)}ms`).join(', ') || 'none observed'}`)
  L.push(`server slow statements (>=${r.config.slowStmtMs}ms): ${r.server.slowStmts.length}  |  server loop stalls (>=${r.config.loopStallMs}ms): ${r.server.loopStalls.length}`)
  L.push('')
  L.push(`-- stalls > ${r.config.stallThresholdMs}ms (append-probe clusters + uncovered server loop stalls) --`)
  if (r.stalls.length === 0) {
    L.push('  none observed in this run')
  } else {
    L.push('  t+s | source | worst ms | samples | verdict | evidence')
    for (const s of r.stalls) L.push(`  ${s.tPlusS} | ${s.source} | ${s.durMs} | ${s.samples} | ${s.verdict} | ${s.evidence}`)
  }
  return L.join('\n')
}

// --- orchestrator -----------------------------------------------------------------
export async function runWalProfile(opts = {}) {
  const cfg = {
    durationMs: 120000,
    numAgents: LOAD_DEFAULTS.numAgents,
    numConvos: LOAD_DEFAULTS.numConvos,
    rates: LOAD_DEFAULTS.rates,
    outOfProc: false,
    stallThresholdMs: 100,
    slowStmtMs: 20,
    loopStallMs: 50,
    keepDb: false,
    ...opts,
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-walprof-'))
  const dbPath = path.join(tmpDir, 'matron.db')
  const runStartedAt = new Date().toISOString()

  let s = null
  let child = null
  try {
    let serverData
    let traffic
    let base

    if (!cfg.outOfProc) {
      s = await startServer({ dbPath, port: 0, bind: '127.0.0.1' })
      base = `http://127.0.0.1:${s.port}`
      const { agents, clients } = await provision(s.db, cfg)
      // instrumentation attaches AFTER provisioning so argon2/setup noise
      // never pollutes the logs
      const instr = attachServerInstrumentation(s.db, dbPath, cfg)
      traffic = await runTraffic({ base, agents, clients, numConvos: cfg.numConvos, rates: cfg.rates, durationMs: cfg.durationMs })
      serverData = instr.stop()
    } else {
      // Provision offline, close the handle (a lingering reader connection
      // would hold a WAL read mark and distort checkpoint behavior), then
      // fork the instrumented server and drive it over localhost ws.
      const provDb = openDb(dbPath)
      const { agents, clients } = await provision(provDb, cfg)
      provDb.close()

      child = fork(fileURLToPath(import.meta.url), [
        '--child-server', `--db=${dbPath}`, `--slow-stmt=${cfg.slowStmtMs}`, `--loop-stall=${cfg.loopStallMs}`,
      ], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
      const childExit = new Promise((_, rej) => child.on('exit', (code) => rej(new Error(`child server exited early (code ${code})`))))
      const ready = new Promise((resolve) => {
        child.on('message', (m) => { if (m && m.op === 'ready') resolve(m) })
      })
      const { port } = await Promise.race([ready, childExit])
      base = `http://127.0.0.1:${port}`

      const genGc = makeGcLog()
      const genLoop = makeLoopStallLog({ thresholdMs: cfg.loopStallMs })
      traffic = await runTraffic({ base, agents, clients, numConvos: cfg.numConvos, rates: cfg.rates, durationMs: cfg.durationMs })
      genGc.stop()
      genLoop.stop()

      const result = new Promise((resolve) => {
        child.on('message', (m) => { if (m && m.op === 'result') resolve(m.data) })
      })
      child.send({ op: 'finish' })
      serverData = await Promise.race([
        result,
        sleep(15000).then(() => { throw new Error('child server did not return instrumentation data within 15s') }),
      ])
      serverData.genData = { loopStalls: genLoop.stalls, gc: genGc.entries }
      child = null // exited cleanly via its own process.exit
    }

    const mode = cfg.outOfProc ? 'out-of-proc' : 'in-process'
    const stalls = buildStallTable({
      latencySamples: traffic.latency.samples,
      serverData,
      genData: serverData.genData || null,
      mode,
      stallThresholdMs: cfg.stallThresholdMs,
      t0: traffic.startedAtEpoch,
    })

    return {
      runStartedAt,
      mode,
      config: {
        durationMs: cfg.durationMs, numAgents: cfg.numAgents, numConvos: cfg.numConvos, rates: cfg.rates,
        stallThresholdMs: cfg.stallThresholdMs, slowStmtMs: cfg.slowStmtMs, loopStallMs: cfg.loopStallMs, dbPath,
      },
      runtime: { node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}` },
      appendLatencyMs: percentiles(traffic.latency.samples.map((x) => x.latencyMs)),
      ephemeral: traffic.ephemeral,
      checkpoints: checkpointCensus(serverData.walSamples),
      server: {
        pragmas: serverData.pragmas,
        eventLoopLagMs: serverData.eventLoopLagMs,
        rssMb: serverData.rssMb,
        gc: serverData.gc,
        loopStalls: serverData.loopStalls,
        slowStmts: serverData.slowStmts,
      },
      generator: serverData.genData || null,
      stalls,
    }
  } finally {
    if (child) { try { child.kill() } catch { /* already gone */ } }
    if (s) { try { await s.close() } catch (e) { console.error('server close failed during teardown', e) } }
    if (!cfg.keepDb) { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ } }
  }
}

function parseArgs(argv) {
  const out = {}
  for (const a of argv) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/)
    if (m) out[m[1]] = m[2] === undefined ? true : m[2]
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args['child-server']) { await runChildServer(args); return }

  const opts = {}
  if (args.duration !== undefined) opts.durationMs = Number(args.duration) * 1000
  if (args.agents !== undefined) opts.numAgents = Number(args.agents)
  if (args.convos !== undefined) opts.numConvos = Number(args.convos)
  if (args['out-of-proc']) opts.outOfProc = true
  if (args['stall-threshold'] !== undefined) opts.stallThresholdMs = Number(args['stall-threshold'])
  if (args['slow-stmt'] !== undefined) opts.slowStmtMs = Number(args['slow-stmt'])
  if (args['loop-stall'] !== undefined) opts.loopStallMs = Number(args['loop-stall'])
  if (args['keep-db']) opts.keepDb = true

  const summary = await runWalProfile(opts)
  console.log(formatProfileReport(summary))
  if (args['json-out']) {
    fs.writeFileSync(args['json-out'], JSON.stringify(summary, null, 2))
    console.log(`\nJSON written to ${args['json-out']}`)
  }
}

let isMain = false
try {
  isMain = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
} catch { /* argv[1] missing or unresolvable: not the entrypoint */ }
if (isMain) {
  main().catch((err) => { console.error(err); process.exitCode = 1 })
}
