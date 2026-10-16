// An item's `working` block: whether the session that owns the item is busy,
// so an item thread can show the same indicator a chat does. `running` while
// the owning conversation is mid-turn; `queued` from the moment the user says
// something on the item that will reach the agent as a turn, until that turn
// starts (or the wait is given up on).
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { saveGithubIdentity } from '../src/github-accounts.js'
import { upsertConversation } from '../src/journal.js'
import { createItem, getItem, listItems, listSharedItems, getSharedItem, requestTurn, itemWorking, WORKING_QUEUED_TTL_MS, WORKING_HANDOFF_GRACE_MS } from '../src/items.js'

const T0 = 1_700_000_000_000

// --- the pure rule ---------------------------------------------------------------

test('itemWorking: running while the owning conversation is mid-turn, whatever the item asked for', () => {
  assert.deepEqual(itemWorking({ sessionState: 'running', turnStartedAt: T0, turnEndedAt: null, turnRequestedAt: null }, T0 + 5),
    { state: 'running', since: T0, until: null })
  assert.deepEqual(itemWorking({ sessionState: 'running', turnStartedAt: null, turnEndedAt: null, turnRequestedAt: T0 }, T0 + 5),
    { state: 'running', since: null, until: null })
})

test('itemWorking: nothing asked and nothing running is null', () => {
  for (const sessionState of ['waiting', 'done', 'archived']) {
    assert.equal(itemWorking({ sessionState, turnStartedAt: T0, turnEndedAt: T0 + 1, turnRequestedAt: null }, T0 + 5), null)
  }
  // No owning conversation row at all.
  assert.equal(itemWorking({ sessionState: null, turnStartedAt: null, turnEndedAt: null, turnRequestedAt: T0 }, T0 + 5), null)
})

test('itemWorking: queued from the ask until a turn starts, bounded by the TTL', () => {
  const base = { sessionState: 'waiting', turnStartedAt: T0 - 60_000, turnEndedAt: T0 - 30_000, turnRequestedAt: T0 }
  assert.deepEqual(itemWorking(base, T0 + 1), { state: 'queued', since: T0, until: T0 + WORKING_QUEUED_TTL_MS })
  // A session that has never run a turn (no stamps at all) still queues.
  assert.deepEqual(itemWorking({ ...base, turnStartedAt: null, turnEndedAt: null }, T0 + 1),
    { state: 'queued', since: T0, until: T0 + WORKING_QUEUED_TTL_MS })
  assert.equal(itemWorking(base, T0 + WORKING_QUEUED_TTL_MS), null)
})

test('itemWorking: a turn that started after the ask has answered it', () => {
  // …and ended: nothing is queued any more.
  assert.equal(itemWorking({ sessionState: 'waiting', turnStartedAt: T0 + 2_000, turnEndedAt: T0 + 9_000, turnRequestedAt: T0 }, T0 + 9_001), null)
})

test('itemWorking: an ask that landed mid-turn stays queued across the hand-off to the next turn, briefly', () => {
  // The turn in flight when the user tapped has ended; the reply is either
  // about to start the next turn or was taken into the one that just ended.
  const row = { sessionState: 'waiting', turnStartedAt: T0 - 5_000, turnEndedAt: T0 + 4_000, turnRequestedAt: T0 }
  assert.deepEqual(itemWorking(row, T0 + 4_001), { state: 'queued', since: T0, until: T0 + 4_000 + WORKING_HANDOFF_GRACE_MS })
  assert.equal(itemWorking(row, T0 + 4_000 + WORKING_HANDOFF_GRACE_MS), null)
  // The grace never outlives the TTL.
  const late = { ...row, turnEndedAt: T0 + WORKING_QUEUED_TTL_MS - 1_000 }
  assert.equal(itemWorking(late, T0 + WORKING_QUEUED_TTL_MS - 500).until, T0 + WORKING_QUEUED_TTL_MS)
})

// --- state -----------------------------------------------------------------------

async function seed() {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const agent = createAgent(db, alice.id, 'box-a')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'C1', sessionState: 'waiting', agentDeviceId: agent.deviceId })
  const item = createItem(db, { userId: alice.id, kind: 'question', title: 'Ship it?', originConvoId: 'c1', originDeviceId: agent.deviceId, createdBy: 'agent' }).item
  return { db, alice, agent, item }
}

test('upsertConversation stamps the turn start and end on session_state transitions only', async () => {
  const { db, alice } = await seed()
  const stamps = () => db.prepare('SELECT turn_started_at AS s, turn_ended_at AS e FROM conversations WHERE id=?').get('c1')
  assert.deepEqual(stamps(), { s: null, e: null })
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, sessionState: 'running' })
  const first = stamps()
  assert.ok(first.s > 0); assert.equal(first.e, null)
  // A repeated `running`, a title-only upsert: no new stamp.
  db.prepare('UPDATE conversations SET turn_started_at=1 WHERE id=?').run('c1')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, sessionState: 'running' })
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'renamed' })
  assert.deepEqual(stamps(), { s: 1, e: null })
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, sessionState: 'waiting' })
  assert.ok(stamps().e > 1)
  // waiting -> done is not a turn ending.
  db.prepare('UPDATE conversations SET turn_ended_at=2 WHERE id=?').run('c1')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, sessionState: 'done' })
  assert.deepEqual(stamps(), { s: 1, e: 2 })
  // A conversation born running started its turn at birth.
  upsertConversation(db, { id: 'c2', ownerUserId: alice.id, title: 'C2' })
  const born = db.prepare('SELECT turn_started_at AS s, created_at AS c FROM conversations WHERE id=?').get('c2')
  assert.equal(born.s, born.c)
})

