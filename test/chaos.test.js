import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'

// deterministic PRNG (mulberry32) so failures reproduce
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('client store converges despite random disconnects', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-chaos-'))
  const s = await startTestServer({ dbPath: path.join(dir, 'chaos.db') })
  t.after(() => { s.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'chaos-agent')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'chaos' } })
  const rand = rng(1337)
  const TOTAL = 300
  const CONVOS = ['s1', 's2', 's3']

  // agent: steady publish stream
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  for (const c of CONVOS) agent.send({ op: 'convo_upsert', convo_id: c, title: c })
  const publishAll = (async () => {
    for (let i = 0; i < TOTAL; i++) {
      agent.send({
        op: 'publish', convo_id: CONVOS[i % 3], type: 'text',
        payload: { body: `msg-${i}` }, idem_key: `k${i}`,
      })
      if (rand() < 0.3) await new Promise((r) => setTimeout(r, 5))
    }
  })()

  // client: apply frames to a local store, killing the socket randomly
  const store = new Map() // seq -> frame
  let cursor = 0
  // journal will hold exactly TOTAL events: convo_upsert without session_state appends nothing
  while (store.size < TOTAL) {
    const c = await makeWsClient(s.base, { token: login.json.token, cursor })
    const killAfter = 1 + Math.floor(rand() * 40)
    try {
      await c.waitFor((f) => {
        for (const fr of c.journal()) {
          if (!store.has(fr.seq)) store.set(fr.seq, fr)
          if (fr.seq > cursor) cursor = fr.seq
        }
        return c.journal().length >= killAfter || store.size >= TOTAL
      }, 5000)
    } catch { /* quiet period - reconnect */ }
    c.ws.terminate() // simulate abrupt network death, not clean close
  }
  await publishAll

  // convergence: local store must be an exact copy of the journal
  const rows = s.db.prepare('SELECT seq, type, payload FROM events WHERE user_id=? ORDER BY seq').all(dan.id)
  assert.equal(store.size, rows.length)
  for (const r of rows) {
    const local = store.get(r.seq)
    assert.ok(local, `missing seq ${r.seq}`)
    assert.equal(local.type, r.type)
    assert.deepEqual(local.payload, JSON.parse(r.payload))
  }
  // no duplicates, no gaps
  const seqs = [...store.keys()].sort((a, b) => a - b)
  seqs.forEach((v, i) => assert.equal(v, i + 1))
  agent.close()
})
