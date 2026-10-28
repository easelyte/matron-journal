import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { peopleConvoId } from '../src/people-convo.js'

// Contacts and read-only mission share between two users on one journal
// (spec 2026-10-02 matron-to-matron sharing, phase 1), end to end over real
// HTTP and sockets: alice (a box, a Coordinator box and a phone) and bob (a
// box and a phone).
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))

async function world(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const bob = await createUser(s.db, 'bob', 'pw')
  const aliceBox = createAgent(s.db, alice.id, 'alice-box')
  const aliceCoord = createAgent(s.db, alice.id, 'alice-coord')
  const bobBox = createAgent(s.db, bob.id, 'bob-box')
  upsertConversation(s.db, { id: 'work', ownerUserId: alice.id, title: 'Garden Club', agentDeviceId: aliceBox.deviceId })
  upsertConversation(s.db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator', agentDeviceId: aliceCoord.deviceId })
  upsertConversation(s.db, { id: 'bobwork', ownerUserId: bob.id, title: 'Bob', agentDeviceId: bobBox.deviceId })
  const login = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: `${name}-phone` } })).json.token
  const alicePhone = await login('alice')
  const bobPhone = await login('bob')
  assert.equal((await s.http('/coordinator', { method: 'PUT', token: alicePhone, body: { convo_id: 'coord' } })).status, 200)
  const sockets = {}
  for (const [k, token] of Object.entries({ alicePhone, bobPhone, aliceBox: aliceBox.token, aliceCoord: aliceCoord.token, bobBox: bobBox.token })) {
    sockets[k] = await makeWsClient(s.base, { token, cursor: null })
    await sockets[k].waitFor((f) => f.op === 'hello_ok')
  }
  t.after(() => { for (const w of Object.values(sockets)) { try { w.close() } catch { /* already closed */ } } })
  const http = (token) => (path, opts = {}) => s.http(path, { token, ...opts })
  return {
    s, alice, bob, ws: sockets,
    aliceBox: http(aliceBox.token), aliceCoord: http(aliceCoord.token), bobBox: http(bobBox.token),
    alicePhone: http(alicePhone), bobPhone: http(bobPhone),
  }
}

const post = (body) => ({ method: 'POST', body })
const cards = (w, kind) => w.journal().filter((f) => f.type === 'permission_request' && f.payload.kind === kind)
const audits = (w) => w.journal().filter((f) => f.type === 'people').map((f) => f.payload.event)

// alice and bob become contacts from their phones: the short path the rest
// of the tests start from.
async function makeContacts(w) {
  const r = await w.alicePhone('/contacts', post({ user: 'bob' }))
  assert.equal(r.status, 201)
  const bobSide = (await w.bobPhone('/contacts')).json.contacts[0]
  assert.equal((await w.bobPhone(`/contacts/${bobSide.id}/answer`, post({ decision: 'approve' }))).status, 200)
  return { aliceContact: r.json.contact.id, bobContact: bobSide.id }
}

async function makeMission(w) {
  const m = await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Garden Club launch', body: 'Ship it.' }))
  assert.equal(m.status, 201)
  return m.json.mission
}

test('the user directory lists the journal\'s other users, names only', async (t) => {
  const w = await world(t)
  assert.deepEqual((await w.aliceBox('/contacts/users')).json, { users: [{ name: 'bob' }] })
  assert.deepEqual((await w.bobPhone('/contacts/users')).json, { users: [{ name: 'alice' }] })
})

