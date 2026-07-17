import http from 'node:http'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.js'
import { makeLoginGuard, makeRateLimiter } from './auth.js'
import { makeHttpHandler } from './http.js'
import { makePairStore } from './pairing.js'
import { makeHub } from './hub.js'
import { attachWs } from './ws.js'
import { makeToolStreamStore } from './tool-stream.js'
import { makeApnsClient } from './apns.js'
import { makeGatewayClient } from './gateway.js'
import { makePushPipeline } from './push.js'
import { resolveMediaDir } from './media.js'
import { runOffload, runExpireLogs } from './retention.js'

export const DEFAULT_MEDIA_MAX_BYTES = 52428800 // 50 MB
export const DEFAULT_MAX_REPLAY = 50000
const DEFAULT_RETENTION_DAYS = 30
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h
const DEFAULT_TOOL_LOG_TTL_HOURS = 24

// Shared validator for small numeric env knobs that guard a size/gap check
// (`size > mediaMaxBytes`, `gap > maxReplay`): an unset var is the normal,
// expected "use the default" case (no warning). But an unparseable or
// non-positive value must never silently become NaN and disable the check
// it guards — `x > NaN` is always false, so e.g. a garbage
// MATRON_MEDIA_MAX_BYTES would make the upload size cap accept anything,
// and a garbage MATRON_MAX_REPLAY would make the snapshot_required valve
// never fire. Fails closed to `defaultValue` instead, with one warn log
// naming the var, so a misconfiguration is loud rather than invisible.
export function resolveNumericEnv(name, raw, defaultValue) {
  if (raw === undefined) return defaultValue
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    console.warn(`${name}=${JSON.stringify(raw)} is invalid (must be a positive integer) — using default ${defaultValue}`)
    return defaultValue
  }
  return n
}

// `override` is startServer's `retentionDays` opt — when given, it takes
// precedence over the env var (this is how tests disable/shrink the window
// without touching process.env), but BOTH sources run through the same
// validation: unset means ENABLED at the 30-day default; `0` disables; and
// anything that isn't a non-negative integer disables with one log line —
// fails closed. (A raw pass-through of a negative override would compute a
// FUTURE cutoff and offload every payload including brand-new ones.)
// Returns the window in days, or null when retention is disabled.
function resolveRetentionDays(override) {
  const fromEnv = override === undefined
  const raw = fromEnv ? process.env.MATRON_RETENTION_DAYS : override
  if (raw === undefined) return DEFAULT_RETENTION_DAYS
  const name = fromEnv ? 'MATRON_RETENTION_DAYS' : 'retentionDays'
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    console.warn(`retention: ${name}=${JSON.stringify(raw)} is invalid — retention disabled`)
    return null
  }
  if (n === 0) {
    console.warn(`retention: ${name}=0 — retention disabled`)
    return null
  }
  return n
}

// `override` is startServer's `toolLogTtlHours` opt — mirrors
// resolveRetentionDays exactly (same precedence, same fail-closed
// validation): unset means ENABLED at the 24h default; `0` disables; and
// anything that isn't a non-negative integer disables with one log line.
// Returns the TTL window in hours, or null when the TTL pass is disabled.
function resolveToolLogTtlHours(override) {
  const fromEnv = override === undefined
  const raw = fromEnv ? process.env.MATRON_TOOL_LOG_TTL_HOURS : override
  if (raw === undefined) return DEFAULT_TOOL_LOG_TTL_HOURS
  const name = fromEnv ? 'MATRON_TOOL_LOG_TTL_HOURS' : 'toolLogTtlHours'
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    console.warn(`retention: ${name}=${JSON.stringify(raw)} is invalid — retention disabled`)
    return null
  }
  if (n === 0) {
    console.warn(`retention: ${name}=0 — retention disabled`)
    return null
  }
  return n
}

// Runs at boot (called after `server.listen` succeeds) and every 6h
// thereafter (unref'd — never keeps the process alive on its own). Runs the
// live-log TTL pass BEFORE the offload pass (opposite of declaration order
// above) so that even a mis-configured-then-re-enabled system tombstones a
// stale inline live_log row before offload ever gets a chance to see it —
// runOffload's `blob_ref IS NULL` scan can't otherwise distinguish a
// long-overdue live_log row from a genuinely-inline one, and offloading it
// would permanently exempt it from the TTL pass (see runOffload's live_log
// skip). The two passes remain independent knobs otherwise — either can be
// disabled on its own (see resolveRetentionDays / resolveToolLogTtlHours)
// without affecting the other — each with its own try/catch so one pass
// failing (e.g. a disk error) never prevents the other from running on this
// tick or being scheduled for the next. Returns the interval handle (for
// close()) or null only when BOTH passes are disabled.
function scheduleRetention(db, { mediaDir, retentionDays, retentionIntervalMs, toolLogTtlHours }) {
  const days = resolveRetentionDays(retentionDays)
  const ttlHours = resolveToolLogTtlHours(toolLogTtlHours)
  if (days === null && ttlHours === null) return null
  const run = () => {
    if (ttlHours !== null) {
      try {
        const r = runExpireLogs(db, { hours: ttlHours, mediaDir })
        if (r.expired > 0) console.log(`retention: purged ${r.expired} live_log payload(s) older than ${ttlHours}h`)
      } catch (err) {
        console.error('retention: expire-logs run failed', err)
      }
    }
    if (days !== null) {
      try {
        const r = runOffload(db, { days, mediaDir })
        if (r.offloaded > 0) console.log(`retention: offloaded ${r.offloaded} tool_output payload(s) older than ${days}d`)
      } catch (err) {
        console.error('retention: offload run failed', err)
      }
    }
  }
  run()
  const interval = setInterval(run, retentionIntervalMs ?? RETENTION_INTERVAL_MS)
  interval.unref()
  return interval
}

