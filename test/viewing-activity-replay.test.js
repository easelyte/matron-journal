import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'

// `viewing` replays the conversation's current activity. A client stops
// viewing a chat when the tracker opens over it or the tab hides (it sends
// `viewing: null`), and starts again when the tracker closes or the tab
// shows (`viewing: <chat>`). Both go through the same null -> chat
// transition, so the tests below cover both. Activity is latest-wins and
// not journaled, so without a replay the client misses whatever ended its
// "thinking" indicator while it was not viewing.

async function setup(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const ag = createAgent(s.db, alice.id, 'box-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  agent.send({ op: 'convo_upsert', convo_id: 'ra', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  t.after(() => { agent.close(); client.close() })
  return { agent, client }
}

// Ops on one socket are handled in order, so a journalled op that round-trips
// proves every earlier `viewing` on that socket has been applied.
let barrierN = 0
async function barrier(client) {
  const n = ++barrierN
  client.send({ op: 'read_marker', convo_id: 'ra', up_to_seq: null, _b: n })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker' && f.sender === 'user:alice' && !f._seen && (f._seen = true))
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const activities = (client, convoId = 'ra') =>
  client.frames.filter((f) => f.kind === 'ephemeral' && f.convo_id === convoId && f.activity).map((f) => f.activity)

test('re-viewing a chat replays its cached thinking activity', async (t) => {
  const { agent, client } = await setup(t)
  client.send({ op: 'viewing', convo_id: 'ra' })
  await barrier(client)
  agent.send({ op: 'activity', convo_id: 'ra', state: 'thinking', detail: 'reading' })
  await client.waitFor((f) => f.kind === 'ephemeral' && f.activity?.state === 'thinking')

  // tracker opens (or the tab hides) ...
  client.send({ op: 'viewing', convo_id: null })
  await barrier(client)
  const before = activities(client).length
  // ... and closes (or the tab shows) again.
  client.send({ op: 'viewing', convo_id: 'ra' })
  await pause(300)
  assert.deepEqual(activities(client).slice(before), [{ state: 'thinking', detail: 'reading' }])
})

test('re-viewing after the activity ended sends the idle frame', async (t) => {
  const { agent, client } = await setup(t)
  client.send({ op: 'viewing', convo_id: 'ra' })
  await barrier(client)
  agent.send({ op: 'activity', convo_id: 'ra', state: 'thinking' })
  await client.waitFor((f) => f.kind === 'ephemeral' && f.activity?.state === 'thinking')

  client.send({ op: 'viewing', convo_id: null })
  await barrier(client)
  // The agent goes idle while the client is not viewing: the frame is not
  // delivered to it.
  agent.send({ op: 'activity', convo_id: 'ra', state: 'idle' })
  await pause(300)
  const before = activities(client).length
  client.send({ op: 'viewing', convo_id: 'ra' })
  await pause(300)
  assert.deepEqual(activities(client).slice(before), [{ state: 'idle' }])
})

test('viewing a chat that never had activity sends the idle frame', async (t) => {
  const { client } = await setup(t)
  client.send({ op: 'viewing', convo_id: 'ra' })
  await pause(300)
  assert.deepEqual(activities(client), [{ state: 'idle' }])
})

test('a thinking frame still pending when the client leaves does not land after the replay', async (t) => {
  const { agent, client } = await setup(t)
  client.send({ op: 'viewing', convo_id: 'ra' })
  await barrier(client)
  const before = activities(client).length // the idle catch-up of the first view

  // "thinking" is queued in the hub's coalesce window (200 ms) ...
  agent.send({ op: 'activity', convo_id: 'ra', state: 'thinking' })
  await pause(40)
  // ... the client leaves the chat, the agent finishes while it is away ...
  client.send({ op: 'viewing', convo_id: null })
  await barrier(client)
  agent.send({ op: 'activity', convo_id: 'ra', state: 'idle' })
  await pause(40)
  // ... and the client comes back before the window would have closed.
  client.send({ op: 'viewing', convo_id: 'ra' })
  await barrier(client)
  await pause(500)

  // Only the replay arrives after the client's last `viewing`; the stale
  // thinking frame is neither flushed after the null nor behind the replay.
  assert.deepEqual(activities(client).slice(before), [{ state: 'idle' }])
})

test('an agent that disconnects mid-turn leaves no thinking behind to replay', async (t) => {
  const { agent, client } = await setup(t)
  agent.send({ op: 'activity', convo_id: 'ra', state: 'thinking' })
  await pause(100)
  agent.close()
  await pause(200)
  client.send({ op: 'viewing', convo_id: 'ra' })
  await pause(300)
  assert.deepEqual(activities(client), [{ state: 'idle' }])
})