test('an unlisted account: not in the directory, an empty directory of its own, and one 404 either way', async (t) => {
  const w = await world(t)
  w.s.db.prepare('UPDATE users SET unlisted=1 WHERE id=?').run(w.bob.id)
  assert.deepEqual((await w.aliceBox('/contacts/users')).json, { users: [] })
  assert.deepEqual((await w.alicePhone('/contacts/users')).json, { users: [] })
  assert.deepEqual((await w.bobPhone('/contacts/users')).json, { users: [] })
  assert.deepEqual((await w.bobBox('/contacts/users')).json, { users: [] })
  const unknown = await w.alicePhone('/contacts', post({ user: 'nobody' }))
  for (const r of [
    await w.alicePhone('/contacts', post({ user: 'bob' })),
    await w.aliceBox('/contacts', post({ user: 'bob', convo_id: 'work' })),
    await w.bobPhone('/contacts', post({ user: 'alice' })),
    await w.bobBox('/contacts', post({ user: 'alice', convo_id: 'bobwork' })),
  ]) {
    assert.equal(r.status, 404)
    assert.deepEqual(r.json, unknown.json, 'indistinguishable from a name that does not exist')
  }
  await settle()
  assert.equal(cards(w.ws.bobPhone, 'contact_request').length, 0)
  assert.equal(cards(w.ws.alicePhone, 'contact_request').length, 0)
  assert.deepEqual((await w.bobPhone('/contacts')).json.contacts, [])
})

