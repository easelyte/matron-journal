import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'

// alice: client 'mac' + agent box-2 with two conversations. c1 owns the item;
// c2 is another agent conversation commenting on it.
async function fleet(t, clock) {
  const wakeCalls = []
  const waker = { enabled: true, wake: (name) => wakeCalls.push(name) }
  const s = await startTestServer({ waker, agentCommentClock: () => clock.now })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-2')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'c2', ownerUserId: alice.id, title: 'C2 commenter', agentDeviceId: agent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  const made = await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'question', title: 'Which auth?', convo_id: 'c1', body: 'A or B?' } })
  return { s, alice, agent, client: login.json.token, item: made.json.item, wakeCalls }
}

const lastMarker = (s) => {
  const row = s.db.prepare("SELECT sender, payload FROM events WHERE type='item' ORDER BY seq DESC LIMIT 1").get()
  return { sender: row.sender, ...JSON.parse(row.payload) }
}

test('foreign agent comment: flagged marker, owner woken, then rate-limited, then delivered again', async (t) => {
  const clock = { now: 1_000_000 }
  const { s, agent, item, wakeCalls } = await fleet(t, clock)
  const post = (body, extra = {}, headers = {}) =>
    s.http(`/items/${item.id}/comments`, { method: 'POST', token: agent.token, headers, body: { body, ...extra } })

  wakeCalls.length = 0
  const first = await post('hello owner', { as_convo_id: 'c2' })
  assert.equal(first.status, 201)
  assert.equal(first.json.owner_notified, true)
  assert.equal('owner_notice' in first.json, false)
  const m = lastMarker(s)
  assert.equal(m.sender, 'agent:box-2')
  assert.equal(m.action, 'commented')
  assert.equal(m.agent_comment, true)
  assert.equal(m.from_convo_id, 'c2')
  assert.equal(m.from_label, 'C2 commenter')
  assert.deepEqual(wakeCalls, ['box-2'])

  // Inside 30 s: stored and announced, but unflagged and not woken.
  clock.now += 10_000
  wakeCalls.length = 0
  const second = await post('again', { as_convo_id: 'c2' })
  assert.equal(second.status, 201)
  assert.equal(second.json.owner_notified, false)
  assert.match(second.json.owner_notice, /^The owner session will not be notified of this comment: rate-limited/)
  assert.equal(lastMarker(s).agent_comment, undefined)
  assert.deepEqual(wakeCalls, [])

  // After the window it is delivered again.
  clock.now += 31_000
  const third = await post('later', { as_convo_id: 'c2' })
  assert.equal(third.json.owner_notified, true)
  assert.equal(lastMarker(s).agent_comment, true)

  // A replayed idempotency key answers without the owner fields.
  clock.now += 31_000
  const k = { 'idempotency-key': 'k-1' }
  const a = await post('idem', { as_convo_id: 'c2' }, k)
  const b = await post('idem', { as_convo_id: 'c2' }, k)
  assert.equal(a.json.owner_notified, true)
  assert.equal('owner_notified' in b.json, false)
})

test('per-item cap: six delivered comments per 10 minutes across commenters', async (t) => {
  const clock = { now: 1_000_000 }
  const { s, agent, item } = await fleet(t, clock)
  const post = (as) => s.http(`/items/${item.id}/comments`, { method: 'POST', token: agent.token, body: { body: 'x', as_convo_id: as } })
  for (let i = 0; i < 6; i++) {
    clock.now += 31_000
    assert.equal((await post('c2')).json.owner_notified, true)
  }
  clock.now += 31_000
  const over = await post('c2')
  assert.equal(over.json.owner_notified, false)
  assert.match(over.json.owner_notice, /rate-limited/)
  clock.now += 10 * 60_000
  assert.equal((await post('c2')).json.owner_notified, true)
})

test('no flag, no wake, no owner fields: owner own comment; missing as_convo_id; user comment', async (t) => {
  const clock = { now: 1_000_000 }
  const { s, agent, client, item, wakeCalls } = await fleet(t, clock)
  const url = `/items/${item.id}/comments`
  wakeCalls.length = 0

  const own = await s.http(url, { method: 'POST', token: agent.token, body: { body: 'mine', as_convo_id: 'c1' } })
  assert.equal(own.status, 201)
  assert.equal('owner_notified' in own.json, false)
  assert.equal(lastMarker(s).agent_comment, undefined)
  assert.deepEqual(wakeCalls, [])

  const anon = await s.http(url, { method: 'POST', token: agent.token, body: { body: 'who?' } })
  assert.equal(anon.status, 201)
  assert.equal(anon.json.owner_notified, false)
  assert.match(anon.json.owner_notice, /commenter conversation unknown \(as_convo_id not sent\)/)
  assert.equal(lastMarker(s).agent_comment, undefined)
  assert.deepEqual(wakeCalls, [])

  const user = await s.http(url, { method: 'POST', token: client, body: { body: 'hi' } })
  assert.equal(user.status, 201)
  assert.equal('owner_notified' in user.json, false)
  assert.equal(lastMarker(s).agent_comment, undefined)
})