test('getItem / listItems carry `working`, and never the columns behind it', async () => {
  const { db, alice, item } = await seed()
  assert.equal(getItem(db, alice.id, item.id).working, null)
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, sessionState: 'running' })
  const got = getItem(db, alice.id, item.id)
  assert.equal(got.working.state, 'running'); assert.ok(got.working.since > 0); assert.equal(got.working.until, null)
  for (const k of ['turn_requested_at', 'owner_session_state', 'owner_turn_started_at', 'owner_turn_ended_at']) assert.equal(k in got, false, k)
  assert.equal(listItems(db, alice.id, {}).items[0].working.state, 'running')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, sessionState: 'waiting' })
  assert.equal(getItem(db, alice.id, item.id).working, null)
})

test('requestTurn: queued at once, running when the turn starts, cleared when it ends', async () => {
  const { db, alice, item } = await seed()
  const w = requestTurn(db, item.id, T0)
  assert.deepEqual(w, { state: 'queued', since: T0, until: T0 + WORKING_QUEUED_TTL_MS })
  assert.equal(getItem(db, alice.id, item.id).working, null, 'T0 is long past: the stored ask has expired by the real clock')
  // The list reads the same clock (a row's index must never stand in for it).
  assert.equal(listItems(db, alice.id, {}).items[0].working, null)
  const now = Date.now()
  requestTurn(db, item.id, now)
  assert.equal(getItem(db, alice.id, item.id).working.state, 'queued')
  // Stamp the turn start strictly after the ask, as a real bridge would.
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, sessionState: 'running' })
  db.prepare('UPDATE conversations SET turn_started_at=? WHERE id=?').run(now + 5, 'c1')
  assert.equal(getItem(db, alice.id, item.id).working.state, 'running')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, sessionState: 'waiting' })
  assert.equal(getItem(db, alice.id, item.id).working, null)
})

// --- HTTP ------------------------------------------------------------------------

async function fleet(t, opts = {}) {
  const s = await startTestServer(opts)
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-a')
  const client = (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'phone' } })).json.token
  const bridge = await makeWsClient(s.base, { token: agent.token, cursor: null })
  t.after(() => bridge.close())
  await bridge.waitFor((f) => f.op === 'hello_ok')
  bridge.send({ op: 'convo_upsert', convo_id: 'c1', title: 'C1', session_state: 'waiting' })
  await bridge.waitFor((f) => f.kind === 'journal' && f.type === 'session_status' && f.payload.state === 'waiting')
  const mk = (body = {}) => s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'question', title: 'Ship it?', convo_id: 'c1', actions: ['Go', 'Wait'], ...body } })
  const setState = async (state) => {
    const before = bridge.journal().filter((f) => f.type === 'session_status').length
    bridge.send({ op: 'convo_upsert', convo_id: 'c1', session_state: state })
    await bridge.waitFor(() => bridge.journal().filter((f) => f.type === 'session_status').length > before)
  }
  return { s, alice, agent, client, bridge, mk, setState }
}

test('a tap answers with the item already queued; the turn starting and ending follow on GET', async (t) => {
  const { s, client, mk, setState } = await fleet(t)
  const id = (await mk()).json.item.id
  assert.equal((await s.http(`/items/${id}`, { token: client })).json.item.working, null)
  const tap = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { action: 'Go' } })
  assert.equal(tap.status, 201)
  assert.equal(tap.json.item.working.state, 'queued')
  assert.equal(tap.json.item.working.until, tap.json.item.working.since + WORKING_QUEUED_TTL_MS)
  assert.equal((await s.http(`/items/${id}`, { token: client })).json.item.working.state, 'queued')
  await new Promise((r) => setTimeout(r, 5))
  await setState('running')
  assert.equal((await s.http(`/items/${id}`, { token: client })).json.item.working.state, 'running')
  await setState('waiting')
  assert.equal((await s.http(`/items/${id}`, { token: client })).json.item.working, null)
})

test('a typed reply, a close and a reopen by the user queue too; an agent write never does', async (t) => {
  const { s, agent, client, mk } = await fleet(t)
  const id = (await mk()).json.item.id
  const agentNote = await s.http(`/items/${id}/comments`, { method: 'POST', token: agent.token, body: { body: 'Still looking' } })
  assert.equal(agentNote.json.item.working, null)
  const reply = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { body: 'Use the other branch' } })
  assert.equal(reply.json.item.working.state, 'queued')
  s.db.prepare('UPDATE items SET turn_requested_at=NULL WHERE id=?').run(id)
  const closed = await s.http(`/items/${id}/close`, { method: 'POST', token: client, body: { resolution: 'cancelled' } })
  assert.equal(closed.json.item.working.state, 'queued')
  s.db.prepare('UPDATE items SET turn_requested_at=NULL WHERE id=?').run(id)
  const reopened = await s.http(`/items/${id}/reopen`, { method: 'POST', token: client, body: {} })
  assert.equal(reopened.json.item.working.state, 'queued')
})