test('an agent\'s contact ask parks for its own user; the tap sends it; the other person accepts once', async (t) => {
  const w = await world(t)
  // Being on the same journal makes nobody a contact (spec decision 8).
  assert.deepEqual((await w.alicePhone('/contacts')).json.contacts, [])
  assert.equal((await w.aliceBox('/contacts', post({ user: 'bob' }))).status, 400, 'an agent must say which conversation asks')
  assert.equal((await w.aliceBox('/contacts', post({ user: 'bob', convo_id: 'bobwork' }))).status, 404, 'not a conversation of this agent')
  assert.equal((await w.aliceBox('/contacts', post({ user: 'nobody', convo_id: 'work' }))).status, 404)
  assert.equal((await w.aliceBox('/contacts', post({ user: 'alice', convo_id: 'work' }))).status, 404, 'yourself is the same 404')

  const ask = await w.aliceBox('/contacts', post({ user: 'bob', convo_id: 'work' }))
  assert.equal(ask.status, 202)
  assert.equal(ask.json.pending, 'owner')
  assert.equal(ask.json.contact.state, 'awaiting_user')
  const id = ask.json.contact.id
  await settle()

  // alice's phone has the card, in the asking conversation; no agent does.
  const card = cards(w.ws.alicePhone, 'contact_request')[0]
  assert.equal(card.convo_id, 'work')
  assert.equal(card.payload.direction, 'out')
  assert.equal(card.payload.peer.name, 'bob')
  assert.equal(card.payload.from_name, 'alice-box')
  for (const k of ['aliceBox', 'aliceCoord', 'bobBox']) assert.equal(cards(w.ws[k], 'contact_request').length, 0, `${k} never sees the card`)
  // Nothing has left for bob.
  assert.deepEqual((await w.bobPhone('/contacts')).json.contacts, [])
  assert.equal(cards(w.ws.bobPhone, 'contact_request').length, 0)

  // The mirror: a question for alice with two buttons, invisible to agents.
  const mirror = (await w.alicePhone('/items?label=consent')).json.items[0]
  assert.equal(mirror.consent, 'contact')
  assert.deepEqual(mirror.actions, ['Approve', 'Decline'])
  assert.equal(mirror.awaiting, 'user')
  assert.equal((await w.aliceBox(`/items/${mirror.id}`)).status, 404)
  assert.equal((await w.aliceBox('/items?label=consent')).json.items.length, 0)

  // No agent answers — not the asker, not the Coordinator.
  for (const agent of [w.aliceBox, w.aliceCoord]) {
    assert.equal((await agent(`/contacts/${id}/answer`, post({ decision: 'approve' }))).status, 403)
  }
  assert.equal((await w.aliceBox(`/items/${mirror.id}/comments`, post({ action: 'Approve' }))).status, 404)
  // The asking agent asking again is told it is pending.
  const again = await w.aliceBox('/contacts', post({ user: 'bob', convo_id: 'work' }))
  assert.equal(again.status, 409)
  assert.equal(again.json.blocked_by, 'pending')

  // alice taps Approve on the mirror — the path today's apps have.
  const tap = await w.alicePhone(`/items/${mirror.id}/comments`, post({ action: 'Approve' }))
  assert.equal(tap.status, 200)
  assert.equal(tap.json.item.state, 'closed')
  assert.equal(tap.json.contact.state, 'pending_out')
  await settle()

  // bob: one accept card in his People conversation, and its mirror.
  const people = peopleConvoId(w.s.db, w.bob.id)
  assert.ok(people)
  const bobCard = cards(w.ws.bobPhone, 'contact_request')[0]
  assert.equal(bobCard.convo_id, people)
  assert.equal(bobCard.sender, 'journal')
  assert.equal(bobCard.payload.direction, 'in')
  assert.equal(bobCard.payload.peer.name, 'alice')
  assert.equal(cards(w.ws.bobBox, 'contact_request').length, 0, 'bob\'s agent never sees it')
  const bobSide = (await w.bobPhone('/contacts')).json.contacts[0]
  assert.equal(bobSide.state, 'pending_in')
  assert.equal(bobSide.address, 'alice')
  const bobMirror = (await w.bobPhone('/items?label=consent')).json.items[0]
  assert.deepEqual(bobMirror.actions, ['Accept', 'Decline'])
  assert.equal(bobMirror.origin_convo_id, people)

  // bob's agent can read that a request is waiting, but cannot accept it.
  assert.equal((await w.bobBox('/contacts')).json.contacts[0].state, 'pending_in')
  assert.equal((await w.bobBox(`/contacts/${bobSide.id}/answer`, post({ decision: 'approve' }))).status, 403)
  const sneaky = await w.bobBox('/contacts', post({ user: 'alice', convo_id: 'bobwork' }))
  assert.equal(sneaky.status, 409, 'asking back is not a way around the accept card for an agent')
  assert.equal(sneaky.json.blocked_by, 'pending_in')

  const accept = await w.bobPhone(`/contacts/${bobSide.id}/answer`, post({ decision: 'approve' }))
  assert.equal(accept.status, 200)
  assert.equal(accept.json.contact.state, 'active')
  await settle()
  assert.equal((await w.alicePhone(`/contacts/${id}`)).json.contact.state, 'active')
  assert.equal((await w.bobPhone(`/items/${bobMirror.id}`)).json.item.state, 'closed')

  // Both logs carry the trail, and both phones were told to refetch.
  assert.deepEqual(audits(w.ws.alicePhone), ['contact.requested', 'contact.accepted'])
  assert.deepEqual(audits(w.ws.bobPhone), ['contact.received', 'contact.accepted'])
  assert.ok(w.ws.alicePhone.frames.some((f) => f.kind === 'people' && f.event === 'changed'))
  for (const k of ['aliceBox', 'aliceCoord', 'bobBox']) assert.deepEqual(audits(w.ws[k]), [], `${k} hears no audit event`)
  const activity = (await w.alicePhone(`/contacts/${id}/activity`)).json.events.map((e) => e.event)
  assert.deepEqual(activity, ['contact.accepted', 'contact.requested'])
  // The trail is the user's, like the events it lists: an agent gets no door to it.
  assert.equal((await w.aliceBox(`/contacts/${id}/activity`)).status, 403)
})

test('the Coordinator is never offered, and cannot answer, a contact or share ask', async (t) => {
  const w = await world(t)
  const ask = await w.aliceBox('/contacts', post({ user: 'bob', convo_id: 'work' }))
  const pending = await w.aliceCoord('/consent/pending?convo_id=coord')
  assert.equal(pending.status, 200)
  assert.deepEqual(pending.json.pending, [])
  await settle()
  assert.ok(!w.ws.aliceCoord.frames.some((f) => f.kind === 'consent'), 'no nudge either')
  for (const kind of ['contact', 'share']) {
    const r = await w.aliceCoord('/consent/answer', post({ convo_id: 'coord', kind, id: ask.json.contact.id, decision: 'approve', reason: 'looks fine' }))
    assert.equal(r.status, 400)
  }
  assert.equal((await w.alicePhone(`/contacts/${ask.json.contact.id}`)).json.contact.state, 'awaiting_user')
})

