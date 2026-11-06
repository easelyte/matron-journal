import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { makeWsClient } from './helpers.js'
import { world, post, grantOf, incoming, offer } from './federation-world.js'
import { applyEvent } from '../src/federation-replica.js'

// Read shares across journals, live (phase 5 stage 7c): after the snapshot,
// every write on alice's shared mission reaches bob's copy as the new state
// of the one record it changed.

async function shared(t) {
  const w = await world(t)
  const q = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'question', title: 'Tomatoes or beans?' }))).json.item
  const g = await offer(w)
  await w.phones.bob(`/grants/${incoming(w.b)[0].id}/answer`, post({ decision: 'approve' }))
  await w.settle()
  assert.equal(grantOf(w.a, g.id).state, 'active')
  return { w, g, q }
}

const events = (w) => w.a.db.prepare("SELECT body FROM fed_outbox WHERE op='mission.event' ORDER BY rowid").all().map((r) => JSON.parse(r.body))
const bobItems = async (w) => (await w.phones.bob('/items?scope=shared')).json.items
const bobMission = async (w) => (await w.phones.bob('/missions?scope=shared')).json.missions[0]

test('each write on the mission reaches the copy, and the apps are told', async (t) => {
  const { w, q } = await shared(t)
  const token = (await w.b.http('/login', post({ username: 'bob', password: 'pw', device_name: 'bob-tablet' }))).json.token
  const ws = await makeWsClient(w.b.base, { token, cursor: null })
  t.after(() => ws.close())
  await ws.waitFor((f) => f.op === 'hello_ok')
  const m = await bobMission(w)

  await w.aliceBox(`/missions/${w.mission.id}`, { method: 'PATCH', body: { status: 'Planting next week', convo_id: 'work' } })
  await w.aliceBox('/milestones', post({ convo_id: 'work', kind: 'progress', title: 'Beds dug' }))
  const task = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'task', title: 'Buy compost' }))).json.item
  await w.aliceBox(`/items/${q.id}/comments`, post({ body: 'Leaning tomatoes', convo_id: 'work' }))
  await w.aliceBox(`/items/${task.id}/close`, post({ resolution: 'done', comment: 'Bought' }))
  await w.settle()

  const after = await bobMission(w)
  assert.deepEqual([after.id, after.status, after.milestones], [m.id, 'Planting next week', 1])
  const detail = (await w.phones.bob(`/missions/${m.id}`)).json
  assert.deepEqual(detail.milestones.map((l) => l.title), ['Beds dug'])
  const items = await bobItems(w)
  assert.deepEqual(items.map((i) => [i.title, i.state]).sort(), [['Buy compost', 'closed'], ['Tomatoes or beans?', 'open']])
  const bq = items.find((i) => i.title === 'Tomatoes or beans?')
  assert.deepEqual((await w.phones.bob(`/items/${bq.id}`)).json.comments.map((c) => c.body), ['Leaning tomatoes'])
  const closed = (await w.phones.bob(`/items/${items.find((i) => i.state === 'closed').id}`)).json
  assert.deepEqual(closed.comments.map((c) => [c.kind, c.body]), [['status', 'Bought']])

  // Each event is one record, its whole state, after the snapshot.
  const kinds = events(w).map((e) => [e.kind, e.ref ? e.ref.slice(0, 3) : null])
  assert.deepEqual(kinds.map((k) => k[0]).filter((k, i, a) => a.indexOf(k) === i).sort(), ['item', 'milestone', 'mission'])
  for (const e of events(w)) {
    assert.deepEqual(Object.keys(e).filter((k) => !['grant', 'sent', 'kind', 'ref', 'record'].includes(k)), [])
    assert.ok(!JSON.stringify(e).includes('"work"') && !JSON.stringify(e).includes(w.mission.id), 'no conversation or mission id crosses')
  }
  const frame = await ws.waitFor((f) => f.kind === 'shared' && f.event === 'mission_changed' && f.what === 'item')
  assert.deepEqual([frame.mission_id, frame.owner.name], [m.id, 'alice@a.example'])
  await ws.waitFor((f) => f.kind === 'shared' && f.event === 'mission_changed' && f.what === 'milestone')
  await ws.waitFor((f) => f.kind === 'shared' && f.event === 'mission_changed' && f.what === 'mission')
})

