import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'
import { recordJoined } from '../src/participants.js'
import { closeItem } from '../src/items.js'

// Fleet: dan (client 'mac' + agent dev-2 managing c1), pat (own agent, own convo).
async function fleet(t, serverOpts = {}) {
  const calls = []
  const waker = { enabled: true, wake: (name) => calls.push(name) }
  const s = await startTestServer({ waker, ...serverOpts })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  const patAgent = createAgent(s.db, pat.id, 'pat-box')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'c2', ownerUserId: dan.id, title: 'C2', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, title: 'P1', agentDeviceId: patAgent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  return { s, dan, pat, agent, patAgent, client: login.json.token, clientDeviceId: login.json.device_id, wakeCalls: calls }
}

const mkItem = (s, token, body) => s.http('/items', { method: 'POST', token, body: { kind: 'question', title: 'Which auth?', convo_id: 'c1', ...body } })

// Same stub shape push.test.js uses: records every send, always succeeds.
function makeStubApnsClient() {
  const calls = []
  return { calls, send(opts) { calls.push(opts); return Promise.resolve({ status: 200, reason: null }) } }
}

test('POST /items: agent creates a question in its convo; marker fans out to the client; 400s on junk', async (t) => {
  const { s, agent, client } = await fleet(t)
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await mkItem(s, agent.token, { body: 'A or B?', labels: ['auth'] })
  assert.equal(r.status, 201)
  assert.equal(r.json.item.num, 1); assert.equal(r.json.item.awaiting, 'user'); assert.equal(r.json.item.created_by, 'agent')
  assert.equal(r.json.item.origin_convo_id, 'c1')
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item')
  assert.equal(marker.convo_id, 'c1'); assert.equal(marker.sender, 'agent:dev-2')
  assert.equal(marker.payload.action, 'created'); assert.equal(marker.payload.num, 1); assert.equal(marker.payload.by, 'agent')
  assert.equal(marker.payload.awaiting, 'user')
  ws.close()
  assert.equal((await mkItem(s, agent.token, { kind: 'nope' })).status, 400)
  assert.equal((await mkItem(s, agent.token, { title: '' })).status, 400)
  assert.equal((await mkItem(s, agent.token, { convo_id: 'p1' })).status, 404) // not ours
  assert.equal((await mkItem(s, agent.token, { convo_id: 'nope' })).status, 404)
  assert.equal((await mkItem(s, agent.token, { after: 'it_nope' })).status, 400)
  assert.equal((await mkItem(s, agent.token, { supersedes: 'it_nope' })).status, 400)
  assert.equal((await mkItem(s, agent.token, { awaiting: 'nobody' })).status, 400)
  assert.equal((await mkItem(s, agent.token, { position: 'middle' })).status, 400)
  assert.equal((await s.http('/items', { method: 'POST', token: agent.token, body: [] })).status, 400)
  const noAuth = await s.http('/items', { method: 'POST', body: { kind: 'task', title: 'x', convo_id: 'c1' } })
  assert.equal(noAuth.status, 401); assert.equal(noAuth.json.error, 'unauthenticated')
  // Exactly one marker: only the successful create emitted one.
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item'").get().n, 1)
})

test('POST /items: client creates a task, agent gets woken, marker sender is user:dan', async (t) => {
  const { s, client, agent, wakeCalls } = await fleet(t)
  const aws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await aws.waitFor((f) => f.op === 'hello_ok')
  aws.close()
  await new Promise((r) => setTimeout(r, 50)) // let the socket drop so the box counts as offline
  const r = await mkItem(s, client, { kind: 'task', title: 'Do X' })
  assert.equal(r.status, 201); assert.equal(r.json.item.created_by, 'user'); assert.equal(r.json.item.awaiting, 'agent')
  assert.deepEqual(wakeCalls, ['dev-2'])
  const ev = s.db.prepare("SELECT sender, payload FROM events WHERE type='item' ORDER BY seq DESC LIMIT 1").get()
  assert.equal(ev.sender, 'user:dan')
  assert.equal(JSON.parse(ev.payload).by, 'user')
})

test('POST /items on_behalf_of: agent files a user-created task; clients may not send the field', async (t) => {
  const { s, agent, client, wakeCalls } = await fleet(t)
  const r = await mkItem(s, agent.token, { kind: 'task', title: 'From queue', on_behalf_of: 'user' })
  assert.equal(r.status, 201); assert.equal(r.json.item.created_by, 'user')
  const ev = s.db.prepare("SELECT sender, payload FROM events WHERE type='item' ORDER BY seq DESC LIMIT 1").get()
  assert.equal(ev.sender, 'agent:dev-2'); assert.equal(JSON.parse(ev.payload).by, 'user')
  assert.equal(wakeCalls.length, 0)
  // A question filed FOR the user is a question asked OF the agent: it takes
  // the user-created default (awaiting the agent), not the kind default.
  const q = await mkItem(s, agent.token, { on_behalf_of: 'user' })
  assert.equal(q.status, 201); assert.equal(q.json.item.created_by, 'user'); assert.equal(q.json.item.awaiting, 'agent')
  assert.equal((await mkItem(s, client, { on_behalf_of: 'user' })).status, 400)
  assert.equal((await mkItem(s, agent.token, { on_behalf_of: 'agent' })).status, 400)
  // A body-only rule is settled before the conversation is looked up, so a
  // client sending the field never learns whether that convo exists.
  assert.equal((await mkItem(s, client, { on_behalf_of: 'user', convo_id: 'nope' })).status, 400)
})

