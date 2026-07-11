import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'

test('agent activity reaches only the viewing client, carrying state+detail', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const loginA = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const loginB = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'ipad' } })

  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const viewer = await makeWsClient(s.base, { token: loginA.json.token, cursor: 0 })
  const other = await makeWsClient(s.base, { token: loginB.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await viewer.waitFor((f) => f.op === 'hello_ok')
  await other.waitFor((f) => f.op === 'hello_ok')

  agent.send({ op: 'convo_upsert', convo_id: 'sess-act', title: 'fix bug', session_state: 'running' })
  await viewer.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  await other.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')

  viewer.send({ op: 'viewing', convo_id: 'sess-act' })
  // `other` is left not-viewing sess-act (viewingConvoId stays null).
  await new Promise((r) => setTimeout(r, 50))

  agent.send({ op: 'activity', convo_id: 'sess-act', state: 'thinking', detail: 'analyzing files' })
  const frame = await viewer.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'sess-act')
  assert.deepEqual(frame.activity, { state: 'thinking', detail: 'analyzing files' })

  // the non-viewing client of the same user gets nothing for this convo.
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(other.frames.some((f) => f.kind === 'ephemeral'), false)

  agent.close(); viewer.close(); other.close()
})

test('client sending activity is forbidden', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')

  agent.send({ op: 'convo_upsert', convo_id: 'sess-act-cli' })
  client.send({ op: 'activity', convo_id: 'sess-act-cli', state: 'thinking' })
  await client.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'forbidden' && f.ref === 'activity')
  assert.equal(client.ws.readyState, 1)
  agent.close(); client.close()
})

test('activity with a bad or missing state is bad_request; connection survives', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  agent.send({ op: 'convo_upsert', convo_id: 'sess-act-bad' })

  agent.send({ op: 'activity', convo_id: 'sess-act-bad', state: 'bogus' })
  await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'activity')
  agent.send({ op: 'activity', convo_id: 'sess-act-bad' }) // missing state
  await agent.waitFor((f) =>
    agent.frames.filter((x) => x.kind === 'control' && x.op === 'error' && x.code === 'bad_request' && x.ref === 'activity').length >= 2)
  assert.equal(agent.ws.readyState, 1)

  // the three legitimate states all pass validation (no bad_request for these)
  for (const state of ['thinking', 'tool', 'idle']) {
    agent.send({ op: 'activity', convo_id: 'sess-act-bad', state })
  }
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(
    agent.frames.filter((x) => x.kind === 'control' && x.op === 'error' && x.code === 'bad_request' && x.ref === 'activity').length,
    2
  )
  agent.close()
})

test("activity on a convo the agent's user does not own (or that doesn't exist) is forbidden", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agDan = createAgent(s.db, dan.id, 'dev-2')
  upsertConversation(s.db, { id: 'cp-act', ownerUserId: pat.id })
  const agent = await makeWsClient(s.base, { token: agDan.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')

  agent.send({ op: 'activity', convo_id: 'cp-act', state: 'thinking' })
  await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'forbidden' && f.ref === 'activity')

  agent.send({ op: 'activity', convo_id: 'does-not-exist', state: 'thinking' })
  await agent.waitFor((f) =>
    agent.frames.filter((x) => x.kind === 'control' && x.op === 'error' && x.code === 'forbidden' && x.ref === 'activity').length >= 2)
  assert.equal(agent.ws.readyState, 1)
  agent.close()
})

test('activity detail is truncated at 200 chars, not rejected', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')

  agent.send({ op: 'convo_upsert', convo_id: 'sess-act-trunc' })
  await new Promise((r) => setTimeout(r, 20))
  client.send({ op: 'viewing', convo_id: 'sess-act-trunc' })
  await new Promise((r) => setTimeout(r, 50))

  const longDetail = 'x'.repeat(250)
  agent.send({ op: 'activity', convo_id: 'sess-act-trunc', state: 'tool', detail: longDetail })
  const frame = await client.waitFor((f) => f.kind === 'ephemeral')
  assert.equal(frame.activity.detail.length, 200)
  assert.equal(frame.activity.detail, 'x'.repeat(200))
  agent.close(); client.close()
})

test('non-string activity detail (number/object) does not crash; frame arrives with detail omitted', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')

  agent.send({ op: 'convo_upsert', convo_id: 'sess-act-nonstr' })
  await new Promise((r) => setTimeout(r, 20))
  client.send({ op: 'viewing', convo_id: 'sess-act-nonstr' })
  await new Promise((r) => setTimeout(r, 50))

  // Sent one at a time (awaiting delivery between them) — the hub coalesces
  // activity frames of one convo under a single key, so two rapid sends
  // would collapse to the latest and the first assertion would race.
  agent.send({ op: 'activity', convo_id: 'sess-act-nonstr', state: 'thinking', detail: 42 })
  const numFrame = await client.waitFor((f) => f.kind === 'ephemeral' && f.activity && f.activity.state === 'thinking')
  assert.equal('detail' in numFrame.activity, false)

  agent.send({ op: 'activity', convo_id: 'sess-act-nonstr', state: 'tool', detail: { nested: 'object' } })
  const objFrame = await client.waitFor((f) => f.kind === 'ephemeral' && f.activity && f.activity.state === 'tool')
  assert.equal('detail' in objFrame.activity, false)

  // no error frames, connection intact — a non-string detail is dropped, never fatal
  assert.equal(agent.frames.some((f) => f.kind === 'control' && f.op === 'error'), false)
  assert.equal(agent.ws.readyState, 1)
  agent.close(); client.close()
})

test('activity never touches the journal or the push pipeline', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')

  agent.send({ op: 'convo_upsert', convo_id: 'sess-act-journal', title: 'journal check' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta')
  client.send({ op: 'viewing', convo_id: 'sess-act-journal' })
  await new Promise((r) => setTimeout(r, 50))

  const seqBefore = s.db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(dan.id).seq
  const rowsBefore = s.db.prepare('SELECT COUNT(*) n FROM events').get().n

  let onAppendCalls = 0
  const origOnAppend = s.pushPipeline.onAppend
  s.pushPipeline.onAppend = (...args) => { onAppendCalls += 1; return origOnAppend(...args) }

  for (let i = 0; i < 5; i++) {
    agent.send({ op: 'activity', convo_id: 'sess-act-journal', state: i % 2 === 0 ? 'tool' : 'idle', detail: `step ${i}` })
  }
  await client.waitFor((f) => f.kind === 'ephemeral' && f.activity.detail === 'step 4')

  s.pushPipeline.onAppend = origOnAppend
  assert.equal(onAppendCalls, 0)
  assert.equal(s.db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(dan.id).seq, seqBefore)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM events').get().n, rowsBefore)

  agent.close(); client.close()
})
