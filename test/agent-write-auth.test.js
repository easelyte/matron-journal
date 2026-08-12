import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent, authorizeAgentWrite } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { inviteParticipant, answerInvite, leaveConvo } from '../src/participants.js'

async function fixture() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const other = await createUser(db, 'eve', 'pw')
  const owner = createAgent(db, dan.id, 'dev-a')
  const peer = createAgent(db, dan.id, 'dev-b')
  const stranger = createAgent(db, other.id, 'dev-x')
  upsertConversation(db, { id: 'room', ownerUserId: dan.id, title: 'room', sessionState: 'running', agentDeviceId: owner.deviceId })
  return { db, dan, other, owner, peer, stranger }
}

test('owner device may write; a foreign agent device may not', async () => {
  const { db, dan, owner, peer } = await fixture()
  assert.equal(authorizeAgentWrite(db, dan.id, owner.deviceId, 'room'), true)
  assert.equal(authorizeAgentWrite(db, dan.id, peer.deviceId, 'room'), false)
})

test('joined participant may write; every other participant state may not', async () => {
  const { db, dan, peer, owner } = await fixture()
  inviteParticipant(db, { convoId: 'room', agentDeviceId: peer.deviceId, initiatorDeviceId: owner.deviceId, justification: 'x' })
  assert.equal(authorizeAgentWrite(db, dan.id, peer.deviceId, 'room'), false, 'invited is not joined')
  answerInvite(db, { convoId: 'room', agentDeviceId: peer.deviceId, accept: true })
  assert.equal(authorizeAgentWrite(db, dan.id, peer.deviceId, 'room'), true)
  leaveConvo(db, { convoId: 'room', agentDeviceId: peer.deviceId })
  assert.equal(authorizeAgentWrite(db, dan.id, peer.deviceId, 'room'), false, 'left loses write access')
})

test('legacy NULL-owner conversation accepts any of the user devices', async () => {
  const { db, dan, peer } = await fixture()
  db.prepare(
    'INSERT INTO conversations(id, owner_user_id, title, session_state, created_at) VALUES(?,?,?,?,?)'
  ).run('legacy', dan.id, 'old', 'running', Date.now())
  assert.equal(authorizeAgentWrite(db, dan.id, peer.deviceId, 'legacy'), true)
})

test('missing convo and cross-user convo both fail closed', async () => {
  const { db, dan, other, owner, stranger } = await fixture()
  assert.equal(authorizeAgentWrite(db, dan.id, owner.deviceId, 'nope'), false)
  assert.equal(authorizeAgentWrite(db, other.id, stranger.deviceId, 'room'), false)
})