test('declining, withdrawing and blocking', async (t) => {
  const w = await world(t)
  // bob declines.
  const a = await w.alicePhone('/contacts', post({ user: 'bob' }))
  let bobSide = (await w.bobPhone('/contacts')).json.contacts[0]
  const mirror = (await w.bobPhone('/items?label=consent')).json.items[0]
  assert.equal((await w.bobPhone(`/items/${mirror.id}/comments`, post({ action: 'Decline' }))).status, 200)
  assert.equal((await w.alicePhone(`/contacts/${a.json.contact.id}`)).json.contact.state, 'declined')
  assert.deepEqual((await w.bobPhone('/contacts')).json.contacts, [], 'ended rows are not listed')

  // alice asks again and withdraws before bob answers: bob's card closes.
  assert.equal((await w.alicePhone('/contacts', post({ user: 'bob' }))).status, 201)
  const second = (await w.bobPhone('/items?label=consent&state=open')).json.items[0]
  assert.equal((await w.aliceBox(`/contacts/${a.json.contact.id}`, { method: 'DELETE' })).status, 200, 'an agent may withdraw')
  assert.equal((await w.bobPhone(`/items/${second.id}`)).json.item.state, 'closed')
  bobSide = (await w.bobPhone(`/contacts/${bobSide.id}`)).json.contact
  assert.equal(bobSide.state, 'removed')

  // bob blocks alice: alice's next request looks sent, and reaches nobody.
  assert.equal((await w.bobBox(`/contacts/${bobSide.id}/block`, post({}))).status, 200)
  const blocked = await w.alicePhone('/contacts', post({ user: 'bob' }))
  assert.equal(blocked.status, 201)
  assert.equal(blocked.json.pending, 'peer')
  assert.equal(blocked.json.contact.state, 'pending_out')
  assert.equal((await w.bobPhone(`/contacts/${bobSide.id}`)).json.contact.state, 'blocked')
  assert.equal((await w.bobPhone('/items?label=consent&state=open')).json.items.length, 0, 'no card reaches the blocker')
  // bob cannot ask while he blocks; only his phone unblocks.
  assert.equal((await w.bobPhone('/contacts', post({ user: 'alice' }))).json.blocked_by, 'blocked')
  assert.equal((await w.bobBox(`/contacts/${bobSide.id}/unblock`, post({}))).status, 403)
  // DELETE is not a way around that for an agent (or anyone).
  const sneak = await w.bobBox(`/contacts/${bobSide.id}`, { method: 'DELETE' })
  assert.equal(sneak.status, 409)
  assert.equal(sneak.json.blocked_by, 'blocked')
  assert.equal((await w.bobPhone(`/contacts/${bobSide.id}`)).json.contact.state, 'blocked')
  assert.equal((await w.bobPhone(`/contacts/${bobSide.id}/unblock`, post({}))).status, 200)
  // alice's request is still out: bob asking now crosses it, and both are active.
  const crossed = await w.bobPhone('/contacts', post({ user: 'alice' }))
  assert.equal(crossed.status, 201)
  assert.equal(crossed.json.contact.state, 'active')
  assert.equal((await w.alicePhone(`/contacts/${a.json.contact.id}`)).json.contact.state, 'active')
})

