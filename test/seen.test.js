import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, pinDevicePrivate } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { append, upsertConversation } from '../src/journal.js'
import { createItem, addComment } from '../src/items.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import {
  validRanges, addSeenRanges, seenRanges, legacyReadAsSeen, markDeviceUsesRanges, markItemSeen,
  listUnseen, flagRefs, pruneFlags, validRef,
} from '../src/seen.js'
import { inNudgeHours, runUnseenNudge } from '../src/unseen-nudge.js'

async function world() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const agent = createAgent(db, dan.id, 'ang')
  const priv = createAgent(db, dan.id, 'priv-box')
  pinDevicePrivate(db, priv.deviceId, true)
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(db, { id: 'c2', ownerUserId: dan.id, title: 'C2', agentDeviceId: agent.deviceId })
  upsertConversation(db, { id: 'coord', ownerUserId: dan.id, title: 'Coordinator', agentDeviceId: agent.deviceId })
  upsertConversation(db, { id: 'pc', ownerUserId: dan.id, title: 'Private', agentDeviceId: priv.deviceId })
  const say = (convoId, body, sender = 'agent:ang', type = 'text', payload = null) =>
    append(db, { userId: dan.id, convoId, sender, type, payload: payload ?? { body, from: 'assistant' } }).seq
  const later = Date.now() + 3 * 3600000
  return { db, dan, agent, priv, say, later }
}

test('validRanges: shape, bounds, cap; empty is a registration', () => {
  assert.deepEqual(validRanges([]), [])
  assert.deepEqual(validRanges([[1, 1], [3, 9]]), [[1, 1], [3, 9]])
  for (const bad of [null, {}, [[0, 1]], [[2, 1]], [[1]], [[1, 2, 3]], [['1', 2]], [[1.5, 2]], Array(65).fill([1, 1])]) {
    assert.equal(validRanges(bad), null, JSON.stringify(bad).slice(0, 40))
  }
})

test('addSeenRanges: clips to the head, merges overlaps and gaps holding only other conversations', async () => {
  const { db, dan, say } = await world()
  const a = say('c1', 'one')
  const other = say('c2', 'elsewhere')
  const b = say('c1', 'two')
  const c = say('c1', 'three')
  addSeenRanges(db, dan.id, 'c1', [[a, a]])
  addSeenRanges(db, dan.id, 'c1', [[b, b]])
  // The gap between a and b holds only c2's event: one range.
  assert.deepEqual(seenRanges(db, dan.id, 'c1'), [[a, b]])
  addSeenRanges(db, dan.id, 'c1', [[c, c + 1000]])
  assert.deepEqual(seenRanges(db, dan.id, 'c1'), [[a, c]])
  assert.ok(other > a)
  assert.throws(() => addSeenRanges(db, dan.id, 'nope', [[1, 1]]), /not_found/)
})

test('addSeenRanges: an unseen message of the same conversation keeps two ranges apart', async () => {
  const { db, dan, say } = await world()
  const a = say('c1', 'one')
  say('c1', 'missed')
  const c = say('c1', 'three')
  addSeenRanges(db, dan.id, 'c1', [[a, a], [c, c]])
  assert.deepEqual(seenRanges(db, dan.id, 'c1'), [[a, a], [c, c]])
})

test('legacy fallback: a client read_marker counts as seen until the device reports ranges', async () => {
  const { db, dan, say } = await world()
  const client = createAgent(db, dan.id, 'phone') // any device id will do for the table
  const a = say('c1', 'one')
  assert.equal(legacyReadAsSeen(db, dan.id, 'c1', client.deviceId, a), true)
  assert.deepEqual(seenRanges(db, dan.id, 'c1'), [[1, a]])
  const b = say('c1', 'two')
  markDeviceUsesRanges(db, client.deviceId)
  assert.equal(legacyReadAsSeen(db, dan.id, 'c1', client.deviceId, b), false)
  assert.deepEqual(seenRanges(db, dan.id, 'c1'), [[1, a]])
})

