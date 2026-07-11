import http from 'node:http'
import path from 'node:path'
import { openDb } from './db.js'
import { makeLoginGuard, makeRateLimiter } from './auth.js'
import { makeHttpHandler } from './http.js'
import { makeHub } from './hub.js'
import { attachWs } from './ws.js'
import { makeApnsClient } from './apns.js'
import { makePushPipeline } from './push.js'

const DEFAULT_MEDIA_MAX_BYTES = 52428800 // 50 MB

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

export function startServer({ dbPath, port = 0, bind = '127.0.0.1', mediaDir, mediaMaxBytes, apnsClient, replayBackpressureBytes } = {}) {
  const resolvedDbPath = dbPath || process.env.MATRON_DB || './matron.db'
  const db = openDb(resolvedDbPath)
  const rateLimiter = makeRateLimiter()
  const loginGuard = makeLoginGuard()
  const resolvedMediaDir = mediaDir || process.env.MATRON_MEDIA_DIR || path.join(path.dirname(resolvedDbPath), 'media')
  const resolvedMediaMaxBytes = mediaMaxBytes ?? (process.env.MATRON_MEDIA_MAX_BYTES ? Number(process.env.MATRON_MEDIA_MAX_BYTES) : DEFAULT_MEDIA_MAX_BYTES)
  const server = http.createServer(makeHttpHandler({
    db, rateLimiter, loginGuard, mediaDir: resolvedMediaDir, mediaMaxBytes: resolvedMediaMaxBytes,
  }))
  const hub = makeHub()
  const { client: resolvedApnsClient, owned: ownsApnsClient } = resolveApnsClient(apnsClient)
  const pushPipeline = makePushPipeline({ db, hub, apnsClient: resolvedApnsClient })
  const wss = attachWs({ server, db, hub, pushPipeline, replayBackpressureBytes })
  return new Promise((resolve) => {
    server.listen(port, bind, () => {
      resolve({
        port: server.address().port,
        db,
        server,
        hub,
        pushPipeline,
        close: () => new Promise((r) => {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MATRON_PORT || 9810)
  const bind = process.env.MATRON_BIND || '127.0.0.1'
  startServer({ port, bind }).then((s) => console.log(`matron-journal listening on ${bind}:${s.port}`))
}