test('an item that leaves the mission leaves the copy; one that joins it arrives', async (t) => {
  const { w, q } = await shared(t)
  assert.equal((await w.aliceBox(`/items/${q.id}`, { method: 'PATCH', body: { mission: null } })).status, 200)
  await w.settle()
  assert.deepEqual(await bobItems(w), [])
  const last = events(w).at(-1)
  assert.deepEqual(last, { grant: last.grant, sent: last.sent, kind: 'item', ref: q.id, record: null })

  assert.equal((await w.aliceBox(`/items/${q.id}`, { method: 'PATCH', body: { mission: w.mission.id } })).status, 200)
  await w.settle()
  assert.deepEqual((await bobItems(w)).map((i) => i.title), ['Tomatoes or beans?'])

  // A conversation that joins brings its unfiled items along.
  upsertConversation(w.a.db, { id: 'shed', ownerUserId: w.users.alice.id, title: 'Shed', agentDeviceId: w.a.db.prepare("SELECT id FROM devices WHERE name='alice-box'").get().id })
  await w.aliceBox('/items', post({ convo_id: 'shed', kind: 'task', title: 'Fix the shed door' }))
  assert.equal((await w.aliceBox(`/missions/${w.mission.id}/join`, post({ convo_id: 'shed' }))).status, 200)
  await w.settle()
  assert.deepEqual((await bobItems(w)).map((i) => i.title).sort(), ['Fix the shed door', 'Tomatoes or beans?'])
})

test('what the grantee view never shows sends nothing, not even its id', async (t) => {
  const { w } = await shared(t)
  const before = events(w).length
  const own = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'task', title: 'Owner only', private: true }))).json.item
  await w.aliceBox(`/items/${own.id}/comments`, post({ body: 'note to self', convo_id: 'work' }))
  const secret = createAgent(w.a.db, w.users.alice.id, 'secret-box')
  upsertConversation(w.a.db, { id: 'quiet', ownerUserId: w.users.alice.id, title: 'Quiet', agentDeviceId: secret.deviceId })
  await w.a.http(`/missions/${w.mission.id}/join`, { token: secret.token, ...post({ convo_id: 'quiet' }) })
  w.a.db.prepare("UPDATE devices SET private=1 WHERE name='secret-box'").run()
  await w.a.http('/items', { token: secret.token, ...post({ convo_id: 'quiet', kind: 'task', title: 'From the private box' }) })
  await w.a.http('/milestones', { token: secret.token, ...post({ convo_id: 'quiet', kind: 'progress', title: 'Private milestone' }) })
  const text = JSON.stringify(events(w).slice(before))
  for (const never of ['Owner only', 'note to self', 'From the private box', 'Private milestone', own.id]) assert.ok(!text.includes(never), `${never} never crosses`)
  await w.settle()
  assert.deepEqual((await bobItems(w)).map((i) => i.title), ['Tomatoes or beans?'])
})

test('once the share ends, writes send nothing', async (t) => {
  const { w, g } = await shared(t)
  assert.equal((await w.phones.alice(`/grants/${g.id}`, { method: 'DELETE' })).status, 200)
  await w.settle()
  const before = events(w).length
  await w.aliceBox('/milestones', post({ convo_id: 'work', kind: 'progress', title: 'After the end' }))
  assert.equal(events(w).length, before)
})