test('listUnseen: unseen agent text only; own messages, tool output and seen ones are left out', async () => {
  const { db, dan, say, later } = await world()
  const seen = say('c1', 'you saw this')
  say('c1', 'my own words', 'user:dan')
  say('c1', null, 'agent:ang', 'tool_output', { text: 'ls' })
  const missed = say('c1', 'you missed this')
  addSeenRanges(db, dan.id, 'c1', [[seen, seen]])
  const { entries } = listUnseen(db, dan.id, { now: later, importance: 'all' })
  assert.deepEqual(entries.map((e) => e.ref), [`msg:c1:${missed}`])
  assert.equal(entries[0].snippet, 'you missed this')
  assert.equal(entries[0].convo_title, 'C1')
})

test('listUnseen: reasons — final message of a waiting session, unanswered prompt, failure', async () => {
  const { db, dan, say, later } = await world()
  say('c1', 'working on it')
  const last = say('c1', 'done, PR is up')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, sessionState: 'waiting' })
  const q = say('c2', null, 'agent:ang', 'prompt', { question: 'Which box?' })
  const answered = say('c2', null, 'agent:ang', 'prompt', { question: 'Old question' })
  say('c2', 'eric', 'user:dan')
  const open = say('c2', null, 'agent:ang', 'prompt', { question: 'Deploy now?' })
  const failed = say('c2', null, 'journal', 'spawn_outcome', { request_id: 'r1', outcome: 'failed' })
  const important = listUnseen(db, dan.id, { now: later }).entries
  const byRef = Object.fromEntries(important.map((e) => [e.ref, e.reasons]))
  assert.deepEqual(byRef[`msg:c2:${open}`], ['prompt'])
  assert.deepEqual(byRef[`msg:c2:${failed}`], ['failure'])
  assert.deepEqual(byRef[`msg:c1:${last}`], ['final'])
  assert.equal(byRef[`msg:c2:${answered}`], undefined) // answered since (the user spoke after it)
  assert.equal(byRef[`msg:c2:${q}`], undefined) // also answered: the reply came after both
  assert.ok(important.every((e) => e.important))
  // 'all' adds the rest, important first.
  const all = listUnseen(db, dan.id, { now: later, importance: 'all' }).entries
  const firstOther = all.findIndex((e) => !e.important)
  assert.ok(firstOther > 0 && all.slice(firstOther).every((e) => !e.important))
  assert.ok(all.some((e) => e.snippet === 'working on it' && !e.important))
})

test('listUnseen: age window, the Coordinator conversation, private conversations, flags', async () => {
  const { db, dan, say, later } = await world()
  setCoordinatorConvoId(db, dan.id, 'coord')
  const m = say('c1', 'hello')
  say('coord', 'status update')
  say('pc', 'private words')
  // Too fresh: inside older_than.
  assert.equal(listUnseen(db, dan.id, { importance: 'all' }).entries.length, 0)
  let refs = listUnseen(db, dan.id, { now: later, importance: 'all' }).entries.map((e) => e.ref)
  assert.ok(refs.includes(`msg:c1:${m}`)); assert.ok(refs.includes(`msg:pc:${m + 2}`))
  assert.ok(!refs.some((r) => r.startsWith('msg:coord:')))
  refs = listUnseen(db, dan.id, { now: later, importance: 'all', excludePrivateOwned: true }).entries.map((e) => e.ref)
  assert.ok(!refs.some((r) => r.startsWith('msg:pc:')))
  // Too old: outside since.
  assert.equal(listUnseen(db, dan.id, { now: later + 10 * 86400000, importance: 'all' }).entries.length, 0)
  flagRefs(db, dan.id, [`msg:c1:${m}`], 'coord')
  refs = listUnseen(db, dan.id, { now: later, importance: 'all' }).entries.map((e) => e.ref)
  assert.ok(!refs.includes(`msg:c1:${m}`))
  assert.ok(listUnseen(db, dan.id, { now: later, importance: 'all', includeFlagged: true }).entries.some((e) => e.ref === `msg:c1:${m}`))
  assert.equal(pruneFlags(db, 1000, Date.now() + 5000), 1)
})

