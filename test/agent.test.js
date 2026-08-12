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

test('convo_upsert accepts parent_convo_id: convo_meta payload and snapshot carry it; it is immutable', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')

  // parent must exist as a row for a realistic setup (not required by server, but tidy)
  agent.send({ op: 'convo_upsert', convo_id: 'parent-1', title: 'parent' })
  await client.waitFor((f) => f.kind === 'journal' && f.convo_id === 'parent-1' && f.type === 'convo_meta')

  // child creation with a title -> convo_meta payload carries parent_convo_id
  agent.send({ op: 'convo_upsert', convo_id: 'child-1', title: 'sub-chat', parent_convo_id: 'parent-1' })
  const meta = await client.waitFor((f) => f.kind === 'journal' && f.convo_id === 'child-1' && f.type === 'convo_meta')
  assert.equal(meta.payload.title, 'sub-chat')
  assert.equal(meta.payload.parent_convo_id, 'parent-1')

  // immutable: a later upsert with a different parent must not change it
  agent.send({ op: 'convo_upsert', convo_id: 'child-1', title: 'renamed', parent_convo_id: 'other' })
  await client.waitFor((f) => f.kind === 'journal' && f.convo_id === 'child-1' && f.type === 'convo_meta' && f.payload.title === 'renamed')
  assert.equal(s.db.prepare("SELECT parent_convo_id FROM conversations WHERE id='child-1'").get().parent_convo_id, 'parent-1')

  // snapshot carries parent_convo_id (set for the child, null for the parent)
  const snap = await s.http('/snapshot', { token: login.json.token })
  assert.equal(snap.json.conversations.find((c) => c.id === 'child-1').parent_convo_id, 'parent-1')
  assert.equal(snap.json.conversations.find((c) => c.id === 'parent-1').parent_convo_id, null)

  agent.close(); client.close()
})

test('convo_upsert rejects a malformed parent_convo_id with bad_request, connection survives', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')

  for (const bad of [42, '', 'x'.repeat(129), {}, []]) {
    agent.send({ op: 'convo_upsert', convo_id: `bad-${Math.random()}`, parent_convo_id: bad })
    await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'convo_upsert')
  }
  assert.equal(agent.ws.readyState, 1)
  // Nothing landed: no conversation row and no journal event from the rejected upserts.
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM conversations').get().n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0)

  // A valid null/omitted parent still works (normal convo).
  agent.send({ op: 'convo_upsert', convo_id: 'ok-1', parent_convo_id: null })
  agent.send({ op: 'convo_upsert', convo_id: 'ok-1', session_state: 'running' })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  assert.equal(s.db.prepare("SELECT parent_convo_id FROM conversations WHERE id='ok-1'").get().parent_convo_id, null)
  agent.close()
})

test('convo_upsert accepts session_outcome: session_status payload and snapshot carry it; it is mutable and sticky', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')

  // A running child carries no outcome yet: the key is absent from the payload,
  // so an existing client's session_status frame is unchanged.
  agent.send({ op: 'convo_upsert', convo_id: 'codex-1', title: 'review run', parent_convo_id: 'parent-1', session_state: 'running' })
  const running = await client.waitFor((f) => f.kind === 'journal' && f.convo_id === 'codex-1' && f.type === 'session_status')
  assert.equal(running.payload.state, 'running')
  assert.ok(!('session_outcome' in running.payload))

  // Terminal upsert: the outcome rides the same session_status event.
  agent.send({ op: 'convo_upsert', convo_id: 'codex-1', session_state: 'done', session_outcome: 'completed' })
  const done = await client.waitFor((f) => f.kind === 'journal' && f.convo_id === 'codex-1' && f.type === 'session_status' && f.payload.state === 'done')
  assert.equal(done.payload.session_outcome, 'completed')
  assert.equal(s.db.prepare("SELECT session_outcome FROM conversations WHERE id='codex-1'").get().session_outcome, 'completed')

  // Sticky: a later upsert that omits the outcome must not clear it, and the
  // status event still reports it (read back from the row, not the frame).
  agent.send({ op: 'convo_upsert', convo_id: 'codex-1', session_state: 'archived' })
  const archived = await client.waitFor((f) => f.kind === 'journal' && f.convo_id === 'codex-1' && f.type === 'session_status' && f.payload.state === 'archived')
  assert.equal(archived.payload.session_outcome, 'completed')
  assert.equal(s.db.prepare("SELECT session_outcome FROM conversations WHERE id='codex-1'").get().session_outcome, 'completed')

  // Mutable, unlike parent_convo_id: a re-emit with a different outcome wins.
  agent.send({ op: 'convo_upsert', convo_id: 'codex-1', session_state: 'done', session_outcome: 'failed' })
  await client.waitFor((f) => f.kind === 'journal' && f.convo_id === 'codex-1' && f.type === 'session_status' && f.payload.session_outcome === 'failed')
  assert.equal(s.db.prepare("SELECT session_outcome FROM conversations WHERE id='codex-1'").get().session_outcome, 'failed')

  // A plain conversation reads null, so clients can tell "no outcome" from any value.
  agent.send({ op: 'convo_upsert', convo_id: 'plain-1', title: 'normal', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.convo_id === 'plain-1' && f.type === 'session_status')

  const snap = await s.http('/snapshot', { token: login.json.token })
  assert.equal(snap.json.conversations.find((c) => c.id === 'codex-1').session_outcome, 'failed')
  assert.equal(snap.json.conversations.find((c) => c.id === 'plain-1').session_outcome, null)

  agent.close(); client.close()
})

