import test from 'node:test'
import assert from 'node:assert/strict'
import { world, post, grantOf, incoming, mirrorOf, audits, notices } from './federation-world.js'

// Contribute shares across journals, the grant (phase 5 stage 10a): alice on
// a.example offers bob on b.example her mission to contribute to, or raises
// a read share she gave him. What he may then write is stage 10b.
const share = async (w, level) => {
  const r = await w.phones.alice(`/missions/${w.mission.id}/shares`, post({ contact: 'bob@b.example', level }))
  await w.settle()
  return r
}
const accept = async (w) => {
  const mirror = mirrorOf(w.b, w.users.bob.id)
  const tap = await w.phones.bob(`/items/${mirror.id}/comments`, post({ action: 'Accept' }))
  assert.equal(tap.status, 200, JSON.stringify(tap.json))
  await w.settle()
  return tap
}

test('a contribute share crosses: the card says so, and both sides hold it at contribute', async (t) => {
  const w = await world(t)
  const r = await share(w, 'contribute')
  assert.equal(r.status, 201, JSON.stringify(r.json))
  const [fg] = incoming(w.b)
  assert.deepEqual([fg.state, fg.level], ['pending', 'contribute'])
  const mirror = mirrorOf(w.b, w.users.bob.id)
  assert.match(mirror.body, /to contribute to/)
  assert.match(mirror.body, /\*\*Can contribute:\*\*/)
  await accept(w)
  assert.deepEqual([grantOf(w.a, r.json.grant.id).state, grantOf(w.a, r.json.grant.id).level], ['active', 'contribute'])
  assert.equal(audits(w.a, w.users.alice.id).at(-1).summary, `bob@b.example accepted mission #${w.mission.num} Garden Club — shared to contribute to`)
  assert.equal(audits(w.b, w.users.bob.id)[0].summary, 'alice@a.example offered you mission "Garden Club" to contribute to')
  const copy = (await w.phones.bob('/missions?scope=shared')).json.missions[0]
  assert.equal(copy.grant.level, 'contribute')
})

test('a read share raised to contribute: a second card, the share standing at read until the accept', async (t) => {
  const w = await world(t)
  const r = await share(w, 'read')
  await accept(w)
  const gid = r.json.grant.id
  const raised = await share(w, 'contribute')
  assert.equal(raised.status, 201, JSON.stringify(raised.json))
  assert.deepEqual([grantOf(w.a, gid).level, grantOf(w.a, gid).pending_level, grantOf(w.a, gid).pending_state], ['read', 'contribute', 'pending'])

  const [fg] = incoming(w.b)
  assert.deepEqual([fg.state, fg.level, fg.pending_level], ['active', 'read', 'contribute'])
  const listed = (await w.phones.bob(`/grants/${fg.id}`)).json.grant
  assert.deepEqual([listed.level, listed.pending_level, listed.pending_state], ['read', 'contribute', 'pending'])
  const mirror = mirrorOf(w.b, w.users.bob.id)
  assert.equal(mirror.state, 'open')
  assert.equal(mirror.title, 'alice@a.example invites you to contribute to a mission you read — Garden Club')
  assert.match(mirror.body, /Decline and the share stays read-only/)
  // The copy is still read-only until bob says yes.
  assert.equal((await w.phones.bob('/missions?scope=shared')).json.missions[0].grant.level, 'read')
  // The same raise heard twice is one card.
  const ops = w.a.db.prepare("SELECT id FROM fed_outbox WHERE op='grant.offer' ORDER BY created_at").all()
  w.a.db.prepare("UPDATE fed_outbox SET state='queued', next_at=0 WHERE id=?").run(ops.at(-1).id)
  await w.settle()
  assert.equal(w.b.db.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id=? AND consent='share' AND state='open'").get(w.users.bob.id).n, 1)

  await accept(w)
  assert.deepEqual([incoming(w.b)[0].level, incoming(w.b)[0].pending_level], ['contribute', null])
  assert.deepEqual([grantOf(w.a, gid).level, grantOf(w.a, gid).pending_state], ['contribute', null])
  assert.equal((await w.phones.bob('/missions?scope=shared')).json.missions[0].grant.level, 'contribute')
  assert.match(w.b.db.prepare("SELECT body FROM item_comments WHERE item_id=? ORDER BY created_at DESC LIMIT 1").get(mirror.id).body, /you can now contribute/)
})

test('a raise declined leaves the share read-only on both sides', async (t) => {
  const w = await world(t)
  const r = await share(w, 'read')
  await accept(w)
  await share(w, 'contribute')
  const [fg] = incoming(w.b)
  assert.equal((await w.phones.bob(`/grants/${fg.id}/answer`, post({ decision: 'decline' }))).status, 200)
  await w.settle()
  assert.deepEqual([incoming(w.b)[0].state, incoming(w.b)[0].level, incoming(w.b)[0].pending_level], ['active', 'read', null])
  const g = grantOf(w.a, r.json.grant.id)
  assert.deepEqual([g.state, g.level, g.pending_state], ['active', 'read', null])
})

test('a raise accepted after the owner ended the share goes back to read, and bob is told', async (t) => {
  const w = await world(t)
  const r = await share(w, 'read')
  await accept(w)
  await share(w, 'contribute')
  // The owner's journal ends the share before bob's yes arrives; its revoke
  // is held back so bob still sees the raise.
  w.a.db.prepare("UPDATE grants SET state='revoked', revoked_by='owner', pending_level=NULL, pending_state=NULL WHERE id=?").run(r.json.grant.id)
  const [fg] = incoming(w.b)
  assert.equal((await w.phones.bob(`/grants/${fg.id}/answer`, post({ decision: 'approve' }))).status, 200)
  await w.settle()
  assert.equal(incoming(w.b)[0].level, 'read')
  assert.match(notices(w.b, w.users.bob.id).at(-1).title, /Couldn't accept contributing/)
})

test('a share that ends while a raise waits closes the raise card', async (t) => {
  const w = await world(t)
  const r = await share(w, 'read')
  await accept(w)
  await share(w, 'contribute')
  const raise = mirrorOf(w.b, w.users.bob.id)
  assert.equal(raise.state, 'open')
  assert.equal((await w.phones.alice(`/grants/${r.json.grant.id}`, { method: 'DELETE' })).status, 200)
  await w.settle()
  const after = w.b.db.prepare('SELECT state, resolution FROM items WHERE id=?').get(raise.id)
  assert.deepEqual([after.state, after.resolution], ['closed', 'cancelled'])
})
