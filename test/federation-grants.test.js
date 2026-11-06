import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgent } from '../src/auth.js'
import { world, post, grantOf, incoming, mirrorOf, audits, notices, offer } from './federation-world.js'
import { enqueue } from '../src/federation-outbox.js'

// Read shares across journals (phase 5 stage 7a), end to end between two
// journals on loopback: alice on a.example shares her mission with bob on
// b.example. The grant; what it lets bob read is federation-replica.test.js.
test('a read share crosses: the offer, the card on the other journal, the accept', async (t) => {
  const w = await world(t)
  const g = await offer(w)
  assert.deepEqual([g.state, g.grantee.address], ['pending', 'bob@b.example'])

  const [fg] = incoming(w.b)
  assert.deepEqual([fg.state, fg.owner_name, fg.peer_host, fg.peer_grant_ref, fg.mission_title, fg.level], ['pending', 'alice', 'a.example', g.id, 'Garden Club', 'read'])
  const card = w.b.db.prepare("SELECT payload FROM events WHERE user_id=? AND type='permission_request'").get(w.users.bob.id)
  assert.equal(JSON.parse(card.payload).grant_id, fg.id)
  const mirror = mirrorOf(w.b, w.users.bob.id)
  assert.equal(mirror.title, 'alice@a.example wants to share a mission with you — Garden Club')
  assert.match(mirror.body, /on another Matron journal/)

  const listed = (await w.phones.bob('/grants')).json.grants
  assert.deepEqual(listed.map((x) => [x.id, x.direction, x.state, x.owner.address, x.mission.title]), [[fg.id, 'in', 'pending', 'alice@a.example', 'Garden Club']])
  assert.equal((await w.phones.bob(`/grants/${fg.id}`)).json.grant.state, 'pending')
  assert.equal((await w.phones.alice(`/grants/${fg.id}`)).status, 404, 'an fg_ id is the grantee journal\'s own')

  // The tap, through the mirror, as today's apps answer a share card.
  const tap = await w.phones.bob(`/items/${mirror.id}/comments`, post({ action: 'Accept' }))
  assert.equal(tap.status, 200)
  assert.equal(tap.json.grant.state, 'active')
  assert.equal(w.b.db.prepare('SELECT state FROM items WHERE id=?').get(mirror.id).state, 'closed')
  await w.settle()
  assert.equal(grantOf(w.a, g.id).state, 'active')
  assert.deepEqual(audits(w.a, w.users.alice.id).map((r) => r.summary), [
    `You offered bob@b.example mission #${w.mission.num} Garden Club to read`,
    `bob@b.example accepted mission #${w.mission.num} Garden Club — shared read-only`,
  ])
  assert.deepEqual(audits(w.b, w.users.bob.id).map((r) => r.summary), [
    'alice@a.example offered you mission "Garden Club" to read',
    'You accepted mission "Garden Club" from alice@a.example',
  ])
  // Sharing again is the same grant.
  const again = await w.phones.alice(`/missions/${w.mission.id}/shares`, post({ contact: 'bob@b.example', level: 'read' }))
  assert.deepEqual([again.status, again.json.existing], [200, true])
})

test('declining, and either side ending it', async (t) => {
  const w = await world(t)
  const g = await offer(w)
  const [fg] = incoming(w.b)
  const no = await w.phones.bob(`/grants/${fg.id}/answer`, post({ decision: 'decline' }))
  assert.equal(no.json.grant.state, 'declined')
  await w.settle()
  assert.equal(grantOf(w.a, g.id).state, 'declined')

  // Offered again: the same row on b, pending once more.
  const g2 = await offer(w)
  assert.equal(g2.id, g.id)
  assert.equal(incoming(w.b)[0].state, 'pending')
  // The owner withdraws: b's card closes.
  assert.equal((await w.phones.alice(`/grants/${g.id}`, { method: 'DELETE' })).status, 200)
  await w.settle()
  const [ended] = incoming(w.b)
  assert.deepEqual([ended.state, ended.revoked_by], ['revoked', 'owner'])
  assert.equal(w.b.db.prepare('SELECT resolution FROM items WHERE id=?').get(ended.item_id).resolution, 'cancelled')

  // Accepted, then the grantee leaves.
  await offer(w)
  const fg3 = incoming(w.b)[0]
  await w.phones.bob(`/grants/${fg3.id}/answer`, post({ decision: 'approve' }))
  await w.settle()
  assert.equal(grantOf(w.a, g.id).state, 'active')
  const left = await w.phones.bob(`/grants/${fg3.id}`, { method: 'DELETE' })
  assert.equal(left.json.grant.state, 'revoked')
  await w.settle()
  assert.deepEqual([grantOf(w.a, g.id).state, grantOf(w.a, g.id).revoked_by], ['revoked', 'grantee'])
  assert.equal(audits(w.a, w.users.alice.id).at(-1).summary, `bob@b.example ended the share of mission #${w.mission.num} Garden Club`)
  assert.equal((await w.phones.bob(`/grants/${fg3.id}`, { method: 'DELETE' })).json.blocked_by, 'not_active')
})

