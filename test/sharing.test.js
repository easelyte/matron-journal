import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, pinDevicePrivate, insertBlob } from '../src/db.js'
import { createUser, createAgent, createClientDevice } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { createMission, createMilestone, listGrantedMissions, getGrantedMission, grantedMissionDetail, updateMission } from '../src/missions.js'
import { createItem, addComment, getSharedItem } from '../src/items.js'
import {
  requestContact, answerContact, removeContact, blockContact, listContacts, expireContactAsks, getContactRaw, listJournalUsers,
  OWN_ASK_TTL_MS, MAX_PARKED_PER_DEVICE,
} from '../src/contacts.js'
import { shareMission, answerGrant, revokeGrant, listGrants, expireGrantAsks, sharePreview, activeGranteeIds } from '../src/grants.js'
import { canReadMission, canWriteMission, missionAccess, canReadBlob, canReadConvo } from '../src/visibility.js'

// Pure-DB half of contacts and grants (spec 2026-10-02 matron-to-matron
// sharing, phase 1): the state machines and the grant clause of the read
// rule. The HTTP and socket half is test/sharing-http.test.js.
async function world() {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const bob = await createUser(db, 'bob', 'pw')
  const sam = await createUser(db, 'sam', 'pw')
  const box = createAgent(db, alice.id, 'alice-box')
  const priv = createAgent(db, alice.id, 'alice-private')
  pinDevicePrivate(db, priv.deviceId, true)
  const phone = createClientDevice(db, alice.id, 'alice-phone')
  upsertConversation(db, { id: 'work', ownerUserId: alice.id, title: 'work', agentDeviceId: box.deviceId })
  upsertConversation(db, { id: 'secret', ownerUserId: alice.id, title: 'secret', agentDeviceId: priv.deviceId })
  return { db, alice, bob, sam, box, priv, phone }
}

const state = (db, userId, peer) => getContactRaw(db, userId, peer)?.state ?? null

function contacts(db, a, b) {
  requestContact(db, { userId: a.id, peerName: b.name, by: 'user' })
  const theirs = getContactRaw(db, b.id, a.name)
  answerContact(db, { userId: b.id, contactId: theirs.id, decision: 'approve' })
  return { own: getContactRaw(db, a.id, b.name), theirs: getContactRaw(db, b.id, a.name) }
}

function mission(db, w, { convo = 'work', device = w.box.deviceId, title = 'Launch' } = {}) {
  // attach:false — the conversation is only the mission's origin, so one
  // conversation can be the origin of several.
  return createMission(db, { userId: w.alice.id, deviceId: device, createdBy: 'agent', convoId: convo, title, attach: false }).mission
}

function milestone(db, w, m, convo, title) {
  if (!db.prepare('SELECT 1 FROM mission_conversations WHERE mission_id=? AND convo_id=?').get(m.id, convo)) {
    db.prepare("INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at) VALUES(?,?,?,'joined',1)").run(m.id, convo, w.alice.id)
  }
  return createMilestone(db, {
    userId: w.alice.id, deviceId: w.box.deviceId, createdBy: 'agent', convoId: convo, kind: 'progress', title, missionRef: m.id,
    appendMarker: (payload) => append(db, { userId: w.alice.id, convoId: convo, sender: 'agent:x', type: 'milestone', payload }),
  })
}

function granted(db, w, m) {
  const { own } = contacts(db, w.alice, w.bob)
  const { grant } = shareMission(db, { ownerUserId: w.alice.id, missionId: m.id, contact: own.id, level: 'read', by: 'user' })
  answerGrant(db, { userId: w.bob.id, grantId: grant.id, decision: 'approve' })
  return grant.id
}