test('POST /items idempotency header', async (t) => {
  const { s, agent } = await fleet(t)
  const a = await s.http('/items', { method: 'POST', token: agent.token, headers: { 'idempotency-key': 'k1' }, body: { kind: 'task', title: 'T', convo_id: 'c1' } })
  const b = await s.http('/items', { method: 'POST', token: agent.token, headers: { 'idempotency-key': 'k1' }, body: { kind: 'task', title: 'T2', convo_id: 'c1' } })
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(b.json.item.id, a.json.item.id)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item'").get().n, 1)
})

test('GET /items and GET /items/:id: filters, #num, other user 404, comments included', async (t) => {
  const { s, agent, client, pat, patAgent } = await fleet(t)
  await mkItem(s, agent.token, {})
  await mkItem(s, agent.token, { kind: 'task', title: 'T', convo_id: 'c2' })
  await s.http('/items', { method: 'POST', token: patAgent.token, body: { kind: 'task', title: 'P', convo_id: 'p1' } })
  const all = await s.http('/items', { token: client })
  assert.equal(all.status, 200); assert.equal(all.json.items.length, 2)
  assert.equal((await s.http('/items?convo=c2', { token: client })).json.items.length, 1)
  assert.equal((await s.http('/items?awaiting=user', { token: client })).json.items.length, 1)
  assert.equal((await s.http('/items?kind=bogus', { token: client })).status, 400)
  assert.equal((await s.http('/items?limit=0', { token: client })).status, 400)
  assert.equal((await s.http('/items?cursor=!!', { token: client })).status, 400)
  const one = await s.http('/items/%231', { token: client })
  assert.equal(one.status, 200); assert.equal(one.json.item.num, 1); assert.deepEqual(one.json.comments, [])
  assert.equal((await s.http(`/items/${all.json.items[0].id}`, { token: patAgent.token })).status, 404)
  assert.equal((await s.http('/items/it_nope', { token: client })).status, 404)
  void pat
})

test('GET /items: query validation, updated sort, cursor paging', async (t) => {
  const { s, agent, client } = await fleet(t)
  for (const title of ['one', 'two', 'three']) await mkItem(s, agent.token, { title })
  for (const q of ['state=bogus', 'awaiting=nobody', 'sort=sideways', 'since=abc', 'since=-1', 'limit=abc', 'limit=1.5', 'label=']) {
    const r = await s.http(`/items?${q}`, { token: client })
    assert.equal(r.status, 400, q); assert.equal(r.json.error, 'bad_request')
  }
  assert.equal((await s.http('/items?kind=question&state=open&awaiting=user&sort=rank&since=0&label=none', { token: client })).status, 200)
  const page1 = await s.http('/items?limit=2', { token: client })
  assert.deepEqual(page1.json.items.map((i) => i.num), [1, 2])
  assert.ok(page1.json.next_cursor)
  const page2 = await s.http(`/items?limit=2&cursor=${encodeURIComponent(page1.json.next_cursor)}`, { token: client })
  assert.deepEqual(page2.json.items.map((i) => i.num), [3])
  assert.equal(page2.json.next_cursor, null)
  const byUpdated = await s.http('/items?sort=updated', { token: client })
  assert.deepEqual(byUpdated.json.items.map((i) => i.num), [3, 2, 1])
})

test('privacy sieve: an ordinary agent cannot see items born in a private device\'s convo; clients and private agents can', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  const made = await s.http('/items', { method: 'POST', token: priv.token, body: { kind: 'decision', title: 'Hidden', convo_id: 'secret' } })
  assert.equal(made.status, 201)
  assert.equal((await s.http('/items', { token: agent.token })).json.items.length, 0)
  assert.equal((await s.http(`/items/${made.json.item.id}`, { token: agent.token })).status, 404)
  assert.equal((await s.http('/items', { token: client })).json.items.length, 1)
  assert.equal((await s.http('/items', { token: priv.token })).json.items.length, 1)
  // ...and an ordinary agent cannot FILE into a private convo either.
  const filed = await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'task', title: 'sneak', convo_id: 'secret' } })
  assert.equal(filed.status, 404); assert.equal(filed.json.error, 'not_found')
})

