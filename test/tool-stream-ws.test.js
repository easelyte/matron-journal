import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'

async function setup(t, opts = {}) {
  const s = await startTestServer(opts)
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  agent.send({ op: 'convo_upsert', convo_id: 'sess-ts' })
  // barrier: convo_upsert applied once a subsequent journalled op round-trips
  agent.send({ op: 'read_marker', convo_id: 'sess-ts', up_to_seq: null })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker')
  return { s, dan, ag, agent, client }
}

test('append fans out to the viewing client only; chunks reach it live', async (t) => {
  const { agent, client } = await setup(t)
  client.send({ op: 'viewing', convo_id: 'sess-ts' })
  // barrier: viewing applied once a journalled op on the same conn round-trips
  client.send({ op: 'read_marker', convo_id: 'sess-ts', up_to_seq: null })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker' && f.sender === 'user:dan')

  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu1', offset: 0, chunk: '$ npm test\n', meta: { tool: 'Bash', command: 'npm test' } })
  const f1 = await client.waitFor((f) => f.tool_stream?.event === 'append')
  assert.equal(f1.message_ref, 'tu1')
  assert.equal(f1.tool_stream.offset, 0)
  assert.equal(f1.tool_stream.chunk, '$ npm test\n')

  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu1', offset: 11, chunk: 'ok\n' })
  await client.waitFor((f) => f.tool_stream?.event === 'append' && f.tool_stream.chunk.includes('ok'))
})

test('gap triggers stream_resync with have; unknown buffer at offset>0 asks from 0', async (t) => {
  const { agent } = await setup(t)
  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu2', offset: 0, chunk: 'abc', meta: { tool: 'Bash', command: 'x' } })
  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu2', offset: 999, chunk: 'zzz' })
  const rs = await agent.waitFor((f) => f.op === 'stream_resync')
  assert.deepEqual({ ref: rs.message_ref, have: rs.have }, { ref: 'tu2', have: 3 })
  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'never-seen', offset: 50, chunk: 'x' })
  const rs2 = await agent.waitFor((f) => f.op === 'stream_resync' && f.message_ref === 'never-seen')
  assert.equal(rs2.have, 0)
})

test('validation and authz: client forbidden; non-owned convo forbidden; bad frames bad_request', async (t) => {
  const { s, agent, client } = await setup(t)
  client.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu3', offset: 0, chunk: 'x', meta: { tool: 'Bash', command: 'x' } })
  await client.waitFor((f) => f.op === 'error' && f.code === 'forbidden' && f.ref === 'stream_append')

  const eve = await createUser(s.db, 'eve', 'pw2')
  const evag = createAgent(s.db, eve.id, 'dev-9')
  const evilAgent = await makeWsClient(s.base, { token: evag.token, cursor: null })
  await evilAgent.waitFor((f) => f.op === 'hello_ok')
  evilAgent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu3', offset: 0, chunk: 'x', meta: { tool: 'Bash', command: 'x' } })
  await evilAgent.waitFor((f) => f.op === 'error' && f.code === 'forbidden')
  evilAgent.close()

  for (const bad of [
    { op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu4', offset: -1, chunk: 'x', meta: { tool: 'Bash', command: 'x' } },
    { op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu4', offset: 0, chunk: 42, meta: { tool: 'Bash', command: 'x' } },
    { op: 'stream_append', convo_id: 'sess-ts', offset: 0, chunk: 'x', meta: { tool: 'Bash', command: 'x' } },
    { op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu4', offset: 0, chunk: 'x' }, // creating frame, no meta
  ]) agent.send(bad)
  await agent.waitFor((f) =>
    agent.frames.filter((x) => x.op === 'error' && x.code === 'bad_request' && x.ref === 'stream_append').length >= 4)
  assert.equal(agent.ws.readyState, 1)
})

test('chunks never touch the journal', async (t) => {
  const { s, agent } = await setup(t)
  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu5', offset: 0, chunk: 'secret-live-bytes', meta: { tool: 'Bash', command: 'x' } })
  await new Promise((r) => setTimeout(r, 100))
  const rows = s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE payload LIKE '%secret-live-bytes%'").get()
  assert.equal(rows.n, 0)
})

test('a client that starts viewing mid-command gets a sync frame with full scrollback', async (t) => {
  const { agent, client } = await setup(t)
  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu6', offset: 0, chunk: 'line one\n', meta: { tool: 'Bash', command: 'make build' } })
  agent.send({ op: 'stream_append', convo_id: 'sess-ts', message_ref: 'tu6', offset: 9, chunk: 'line two\n' })
  // barrier on the agent conn: a journalled op round-trips → both appends applied
  agent.send({ op: 'read_marker', convo_id: 'sess-ts', up_to_seq: null })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker')

  client.send({ op: 'viewing', convo_id: 'sess-ts' })
  const sync = await client.waitFor((f) => f.tool_stream?.event === 'sync')
  assert.equal(sync.message_ref, 'tu6')
  assert.deepEqual(sync.tool_stream.meta, { tool: 'Bash', command: 'make build' })
  assert.equal(sync.tool_stream.offset, 0)
  assert.equal(sync.tool_stream.content, 'line one\nline two\n')
  assert.equal(sync.tool_stream.head_truncated, false)
})

test('viewing a convo with no active streams sends no sync frames', async (t) => {
  const { client } = await setup(t)
  client.send({ op: 'viewing', convo_id: 'sess-ts' })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(client.frames.some((f) => f.tool_stream), false)
})
