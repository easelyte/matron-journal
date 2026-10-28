import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'

// Starting a session on a handed-over mission (docs/protocol.md "Hand-over"):
// the recipient's accept can also start a new session on one of their boxes,
// with the copy as its mission and the brief as its first reading — the same
// journal-started "New session" spawn a talk request uses, with the same
// rules. The accept tap is the consent; no spawn card is asked for.
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const post = (body) => ({ method: 'POST', body })
const BRIEF = 'Where it stands: the hall is booked. Next: the invitations.'

// alice has a box. bob has a box, a Coordinator box and a private box.
async function world(t, { coordinator = true } = {}) {
  const s = await startTestServer({ spawnStartTimeoutMs: 1500 })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const bob = await createUser(s.db, 'bob', 'pw')
  const aliceBox = createAgent(s.db, alice.id, 'alice-box')
  const bobBox = createAgent(s.db, bob.id, 'bob-box')
  const bobCoord = createAgent(s.db, bob.id, 'bob-coord')
  const bobPriv = createAgent(s.db, bob.id, 'bob-private')
  pinDevicePrivate(s.db, bobPriv.deviceId, true)
  upsertConversation(s.db, { id: 'work', ownerUserId: alice.id, title: 'Garden Club', agentDeviceId: aliceBox.deviceId })
  upsertConversation(s.db, { id: 'bobwork', ownerUserId: bob.id, title: 'Bob', agentDeviceId: bobBox.deviceId })
  upsertConversation(s.db, { id: 'bobcoord', ownerUserId: bob.id, title: 'Coordinator', agentDeviceId: bobCoord.deviceId })
  const login = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: `${name}-phone` } })).json.token
  const tokens = { alicePhone: await login('alice'), bobPhone: await login('bob'), aliceBox: aliceBox.token, bobBox: bobBox.token, bobCoord: bobCoord.token, bobPriv: bobPriv.token }
  if (coordinator) assert.equal((await s.http('/coordinator', { method: 'PUT', token: tokens.bobPhone, body: { convo_id: 'bobcoord' } })).status, 200)
  const ws = {}
  for (const k of ['bobPhone', 'bobBox', 'bobCoord', 'bobPriv']) {
    ws[k] = await makeWsClient(s.base, { token: tokens[k], cursor: null })
    await ws[k].waitFor((f) => f.op === 'hello_ok')
  }
  t.after(() => { for (const x of Object.values(ws)) { try { x.close() } catch { /* closed */ } } })
  const http = (token) => (p, opts = {}) => s.http(p, { token, ...opts })
  const w = {
    s, alice, bob, ws, tokens, ids: { aliceBox: aliceBox.deviceId, bobBox: bobBox.deviceId, bobCoord: bobCoord.deviceId, bobPriv: bobPriv.deviceId },
    aliceBox: http(tokens.aliceBox), alicePhone: http(tokens.alicePhone), bobPhone: http(tokens.bobPhone),
  }
  const r = await w.alicePhone('/contacts', post({ user: 'bob' }))
  const theirs = (await w.bobPhone('/contacts')).json.contacts[0]
  await w.bobPhone(`/contacts/${theirs.id}/answer`, post({ decision: 'approve' }))
  w.aliceContact = r.json.contact.id
  return w
}

// alice hands a mission to bob from her phone; bob's card is waiting.
async function offered(w) {
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Garden Club launch' }))).json.mission
  const g = (await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF }))).json.grant
  await settle()
  const card = w.ws.bobPhone.journal().find((f) => f.type === 'permission_request' && f.payload.kind === 'mission_handover')
  const mirror = (await w.bobPhone('/items?label=consent&state=open')).json.items.find((i) => i.consent === 'handover')
  return { m, g, card, mirror }
}

// The start RPC a box received, answered with `reply`.
async function startRpc(sock, reply) {
  const rpc = await sock.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start', 3000)
  sock.send({ op: 'agent_response', request_id: rpc.request.request_id, to_device_id: 0, ...reply })
  return rpc.request
}