test('PATCH /items/:id updates fields and emits one updated marker; awaiting validated; attachments rejected', async (t) => {
  const { s, agent, client, wakeCalls } = await fleet(t)
  const made = await mkItem(s, agent.token, {})
  const id = made.json.item.id
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const before = s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item'").get().n
  const r = await s.http(`/items/${id}`, { method: 'PATCH', token: client, body: { title: 'Renamed', awaiting: 'agent' } })
  assert.equal(r.status, 200); assert.equal(r.json.item.title, 'Renamed'); assert.equal(r.json.item.awaiting, 'agent')
  // Every mutating route appends a marker — a PATCH included.
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'updated')
  assert.equal(marker.convo_id, 'c1'); assert.equal(marker.sender, 'user:dan')
  assert.equal(marker.payload.title, 'Renamed'); assert.equal(marker.payload.awaiting, 'agent')
  assert.equal(marker.payload.by, 'user'); assert.equal(marker.payload.comment, undefined)
  ws.close()
  assert.equal((await s.http(`/items/${id}`, { method: 'PATCH', token: client, body: { awaiting: 'nobody' } })).status, 400)
  assert.equal((await s.http(`/items/${id}`, { method: 'PATCH', token: client, body: { title: '' } })).status, 400)
  assert.equal((await s.http(`/items/${id}`, { method: 'PATCH', token: client, body: {} })).status, 400)
  // Attachments are a create-only field (v1): silently dropping them told a
  // client its blob had landed, so an attempt is refused outright.
  const att = await s.http(`/items/${id}`, { method: 'PATCH', token: client, body: { title: 'With blob', attachments: [{ blob_ref: 'b1', mime: 'image/png', name: 'a.png', size: 3 }] } })
  assert.equal(att.status, 400); assert.equal(att.json.error, 'bad_request')
  assert.equal((await s.http(`/items/${id}`, { method: 'PATCH', token: client, body: { attachments: [] } })).status, 400)
  assert.equal((await s.http(`/items/${id}`, { token: client })).json.item.title, 'Renamed') // the rejected patch changed nothing
  assert.equal((await s.http('/items/it_nope', { method: 'PATCH', token: client, body: { title: 'X' } })).status, 404)
  // Exactly one marker for the one successful patch; no failed patch added one.
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item'").get().n, before + 1)
  assert.equal(wakeCalls.length, 0) // 'updated' is not a wake action
})

test('PATCH /items/:id: awaiting on a closed item is a conflict, clearing it is not', async (t) => {
  const { s, dan, agent, client, wakeCalls } = await fleet(t)
  const made = await mkItem(s, agent.token, {})
  const id = made.json.item.id
  closeItem(s.db, { userId: dan.id, itemId: id, resolution: 'answered', author: 'agent', deviceId: agent.deviceId })
  const bad = await s.http(`/items/${id}`, { method: 'PATCH', token: client, body: { awaiting: 'agent' } })
  assert.equal(bad.status, 409); assert.equal(bad.json.error, 'conflict')
  const ok = await s.http(`/items/${id}`, { method: 'PATCH', token: client, body: { title: 'Still closed', awaiting: null } })
  assert.equal(ok.status, 200); assert.equal(ok.json.item.state, 'closed'); assert.equal(ok.json.item.awaiting, null)
  assert.equal(wakeCalls.length, 0) // an edit is not traffic for the box
})

test('POST /items: an agent may only file into a conversation it owns or has joined', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const other = createAgent(s.db, dan.id, 'dev-3')
  upsertConversation(s.db, { id: 'c3', ownerUserId: dan.id, title: 'C3', agentDeviceId: other.deviceId })
  const foreign = await mkItem(s, agent.token, { convo_id: 'c3', title: 'Not mine' })
  assert.equal(foreign.status, 404); assert.equal(foreign.json.error, 'not_found')
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item'").get().n, 0)
  // The managing box may, and so may a joined participant...
  assert.equal((await mkItem(s, other.token, { convo_id: 'c3', title: 'Mine' })).status, 201)
  recordJoined(s.db, { convoId: 'c3', agentDeviceId: agent.deviceId, initiatorDeviceId: other.deviceId })
  assert.equal((await mkItem(s, agent.token, { convo_id: 'c3', title: 'Joined' })).status, 201)
  // ...and the write gate never applies to the user's own client.
  assert.equal((await mkItem(s, client, { convo_id: 'c3', title: 'Dan\'s' })).status, 201)
})

test('POST /items: a malformed Idempotency-Key is rejected, never silently ignored', async (t) => {
  const { s, agent } = await fleet(t)
  const post = (key) => s.http('/items', { method: 'POST', token: agent.token, headers: { 'idempotency-key': key }, body: { kind: 'task', title: 'T', convo_id: 'c1' } })
  assert.equal((await post('')).status, 400)
  assert.equal((await post('k'.repeat(129))).status, 400)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0)
  assert.equal((await post('k'.repeat(128))).status, 201)
})

test('a junk sub-path is never treated as the item itself', async (t) => {
  const { s, agent, client } = await fleet(t)
  const id = (await mkItem(s, agent.token, {})).json.item.id
  assert.equal((await s.http(`/items/${id}/commentz`, { token: client })).status, 404)
  assert.equal((await s.http(`/items/${id}/anything`, { method: 'PATCH', token: client, body: { title: 'Hijacked' } })).status, 404)
  assert.equal((await s.http(`/items/${id}/comments/ic_1/extra`, { token: client })).status, 404)
  assert.equal((await s.http(`/items/${id}`, { token: client })).json.item.title, 'Which auth?')
})

