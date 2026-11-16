// An agent reaches a room with a file only through the approved transfer
// path (POST /transfers, then the user's card, then the journal's own
// release). A plain `file` frame from an agent into a room, over the
// publish or finalize ws ops, would skip the card: both are refused.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { inviteParticipant, answerInvite } from '../src/participants.js'

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))
const FILE = { blob_ref: 'file0002', name: 'a.pdf', content_type: 'application/pdf', size: 10 }
const IMAGE = { blob_ref: 'img00001', name: 'a.png', content_type: 'image/png', size: 10 }

async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agA = createAgent(s.db, alice.id, 'dev-a')
  const agB = createAgent(s.db, alice.id, 'dev-b')
  const a = await makeWsClient(s.base, { token: agA.token, cursor: null })
  const b = await makeWsClient(s.base, { token: agB.token, cursor: null })
  await a.waitFor((f) => f.op === 'hello_ok')
  await b.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { a.close(); b.close() })
  for (const id of ['room', 'solo']) {
    a.send({ op: 'convo_upsert', convo_id: id, title: id, session_state: 'running' })
    await a.waitFor((f) => f.kind === 'journal' && f.type === 'session_status' && f.convo_id === id)
  }
  inviteParticipant(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, initiatorDeviceId: agA.deviceId, justification: 'x' })
  answerInvite(s.db, { convoId: 'room', agentDeviceId: agB.deviceId, accept: true })
  return { s, a, b }
}

const fileEvents = (s, convoId) => s.db.prepare("SELECT seq FROM events WHERE convo_id=? AND type='file'").all(convoId)
const imageEvents = (s, convoId) => s.db.prepare("SELECT seq FROM events WHERE convo_id=? AND type='image'").all(convoId)

test('publish of a file frame into a room is refused, for a joined agent and for the owner', async (t) => {
  const { s, a, b } = await fleet(t)
  for (const [who, name] of [[b, 'joined'], [a, 'owner']]) {
    who.send({ op: 'publish', convo_id: 'room', type: 'file', payload: FILE })
    const err = await who.waitFor((f) => f.op === 'error' && f.ref === 'publish')
    assert.equal(err.code, 'bad_request', `${name} publish refused`)
    assert.match(err.detail, /transfer/)
  }
  await settle()
  assert.equal(fileEvents(s, 'room').length, 0, 'no file event was written')
})

test('finalize of a file frame into a room is refused', async (t) => {
  const { s, b } = await fleet(t)
  b.send({ op: 'finalize', convo_id: 'room', message_ref: 'm1', type: 'file', payload: FILE })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'finalize')
  assert.equal(err.code, 'bad_request')
  await settle()
  assert.equal(fileEvents(s, 'room').length, 0)
})

test('controls: text into a room and a file into a non-room session still go through', async (t) => {
  const { s, a, b } = await fleet(t)
  b.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'hi room' } })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.body === 'hi room')
  a.send({ op: 'publish', convo_id: 'solo', type: 'file', payload: FILE })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'file' && f.convo_id === 'solo')
  assert.equal(fileEvents(s, 'solo').length, 1)
})

test('publish of an image frame into a room is refused, for a joined agent and for the owner', async (t) => {
  const { s, a, b } = await fleet(t)
  for (const [who, name] of [[b, 'joined'], [a, 'owner']]) {
    who.send({ op: 'publish', convo_id: 'room', type: 'image', payload: IMAGE })
    const err = await who.waitFor((f) => f.op === 'error' && f.ref === 'publish')
    assert.equal(err.code, 'bad_request', `${name} image publish refused`)
    assert.match(err.detail, /transfer/)
  }
  await settle()
  assert.equal(imageEvents(s, 'room').length, 0, 'no image event was written')
})

test('finalize of an image frame into a room is refused', async (t) => {
  const { s, b } = await fleet(t)
  b.send({ op: 'finalize', convo_id: 'room', message_ref: 'm1', type: 'image', payload: IMAGE })
  const err = await b.waitFor((f) => f.op === 'error' && f.ref === 'finalize')
  assert.equal(err.code, 'bad_request')
  assert.match(err.detail, /transfer/)
  await settle()
  assert.equal(imageEvents(s, 'room').length, 0)
})

test('controls: an image into a non-room session still goes through, by publish and by finalize', async (t) => {
  const { s, a } = await fleet(t)
  a.send({ op: 'publish', convo_id: 'solo', type: 'image', payload: IMAGE })
  await a.waitFor((f) => f.kind === 'journal' && f.type === 'image' && f.convo_id === 'solo')
  a.send({ op: 'finalize', convo_id: 'solo', message_ref: 'm2', type: 'image', payload: { ...IMAGE, blob_ref: 'img00002' } })
  await settle()
  assert.equal(imageEvents(s, 'solo').length, 2)
})