test('a read-only mission share: two yeses, a sieved view, live, and no writes', async (t) => {
  const w = await world(t)
  const mission = await makeMission(w)
  assert.equal((await w.aliceBox('/milestones', post({ convo_id: 'work', kind: 'progress', title: 'Plan agreed', body: 'Details.' }))).status, 201)
  const item = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'task', title: 'Book the hall', body: 'By Friday.' }))).json.item
  assert.equal((await w.aliceBox(`/items/${item.id}/comments`, post({ body: 'Called them.' }))).status, 201)

  // Not contacts yet: nothing can be shared.
  const early = await w.aliceBox(`/missions/${mission.num}/shares`, post({ contact: 'bob', convo_id: 'work' }))
  assert.equal(early.status, 409)
  assert.equal(early.json.blocked_by, 'not_contact')
  await makeContacts(w)
  // contribute and owner are test/contribute.test.js's and test/handover.test.js's;
  // owner (a hand-over, test/handover.test.js) needs its brief.
  assert.equal((await w.aliceBox(`/missions/${mission.num}/shares`, post({ contact: 'bob', level: 'owner', convo_id: 'work' }))).status, 400)
  for (const k of Object.keys(w.ws)) w.ws[k].frames.length = 0

  // alice's agent asks; alice gets the card with the preview of what crosses.
  const ask = await w.aliceBox(`/missions/${mission.num}/shares`, post({ contact: 'bob', level: 'read', convo_id: 'work' }))
  assert.equal(ask.status, 202)
  assert.equal(ask.json.grant.state, 'awaiting_owner')
  const gid = ask.json.grant.id
  await settle()
  const card = cards(w.ws.alicePhone, 'mission_share')[0]
  assert.equal(card.convo_id, 'work')
  assert.equal(card.payload.direction, 'out')
  assert.deepEqual(card.payload.preview, { milestones: 1, items: 1, comments: 1, attachments: 0 })
  assert.equal(cards(w.ws.aliceBox, 'mission_share').length, 0)
  // bob knows nothing yet: no grant, no mission, no card.
  assert.deepEqual((await w.bobPhone('/grants')).json.grants, [])
  assert.equal((await w.bobPhone(`/grants/${gid}`)).status, 404)
  assert.equal((await w.bobPhone(`/missions/${mission.id}`)).status, 404)
  assert.equal((await w.aliceBox(`/grants/${gid}/answer`, post({ decision: 'approve' }))).status, 403)
  assert.equal((await w.aliceCoord(`/grants/${gid}/answer`, post({ decision: 'approve' }))).status, 403)

  assert.equal((await w.alicePhone(`/grants/${gid}/answer`, post({ decision: 'approve' }))).json.grant.state, 'pending')
  await settle()
  const bobCard = cards(w.ws.bobPhone, 'mission_share')[0]
  assert.equal(bobCard.convo_id, peopleConvoId(w.s.db, w.bob.id))
  assert.equal(bobCard.payload.owner.name, 'alice')
  assert.equal(bobCard.payload.mission.title, 'Garden Club launch')
  assert.equal(cards(w.ws.bobBox, 'mission_share').length, 0)
  // Pending is not active: still unreadable.
  assert.equal((await w.bobPhone(`/missions/${mission.id}`)).status, 404)
  assert.equal((await w.bobBox(`/grants/${gid}/answer`, post({ decision: 'approve' }))).status, 403)

  const bobMirror = (await w.bobPhone('/items?label=consent&state=open')).json.items[0]
  assert.equal(bobMirror.consent, 'share')
  const tap = await w.bobPhone(`/items/${bobMirror.id}/comments`, post({ action: 'Accept' }))
  assert.equal(tap.status, 200)
  assert.equal(tap.json.grant.state, 'active')
  await settle()
  assert.ok(w.ws.bobPhone.frames.some((f) => f.kind === 'shared' && f.event === 'mission_added' && f.mission_id === mission.id))

  // bob's view: "shared by alice", and nothing that names a conversation,
  // a device or a project.
  const list = (await w.bobPhone('/missions?scope=shared')).json.missions
  assert.equal(list.length, 1)
  assert.equal(list[0].id, mission.id)
  assert.deepEqual(list[0].owner.name, 'alice')
  assert.equal(list[0].shared_via, 'grant')
  assert.deepEqual(list[0].grant, { id: gid, level: 'read' })
  assert.equal(list[0].origin_convo_id, '')
  assert.equal(list[0].project_id, null)
  assert.equal(list[0].conversations, 0)
  const detail = (await w.bobPhone(`/missions/${mission.id}`)).json
  assert.equal(detail.mission.title, 'Garden Club launch')
  assert.deepEqual(detail.conversations, [])
  assert.deepEqual(detail.milestones.map((m) => m.title), ['Plan agreed'])
  assert.deepEqual(Object.keys(detail.milestones[0]).sort(), ['body', 'created_at', 'created_by', 'id', 'kind', 'mission_id', 'num', 'title'])
  assert.deepEqual(detail.items.map((i) => i.title), ['Book the hall'], 'the consent mirror on the mission is not listed')
  const shownItem = (await w.bobPhone(`/items/${item.id}`)).json
  assert.equal(shownItem.item.shared_via, 'grant')
  assert.equal(shownItem.item.origin_convo_id, '')
  assert.equal(shownItem.item.owner.name, 'alice')
  assert.deepEqual(shownItem.comments.map((c) => [c.body, c.device_id]), [['Called them.', 0]])
  assert.ok((await w.bobPhone('/items?scope=shared')).json.items.some((i) => i.id === item.id))
  // bob's agent reads the same view; the lookup resolves alice's number.
  assert.equal((await w.bobBox(`/missions/${mission.id}`)).json.mission.shared_via, 'grant')
  assert.equal((await w.bobBox(`/lookup?user=alice&num=${mission.num}`)).json.id, mission.id)

  // Transcripts never cross (spec decision 6).
  assert.equal((await w.bobPhone('/convo/work/messages?around_seq=1')).status, 404)
  assert.equal((await w.bobPhone('/milestones?convo=work')).status, 404)

  // Read-only: every write is refused.
  assert.equal((await w.bobPhone(`/missions/${mission.id}`, { method: 'PATCH', body: { title: 'mine now' } })).status, 403)
  assert.equal((await w.bobPhone(`/missions/${mission.id}/close`, post({ summary: 'x' }))).status, 403)
  assert.equal((await w.bobPhone(`/items/${item.id}/comments`, post({ body: 'hello' }))).status, 403)
  assert.equal((await w.bobPhone(`/items/${item.id}/close`, post({ resolution: 'done' }))).status, 403)
  assert.equal((await w.bobPhone(`/missions/${mission.id}/shares`, post({ contact: 'alice' }))).status, 404, 'a grantee cannot share it on')

  // Live: each write on alice's side reaches bob's phone, never bob's box.
  w.ws.bobPhone.frames.length = 0
  await w.aliceBox('/milestones', post({ convo_id: 'work', kind: 'progress', title: 'Hall booked' }))
  await w.aliceBox(`/items/${item.id}/comments`, post({ body: 'Deposit paid.' }))
  await w.aliceBox(`/missions/${mission.id}`, { method: 'PATCH', body: { status: 'On track.', convo_id: 'work' } })
  await settle()
  const live = w.ws.bobPhone.frames.filter((f) => f.kind === 'shared' && f.event === 'mission_changed')
  assert.deepEqual(live.map((f) => f.what), ['milestone', 'item', 'mission'])
  assert.deepEqual(live[0].owner, { user_id: w.alice.id, name: 'alice' })
  assert.equal(w.ws.bobBox.frames.filter((f) => f.kind === 'shared').length, 0)
  const after = (await w.bobPhone(`/missions/${mission.id}`)).json
  assert.deepEqual(after.milestones.map((m) => m.title), ['Hall booked', 'Plan agreed'])
  assert.equal(after.mission.status, 'On track.')

  // Sharing again is not an error.
  const twice = await w.alicePhone(`/missions/${mission.id}/shares`, post({ contact: 'bob' }))
  assert.equal(twice.status, 200)
  assert.equal(twice.json.existing, true)
  assert.equal((await w.alicePhone(`/missions/${mission.id}/shares`)).json.grants.length, 1)
  assert.deepEqual((await w.bobPhone('/grants?direction=in')).json.grants.map((g) => [g.id, g.direction, g.state]), [[gid, 'in', 'active']])

  assert.deepEqual(audits(w.ws.alicePhone), ['grant.offered', 'grant.accepted'])
})