test('only read crosses; an agent asks and the owner approves; the grantee answers only from a client', async (t) => {
  const w = await world(t)
  for (const level of ['contribute', 'owner']) {
    const r = await w.phones.alice(`/missions/${w.mission.id}/shares`, post({ contact: 'bob@b.example', level, ...(level === 'owner' ? { brief: 'All yours.' } : {}) }))
    assert.deepEqual([r.status, r.json.blocked_by], [409, 'level_unavailable'], level)
  }
  const asked = await w.aliceBox(`/missions/${w.mission.id}/shares`, post({ contact: 'bob@b.example', level: 'read', convo_id: 'work' }))
  assert.equal(asked.status, 202)
  assert.equal(w.a.db.prepare("SELECT COUNT(*) AS n FROM fed_outbox WHERE op='grant.offer'").get().n, 0, 'nothing leaves before the owner approves')
  const ownerMirror = mirrorOf(w.a, w.users.alice.id)
  assert.equal((await w.phones.alice(`/items/${ownerMirror.id}/comments`, post({ action: 'Approve' }))).status, 200)
  await w.settle()
  const [fg] = incoming(w.b)
  assert.equal(fg.state, 'pending')
  const bobBox = createAgent(w.b.db, w.users.bob.id, 'bob-box')
  assert.equal((await w.b.http(`/grants/${fg.id}/answer`, { token: bobBox.token, ...post({ decision: 'approve' }) })).status, 403)
})

test('a contact that ends ends its shares on both journals', async (t) => {
  const w = await world(t)
  const g = await offer(w)
  await w.phones.bob(`/grants/${incoming(w.b)[0].id}/answer`, post({ decision: 'approve' }))
  await w.settle()
  assert.equal(grantOf(w.a, g.id).state, 'active')
  const bobOnA = (await w.phones.alice('/contacts')).json.contacts.find((c) => c.address === 'bob@b.example')
  assert.equal((await w.phones.alice(`/contacts/${bobOnA.id}`, { method: 'DELETE' })).status, 200)
  assert.deepEqual([grantOf(w.a, g.id).state, grantOf(w.a, g.id).revoked_by], ['revoked', 'contact_removed'])
  await w.settle()
  const [fg] = incoming(w.b)
  assert.deepEqual([fg.state, fg.revoked_by], ['revoked', 'contact_removed'])
  assert.equal(audits(w.b, w.users.bob.id).at(-1).summary, 'The share of mission "Garden Club" from alice@a.example ended with the contact')
  // No longer a contact: nothing can be offered.
  const r = await w.phones.alice(`/missions/${w.mission.id}/shares`, post({ contact: 'bob@b.example', level: 'read' }))
  assert.deepEqual([r.status, r.json.blocked_by], [409, 'not_contact'])
})

test('an offer the other journal refuses ends here with a notice', async (t) => {
  const w = await world(t)
  // bob's journal no longer has alice as a contact, and was never told.
  w.b.db.prepare("UPDATE contacts SET state='removed' WHERE user_id=?").run(w.users.bob.id)
  const g = await offer(w)
  assert.equal(grantOf(w.a, g.id).state, 'expired')
  assert.equal(incoming(w.b).length, 0)
  const [n] = notices(w.a, w.users.alice.id).filter((x) => x.title.startsWith("Couldn't offer"))
  assert.equal(n.title, `Couldn't offer mission #${w.mission.num} to bob@b.example`)
  assert.match(n.body, /no longer has you as a contact/)
})

test('an answer that arrives after the owner withdrew does not start the share', async (t) => {
  const w = await world(t)
  const g = await offer(w)
  // The withdrawal is still in alice's outbox when bob taps Accept.
  await w.phones.alice(`/grants/${g.id}`, { method: 'DELETE' })
  const [fg] = incoming(w.b)
  await w.phones.bob(`/grants/${fg.id}/answer`, post({ decision: 'approve' }))
  await w.b.federationOutbox.tick()
  assert.equal(grantOf(w.a, g.id).state, 'revoked')
  await w.settle()
  const [after] = incoming(w.b)
  assert.equal(after.state, 'revoked')
  assert.equal(grantOf(w.a, g.id).state, 'revoked')
})