test('contacts: request, accept, and both rows are active', async () => {
  const { db, alice, bob } = await world()
  const out = requestContact(db, { userId: alice.id, peerName: 'bob', by: 'user' })
  assert.equal(out.outcome, 'sent')
  assert.equal(state(db, alice.id, 'bob'), 'pending_out')
  assert.equal(state(db, bob.id, 'alice'), 'pending_in')
  assert.throws(() => requestContact(db, { userId: alice.id, peerName: 'bob', by: 'user' }), /pending/)
  // Only the person asked may accept; the requester's own row is not answerable.
  assert.throws(() => answerContact(db, { userId: alice.id, contactId: out.contact.id, decision: 'approve' }), /not_pending/)
  assert.equal(answerContact(db, { userId: bob.id, contactId: out.contact.id, decision: 'approve' }), null, 'not bob\'s row')
  const acc = answerContact(db, { userId: bob.id, contactId: out.peer.id, decision: 'approve' })
  assert.equal(acc.outcome, 'accepted')
  assert.equal(state(db, alice.id, 'bob'), 'active')
  assert.equal(state(db, bob.id, 'alice'), 'active')
  assert.throws(() => requestContact(db, { userId: alice.id, peerName: 'bob', by: 'user' }), /already_contact/)
  assert.throws(() => requestContact(db, { userId: alice.id, peerName: 'alice', by: 'user' }), /no_user/)
  assert.throws(() => requestContact(db, { userId: alice.id, peerName: 'ghost', by: 'user' }), /no_user/)
  db.close()
})

test('contacts: an agent\'s ask parks, expires after 24 h, and is capped per device', async () => {
  const { db, alice, bob, box } = await world()
  const t0 = 1_000_000
  const out = requestContact(db, { userId: alice.id, peerName: 'bob', by: 'agent', convoId: 'work', deviceId: box.deviceId, now: t0 })
  assert.equal(out.outcome, 'parked')
  assert.equal(state(db, bob.id, 'alice'), null, 'nothing has left')
  // A tap after the TTL expires it instead of sending it.
  const late = answerContact(db, { userId: alice.id, contactId: out.contact.id, decision: 'approve', now: t0 + OWN_ASK_TTL_MS + 1 })
  assert.equal(late.outcome, 'expired')
  assert.equal(state(db, bob.id, 'alice'), null)
  // The sweep does the same for one nobody tapped, and the row can be reused.
  requestContact(db, { userId: alice.id, peerName: 'bob', by: 'agent', convoId: 'work', deviceId: box.deviceId, now: t0 })
  assert.deepEqual(expireContactAsks(db, t0 + OWN_ASK_TTL_MS - 1), [])
  assert.equal(expireContactAsks(db, t0 + OWN_ASK_TTL_MS + 1).length, 1)
  assert.equal(state(db, alice.id, 'bob'), 'expired')
  // The cap counts parked asks of one device.
  for (let i = 0; i < MAX_PARKED_PER_DEVICE; i++) {
    await createUser(db, `u${i}`, 'pw')
    requestContact(db, { userId: alice.id, peerName: `u${i}`, by: 'agent', convoId: 'work', deviceId: box.deviceId })
  }
  assert.throws(() => requestContact(db, { userId: alice.id, peerName: 'bob', by: 'agent', convoId: 'work', deviceId: box.deviceId }), /too_many_asks/)
  db.close()
})

test('contacts: a request overtakes the other side\'s parked ask; crossed requests make contacts', async () => {
  const { db, alice, bob, sam, box } = await world()
  const bobBox = createAgent(db, bob.id, 'bob-box')
  upsertConversation(db, { id: 'bobwork', ownerUserId: bob.id, title: 't', agentDeviceId: bobBox.deviceId })
  const parked = requestContact(db, { userId: bob.id, peerName: 'alice', by: 'agent', convoId: 'bobwork', deviceId: bobBox.deviceId })
  const out = requestContact(db, { userId: alice.id, peerName: 'bob', by: 'user' })
  assert.equal(out.outcome, 'sent')
  assert.equal(out.superseded.id, parked.contact.id)
  assert.equal(state(db, bob.id, 'alice'), 'pending_in')
  // sam asked alice; alice's own request back is the accept.
  requestContact(db, { userId: sam.id, peerName: 'alice', by: 'user' })
  assert.throws(() => requestContact(db, { userId: alice.id, peerName: 'sam', by: 'agent', convoId: 'work', deviceId: box.deviceId }), /pending_in/)
  assert.equal(requestContact(db, { userId: alice.id, peerName: 'sam', by: 'user' }).outcome, 'accepted')
  assert.equal(state(db, sam.id, 'alice'), 'active')
  db.close()
})

