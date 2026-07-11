import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'

test('agent publishes, streams ephemerally, finalizes durably', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })

  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')

  agent.send({ op: 'convo_upsert', convo_id: 'sess-1', title: 'fix bug', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')

  client.send({ op: 'viewing', convo_id: 'sess-1' })
  await new Promise((r) => setTimeout(r, 50))

  // 20 rapid stream deltas coalesce to few ephemeral frames, none durable
  for (let i = 0; i < 20; i++) {
    agent.send({ op: 'stream', convo_id: 'sess-1', message_ref: 'm1', replace_text: `progress ${i}` })
  }
  await client.waitFor((f) => f.kind === 'ephemeral' && f.replace_text === 'progress 19', 3000)
  const ephemerals = client.frames.filter((f) => f.kind === 'ephemeral')
  assert.ok(ephemerals.length <= 5, `expected coalescing, got ${ephemerals.length}`)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='text'").get().n, 0)

  agent.send({ op: 'finalize', convo_id: 'sess-1', message_ref: 'm1', payload: { body: 'done: 3 files changed' } })
  const fin = await client.waitFor((f) => f.kind === 'journal' && f.type === 'text')
  assert.equal(fin.payload.body, 'done: 3 files changed')
  assert.equal(fin.sender, 'agent:dev-2')

  // finalize retry is idempotent
  agent.send({ op: 'finalize', convo_id: 'sess-1', message_ref: 'm1', payload: { body: 'done: 3 files changed' } })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='text'").get().n, 1)

  // clients may not use agent ops
  client.send({ op: 'publish', convo_id: 'sess-1', type: 'text', payload: { body: 'x' } })
  await client.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'forbidden')
  agent.close(); client.close()
})

test('malformed agent publish/finalize get bad_request, connection survives', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  agent.send({ op: 'convo_upsert', convo_id: 's1', title: 't' })
  agent.send({ op: 'publish', convo_id: 's1', type: 'text', payload: null })
  await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'publish')
  agent.send({ op: 'publish', convo_id: 's1', payload: { body: 'x' } })
  await agent.waitFor((f) => agent.frames.filter((x) => x.code === 'bad_request' && x.ref === 'publish').length >= 2)
  agent.send({ op: 'finalize', convo_id: 's1', message_ref: 'm9', payload: null })
  await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'finalize')
  assert.equal(agent.ws.readyState, 1)
  // convo_upsert with a non-empty title at creation legitimately appends one
  // convo_meta event; none of the malformed publish/finalize attempts add more.
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM events').get().n, 1)
  assert.equal(s.db.prepare('SELECT type FROM events').get().type, 'convo_meta')
  agent.close()
})

test('convo_meta fans out on title change, not on same-title or state-only upserts', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')

  // creation with a non-empty title -> convo_meta
  agent.send({ op: 'convo_upsert', convo_id: 'sess-cm', title: 'first title' })
  const created = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta')
  assert.equal(created.payload.title, 'first title')
  assert.equal(created.sender, 'agent:dev-2')

  // same-title upsert (with an unrelated session_state change) -> no additional convo_meta
  agent.send({ op: 'convo_upsert', convo_id: 'sess-cm', title: 'first title', session_state: 'waiting' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE convo_id='sess-cm' AND type='convo_meta'").get().n, 1)

  // state-only upsert (no title field at all) -> no convo_meta
  agent.send({ op: 'convo_upsert', convo_id: 'sess-cm', session_state: 'done' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status' && f.payload.state === 'done')
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE convo_id='sess-cm' AND type='convo_meta'").get().n, 1)

  // an actual title change -> another convo_meta
  agent.send({ op: 'convo_upsert', convo_id: 'sess-cm', title: 'renamed' })
  const renamed = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta' && f.payload.title === 'renamed')
  assert.equal(renamed.sender, 'agent:dev-2')
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE convo_id='sess-cm' AND type='convo_meta'").get().n, 2)

  agent.close(); client.close()
})

test('agent publish with a fin:-prefixed idem_key is rejected, nothing lands', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  agent.send({ op: 'convo_upsert', convo_id: 'sess-fin' })

  agent.send({ op: 'publish', convo_id: 'sess-fin', type: 'text', payload: { body: 'x' }, idem_key: 'fin:sneaky' })
  const err = await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'publish')
  assert.equal(err.detail, 'idem_key prefix fin: is reserved')
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE convo_id='sess-fin'").get().n, 0)

  // finalize's own internally composed fin: keys are unaffected
  agent.send({ op: 'finalize', convo_id: 'sess-fin', message_ref: 'm1', payload: { body: 'ok' } })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'text')
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE convo_id='sess-fin' AND type='text'").get().n, 1)
  agent.close()
})

