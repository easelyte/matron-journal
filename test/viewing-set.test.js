import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'

// `viewing {convo_ids: [...]}` — one connection viewing a SET of
// conversations (Coordinator: two live chats on screen at once). Without
// `convo_ids`, `convo_id` keeps its old single-convo meaning.

async function setup(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const agent = await makeWsClient(s.base, { token: ag.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  await agent.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  for (const id of ['va', 'vb', 'vc']) agent.send({ op: 'convo_upsert', convo_id: id })
  agent.send({ op: 'read_marker', convo_id: 'vc', up_to_seq: null })
  await agent.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker')
  t.after(() => { agent.close(); client.close() })
  return { s, dan, agent, client, deviceId: login.json.device_id }
}

// Barrier: the viewing op is applied once a later journalled op on the same
// conn round-trips (ops are handled in order).
let barrierN = 0
async function barrier(client) {
  const n = ++barrierN
  client.send({ op: 'read_marker', convo_id: 'va', up_to_seq: null, _b: n })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker' && f.sender === 'user:dan' && !f._seen && (f._seen = true))
}

const act = (convoId) => ({ op: 'activity', convo_id: convoId, state: 'thinking' })
const gotActivity = (client, convoId) => client.frames.some((f) => f.kind === 'ephemeral' && f.convo_id === convoId && f.activity)
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms))

test('two convos viewed on one connection both receive ephemerals', async (t) => {
  const { agent, client } = await setup(t)
  client.send({ op: 'viewing', convo_ids: ['va', 'vb'] })
  await barrier(client)
  agent.send(act('va')); agent.send(act('vb')); agent.send(act('vc'))
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'va' && f.activity)
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'vb' && f.activity)
  await pause()
  assert.equal(gotActivity(client, 'vc'), false, 'an unviewed convo gets nothing')
})

test('switching the set drops the removed convo', async (t) => {
  const { agent, client } = await setup(t)
  client.send({ op: 'viewing', convo_ids: ['va', 'vb'] })
  client.send({ op: 'viewing', convo_ids: ['vb', 'vc'] })
  await barrier(client)
  agent.send(act('va')); agent.send(act('vb')); agent.send(act('vc'))
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'vb' && f.activity)
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'vc' && f.activity)
  await pause()
  assert.equal(gotActivity(client, 'va'), false)
})

test('an empty set views nothing; a later single convo_id replaces the set', async (t) => {
  const { agent, client } = await setup(t)
  client.send({ op: 'viewing', convo_ids: ['va', 'vb'] })
  client.send({ op: 'viewing', convo_ids: [] })
  await barrier(client)
  agent.send(act('va'))
  await pause()
  assert.equal(gotActivity(client, 'va'), false)

  client.send({ op: 'viewing', convo_ids: ['va', 'vb'] })
  client.send({ op: 'viewing', convo_id: 'vb' })
  await barrier(client)
  agent.send(act('va')); agent.send(act('vb'))
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'vb' && f.activity)
  await pause()
  assert.equal(gotActivity(client, 'va'), false, 'old single convo_id means exactly {convo_id}')
})

test('catch-up (status + tool-stream sync) replays only for newly added convos', async (t) => {
  const { agent, client } = await setup(t)
  for (const id of ['va', 'vb']) {
    agent.send({ op: 'status', convo_id: id, status: { model: `m-${id}` } })
    agent.send({ op: 'stream_append', convo_id: id, message_ref: `tu-${id}`, offset: 0, chunk: 'x', meta: { tool: 'Bash', command: 'x' } })
  }
  await pause(100)
  const count = (id, pred) => client.frames.filter((f) => f.kind === 'ephemeral' && f.convo_id === id && pred(f)).length
  const isStatus = (f) => f.status
  const isSync = (f) => f.tool_stream?.event === 'sync'

  client.send({ op: 'viewing', convo_ids: ['va'] })
  await barrier(client)
  assert.equal(count('va', isStatus), 1)
  assert.equal(count('va', isSync), 1)

  client.send({ op: 'viewing', convo_ids: ['va', 'vb'] })
  await barrier(client)
  assert.equal(count('va', isStatus), 1, 'va was already viewed: no second catch-up')
  assert.equal(count('va', isSync), 1)
  assert.equal(count('vb', isStatus), 1, 'vb newly added: catch-up')
  assert.equal(count('vb', isSync), 1)

  // Re-sending the same set is not an addition.
  client.send({ op: 'viewing', convo_ids: ['vb', 'va'] })
  await barrier(client)
  assert.equal(count('va', isStatus), 1)
  assert.equal(count('vb', isStatus), 1)
  // Dropped then re-added: catch-up again.
  client.send({ op: 'viewing', convo_ids: ['vb'] })
  client.send({ op: 'viewing', convo_ids: ['va', 'vb'] })
  await barrier(client)
  assert.equal(count('va', isStatus), 2)
  assert.equal(count('vb', isStatus), 1)
})

