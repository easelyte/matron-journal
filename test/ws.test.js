import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { waitForDrain } from '../src/ws.js'

test('hello replays from cursor, then streams live appends', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id })
  for (let i = 1; i <= 3; i++) {
    append(s.db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: `m${i}` } })
  }
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })

  const c = await makeWsClient(s.base, { token: login.json.token, cursor: 1 })
  await c.waitFor((f) => f.kind === 'journal' && f.seq === 3)
  assert.deepEqual(c.journal().map((f) => f.seq), [2, 3])

  // a live append (as if from another connection) must be fanned out
  const r = append(s.db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'live' } })
  s.hub.broadcastJournal(dan.id, { kind: 'journal', seq: r.seq, convo_id: 'c1', ts: r.ts, sender: 'agent:a', type: 'text', payload: { body: 'live' } })
  await c.waitFor((f) => f.kind === 'journal' && f.seq === 4)
  c.close()
})

test('bad token gets error control frame', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const c = await makeWsClient(s.base, { token: 'nope', cursor: 0 })
  await c.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'auth')
  c.close()
})

test('null and non-JSON frames do not crash the server', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })

  // pre-auth: null frame → closed, no crash
  const raw = new (await import('ws')).default(s.base.replace('http', 'ws') + '/ws')
  await new Promise((r) => raw.on('open', r))
  raw.send('null')
  await new Promise((r) => raw.on('close', r))

  // pre-auth: non-JSON frame → closed
  const raw2 = new (await import('ws')).default(s.base.replace('http', 'ws') + '/ws')
  await new Promise((r) => raw2.on('open', r))
  raw2.send('{not json')
  await new Promise((r) => raw2.on('close', r))

  // post-auth: junk frame ignored, connection survives
  const c = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await c.waitFor((f) => f.op === 'hello_ok')
  c.ws.send('null')
  c.ws.send('{bad')
  c.send({ op: 'viewing', convo_id: null })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(c.ws.readyState, 1)
  // and the server still works end-to-end
  assert.equal((await s.http('/snapshot', { token: login.json.token })).status, 200)
  c.close()
})

test('replay of a multi-batch backlog arrives complete and in order', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'big', ownerUserId: dan.id })
  for (let i = 0; i < 1203; i++) {
    append(s.db, { userId: dan.id, convoId: 'big', sender: 'agent:a', type: 'text', payload: { body: `m${i}` } })
  }
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const c = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await c.waitFor((f) => f.kind === 'journal' && f.seq === 1203, 10000)
  const seqs = c.journal().map((f) => f.seq)
  assert.equal(seqs.length, 1203)
  seqs.forEach((v, i) => assert.equal(v, i + 1))
  c.close()
})

test('send, prompt_reply, read_marker round-trip to a second device', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id })
  const l1 = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const l2 = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'phone' } })
  const mac = await makeWsClient(s.base, { token: l1.json.token, cursor: 0 })
  const phone = await makeWsClient(s.base, { token: l2.json.token, cursor: 0 })

  mac.send({ op: 'send', convo_id: 'c1', payload: { body: 'do it' }, local_id: 'x1' })
  const f = await phone.waitFor((x) => x.kind === 'journal' && x.type === 'text')
  assert.equal(f.payload.body, 'do it')
  assert.equal(f.sender, 'user:dan')
  // a user's own send must not inflate their own unread badge
  assert.equal(s.db.prepare("SELECT unread_count FROM conversations WHERE id='c1'").get().unread_count, 0)

  mac.send({ op: 'read_marker', convo_id: 'c1', up_to_seq: f.seq })
  const rm = await phone.waitFor((x) => x.kind === 'journal' && x.type === 'read_marker')
  // broadcast frame must be byte-identical to the persisted row: username, not user id
  assert.equal(rm.sender, 'user:dan')
  assert.equal(s.db.prepare('SELECT sender FROM events WHERE seq=?').get(rm.seq).sender, rm.sender)

  mac.send({ op: 'ack', cursor: f.seq })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(s.db.prepare('SELECT cursor FROM devices WHERE id=?').get(l1.json.device_id).cursor, f.seq)

  // foreign convo rejected
  const pat = await createUser(s.db, 'pat', 'pw')
  upsertConversation(s.db, { id: 'cp', ownerUserId: pat.id })
  mac.send({ op: 'send', convo_id: 'cp', payload: { body: 'nope' } })
  await mac.waitFor((x) => x.kind === 'control' && x.op === 'error' && x.code === 'forbidden')
  mac.close(); phone.close()
})