test('either side revokes, and the mission is gone at once', async (t) => {
  const w = await world(t)
  const mission = await makeMission(w)
  const { aliceContact } = await makeContacts(w)
  const share = async () => {
    const r = await w.alicePhone(`/missions/${mission.id}/shares`, post({ contact: 'bob' }))
    assert.equal(r.status, 201, 'a client share goes straight to the grantee')
    assert.equal((await w.bobPhone(`/grants/${r.json.grant.id}/answer`, post({ decision: 'approve' }))).status, 200)
    assert.equal((await w.bobPhone(`/missions/${mission.id}`)).status, 200)
    return r.json.grant.id
  }

  // The owner revokes — from an agent, which may reduce access.
  let gid = await share()
  w.ws.bobPhone.frames.length = 0
  const rev = await w.aliceBox(`/grants/${gid}`, { method: 'DELETE' })
  assert.equal(rev.status, 200)
  assert.equal(rev.json.grant.state, 'revoked')
  assert.equal(rev.json.grant.revoked_by, 'owner')
  assert.equal((await w.bobPhone(`/missions/${mission.id}`)).status, 404)
  assert.deepEqual((await w.bobPhone('/missions?scope=shared')).json.missions, [])
  await settle()
  assert.ok(w.ws.bobPhone.frames.some((f) => f.kind === 'shared' && f.event === 'mission_removed' && f.mission_id === mission.id))
  assert.ok(audits(w.ws.bobPhone).includes('grant.revoked'))
  assert.equal((await w.aliceBox(`/grants/${gid}`, { method: 'DELETE' })).json.blocked_by, 'not_active')

  // The grantee leaves.
  gid = await share()
  const left = await w.bobPhone(`/grants/${gid}`, { method: 'DELETE' })
  assert.equal(left.json.grant.revoked_by, 'grantee')
  assert.equal((await w.bobPhone(`/missions/${mission.id}`)).status, 404)

  // Removing the contact revokes every grant between the two.
  gid = await share()
  assert.equal((await w.alicePhone(`/contacts/${aliceContact}`, { method: 'DELETE' })).status, 200)
  assert.equal((await w.bobPhone(`/missions/${mission.id}`)).status, 404)
  const ended = (await w.alicePhone('/grants?direction=out&state=revoked')).json.grants.find((g) => g.id === gid)
  assert.equal(ended.revoked_by, 'contact_removed')
  assert.equal((await w.alicePhone(`/missions/${mission.id}/shares`, post({ contact: 'bob' }))).json.blocked_by, 'not_contact')
  const trail = (await w.alicePhone(`/contacts/${aliceContact}/activity`)).json.events.map((e) => e.event)
  assert.equal(trail[0], 'grant.revoked')
  assert.ok(trail.includes('contact.removed'))
})