test('the in card offers the talk request\'s choices: a new session on the Coordinator\'s box, or a box to pick', async (t) => {
  const w = await world(t)
  const { card, mirror } = await offered(w)
  assert.deepEqual(card.payload.choices, ['Accept', 'New session', 'Pick a box', 'Decline'])
  assert.deepEqual(mirror.actions, card.payload.choices)
  // The boxes "Pick a box" offers: bob's own, never a private one.
  assert.deepEqual(Object.entries(card.payload.pick_options).sort(), [['bob-box', w.ids.bobBox], ['bob-coord', w.ids.bobCoord]])
})

test('without a Coordinator there is no New session button', async (t) => {
  const w = await world(t, { coordinator: false })
  const { card } = await offered(w)
  assert.deepEqual(card.payload.choices, ['Accept', 'Pick a box', 'Decline'])
})

test('New session: the accept makes the copy and starts a session on the Coordinator\'s box, on the copy, told to read the brief', async (t) => {
  const w = await world(t)
  const { mirror } = await offered(w)
  const tap = await w.bobPhone(`/items/${mirror.id}/comments`, post({ action: 'New session' }))
  assert.equal(tap.status, 200)
  assert.equal(tap.json.grant.state, 'active')
  assert.deepEqual(tap.json.start_session, { status: 'starting', device_id: w.ids.bobCoord })
  const copy = (await w.bobPhone(`/missions/${tap.json.grant.copy_id}`)).json.mission
  const req = await startRpc(w.ws.bobCoord, { ok: true, result: { convo_id: 'handed-child' } })
  assert.equal(req.from_device_id, 0)
  assert.equal(req.params.agent, 'claude')
  assert.equal(req.params.workdir, '')
  assert.equal(req.params.talk, true, 'the bridge starts an empty workdir in the box default only on this flag')
  assert.equal(req.params.mission_num, copy.num)
  assert.match(req.params.prompt, /handed over by alice/i)
  assert.match(req.params.prompt, new RegExp(`mission #${copy.num}`))
  assert.match(req.params.prompt, /brief/)
  assert.match(req.params.prompt, /first milestone/)
  await settle()
  const missions = (await w.bobPhone('/conversations/handed-child/missions')).json.missions
  assert.deepEqual(missions.map((m) => [m.id, m.current]), [[copy.id, true]])
  assert.equal(w.s.db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get('handed-child').agent_device_id, w.ids.bobCoord)
  const thread = (await w.bobPhone(`/items/${mirror.id}`)).json.comments
  assert.match(thread.at(-1).body, /Started a new session on bob-coord/)
  // No spawn card: bob's tap was the consent.
  assert.equal(w.ws.bobPhone.journal().filter((f) => f.type === 'permission_request' && f.payload.kind === 'agent_spawn').length, 0)
})

test('Pick a box: a follow-up offers bob\'s boxes; the pick accepts and starts there', async (t) => {
  const w = await world(t)
  const { mirror } = await offered(w)
  const pick = await w.bobPhone(`/items/${mirror.id}/comments`, post({ action: 'Pick a box' }))
  assert.equal(pick.status, 200)
  assert.equal(pick.json.item.state, 'open', 'nothing is decided yet')
  assert.deepEqual([...pick.json.comment.actions].sort(), ['Decline', 'bob-box', 'bob-coord'])
  assert.equal((await w.bobPhone(`/grants/${mirror.links[0].url.split('/').pop()}`)).json.grant.state, 'pending')
  // Only the journal's own question's labels are taps.
  assert.equal((await w.bobPhone(`/items/${mirror.id}/comments`, post({ action: 'bob-private', reply_to: pick.json.comment.id }))).status, 400)
  const chosen = await w.bobPhone(`/items/${mirror.id}/comments`, post({ action: 'bob-box', reply_to: pick.json.comment.id }))
  assert.equal(chosen.status, 200)
  assert.equal(chosen.json.grant.state, 'active')
  assert.deepEqual(chosen.json.start_session, { status: 'starting', device_id: w.ids.bobBox })
  await startRpc(w.ws.bobBox, { ok: true, result: { convo_id: 'picked-child' } })
  await settle()
  assert.equal((await w.bobPhone('/conversations/picked-child/missions')).json.missions[0].id, chosen.json.grant.copy_id)
})