test('send type whitelist and ack validation', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id })
  const l = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const c = await makeWsClient(s.base, { token: l.json.token, cursor: 0 })
  await c.waitFor((f) => f.op === 'hello_ok')

  c.send({ op: 'send', convo_id: 'c1', type: 'session_status', payload: { state: 'archived' } })
  await c.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'forbidden' && f.ref === 'send')
  assert.equal(s.db.prepare("SELECT session_state FROM conversations WHERE id='c1'").get().session_state, 'running')

  c.send({ op: 'ack', cursor: -5 })
  await c.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request')
  c.send({ op: 'ack' })
  await c.waitFor((f) => c.frames.filter((x) => x.code === 'bad_request').length >= 2)
  assert.equal(s.db.prepare('SELECT cursor FROM devices WHERE id=?').get(l.json.device_id).cursor, 0)

  c.send({ op: 'ack', cursor: 7 })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(s.db.prepare('SELECT cursor FROM devices WHERE id=?').get(l.json.device_id).cursor, 7)
  c.close()
})

test('send with a missing or non-object payload is rejected as bad_request, not a crash', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id })
  const l = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const c = await makeWsClient(s.base, { token: l.json.token, cursor: 0 })
  await c.waitFor((f) => f.op === 'hello_ok')

  c.send({ op: 'send', convo_id: 'c1' }) // no payload at all
  await c.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'send')
  c.send({ op: 'send', convo_id: 'c1', payload: 'not an object' })
  await c.waitFor((f) => c.frames.filter((x) => x.code === 'bad_request' && x.ref === 'send').length >= 2)
  c.send({ op: 'send', convo_id: 'c1', payload: null })
  await c.waitFor((f) => c.frames.filter((x) => x.code === 'bad_request' && x.ref === 'send').length >= 3)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE convo_id='c1'").get().n, 0)
  assert.equal(c.ws.readyState, 1) // connection survives
  c.close()
})

test('prompt_reply requires an integer target_seq (the ref it answers)', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id })
  const l = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const c = await makeWsClient(s.base, { token: l.json.token, cursor: 0 })
  await c.waitFor((f) => f.op === 'hello_ok')

  c.send({ op: 'prompt_reply', convo_id: 'c1', target_seq: 'nope', choice: 'yes' })
  await c.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'prompt_reply')
  c.send({ op: 'prompt_reply', convo_id: 'c1', choice: 'yes' }) // target_seq missing entirely
  await c.waitFor((f) => c.frames.filter((x) => x.code === 'bad_request' && x.ref === 'prompt_reply').length >= 2)
  c.send({ op: 'prompt_reply', convo_id: 'c1', target_seq: 1.5, choice: 'yes' })
  await c.waitFor((f) => c.frames.filter((x) => x.code === 'bad_request' && x.ref === 'prompt_reply').length >= 3)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='prompt_reply'").get().n, 0)

  c.send({ op: 'prompt_reply', convo_id: 'c1', target_seq: 3, choice: 'yes' })
  await c.waitFor((f) => f.kind === 'journal' && f.type === 'prompt_reply')
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='prompt_reply'").get().n, 1)
  c.close()
})

test('read_marker requires up_to_seq to be null or a non-negative integer', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id })
  const l = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const c = await makeWsClient(s.base, { token: l.json.token, cursor: 0 })
  await c.waitFor((f) => f.op === 'hello_ok')

  c.send({ op: 'read_marker', convo_id: 'c1', up_to_seq: -1 })
  await c.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'read_marker')
  c.send({ op: 'read_marker', convo_id: 'c1', up_to_seq: 1.5 })
  await c.waitFor((f) => c.frames.filter((x) => x.code === 'bad_request' && x.ref === 'read_marker').length >= 2)
  c.send({ op: 'read_marker', convo_id: 'c1', up_to_seq: 'abc' })
  await c.waitFor((f) => c.frames.filter((x) => x.code === 'bad_request' && x.ref === 'read_marker').length >= 3)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='read_marker'").get().n, 0)

  // null is still valid — resolves server-side to the conversation head
  c.send({ op: 'read_marker', convo_id: 'c1', up_to_seq: null })
  await c.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker')
  // and an explicit non-negative integer (including 0) still works
  c.send({ op: 'read_marker', convo_id: 'c1', up_to_seq: 0 })
  await c.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker' && f.payload.up_to_seq === 0)
  c.close()
})

