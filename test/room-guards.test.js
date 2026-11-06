import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { createMission } from '../src/missions.js'
import { checkRoomFree, askMissionId, FRESH_TEXT_MAX } from '../src/person-rooms.js'
import { MAX_PARKED_PER_DEVICE } from '../src/contacts.js'

// The checks shared by both ways an agent asks another person into its room
// (a contact's shared session, and a talk request to the person).
async function world() {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const bob = await createUser(db, 'bob', 'pw')
  const box = createAgent(db, alice.id, 'alice-box')
  upsertConversation(db, { id: 'room', ownerUserId: alice.id, title: 'Cover chat', agentDeviceId: box.deviceId })
  const args = { ownerUserId: alice.id, roomId: 'room', ownerDeviceId: box.deviceId, ownerSender: 'agent:alice-box' }
  return { db, alice, bob, box, args }
}

const contact = (db, id, userId, peerUserId, peer, state) =>
  db.prepare(`INSERT INTO contacts(id, user_id, peer_user, peer_user_id, state, created_at, updated_at)
    VALUES(?,?,?,?,?,0,0)`).run(id, userId, peer, peerUserId, state)

test('checkRoomFree: a fresh room with no members or twin passes', async () => {
  const { db, args } = await world()
  assert.doesNotThrow(() => checkRoomFree(db, args))
})

test('checkRoomFree: a room that already had a twin is busy', async () => {
  const { db, alice, bob, box, args } = await world()
  db.prepare(`INSERT INTO person_rooms(id, owner_user_id, owner_room_id, owner_device_id, guest_user_id, guest_room_id, state, created_at, updated_at)
    VALUES('pr_1',?, 'room', ?, ?, 'twin', 'left', 0, 0)`).run(alice.id, box.deviceId, bob.id)
  assert.throws(() => checkRoomFree(db, args), /room_busy/)
})

test('checkRoomFree: a room with any other agent in it is busy', async () => {
  const { db, alice, box, args } = await world()
  const other = createAgent(db, alice.id, 'alice-other')
  db.prepare("INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, created_at) VALUES('room', ?, ?, 'joined', 0)").run(other.deviceId, box.deviceId)
  assert.throws(() => checkRoomFree(db, args), /room_busy/)
})

test('checkRoomFree: a room with more than a few texts, or anyone else\'s, is not fresh', async () => {
  const { db, alice, args } = await world()
  for (let i = 0; i <= FRESH_TEXT_MAX; i++) append(db, { userId: alice.id, convoId: 'room', sender: 'agent:alice-box', type: 'text', payload: { body: `hi ${i}` } })
  assert.throws(() => checkRoomFree(db, args), /not_fresh/)

  const w2 = await world()
  append(w2.db, { userId: w2.alice.id, convoId: 'room', sender: 'agent:someone-else', type: 'text', payload: { body: 'hello' } })
  assert.throws(() => checkRoomFree(w2.db, w2.args), /not_fresh/)
})

test('checkRoomFree: a device at its parked-ask cap is refused', async () => {
  const { db, alice, box, args } = await world()
  for (let i = 0; i < MAX_PARKED_PER_DEVICE; i++) {
    db.prepare(`INSERT INTO contacts(id, user_id, peer_user, state, origin_device_id, created_at, updated_at)
      VALUES(?, ?, ?, 'awaiting_user', ?, 0, 0)`).run(`ct_${i}`, alice.id, `peer${i}`, box.deviceId)
  }
  assert.throws(() => checkRoomFree(db, args), /too_many_asks/)
})

test('askMissionId: no mission named is null; an unknown one is no_mission', async () => {
  const { db, alice } = await world()
  assert.equal(askMissionId(db, alice.id, null, null), null)
  assert.throws(() => askMissionId(db, alice.id, 'ms_nope', null), /no_mission/)
})

test('askMissionId: the mission must be shared, readably, with a mutual contact', async () => {
  const { db, alice, bob, box } = await world()
  const { mission } = createMission(db, { userId: alice.id, deviceId: box.deviceId, createdBy: 'agent', convoId: 'room', title: 'Cover editor' })
  contact(db, 'ct_a', alice.id, bob.id, 'bob', 'active')
  const own = db.prepare("SELECT * FROM contacts WHERE id='ct_a'").get()
  // No contact at all, and a one-sided one, share nothing.
  assert.throws(() => askMissionId(db, alice.id, mission.id, null), /mission_not_shared/)
  assert.throws(() => askMissionId(db, alice.id, mission.id, own), /mission_not_shared/)
  contact(db, 'ct_b', bob.id, alice.id, 'alice', 'active')
  // Mutual, but not granted.
  assert.throws(() => askMissionId(db, alice.id, mission.id, own), /mission_not_shared/)
  const grant = db.prepare(`INSERT INTO grants(id, owner_user_id, subject_kind, subject_id, contact_id, level, state, created_at, updated_at)
    VALUES('gr_1', ?, 'mission', ?, 'ct_a', ?, 'active', 0, 0)`)
  // A hand-over's owner-level row confers nothing.
  grant.run(alice.id, mission.id, 'owner')
  assert.throws(() => askMissionId(db, alice.id, mission.id, own), /mission_not_shared/)
  db.prepare("DELETE FROM grants WHERE id='gr_1'").run()
  grant.run(alice.id, mission.id, 'read')
  assert.equal(askMissionId(db, alice.id, mission.id, own), mission.id)
})