test('contacts: a block is silent to the blocked, and survives their removal', async () => {
  const { db, alice, bob } = await world()
  const { own, theirs } = contacts(db, alice, bob)
  blockContact(db, { userId: bob.id, contactId: theirs.id })
  assert.equal(state(db, bob.id, 'alice'), 'blocked')
  assert.equal(state(db, alice.id, 'bob'), 'removed')
  const again = requestContact(db, { userId: alice.id, peerName: 'bob', by: 'user' })
  assert.equal(again.outcome, 'silent')
  assert.equal(again.contact.state, 'pending_out')
  assert.equal(state(db, bob.id, 'alice'), 'blocked')
  removeContact(db, { userId: alice.id, contactId: own.id })
  assert.equal(state(db, bob.id, 'alice'), 'blocked', 'alice removing her row does not lift bob\'s block')
  assert.deepEqual(listContacts(db, alice.id), [])
  // Removing a blocked row is not a second way to unblock: it is refused,
  // and alice's next request still reaches nobody.
  assert.throws(() => removeContact(db, { userId: bob.id, contactId: theirs.id }), /blocked/)
  assert.throws(() => blockContact(db, { userId: bob.id, contactId: theirs.id }), /not_active/)
  assert.equal(requestContact(db, { userId: alice.id, peerName: 'bob', by: 'user' }).outcome, 'silent')
  assert.equal(state(db, bob.id, 'alice'), 'blocked')
  db.close()
})

test('the grant clause: an active grant between two active contact rows, and nothing less', async () => {
  const w = await world()
  const { db, alice, bob, sam } = w
  const m = mission(db, w)
  assert.equal(missionAccess(db, alice.id, m.id), 'owner')
  assert.equal(canReadMission(db, bob.id, m.id), false)
  const { own, theirs } = contacts(db, alice, bob)
  assert.equal(canReadMission(db, bob.id, m.id), false, 'contacts alone share nothing')
  const { grant } = shareMission(db, { ownerUserId: alice.id, missionId: m.id, contact: 'bob', level: 'read', by: 'user' })
  assert.equal(grant.state, 'pending')
  assert.equal(canReadMission(db, bob.id, m.id), false, 'offered is not accepted')
  assert.throws(() => answerGrant(db, { userId: alice.id, grantId: grant.id, decision: 'approve' }), /not_pending/, 'the owner cannot accept for the grantee')
  assert.equal(answerGrant(db, { userId: sam.id, grantId: grant.id, decision: 'approve' }), null)
  assert.equal(answerGrant(db, { userId: bob.id, grantId: grant.id, decision: 'approve' }).outcome, 'accepted')
  assert.equal(missionAccess(db, bob.id, m.id), 'read')
  assert.equal(canReadMission(db, sam.id, m.id), false)
  assert.deepEqual(activeGranteeIds(db, m.id), [bob.id])
  // Read is not write, and a grant is not a transcript.
  assert.equal(canWriteMission(db, bob.id, m.id), false)
  assert.equal(canWriteMission(db, alice.id, m.id), true)
  assert.equal(canReadConvo(db, bob.id, 'work'), false)
  // Either contact row leaving 'active' closes the clause, with the grant row untouched.
  db.prepare("UPDATE contacts SET state='removed' WHERE id=?").run(theirs.id)
  assert.equal(canReadMission(db, bob.id, m.id), false)
  db.prepare("UPDATE contacts SET state='active' WHERE id=?").run(theirs.id)
  db.prepare("UPDATE contacts SET state='blocked' WHERE id=?").run(own.id)
  assert.equal(canReadMission(db, bob.id, m.id), false)
  assert.deepEqual(activeGranteeIds(db, m.id), [])
  db.prepare("UPDATE contacts SET state='active' WHERE id=?").run(own.id)
  assert.equal(canReadMission(db, bob.id, m.id), true)
  // Revocation, by either party and nobody else.
  assert.equal(revokeGrant(db, { userId: sam.id, grantId: grant.id }), null)
  assert.equal(revokeGrant(db, { userId: bob.id, grantId: grant.id }).by, 'grantee')
  assert.equal(canReadMission(db, bob.id, m.id), false)
  assert.throws(() => revokeGrant(db, { userId: alice.id, grantId: grant.id }), /not_active/)
  // The row is reused by a new share.
  const renewed = shareMission(db, { ownerUserId: alice.id, missionId: m.id, contact: own.id, level: 'read', by: 'user' })
  assert.equal(renewed.grant.id, grant.id)
  assert.equal(renewed.grant.state, 'pending')
  db.close()
})