test('hello with a non-integer, non-null cursor gets a bad_request error frame and the socket is closed', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'pw')
  const l = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })

  for (const badCursor of ['abc', 1.5, {}, []]) {
    const raw = new (await import('ws')).default(s.base.replace('http', 'ws') + '/ws')
    await new Promise((r) => raw.on('open', r))
    const frames = []
    raw.on('message', (d) => frames.push(JSON.parse(d)))
    raw.send(JSON.stringify({ op: 'hello', token: l.json.token, cursor: badCursor }))
    await new Promise((r) => raw.on('close', r))
    assert.ok(
      frames.some((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'hello'),
      `expected a bad_request error frame for cursor=${JSON.stringify(badCursor)}, got ${JSON.stringify(frames)}`
    )
  }
})

test('WS maxPayload (1 MiB) closes a connection that sends an oversized frame', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id })
  const l = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const c = await makeWsClient(s.base, { token: l.json.token, cursor: 0 })
  await c.waitFor((f) => f.op === 'hello_ok')

  const big = 'x'.repeat(2 * 1024 * 1024) // 2 MiB, over the 1 MiB cap
  c.send({ op: 'send', convo_id: 'c1', payload: { body: big } })
  await new Promise((r) => c.ws.on('close', r))
  assert.equal(c.ws.readyState, 3) // CLOSED
})

test('waitForDrain resolves immediately when already under the threshold', async () => {
  const fakeWs = { readyState: 1, bufferedAmount: 10 }
  const t0 = Date.now()
  await waitForDrain(fakeWs, 1000, 5)
  assert.ok(Date.now() - t0 < 50)
})

test('waitForDrain polls until bufferedAmount drops below the threshold', async () => {
  const fakeWs = { readyState: 1, bufferedAmount: 5000 }
  setTimeout(() => { fakeWs.bufferedAmount = 100 }, 30)
  const t0 = Date.now()
  await waitForDrain(fakeWs, 1000, 5)
  assert.ok(Date.now() - t0 >= 25, 'should have waited for at least one poll cycle before draining')
  assert.ok(fakeWs.bufferedAmount <= 1000)
})

test('waitForDrain gives up once the socket is no longer open, rather than hanging forever', async () => {
  const fakeWs = { readyState: 1, bufferedAmount: 999999999 }
  setTimeout(() => { fakeWs.readyState = 3 }, 20) // CLOSED; bufferedAmount never drains
  const t0 = Date.now()
  await waitForDrain(fakeWs, 1000, 5)
  assert.ok(Date.now() - t0 < 500, 'must not hang forever waiting on a dead socket')
})

test('replay backpressure wait-loop is wired into a real connection: even at a tiny threshold, replay stays complete and in order', async (t) => {
  // A threshold this small means the drain-wait loop is exercised at every
  // batch boundary (ws.bufferedAmount is essentially always "over" 1 byte
  // right after a send). The client here reads normally, so bufferedAmount
  // drains quickly and this stays fast and deterministic.
  const s = await startTestServer({ replayBackpressureBytes: 1 })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'big', ownerUserId: dan.id })
  for (let i = 0; i < 1203; i++) {
    append(s.db, { userId: dan.id, convoId: 'big', sender: 'agent:a', type: 'text', payload: { body: `m${i}` } })
  }
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const c = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await c.waitFor((f) => f.kind === 'journal' && f.seq === 1203, 10000)
  const seqs = c.journal().map((f) => f.seq)
  assert.equal(seqs.length, 1203)
  seqs.forEach((v, i) => assert.equal(v, i + 1))
  c.close()
})

test('a socket that closes mid-replay is never left registered in the hub', async (t) => {
  // replayBackpressureBytes: -1 parks the replay loop in waitForDrain at the
  // first batch boundary indefinitely (bufferedAmount >= 0 is always > -1)
  // until the socket stops being open — a deterministic stand-in for a peer
  // that stops reading during a large replay, with no dependence on real
  // kernel buffer sizes.
  const s = await startTestServer({ replayBackpressureBytes: -1 })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'big', ownerUserId: dan.id })
  for (let i = 0; i < 520; i++) {
    append(s.db, { userId: dan.id, convoId: 'big', sender: 'agent:a', type: 'text', payload: { body: `m${i}` } })
  }
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const c = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  // Receiving seq 500 (the batch-1 boundary) proves the server has sent the
  // whole first batch and moved on to the drain wait, where it is now parked.
  await c.waitFor((f) => f.kind === 'journal' && f.seq === 500, 10000)
  assert.equal(s.hub.connsOf(dan.id).length, 0, 'precondition: registration must not have happened mid-replay')
  // Close while the server is parked mid-replay. Its 'close' handler runs
  // before registration — the bug was that replay then completed and
  // registered a permanently-dead conn nothing would ever prune.
  c.ws.terminate()
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(s.hub.connsOf(dan.id).length, 0, 'a closed socket must never remain registered')
})
