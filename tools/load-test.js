#!/usr/bin/env node
// Load test (spec §12): "synthetic publisher replicating the worst observed
// traffic — ~40 deltas/s per session, 10 concurrent sessions, 300
// conversations/user — validating coalescing rates and append latency."
//
// Spawns its OWN in-process server instance (startServer, temp DB under
// /tmp, random port) — never touches a live deployment. Provisions 1 user +
// N agent devices + 3 client devices directly via the db/admin modules
// (src/auth.js, src/journal.js) against the server's own db handle, creates
// numConvos conversations, then drives synthetic traffic for durationMs:
//
//   - N concurrent agent sockets, each publishing a realistic mix at
//     ~40 events/s: stream ephemerals (with message_ref, simulating token
//     streaming), publish (text/tool_output), finalize (closing a streamed
//     turn), and a sprinkle of convo_upsert state flips / activity frames.
//     Agent 0 is pinned to a single "hot" conversation for the whole run
//     (clean coalescing measurement); the rest round-robin a private pool
//     of the remaining conversations, switching convo at each finalize.
//   - 3 client sockets: a hot-convo viewer (receives ephemerals), a
//     live-follower (cursor tail, acks periodically — the append-latency
//     probe observer), and a cold client that connects mid-run with
//     cursor 0 (full replay while load keeps flowing).
//
// Reports append latency (publish/finalize -> journal frame observed on the
// live-follower) p50/p95/p99, ephemeral coalescing ratio (delivered/sent to
// the hot viewer), cold-client replay throughput/wall time, server-process
// event-loop lag (monitorEventLoopDelay), final head_seq, and RSS
// before/after. Machine-readable JSON + a human table go to stdout.
//
// Usage:
//   node tools/load-test.js [--duration=60] [--agents=10] [--convos=300]
//     [--cold-at=0.5] [--port=0] [--json-out=path] [--keep-db]
//
// Also importable: `import { runLoadTest } from './tools/load-test.js'`.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import WebSocket from 'ws'
import { startServer } from '../src/server.js'
import { createUser, createAgent, login } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'

const DEFAULTS = {
  durationMs: 60000,
  numAgents: 10,
  numConvos: 300,
  coldConnectFraction: 0.5, // fraction of durationMs at which the cold client connects
  port: 0,
  bind: '127.0.0.1',
  dbPath: null, // null => fresh temp file under os.tmpdir()
  keepDb: false,
  rates: { stream: 30, publish: 8, finalize: 1, sprinkle: 1 }, // events/s per agent session
  drainMs: 1500, // grace period after the load window before measuring final state
  ackIntervalMs: 1000,
}

const nowMs = () => Number(process.hrtime.bigint()) / 1e6
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))
const jitter = (intervalMs, spread = 0.3) => intervalMs * (1 - spread / 2 + Math.random() * spread)

function percentiles(values) {
  if (values.length === 0) return { p50: null, p95: null, p99: null, max: null, count: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
  return { p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1], count: sorted.length }
}

const WORDS = ['the', 'quick', 'agent', 'streamed', 'a', 'diff', 'against', 'session', 'token', 'reply', 'tool', 'result', 'ok', 'building', 'index']
const randWord = () => WORDS[Math.floor(Math.random() * WORDS.length)]
const randSentence = (n = 8) => Array.from({ length: n }, randWord).join(' ')

// --- latency probe tracking -------------------------------------------------
// publish/finalize payloads are tagged with `_probe: <id>` right before
// send; the live-follower socket (the only listener that calls `observe`)
// matches the id back off the journal frame's echoed payload and records
// send -> observed latency, bucketed by phase (pre/during/post cold-replay)
// so a starvation regression during the cold client's replay is visible.
function makeLatencyTracker() {
  let counter = 0
  const pending = new Map()
  const samples = []
  const phase = { coldConnectAt: null, coldDoneAt: null }
  const currentPhase = () => {
    if (phase.coldConnectAt == null || nowMs() < phase.coldConnectAt) return 'preCold'
    if (phase.coldDoneAt == null || nowMs() < phase.coldDoneAt) return 'duringCold'
    return 'postCold'
  }
  return {
    phase,
    nextProbeId: () => ++counter,
    mark(id) { pending.set(id, { sentMs: nowMs(), phase: currentPhase() }) },
    observe(id) {
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      samples.push({ latencyMs: nowMs() - p.sentMs, phase: p.phase })
    },
    pendingCount: () => pending.size,
    samples,
  }
}

