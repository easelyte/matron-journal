import WebSocket from 'ws'
import { startServer } from '../src/server.js'

export async function startTestServer(opts = {}) {
  // Unified search's similar tier (spec 2026-10-12 §5): default to no
  // embedder so the suite never tries to load (or download) a real model;
  // a test that wants the tier passes its own (e.g. `fakeEmbedder()`).
  // Background work starts at once and runs unpaced, so tests that await
  // it don't sit out the production startup delay.
  // Security events (src/security-log.js): no line on stdout and none in a
  // real MATRON_SECURITY_LOG; a test that reads them passes its own sinks.
  const s = await startServer({ dbPath: ':memory:', port: 0, fileOwnerUserId: 1, embedder: null, backgroundDelayMs: 0, retentionInitialDelayMs: 0, backgroundPace: 0, pushHoldMs: 0, securityLog: { out: () => {}, file: null }, ...opts })
  const base = `http://127.0.0.1:${s.port}`
  return {
    ...s,
    base,
    async http(path, { method = 'GET', token = null, body = null, headers = {} } = {}) {
      const r = await fetch(base + path, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      let j = null
      try { j = await r.json() } catch { /* empty body */ }
      return { status: r.status, json: j }
    },
  }
}

export function makeWsClient(base, { token, cursor, hello = {} }) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
  const frames = []
  ws.on('message', (d) => frames.push(JSON.parse(d)))
  return new Promise((resolve, reject) => {
    ws.on('error', reject)
    ws.on('open', () => {
      ws.send(JSON.stringify({ op: 'hello', token, cursor, ...hello }))
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
