import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { createSpawnRequest } from '../src/spawns.js'
import { pinDevicePrivate } from '../src/db.js'
import { createRoutine } from '../src/routines.js'
import {
  resolveAskCause, SELF_APPROVAL_USER_WINDOW_MS, SELF_APPROVAL_ROUTINE_WINDOW_MS, FIRE_SLACK_MS, CAUSE_CHAIN_MAX_DEPTH,
  WHY_NO_CAUSE, WHY_OTHER_CONVO_MESSAGE, WHY_OTHER_CONVO_ITEM, WHY_CHAIN_TOO_DEEP, WHY_NOT_ASKING_USER, whyStartedBy,
} from '../src/ask-cause.js'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const iso = (ms) => new Date(ms).toISOString()

// One server for the whole file: every case gets its own conversation,
// items, routines and spawns, so they never see each other's rows.
let s, alice, bob, boxA, boxB, who, bobWho
let n = 0

test.before(async () => {
  s = await startTestServer()
  alice = await createUser(s.db, 'alice', 'pw')
  bob = await createUser(s.db, 'bob', 'pw')
  boxA = createAgent(s.db, alice.id, 'box-a')
  boxB = createAgent(s.db, alice.id, 'box-b')
  const bobBox = createAgent(s.db, bob.id, 'bob-box')
  who = { kind: 'agent', userId: alice.id, deviceId: boxA.deviceId, name: 'box-a' }
  bobWho = { kind: 'agent', userId: bob.id, deviceId: bobBox.deviceId, name: 'bob-box' }
})
test.after(() => s?.close())

