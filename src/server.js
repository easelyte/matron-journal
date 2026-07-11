import http from 'node:http'
import { openDb } from './db.js'
import { makeLoginGuard, makeRateLimiter } from './auth.js'
import { makeHttpHandler } from './http.js'
import { makeHub } from './hub.js'
import { attachWs } from './ws.js'

export function startServer({ dbPath, port = 0, bind = '127.0.0.1' } = {}) {
  const db = openDb(dbPath || process.env.MATRON_DB || './matron.db')
  const rateLimiter = makeRateLimiter()
  const loginGuard = makeLoginGuard()
  const server = http.createServer(makeHttpHandler({ db, rateLimiter, loginGuard }))
  const hub = makeHub()
  const wss = attachWs({ server, db, hub })
  return new Promise((resolve) => {
    server.listen(port, bind, () => {
      resolve({
        port: server.address().port,
        db,
        server,
        hub,
        close: () => new Promise((r) => {
          wss.close()
          for (const c of wss.clients) c.terminate()
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