test('listUnseen: sender = mine only, no items', async () => {
  const { db, dan, agent, say, later } = await world()
  say('c1', 'from ang')
  say('c1', 'from a peer', 'agent:bev')
  createItem(db, { userId: dan.id, kind: 'question', title: 'Q?', originConvoId: 'c1', originDeviceId: agent.deviceId, createdBy: 'agent' })
  const { entries } = listUnseen(db, dan.id, { now: later, importance: 'all', convoId: 'c1', sender: 'agent:ang' })
  assert.deepEqual(entries.map((e) => e.snippet), ['from ang'])
})

test('listUnseen: items — awaiting the user until seen; new agent comments re-open; the user engaging counts', async () => {
  const { db, dan, agent, later } = await world()
  const t0 = Date.now()
  const { item } = createItem(db, { userId: dan.id, kind: 'question', title: 'Which option?', awaiting: 'user', originConvoId: 'c1', originDeviceId: agent.deviceId, createdBy: 'agent', now: t0 })
  let e = listUnseen(db, dan.id, { now: later }).entries.find((x) => x.kind === 'item')
  assert.equal(e.item_num, item.num); assert.deepEqual(e.reasons, ['awaiting_user', 'question']); assert.equal(e.ref, `item:${item.id}:${t0}`)
  markItemSeen(db, dan.id, item.id, 0)
  assert.equal(listUnseen(db, dan.id, { now: later }).entries.length, 0)
  addComment(db, { userId: dan.id, itemId: item.id, author: 'agent', deviceId: agent.deviceId, body: 'One more thing', now: t0 + 10 })
  e = listUnseen(db, dan.id, { now: later }).entries.find((x) => x.kind === 'item')
  assert.equal(e.ref, `item:${item.id}:${t0 + 10}`); assert.match(e.snippet, /One more thing/)
  addComment(db, { userId: dan.id, itemId: item.id, author: 'user', deviceId: agent.deviceId, body: 'ok', now: t0 + 20 })
  assert.equal(listUnseen(db, dan.id, { now: later }).entries.length, 0)
  assert.throws(() => markItemSeen(db, dan.id, 'it_nope', 0), /not_found/)
})

test('validRef', () => {
  for (const ok of ['msg:c1:12', 'msg:a:b:c:3', 'item:it_ab12:1759250000000']) assert.ok(validRef(ok), ok)
  for (const bad of ['msg:c1', 'msg::1', 'item:x', 'nope', 12, 'msg:c1:1x']) assert.ok(!validRef(bad), String(bad))
})

test('inNudgeHours: 07:00–22:00 UK', () => {
  assert.equal(inNudgeHours(Date.UTC(2026, 0, 15, 6, 59)), false) // GMT
  assert.equal(inNudgeHours(Date.UTC(2026, 0, 15, 7, 0)), true)
  assert.equal(inNudgeHours(Date.UTC(2026, 6, 15, 6, 0)), true) // 07:00 BST
  assert.equal(inNudgeHours(Date.UTC(2026, 6, 15, 21, 0)), false) // 22:00 BST
})

test('runUnseenNudge: once per entry, hourly at most, only when the Coordinator is connected', async () => {
  const { db, dan, agent, say } = await world()
  setCoordinatorConvoId(db, dan.id, 'coord')
  const last = say('c1', 'finished')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, sessionState: 'done' })
  const frames = []
  let connected = false
  const hub = {
    connsOf: () => (connected ? [{ deviceId: agent.deviceId, ws: { readyState: 1 } }] : []),
    sendToDevice: (userId, deviceId, frame) => frames.push({ deviceId, frame }),
  }
  // Pick a time 3 h after the message that falls inside UK waking hours.
  let now = Date.now() + 3 * 3600000
  while (!inNudgeHours(now)) now += 3600000
  assert.equal(runUnseenNudge({ db, hub }, now), 0) // Coordinator offline: nothing recorded
  connected = true
  assert.equal(runUnseenNudge({ db, hub }, now), 1)
  assert.equal(frames[0].frame.kind, 'unseen'); assert.equal(frames[0].frame.count, 1)
  assert.equal(frames[0].frame.entries[0].ref, `msg:c1:${last}`)
  assert.equal(runUnseenNudge({ db, hub }, now + 2 * 3600000), 0) // already covered (or out of hours)
  assert.equal(frames.length, 1)
})