test('oversized item body gets 413 and no item is written', async (t) => {
  const { s, agent } = await fleet(t)
  // Same idiom as http.test.js's login case: the 413 closes the connection,
  // so a socket-level failure instead of a response is an acceptable outcome.
  const big = JSON.stringify({ kind: 'task', title: 'T', convo_id: 'c1', body: 'x'.repeat(1_100_000) })
  const r = await fetch(`${s.base}/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${agent.token}` },
    body: big,
  }).catch(() => null)
  if (r) assert.equal(r.status, 413)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0)
  assert.equal((await s.http('/items', { token: agent.token })).status, 200)
})

test('push: a new item awaiting the user alerts the client; a user-authored one does not', async (t) => {
  const stub = makeStubApnsClient()
  const { s, agent, client } = await fleet(t, { apnsClient: stub })
  assert.equal((await s.http('/push/register', { method: 'POST', token: client, body: { apns_token: 'phone-token', environment: 'prod' } })).status, 200)
  assert.equal((await mkItem(s, agent.token, {})).status, 201)
  await new Promise((r) => setTimeout(r, 50))
  const alerts = stub.calls.filter((c) => c.deviceToken === 'phone-token' && c.payload.aps.alert)
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].payload.aps.alert.title, 'C1')
  assert.equal(alerts[0].payload.aps.alert.body, '❓ #1 Which auth?')
  // The user's own task (awaiting the agent) must not ring the user's pocket.
  assert.equal((await mkItem(s, client, { kind: 'task', title: 'Mine' })).status, 201)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(stub.calls.filter((c) => c.deviceToken === 'phone-token' && c.payload.aps.alert).length, 1)
})

test('comments: user comment flips awaiting, emits a commented marker with the body, wakes the box', async (t) => {
  const { s, agent, client, wakeCalls } = await fleet(t)
  const made = await mkItem(s, agent.token, {})
  const id = made.json.item.id
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { body: 'use A', attachments: [{ blob_ref: 'b1', mime: 'audio/mp4', name: 'v.m4a', size: 3 }] } })
  assert.equal(r.status, 201); assert.equal(r.json.item.awaiting, 'agent'); assert.equal(r.json.comment.attachments[0].blob_ref, 'b1')
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'commented')
  assert.equal(marker.sender, 'user:dan'); assert.equal(marker.payload.comment.body, 'use A'); assert.equal(marker.payload.awaiting, 'agent')
  assert.equal(marker.payload.comment.attachments[0].transcript, null)
  ws.close()
  assert.deepEqual(wakeCalls, ['dev-2'])
  assert.equal((await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: {} })).status, 400)
  assert.equal((await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { body: 'x'.repeat(32769) } })).status, 400)
  // agent comment: no wake, awaiting unchanged
  const a = await s.http(`/items/${id}/comments`, { method: 'POST', token: agent.token, body: { body: 'noted' } })
  assert.equal(a.status, 201); assert.equal(a.json.item.awaiting, 'agent'); assert.equal(wakeCalls.length, 1)
})

test('comments idempotency and transcript patch (agent-only)', async (t) => {
  const { s, agent, client } = await fleet(t)
  const id = (await mkItem(s, agent.token, {})).json.item.id
  const h = { 'idempotency-key': 'c-1' }
  const a = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, headers: h, body: { body: 'x', attachments: [{ blob_ref: 'b1', mime: 'audio/mp4', name: 'v', size: 1 }] } })
  const b = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, headers: h, body: { body: 'y' } })
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(b.json.comment.id, a.json.comment.id)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item' AND payload LIKE '%commented%'").get().n, 1)
  const cid = a.json.comment.id
  assert.equal((await s.http(`/items/${id}/comments/${cid}`, { method: 'PATCH', token: client, body: { blob_ref: 'b1', transcript: 'hi' } })).status, 403)
  const p = await s.http(`/items/${id}/comments/${cid}`, { method: 'PATCH', token: agent.token, body: { blob_ref: 'b1', transcript: 'hi' } })
  assert.equal(p.status, 200); assert.equal(p.json.comment.attachments[0].transcript, 'hi')
  assert.equal((await s.http(`/items/${id}/comments/${cid}`, { method: 'PATCH', token: agent.token, body: { blob_ref: 'zz', transcript: 'hi' } })).status, 404)
  assert.equal((await s.http(`/items/${id}/comments/${cid}`, { method: 'PATCH', token: agent.token, body: { blob_ref: 'b1' } })).status, 400)
})

test('close / reopen: state machine, 409s, markers, agent close does not wake', async (t) => {
  const { s, agent, client, wakeCalls } = await fleet(t)
  const id = (await mkItem(s, agent.token, {})).json.item.id
  const c = await s.http(`/items/${id}/close`, { method: 'POST', token: agent.token, body: { resolution: 'answered', comment: 'done' } })
  assert.equal(c.status, 200); assert.equal(c.json.item.state, 'closed'); assert.equal(c.json.comment.kind, 'status')
  assert.equal((await s.http(`/items/${id}/close`, { method: 'POST', token: agent.token, body: { resolution: 'answered' } })).status, 409)
  assert.equal((await s.http(`/items/${id}/close`, { method: 'POST', token: agent.token, body: { resolution: 'meh' } })).status, 400)
  assert.equal(wakeCalls.length, 0)
  const r = await s.http(`/items/${id}/reopen`, { method: 'POST', token: client, body: { comment: 'not yet' } })
  assert.equal(r.status, 200); assert.equal(r.json.item.state, 'open'); assert.equal(r.json.item.awaiting, 'user')
  assert.equal(wakeCalls.length, 1)
  assert.equal((await s.http(`/items/${id}/reopen`, { method: 'POST', token: client, body: {} })).status, 409)
  const actions = s.db.prepare("SELECT payload FROM events WHERE type='item' ORDER BY seq").all().map((e) => JSON.parse(e.payload).action)
  assert.deepEqual(actions, ['created', 'closed', 'reopened'])
})