// The explicit-checkpoint half of the WAL mitigation (the pragma half —
// wal_autocheckpoint=0 + journal_size_limit — lives in openDb; measured
// rationale in docs/wal-checkpoint-profile.md). PASSIVE never blocks readers
// or the writer, and on an empty WAL it is sub-ms, so a 1s cadence costs
// nothing when idle; under load it keeps backfills small and the WAL bounded
// (~4.8MiB worst observed vs unbounded growth without it, since autockpt is
// now off). It still runs the fsync on this thread — profiled cost p99 46ms,
// max 59ms per pass under load — but appends themselves no longer carry it.
// Unref'd like the retention timer; cleared in close().
const WAL_CHECKPOINT_INTERVAL_MS = 1000

function scheduleWalCheckpoint(db, walCheckpointIntervalMs) {
  const run = () => {
    try {
      db.pragma('wal_checkpoint(PASSIVE)')
    } catch (err) {
      // A failed passive pass is retried by the next tick; log once per tick
      // rather than crash — the DB itself is still healthy (busy/locked are
      // expected transient outcomes).
      console.error('wal-checkpoint: passive pass failed', err)
    }
  }
  const interval = setInterval(run, walCheckpointIntervalMs ?? WAL_CHECKPOINT_INTERVAL_MS)
  interval.unref()
  return interval
}

// Push client selection, in strict priority order:
//   1. injected (tests) — caller owns its lifecycle.
//   2. all four MATRON_APNS_* set → direct APNs (Dan's journal: full-content
//      alerts, exactly the pre-relay behavior).
//   3. MATRON_PUSH_GATEWAY_URL set → the push.matron.chat relay (self-hosted
//      journals with no APNs key; generic alert text, content never leaves
//      the box — see src/gateway.js).
//   4. neither → push disabled, one warn log at boot, pipeline is inert.
// Exported for the selection-order tests only.
export function resolveApnsClient(injected) {
  if (injected) return { client: injected, owned: false }
  const { MATRON_APNS_KEY_FILE, MATRON_APNS_KEY_ID, MATRON_APNS_TEAM_ID, MATRON_APNS_TOPIC, MATRON_PUSH_GATEWAY_URL } = process.env
  if (MATRON_APNS_KEY_FILE && MATRON_APNS_KEY_ID && MATRON_APNS_TEAM_ID && MATRON_APNS_TOPIC) {
    const client = makeApnsClient({
      keyFile: MATRON_APNS_KEY_FILE, keyId: MATRON_APNS_KEY_ID,
      teamId: MATRON_APNS_TEAM_ID, topic: MATRON_APNS_TOPIC,
    })
    return { client, owned: true }
  }
  if (MATRON_PUSH_GATEWAY_URL) {
    // A typo'd URL (e.g. missing scheme) degrades to push-disabled like the
    // other misconfigurations — new URL() in makeGatewayClient would
    // otherwise throw and take the whole journal down at boot.
    if (URL.canParse('/push', MATRON_PUSH_GATEWAY_URL)) {
      return { client: makeGatewayClient({ url: MATRON_PUSH_GATEWAY_URL }), owned: true }
    }
    console.warn(`push: disabled — MATRON_PUSH_GATEWAY_URL is not a valid URL: ${MATRON_PUSH_GATEWAY_URL}`)
    return { client: undefined, owned: false }
  }
  console.warn('push: disabled — set all four MATRON_APNS_* vars (direct APNs) or MATRON_PUSH_GATEWAY_URL (relay) to enable')
  return { client: undefined, owned: false }
}