test('agent read_marker resets unread and fans out; up_to_seq null resolves to head', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')

  agent.send({ op: 'convo_upsert', convo_id: 'sess-rm' })
  agent.send({ op: 'publish', convo_id: 'sess-rm', type: 'text', payload: { body: 'mirrored' } })
  const mirrored = await client.waitFor((f) => f.kind === 'journal' && f.type === 'text')
  assert.equal(s.db.prepare("SELECT unread_count FROM conversations WHERE id='sess-rm'").get().unread_count, 1)

  agent.send({ op: 'read_marker', convo_id: 'sess-rm', up_to_seq: null })
  const rm = await client.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker')
  assert.equal(rm.sender, 'agent:dev-2')
  assert.equal(rm.payload.up_to_seq, mirrored.seq)
  assert.equal(s.db.prepare("SELECT unread_count FROM conversations WHERE id='sess-rm'").get().unread_count, 0)
  const row = s.db.prepare('SELECT sender, payload FROM events WHERE seq=?').get(rm.seq)
  assert.equal(row.sender, 'agent:dev-2')
  assert.equal(JSON.parse(row.payload).up_to_seq, mirrored.seq)

  agent.close(); client.close()
})

test('agent publish type whitelist: rejects server-generated/unknown types, accepts exactly the allowed set', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  agent.send({ op: 'convo_upsert', convo_id: 'sess-wl' })

  // convo_meta/session_status/read_marker are server-generated (only reachable
  // via convo_upsert / the read_marker op) and must not be forgeable via a
  // bare publish; unknown/future type strings are rejected the same way.
  const rejected = ['session_status', 'read_marker', 'convo_meta', 'bogus', 'm.text']
  for (const type of rejected) {
    agent.send({ op: 'publish', convo_id: 'sess-wl', type, payload: { body: 'x' } })
  }
  await agent.waitFor((f) =>
    agent.frames.filter((x) => x.kind === 'control' && x.op === 'error' && x.code === 'bad_request' && x.ref === 'publish').length >= rejected.length)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE convo_id='sess-wl'").get().n, 0)

  const allowed = ['text', 'prompt', 'prompt_reply', 'tool_output', 'diff', 'permission_request', 'file', 'image', 'edit']
  for (const type of allowed) {
    agent.send({ op: 'publish', convo_id: 'sess-wl', type, payload: { body: 'ok' } })
  }
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'edit') // the last one sent
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE convo_id='sess-wl'").get().n, allowed.length)
  agent.close()
})

test('agent finalize with type session_status and a payload missing a valid state fails cleanly, connection survives', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  agent.send({ op: 'convo_upsert', convo_id: 's-fin-ss' })

  // finalize isn't subject to the publish whitelist, so this is the one
  // remaining agent-reachable path to append()'s session_status branch with
  // an arbitrary payload shape — must fail cleanly, not crash the process.
  agent.send({ op: 'finalize', convo_id: 's-fin-ss', message_ref: 'm1', type: 'session_status', payload: {} })
  await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.ref === 'finalize')
  assert.equal(agent.ws.readyState, 1)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE convo_id='s-fin-ss' AND type='session_status'").get().n, 0)
  agent.close()
})

test("agent read_marker on a convo the agent's user does not own fails closed", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat4', 'pw')
  const agDan = createAgent(s.db, dan.id, 'dev-2')
  upsertConversation(s.db, { id: 'cp-rm', ownerUserId: pat.id })
  const agent = await makeWsClient(s.base, { token: agDan.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')

  agent.send({ op: 'read_marker', convo_id: 'cp-rm', up_to_seq: null })
  await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'forbidden' && f.ref === 'read_marker')
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE convo_id='cp-rm'").get().n, 0)
  assert.equal(s.db.prepare("SELECT unread_count FROM conversations WHERE id='cp-rm'").get().unread_count, 0)
  agent.close()
})