test('a failure to reach the other person never fails the request that made the contact or share', async (t) => {
  const w = await world(t)
  // bob's People conversation cannot be created: the card, its mirror and
  // the audit line are all lost, and each is logged instead of thrown.
  w.s.db.exec(`CREATE TRIGGER no_people BEFORE INSERT ON conversations WHEN NEW.system IS NOT NULL AND NEW.owner_user_id = ${Number(w.bob.id)}
    BEGIN SELECT RAISE(ABORT, 'no people conversation today'); END`)
  const quiet = t.mock.method(console, 'error', () => {})
  const r = await w.alicePhone('/contacts', post({ user: 'bob' }))
  assert.equal(r.status, 201)
  assert.equal(r.json.contact.state, 'pending_out')
  assert.ok(quiet.mock.callCount() > 0, 'the failure is logged')
  assert.equal(peopleConvoId(w.s.db, w.bob.id), null)
  // The request stands and bob can still answer it from his list.
  const bobSide = (await w.bobPhone('/contacts')).json.contacts[0]
  assert.equal(bobSide.state, 'pending_in')
  assert.equal((await w.bobPhone(`/contacts/${bobSide.id}/answer`, post({ decision: 'approve' }))).status, 200)
  const m = await makeMission(w)
  const share = await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'read' }))
  assert.equal(share.status, 201)
  assert.equal(share.json.grant.state, 'pending')
  assert.equal(share.json.grant.contact_id, r.json.contact.id)
  const offered = (await w.bobPhone('/grants?direction=in')).json.grants[0]
  assert.equal(offered.id, share.json.grant.id)
  assert.equal('contact_id' in offered, false)
  assert.equal((await w.bobPhone(`/grants/${offered.id}/answer`, post({ decision: 'approve' }))).status, 200)
  assert.equal((await w.bobPhone(`/missions/${m.id}`)).status, 200)
})