const convo = (userId = alice.id, deviceId = boxA.deviceId) => {
  const id = `c${++n}`
  upsertConversation(s.db, { id, ownerUserId: userId, title: 'Chat', agentDeviceId: deviceId })
  return id
}
const say = (convoId, sender, body, userId = alice.id) => {
  const { seq } = append(s.db, { userId, convoId, sender, type: 'text', payload: { body } })
  const { ts } = s.db.prepare('SELECT ts FROM events WHERE user_id=? AND seq=?').get(userId, seq)
  return { seq, ts, ref: `${convoId}:${seq}` }
}
const item = (userId = alice.id, ownerConvoId = 'c0', num = ++n) => {
  const id = `it_${userId}_${num}`
  const now = Date.now()
  s.db.prepare(`INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
    VALUES(?,?,?,'question','open',?,?,?,?,'agent',?,?)`).run(id, userId, num, num, 'A question', ownerConvoId, boxA.deviceId, now, now)
  return { id, num }
}
const comment = (it, { author = 'user', kind = 'comment', meta = null, at = Date.now(), userId = alice.id } = {}) => {
  s.db.prepare(`INSERT INTO item_comments(id,item_id,user_id,author,device_id,kind,body,meta,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(`ic_${++n}`, it.id, userId, author, boxA.deviceId, kind, 'go ahead', meta == null ? null : JSON.stringify(meta), at)
  return `item:${it.num}@${iso(at)}`
}
const routine = ({ firedAt = Date.now(), envelope = { spawns_per_fire: 1, chats: false, boxes: null }, userId = alice.id } = {}) => {
  const name = `sweep-${++n}`
  createRoutine(s.db, { userId, origin: 'user', fields: { name, title: 'A sweep', schedule: '0 8 * * *', tz: 'UTC', prompt: 'Do the sweep.', enabled: true } })
  s.db.prepare('UPDATE routines SET last_fired_at=?, envelope=? WHERE user_id=? AND name=?')
    .run(firedAt, envelope == null ? null : (typeof envelope === 'string' ? envelope : JSON.stringify(envelope)), userId, name)
  return { name, firedAt }
}
const spawn = ({ fromConvoId, causes, state = 'started', userId = alice.id, id = `sp_${++n}`, createdAt = Date.now() }) => {
  createSpawnRequest(s.db, { id, userId, fromDeviceId: boxA.deviceId, fromConvoId, targetDeviceId: boxB.deviceId, workdir: '/w', task: 't', causes, now: createdAt })
  s.db.prepare('UPDATE agent_spawn_requests SET state=? WHERE id=?').run(state, id)
  return id
}
const resolve = (causes, { fromConvoId = 'c0', createdAt = Date.now(), as = who, userId = alice.id, depth } = {}) =>
  resolveAskCause(s.db, { who: as, userId, causes, createdAt, fromConvoId, ...(depth != null ? { depth } : {}) })

test('the windows, the depth limit and the whys are exported', () => {
  assert.equal(SELF_APPROVAL_USER_WINDOW_MS, 48 * HOUR)
  assert.equal(SELF_APPROVAL_ROUTINE_WINDOW_MS, 6 * HOUR)
  assert.equal(FIRE_SLACK_MS, 60 * 1000)
  assert.equal(CAUSE_CHAIN_MAX_DEPTH, 4)
  assert.equal(WHY_NO_CAUSE, 'the ask carries no turn cause (bridge too old, or the turn had none)')
  assert.equal(WHY_OTHER_CONVO_MESSAGE, 'the cited message is in another conversation')
  assert.equal(WHY_OTHER_CONVO_ITEM, 'the cited item belongs to another conversation')
  assert.equal(WHY_CHAIN_TOO_DEEP, 'the cause chain is deeper than 4 spawns')
  assert.equal(whyStartedBy('room_message'), 'started by room_message')
})

test('no causes: null and an empty list both fail with the same why', () => {
  for (const causes of [null, undefined, []]) {
    assert.deepEqual(resolve(causes), { ok: false, why: WHY_NO_CAUSE })
  }
})

test('a cause of any other kind fails the ask, named', () => {
  const c = convo()
  const m = say(c, 'user:alice', 'start a helper')
  assert.deepEqual(resolve([{ kind: 'room_message', ref: 'r1' }, { kind: 'user_message', ref: m.ref }], { fromConvoId: c }), { ok: false, why: 'started by room_message' })
  for (const kind of ['reminder', 'carry_on', 'alert', 'handoff', 'other']) {
    assert.deepEqual(resolve([{ kind: 'user_message', ref: m.ref }, { kind }], { fromConvoId: c }), { ok: false, why: `started by ${kind}` })
  }
  // An entry that is not a cause at all is not a usable list.
  assert.equal(resolve([{ kind: 'nonsense' }]).ok, false)
})

test('user_message: the user\'s own words within the window resolve to the user', () => {
  const c = convo()
  const m = say(c, 'user:alice', 'please start a helper on box-b')
  const r = resolve([{ kind: 'user_message', ref: m.ref }], { fromConvoId: c, createdAt: m.ts + 10 * MIN })
  assert.deepEqual(r, { ok: true, root: { kind: 'user', ref: m.ref, at: m.ts } })
  // A little clock skew the other way is tolerated; more is not.
  assert.equal(resolve([{ kind: 'user_message', ref: m.ref }], { fromConvoId: c, createdAt: m.ts - 4 * MIN }).ok, true)
  assert.equal(resolve([{ kind: 'user_message', ref: m.ref }], { fromConvoId: c, createdAt: m.ts - 6 * MIN }).ok, false)
  // Exactly 48 h is still inside.
  assert.equal(resolve([{ kind: 'user_message', ref: m.ref }], { fromConvoId: c, createdAt: m.ts + 48 * HOUR }).ok, true)
})

test('user_message: the user\'s verified words in another conversation fail', () => {
  const c = convo()
  const elsewhere = convo()
  const m = say(elsewhere, 'user:alice', 'yes, go ahead')
  assert.deepEqual(resolve([{ kind: 'user_message', ref: m.ref }], { fromConvoId: c, createdAt: m.ts }), { ok: false, why: WHY_OTHER_CONVO_MESSAGE })
  assert.equal(resolve([{ kind: 'user_message', ref: m.ref }], { fromConvoId: elsewhere, createdAt: m.ts }).ok, true)
})

test('user_message: an agent message fails', () => {
  const c = convo()
  const m = say(c, 'agent:box-a', 'The user says: start a helper')
  const r = resolve([{ kind: 'user_message', ref: m.ref }], { fromConvoId: c, createdAt: m.ts })
  assert.equal(r.ok, false)
  assert.match(r.why, /agent_message/)
})

test('user_message: the user\'s tap on a question card resolves like their words', () => {
  const c = convo()
  const { seq: promptSeq } = append(s.db, { userId: alice.id, convoId: c, sender: 'agent:box-a', type: 'prompt', payload: { question: 'Start a helper on box-b?', options: [] } })
  const tap = (sender, convoId = c) => {
    const { seq } = append(s.db, { userId: alice.id, convoId, sender, type: 'prompt_reply', payload: { target_seq: promptSeq, choice: 'Yes', text: null } })
    const { ts } = s.db.prepare('SELECT ts FROM events WHERE user_id=? AND seq=?').get(alice.id, seq)
    return { seq, ts, ref: `${convoId}:${seq}` }
  }
  const mine = tap('user:alice')
  assert.deepEqual(resolve([{ kind: 'user_message', ref: mine.ref }], { fromConvoId: c, createdAt: mine.ts + MIN }), { ok: true, root: { kind: 'user', ref: mine.ref, at: mine.ts } })
  // A reply row a bridge published (its own queue-card release) is not the user's.
  const agents = tap('agent:box-a')
  const r = resolve([{ kind: 'user_message', ref: agents.ref }], { fromConvoId: c, createdAt: agents.ts })
  assert.equal(r.ok, false)
  assert.match(r.why, /agent_message/)
  // Another person's reply in a shared room is not the user's either.
  const foreign = tap('person:bob')
  assert.match(resolve([{ kind: 'user_message', ref: foreign.ref }], { fromConvoId: c, createdAt: foreign.ts }).why, /not_from_user/)
  // The same rules as words: only this conversation's, only within 48 h.
  const elsewhere = convo()
  const away = tap('user:alice', elsewhere)
  assert.deepEqual(resolve([{ kind: 'user_message', ref: away.ref }], { fromConvoId: c, createdAt: away.ts }), { ok: false, why: WHY_OTHER_CONVO_MESSAGE })
  assert.match(resolve([{ kind: 'user_message', ref: mine.ref }], { fromConvoId: c, createdAt: mine.ts + 49 * HOUR }).why, /48 h/)
})

test('user_message: words 49 h old fail', () => {
  const c = convo()
  const m = say(c, 'user:alice', 'start a helper')
  const r = resolve([{ kind: 'user_message', ref: m.ref }], { fromConvoId: c, createdAt: m.ts + 49 * HOUR })
  assert.equal(r.ok, false)
  assert.match(r.why, /48 h/)
})

test('user_message: unknown, malformed and another user\'s citations fail', () => {
  const bc = convo(bob.id, null)
  const bm = say(bc, 'user:bob', 'start a helper', bob.id)
  for (const ref of [bm.ref, 'c-missing:3', 'nonsense', undefined]) {
    const r = resolve([{ kind: 'user_message', ...(ref ? { ref } : {}) }])
    assert.equal(r.ok, false, String(ref))
    assert.equal(typeof r.why, 'string')
  }
  assert.equal(resolve([{ kind: 'user_message', ref: bm.ref }], { fromConvoId: bc }).ok, false)
  // The caller's identity must be the asking user's.
  assert.deepEqual(resolve([{ kind: 'user_message', ref: bm.ref }], { as: bobWho, fromConvoId: bc }), { ok: false, why: WHY_NOT_ASKING_USER })
  assert.equal(resolve([{ kind: 'user_message', ref: bm.ref }], { as: bobWho, userId: bob.id, fromConvoId: bc }).ok, true)
})

test('item_reply / item_tap: the user\'s comment resolves to the item; a tap needs an action', () => {
  const it = item()
  const at = Date.now() - HOUR
  const reply = comment(it, { at })
  assert.deepEqual(resolve([{ kind: 'item_reply', ref: reply }]), { ok: true, root: { kind: 'item', ref: reply, at } })
  const tap = comment(it, { at: at + 1, meta: { action: 'Go' } })
  assert.deepEqual(resolve([{ kind: 'item_tap', ref: tap }]), { ok: true, root: { kind: 'item', ref: tap, at: at + 1 } })
  // A plain reply cited as a tap is not a tap.
  assert.equal(resolve([{ kind: 'item_tap', ref: reply }]).ok, false)
  const bad = comment(it, { at: at + 2, meta: { action: 5 } })
  assert.equal(resolve([{ kind: 'item_tap', ref: bad }]).ok, false)
})

test('item_reply / item_tap: an item owned by another conversation fails', () => {
  const it = item(alice.id, 'c-other')
  const reply = comment(it, { at: Date.now() - MIN })
  const tap = comment(it, { at: Date.now() - 2 * MIN, meta: { action: 'Go' } })
  assert.deepEqual(resolve([{ kind: 'item_reply', ref: reply }]), { ok: false, why: WHY_OTHER_CONVO_ITEM })
  assert.deepEqual(resolve([{ kind: 'item_tap', ref: tap }]), { ok: false, why: WHY_OTHER_CONVO_ITEM })
  assert.equal(resolve([{ kind: 'item_reply', ref: reply }], { fromConvoId: 'c-other' }).ok, true)
})

test('item_reply: an agent comment, a status row, a wrong time, an old one and another user\'s item fail', () => {
  const it = item()
  const at = Date.now() - 2 * HOUR
  assert.equal(resolve([{ kind: 'item_reply', ref: comment(it, { author: 'agent', at }) }]).ok, false)
  assert.equal(resolve([{ kind: 'item_reply', ref: comment(it, { kind: 'status', at: at + 1 }) }]).ok, false)
  assert.equal(resolve([{ kind: 'item_reply', ref: `item:${it.num}@${iso(at + 2)}` }]).ok, false)
  const old = comment(it, { at: Date.now() - 49 * HOUR })
  assert.equal(resolve([{ kind: 'item_reply', ref: old }]).ok, false)
  for (const ref of [`item:${it.num}`, `item:x@${iso(at)}`, `item:${it.num}@2026-01-01T00:00:00Z`, `item:${it.num}@2026-02-30T00:00:00.000Z`, `item:${'1'.repeat(16)}@${iso(at)}`, 'garbage']) {
    assert.deepEqual(resolve([{ kind: 'item_reply', ref }]), { ok: false, why: 'the item_reply cause is not an item:<num>@<time> ref' }, ref)
  }
})

test('item_reply: another user\'s item is never the asking user\'s', () => {
  const at = Date.now() - HOUR
  // Only the other user has an item with this number.
  const bit = item(bob.id)
  const bref = comment(bit, { at, userId: bob.id })
  assert.deepEqual(resolve([{ kind: 'item_reply', ref: bref }]), { ok: false, why: 'the item_reply cause names no item of the user\'s' })
  // Both users have an item with this number; the other user's comment is on theirs.
  const num = ++n
  item(alice.id, 'c0', num)
  const shared = comment(item(bob.id, 'c0', num), { at: at + 7, userId: bob.id })
  assert.deepEqual(resolve([{ kind: 'item_reply', ref: shared }]), { ok: false, why: 'the item_reply cause is not a comment the user left on that item' })
  // ... and it resolves for its own user.
  const bobsWho = { ...bobWho }
  assert.equal(resolve([{ kind: 'item_reply', ref: shared }], { as: bobsWho, userId: bob.id }).ok, true)
})

test('routine: a fire matching last_fired_at resolves to the routine, envelope parsed', () => {
  const r0 = routine({ firedAt: Date.now() - HOUR, envelope: { spawns_per_fire: 2, chats: false, boxes: ['box-b'] } })
  const ref = `routine:${r0.name}@${iso(r0.firedAt + 30 * 1000)}`
  const r = resolve([{ kind: 'routine', ref }])
  assert.equal(r.ok, true)
  assert.equal(r.root.kind, 'routine')
  // The root is the recorded fire, not the cited time.
  assert.equal(r.root.ref, `routine:${r0.name}@${iso(r0.firedAt)}`)
  assert.equal(r.root.at, r0.firedAt)
  assert.equal(r.root.routine.name, r0.name)
  assert.equal(r.root.routine.prompt, 'Do the sweep.')
  assert.deepEqual(r.root.routine.envelope, { spawns_per_fire: 2, chats: false, boxes: ['box-b'] })
  // No envelope and a broken one both read as null.
  const r1 = routine({ envelope: null })
  assert.equal(resolve([{ kind: 'routine', ref: `routine:${r1.name}@${iso(r1.firedAt)}` }]).root.routine.envelope, null)
  const r2 = routine({ envelope: '{not json' })
  assert.equal(resolve([{ kind: 'routine', ref: `routine:${r2.name}@${iso(r2.firedAt)}` }]).root.routine.envelope, null)
})

test('routine: refs a millisecond apart name the same root', () => {
  const r0 = routine({ firedAt: Date.now() - HOUR })
  const a = resolve([{ kind: 'routine', ref: `routine:${r0.name}@${iso(r0.firedAt + 10)}` }])
  const b = resolve([{ kind: 'routine', ref: `routine:${r0.name}@${iso(r0.firedAt + 11)}` }])
  const c = resolve([{ kind: 'routine', ref: `routine:${r0.name}@${iso(r0.firedAt - 59 * 1000)}` }])
  assert.equal(a.root.ref, b.root.ref)
  assert.equal(a.root.ref, c.root.ref)
  assert.equal(a.root.at, b.root.at)
})

test('routine: a fire after the ask fails', () => {
  const r0 = routine({ firedAt: Date.now() })
  const ref = `routine:${r0.name}@${iso(r0.firedAt)}`
  assert.deepEqual(resolve([{ kind: 'routine', ref }], { createdAt: r0.firedAt - 6 * MIN }), { ok: false, why: 'the routine cause fired after the ask' })
  assert.equal(resolve([{ kind: 'routine', ref }], { createdAt: r0.firedAt - 4 * MIN }).ok, true)
})

test('routine: a fired_at 5 min off last_fired_at fails', () => {
  const r0 = routine({ firedAt: Date.now() - HOUR })
  const r = resolve([{ kind: 'routine', ref: `routine:${r0.name}@${iso(r0.firedAt - 5 * MIN)}` }])
  assert.equal(r.ok, false)
  assert.match(r.why, /last fire/)
})

test('routine: the 6 h and after-the-ask bounds are measured on the recorded fire, not the cited time', () => {
  const createdAt = Date.now()
  // Recorded just past 6 h before the ask; the citation, inside the slack, just inside it.
  const old = routine({ firedAt: createdAt - SELF_APPROVAL_ROUTINE_WINDOW_MS - 30 * 1000 })
  assert.deepEqual(resolve([{ kind: 'routine', ref: `routine:${old.name}@${iso(old.firedAt + 59 * 1000)}` }], { createdAt }),
    { ok: false, why: 'the routine cause fired more than 6 h before the ask' })
  // Recorded just past the future slack; the citation just inside it.
  const late = routine({ firedAt: createdAt + 5 * MIN + 30 * 1000 })
  assert.deepEqual(resolve([{ kind: 'routine', ref: `routine:${late.name}@${iso(late.firedAt - 59 * 1000)}` }], { createdAt }),
    { ok: false, why: 'the routine cause fired after the ask' })
})

test('routine: a fire 7 h old fails', () => {
  const r0 = routine({ firedAt: Date.now() - 7 * HOUR })
  const r = resolve([{ kind: 'routine', ref: `routine:${r0.name}@${iso(r0.firedAt)}` }])
  assert.equal(r.ok, false)
  assert.match(r.why, /6 h/)
})

test('routine: unknown, another user\'s, never fired and malformed refs fail', () => {
  const b = routine({ userId: bob.id })
  const never = routine()
  s.db.prepare('UPDATE routines SET last_fired_at=NULL WHERE name=?').run(never.name)
  const at = iso(Date.now())
  const BAD_REF = 'the routine cause is not a routine:<name>@<fired_at> ref'
  const UNKNOWN = 'the routine cause names no routine of the user\'s'
  const cases = [
    [`routine:${b.name}@${iso(b.firedAt)}`, UNKNOWN],
    [`routine:no-such@${at}`, UNKNOWN],
    [`routine:${never.name}@${at}`, 'the routine cause is not that routine\'s last fire'],
    [`routine:${never.name}`, BAD_REF],
    [`routine:@${at}`, BAD_REF],
    [`routine:Bad_Name@${at}`, BAD_REF],
    [`routine:rt_x@${at}`, BAD_REF],
    [`routine:${never.name}@2026-01-01T00:00:00Z`, BAD_REF],
    [undefined, BAD_REF],
  ]
  for (const [ref, why] of cases) {
    assert.deepEqual(resolve([{ kind: 'routine', ...(ref ? { ref } : {}) }]), { ok: false, why }, String(ref))
  }
})

test('a user cause wins over a routine, whichever comes first', () => {
  const c = convo()
  const m = say(c, 'user:alice', 'start a helper')
  const r0 = routine()
  const rref = `routine:${r0.name}@${iso(r0.firedAt)}`
  assert.deepEqual(resolve([{ kind: 'routine', ref: rref }, { kind: 'user_message', ref: m.ref }], { fromConvoId: c }), { ok: true, root: { kind: 'user', ref: m.ref, at: m.ts } })
  assert.equal(resolve([{ kind: 'user_message', ref: m.ref }, { kind: 'routine', ref: rref }], { fromConvoId: c }).root.kind, 'user')
  // A user cause that does not verify does not fall back to the routine.
  const a = say(c, 'agent:box-a', 'start a helper')
  const r = resolve([{ kind: 'routine', ref: rref }, { kind: 'user_message', ref: a.ref }], { fromConvoId: c })
  assert.equal(r.ok, false)
  // The first user/item cause that resolves wins.
  const it = item(alice.id, c)
  const reply = comment(it, { at: Date.now() - MIN })
  assert.equal(resolve([{ kind: 'user_message', ref: a.ref }, { kind: 'item_reply', ref: reply }], { fromConvoId: c }).root.kind, 'item')
})

test('spawn_outcome: a chain of two hops reaches the user', () => {
  const c = convo()
  const m = say(c, 'user:alice', 'start two helpers, one after the other')
  const first = spawn({ fromConvoId: c, causes: [{ kind: 'user_message', ref: m.ref }] })
  const second = spawn({ fromConvoId: c, causes: [{ kind: 'spawn_outcome', ref: `spawn:${first}` }] })
  const r = resolve([{ kind: 'spawn_outcome', ref: `spawn:${second}` }], { fromConvoId: c })
  assert.deepEqual(r, { ok: true, root: { kind: 'user', ref: m.ref, at: m.ts } })
  // ... and a routine root through a spawn is a routine root.
  const r0 = routine()
  const viaRoutine = spawn({ fromConvoId: c, causes: [{ kind: 'routine', ref: `routine:${r0.name}@${iso(r0.firedAt)}` }] })
  assert.equal(resolve([{ kind: 'spawn_outcome', ref: `spawn:${viaRoutine}` }], { fromConvoId: c }).root.kind, 'routine')
})

test('spawn_outcome: a self-referencing chain fails on depth', () => {
  const c = convo()
  const id = 'sp_loop'
  spawn({ id, fromConvoId: c, causes: [{ kind: 'spawn_outcome', ref: `spawn:${id}` }] })
  const r = resolve([{ kind: 'spawn_outcome', ref: `spawn:${id}` }], { fromConvoId: c })
  assert.equal(r.ok, false)
  assert.equal(r.why, WHY_CHAIN_TOO_DEEP)
  // A wide loop is cut off just the same, without exploding.
  const wide = 'sp_wide'
  spawn({ id: wide, fromConvoId: c, causes: Array.from({ length: 8 }, () => ({ kind: 'spawn_outcome', ref: `spawn:${wide}` })) })
  const t0 = Date.now()
  assert.equal(resolve([{ kind: 'spawn_outcome', ref: `spawn:${wide}` }], { fromConvoId: c }).ok, false)
  assert.ok(Date.now() - t0 < 2000)
  // A caller already at the limit cannot recurse at all.
  const m = say(c, 'user:alice', 'go')
  const one = spawn({ fromConvoId: c, causes: [{ kind: 'user_message', ref: m.ref }] })
  assert.equal(resolve([{ kind: 'spawn_outcome', ref: `spawn:${one}` }], { fromConvoId: c, depth: 4 }).ok, false)
  assert.equal(resolve([{ kind: 'spawn_outcome', ref: `spawn:${one}` }], { fromConvoId: c, depth: 3 }).ok, true)
})

test('spawn_outcome: another conversation\'s, another user\'s, an unanswered or refused spawn, and a bad ref fail', () => {
  const c = convo()
  const other = convo()
  const m = say(c, 'user:alice', 'start a helper')
  const causes = [{ kind: 'user_message', ref: m.ref }]
  const NOT_OURS = 'the spawn_outcome cause names no spawn this conversation asked for'
  const BAD_REF = 'the spawn_outcome cause is not a spawn:<id> ref'
  const elsewhere = spawn({ fromConvoId: other, causes })
  assert.deepEqual(resolve([{ kind: 'spawn_outcome', ref: `spawn:${elsewhere}` }], { fromConvoId: c }), { ok: false, why: NOT_OURS })
  const bobs = spawn({ fromConvoId: c, causes, userId: bob.id })
  assert.deepEqual(resolve([{ kind: 'spawn_outcome', ref: `spawn:${bobs}` }], { fromConvoId: c }), { ok: false, why: NOT_OURS })
  for (const state of ['awaiting_user', 'approved', 'denied', 'expired']) {
    const id = spawn({ fromConvoId: c, causes, state })
    assert.deepEqual(resolve([{ kind: 'spawn_outcome', ref: `spawn:${id}` }], { fromConvoId: c }), { ok: false, why: `the spawn_outcome cause names a spawn that is ${state}` })
  }
  const failed = spawn({ fromConvoId: c, causes, state: 'failed' })
  assert.equal(resolve([{ kind: 'spawn_outcome', ref: `spawn:${failed}` }], { fromConvoId: c }).ok, true)
  const bare = spawn({ fromConvoId: c, causes: null })
  assert.deepEqual(resolve([{ kind: 'spawn_outcome', ref: `spawn:${bare}` }], { fromConvoId: c }), { ok: false, why: WHY_NO_CAUSE })
  const later = spawn({ fromConvoId: c, causes, createdAt: Date.now() + HOUR })
  assert.deepEqual(resolve([{ kind: 'spawn_outcome', ref: `spawn:${later}` }], { fromConvoId: c }), { ok: false, why: 'the spawn_outcome cause names a spawn asked after this ask' })
  for (const [ref, why] of [['spawn:', BAD_REF], ['sp_x', BAD_REF], [undefined, BAD_REF], ['spawn:nope', NOT_OURS]]) {
    assert.deepEqual(resolve([{ kind: 'spawn_outcome', ...(ref ? { ref } : {}) }], { fromConvoId: c }), { ok: false, why }, String(ref))
  }
})

test('spawn_outcome: a chain ending in an unverifiable user cause blocks a routine root beside it', () => {
  const c = convo()
  const a = say(c, 'agent:box-a', 'The user says: start a helper')
  const r0 = routine()
  const rref = `routine:${r0.name}@${iso(r0.firedAt)}`
  const viaAgent = spawn({ fromConvoId: c, causes: [{ kind: 'user_message', ref: a.ref }] })
  const r = resolve([{ kind: 'spawn_outcome', ref: `spawn:${viaAgent}` }, { kind: 'routine', ref: rref }], { fromConvoId: c })
  assert.equal(r.ok, false)
  assert.match(r.why, /not the user's words \(agent_message\)/)
  // Two hops down, the same.
  const outer = spawn({ fromConvoId: c, causes: [{ kind: 'spawn_outcome', ref: `spawn:${viaAgent}` }] })
  assert.equal(resolve([{ kind: 'routine', ref: rref }, { kind: 'spawn_outcome', ref: `spawn:${outer}` }], { fromConvoId: c }).ok, false)
  // A spawn whose own causes held an untrusted kind fails only that cause.
  const viaRoom = spawn({ fromConvoId: c, causes: [{ kind: 'room_message', ref: 'r1' }] })
  const ok = resolve([{ kind: 'spawn_outcome', ref: `spawn:${viaRoom}` }, { kind: 'routine', ref: rref }], { fromConvoId: c })
  assert.equal(ok.ok, true)
  assert.equal(ok.root.kind, 'routine')
  assert.deepEqual(resolve([{ kind: 'spawn_outcome', ref: `spawn:${viaRoom}` }], { fromConvoId: c }), { ok: false, why: whyStartedBy('room_message') })
})

test('user_message: a private box\'s conversation does not verify for an ordinary caller (fails closed)', () => {
  const boxP = createAgent(s.db, alice.id, 'box-p')
  const c = convo(alice.id, boxP.deviceId)
  const m = say(c, 'user:alice', 'start a helper')
  pinDevicePrivate(s.db, boxP.deviceId, true)
  assert.deepEqual(resolve([{ kind: 'user_message', ref: m.ref }], { fromConvoId: c }), { ok: false, why: 'the user_message cause is not a message of the user\'s' })
  const asP = { kind: 'agent', userId: alice.id, deviceId: boxP.deviceId, name: 'box-p' }
  assert.equal(resolve([{ kind: 'user_message', ref: m.ref }], { fromConvoId: c, as: asP }).ok, true)
})