test('the single convo_id form still catches up on every send (client resync idiom)', async (t) => {
  const { agent, client } = await setup(t)
  agent.send({ op: 'status', convo_id: 'va', status: { model: 'm' } })
  agent.send({ op: 'stream_append', convo_id: 'va', message_ref: 'tu', offset: 0, chunk: 'x', meta: { tool: 'Bash', command: 'x' } })
  await pause(100)
  client.send({ op: 'viewing', convo_id: 'va' })
  client.send({ op: 'viewing', convo_id: 'va' })
  await barrier(client)
  const eph = client.frames.filter((f) => f.kind === 'ephemeral' && f.convo_id === 'va')
  assert.equal(eph.filter((f) => f.status).length, 2)
  assert.equal(eph.filter((f) => f.tool_stream?.event === 'sync').length, 2)
})

test('duplicate convo_ids are de-duplicated (one catch-up, counts once toward the cap)', async (t) => {
  const { agent, client } = await setup(t)
  agent.send({ op: 'status', convo_id: 'va', status: { model: 'm' } })
  await pause(100)
  client.send({ op: 'viewing', convo_ids: ['va', 'va', 'vb', 'vc', 'vd', 'vd'] })
  await barrier(client)
  assert.equal(client.frames.filter((f) => f.kind === 'ephemeral' && f.convo_id === 'va' && f.status).length, 1)
  assert.equal(client.frames.some((f) => f.op === 'error' && f.ref === 'viewing'), false)
})

test('invalid convo_ids is bad_request and leaves the viewed set unchanged', async (t) => {
  const { agent, client } = await setup(t)
  client.send({ op: 'viewing', convo_ids: ['va'] })
  const bad = [
    'va', null, [1], [''], ['x'.repeat(129)], ['a', 'b', 'c', 'd', 'e'], { 0: 'va' },
  ]
  for (const convo_ids of bad) client.send({ op: 'viewing', convo_ids })
  await barrier(client)
  const errs = client.frames.filter((f) => f.op === 'error' && f.ref === 'viewing')
  assert.equal(errs.length, bad.length)
  assert.ok(errs.every((e) => e.code === 'bad_request'))
  agent.send(act('va'))
  await client.waitFor((f) => f.kind === 'ephemeral' && f.convo_id === 'va' && f.activity)
})

test('push suppression honours every convo in the set', async (t) => {
  const { s, dan, client, deviceId } = await setup(t)
  client.send({ op: 'viewing', convo_ids: ['va', 'vb'] })
  await barrier(client)
  assert.equal(s.hub.isViewing(dan.id, deviceId, 'va'), true)
  assert.equal(s.hub.isViewing(dan.id, deviceId, 'vb'), true)
  assert.equal(s.hub.isViewing(dan.id, deviceId, 'vc'), false)
  client.send({ op: 'viewing', convo_ids: ['vc'] })
  await barrier(client)
  assert.equal(s.hub.isViewing(dan.id, deviceId, 'va'), false)
  assert.equal(s.hub.isViewing(dan.id, deviceId, 'vc'), true)
  client.send({ op: 'viewing', convo_id: null })
  await barrier(client)
  assert.equal(s.hub.isViewing(dan.id, deviceId, 'vc'), false)
})

test('convo_ids + convo_id: convo_id catches up again even when already viewed; others only if new', async (t) => {
  const { agent, client } = await setup(t)
  for (const id of ['va', 'vb']) {
    agent.send({ op: 'status', convo_id: id, status: { model: `m-${id}` } })
    agent.send({ op: 'stream_append', convo_id: id, message_ref: `tu-${id}`, offset: 0, chunk: 'x', meta: { tool: 'Bash', command: 'x' } })
  }
  await pause(100)
  const count = (id, pred) => client.frames.filter((f) => f.kind === 'ephemeral' && f.convo_id === id && pred(f)).length
  const isStatus = (f) => f.status
  const isSync = (f) => f.tool_stream?.event === 'sync'

  client.send({ op: 'viewing', convo_ids: ['va', 'vb'] })
  await barrier(client)
  client.send({ op: 'viewing', convo_ids: ['va', 'vb'], convo_id: 'va' })
  await barrier(client)
  assert.equal(count('va', isStatus), 2, 'convo_id forces a resync of an already-viewed convo')
  assert.equal(count('va', isSync), 2)
  assert.equal(count('vb', isStatus), 1, 'vb already viewed, not named: no catch-up')
  assert.equal(count('vb', isSync), 1)
})
