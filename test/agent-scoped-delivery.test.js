import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'

// Multi-bridge fleet scoping: the journal fans every frame to every
// connection of the owning user, which made every NON-owning bridge treat
// the user's input as "unknown convo" and publish a bounce notice into the
// convo (observed live: dev-2 and dev-3 bouncing every message meant for
// dev-6). Agent devices must only receive frames for conversations they
// own; client devices keep receiving everything. Ownership is recorded by
// convo_upsert; a convo with no recorded owner (row predating the
// agent_device_id column) keeps legacy broadcast-to-all-agents behavior.

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agA = createAgent(s.db, dan.id, 'dev-a')
  const agB = createAgent(s.db, dan.id, 'dev-b')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const a = await makeWsClient(s.base, { token: agA.token, cursor: null })
  const b = await makeWsClient(s.base, { token: agB.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await a.waitFor((f) => f.op === 'hello_ok')
  await b.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { a.close(); b.close(); client.close() })
  return { s, dan, agA, agB, a, b, client }
}

test('user input is delivered only to the agent device that owns the convo', async (t) => {
  const { a, b, client } = await fleet(t)

  a.send({ op: 'convo_upsert', convo_id: 'sess-owned', title: 'work', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')

  client.send({ op: 'send', convo_id: 'sess-owned', payload: { body: 'Hi' } })

  const got = await a.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'Hi')
  assert.equal(got.sender, 'user:dan')
  // The client still sees its own message echoed back.
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'Hi')

  await settle()
  assert.deepEqual(
    b.journal().filter((f) => f.convo_id === 'sess-owned'), [],
    'non-owning agent must receive nothing for this convo'
  )
})

test('a convo with no recorded owner device keeps broadcasting to every agent', async (t) => {
  const { s, dan, a, b, client } = await fleet(t)

  // Simulate a conversation row that predates the agent_device_id column.
  s.db.prepare(
    'INSERT INTO conversations(id, owner_user_id, title, session_state, created_at) VALUES(?,?,?,?,?)'
  ).run('sess-legacy', dan.id, 'old', 'running', Date.now())

  client.send({ op: 'send', convo_id: 'sess-legacy', payload: { body: 'anyone?' } })

  await a.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'anyone?')
  await b.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'anyone?')
})

test('a later convo_upsert by another device takes over delivery', async (t) => {
  const { a, b, client } = await fleet(t)

  a.send({ op: 'convo_upsert', convo_id: 'sess-move', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  b.send({ op: 'convo_upsert', convo_id: 'sess-move', session_state: 'running' })
  await b.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')

  client.send({ op: 'send', convo_id: 'sess-move', payload: { body: 'ping' } })

  await b.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'ping')
  await settle()
  assert.deepEqual(
    a.journal().filter((f) => f.type === 'text' && f.convo_id === 'sess-move'), [],
    'previous owner must not receive input after handover'
  )
})

test('hello replay applies the same ownership scoping for agent connections', async (t) => {
  const { s, agA, agB, a, client } = await fleet(t)

  a.send({ op: 'convo_upsert', convo_id: 'sess-replay', session_state: 'running' })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  client.send({ op: 'send', convo_id: 'sess-replay', payload: { body: 'while you were out' } })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'text')

  // Non-owner replaying from 0 must not see the convo's history...
  const b2 = await makeWsClient(s.base, { token: agB.token, cursor: 0 })
  await b2.waitFor((f) => f.op === 'hello_ok')
  await settle()
  assert.deepEqual(b2.journal().filter((f) => f.convo_id === 'sess-replay'), [])
  b2.close()

  // ...while the owner and a client replaying from 0 both do.
  const a2 = await makeWsClient(s.base, { token: agA.token, cursor: 0 })
  await a2.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'while you were out')
  a2.close()
  const login2 = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'phone' } })
  const c2 = await makeWsClient(s.base, { token: login2.json.token, cursor: 0 })
  await c2.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'while you were out')
  c2.close()
})