function connectWs(base, { token, cursor }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
    const onError = (e) => { cleanup(); reject(e) }
    const onOpen = () => ws.send(JSON.stringify({ op: 'hello', token, cursor }))
    const onMessage = (data) => {
      let msg
      try { msg = JSON.parse(data) } catch { return }
      if (msg.kind === 'control' && msg.op === 'hello_ok') {
        cleanup()
        resolve({ ws, helloSeq: msg.seq })
      } else if (msg.kind === 'control' && msg.op === 'error') {
        cleanup()
        reject(new Error(`ws hello failed: ${msg.code}`))
      }
    }
    function cleanup() {
      ws.off('error', onError)
      ws.off('message', onMessage)
    }
    ws.on('error', onError)
    ws.on('open', onOpen)
    ws.on('message', onMessage)
  })
}

// One agent session's traffic-mix loop: a single "earliest next event wins"
// scheduler covering stream/publish/finalize/sprinkle, jittered around their
// target per-second rates so the four kinds interleave the way a real
// bridge's traffic would rather than firing in lockstep bursts.
async function runAgentSession({ id, ws, hot, convoIds, rates, endAtMs, latency, ephemeral }) {
  let convoIdx = 0
  let currentConvo = convoIds[convoIdx]
  let turnCounter = 0
  let messageRef = `turn-${id}-${turnCounter}`
  let streamedText = ''
  let sessionState = 'running'
  let pubCounter = 0
  let sprinkleToggle = 0

  const nextFire = {
    stream: nowMs() + jitter(1000 / rates.stream),
    publish: nowMs() + jitter(1000 / rates.publish),
    finalize: nowMs() + jitter(1000 / rates.finalize),
    sprinkle: nowMs() + jitter(1000 / rates.sprinkle),
  }

  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)) }

  while (nowMs() < endAtMs) {
    let kind = null
    let t = Infinity
    for (const k in nextFire) if (nextFire[k] < t) { t = nextFire[k]; kind = k }
    await sleep(t - nowMs())
    if (nowMs() >= endAtMs) break

    switch (kind) {
      case 'stream': {
        streamedText += (streamedText ? ' ' : '') + randWord()
        send({ op: 'stream', convo_id: currentConvo, message_ref: messageRef, text: streamedText })
        if (hot) ephemeral.streamSent++
        break
      }
      case 'publish': {
        pubCounter++
        const probeId = latency.nextProbeId()
        const type = pubCounter % 3 === 0 ? 'tool_output' : 'text'
        const payload = type === 'text'
          ? { body: randSentence(), _probe: probeId }
          : { snippet: randSentence(4), truncated: false, tool_name: 'bash', _probe: probeId }
        latency.mark(probeId)
        send({ op: 'publish', convo_id: currentConvo, type, payload, idem_key: `pub-${id}-${pubCounter}` })
        break
      }
      case 'finalize': {
        const probeId = latency.nextProbeId()
        latency.mark(probeId)
        send({
          op: 'finalize', convo_id: currentConvo, message_ref: messageRef, type: 'text',
          payload: { body: streamedText || randSentence(), _probe: probeId },
        })
        turnCounter++
        streamedText = ''
        convoIdx = (convoIdx + 1) % convoIds.length
        currentConvo = convoIds[convoIdx]
        messageRef = `turn-${id}-${turnCounter}`
        break
      }
      case 'sprinkle': {
        sprinkleToggle ^= 1
        if (sprinkleToggle) {
          sessionState = sessionState === 'running' ? 'waiting' : sessionState === 'waiting' ? 'done' : 'running'
          send({ op: 'convo_upsert', convo_id: currentConvo, session_state: sessionState })
        } else {
          const states = ['thinking', 'tool', 'idle']
          send({ op: 'activity', convo_id: currentConvo, state: states[Math.floor(Math.random() * states.length)] })
          if (hot) ephemeral.activitySent++
        }
        break
      }
      default: break
    }
    nextFire[kind] = nowMs() + jitter(1000 / rates[kind])
  }
}