test('grants: an agent\'s ask parks for the owner, expires, and removal of the contact revokes everything', async () => {
  const w = await world()
  const { db, alice, bob, box } = w
  const m = mission(db, w)
  const { own } = contacts(db, alice, bob)
  const t0 = 5_000_000
  const ask = shareMission(db, { ownerUserId: alice.id, missionId: m.id, contact: 'bob', level: 'read', by: 'agent', convoId: 'work', deviceId: box.deviceId, now: t0 })
  assert.equal(ask.grant.state, 'awaiting_owner')
  assert.deepEqual(listGrants(db, bob.id, { direction: 'in' }), [], 'the grantee is not told of an unapproved ask')
  assert.equal(revokeGrant(db, { userId: bob.id, grantId: ask.grant.id }), null)
  assert.equal(answerGrant(db, { userId: bob.id, grantId: ask.grant.id, decision: 'approve' }), null)
  assert.throws(() => shareMission(db, { ownerUserId: alice.id, missionId: m.id, contact: 'bob', level: 'read', by: 'user' }), /pending/)
  assert.equal(expireGrantAsks(db, t0 + OWN_ASK_TTL_MS + 1).length, 1)
  // Approved while the two are no longer contacts: revoked, not sent.
  const again = shareMission(db, { ownerUserId: alice.id, missionId: m.id, contact: 'bob', level: 'read', by: 'agent', convoId: 'work', deviceId: box.deviceId })
  db.prepare("UPDATE contacts SET state='removed' WHERE user_id=?").run(bob.id)
  assert.equal(answerGrant(db, { userId: alice.id, grantId: again.grant.id, decision: 'approve' }).outcome, 'unavailable')
  db.prepare("UPDATE contacts SET state='active' WHERE user_id=?").run(bob.id)
  // Live and pending grants both end with the contact.
  const m2 = mission(db, w, { title: 'Second' })
  const g1 = shareMission(db, { ownerUserId: alice.id, missionId: m.id, contact: 'bob', level: 'read', by: 'user' }).grant
  answerGrant(db, { userId: bob.id, grantId: g1.id, decision: 'approve' })
  shareMission(db, { ownerUserId: alice.id, missionId: m2.id, contact: 'bob', level: 'read', by: 'user' })
  const out = removeContact(db, { userId: bob.id, contactId: getContactRaw(db, bob.id, 'alice').id })
  assert.equal(out.revokedGrants.length, 2)
  assert.deepEqual(listGrants(db, alice.id, { direction: 'out' }), [])
  assert.deepEqual(listGrants(db, alice.id, { state: 'revoked' }).map((g) => g.revoked_by), ['contact_removed', 'contact_removed'])
  assert.equal(state(db, alice.id, 'bob'), 'removed')
  assert.equal(own.user_id, alice.id)
  db.close()
})

test('grants: only the owner\'s own shareable missions, and a hand-over needs its brief', async () => {
  const w = await world()
  const { db, alice, bob, priv } = w
  const m = mission(db, w)
  const hidden = mission(db, w, { convo: 'secret', device: priv.deviceId, title: 'Private' })
  contacts(db, alice, bob)
  const share = (over) => shareMission(db, { ownerUserId: alice.id, missionId: m.id, contact: 'bob', level: 'read', by: 'user', ...over })
  assert.throws(() => share({ level: 'owner' }), /no_brief/, 'a hand-over needs its brief (test/handover.test.js)')
  assert.throws(() => share({ level: 'admin' }), /bad_level/)
  assert.throws(() => share({ contact: 'sam' }), /not_contact/)
  assert.throws(() => share({ missionId: hidden.id }), /private_mission/)
  assert.throws(() => share({ ownerUserId: bob.id, contact: 'alice' }), /no_mission/, 'not the caller\'s mission')
  db.close()
})