test('the People conversation belongs to no agent', async (t) => {
  const w = await world(t)
  await w.alicePhone('/contacts', post({ user: 'bob' }))
  const people = peopleConvoId(w.s.db, w.bob.id)
  // Listed for bob's phone, marked as the journal's own; not for his box.
  const phoneSnap = (await w.bobPhone('/snapshot')).json.conversations.find((c) => c.id === people)
  assert.equal(phoneSnap.system, 'people')
  assert.equal(phoneSnap.title, 'People')
  assert.ok(!(await w.bobBox('/snapshot')).json.conversations.some((c) => c.id === people))
  assert.ok(!(await w.bobBox('/roster')).json.conversations.some((c) => c.id === people))
  // An agent can neither adopt it nor publish into it.
  w.ws.bobBox.frames.length = 0
  w.ws.bobBox.send({ op: 'convo_upsert', convo_id: people, title: 'mine' })
  w.ws.bobBox.send({ op: 'publish', convo_id: people, type: 'text', payload: { body: 'hi' }, local_id: 'x1' })
  await settle()
  assert.equal(w.ws.bobBox.frames.filter((f) => f.op === 'error').length, 2)
  assert.equal(w.s.db.prepare('SELECT title, agent_device_id FROM conversations WHERE id=?').get(people).agent_device_id, null)
  assert.equal((await w.bobBox('/items', post({ convo_id: people, kind: 'task', title: 'x' }))).status, 404)
  // And an agent cannot forge either card anywhere.
  for (const kind of ['contact_request', 'mission_share']) {
    w.ws.bobBox.frames.length = 0
    w.ws.bobBox.send({ op: 'publish', convo_id: 'bobwork', type: 'permission_request', payload: { kind }, local_id: `f-${kind}` })
    await settle()
    assert.equal(w.ws.bobBox.frames.filter((f) => f.op === 'error').length, 1, `${kind} is server-minted only`)
  }
  // A fresh socket's replay hands the agent none of it.
  // A replay from the start hands a client its People conversation, and a
  // box none of it.
  const second = (await w.s.http('/login', { method: 'POST', body: { username: 'bob', password: 'pw', device_name: 'bob-second' } })).json.token
  const freshPhone = await makeWsClient(w.s.base, { token: second, cursor: 0 })
  const freshBox = await makeWsClient(w.s.base, { token: createAgent(w.s.db, w.bob.id, 'bob-box-2').token, cursor: 0 })
  t.after(() => { freshPhone.close(); freshBox.close() })
  for (const c of [freshPhone, freshBox]) await c.waitFor((f) => f.op === 'hello_ok')
  await settle()
  assert.ok(freshPhone.journal().some((f) => f.convo_id === people))
  assert.ok(!freshBox.journal().some((f) => f.convo_id === people))
})