test('over HTTP the recipient may name any box of theirs, a private one included, and a folder', async (t) => {
  const w = await world(t)
  const { g } = await offered(w)
  const r = await w.bobPhone(`/grants/${g.id}/answer`, post({ decision: 'approve', start_session: { device_id: w.ids.bobPriv, workdir: '/srv/club' } }))
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.start_session, { status: 'starting', device_id: w.ids.bobPriv })
  const req = await startRpc(w.ws.bobPriv, { ok: true, result: { convo_id: 'private-child' } })
  assert.equal(req.params.workdir, '/srv/club')
  assert.equal(req.params.talk, undefined, 'a named folder is an ordinary spawn')
})

test('refusals stay graceful: the copy is made and the answer says why no session started', async (t) => {
  const w = await world(t)
  // Not one of bob's boxes.
  const first = await offered(w)
  const r = await w.bobPhone(`/grants/${first.g.id}/answer`, post({ decision: 'approve', start_session: { device_id: w.ids.aliceBox } }))
  assert.equal(r.status, 200)
  assert.equal(r.json.grant.state, 'active')
  assert.deepEqual(r.json.start_session, { status: 'refused', reason: 'not_your_box' })
  assert.equal((await w.bobPhone(`/missions/${r.json.grant.copy_id}`)).status, 200)
  // A box that fails to start: bob is told on the card, and the copy stands.
  const second = await offered(w)
  const tap = await w.bobPhone(`/items/${second.mirror.id}/comments`, post({ action: 'New session' }))
  assert.equal(tap.json.grant.state, 'active')
  await startRpc(w.ws.bobCoord, { ok: false, error: { code: 'bad_workdir' } })
  await settle()
  assert.match((await w.bobPhone(`/items/${second.mirror.id}`)).json.comments.at(-1).body, /Couldn't start a session: bad_workdir/)
  assert.equal((await w.bobPhone(`/missions/${tap.json.grant.copy_id}`)).status, 200)
  // A malformed ask is a 400 and nothing happens.
  const third = await offered(w)
  assert.equal((await w.bobPhone(`/grants/${third.g.id}/answer`, post({ decision: 'approve', start_session: { device_id: 'x' } }))).status, 400)
  assert.equal((await w.bobPhone(`/grants/${third.g.id}`)).json.grant.state, 'pending')
  // An agent cannot start one for bob.
  const agent = await w.s.http(`/grants/${third.g.id}/answer`, { method: 'POST', token: w.tokens.bobCoord, body: { decision: 'approve', start_session: { device_id: w.ids.bobCoord } } })
  assert.equal(agent.status, 403)
})

test('a start reply that names no fresh session of bob\'s on that box joins nothing', async (t) => {
  const w = await world(t)
  // The People conversation: bob's own, but no box's session.
  const people = w.s.db.prepare("SELECT id FROM conversations WHERE owner_user_id=? AND system='people'").get(w.bob.id)
  for (const convoId of [people?.id, 'bobwork']) {
    assert.ok(convoId)
    w.ws.bobCoord.frames.length = 0
    const { mirror } = await offered(w)
    const tap = await w.bobPhone(`/items/${mirror.id}/comments`, post({ action: 'New session' }))
    assert.equal(tap.json.grant.state, 'active')
    await startRpc(w.ws.bobCoord, { ok: true, result: { convo_id: convoId } })
    await settle()
    assert.match((await w.bobPhone(`/items/${mirror.id}`)).json.comments.at(-1).body, /Couldn't start a session: bad_start_reply/, convoId)
    const linked = (await w.bobPhone(`/conversations/${convoId}/missions`)).json.missions ?? []
    assert.ok(!linked.some((m) => m.id === tap.json.grant.copy_id), `${convoId} is not put on the copy`)
  }
})

test('Pick a box on a card already answered is a conflict, and offers nothing', async (t) => {
  const w = await world(t)
  const { g, mirror } = await offered(w)
  assert.equal((await w.bobPhone(`/grants/${g.id}/answer`, post({ decision: 'approve' }))).status, 200)
  const r = await w.bobPhone(`/items/${mirror.id}/comments`, post({ action: 'Pick a box' }))
  assert.equal(r.status, 409)
  assert.equal(r.json.blocked_by, 'not_pending')
  assert.equal(w.s.db.prepare('SELECT pick_options FROM grants WHERE id=?').get(g.id).pick_options, null)
})