test('an accept that never gets back leaves the owner free to offer again', async (t) => {
  const w = await world(t)
  const g = await offer(w)
  // alice's journal refuses bob's answer, so it dies in bob's outbox.
  const row = w.a.db.prepare("SELECT id FROM contacts WHERE user_id=? AND peer_journal='b.example'").get(w.users.alice.id)
  w.a.db.prepare("UPDATE contacts SET state='removed' WHERE id=?").run(row.id)
  const [fg] = incoming(w.b)
  await w.phones.bob(`/grants/${fg.id}/answer`, post({ decision: 'approve' }))
  await w.settle()
  assert.deepEqual([incoming(w.b)[0].state, grantOf(w.a, g.id).state], ['revoked', 'pending'])
  const [n] = notices(w.b, w.users.bob.id).filter((x) => x.title.startsWith("Couldn't accept"))
  assert.match(n.body, /Ask them to offer it again/)

  w.a.db.prepare("UPDATE contacts SET state='active' WHERE id=?").run(row.id)
  // Still pending here, but the owner may send it again; an agent may not.
  const byAgent = await w.aliceBox(`/missions/${w.mission.id}/shares`, post({ contact: 'bob@b.example', level: 'read', convo_id: 'work' }))
  assert.deepEqual([byAgent.status, byAgent.json.blocked_by], [409, 'pending'])
  const g2 = await offer(w)
  assert.equal(g2.id, g.id)
  assert.equal(incoming(w.b)[0].state, 'pending')
  await w.phones.bob(`/grants/${incoming(w.b)[0].id}/answer`, post({ decision: 'approve' }))
  await w.settle()
  assert.equal(grantOf(w.a, g.id).state, 'active')
})

test('the grantee ending the contact is logged as theirs', async (t) => {
  const w = await world(t)
  await offer(w)
  await w.phones.bob(`/grants/${incoming(w.b)[0].id}/answer`, post({ decision: 'approve' }))
  await w.settle()
  const aliceOnB = (await w.phones.bob('/contacts')).json.contacts.find((c) => c.address === 'alice@a.example')
  assert.equal((await w.phones.bob(`/contacts/${aliceOnB.id}`, { method: 'DELETE' })).status, 200)
  assert.equal(audits(w.b, w.users.bob.id).at(-1).summary, 'The share of mission "Garden Club" from alice@a.example ended with the contact')
})

test('a decline that crosses the offer sent again is stale', async (t) => {
  const w = await world(t)
  const g = await offer(w)
  // alice's journal refuses bob's accept, so her grant stays pending.
  const row = w.a.db.prepare("SELECT id FROM contacts WHERE user_id=? AND peer_journal='b.example'").get(w.users.alice.id)
  w.a.db.prepare("UPDATE contacts SET state='removed' WHERE id=?").run(row.id)
  await w.phones.bob(`/grants/${incoming(w.b)[0].id}/answer`, post({ decision: 'approve' }))
  await w.settle()
  w.a.db.prepare("UPDATE contacts SET state='active' WHERE id=?").run(row.id)
  // Offered again; then bob declines the new card, but his decline names the
  // first sending (as if it had left before the new offer arrived).
  await new Promise((r) => setTimeout(r, 5))
  await offer(w)
  const fg = incoming(w.b)[0]
  assert.equal(fg.state, 'pending')
  w.b.db.prepare('UPDATE fed_grants_in SET offer_sent=? WHERE id=?').run(fg.offer_sent - 1, fg.id)
  await w.phones.bob(`/grants/${fg.id}/answer`, post({ decision: 'decline' }))
  await w.settle()
  assert.equal(grantOf(w.a, g.id).state, 'pending', 'a stale decline changes nothing')
  // A current one does.
  w.b.db.prepare("UPDATE fed_grants_in SET state='pending', offer_sent=? WHERE id=?").run(fg.offer_sent, fg.id)
  await w.phones.bob(`/grants/${fg.id}/answer`, post({ decision: 'decline' }))
  await w.settle()
  assert.equal(grantOf(w.a, g.id).state, 'declined')
})

test('an older offer arriving late neither rewinds nor reopens', async (t) => {
  const w = await world(t)
  const g = await offer(w)
  const [fg] = incoming(w.b)
  await w.phones.bob(`/grants/${fg.id}/answer`, post({ decision: 'decline' }))
  await w.settle()
  // A copy of the first offer, delayed in flight, arrives after the decline
  // (alice's grant held pending just long enough for it to go out).
  const { body } = w.a.db.prepare("SELECT body FROM fed_outbox WHERE op='grant.offer'").get()
  w.a.db.prepare("UPDATE grants SET state='pending' WHERE id=?").run(g.id)
  enqueue(w.a.db, { userId: w.users.alice.id, from: 'alice@a.example', to: 'bob@b.example', op: 'grant.offer', body: JSON.parse(body), subject: `grant:${g.id}` })
  await w.settle()
  const [after] = incoming(w.b)
  assert.deepEqual([after.state, after.offer_sent], ['declined', fg.offer_sent])
})