test('the grantee\'s view applies the private sieve and carries no ids', async () => {
  const w = await world()
  const { db, alice, bob, box, priv, phone } = w
  const m = mission(db, w)
  milestone(db, w, m, 'work', 'Public step')
  milestone(db, w, m, 'secret', 'Private step')
  const item = (deviceConvo, title, extra = {}) => createItem(db, {
    userId: alice.id, kind: 'task', title, originConvoId: deviceConvo, originDeviceId: box.deviceId, createdBy: 'agent', ...extra,
  }).item
  const open = item('work', 'Visible task')
  const secret = item('secret', 'Private task')
  db.prepare('UPDATE items SET mission_id=? WHERE id IN (?,?)').run(m.id, open.id, secret.id)
  const mirror = item('work', 'Approve something', { consent: 'spawn' })
  db.prepare('UPDATE items SET mission_id=? WHERE id=?').run(m.id, mirror.id)
  insertBlob(db, { id: 'blob1', ownerUserId: alice.id, contentType: 'image/png', size: 3, sha256: 'x', diskPath: '/tmp/x' })
  insertBlob(db, { id: 'blob2', ownerUserId: alice.id, contentType: 'image/png', size: 3, sha256: 'y', diskPath: '/tmp/y' })
  const att = (id) => [{ blob_ref: id, mime: 'image/png', name: 'a.png', size: 3 }]
  addComment(db, { userId: alice.id, itemId: open.id, author: 'user', deviceId: phone.deviceId, body: 'see', attachments: att('blob1') })
  addComment(db, { userId: alice.id, itemId: secret.id, author: 'user', deviceId: phone.deviceId, body: 'see', attachments: att('blob2') })
  updateMission(db, { userId: alice.id, missionId: m.id, fields: { status: 'from the private box' }, statusWriter: { by: 'agent', convoId: 'secret', deviceId: priv.deviceId } })

  assert.deepEqual(sharePreview(db, m.id), { milestones: 1, items: 1, comments: 1, attachments: 1 })
  assert.equal(getGrantedMission(db, bob.id, m.id), null)
  assert.equal(canReadBlob(db, bob.id, 'blob1'), false)
  granted(db, w, m)

  const row = getGrantedMission(db, bob.id, m.id)
  assert.equal(row.shared_via, 'grant')
  assert.equal(row.milestones, 1)
  assert.equal(row.open_items, 1)
  // An item waiting on the OWNER is not the grantee's to answer, in the
  // count or in the activity derived from it.
  db.prepare("UPDATE items SET awaiting='user' WHERE id=?").run(open.id)
  const waiting = getGrantedMission(db, bob.id, m.id)
  assert.equal(waiting.needs_you, 0)
  assert.notEqual(waiting.activity, 'waiting')
  assert.equal(row.last_milestone.title, 'Public step')
  assert.equal(row.status, null, 'a privately written status is withheld')
  for (const k of ['status_convo_id', 'closed_convo_id', 'project_id']) assert.equal(row[k], null, k)
  assert.equal(row.origin_convo_id, '')
  assert.equal(row.origin_device_id, 0)
  assert.equal(row.owner.name, 'alice')
  assert.deepEqual(listGrantedMissions(db, bob.id).map((x) => x.id), [m.id])
  assert.deepEqual(listGrantedMissions(db, alice.id), [], 'never the owner\'s own')
  const detail = grantedMissionDetail(db, row)
  assert.deepEqual(detail.milestones.map((l) => l.title), ['Public step'])
  assert.deepEqual(detail.items.map((i) => i.title), ['Visible task'])
  assert.deepEqual(detail.conversations, [])
  const json = JSON.stringify(detail)
  for (const leak of ['work', 'secret', 'alice-box', 'convo_id":"']) assert.ok(!json.includes(`"${leak}"`), `${leak} must not cross`)

  assert.equal(getSharedItem(db, bob.id, open.id).shared_via, 'grant')
  assert.equal(getSharedItem(db, bob.id, secret.id), null)
  assert.equal(getSharedItem(db, bob.id, mirror.id), null)
  assert.equal(canReadBlob(db, bob.id, 'blob1'), true)
  assert.equal(canReadBlob(db, bob.id, 'blob2'), false, 'an attachment on a private-box item stays home')
  assert.equal(canReadBlob(db, w.sam.id, 'blob1'), false)
  // The mission's origin box turning private later hides the mission, its
  // items and their attachments together: a kept URL opens nothing.
  pinDevicePrivate(db, box.deviceId, true)
  assert.equal(getGrantedMission(db, bob.id, m.id), null)
  assert.equal(getSharedItem(db, bob.id, open.id), null)
  assert.equal(canReadBlob(db, bob.id, 'blob1'), false)
  db.close()
})