test('rank: reorder emits a silent reordered marker and never wakes', async (t) => {
  const { s, agent, client, wakeCalls } = await fleet(t)
  const a = (await mkItem(s, agent.token, { kind: 'task', title: 'A' })).json.item
  const b = (await mkItem(s, agent.token, { kind: 'task', title: 'B' })).json.item
  const r = await s.http(`/items/${b.id}/rank`, { method: 'POST', token: client, body: { position: 'top' } })
  assert.equal(r.status, 200); assert.ok(r.json.item.rank < a.rank)
  assert.equal(wakeCalls.length, 0)
  assert.equal((await s.http(`/items/${b.id}/rank`, { method: 'POST', token: client, body: { after: b.id } })).status, 400)
  assert.equal((await s.http(`/items/${b.id}/rank`, { method: 'POST', token: client, body: {} })).status, 400)
  const last = JSON.parse(s.db.prepare("SELECT payload FROM events WHERE type='item' ORDER BY seq DESC LIMIT 1").get().payload)
  assert.equal(last.action, 'reordered')
})

// Old-client fallback (spec: "Old-client fallback"). The journal mirrors
// every card-worthy marker as a flagged `text` event right after it, same
// convo, same sender, so a pre-tracker client (which can't render `item` at
// all) still sees the traffic. `reordered` produces no such text.
test('fallback text: mirrors created/closed/commented markers, skips reordered', async (t) => {
  const { s, agent, client } = await fleet(t)
  const rows = () => s.db.prepare("SELECT type, sender, payload FROM events ORDER BY seq").all()
    .map((e) => ({ type: e.type, sender: e.sender, payload: JSON.parse(e.payload) }))

  const created = await mkItem(s, agent.token, { body: 'we have two' })
  const id = created.json.item.id
  assert.equal(created.json.item.awaiting, 'user')
  let evs = rows()
  const marker1 = evs.at(-2)
  const fb1 = evs.at(-1)
  assert.equal(marker1.type, 'item'); assert.equal(marker1.payload.action, 'created')
  assert.equal(fb1.type, 'text'); assert.equal(fb1.sender, marker1.sender)
  assert.equal(fb1.payload.fallback_for, 'item')
  assert.equal(fb1.payload.item_id, id); assert.equal(fb1.payload.num, created.json.item.num)
  assert.equal(fb1.payload.action, 'created')
  assert.ok(fb1.payload.body.startsWith('📌 Needs you — '))

  // rank: no fallback text at all — only the marker.
  const before = rows().length
  await s.http(`/items/${id}/rank`, { method: 'POST', token: client, body: { position: 'top' } })
  evs = rows()
  assert.equal(evs.length, before + 1)
  assert.equal(evs.at(-1).type, 'item'); assert.equal(evs.at(-1).payload.action, 'reordered')

  // close: fallback text with the ✅ shape.
  const c = await s.http(`/items/${id}/close`, { method: 'POST', token: agent.token, body: { resolution: 'answered' } })
  assert.equal(c.status, 200)
  evs = rows()
  const closeFb = evs.at(-1)
  assert.equal(closeFb.type, 'text'); assert.equal(closeFb.payload.fallback_for, 'item'); assert.equal(closeFb.payload.action, 'closed')
  assert.ok(closeFb.payload.body.startsWith('✅ '))

  // reopen by the user: fallback text sender is user:dan.
  const r = await s.http(`/items/${id}/reopen`, { method: 'POST', token: client, body: {} })
  assert.equal(r.status, 200)
  evs = rows()
  const reopenFb = evs.at(-1)
  assert.equal(reopenFb.type, 'text'); assert.equal(reopenFb.sender, 'user:dan'); assert.equal(reopenFb.payload.action, 'reopened')

  // a user comment produces a fallback text with a user: sender too.
  const cm = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { body: 'thanks' } })
  assert.equal(cm.status, 201)
  evs = rows()
  const commentMarker = evs.at(-2)
  const commentFb = evs.at(-1)
  assert.equal(commentMarker.type, 'item'); assert.equal(commentMarker.payload.action, 'commented')
  assert.equal(commentFb.type, 'text'); assert.equal(commentFb.sender, 'user:dan'); assert.equal(commentFb.payload.action, 'commented')
})

