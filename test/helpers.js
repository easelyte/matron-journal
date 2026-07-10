import WebSocket from 'ws'
import { startServer } from '../src/server.js'

export async function startTestServer(opts = {}) {
  const s = await startServer({ dbPath: ':memory:', port: 0, ...opts })
  const base = `http://127.0.0.1:${s.port}`
  return {
    ...s,
    base,
    async http(path, { method = 'GET', token = null, body = null } = {}) {
      const r = await fetch(base + path, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      let j = null
      try { j = await r.json() } catch { /* empty body */ }
      return { status: r.status, json: j }
    },
  }
}

export function makeWsClient(base, { token, cursor }) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
  const frames = []
  ws.on('message', (d) => frames.push(JSON.parse(d)))
  return new Promise((resolve, reject) => {
    ws.on('error', reject)
    ws.on('open', () => {
      ws.send(JSON.stringify({ op: 'hello', token, cursor }))
      resolve({
        ws,
        frames,
        journal: () => frames.filter((f) => f.kind === 'journal'),
        send: (obj) => ws.send(JSON.stringify(obj)),
        close: () => ws.close(),
        waitFor(pred, ms = 2000) {
          return new Promise((res, rej) => {
            const t0 = Date.now()
            const iv = setInterval(() => {
              const hit = frames.find(pred)
              if (hit) { clearInterval(iv); res(hit) }
              else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('waitFor timeout')) }
            }, 10)
          })
        },
      })
    })
  })
}