test('a task the user files is queued for its session; a notice Seen tap is not', async (t) => {
  const { s, agent, client } = await fleet(t)
  const filed = await s.http('/items', { method: 'POST', token: client, body: { kind: 'task', title: 'Tidy the logs', convo_id: 'c1' } })
  assert.equal(filed.status, 201); assert.equal(filed.json.item.working.state, 'queued')
  const KINDS = { 'x-matron-item-kinds': 'notice' }
  const notice = await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'notice', title: 'Key expired', convo_id: 'c1' } })
  const seen = await s.http(`/items/${notice.json.item.id}/comments`, { method: 'POST', token: client, body: { action: 'Seen' }, headers: KINDS })
  assert.equal(seen.json.item.state, 'closed'); assert.equal(seen.json.item.working, null)
})

test('a tap while the session is mid-turn reads running, then queued across the hand-off', async (t) => {
  const { s, client, mk, setState } = await fleet(t)
  const id = (await mk()).json.item.id
  await setState('running')
  await new Promise((r) => setTimeout(r, 5))
  const tap = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { action: 'Go' } })
  assert.equal(tap.json.item.working.state, 'running')
  await new Promise((r) => setTimeout(r, 5))
  await setState('waiting')
  const between = (await s.http(`/items/${id}`, { token: client })).json.item.working
  assert.equal(between.state, 'queued')
  const ended = s.db.prepare('SELECT turn_ended_at AS e FROM conversations WHERE id=?').get('c1').e
  assert.equal(between.until, ended + WORKING_HANDOFF_GRACE_MS)
  await new Promise((r) => setTimeout(r, 5))
  await setState('running')
  assert.equal((await s.http(`/items/${id}`, { token: client })).json.item.working.state, 'running')
  await setState('waiting')
  assert.equal((await s.http(`/items/${id}`, { token: client })).json.item.working, null)
})

test("another person's shared view of an item never carries `working`", async (t) => {
  const { s, alice, agent, mk, setState } = await fleet(t)
  const bob = await createUser(s.db, 'bob', 'pw')
  const link = (u, gid) => saveGithubIdentity(s.db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: `${u.name}-gh`, scopes: ['github.com/example'] }, token: `t${gid}`, now: 1 })
  link(alice, 1); link(bob, 2)
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, agentDeviceId: agent.deviceId, repo: 'github.com/example/app' })
  const id = (await mk()).json.item.id
  await setState('running')
  assert.equal(getItem(s.db, alice.id, id).working.state, 'running')
  const listed = listSharedItems(s.db, bob.id, {}).items
  assert.equal(listed.length, 1)
  assert.equal('working' in listed[0], false)
  assert.equal('working' in getSharedItem(s.db, bob.id, id), false)
})

test('a handover takes the ask with the old owner: the new session is not shown as queued for it', async (t) => {
  const { s, alice, agent, client, mk } = await fleet(t)
  const boxB = createAgent(s.db, alice.id, 'box-b')
  upsertConversation(s.db, { id: 'c2', ownerUserId: alice.id, title: 'C2', sessionState: 'waiting', agentDeviceId: boxB.deviceId })
  const item = (await mk()).json.item
  const reply = await s.http(`/items/${item.id}/comments`, { method: 'POST', token: client, body: { body: 'Over to the other session' } })
  assert.equal(reply.json.item.working.state, 'queued')
  const post = (token, path, body) => s.http(path, { method: 'POST', token, body })
  assert.equal((await post(agent.token, `/items/${item.num}/handover`, { to_convo_id: 'c2', as_convo_id: 'c1' })).status, 201)
  const acc = await post(boxB.token, `/items/${item.num}/handover/accept`, { as_convo_id: 'c2' })
  assert.equal(acc.status, 200); assert.equal(acc.json.item.origin_convo_id, 'c2')
  assert.equal((await s.http(`/items/${item.id}`, { token: client })).json.item.working, null)
})

test('an app that is not viewing the conversation still hears its turns start and end: what an item view re-reads on', async (t) => {
  const { s, client, setState } = await fleet(t)
  const app = await makeWsClient(s.base, { token: client, cursor: null })
  t.after(() => app.close())
  await app.waitFor((f) => f.op === 'hello_ok')
  const seen = (state) => app.waitFor((f) => f.kind === 'journal' && f.type === 'session_status' && f.convo_id === 'c1' && f.payload.state === state && f.live !== false && f.seq > mark)
  let mark = Math.max(0, ...app.journal().map((f) => f.seq))
  await setState('running')
  await seen('running')
  mark = Math.max(0, ...app.journal().map((f) => f.seq))
  await setState('waiting')
  await seen('waiting')
})