test('sub-routes on a foreign or hidden item are 404, never 403', async (t) => {
  const { s, agent, patAgent } = await fleet(t)
  const id = (await mkItem(s, agent.token, {})).json.item.id
  for (const sub of ['comments', 'close', 'reopen', 'rank']) {
    assert.equal((await s.http(`/items/${id}/${sub}`, { method: 'POST', token: patAgent.token, body: { resolution: 'done', body: 'x', position: 'top' } })).status, 404)
  }
})

test('sub-routes: any agent that can see an item may write to it; create and transcript stay gated', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const other = createAgent(s.db, dan.id, 'dev-3')
  upsertConversation(s.db, { id: 'c3', ownerUserId: dan.id, title: 'C3', agentDeviceId: other.deviceId })
  const id = (await s.http('/items', { method: 'POST', token: other.token, body: { kind: 'task', title: 'Theirs', convo_id: 'c3' } })).json.item.id
  // dev-2 may SEE it (same user, nothing private) — and, per the new rule,
  // may write to it too, even though it never joined c3.
  assert.equal((await s.http(`/items/${id}`, { token: agent.token })).status, 200)
  const before = s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item'").get().n
  const patched = await s.http(`/items/${id}`, { method: 'PATCH', token: agent.token, body: { title: 'Retitled by dev-2' } })
  assert.equal(patched.status, 200); assert.equal(patched.json.item.title, 'Retitled by dev-2')
  const commented = await s.http(`/items/${id}/comments`, { method: 'POST', token: agent.token, body: { body: 'from dev-2' } })
  assert.equal(commented.status, 201)
  const closed = await s.http(`/items/${id}/close`, { method: 'POST', token: agent.token, body: { resolution: 'done' } })
  assert.equal(closed.status, 200); assert.equal(closed.json.item.state, 'closed')
  const reopened = await s.http(`/items/${id}/reopen`, { method: 'POST', token: agent.token, body: {} })
  assert.equal(reopened.status, 200); assert.equal(reopened.json.item.state, 'open')
  const ranked = await s.http(`/items/${id}/rank`, { method: 'POST', token: agent.token, body: { position: 'top' } })
  assert.equal(ranked.status, 200)
  // Every one of those writes landed a marker on c3, all authored 'agent'.
  const markers = s.db.prepare("SELECT payload FROM events WHERE type='item' ORDER BY seq").all().map((e) => JSON.parse(e.payload))
  assert.equal(markers.length, before + 5)
  for (const m of markers.slice(-5)) assert.equal(m.by, 'agent')

  // Create still targets a conversation, so it stays gated: dev-2 has not
  // joined c3.
  const create = await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'task', title: 'Interloper', convo_id: 'c3' } })
  assert.equal(create.status, 404)

  // Transcript write-back stays gated on the item's origin conversation too:
  // it is specifically the origin bridge's job.
  const withVoice = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { body: 'v', attachments: [{ blob_ref: 'b1', mime: 'audio/mp4', name: 'v', size: 1 }] } })
  const cid = withVoice.json.comment.id
  const refusedTranscript = await s.http(`/items/${id}/comments/${cid}`, { method: 'PATCH', token: agent.token, body: { blob_ref: 'b1', transcript: 'hi' } })
  assert.equal(refusedTranscript.status, 404)
  const ownerTranscript = await s.http(`/items/${id}/comments/${cid}`, { method: 'PATCH', token: other.token, body: { blob_ref: 'b1', transcript: 'hi' } })
  assert.equal(ownerTranscript.status, 200)
})

test('comments: a malformed Idempotency-Key is rejected; a key reused across items is a conflict', async (t) => {
  const { s, agent, client } = await fleet(t)
  const a = (await mkItem(s, agent.token, {})).json.item.id
  const b = (await mkItem(s, agent.token, { title: 'Other' })).json.item.id
  const post = (id, key) => s.http(`/items/${id}/comments`, { method: 'POST', token: client, headers: { 'idempotency-key': key }, body: { body: 'x' } })
  assert.equal((await post(a, '')).status, 400)
  assert.equal((await post(a, 'k'.repeat(129))).status, 400)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM item_comments').get().n, 0)
  assert.equal((await post(a, 'shared')).status, 201)
  const clash = await post(b, 'shared')
  assert.equal(clash.status, 409); assert.equal(clash.json.error, 'conflict')
})

test('rank: position is exclusive of after/before; after+before together is a midpoint; only open items are ranked', async (t) => {
  const { s, agent, client } = await fleet(t)
  const a = (await mkItem(s, agent.token, { kind: 'task', title: 'A' })).json.item
  const b = (await mkItem(s, agent.token, { kind: 'task', title: 'B' })).json.item
  const c = (await mkItem(s, agent.token, { kind: 'task', title: 'C' })).json.item
  const rank = (id, body) => s.http(`/items/${id}/rank`, { method: 'POST', token: client, body })
  // after+before together is a midpoint, not an ambiguous pair (checked first,
  // before any other reorder below moves a or b out of their creation order).
  const mid = await rank(c.id, { after: a.id, before: b.id })
  assert.equal(mid.status, 200)
  assert.ok(a.rank < mid.json.item.rank && mid.json.item.rank < b.rank)
  assert.equal((await rank(b.id, { after: a.id, before: a.id })).status, 400)
  assert.equal((await rank(b.id, { position: 'top', after: a.id })).status, 400)
  assert.equal((await rank(b.id, { position: 'middle' })).status, 400)
  assert.equal((await rank(b.id, { after: '' })).status, 400)
  assert.equal((await rank(b.id, { before: a.id })).status, 200)
  assert.equal((await s.http(`/items/${a.id}/close`, { method: 'POST', token: agent.token, body: { resolution: 'done' } })).status, 200)
  const closed = await rank(a.id, { position: 'top' })
  assert.equal(closed.status, 409); assert.equal(closed.json.error, 'conflict')
})

