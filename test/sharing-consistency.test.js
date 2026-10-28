import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { createMission, missionDetail } from '../src/missions.js'
import { projectDetail, getProject, createProject } from '../src/projects.js'
import { requestContact, answerContact, getContactRaw } from '../src/contacts.js'
import { shareMission, answerGrant, revokeGrant } from '../src/grants.js'
import { contributableMission, contributeMilestone, contributeItem } from '../src/contribute.js'
import { parkTalk } from '../src/talk-requests.js'

// Three edges of sharing between people (spec 2026-10-02): the other
// person's box name never reaches a mission or project view through a
// person-room twin; a talk request attaches only a mission the other person
// can read; a contributor's create re-checks the grant inside its own
// transaction.

async function world() {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const bob = await createUser(db, 'bob', 'pw')
  const aliceBox = createAgent(db, alice.id, 'alice-box')
  const bobBox = createAgent(db, bob.id, 'bob-box')
  upsertConversation(db, { id: 'work', ownerUserId: alice.id, title: 'work', agentDeviceId: aliceBox.deviceId })
  upsertConversation(db, { id: 'bobwork', ownerUserId: bob.id, title: 'bobwork', agentDeviceId: bobBox.deviceId })
  requestContact(db, { userId: alice.id, peerName: 'bob', by: 'user' })
  answerContact(db, { userId: bob.id, contactId: getContactRaw(db, bob.id, 'alice').id, decision: 'approve' })
  return { db, alice, bob, aliceBox, bobBox }
}

const mission = (db, w, user, box, convo, title = 'Launch') =>
  createMission(db, { userId: user.id, deviceId: box.deviceId, createdBy: 'agent', convoId: convo, title }).mission

function link(db, w, m, convo) {
  db.prepare("INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at) VALUES(?,?,?,'joined',1)").run(m.id, convo, m.user_id)
}

test('a person-room twin on a mission shows no box: the device join is scoped to the conversation owner', async () => {
  const { db, alice, bob, aliceBox, bobBox } = await world()
  // The twin in bob's log carries alice's device id (person-rooms.js createGuestRoom).
  upsertConversation(db, { id: 'twin', ownerUserId: bob.id, title: 'alice — covers', agentDeviceId: aliceBox.deviceId })
  const m = mission(db, null, bob, bobBox, 'bobwork')
  link(db, null, m, 'twin')
  const rows = missionDetail(db, bob.id, m.id).conversations
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.box]))
  assert.equal(byId.bobwork, 'bob-box')
  assert.equal(byId.twin, null, 'the other person\'s box name never crosses')
  assert.ok(!JSON.stringify(rows).includes('alice-box'))
  // Nor into a project's sessions-by-box.
  const { project } = createProject(db, { userId: bob.id, deviceId: bobBox.deviceId, createdBy: 'agent', convoId: 'bobwork', title: 'P' })
  db.prepare('UPDATE missions SET project_id=? WHERE id=?').run(project.id, m.id)
  const detail = projectDetail(db, bob.id, getProject(db, bob.id, project.id))
  assert.deepEqual(detail.sessions_by_box, { 'bob-box': 1 })
  db.close()
})

test('a talk request cannot attach a handed-over mission: an owner-level grant confers no read', async () => {
  const { db, alice, bob, aliceBox } = await world()
  const m = mission(db, null, alice, aliceBox, 'work')
  upsertConversation(db, { id: 'room', ownerUserId: alice.id, title: 'room', agentDeviceId: aliceBox.deviceId })
  const own = getContactRaw(db, alice.id, 'bob')
  const ask = (ref) => parkTalk(db, { ownerUserId: alice.id, roomId: 'room', ownerDeviceId: aliceBox.deviceId, ownerSender: 'agent:alice-box', person: 'bob', missionRef: ref, topic: 'covers', justification: 'why' })
  // Not shared at all.
  assert.throws(() => ask(m.num), /mission_not_shared/)
  // An accepted hand-over: the row is active at level owner.
  const { grant } = shareMission(db, { ownerUserId: alice.id, missionId: m.id, contact: own.id, level: 'owner', brief: 'where things stand', by: 'user' })
  db.prepare("UPDATE grants SET state='active', sent_at=1, answered_at=1 WHERE id=?").run(grant.id)
  assert.throws(() => ask(m.num), /mission_not_shared/)
  // A read grant lets it through.
  db.prepare("UPDATE grants SET level='read' WHERE id=?").run(grant.id)
  assert.equal(ask(m.num).mission_id, m.id)
  db.close()
})

test('a contributor\'s milestone or item is refused when the share ended after the route read the mission', async () => {
  const { db, alice, bob, aliceBox } = await world()
  const m = mission(db, null, alice, aliceBox, 'work')
  const own = getContactRaw(db, alice.id, 'bob')
  const { grant } = shareMission(db, { ownerUserId: alice.id, missionId: m.id, contact: own.id, level: 'contribute', by: 'user' })
  answerGrant(db, { userId: bob.id, grantId: grant.id, decision: 'approve' })
  const contributor = { userId: bob.id, name: 'bob', via: 'agent' }
  const read = contributableMission(db, bob.id, m.id)
  assert.equal(read.id, m.id)
  const appendMarker = (convoId, payload) => append(db, { userId: alice.id, convoId, sender: 'journal', type: 'milestone', payload })
  // Still shared: the write lands.
  assert.equal(contributeMilestone(db, { mission: read, contributor, kind: 'progress', title: 'first', appendMarker }).milestone.title, 'first')
  // The share ends between the route's read and the write.
  revokeGrant(db, { userId: alice.id, grantId: grant.id })
  assert.throws(() => contributeMilestone(db, { mission: read, contributor, kind: 'progress', title: 'late', appendMarker }), /gone/)
  assert.throws(() => contributeItem(db, { mission: read, contributor, kind: 'task', title: 'late' }), /gone/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM milestones WHERE mission_id=?').get(m.id).n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items WHERE mission_id=?').get(m.id).n, 0)
  db.close()
})