test('private commenter: owner is flagged and woken, but the marker names no conversation', async (t) => {
  const clock = { now: 1_000_000 }
  const { s, alice, item, wakeCalls } = await fleet(t, clock)
  const priv = createAgent(s.db, alice.id, 'priv-box')
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(priv.deviceId)
  upsertConversation(s.db, { id: 'cp', ownerUserId: alice.id, title: 'Secret plans', agentDeviceId: priv.deviceId })
  wakeCalls.length = 0
  const r = await s.http(`/items/${item.id}/comments`, { method: 'POST', token: priv.token, body: { body: 'psst', as_convo_id: 'cp' } })
  assert.equal(r.status, 201)
  assert.equal(r.json.owner_notified, true)
  const m = lastMarker(s)
  assert.equal(m.agent_comment, true)
  assert.equal('from_convo_id' in m, false)
  assert.equal('from_label' in m, false)
  assert.equal(JSON.stringify(m).includes('Secret plans'), false)
  assert.equal(JSON.stringify(m).includes('"cp"'), false)
  assert.deepEqual(wakeCalls, ['box-2'])
})

test('owner conversation without any agent: not notified, no limiter slot taken', async (t) => {
  const clock = { now: 1_000_000 }
  const { s, alice, agent } = await fleet(t, clock)
  upsertConversation(s.db, { id: 'c3', ownerUserId: alice.id, title: 'No agent', agentDeviceId: agent.deviceId })
  const made = await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'question', title: 'Q', convo_id: 'c3', body: 'b' } })
  const url = `/items/${made.json.item.id}/comments`
  s.db.prepare('UPDATE conversations SET agent_device_id=NULL WHERE id=?').run('c3')
  const r = await s.http(url, { method: 'POST', token: agent.token, body: { body: 'hi', as_convo_id: 'c2' } })
  assert.equal(r.status, 201)
  assert.equal(r.json.owner_notified, false)
  assert.match(r.json.owner_notice, /owner conversation unavailable/)
  assert.equal(lastMarker(s).agent_comment, undefined)
  // The slot was not spent: once an agent is assigned, the same pair is delivered at once.
  s.db.prepare('UPDATE conversations SET agent_device_id=? WHERE id=?').run(agent.deviceId, 'c3')
  const r2 = await s.http(url, { method: 'POST', token: agent.token, body: { body: 'again', as_convo_id: 'c2' } })
  assert.equal(r2.json.owner_notified, true)
})

test('failed marker emission: not reported as notified, slot released for a retry', async (t) => {
  const clock = { now: 1_000_000 }
  const { s, agent, item, wakeCalls } = await fleet(t, clock)
  const url = `/items/${item.id}/comments`
  s.db.exec("CREATE TRIGGER no_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'boom'); END")
  wakeCalls.length = 0
  const origErr = console.error
  console.error = () => {}
  let r
  try { r = await s.http(url, { method: 'POST', token: agent.token, body: { body: 'lost?', as_convo_id: 'c2' } }) } finally { console.error = origErr }
  assert.equal(r.status, 201)
  assert.equal(r.json.owner_notified, false)
  assert.match(r.json.owner_notice, /could not be recorded/)
  assert.deepEqual(wakeCalls, [])
  s.db.exec('DROP TRIGGER no_events')
  // No clock advance: the released slot lets the retry through.
  const retry = await s.http(url, { method: 'POST', token: agent.token, body: { body: 'retry', as_convo_id: 'c2' } })
  assert.equal(retry.json.owner_notified, true)
  assert.deepEqual(wakeCalls, ['box-2'])
})

test('from_label drops bidi and zero-width controls and flattens double quotes', async (t) => {
  const clock = { now: 1_000_000 }
  const { s, alice, agent, item } = await fleet(t, clock)
  upsertConversation(s.db, { id: 'c4', ownerUserId: alice.id, title: 'ok‮"evil"⁦ title​', agentDeviceId: agent.deviceId })
  const r = await s.http(`/items/${item.id}/comments`, { method: 'POST', token: agent.token, body: { body: 'hi', as_convo_id: 'c4' } })
  assert.equal(r.status, 201)
  assert.equal(lastMarker(s).from_label, "ok'evil' title")
})