test('transcript: bounded, markerless, silent — and a trailing segment never mutates the item', async (t) => {
  const { s, agent, client, wakeCalls } = await fleet(t)
  const id = (await mkItem(s, agent.token, {})).json.item.id
  const c = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { body: 'v', attachments: [{ blob_ref: 'b1', mime: 'audio/mp4', name: 'v', size: 1 }] } })
  const cid = c.json.comment.id
  const patch = (body) => s.http(`/items/${id}/comments/${cid}`, { method: 'PATCH', token: agent.token, body })
  assert.equal((await patch({ blob_ref: 'b1', transcript: 'x'.repeat(32769) })).status, 400)
  assert.equal((await patch({ blob_ref: '', transcript: 'hi' })).status, 400)
  assert.equal((await s.http(`/items/${id}/comments/ic_nope`, { method: 'PATCH', token: agent.token, body: { blob_ref: 'b1', transcript: 'hi' } })).status, 404)
  const before = s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item'").get().n
  assert.equal((await patch({ blob_ref: 'b1', transcript: 'hi' })).status, 200)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item'").get().n, before)
  assert.equal(wakeCalls.length, 1) // the comment woke the box; the transcript did not
  // The trailing segment belongs to the sub-route, so a junk one is not a close.
  assert.equal((await s.http(`/items/${id}/close/junk`, { method: 'POST', token: agent.token, body: { resolution: 'done' } })).status, 404)
  assert.equal((await s.http(`/items/${id}`, { token: client })).json.item.state, 'open')
})

test('POST /items: position is exclusive of after/before; after+before together is a midpoint', async (t) => {
  const { s, agent, client } = await fleet(t)
  const a = (await mkItem(s, agent.token, { kind: 'task', title: 'A' })).json.item
  const b = (await mkItem(s, agent.token, { kind: 'task', title: 'B' })).json.item
  // position combined with a neighbour is still an ambiguous intent.
  assert.equal((await mkItem(s, client, { position: 'top', after: a.id })).status, 400)
  assert.equal((await mkItem(s, client, { position: 'bottom', before: b.id })).status, 400)
  // after+before together is a midpoint between the two neighbours.
  const mid = await mkItem(s, client, { after: a.id, before: b.id })
  assert.equal(mid.status, 201)
  assert.ok(a.rank < mid.json.item.rank && mid.json.item.rank < b.rank)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 3)
  // Zero is fine (bottom by default), and so is exactly one.
  assert.equal((await mkItem(s, client, { title: 'None' })).status, 201)
  assert.equal((await mkItem(s, client, { title: 'One', position: 'top' })).status, 201)
})

test('POST /items/:id/comments: a client-supplied attachment transcript is stripped, never stored', async (t) => {
  const { s, agent, client } = await fleet(t)
  const id = (await mkItem(s, agent.token, {})).json.item.id
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: {
    body: 'listen', attachments: [{ blob_ref: 'b1', mime: 'audio/mp4', name: 'v.m4a', size: 3, transcript: 'forged' }],
  } })
  assert.equal(r.status, 201)
  // A transcript is agent-attested (the PATCH transcript route only): the
  // response, the stored row, and the marker all carry no forged text.
  assert.equal(r.json.comment.attachments[0].transcript ?? null, null)
  assert.equal(r.json.comment.attachments[0].blob_ref, 'b1')
  const stored = JSON.parse(s.db.prepare('SELECT attachments FROM item_comments WHERE id=?').get(r.json.comment.id).attachments)
  assert.equal(stored[0].transcript ?? null, null)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'commented')
  assert.equal(marker.payload.comment.attachments[0].transcript, null)
  ws.close()
  // The same field on a create is dropped just as quietly.
  const made = await mkItem(s, client, { title: 'With audio', attachments: [{ blob_ref: 'b2', mime: 'audio/mp4', name: 'w.m4a', size: 3, transcript: 'forged too' }] })
  assert.equal(made.status, 201)
  assert.equal(made.json.item.attachments[0].transcript ?? null, null)
})

