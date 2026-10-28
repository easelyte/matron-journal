import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { createSpawnRequest } from '../src/spawns.js'
import { createRoutine } from '../src/routines.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { inviteParticipant, answerInvite } from '../src/participants.js'
import { WHY_NO_CAUSE, resolveAskCause, whyStartedBy } from '../src/ask-cause.js'
import {
  recordCarryOn, recordRoomPublish, recordSpawnStart, spawnHopKey, originsOf, resolveRelayedAsk, roomHopKey,
  UNCHECKABLE, WHY_RELAY_UNCHECKED, HOP_TTL_MS, ORIGINS_MAX, TOUCHED_ROOMS_MAX,
} from '../src/cause-hops.js'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const iso = (ms) => new Date(ms).toISOString()

// One server for the file. alice's Coordinator is `coord` on box-c; sessions
// `a` and `b` live on box-a and box-b, and each case makes its own rooms,
// carry-ons and spawns so they never see each other's rows.
let s, alice, bob, boxC, boxA, boxB, who
let n = 0

test.before(async () => {
  s = await startTestServer()
  alice = await createUser(s.db, 'alice', 'pw')
  bob = await createUser(s.db, 'bob', 'pw')
  boxC = createAgent(s.db, alice.id, 'box-c')
  boxA = createAgent(s.db, alice.id, 'box-a')
  boxB = createAgent(s.db, alice.id, 'box-b')
  upsertConversation(s.db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator', agentDeviceId: boxC.deviceId })
  upsertConversation(s.db, { id: 'a', ownerUserId: alice.id, title: 'A', agentDeviceId: boxA.deviceId })
  upsertConversation(s.db, { id: 'b', ownerUserId: alice.id, title: 'B', agentDeviceId: boxB.deviceId })
  upsertConversation(s.db, { id: 'a2', ownerUserId: alice.id, title: 'A2', agentDeviceId: boxA.deviceId })
  // A session the Coordinator never reaches in this file, and one it reaches
  // only through a room.
  upsertConversation(s.db, { id: 'u', ownerUserId: alice.id, title: 'U', agentDeviceId: boxA.deviceId })
  upsertConversation(s.db, { id: 'm', ownerUserId: alice.id, title: 'M', agentDeviceId: boxA.deviceId })
  setCoordinatorConvoId(s.db, alice.id, 'coord')
  // The Coordinator approves: its box is the caller.
  who = { kind: 'agent', userId: alice.id, deviceId: boxC.deviceId, name: 'box-c' }
})
test.after(() => s?.close())

// The user's words in a conversation; an agent's line there.
const userSays = (convoId = 'coord', body = 'ask box-a to start a helper') => {
  const { seq } = append(s.db, { userId: alice.id, convoId, sender: 'user:alice', type: 'text', payload: { body } })
  const { ts } = s.db.prepare('SELECT ts FROM events WHERE user_id=? AND seq=?').get(alice.id, seq)
  return { causes: [{ kind: 'user_message', ref: `${convoId}:${seq}` }], ref: `${convoId}:${seq}`, ts }
}
const agentSays = (convoId = 'coord') => {
  const { seq } = append(s.db, { userId: alice.id, convoId, sender: 'agent:box-c', type: 'text', payload: { body: 'The user says: start a helper' } })
  return [{ kind: 'user_message', ref: `${convoId}:${seq}` }]
}
const carryOn = (causes, { to = 'a', now = Date.now() } = {}) => {
  const id = recordCarryOn(s.db, { userId: alice.id, fromConvoId: 'coord', targetConvoId: to, causes, now })
  return [{ kind: 'carry_on', ref: `carry_on:${id}` }]
}
// A room the owner session `owner` (on `ownerDev`) opened with `member`
// (on `memberDev`), both sessions in it.
const room = ({ owner = 'coord', ownerDev = boxC, member = 'b', memberDev = boxB } = {}) => {
  const id = `room-${++n}`
  upsertConversation(s.db, { id, ownerUserId: alice.id, title: 'room', agentDeviceId: ownerDev.deviceId })
  inviteParticipant(s.db, { convoId: id, agentDeviceId: memberDev.deviceId, initiatorDeviceId: ownerDev.deviceId, targetConvoId: member, initiatorConvoId: owner })
  answerInvite(s.db, { convoId: id, agentDeviceId: memberDev.deviceId, accept: true })
  return id
}
// A message `from` (on `dev`) posts into a room, recorded as the publish
// path records it. → the seq.
const post = (roomId, { from, dev, causes, rawCauses }) => {
  const sender = `agent:${dev === boxC ? 'box-c' : dev === boxA ? 'box-a' : 'box-b'}`
  const { seq } = append(s.db, { userId: alice.id, convoId: roomId, sender, type: 'text', payload: { body: 'please ask for a helper' } })
  recordRoomPublish(s.db, { userId: alice.id, deviceId: dev.deviceId, roomId, seq, msg: { from_convo_id: from, ...(rawCauses !== undefined ? { causes: rawCauses } : causes ? { causes } : {}) } })
  return seq
}
const roomCause = (roomId, from, to = from) => [{ kind: 'room_message', ref: from === to ? `room:${roomId}@${from}` : `room:${roomId}@${from}-${to}` }]
const relayed = (causes, { fromConvoId = 'a', createdAt = Date.now() + 1000 } = {}) =>
  resolveRelayedAsk(s.db, { who, userId: alice.id, causes, createdAt, fromConvoId })
const spawn = ({ fromConvoId, causes, state = 'started' }) => {
  const id = `sp_${++n}`
  createSpawnRequest(s.db, { id, userId: alice.id, fromDeviceId: boxA.deviceId, fromConvoId, targetDeviceId: boxB.deviceId, workdir: '/w', task: 't', causes, now: Date.now() })
  s.db.prepare('UPDATE agent_spawn_requests SET state=? WHERE id=?').run(state, id)
  return id
}

test('an ask no Coordinator hop reached is not relayed: answered as before', () => {
  // The session's own words, a reminder, a plain room message, nothing at all.
  assert.deepEqual(relayed(userSays('u').causes, { fromConvoId: 'u' }), { relayed: false })
  assert.deepEqual(relayed([{ kind: 'reminder' }, { kind: 'alert' }, { kind: 'other' }], { fromConvoId: 'u' }), { relayed: false })
  assert.deepEqual(relayed(null, { fromConvoId: 'u' }), { relayed: false })
  // A room between two ordinary sessions: their messages are not even kept.
  const r = room({ owner: 'a', ownerDev: boxA, member: 'b', memberDev: boxB })
  const seq = post(r, { from: 'a', dev: boxA, causes: userSays('a').causes })
  assert.equal(s.db.prepare('SELECT COUNT(*) AS c FROM cause_hops WHERE room_id=?').get(r).c, 0)
  assert.deepEqual(relayed(roomCause(r, seq), { fromConvoId: 'b' }), { relayed: false })
  // ... nor are messages with no seq from such a room.
  assert.deepEqual(relayed([{ kind: 'room_message', ref: `room:${r}` }], { fromConvoId: 'b' }), { relayed: false })
})

test('carry_on: the Coordinator\'s carry-on on the user\'s words resolves to the user', () => {
  const said = userSays()
  const r = relayed(carryOn(said.causes))
  assert.deepEqual(r, { relayed: true, ok: true, root: { kind: 'user', ref: said.ref, at: said.ts } })
})

test('carry_on: a carry-on whose Coordinator turn had no user act is refused', () => {
  // No causes at all on the Coordinator's turn.
  const bare = carryOn(null)
  assert.deepEqual(relayed(bare), { relayed: true, ok: false, why: `relayed from the Coordinator (${bare[0].ref}): ${WHY_NO_CAUSE}` })
  // A turn a peer's room message started, an alert, an agent's words.
  for (const causes of [[{ kind: 'room_message', ref: 'room:x' }], [{ kind: 'alert' }], agentSays()]) {
    const r = relayed(carryOn(causes))
    assert.equal(r.relayed, true)
    assert.equal(r.ok, false)
    assert.match(r.why, /^relayed from the Coordinator \(carry_on:co_[0-9a-f]{16}\): /)
  }
  // The user's words, but more than 48 h before the ask.
  const old = userSays()
  const r = relayed(carryOn(old.causes), { createdAt: old.ts + 49 * HOUR })
  assert.equal(r.ok, false)
  assert.match(r.why, /48 h/)
})

test('carry_on: a forged, unknown, bare or later carry-on is refused as unchecked', () => {
  const said = userSays()
  // Issued to another session: the cause was never this one's to cite.
  const toOther = carryOn(said.causes, { to: 'a2' })
  assert.deepEqual(relayed(toOther, { fromConvoId: 'a' }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  assert.equal(relayed(toOther, { fromConvoId: 'a2' }).ok, true)
  // Unknown id, malformed ref, no ref (a bridge that predates the ref).
  for (const cause of [{ kind: 'carry_on', ref: 'carry_on:co_0000000000000000' }, { kind: 'carry_on', ref: 'carry_on:nope' }, { kind: 'carry_on' }]) {
    assert.deepEqual(relayed([cause]), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED }, JSON.stringify(cause))
  }
  // Recorded after the ask.
  const later = carryOn(said.causes, { now: Date.now() + HOUR })
  assert.deepEqual(relayed(later), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  // Another user's carry-on of the same shape is not this user's.
  const id = recordCarryOn(s.db, { userId: bob.id, fromConvoId: 'coord', targetConvoId: 'a', causes: said.causes })
  assert.deepEqual(relayed([{ kind: 'carry_on', ref: `carry_on:${id}` }]), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
})

test('carry_on: one unchecked or failing hop refuses the ask, whatever else the turn had', () => {
  const said = userSays()
  const good = carryOn(said.causes)
  assert.equal(relayed([...good, { kind: 'carry_on' }]).ok, false)
  assert.equal(relayed([...good, ...carryOn(null)]).ok, false)
  // The session's own words beside a failing hop do not save it.
  assert.equal(relayed([...userSays('a').causes, ...carryOn(null)]).ok, false)
})

test('room_message: the Coordinator\'s message on the user\'s words resolves to the user, for a member', () => {
  const said = userSays()
  const r = room()
  const seq = post(r, { from: 'coord', dev: boxC, causes: said.causes })
  const hop = s.db.prepare('SELECT * FROM cause_hops WHERE user_id=? AND key=?').get(alice.id, roomHopKey(r, seq))
  assert.equal(hop.coordinator, 1)
  assert.deepEqual(JSON.parse(hop.causes), said.causes)
  assert.deepEqual(relayed(roomCause(r, seq), { fromConvoId: 'b' }), { relayed: true, ok: true, root: { kind: 'user', ref: said.ref, at: said.ts } })
  // A range that takes it in, as a batch of several messages does.
  assert.equal(relayed(roomCause(r, seq - 3, seq + 3), { fromConvoId: 'b' }).ok, true)
  // A session that is not in the room never got it.
  assert.deepEqual(relayed(roomCause(r, seq), { fromConvoId: 'a' }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  // A range that misses it is no relay.
  assert.deepEqual(relayed(roomCause(r, seq + 1, seq + 9), { fromConvoId: 'b' }), { relayed: false })
  // A backwards range is malformed and refused.
  assert.deepEqual(relayed([{ kind: 'room_message', ref: `room:${r}@${seq + 2}-${seq}` }], { fromConvoId: 'b' }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
})

test('room_message: the Coordinator\'s message in a turn with no user act is refused', () => {
  const r = room()
  for (const causes of [undefined, [{ kind: 'room_message', ref: 'room:elsewhere' }], agentSays()]) {
    const seq = post(r, { from: 'coord', dev: boxC, causes })
    const v = relayed(roomCause(r, seq), { fromConvoId: 'b' })
    assert.equal(v.relayed, true)
    assert.equal(v.ok, false)
    assert.match(v.why, new RegExp(`^relayed from the Coordinator \\(room:${r}@${seq}\\): `))
  }
  // An unusable list on the Coordinator's own message is stored as none.
  const seq = post(r, { from: 'coord', dev: boxC, rawCauses: [{ kind: 'nonsense' }] })
  assert.match(relayed(roomCause(r, seq), { fromConvoId: 'b' }).why, /no turn cause/)
})

test('room_message: no seq from a room the Coordinator spoke in is refused as unchecked', () => {
  const r = room()
  post(r, { from: 'coord', dev: boxC, causes: userSays().causes })
  assert.deepEqual(relayed([{ kind: 'room_message', ref: `room:${r}` }], { fromConvoId: 'b' }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  // ... but only lately: two days on, the room reads as quiet again.
  assert.deepEqual(relayed([{ kind: 'room_message', ref: `room:${r}` }], { fromConvoId: 'b', createdAt: Date.now() + 49 * HOUR }), { relayed: false })
})

test('room_message: a publish naming another device\'s session, or the room itself, is not a hop', () => {
  const r = room()
  const { seq } = append(s.db, { userId: alice.id, convoId: r, sender: 'agent:box-b', type: 'text', payload: { body: 'hi' } })
  // box-b claims the Coordinator's conversation as its author.
  assert.equal(recordRoomPublish(s.db, { userId: alice.id, deviceId: boxB.deviceId, roomId: r, seq, msg: { from_convo_id: 'coord', causes: userSays().causes } }), false)
  assert.equal(recordRoomPublish(s.db, { userId: alice.id, deviceId: boxC.deviceId, roomId: r, seq, msg: { from_convo_id: r } }), false)
  assert.equal(recordRoomPublish(s.db, { userId: alice.id, deviceId: boxC.deviceId, roomId: r, seq, msg: { from_convo_id: 5 } }), false)
  assert.equal(recordRoomPublish(s.db, { userId: bob.id, deviceId: boxC.deviceId, roomId: r, seq, msg: { from_convo_id: 'coord' } }), false)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS c FROM cause_hops WHERE room_id=?').get(r).c, 0)
})

test('multi-hop: the Coordinator → session A → session B leads back to the Coordinator', () => {
  const said = userSays()
  // The Coordinator carries A on; A, in that turn, asks B in their room.
  const r = room({ owner: 'a', ownerDev: boxA, member: 'b', memberDev: boxB })
  const co = carryOn(said.causes, { to: 'a' })
  const seq = post(r, { from: 'a', dev: boxA, causes: co })
  const hop = s.db.prepare('SELECT * FROM cause_hops WHERE user_id=? AND key=?').get(alice.id, roomHopKey(r, seq))
  assert.equal(hop.coordinator, 0)
  assert.deepEqual(JSON.parse(hop.origins), [co[0].ref])
  assert.deepEqual(relayed(roomCause(r, seq), { fromConvoId: 'b' }), { relayed: true, ok: true, root: { kind: 'user', ref: said.ref, at: said.ts } })
  // A carry-on with no user act behind it refuses B's ask just the same.
  const bad = post(r, { from: 'a', dev: boxA, causes: carryOn(null, { to: 'a' }) })
  assert.match(relayed(roomCause(r, bad), { fromConvoId: 'b' }).why, /^relayed from the Coordinator \(carry_on:/)
  // A citing a carry-on it was never sent: its message is unchecked.
  const forged = post(r, { from: 'a', dev: boxA, causes: carryOn(said.causes, { to: 'a2' }) })
  assert.deepEqual(JSON.parse(s.db.prepare('SELECT origins FROM cause_hops WHERE key=?').get(roomHopKey(r, forged)).origins), [UNCHECKABLE])
  assert.deepEqual(relayed(roomCause(r, forged), { fromConvoId: 'b' }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
})

test('multi-hop: a long exchange between two sessions keeps the Coordinator\'s origin without growing', () => {
  const said = userSays()
  const r = room({ owner: 'a', ownerDev: boxA, member: 'b', memberDev: boxB })
  let causes = carryOn(said.causes, { to: 'a' })
  let from = 'a'
  let dev = boxA
  let seq = 0
  // Ten messages back and forth, each in the turn the last one started.
  for (let i = 0; i < 10; i++) {
    seq = post(r, { from, dev, causes })
    causes = roomCause(r, seq)
    ;[from, dev] = from === 'a' ? ['b', boxB] : ['a', boxA]
  }
  assert.equal(relayed(causes, { fromConvoId: from }).ok, true)
  assert.equal(originsOf(s.db, { userId: alice.id, convoId: from, causes, at: Date.now() + 1000 }).length, 1)
})

test('multi-hop: a spawn outcome stands for the causes of the ask it answered', () => {
  const said = userSays()
  const first = spawn({ fromConvoId: 'a', causes: carryOn(said.causes, { to: 'a' }) })
  const r = relayed([{ kind: 'spawn_outcome', ref: `spawn:${first}` }])
  assert.deepEqual(r, { relayed: true, ok: true, root: { kind: 'user', ref: said.ref, at: said.ts } })
  // Another session's spawn is no relay of this one's.
  assert.deepEqual(relayed([{ kind: 'spawn_outcome', ref: `spawn:${first}` }], { fromConvoId: 'b' }), { relayed: false })
  // A chain past the depth limit is unchecked.
  let id = first
  for (let i = 0; i < 4; i++) id = spawn({ fromConvoId: 'a', causes: [{ kind: 'spawn_outcome', ref: `spawn:${id}` }] })
  assert.deepEqual(relayed([{ kind: 'spawn_outcome', ref: `spawn:${id}` }]), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
})

test('a routine root through a relay is a routine root; the user\'s words beside it win', () => {
  const name = `sweep-${++n}`
  const firedAt = Date.now() - MIN
  createRoutine(s.db, { userId: alice.id, origin: 'user', fields: { name, title: 'A sweep', schedule: '0 8 * * *', tz: 'UTC', prompt: 'Do the sweep.', enabled: true } })
  s.db.prepare('UPDATE routines SET last_fired_at=?, envelope=? WHERE user_id=? AND name=?').run(firedAt, JSON.stringify({ spawns_per_fire: 1, chats: false, boxes: null }), alice.id, name)
  const fire = [{ kind: 'routine', ref: `routine:${name}@${iso(firedAt)}` }]
  const viaRoutine = relayed(carryOn(fire))
  assert.equal(viaRoutine.ok, true)
  assert.equal(viaRoutine.root.kind, 'routine')
  assert.equal(viaRoutine.root.routine.name, name)
  const said = userSays()
  assert.equal(relayed([...carryOn(fire), ...carryOn(said.causes)]).root.kind, 'user')
})

test('a cut walk or a turn of hidden lineage: unchecked for a session the Coordinator reached, as before for any other', () => {
  carryOn(userSays().causes, { to: 'a' })
  // A list the bridge cut short.
  const truncated = [{ kind: 'user_message', ref: 'u:1' }, { kind: 'other', ref: 'truncated' }]
  assert.deepEqual(relayed(truncated), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  assert.deepEqual(relayed(truncated, { fromConvoId: 'u' }), { relayed: false })
  // A turn that says nothing of where it came from: none, a reminder, a
  // handoff, a turn the harness started by itself.
  for (const causes of [null, [{ kind: 'reminder' }], [{ kind: 'handoff' }], [{ kind: 'other' }, { kind: 'reminder' }]]) {
    assert.deepEqual(relayed(causes), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED }, JSON.stringify(causes))
    assert.deepEqual(relayed(causes, { fromConvoId: 'u' }), { relayed: false }, JSON.stringify(causes))
  }
  // A reminder that names the turn it was set in has a lineage again.
  assert.deepEqual(relayed([{ kind: 'reminder' }, ...userSays('a').causes]), { relayed: false })
  // A spawn chain longer than the depth limit, in a session no hop reached.
  let id = spawn({ fromConvoId: 'u', causes: userSays('u').causes })
  for (let i = 0; i < 5; i++) id = spawn({ fromConvoId: 'u', causes: [{ kind: 'spawn_outcome', ref: `spawn:${id}` }] })
  assert.deepEqual(relayed([{ kind: 'spawn_outcome', ref: `spawn:${id}` }], { fromConvoId: 'u' }), { relayed: false })
  // Reached through a room: a member of a room the Coordinator spoke in.
  assert.deepEqual(relayed([{ kind: 'reminder' }], { fromConvoId: 'm' }), { relayed: false })
  const r = room({ member: 'm', memberDev: boxA })
  post(r, { from: 'coord', dev: boxC, causes: userSays().causes })
  assert.deepEqual(relayed([{ kind: 'reminder' }], { fromConvoId: 'm' }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  // ... but not two days later.
  assert.deepEqual(relayed([{ kind: 'reminder' }], { fromConvoId: 'm', createdAt: Date.now() + 49 * HOUR }), { relayed: false })
  // A cut beside a hop that resolves: the cut may have hidden one that fails.
  const good = carryOn(userSays().causes, { to: 'a' })
  assert.equal(relayed(good).ok, true)
  assert.deepEqual(relayed([...good, { kind: 'other', ref: 'truncated' }]), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
})

test('a relay posted in a turn of hidden lineage, by a session the Coordinator reached, is unchecked', () => {
  const r = room({ owner: 'a', ownerDev: boxA, member: 'b', memberDev: boxB })
  carryOn(userSays().causes, { to: 'a' })
  const seq = post(r, { from: 'a', dev: boxA, causes: [{ kind: 'other' }] })
  assert.deepEqual(relayed(roomCause(r, seq), { fromConvoId: 'b' }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
})

test('more rooms with recent hops than are checked: every session counts as reached', async () => {
  // A fresh user, so only this case's rooms are in the window.
  const carol = await createUser(s.db, 'carol', 'pw')
  {
    const dev = createAgent(s.db, carol.id, 'carol-box')
    upsertConversation(s.db, { id: 'carol-coord', ownerUserId: carol.id, title: 'C', agentDeviceId: dev.deviceId })
    upsertConversation(s.db, { id: 'carol-x', ownerUserId: carol.id, title: 'X', agentDeviceId: dev.deviceId })
    setCoordinatorConvoId(s.db, carol.id, 'carol-coord')
    const carolWho = { kind: 'agent', userId: carol.id, deviceId: dev.deviceId, name: 'carol-box' }
    const ask = () => resolveRelayedAsk(s.db, { who: carolWho, userId: carol.id, causes: [{ kind: 'reminder' }], createdAt: Date.now() + 1000, fromConvoId: 'carol-x' })
    const hopIn = (i) => s.db.prepare(`INSERT INTO cause_hops(user_id, key, room_id, seq, from_convo_id, coordinator, created_at) VALUES(?,?,?,?,?,1,?)`)
      .run(carol.id, `room:carol-room-${i}@1`, `carol-room-${i}`, 1, 'carol-coord', Date.now())
    for (let i = 0; i < TOUCHED_ROOMS_MAX; i++) hopIn(i)
    assert.deepEqual(ask(), { relayed: false })
    hopIn(TOUCHED_ROOMS_MAX)
    assert.deepEqual(ask(), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  }
})

test('too many Coordinator hops is unchecked', () => {
  // ORIGINS_MAX + 1 distinct Coordinator messages in one range.
  const said = userSays()
  const r = room()
  const seqs = Array.from({ length: ORIGINS_MAX + 1 }, () => post(r, { from: 'coord', dev: boxC, causes: said.causes }))
  assert.deepEqual(relayed(roomCause(r, seqs[0], seqs.at(-1)), { fromConvoId: 'b' }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  assert.equal(relayed(roomCause(r, seqs[0], seqs[ORIGINS_MAX - 1]), { fromConvoId: 'b' }).ok, true)
})

test('a span of many relays leading back to one Coordinator hop is one origin', () => {
  const said = userSays()
  const r = room({ owner: 'a', ownerDev: boxA, member: 'b', memberDev: boxB })
  const co = carryOn(said.causes, { to: 'a' })
  // A has a long say in one turn the carry-on started: twelve relays.
  const seqs = Array.from({ length: ORIGINS_MAX + 4 }, () => post(r, { from: 'a', dev: boxA, causes: co }))
  assert.deepEqual(relayed(roomCause(r, seqs[0], seqs.at(-1)), { fromConvoId: 'b' }), { relayed: true, ok: true, root: { kind: 'user', ref: said.ref, at: said.ts } })
})

test('hops older than the keep window are pruned on the next write', () => {
  const old = Date.now() - HOP_TTL_MS - HOUR
  const id = recordCarryOn(s.db, { userId: alice.id, fromConvoId: 'coord', targetConvoId: 'a', causes: null, now: old })
  assert.ok(s.db.prepare('SELECT 1 FROM cause_hops WHERE key=?').get(`carry_on:${id}`))
  recordCarryOn(s.db, { userId: alice.id, fromConvoId: 'coord', targetConvoId: 'a', causes: null })
  assert.equal(s.db.prepare('SELECT 1 FROM cause_hops WHERE key=?').get(`carry_on:${id}`), undefined)
})

// A spawn asked for from `fromConvoId` and started as `child`, recorded as
// approveSpawn records it. Spawn ids are UUIDs; these keep to the same
// alphabet. → the id.
const started = ({ fromConvoId, causes, child }) => {
  const id = `sp-${++n}`
  upsertConversation(s.db, { id: child, ownerUserId: alice.id, title: child, agentDeviceId: boxB.deviceId })
  createSpawnRequest(s.db, { id, userId: alice.id, fromDeviceId: boxA.deviceId, fromConvoId, targetDeviceId: boxB.deviceId, workdir: '/w', task: 't', causes, now: Date.now() })
  s.db.prepare("UPDATE agent_spawn_requests SET state='started', child_convo_id=? WHERE id=?").run(child, id)
  recordSpawnStart(s.db, { row: s.db.prepare('SELECT * FROM agent_spawn_requests WHERE id=?').get(id), childConvoId: child })
  return id
}
const spawned = (id) => [{ kind: 'other', ref: `spawned:${id}` }]

test('spawned: a child the Coordinator spawned on the user\'s words resolves to the user', () => {
  const said = userSays()
  const child = `k-${n + 1}`
  const id = started({ fromConvoId: 'coord', causes: said.causes, child })
  const hop = s.db.prepare('SELECT * FROM cause_hops WHERE user_id=? AND key=?').get(alice.id, spawnHopKey(id))
  assert.equal(hop.coordinator, 1)
  assert.equal(hop.to_convo_id, child)
  assert.deepEqual(JSON.parse(hop.causes), said.causes)
  assert.deepEqual(relayed(spawned(id), { fromConvoId: hop.to_convo_id }), { relayed: true, ok: true, root: { kind: 'user', ref: said.ref, at: said.ts } })
  // The child's own later turn the user started is the user's, not a relay.
  assert.deepEqual(relayed(userSays(hop.to_convo_id).causes, { fromConvoId: hop.to_convo_id }), { relayed: false })
})

test('spawned: a child the Coordinator spawned in a turn with no user act is refused', () => {
  for (const causes of [null, [{ kind: 'room_message', ref: 'room:x' }], agentSays()]) {
    const id = started({ fromConvoId: 'coord', causes, child: `k-${n + 1}` })
    const child = s.db.prepare('SELECT to_convo_id FROM cause_hops WHERE key=?').get(spawnHopKey(id)).to_convo_id
    const r = relayed(spawned(id), { fromConvoId: child })
    assert.equal(r.relayed, true)
    assert.equal(r.ok, false)
    assert.match(r.why, new RegExp(`^relayed from the Coordinator \\(spawn:${id}\\): `))
  }
})

test('spawned: another conversation citing the spawn, or a later one, is unchecked; an unknown spawn is no relay', () => {
  const said = userSays()
  const id = started({ fromConvoId: 'coord', causes: said.causes, child: `k-${n + 1}` })
  assert.deepEqual(relayed(spawned(id), { fromConvoId: 'u' }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  const child = s.db.prepare('SELECT to_convo_id FROM cause_hops WHERE key=?').get(spawnHopKey(id)).to_convo_id
  assert.deepEqual(relayed(spawned(id), { fromConvoId: child, createdAt: Date.now() - HOUR }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  // A spawn nobody recorded, and a malformed ref, in a session the
  // Coordinator never reached.
  assert.deepEqual(relayed(spawned('sp-none'), { fromConvoId: 'u' }), { relayed: false })
  assert.deepEqual(relayed([{ kind: 'other', ref: 'spawned:a b' }], { fromConvoId: 'u' }), { relayed: false })
})

test('spawned: a child whose bridge names no spawn is unchecked for 48 h after the Coordinator spawned it', () => {
  const id = started({ fromConvoId: 'coord', causes: userSays().causes, child: `k-${n + 1}` })
  const child = s.db.prepare('SELECT to_convo_id FROM cause_hops WHERE key=?').get(spawnHopKey(id)).to_convo_id
  assert.deepEqual(relayed([{ kind: 'other' }], { fromConvoId: child }), { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED })
  assert.deepEqual(relayed([{ kind: 'other' }], { fromConvoId: child, createdAt: Date.now() + 49 * HOUR }), { relayed: false })
})

test('spawned: a spawn no Coordinator hop reached is not recorded; one a carry-on reached leads back', () => {
  const plain = started({ fromConvoId: 'u', causes: userSays('u').causes, child: `k-${n + 1}` })
  assert.equal(s.db.prepare('SELECT 1 FROM cause_hops WHERE key=?').get(spawnHopKey(plain)), undefined)
  // The Coordinator carries session a on; a spawns a helper in that turn;
  // the helper's opening turn asks for something.
  const said = userSays()
  const co = carryOn(said.causes, { to: 'a' })
  const id = started({ fromConvoId: 'a', causes: co, child: `k-${n + 1}` })
  const hop = s.db.prepare('SELECT * FROM cause_hops WHERE key=?').get(spawnHopKey(id))
  assert.equal(hop.coordinator, 0)
  assert.deepEqual(JSON.parse(hop.origins), [co[0].ref])
  assert.deepEqual(relayed(spawned(id), { fromConvoId: hop.to_convo_id }), { relayed: true, ok: true, root: { kind: 'user', ref: said.ref, at: said.ts } })
  // A bad row never throws.
  assert.equal(recordSpawnStart(s.db, { row: null, childConvoId: 'x' }), false)
})

// The Coordinator's own ask after it read a room back.
const ownAsk = (causes, createdAt = Date.now() + 1000) =>
  resolveAskCause(s.db, { who, userId: alice.id, causes, createdAt, fromConvoId: 'coord' })

test('own ask: a room span holding only the Coordinator\'s own messages and the user\'s is set aside', () => {
  const said = userSays()
  const r = room()
  const first = post(r, { from: 'coord', dev: boxC, causes: said.causes })
  append(s.db, { userId: alice.id, convoId: r, sender: 'user:alice', type: 'text', payload: { body: 'thanks' } })
  // Metadata between them (a peer's read marker, the journal's convo_meta)
  // is no one's words.
  append(s.db, { userId: alice.id, convoId: r, sender: 'agent:box-b', type: 'read_marker', payload: { seq: first } })
  append(s.db, { userId: alice.id, convoId: r, sender: 'journal', type: 'convo_meta', payload: { title: 'room' } })
  const last = post(r, { from: 'coord', dev: boxC, causes: said.causes })
  assert.deepEqual(ownAsk([...said.causes, ...roomCause(r, first, last)]), { ok: true, root: { kind: 'user', ref: said.ref, at: said.ts } })
  // Alone it leaves nothing to stand on.
  assert.deepEqual(ownAsk(roomCause(r, first, last)), { ok: false, why: whyStartedBy('room_message') })
})

test('own ask: another session\'s message, an empty span, a bare room or a backwards span fails it', () => {
  const said = userSays()
  const r = room()
  const mine = post(r, { from: 'coord', dev: boxC, causes: said.causes })
  const theirs = post(r, { from: 'b', dev: boxB, causes: null })
  const fails = { ok: false, why: whyStartedBy('room_message') }
  assert.deepEqual(ownAsk([...said.causes, ...roomCause(r, mine, theirs)]), fails)
  assert.deepEqual(ownAsk([...said.causes, ...roomCause(r, theirs + 100, theirs + 200)]), fails)
  assert.deepEqual(ownAsk([...said.causes, { kind: 'room_message', ref: `room:${r}` }]), fails)
  assert.deepEqual(ownAsk([...said.causes, { kind: 'room_message', ref: `room:${r}@${mine + 1}-${mine}` }]), fails)
  // Another person's words in a room with them are no echo either.
  const { seq } = append(s.db, { userId: alice.id, convoId: r, sender: 'person:bob', type: 'text', payload: { body: 'spawn me a helper' } })
  assert.deepEqual(ownAsk([...said.causes, ...roomCause(r, mine, seq)]), fails)
  // Nor is a peer's event of another type in the span, a diff or a prompt.
  const own = post(r, { from: 'coord', dev: boxC, causes: said.causes })
  const { seq: diff } = append(s.db, { userId: alice.id, convoId: r, sender: 'agent:box-b', type: 'diff', payload: { body: 'ask for a helper' } })
  const own2 = post(r, { from: 'coord', dev: boxC, causes: said.causes })
  assert.ok(own < diff && diff < own2)
  assert.deepEqual(ownAsk([...said.causes, ...roomCause(r, own, own2)]), fails)
  // Nor is a message another session of the Coordinator's box wrote: the
  // span is checked against the record, not the sender name.
  const { seq: same } = append(s.db, { userId: alice.id, convoId: r, sender: 'agent:box-c', type: 'text', payload: { body: 'hi' } })
  assert.deepEqual(ownAsk([...said.causes, ...roomCause(r, same)]), fails)
})