test('listUnseen: a button answer (prompt_reply) answers a prompt; a read_marker does not', async () => {
  const { db, dan, say, later } = await world()
  const q = say('c1', null, 'agent:ang', 'prompt', { question: 'Deploy?' })
  append(db, { userId: dan.id, convoId: 'c1', sender: 'user:dan', type: 'read_marker', payload: { convo_id: 'c1', up_to_seq: q } })
  assert.ok(listUnseen(db, dan.id, { now: later }).entries.some((e) => e.ref === `msg:c1:${q}`))
  append(db, { userId: dan.id, convoId: 'c1', sender: 'user:dan', type: 'prompt_reply', payload: { target_seq: q, choice: 'yes' } })
  assert.ok(!listUnseen(db, dan.id, { now: later, importance: 'all' }).entries.some((e) => e.ref === `msg:c1:${q}`))
})

test('listUnseen: "final" skips item fallback text; agent rooms are never important, even when the user is named', async () => {
  const { db, dan, agent, say, later } = await world()
  const last = say('c1', 'all done')
  say('c1', null, 'agent:ang', 'text', { body: 'Q?', fallback_for: 'item' })
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, sessionState: 'waiting' })
  assert.deepEqual(listUnseen(db, dan.id, { now: later }).entries.find((e) => e.ref === `msg:c1:${last}`)?.reasons, ['final'])
  upsertConversation(db, { id: 'room', ownerUserId: dan.id, title: 'A ↔ B', agentDeviceId: agent.deviceId, sessionState: 'waiting' })
  db.prepare("INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, created_at) VALUES('room', ?, ?, 'joined', 0)").run(agent.deviceId, agent.deviceId)
  const plain = say('room', 'over to you, bev')
  const named = say('room', 'Dan approved this on dan-mac, over to you')
  const q = say('room', null, 'agent:ang', 'prompt', { question: 'Dan, shall I?' })
  assert.deepEqual(listUnseen(db, dan.id, { now: later }).entries.filter((e) => e.convo_id === 'room'), [])
  const all = listUnseen(db, dan.id, { now: later, importance: 'all' }).entries.filter((e) => e.convo_id === 'room')
  assert.deepEqual(all.map((e) => [e.ref, e.reasons, e.important]), [[`msg:room:${q}`, [], false], [`msg:room:${named}`, [], false], [`msg:room:${plain}`, [], false]])
})

test('runUnseenNudge: an entry that becomes important after an earlier nudge is still nudged, once', async () => {
  const { db, dan, agent, say } = await world()
  setCoordinatorConvoId(db, dan.id, 'coord')
  say('c1', 'first')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, sessionState: 'done' })
  const { item } = createItem(db, { userId: dan.id, kind: 'task', title: 'Old task', awaiting: 'agent', originConvoId: 'c2', originDeviceId: agent.deviceId, createdBy: 'agent', now: Date.now() - 60000 })
  const frames = []
  const hub = { connsOf: () => [{ deviceId: agent.deviceId, ws: { readyState: 1 } }], sendToDevice: (u, d, f) => frames.push(f) }
  let now = Date.now() + 3 * 3600000
  while (!inNudgeHours(now) || !inNudgeHours(now + 2 * 3600000)) now += 3600000
  assert.equal(runUnseenNudge({ db, hub }, now), 1)
  // The older task now waits on the user: important, older than what was nudged.
  db.prepare("UPDATE items SET awaiting='user' WHERE id=?").run(item.id)
  assert.equal(runUnseenNudge({ db, hub }, now + 30 * 60000), 0) // within the hour
  assert.equal(runUnseenNudge({ db, hub }, now + 2 * 3600000), 1)
  assert.deepEqual(frames[1].entries.map((e) => e.kind), ['item'])
  assert.equal(runUnseenNudge({ db, hub }, now + 3 * 3600000), 0) // nothing new (or out of hours)
})