test('contacts: an unlisted account is in nobody\'s list, has no list, and can neither be asked nor ask', async () => {
  const w = await world()
  const { db, alice, bob, sam, box } = w
  const names = (u) => listJournalUsers(db, u.id).map((r) => r.name)
  assert.deepEqual(names(alice), ['bob', 'sam'])
  // sam and bob are contacts before sam is flagged: that row is left alone.
  contacts(db, sam, bob)
  db.prepare('UPDATE users SET unlisted=1 WHERE id=?').run(sam.id)
  assert.deepEqual(names(alice), ['bob'])
  assert.deepEqual(names(bob), ['alice'])
  assert.deepEqual(names(sam), [], 'the unlisted account sees nobody')
  // To it, and from it, by a tap or by an agent: the answer for a name that does not exist.
  assert.throws(() => requestContact(db, { userId: alice.id, peerName: 'sam', by: 'user' }), /^Error: no_user$/)
  assert.throws(() => requestContact(db, { userId: alice.id, peerName: 'sam', by: 'agent', convoId: 'work', deviceId: box.deviceId }), /^Error: no_user$/)
  assert.throws(() => requestContact(db, { userId: sam.id, peerName: 'alice', by: 'user' }), /^Error: no_user$/)
  assert.throws(() => requestContact(db, { userId: sam.id, peerName: 'nobody', by: 'user' }), /^Error: no_user$/)
  assert.equal(state(db, alice.id, 'sam'), null, 'no row was made')
  assert.equal(state(db, sam.id, 'alice'), null)
  assert.equal(state(db, bob.id, 'sam'), 'active')
  // Off again: listed, and reachable.
  db.prepare('UPDATE users SET unlisted=0 WHERE id=?').run(sam.id)
  assert.deepEqual(names(alice), ['bob', 'sam'])
  assert.equal(requestContact(db, { userId: alice.id, peerName: 'sam', by: 'user' }).outcome, 'sent')
  db.close()
})

test('contacts: a user whose name starts with ct_ is found by name; a grant names its contact to the owner only', async () => {
  const w = await world()
  const { db, alice, bob } = w
  const odd = await createUser(db, 'ct_bob', 'pw')
  assert.equal(requestContact(db, { userId: alice.id, peerName: 'ct_bob', by: 'user' }).outcome, 'sent')
  const theirs = getContactRaw(db, odd.id, 'alice')
  answerContact(db, { userId: odd.id, contactId: theirs.id, decision: 'approve' })
  const own = getContactRaw(db, alice.id, 'ct_bob')
  assert.equal(own.state, 'active')
  assert.equal(getContactRaw(db, alice.id, own.id).id, own.id, 'and still by id')
  assert.equal(getContactRaw(db, bob.id, own.id), null, 'never another user\'s row')
  const m = mission(db, w)
  const { grant } = shareMission(db, { ownerUserId: alice.id, missionId: m.id, contact: 'ct_bob', level: 'read', by: 'user' })
  assert.equal(grant.contact_id, own.id)
  assert.equal(listGrants(db, alice.id, { direction: 'out' })[0].contact_id, own.id)
  assert.equal('contact_id' in listGrants(db, odd.id, { direction: 'in' })[0], false, 'the owner\'s row id is not the grantee\'s business')
  db.close()
})