test('convo_upsert stores an unenumerated session_outcome verbatim so a newer bridge is not rejected', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')

  // The journal does not own the outcome vocabulary. A value it has never
  // heard of is stored as-is, not rejected — clients render an unknown outcome
  // as "status unknown" rather than breaking.
  agent.send({ op: 'convo_upsert', convo_id: 'codex-new', session_state: 'done', session_outcome: 'timed-out' })
  const ev = await agent.waitFor((f) => f.kind === 'journal' && f.convo_id === 'codex-new' && f.type === 'session_status')
  assert.equal(ev.payload.session_outcome, 'timed-out')
  assert.equal(s.db.prepare("SELECT session_outcome FROM conversations WHERE id='codex-new'").get().session_outcome, 'timed-out')
  assert.equal(agent.ws.readyState, 1)
  agent.close()
})

test('convo_upsert rejects a malformed session_outcome with bad_request, connection survives', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')

  for (const bad of [42, '', 'x'.repeat(33), {}, []]) {
    agent.send({ op: 'convo_upsert', convo_id: `bad-${Math.random()}`, session_outcome: bad })
    await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'convo_upsert')
  }
  assert.equal(agent.ws.readyState, 1)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM conversations').get().n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0)

  // An explicit null is the same as omitting it (normal convo, no outcome).
  agent.send({ op: 'convo_upsert', convo_id: 'ok-2', session_state: 'running', session_outcome: null })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  assert.equal(s.db.prepare("SELECT session_outcome FROM conversations WHERE id='ok-2'").get().session_outcome, null)
  agent.close()
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

  const allowed = ['text', 'prompt', 'prompt_reply', 'tool_output', 'diff', 'permission_request', 'file', 'image', 'edit', 'summary']
  for (const type of allowed) {
    agent.send({ op: 'publish', convo_id: 'sess-wl', type, payload: { body: 'ok' } })
  }
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'summary') // the last one sent
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE convo_id='sess-wl'").get().n, allowed.length)
  agent.close()
})

test('summary events append and fan out but never touch snippet or unread', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  agent.send({ op: 'convo_upsert', convo_id: 'sess-sum' })
  agent.send({ op: 'publish', convo_id: 'sess-sum', type: 'text', payload: { body: 'real message' } })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'text')
  const before = s.db.prepare("SELECT snippet, unread_count, last_seq FROM conversations WHERE id='sess-sum'").get()

  agent.send({ op: 'publish', convo_id: 'sess-sum', type: 'summary', payload: { toc: 'Fixed the bug', detail: 'Working on X.', model: 'gpt-5.6-luna' } })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'summary')

  const after = s.db.prepare("SELECT snippet, unread_count, last_seq FROM conversations WHERE id='sess-sum'").get()
  assert.equal(after.snippet, before.snippet)            // no snippet change
  assert.equal(after.unread_count, before.unread_count)  // no unread bump
  assert.ok(after.last_seq > before.last_seq)            // seq still advances
  agent.close()
})