export function startServer({
  dbPath, port = 0, bind = '127.0.0.1', mediaDir, mediaMaxBytes, apnsClient, replayBackpressureBytes,
  retentionDays, retentionIntervalMs, maxReplay, revocationSweepMs, walCheckpointIntervalMs, toolStreamOpts,
  toolLogTtlHours, pairs,
} = {}) {
  const resolvedDbPath = dbPath || process.env.MATRON_DB || './matron.db'
  const db = openDb(resolvedDbPath)
  // WAL-checkpoint tail mitigation, server half (docs/wal-checkpoint-profile.md;
  // journal_size_limit lives in openDb). With synchronous=NORMAL the
  // auto-checkpoint is the only steady-state fsync and it runs INLINE in
  // whichever append COMMIT crosses the 1000-page mark: 69/69 profiled
  // event-loop blockages >=20ms carried that fingerprint, worst 1.22s under
  // real disk contention (GC max 6.2ms — exonerated). Disabling it here and
  // checkpointing from scheduleWalCheckpoint's 1s PASSIVE timer instead moves
  // the fsync out of append COMMITs: matched-window A/B improved append p99
  // 9.7->3.1ms, contended-round max 1221.7->26.8ms, zero >100ms stall events
  // in every mitigated run, WAL bounded <=4.8MB. Server-only on purpose — a
  // standalone opener (admin CLI) has no timer and keeps the stock inline
  // auto-checkpoint (see openDb).
  db.pragma('wal_autocheckpoint = 0')
  const rateLimiter = makeRateLimiter()
  const loginGuard = makeLoginGuard()
  const resolvedPairs = pairs || makePairStore()
  const resolvedMediaDir = resolveMediaDir(resolvedDbPath, mediaDir)
  const resolvedMediaMaxBytes = mediaMaxBytes ?? resolveNumericEnv('MATRON_MEDIA_MAX_BYTES', process.env.MATRON_MEDIA_MAX_BYTES, DEFAULT_MEDIA_MAX_BYTES)
  const resolvedMaxReplay = maxReplay ?? resolveNumericEnv('MATRON_MAX_REPLAY', process.env.MATRON_MAX_REPLAY, DEFAULT_MAX_REPLAY)
  const hub = makeHub()
  const toolStreams = makeToolStreamStore({
    maxBytes: resolveNumericEnv('MATRON_TOOL_STREAM_MAX_BYTES', process.env.MATRON_TOOL_STREAM_MAX_BYTES, 1048576),
    maxBuffers: resolveNumericEnv('MATRON_TOOL_STREAM_MAX_BUFFERS', process.env.MATRON_TOOL_STREAM_MAX_BUFFERS, 64),
    idleMs: resolveNumericEnv('MATRON_TOOL_STREAM_IDLE_MS', process.env.MATRON_TOOL_STREAM_IDLE_MS, 1800000),
    ...(toolStreamOpts || {}),
  })
  const { client: resolvedApnsClient, owned: ownsApnsClient } = resolveApnsClient(apnsClient)
  const pushPipeline = makePushPipeline({ db, hub, apnsClient: resolvedApnsClient })
  const server = http.createServer(makeHttpHandler({
    db, rateLimiter, loginGuard, mediaDir: resolvedMediaDir, mediaMaxBytes: resolvedMediaMaxBytes,
    hub, pushPipeline, dbPath: resolvedDbPath, pairs: resolvedPairs,
  }))
  const wss = attachWs({
    server, db, hub, pushPipeline, replayBackpressureBytes, maxReplay: resolvedMaxReplay, toolStreams,
    rpcMaxBytes: resolveNumericEnv('MATRON_RPC_MAX_BYTES', process.env.MATRON_RPC_MAX_BYTES, 16384),
    ...(revocationSweepMs !== undefined ? { revocationSweepMs } : {}),
  })
  let retentionInterval = null
  let walCheckpointInterval = null
  return new Promise((resolve) => {
    server.listen(port, bind, () => {
      retentionInterval = scheduleRetention(db, { mediaDir: resolvedMediaDir, retentionDays, retentionIntervalMs, toolLogTtlHours })
      walCheckpointInterval = scheduleWalCheckpoint(db, walCheckpointIntervalMs)
      resolve({
        port: server.address().port,
        db,
        server,
        hub,
        toolStreams,
        pushPipeline,
        close: () => new Promise((r) => {
          if (retentionInterval) clearInterval(retentionInterval)
          if (walCheckpointInterval) clearInterval(walCheckpointInterval)
          wss.close()
          for (const c of wss.clients) c.terminate()
          pushPipeline.close()
          if (ownsApnsClient) resolvedApnsClient.close()
          server.close(() => { db.close(); r() })
        }),
      })
    })
  })
}

let isMain = false
try {
  isMain = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
} catch { /* argv[1] missing or unresolvable: not the entrypoint */ }
if (isMain) {
  const port = Number(process.env.MATRON_PORT || 9810)
  const bind = process.env.MATRON_BIND || '127.0.0.1'
  startServer({ port, bind }).then((s) => console.log(`matron-journal listening on ${bind}:${s.port}`))
}