test('an event is applied only to a whole copy, and checked like a snapshot', async (t) => {
  const { w, q } = await shared(t)
  const r = incoming(w.b)[0]
  const item = { ref: q.id, num: q.num, kind: 'question', state: 'open', title: 'Renamed\u0007 over there', body: '', created_at: 1, updated_at: Date.now(), comments: [] }
  assert.deepEqual(applyEvent(w.b.db, r, { grant: r.peer_grant_ref, sent: r.offer_sent, kind: 'item', ref: q.id, record: item }).kind, 'item')
  assert.deepEqual((await bobItems(w)).map((i) => i.title), ['Renamed over there'])
  for (const bad of [
    { kind: 'nope', record: {} }, { kind: 'item', ref: 'gr_1', record: null }, { kind: 'item', ref: 'it_other', record: item },
    { kind: 'milestone', ref: 'ml_1', record: null }, { kind: 'mission', record: null }, { kind: 'item', ref: q.id }, { kind: 'item', ref: q.id, record: null, sent: 'x' },
  ]) {
    assert.throws(() => applyEvent(w.b.db, r, { grant: r.peer_grant_ref, sent: r.offer_sent, ...bad }), /malformed/, JSON.stringify(bad))
  }
  // No whole copy yet: dropped.
  w.b.db.prepare('UPDATE fed_replica_missions SET complete=0').run()
  assert.equal(applyEvent(w.b.db, r, { grant: r.peer_grant_ref, sent: r.offer_sent, kind: 'item', ref: q.id, record: null }), null)
  w.b.db.prepare('UPDATE fed_replica_missions SET complete=1').run()
  // From an earlier offer of the same grant: dropped.
  assert.equal(applyEvent(w.b.db, r, { grant: r.peer_grant_ref, sent: r.offer_sent - 1, kind: 'item', ref: q.id, record: null }), null)
  assert.equal((await bobItems(w)).length, 1)
})

test('a comment keeps its id on the copy as its item changes', async (t) => {
  const { w, q } = await shared(t)
  await w.aliceBox(`/items/${q.id}/comments`, post({ body: 'First thought', convo_id: 'work' }))
  await w.settle()
  const [bq] = await bobItems(w)
  const ids = (await w.phones.bob(`/items/${bq.id}`)).json.comments.map((c) => c.id)
  await w.aliceBox(`/items/${q.id}`, { method: 'PATCH', body: { title: 'Tomatoes, beans or peas?' } })
  await w.aliceBox(`/items/${q.id}/comments`, post({ body: 'Second thought', convo_id: 'work' }))
  await w.settle()
  const after = (await w.phones.bob(`/items/${bq.id}`)).json
  assert.equal(after.item.title, 'Tomatoes, beans or peas?')
  assert.deepEqual(after.comments.map((c) => c.body), ['First thought', 'Second thought'])
  assert.equal(after.comments[0].id, ids[0])
})

test('an event whose box turned private while it waited is not sent', async (t) => {
  const { w } = await shared(t)
  const box = createAgent(w.a.db, w.users.alice.id, 'shed-box')
  upsertConversation(w.a.db, { id: 'shed', ownerUserId: w.users.alice.id, title: 'Shed', agentDeviceId: box.deviceId })
  await w.a.http(`/missions/${w.mission.id}/join`, { token: box.token, ...post({ convo_id: 'shed' }) })
  await w.settle()
  // Hold the share's queue: an earlier event at its head, not yet due.
  await w.aliceBox(`/missions/${w.mission.id}`, { method: 'PATCH', body: { status: 'Held', convo_id: 'work' } })
  w.a.db.prepare("UPDATE fed_outbox SET next_at=? WHERE rowid=(SELECT MAX(rowid) FROM fed_outbox WHERE op='mission.event')").run(Date.now() + 3600_000)
  await w.a.http('/items', { token: box.token, ...post({ convo_id: 'shed', kind: 'task', title: 'Before it went private' }) })
  assert.ok(events(w).some((e) => e.record?.title === 'Before it went private'), 'queued while the box was ordinary')
  w.a.db.prepare("UPDATE devices SET private=1 WHERE name='shed-box'").run()
  w.a.db.prepare("UPDATE fed_outbox SET next_at=0 WHERE state='queued'").run()
  await w.settle()
  assert.equal((await bobMission(w)).status, 'Held')
  assert.deepEqual((await bobItems(w)).map((i) => i.title), ['Tomatoes or beans?'])
})