function assignConvoPools(restConvos, nonHotAgentCount) {
  const pools = Array.from({ length: nonHotAgentCount }, () => [])
  restConvos.forEach((cid, idx) => pools[idx % nonHotAgentCount].push(cid))
  for (const p of pools) if (p.length === 0) p.push(restConvos[0] ?? 'convo-0')
  return pools
}

export async function runLoadTest(opts = {}) {
  const cfg = {
    ...DEFAULTS,
    ...opts,
    rates: { ...DEFAULTS.rates, ...(opts.rates || {}) },
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-loadtest-'))
  const dbPath = cfg.dbPath || path.join(tmpDir, 'matron.db')
  const runStartedAt = new Date().toISOString()
  const t0 = nowMs()

  const s = await startServer({ dbPath, port: cfg.port, bind: cfg.bind })
  const base = `http://127.0.0.1:${s.port}`

  try {
    // --- provisioning: 1 user + N agent devices + 3 client devices,
    // directly via the db/admin modules against the server's own db
    // handle (same in-process better-sqlite3 connection) -----------------
    const password = `loadtest-${crypto.randomBytes(8).toString('hex')}`
    const user = await createUser(s.db, 'loadtest', password)

    const agentDevices = []
    for (let i = 0; i < cfg.numAgents; i++) {
      agentDevices.push({ idx: i, name: `agent-${i}`, ...createAgent(s.db, user.id, `agent-${i}`) })
    }

    const clientRoles = ['hot-viewer', 'live-follower', 'cold-client']
    const clientDevices = {}
    for (const role of clientRoles) {
      clientDevices[role] = await login(s.db, { username: 'loadtest', password, deviceName: role })
    }

    for (let i = 0; i < cfg.numConvos; i++) {
      upsertConversation(s.db, { id: `convo-${i}`, ownerUserId: user.id, title: `Load Test Convo ${i}`, sessionState: 'running' })
    }
    const setupMs = nowMs() - t0

    const hotConvoId = 'convo-0'
    const restConvos = Array.from({ length: Math.max(cfg.numConvos - 1, 0) }, (_, i) => `convo-${i + 1}`)
    const nonHotAgents = Math.max(cfg.numAgents - 1, 1)
    const pools = restConvos.length > 0 ? assignConvoPools(restConvos, nonHotAgents) : Array.from({ length: nonHotAgents }, () => [hotConvoId])

    // --- client sockets: hot viewer + live-follower connect BEFORE any
    // agent so no probe/ephemeral is ever missed ---------------------------
    const hot = await connectWs(base, { token: clientDevices['hot-viewer'].token, cursor: null })
    hot.ws.send(JSON.stringify({ op: 'viewing', convo_id: hotConvoId }))

    const ephemeral = { streamSent: 0, activitySent: 0, streamReceived: 0, activityReceived: 0 }
    hot.ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data) } catch { return }
      if (msg.kind !== 'ephemeral' || msg.convo_id !== hotConvoId) return
      if (msg.activity) ephemeral.activityReceived++
      else ephemeral.streamReceived++
    })

    const latency = makeLatencyTracker()
    const live = await connectWs(base, { token: clientDevices['live-follower'].token, cursor: 0 })
    let liveMaxSeq = 0
    live.ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data) } catch { return }
      if (msg.kind !== 'journal') return
      if (msg.seq > liveMaxSeq) liveMaxSeq = msg.seq
      if (msg.payload && typeof msg.payload._probe === 'number') latency.observe(msg.payload._probe)
    })
    const ackInterval = setInterval(() => {
      if (live.ws.readyState === 1) live.ws.send(JSON.stringify({ op: 'ack', cursor: liveMaxSeq }))
    }, cfg.ackIntervalMs)

    // --- agent sockets ------------------------------------------------------
    const agentConns = await Promise.all(agentDevices.map(async (a) => {
      const c = await connectWs(base, { token: a.token, cursor: null })
      return { ...a, ws: c.ws }
    }))

    // --- cold client: scheduled to connect partway through the run --------
    const cold = { state: 'pending', count: 0, doneCount: 0, wallMs: null, throughputPerSec: null, helloSeq: null }
    const coldConnectDelayMs = cfg.durationMs * cfg.coldConnectFraction
    let coldTimer = null
    const connectColdClient = async () => {
      const connectStartMs = nowMs()
      latency.phase.coldConnectAt = connectStartMs
      cold.state = 'connecting'
      const c = await connectWs(base, { token: clientDevices['cold-client'].token, cursor: 0 })
      cold.helloSeq = c.helloSeq
      cold.ws = c.ws
      cold.state = 'replaying'
      if (c.helloSeq === 0) {
        cold.state = 'done'
        cold.wallMs = nowMs() - connectStartMs
        cold.doneCount = 0
        cold.throughputPerSec = 0
        latency.phase.coldDoneAt = nowMs()
      }
      c.ws.on('message', (data) => {
        let msg
        try { msg = JSON.parse(data) } catch { return }
        if (msg.kind !== 'journal') return
        cold.count++
        if (cold.state === 'replaying' && msg.seq >= cold.helloSeq) {
          cold.state = 'done'
          cold.wallMs = nowMs() - connectStartMs
          cold.doneCount = cold.count
          cold.throughputPerSec = cold.wallMs > 0 ? cold.doneCount / (cold.wallMs / 1000) : cold.doneCount
          latency.phase.coldDoneAt = nowMs()
        }
      })
    }

    // --- run the load window ------------------------------------------------
    // resolution: 2ms — at the default 20ms this box's virtualized timer
    // shows a ~20ms floor even fully idle (verified separately), which
    // swamps any real load-induced signal; 2ms keeps the idle floor near
    // ~2ms so genuine event-loop pressure is actually visible.
    const loop = monitorEventLoopDelay({ resolution: 2 })
    loop.enable()
    const rssBeforeBytes = process.memoryUsage().rss
    const loadStartMs = nowMs()
    const endAtMs = loadStartMs + cfg.durationMs
    coldTimer = setTimeout(() => { connectColdClient().catch((e) => console.error('cold client connect failed', e)) }, coldConnectDelayMs)

    await Promise.all(agentConns.map((a) => runAgentSession({
      id: a.idx, ws: a.ws, hot: a.idx === 0,
      convoIds: a.idx === 0 ? [hotConvoId] : pools[a.idx - 1],
      rates: cfg.rates, endAtMs, latency, ephemeral,
    })))

    // Drain: let in-flight sends, the 200ms ephemeral coalesce timer, and any
    // outstanding latency probes resolve before we snapshot final state.
    const drainDeadline = nowMs() + cfg.drainMs
    while (nowMs() < drainDeadline && latency.pendingCount() > 0) await sleep(50)

    clearInterval(ackInterval)
    clearTimeout(coldTimer)
    loop.disable()
    const rssAfterBytes = process.memoryUsage().rss

    const headRow = s.db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(user.id)
    const headSeqFinal = headRow ? headRow.seq : 0
    const journalRowCount = s.db.prepare('SELECT COUNT(*) n FROM events').get().n

    // --- close everything ---------------------------------------------------
    for (const c of [hot.ws, live.ws, cold.ws, ...agentConns.map((a) => a.ws)]) {
      if (c && (c.readyState === 0 || c.readyState === 1)) c.close()
    }
    await s.close()

    const allLatency = percentiles(latency.samples.map((x) => x.latencyMs))
    const byPhase = (phase) => percentiles(latency.samples.filter((x) => x.phase === phase).map((x) => x.latencyMs))
    const loopMs = (ns) => ns / 1e6
    const eventLoopLagMs = {
      p50: loopMs(loop.percentile(50)), p95: loopMs(loop.percentile(95)),
      p99: loopMs(loop.percentile(99)), max: loopMs(loop.max),
    }

    const coalesceRatio = ephemeral.streamSent > 0 ? ephemeral.streamReceived / ephemeral.streamSent : null

    const preCold = byPhase('preCold')
    const duringCold = byPhase('duringCold')
    const starved = duringCold.count > 0 && (
      (duringCold.p99 != null && duringCold.p99 > 250) ||
      (preCold.p99 != null && preCold.p99 > 0 && duringCold.p99 != null && duringCold.p99 > preCold.p99 * 2 && duringCold.p99 > 20)
    )

    const gates = {
      appendP99: { thresholdMs: 250, actualMs: allLatency.p99, ok: allLatency.p99 == null || allLatency.p99 <= 250 },
      eventLoopP95: { thresholdMs: 200, actualMs: eventLoopLagMs.p95, ok: eventLoopLagMs.p95 <= 200 },
      replayStarvation: {
        ok: !starved,
        preColdP99Ms: preCold.p99, duringColdP99Ms: duringCold.p99,
        detail: starved
          ? 'append p99 during cold-client replay is elevated vs. steady-state — see appendLatencyByPhaseMs'
          : 'no material append-latency regression observed during cold-client replay',
      },
    }

    return {
      runStartedAt,
      config: {
        durationMs: cfg.durationMs, numAgents: cfg.numAgents, numConvos: cfg.numConvos,
        coldConnectFraction: cfg.coldConnectFraction, rates: cfg.rates, dbPath,
      },
      runtime: {
        node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`,
        cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model || 'unknown',
        totalMemGb: +(os.totalmem() / 1e9).toFixed(1),
      },
      provisioning: {
        setupMs: +setupMs.toFixed(1), numAgentDevices: cfg.numAgents, numClientDevices: 3, numConversations: cfg.numConvos,
      },
      appendLatencyMs: allLatency,
      appendLatencyByPhaseMs: { preCold, duringCold, postCold: byPhase('postCold') },
      ephemeral: { ...ephemeral, coalesceRatio, coalesceMsWindow: 200 },
      replay: {
        coldConnectDelayMs: +coldConnectDelayMs.toFixed(0), helloSeq: cold.helloSeq,
        eventsReplayed: cold.doneCount, wallTimeMs: cold.wallMs != null ? +cold.wallMs.toFixed(1) : null,
        throughputEventsPerSec: cold.throughputPerSec != null ? +cold.throughputPerSec.toFixed(1) : null,
        completed: cold.state === 'done',
      },
      eventLoopLagMs,
      memory: {
        rssBeforeMb: +(rssBeforeBytes / 1e6).toFixed(1), rssAfterMb: +(rssAfterBytes / 1e6).toFixed(1),
        deltaMb: +((rssAfterBytes - rssBeforeBytes) / 1e6).toFixed(1),
      },
      headSeqFinal,
      journalRowCount,
      gates,
    }
  } finally {
    if (!cfg.keepDb) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort cleanup */ }
    }
  }
}

function fmt(n, digits = 1) { return n == null ? 'n/a' : Number(n).toFixed(digits) }

export function formatReport(summary) {
  const lines = []
  lines.push('=== matron-journal load test ===')
  lines.push(`started: ${summary.runStartedAt}`)
  lines.push(`config: duration=${summary.config.durationMs / 1000}s agents=${summary.config.numAgents} convos=${summary.config.numConvos} rates=${JSON.stringify(summary.config.rates)}`)
  lines.push(`runtime: node ${summary.runtime.node} on ${summary.runtime.platform}, ${summary.runtime.cpus} cpus (${summary.runtime.cpuModel}), ${summary.runtime.totalMemGb}GB RAM`)
  lines.push('')
  lines.push('-- append latency (publish/finalize -> journal frame on live-follower), ms --')
  lines.push(`  p50=${fmt(summary.appendLatencyMs.p50)} p95=${fmt(summary.appendLatencyMs.p95)} p99=${fmt(summary.appendLatencyMs.p99)} max=${fmt(summary.appendLatencyMs.max)} n=${summary.appendLatencyMs.count}`)
  const ph = summary.appendLatencyByPhaseMs
  lines.push(`  by phase: pre-cold p99=${fmt(ph.preCold.p99)} (n=${ph.preCold.count})  during-cold p99=${fmt(ph.duringCold.p99)} (n=${ph.duringCold.count})  post-cold p99=${fmt(ph.postCold.p99)} (n=${ph.postCold.count})`)
  lines.push('')
  lines.push('-- ephemeral coalescing (hot conversation viewer) --')
  lines.push(`  stream sent=${summary.ephemeral.streamSent} received=${summary.ephemeral.streamReceived} ratio=${fmt(summary.ephemeral.coalesceRatio, 3)} (coalesce window ${summary.ephemeral.coalesceMsWindow}ms)`)
  lines.push(`  activity sent=${summary.ephemeral.activitySent} received=${summary.ephemeral.activityReceived}`)
  lines.push('')
  lines.push('-- cold client replay (mid-run connect, cursor 0) --')
  lines.push(`  connected at +${summary.replay.coldConnectDelayMs}ms, target seq=${summary.replay.helloSeq}, events replayed=${summary.replay.eventsReplayed}`)
  lines.push(`  wall time=${fmt(summary.replay.wallTimeMs)}ms throughput=${fmt(summary.replay.throughputEventsPerSec)} events/s completed=${summary.replay.completed}`)
  lines.push('')
  lines.push('-- server event-loop lag, ms --')
  lines.push(`  p50=${fmt(summary.eventLoopLagMs.p50, 2)} p95=${fmt(summary.eventLoopLagMs.p95, 2)} p99=${fmt(summary.eventLoopLagMs.p99, 2)} max=${fmt(summary.eventLoopLagMs.max, 2)}`)
  lines.push('')
  lines.push('-- memory (process RSS) --')
  lines.push(`  before=${summary.memory.rssBeforeMb}MB after=${summary.memory.rssAfterMb}MB delta=${summary.memory.deltaMb}MB`)
  lines.push('')
  lines.push(`head_seq final=${summary.headSeqFinal}  journal rows=${summary.journalRowCount}`)
  lines.push('')
  lines.push('-- gates --')
  for (const [name, g] of Object.entries(summary.gates)) {
    lines.push(`  ${name}: ${g.ok ? 'PASS' : 'CONCERN'}${g.detail ? ' — ' + g.detail : ''}`)
  }
  return lines.join('\n')
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
  const opts = {}
  if (args.duration !== undefined) opts.durationMs = Number(args.duration) * 1000
  if (args.agents !== undefined) opts.numAgents = Number(args.agents)
  if (args.convos !== undefined) opts.numConvos = Number(args.convos)
  if (args['cold-at'] !== undefined) opts.coldConnectFraction = Number(args['cold-at'])
  if (args.port !== undefined) opts.port = Number(args.port)
  if (args['keep-db']) opts.keepDb = true

  const summary = await runLoadTest(opts)
  console.log(formatReport(summary))
  console.log('')
  console.log('=== JSON SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))

  if (args['json-out']) {
    fs.writeFileSync(args['json-out'], JSON.stringify(summary, null, 2))
  }

  const failed = Object.values(summary.gates).some((g) => !g.ok)
  process.exitCode = failed ? 1 : 0
}

let isMain = false
try {
  isMain = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
} catch { /* argv[1] missing or unresolvable: not the entrypoint */ }
if (isMain) {
  main().catch((err) => { console.error(err); process.exitCode = 1 })
}