test('POST /items/:id/comments: a user comment on a CLOSED item reopens it awaiting the agent', async (t) => {
  const { s, agent, client, wakeCalls } = await fleet(t)
  const id = (await mkItem(s, agent.token, {})).json.item.id
  assert.equal((await s.http(`/items/${id}/close`, { method: 'POST', token: agent.token, body: { resolution: 'answered' } })).status, 200)
  assert.equal(wakeCalls.length, 0) // the agent's own close does not wake it
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await s.http(`/items/${id}/comments`, { method: 'POST', token: client, body: { body: 'actually…' } })
  assert.equal(r.status, 201)
  assert.equal(r.json.item.state, 'open'); assert.equal(r.json.item.awaiting, 'agent')
  assert.equal(r.json.item.resolution, null); assert.equal(r.json.item.closed_at, null)
  // The marker reports the post-transition item, not the closed one it found.
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'commented')
  assert.equal(marker.payload.awaiting, 'agent'); assert.equal(marker.payload.resolution, null)
  assert.equal(marker.payload.by, 'user'); assert.equal(marker.payload.comment.body, 'actually…')
  ws.close()
  // A reopening comment is inbound traffic: the box gets woken for it.
  assert.deepEqual(wakeCalls, ['dev-2'])
  assert.equal((await s.http(`/items/${id}`, { token: client })).json.item.state, 'open')
})

test('an agent may not publish an item marker over the WS', async (t) => {
  const { s, agent } = await fleet(t)
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  // 'item' is not in AGENT_PUBLISH_TYPES: markers are server-minted by the
  // /items routes only, so a forged one is a bad_request and lands nothing.
  ws.send({ op: 'publish', convo_id: 'c1', type: 'item', payload: { item_id: 'it_forged', num: 99, kind: 'question', title: 'Forged', action: 'created', by: 'agent', awaiting: 'user', resolution: null } })
  await ws.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.code === 'bad_request' && f.ref === 'publish')
  assert.equal(ws.ws.readyState, 1)
  ws.close()
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item'").get().n, 0)
})

test('POST /items with attachments: the blob rides on the item and lights has_image in the list', async (t) => {
  const { s, agent, client } = await fleet(t)
  const made = await mkItem(s, agent.token, {
    title: 'Look at this', attachments: [{ blob_ref: 'b1', mime: 'image/png', name: 'shot.png', size: 42 }],
  })
  assert.equal(made.status, 201)
  assert.equal(made.json.item.attachments.length, 1)
  assert.equal(made.json.item.has_image, true)
  const one = await s.http(`/items/${made.json.item.id}`, { token: client })
  assert.equal(one.status, 200)
  assert.deepEqual(one.json.item.attachments, [{ blob_ref: 'b1', mime: 'image/png', name: 'shot.png', size: 42 }])
  assert.equal(one.json.item.has_image, true)
  // The synthetic body comment carrying the blobs is not part of the thread.
  assert.deepEqual(one.json.comments, [])
  const list = await s.http('/items', { token: client })
  assert.equal(list.json.items[0].has_image, true)
  assert.equal(list.json.items[0].attachments[0].blob_ref, 'b1')
  // A non-image attachment leaves has_image false.
  const doc = await mkItem(s, agent.token, { title: 'A doc', attachments: [{ blob_ref: 'b2', mime: 'application/pdf', name: 'a.pdf', size: 9 }] })
  assert.equal(doc.json.item.has_image, false)
  assert.equal((await mkItem(s, agent.token, { attachments: [{ blob_ref: 'b3', mime: 'image/png' }] })).status, 400)
})

test('POST /items supersedes: another of the user\'s items round-trips; a foreign one is 400', async (t) => {
  const { s, agent, client, patAgent } = await fleet(t)
  const original = (await mkItem(s, agent.token, { kind: 'decision', title: 'Use A' })).json.item
  const revised = await mkItem(s, client, { kind: 'decision', title: 'Use B instead', supersedes: original.id })
  assert.equal(revised.status, 201)
  assert.equal(revised.json.item.supersedes, original.id)
  assert.equal((await s.http(`/items/${revised.json.item.id}`, { token: client })).json.item.supersedes, original.id)
  assert.equal((await s.http('/items', { token: client })).json.items.find((i) => i.id === revised.json.item.id).supersedes, original.id)
  // Another user's item is not a supersedable id — the same 400 an unknown one gets.
  const theirs = (await s.http('/items', { method: 'POST', token: patAgent.token, body: { kind: 'decision', title: 'P', convo_id: 'p1' } })).json.item
  assert.equal((await mkItem(s, client, { kind: 'decision', supersedes: theirs.id })).status, 400)
})

test('item and comment API shapes carry no internal columns', async (t) => {
  const { s, agent, client } = await fleet(t)
  const made = await s.http('/items', { method: 'POST', token: agent.token, headers: { 'idempotency-key': 'k1' }, body: { kind: 'task', title: 'T', convo_id: 'c1' } })
  assert.ok(!('idem_key' in made.json.item))
  const c = await s.http(`/items/${made.json.item.id}/comments`, { method: 'POST', token: client, headers: { 'idempotency-key': 'c1' }, body: { body: 'x' } })
  assert.ok(!('idem_key' in c.json.comment))
  assert.ok(!('user_id' in c.json.comment))
  const one = await s.http(`/items/${made.json.item.id}`, { token: client })
  assert.ok(!('idem_key' in one.json.item))
  assert.ok(!('idem_key' in one.json.comments[0]))
  assert.ok(!('user_id' in one.json.comments[0]))
  assert.ok(!('idem_key' in (await s.http('/items', { token: client })).json.items[0]))
})
