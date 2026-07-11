import http from 'node:http'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.js'
import { makeLoginGuard, makeRateLimiter } from './auth.js'
import { makeHttpHandler } from './http.js'
import { makeHub } from './hub.js'
import { attachWs } from './ws.js'
import { makeApnsClient } from './apns.js'
import { makePushPipeline } from './push.js'
import { resolveMediaDir } from './media.js'
import { runOffload } from './retention.js'

const DEFAULT_MEDIA_MAX_BYTES = 52428800 // 50 MB
const DEFAULT_MAX_REPLAY = 50000
const DEFAULT_RETENTION_DAYS = 30
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h

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

// Runs at boot (called after `server.listen` succeeds) and every 6h
// thereafter (unref'd — never keeps the process alive on its own). Returns
// the interval handle (for close()) or null when retention is disabled.
function scheduleRetention(db, { mediaDir, retentionDays, retentionIntervalMs }) {
  const days = resolveRetentionDays(retentionDays)
  if (days === null) return null
  const run = () => {
    try {
      const r = runOffload(db, { days, mediaDir })
      if (r.offloaded > 0) console.log(`retention: offloaded ${r.offloaded} tool_output payload(s) older than ${days}d`)
    } catch (err) {
      console.error('retention: offload run failed', err)
    }
  }
  run()
  const interval = setInterval(run, retentionIntervalMs ?? RETENTION_INTERVAL_MS)
  interval.unref()
  return interval
}

// Direct APNs push is wired ONLY when all four MATRON_APNS_* vars are set
// (same disabled-by-default pattern as the rest of the server); otherwise a
// single warn log at boot and the push pipeline is an inert no-op.
function resolveApnsClient(injected) {
  if (injected) return { client: injected, owned: false }
  const { MATRON_APNS_KEY_FILE, MATRON_APNS_KEY_ID, MATRON_APNS_TEAM_ID, MATRON_APNS_TOPIC } = process.env
  if (MATRON_APNS_KEY_FILE && MATRON_APNS_KEY_ID && MATRON_APNS_TEAM_ID && MATRON_APNS_TOPIC) {
    const client = makeApnsClient({
      keyFile: MATRON_APNS_KEY_FILE, keyId: MATRON_APNS_KEY_ID,
      teamId: MATRON_APNS_TEAM_ID, topic: MATRON_APNS_TOPIC,
    })
    return { client, owned: true }
  }
  console.warn('apns: MATRON_APNS_KEY_FILE/MATRON_APNS_KEY_ID/MATRON_APNS_TEAM_ID/MATRON_APNS_TOPIC not all set — push notifications disabled')
  return { client: undefined, owned: false }
}

export function startServer({
  dbPath, port = 0, bind = '127.0.0.1', mediaDir, mediaMaxBytes, apnsClient, replayBackpressureBytes,
  retentionDays, retentionIntervalMs, maxReplay, revocationSweepMs,
} = {}) {
  const resolvedDbPath = dbPath || process.env.MATRON_DB || './matron.db'
  const db = openDb(resolvedDbPath)
  const rateLimiter = makeRateLimiter()
  const loginGuard = makeLoginGuard()
  const resolvedMediaDir = resolveMediaDir(resolvedDbPath, mediaDir)
  const resolvedMediaMaxBytes = mediaMaxBytes ?? (process.env.MATRON_MEDIA_MAX_BYTES ? Number(process.env.MATRON_MEDIA_MAX_BYTES) : DEFAULT_MEDIA_MAX_BYTES)
  const resolvedMaxReplay = maxReplay ?? (process.env.MATRON_MAX_REPLAY ? Number(process.env.MATRON_MAX_REPLAY) : DEFAULT_MAX_REPLAY)
  const hub = makeHub()
  const { client: resolvedApnsClient, owned: ownsApnsClient } = resolveApnsClient(apnsClient)
  const pushPipeline = makePushPipeline({ db, hub, apnsClient: resolvedApnsClient })
  const server = http.createServer(makeHttpHandler({
    db, rateLimiter, loginGuard, mediaDir: resolvedMediaDir, mediaMaxBytes: resolvedMediaMaxBytes,
    hub, pushPipeline, dbPath: resolvedDbPath,
  }))
  const wss = attachWs({ server, db, hub, pushPipeline, replayBackpressureBytes, maxReplay: resolvedMaxReplay, ...(revocationSweepMs !== undefined ? { revocationSweepMs } : {}) })
  let retentionInterval = null
  return new Promise((resolve) => {
    server.listen(port, bind, () => {
      retentionInterval = scheduleRetention(db, { mediaDir: resolvedMediaDir, retentionDays, retentionIntervalMs })
      resolve({
        port: server.address().port,
        db,
        server,
        hub,
        pushPipeline,
        close: () => new Promise((r) => {
          if (retentionInterval) clearInterval(retentionInterval)
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