test('finalize type whitelist: server-generated types are rejected even with well-formed payloads; text and default still work', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  agent.send({ op: 'convo_upsert', convo_id: 's-fin-wl' })

  // The publish whitelist must not be bypassable via finalize: finalize's
  // type is raw agent input too, so without its own whitelist an agent
  // could forge server-generated event types with a well-formed payload
  // (e.g. type session_status with {state:'done'} would flip the
  // conversation's state). The payload here is deliberately well-formed
  // for all three server types, so a rejection can only come from the type
  // whitelist, not from payload validation.
  const forged = { state: 'done', convo_id: 's-fin-wl', up_to_seq: 1, title: 'forged' }
  const rejected = ['session_status', 'read_marker', 'convo_meta', 'bogus']
  rejected.forEach((type, i) => {
    agent.send({ op: 'finalize', convo_id: 's-fin-wl', message_ref: `m${i}`, type, payload: forged })
  })
  await agent.waitFor((f) =>
    agent.frames.filter((x) => x.kind === 'control' && x.op === 'error' && x.code === 'bad_request' && x.ref === 'finalize').length >= rejected.length)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE convo_id='s-fin-wl'").get().n, 0)
  assert.equal(s.db.prepare("SELECT session_state FROM conversations WHERE id='s-fin-wl'").get().session_state, 'running')
  assert.equal(agent.ws.readyState, 1)

  // explicit 'text' and an absent type (defaults to text) both still work
  agent.send({ op: 'finalize', convo_id: 's-fin-wl', message_ref: 'ok1', type: 'text', payload: { body: 'explicit' } })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'explicit')
  agent.send({ op: 'finalize', convo_id: 's-fin-wl', message_ref: 'ok2', payload: { body: 'default' } })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'default')
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE convo_id='s-fin-wl' AND type='text'").get().n, 2)
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

test("agent stream on a convo the agent's user does not own fails closed (forbidden)", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat5', 'pw')
  const agDan = createAgent(s.db, dan.id, 'dev-2')
  // A convo owned by pat, not dan — dan's agent must not be able to push a live
  // overlay into it, same as read_marker/activity/status.
  upsertConversation(s.db, { id: 'cp-stream', ownerUserId: pat.id })
  const agent = await makeWsClient(s.base, { token: agDan.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')

  agent.send({ op: 'stream', convo_id: 'cp-stream', message_ref: 'm1', replace_text: 'leak' })
  await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'forbidden' && f.ref === 'stream')
  agent.close()
})

test('agent stream with a non-string replace_text is rejected (bad_request), connection survives', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agDan = createAgent(s.db, dan.id, 'dev-2')
  const agent = await makeWsClient(s.base, { token: agDan.token, cursor: null })
  await agent.waitFor((f) => f.op === 'hello_ok')
  agent.send({ op: 'convo_upsert', convo_id: 'sess-st', title: 't', session_state: 'running' })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')

  agent.send({ op: 'stream', convo_id: 'sess-st', message_ref: 'm1', replace_text: { not: 'a string' } })
  await agent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'stream')

  // The connection is still usable: a well-formed stream on an owned convo goes through.
  agent.send({ op: 'stream', convo_id: 'sess-st', message_ref: 'm1', replace_text: 'ok now' })
  agent.send({ op: 'ack', cursor: 0 })
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(!agent.frames.some((f) => f.op === 'error' && f.code === 'internal'), 'no internal error frame')
  agent.close()
})

test('convo_meta carries the upserting agent device id so a live client can chip a brand-new convo', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'hunter22')
  const agent = createAgent(s.db, dan.id, 'dev-y')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'mac' } })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  t.after(() => client.close())
  const box = await makeWsClient(s.base, { token: agent.token, cursor: 0 })
  t.after(() => box.close())

  box.send({ op: 'convo_upsert', convo_id: 'c-new', title: 'Fix the parser' })
  const meta = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta')
  assert.equal(meta.payload.title, 'Fix the parser')
  assert.equal(meta.payload.agent_device_id, agent.deviceId)
})
