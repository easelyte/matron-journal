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

// Asserts per-connection exactly-once delivery: cross-connection re-delivery is
// legitimate (a client killed after frames arrived but before it drained them lags
// its cursor, and the next connection correctly re-receives them - at-least-once +
// client-side dedup by seq is the design). What must never happen is a duplicate or
// out-of-order seq WITHIN a single connection's delivery, relative to the cursor it
// said hello with.
function assertPerConnectionOrder(delivered, helloCursor) {
  for (let i = 0; i < delivered.length; i++) {
    assert.ok(delivered[i] > helloCursor, `seq ${delivered[i]} <= hello cursor ${helloCursor} (duplicate within connection)`)
    if (i > 0) assert.ok(delivered[i] > delivered[i - 1], `non-ascending delivery: ${delivered[i - 1]} then ${delivered[i]}`)
  }
}

test('client store converges despite random disconnects', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-chaos-'))
  const s = await startTestServer({ dbPath: path.join(dir, 'chaos.db') })
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'chaos-agent')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'chaos' } })
  // Two independent PRNGs, one per concurrent flow: publishing and the reconnect loop
  // race against each other in phase 2, so a single shared generator would make draw
  // order (and therefore reproducibility) depend on OS scheduling. Each flow's own
  // draws are still deterministic in isolation; only the interleaving between flows
  // is OS-scheduled.
  const randPace = rng(1337)
  const randKill = rng(7331)
  const SEED = 700 // phase 1: pre-connect backlog, > 500 so a single replay must span 2+ batches
  const TOTAL = 1200 // grand total across both phases
  const CONVOS = ['s1', 's2', 's3']

  // agent: steady publish stream. No title: convo_upsert with a non-empty
  // title now fans out a convo_meta journal event (decision 1), and this
  // test's convergence loop below counts every kind:'journal' frame (not
  // just message types) toward TOTAL — an untitled convo keeps this test's
  // own stated invariant true ("convo_upsert without session_state appends
  // nothing") instead of racing 3 extra frames into that count.
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  for (const c of CONVOS) agent.send({ op: 'convo_upsert', convo_id: c })

  const publishOne = (i) => {
    const frame = {
      op: 'publish', convo_id: CONVOS[i % 3], type: 'text',
      payload: { body: `msg-${i}` }, idem_key: `k${i}`,
    }
    agent.send(frame)
    // Simulate an ack-timeout retry: re-send the IDENTICAL frame (same convo_id,
    // idem_key, payload). The server's idem_key dedup must absorb it as a no-op.
    if (randPace() < 0.15) agent.send(frame)
  }

  const store = new Map() // seq -> frame
  let cursor = 0

  // PHASE 1 - cold-start backlog replay (deterministic multi-batch).
  // Publish the first SEED events and wait for them to be committed *before* any
  // client connects. A client that then connects with cursor 0 must replay all
  // SEED events on a single hello - since SEED > 500 (the per-batch page size),
  // this forces the server down the batch-of-500 -> setImmediate yield -> second
  // batch path deterministically, with no race against a fast-reconnecting client
  // that could otherwise dodge ever falling behind by 500+ events.
  for (let i = 0; i < SEED; i++) {
    publishOne(i)
    if (randPace() < 0.3) await new Promise((r) => setTimeout(r, 5))
  }
  {
    const countRow = s.db.prepare('SELECT COUNT(*) AS n FROM events WHERE user_id=?')
    while (countRow.get(dan.id).n < SEED) {
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  {
    const helloCursor = cursor
    const c = await makeWsClient(s.base, { token: login.json.token, cursor })
    // Dedup means seqs stay a gapless 1..SEED regardless of the ~15% retries above,
    // so the SEED-th distinct publish is exactly seq SEED.
    await c.waitFor((f) => f.kind === 'journal' && f.seq === SEED, 10000)
    for (const fr of c.journal()) {
      if (!store.has(fr.seq)) store.set(fr.seq, fr)
      if (fr.seq > cursor) cursor = fr.seq
    }
    const delivered = c.journal().map((f) => f.seq)
    // Proves a multi-batch replay (SEED=700 > 500-per-batch) happened within one
    // connection and arrived exactly-once, in ascending order.
    assert.ok(delivered.length >= SEED, `expected >= ${SEED} journal frames from one cold-start connection, got ${delivered.length}`)
    assertPerConnectionOrder(delivered, helloCursor)
    // Clean close (not terminate) - phase 1 has no chaos, so let the connection
    // wind down normally before phase 2 begins.
    await new Promise((resolve) => {
      c.ws.once('close', resolve)
      c.close()
    })
  }

  // PHASE 2 - concurrent chaos. Publisher emits the remaining events while the
  // client repeatedly reconnects (from cursor = SEED) and gets killed mid-stream.
  const publishRest = (async () => {
    for (let i = SEED; i < TOTAL; i++) {
      publishOne(i)
      if (randPace() < 0.3) await new Promise((r) => setTimeout(r, 5))
    }
  })()

  // journal will hold exactly TOTAL events: convo_upsert without session_state
  // appends nothing.
  while (store.size < TOTAL) {
    const helloCursor = cursor
    const c = await makeWsClient(s.base, { token: login.json.token, cursor })
    const killAfter = 1 + Math.floor(randKill() * 40)
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

    const delivered = c.journal().map((f) => f.seq)
    assertPerConnectionOrder(delivered, helloCursor)
  }
  await publishRest

  // convergence: local store must be an exact copy of the journal
  const rows = s.db.prepare('SELECT seq, type, payload FROM events WHERE user_id=? ORDER BY seq').all(dan.id)
  // The journal must land at exactly TOTAL rows: convo_upsert without session_state
  // appends nothing, and ~15% of publishes were retried with an identical idem_key,
  // so this also proves the retries created no extra rows (idem dedupe held).
  assert.equal(rows.length, TOTAL)
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
