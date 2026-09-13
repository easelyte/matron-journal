import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'
import { visibleMission } from '../src/missions-http.js'
import { CONVOS_MAX } from '../src/missions.js'

async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  const patAgent = createAgent(s.db, pat.id, 'pat-box')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'c2', ownerUserId: dan.id, title: 'C2', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, title: 'P1', agentDeviceId: patAgent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  return { s, dan, agent, patAgent, client: login.json.token }
}
const start = (s, token, body, headers = {}) => s.http('/missions', { method: 'POST', token, body: { title: 'Missions', body: 'goal', convo_id: 'c1', ...body }, headers })
const post = (s, token, body, headers = {}) => s.http('/milestones', { method: 'POST', token, body: { convo_id: 'c1', kind: 'progress', title: 'step', ...body }, headers })
const item = (s, token, body) => s.http('/items', { method: 'POST', token, body: { kind: 'question', title: 'Q?', convo_id: 'c1', ...body } })

test('POST /missions: 201 with the next shared number, marker on the convo, existing on a second start, idempotent replay, 400/404 on junk', async (t) => {
  const { s, agent, client } = await fleet(t)
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const it = await item(s, agent.token, {})
  assert.equal(it.json.item.num, 1)
  const r = await start(s, agent.token, {}, { 'idempotency-key': 'k1' })
  assert.equal(r.status, 201); assert.equal(r.json.mission.num, 2); assert.equal(r.json.mission.state, 'open'); assert.equal(r.json.existing, undefined)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission')
  assert.equal(marker.convo_id, 'c1'); assert.equal(marker.payload.action, 'created'); assert.equal(marker.payload.num, 2); assert.equal(marker.payload.by, 'agent')
  ws.close()
  const replay = await start(s, agent.token, {}, { 'idempotency-key': 'k1' })
  assert.equal(replay.status, 200); assert.equal(replay.json.mission.id, r.json.mission.id)
  const second = await start(s, agent.token, { title: 'Other' })
  assert.equal(second.status, 200); assert.equal(second.json.existing, true); assert.equal(second.json.mission.title, 'Missions')
  assert.equal((await s.http('/items/it_x', { token: agent.token })).status, 404)
  const moved = await s.http(`/items/${it.json.item.id}`, { token: agent.token })
  assert.equal(moved.json.item.mission_id, r.json.mission.id); assert.equal(moved.json.item.mission_num, 2)
  assert.equal((await start(s, agent.token, { title: '' })).status, 400)
  assert.equal((await start(s, agent.token, { title: 'x'.repeat(201) })).status, 400)
  assert.equal((await start(s, agent.token, { convo_id: 'p1' })).status, 404)
  assert.equal((await start(s, agent.token, { convo_id: 'nope' })).status, 404)
  assert.equal((await s.http('/missions', { method: 'POST', body: { title: 'x', convo_id: 'c1' } })).status, 401)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='mission'").get().n, 1)
})

test('POST /milestones: 409 no_mission writes nothing; 201 with marker seq as anchor; replay 200; GET /milestones newest first; closed mission 409', async (t) => {
  const { s, agent, client } = await fleet(t)
  const none = await post(s, agent.token, {})
  assert.equal(none.status, 409); assert.equal(none.json.blocked_by, 'no_mission')
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n, 0)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='milestone'").get().n, 0)
  const m = (await start(s, agent.token, {})).json.mission
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await post(s, agent.token, { kind: 'user_input', title: 'Dan asked', body: 'b' }, { 'idempotency-key': 'm1' })
  assert.equal(r.status, 201); assert.equal(r.json.milestone.num, 2); assert.equal(r.json.mission.id, m.id)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'milestone')
  assert.equal(marker.seq, r.json.milestone.seq); assert.equal(marker.payload.milestone_id, r.json.milestone.id)
  assert.equal(marker.payload.mission_num, m.num); assert.equal(marker.payload.kind, 'user_input'); assert.equal(marker.payload.by, 'agent')
  ws.close()
  assert.equal((await post(s, agent.token, { kind: 'user_input', title: 'Dan asked' }, { 'idempotency-key': 'm1' })).status, 200)
  const r2 = await post(s, agent.token, { title: 'later' })
  assert.equal(r2.status, 201)
  const list = await s.http('/milestones?convo=c1', { token: client })
  assert.deepEqual(list.json.milestones.map((l) => l.title), ['later', 'Dan asked'])
  assert.equal((await post(s, agent.token, { kind: 'nope' })).status, 400)
  assert.equal((await post(s, agent.token, { title: '' })).status, 400)
  assert.equal((await post(s, agent.token, { convo_id: 'p1' })).status, 404)
  const detail = await s.http(`/missions/${m.num}`, { token: client })
  assert.equal(detail.json.mission.milestones, 2); assert.equal(detail.json.mission.last_milestone.title, 'later')
  assert.equal(detail.json.milestones[0].title, 'later')
  const closed = await s.http(`/missions/${m.id}/close`, { method: 'POST', token: agent.token, body: { summary: 'done' } })
  assert.equal(closed.status, 200)
  const after = await post(s, agent.token, { title: 'too late' })
  assert.equal(after.status, 409); assert.equal(after.json.blocked_by, 'closed')
})

test('close: agent blocked by user items then agent items (409 with the list); user close records closed_over_open_items and the marker carries open_item_nums', async (t) => {
  const { s, agent, client } = await fleet(t)
  const m = (await start(s, agent.token, {})).json.mission
  const q = (await item(s, agent.token, {})).json.item
  const tk = (await item(s, agent.token, { kind: 'task', title: 'T' })).json.item
  const close = (token, summary = 's') => s.http(`/missions/${m.id}/close`, { method: 'POST', token, body: { summary } })
  let r = await close(agent.token)
  assert.equal(r.status, 409); assert.equal(r.json.blocked_by, 'user_items'); assert.deepEqual(r.json.items, [{ num: q.num, title: 'Q?' }])
  await s.http(`/items/${q.id}/close`, { method: 'POST', token: client, body: { resolution: 'answered' } })
  r = await close(agent.token)
  assert.equal(r.status, 409); assert.equal(r.json.blocked_by, 'agent_items'); assert.deepEqual(r.json.items, [{ num: tk.num, title: 'T' }])
  assert.equal((await close(agent.token, '')).status, 400)
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  r = await close(client, 'forced')
  assert.equal(r.status, 200); assert.equal(r.json.mission.closed_by, 'user'); assert.equal(r.json.mission.closed_over_open_items, 1)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.payload.action === 'closed')
  assert.deepEqual(marker.payload.open_item_nums, [tk.num]); assert.equal(marker.payload.by, 'user')
  ws.close()
  assert.equal((await close(client)).status, 409)
  assert.equal((await s.http(`/missions/${m.id}`, { method: 'PATCH', token: agent.token, body: { title: 'x' } })).status, 409)
  assert.equal((await s.http(`/items/${tk.id}`, { token: client })).json.item.state, 'open')
})

test('close: a hidden open item on a private-owned conversation still blocks the close, but is absent from an ordinary agent\'s 409 items list', async (t) => {
  const { s, dan, agent } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret3', ownerUserId: dan.id, title: 'S3', agentDeviceId: priv.deviceId })
  const m = (await start(s, agent.token, {})).json.mission
  const joined = await s.http(`/missions/${m.id}/join`, { method: 'POST', token: priv.token, body: { convo_id: 'secret3' } })
  assert.equal(joined.status, 200)
  const hidden = (await s.http('/items', { method: 'POST', token: priv.token, body: { kind: 'task', title: 'Hidden task', convo_id: 'secret3' } })).json.item
  assert.equal(hidden.mission_id, m.id)
  const close = (token) => s.http(`/missions/${m.id}/close`, { method: 'POST', token, body: { summary: 's' } })
  // Ordinary agent: still blocked (the hidden item exists and is open), but
  // the 409 names nothing it can't see.
  const asOrdinary = await close(agent.token)
  assert.equal(asOrdinary.status, 409); assert.equal(asOrdinary.json.blocked_by, 'agent_items'); assert.deepEqual(asOrdinary.json.items, [])
  // The private device itself is unfiltered and sees the real item.
  const asPrivate = await close(priv.token)
  assert.equal(asPrivate.status, 409); assert.equal(asPrivate.json.blocked_by, 'agent_items')
  assert.deepEqual(asPrivate.json.items, [{ num: hidden.num, title: 'Hidden task' }])
})

test('join: attaches c2 and repoints its items; refuses a second mission for a convo; PATCH updates and emits the marker on the origin', async (t) => {
  const { s, agent, client } = await fleet(t)
  const m = (await start(s, agent.token, {})).json.mission
  const it2 = (await item(s, agent.token, { convo_id: 'c2', kind: 'task', title: 'T2' })).json.item
  const j = await s.http(`/missions/${m.num}/join`, { method: 'POST', token: agent.token, body: { convo_id: 'c2' } })
  assert.equal(j.status, 200); assert.equal(j.json.mission.conversations, 2)
  assert.equal((await s.http(`/items/${it2.id}`, { token: client })).json.item.mission_id, m.id)
  const other = await s.http('/missions', { method: 'POST', token: agent.token, body: { title: 'B', convo_id: 'c2' } })
  assert.equal(other.status, 200); assert.equal(other.json.existing, true); assert.equal(other.json.mission.id, m.id)
  upsertConversation(s.db, { id: 'c3', ownerUserId: 1, title: 'C3', agentDeviceId: agent.deviceId })
  const b = (await s.http('/missions', { method: 'POST', token: agent.token, body: { title: 'B', convo_id: 'c3' } })).json.mission
  const bad = await s.http(`/missions/${b.id}/join`, { method: 'POST', token: agent.token, body: { convo_id: 'c2' } })
  assert.equal(bad.status, 409); assert.equal(bad.json.blocked_by, 'other_mission')
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const p = await s.http(`/missions/${m.id}`, { method: 'PATCH', token: agent.token, body: { title: 'Renamed' } })
  assert.equal(p.status, 200); assert.equal(p.json.mission.title, 'Renamed')
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.payload.action === 'updated')
  assert.equal(marker.convo_id, 'c1'); assert.equal(marker.payload.title, 'Renamed')
  ws.close()
  assert.equal((await s.http(`/missions/${m.id}`, { method: 'PATCH', token: agent.token, body: {} })).status, 400)
})

test('GET /missions: counts and sort; state filter; PATCH /items/:id {mission} moves and detaches', async (t) => {
  const { s, agent, client } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const b = (await start(s, agent.token, { title: 'B', convo_id: 'c2' })).json.mission
  const it = (await item(s, agent.token, {})).json.item
  await post(s, agent.token, { convo_id: 'c2', title: 'b1' })
  const list = await s.http('/missions', { token: client })
  assert.deepEqual(list.json.missions.map((m) => m.id), [b.id, a.id])
  assert.equal(list.json.missions[1].needs_you, 1); assert.equal(list.json.missions[1].open_items, 1)
  assert.equal(list.json.missions[0].last_milestone.title, 'b1')
  const mv = await s.http(`/items/${it.id}`, { method: 'PATCH', token: agent.token, body: { mission: `#${b.num}` } })
  assert.equal(mv.status, 200); assert.equal(mv.json.item.mission_id, b.id); assert.equal(mv.json.item.mission_num, b.num)
  const det = await s.http(`/items/${it.id}`, { method: 'PATCH', token: agent.token, body: { mission: null } })
  assert.equal(det.json.item.mission_id, null)
  assert.equal((await s.http(`/items/${it.id}`, { method: 'PATCH', token: agent.token, body: { mission: '#999' } })).status, 404)
  await s.http(`/missions/${b.id}/close`, { method: 'POST', token: client, body: { summary: 'x' } })
  assert.equal((await s.http('/missions?state=open', { token: client })).json.missions.length, 1)
  assert.equal((await s.http('/missions?state=closed', { token: client })).json.missions.length, 1)
  assert.equal((await s.http('/missions?state=bogus', { token: client })).status, 400)
})

test('privacy sieve: an ordinary agent cannot see a mission born in a private convo, nor its milestones through another mission', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  // A second private-owned convo, deliberately never given its own mission —
  // 'secret' already owns 'm' below, so reusing it to join 'pub' would
  // correctly 409 other_mission (a convo may join at most one mission).
  upsertConversation(s.db, { id: 'secret2', ownerUserId: dan.id, title: 'S2', agentDeviceId: priv.deviceId })
  const m = (await s.http('/missions', { method: 'POST', token: priv.token, body: { title: 'Hidden', convo_id: 'secret' } })).json.mission
  assert.equal((await s.http('/missions', { token: agent.token })).json.missions.length, 0)
  assert.equal((await s.http(`/missions/${m.id}`, { token: agent.token })).status, 404)
  assert.equal((await s.http('/missions', { token: client })).json.missions.length, 1)
  assert.equal((await s.http('/missions', { token: priv.token })).json.missions.length, 1)
  // an ordinary agent cannot start a mission in a private convo or post milestones there
  assert.equal((await start(s, agent.token, { convo_id: 'secret' })).status, 404)
  assert.equal((await post(s, agent.token, { convo_id: 'secret' })).status, 404)
  // Critical 3: a mission invisible to GET /missions/:id must not be reachable
  // as a PATCH /items/:id {mission} target either — same 404, no existence oracle.
  const pubItem = (await item(s, agent.token, {})).json.item
  assert.equal((await s.http(`/items/${pubItem.id}`, { method: 'PATCH', token: agent.token, body: { mission: m.id } })).status, 404)
  assert.equal((await s.http(`/items/${pubItem.id}`, { method: 'PATCH', token: agent.token, body: { mission: `#${m.num}` } })).status, 404)
  assert.equal((await s.http(`/items/${pubItem.id}`, { token: agent.token })).json.item.mission_id, null)
  // a public mission that a private convo joined: the private convo's milestones are filtered for the ordinary agent
  const pub = (await start(s, agent.token, {})).json.mission
  const firstJoin = await s.http(`/missions/${pub.id}/join`, { method: 'POST', token: priv.token, body: { convo_id: 'secret2' } })
  assert.equal(firstJoin.status, 200)
  // A repeat join of the same mission (secret2 is already attached to pub) is a no-op: 200, not 409.
  assert.equal((await s.http(`/missions/${pub.id}/join`, { method: 'POST', token: priv.token, body: { convo_id: 'secret2' } })).status, 200)
  // Important #5 / Critical 1: post a milestone from the private convo, then
  // read pub both as the ordinary agent (sieved) and as the client
  // (unsieved) — the milestone, the counts AND last_milestone must all agree
  // with the (sieved) arrays, not just the arrays on their own.
  const hiddenMilestone = await post(s, priv.token, { convo_id: 'secret2', title: 'private step' })
  assert.equal(hiddenMilestone.status, 201)
  const detailAsAgent = await s.http(`/missions/${pub.id}`, { token: agent.token })
  assert.equal(detailAsAgent.status, 200)
  assert.equal(detailAsAgent.json.milestones.length, 0)
  assert.equal(detailAsAgent.json.mission.milestones, 0)
  assert.equal(detailAsAgent.json.mission.last_milestone, null)
  assert.equal(detailAsAgent.json.mission.conversations, 1)
  assert.equal(detailAsAgent.json.conversations.length, 1)
  const listAsAgent = (await s.http('/missions', { token: agent.token })).json.missions.find((x) => x.id === pub.id)
  assert.equal(listAsAgent.milestones, 0); assert.equal(listAsAgent.last_milestone, null); assert.equal(listAsAgent.conversations, 1)
  const detailAsClient = await s.http(`/missions/${pub.id}`, { token: client })
  assert.equal(detailAsClient.json.milestones.length, 1)
  assert.equal(detailAsClient.json.mission.milestones, 1)
  assert.equal(detailAsClient.json.mission.last_milestone.title, 'private step')
  assert.equal(detailAsClient.json.mission.conversations, 2)
})

test('forged publish of mission/milestone types is rejected; oversized bodies 400 with nothing written', async (t) => {
  const { s, agent } = await fleet(t)
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  ws.send({ op: 'publish', convo_id: 'c1', type: 'milestone', payload: { num: 1 } })
  const badMilestone = await ws.waitFor((f) => f.op === 'error' || f.error)
  assert.match(JSON.stringify(badMilestone), /bad_request/)
  const before = ws.frames.length
  ws.send({ op: 'publish', convo_id: 'c1', type: 'mission', payload: { action: 'created' } })
  const badMission = await new Promise((resolve, reject) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      const hit = ws.frames.slice(before).find((f) => f.op === 'error' || f.error)
      if (hit) { clearInterval(iv); resolve(hit) }
      else if (Date.now() - t0 > 2000) { clearInterval(iv); reject(new Error('waitFor timeout')) }
    }, 10)
  })
  assert.match(JSON.stringify(badMission), /bad_request/)
  ws.close()
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type IN ('milestone','mission')").get().n, 0)
  // Well under readBody's 1 MB / 413 cap — this is deterministically a
  // validation 400 (BODY_MAX), not a transport-size 413.
  const big = await s.http('/missions', { method: 'POST', token: agent.token, body: { title: 'x', body: 'y'.repeat(40000), convo_id: 'c1' } })
  assert.equal(big.status, 400)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM missions').get().n, 0)
})

// Task 7 re-review, extra 1: writableConvo confirms the conversation exists
// right before createMilestone's own transaction re-reads it — a genuine
// TOCTOU window if the row vanishes in between. Simulated deterministically
// (no real concurrency needed): intercept db.prepare so the FIRST call to
// createMilestone's own "does this convo exist" query deletes the row a
// moment before it runs, reproducing the exact race the code comments
// already describe for create/join without needing two overlapping requests.
test('POST /milestones: convo deleted between the write-gate and the write (TOCTOU) maps no_convo to 404, never the generic 500', async (t) => {
  const { s, agent } = await fleet(t)
  const realPrepare = s.db.prepare.bind(s.db)
  let armed = true
  s.db.prepare = (sql) => {
    if (armed && sql === 'SELECT mission_id FROM conversations WHERE id=? AND owner_user_id=?') {
      armed = false
      realPrepare('DELETE FROM conversations WHERE id=?').run('c1')
    }
    return realPrepare(sql)
  }
  let r
  try { r = await post(s, agent.token, {}) } finally { s.db.prepare = realPrepare }
  assert.equal(r.status, 404)
  assert.deepEqual(r.json, { error: 'not_found' })
})

// Task 7 re-review, extra 2: visibleMission must hand back a row already
// sieved for the caller — not just an id safe to reuse — so a future
// consumer that serialises it directly (unlike today's two, which only read
// .id) can never leak an ordinary agent's counts/last_milestone assembled
// from a private-owned conversation it isn't allowed to see. Same fixture
// shape as the "privacy sieve" test above (a public mission joined by a
// private-owned conversation that then posts a milestone), but calls
// visibleMission directly to pin the guarantee at its own source, not only
// as observed through GET /missions/:id's separate missionDetail re-fetch.
test('visibleMission returns sieved counts/last_milestone for an ordinary agent, not the raw row', async (t) => {
  const { s, dan, agent } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret2', ownerUserId: dan.id, title: 'S2', agentDeviceId: priv.deviceId })
  const pub = (await start(s, agent.token, {})).json.mission
  assert.equal((await s.http(`/missions/${pub.id}/join`, { method: 'POST', token: priv.token, body: { convo_id: 'secret2' } })).status, 200)
  assert.equal((await post(s, priv.token, { convo_id: 'secret2', title: 'private step' })).status, 201)
  const seenByOrdinaryAgent = visibleMission(s.db, { kind: 'agent', userId: dan.id, deviceId: agent.deviceId }, pub.id)
  assert.equal(seenByOrdinaryAgent.milestones, 0)
  assert.equal(seenByOrdinaryAgent.last_milestone, null)
  assert.equal(seenByOrdinaryAgent.conversations, 1)
  const seenByPrivateAgent = visibleMission(s.db, { kind: 'agent', userId: dan.id, deviceId: priv.deviceId }, pub.id)
  assert.equal(seenByPrivateAgent.milestones, 1)
  assert.equal(seenByPrivateAgent.last_milestone.title, 'private step')
})

// ---------------------------------------------------------------------------
// Final review, C1: the origin sieve lives in getMission now, so the two
// routes that target a CONVERSATION rather than an already-visible mission
// (POST /missions, POST /milestones) can no longer hand an ordinary agent a
// hidden mission's row — or write into it. Mirrors the "privacy sieve"
// fixture above: the user joins a public conversation to a private-origin
// mission, then that conversation's ordinary agent calls both routes.
// ---------------------------------------------------------------------------
test('privacy sieve: a public convo joined to a private-origin mission is not an oracle — POST /missions 404s and POST /milestones 409s with nothing written', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  const hidden = (await s.http('/missions', { method: 'POST', token: priv.token, body: { title: 'Hidden', body: 'secret goal', convo_id: 'secret' } })).json.mission
  // Only the user can do this: they can see both sides.
  assert.equal((await s.http(`/missions/${hidden.id}/join`, { method: 'POST', token: client, body: { convo_id: 'c1' } })).status, 200)
  // c1's own ordinary agent: the mission is still invisible on every route.
  assert.equal((await s.http(`/missions/${hidden.id}`, { token: agent.token })).status, 404)
  const existing = await start(s, agent.token, {})
  assert.equal(existing.status, 404)
  assert.deepEqual(existing.json, { error: 'not_found' })
  const ms = await post(s, agent.token, {})
  assert.equal(ms.status, 409); assert.equal(ms.json.blocked_by, 'no_mission')
  assert.equal(ms.json.mission, undefined)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n, 0)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='milestone'").get().n, 0)
  // The client is unfiltered: same conversation, same route, 201.
  const byUser = await post(s, client, {})
  assert.equal(byUser.status, 201); assert.equal(byUser.json.mission.id, hidden.id)
  assert.equal((await s.http('/missions', { token: agent.token })).json.missions.length, 0)
})

// ---------------------------------------------------------------------------
// Fix round 2, Critical: the marker events themselves. C1 closed the ROUTES,
// but the user — who legitimately sees both sides — can still join a PUBLIC
// conversation to a private-origin mission and post a milestone there. Those
// markers land in that public conversation, and ws.js replays events verbatim
// (no per-type payload sieve), so an ordinary agent used to read the private
// mission's TITLE out of its own replay while GET /missions/:id 404'd. The
// title is now dropped at write time; the marker itself still lands.
// ---------------------------------------------------------------------------
test("privacy sieve: markers written across the boundary carry numbers only — an ordinary agent's replay never sees the private mission's title", async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  const TITLE = 'SECRET-MISSION-TITLE'
  const hidden = (await s.http('/missions', { method: 'POST', token: priv.token, body: { title: TITLE, body: 'secret goal', convo_id: 'secret' } })).json.mission
  // Exactly the state the C1 fixture builds: only the user can join the
  // public conversation to it, and only the user can post the milestone.
  assert.equal((await s.http(`/missions/${hidden.id}/join`, { method: 'POST', token: client, body: { convo_id: 'c1' } })).status, 200)
  const ms = await post(s, client, { title: 'a public step', body: 'own content' })
  assert.equal(ms.status, 201)
  // The mission is still invisible to c1's own ordinary agent on every route.
  assert.equal((await s.http(`/missions/${hidden.id}`, { token: agent.token })).status, 404)

  // The agent replays c1 from the beginning (cursor 0 = full replay) — the
  // leak's actual path.
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: 0 })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const milestoneFrame = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'milestone')
  const joinFrame = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission')
  for (const f of ws.journal()) {
    assert.equal(f.convo_id, 'c1')  // the origin conversation never replays to it at all
    assert.equal(JSON.stringify(f.payload).includes(TITLE), false, `${f.type} marker leaked the title`)
  }
  // The events still LAND, carrying every number: suppressing them would
  // leave the user's own timeline with a hole.
  assert.equal(joinFrame.payload.action, 'joined')
  assert.equal(joinFrame.payload.num, hidden.num)
  assert.equal(joinFrame.payload.mission_id, hidden.id)
  assert.equal(joinFrame.payload.by, 'user')
  assert.equal('title' in joinFrame.payload, false)
  assert.equal(milestoneFrame.payload.mission_num, hidden.num)
  assert.equal('mission_title' in milestoneFrame.payload, false)
  // The milestone's OWN fields are that conversation's content and stay.
  assert.equal(milestoneFrame.payload.title, 'a public step')
  assert.equal(milestoneFrame.payload.body, 'own content')
  assert.equal(milestoneFrame.seq, ms.json.milestone.seq)
  ws.close()

  // Same over the HTTP read of the same conversation, and in the STORED rows
  // (the drop is at write time, so history cannot be replayed any other way).
  const read = await s.http('/convo/c1/messages?limit=50', { token: agent.token })
  assert.equal(JSON.stringify(read.json.events).includes(TITLE), false)
  const stored = s.db.prepare("SELECT payload FROM events WHERE convo_id='c1' AND type IN ('mission','milestone')").all()
  assert.equal(stored.length, 2)
  for (const row of stored) assert.equal(row.payload.includes(TITLE), false)
  // The conversation-preview snippet is not a back door either.
  assert.equal(s.db.prepare("SELECT snippet FROM conversations WHERE id='c1'").get().snippet.includes(TITLE), false)

  // The user's own replay of the ORIGIN conversation still names it: nothing
  // crossed the boundary there, and the client is unfiltered.
  const userWs = await makeWsClient(s.base, { token: client, cursor: 0 })
  await userWs.waitFor((f) => f.op === 'hello_ok')
  const created = await userWs.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.convo_id === 'secret')
  assert.equal(created.payload.action, 'created')
  assert.equal(created.payload.title, TITLE)
  // …and the user sees the title-less markers on c1, exactly as stored.
  const userJoin = await userWs.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.convo_id === 'c1')
  assert.equal('title' in userJoin.payload, false)
  userWs.close()
  // A private agent still reads the mission itself in full — the sieve, not
  // the marker, is what decides that.
  assert.equal((await s.http(`/missions/${hidden.id}`, { token: priv.token })).json.mission.title, TITLE)
})

// A marker written into ANOTHER private-owned conversation has not crossed
// anything: the title travels, or a private agent's own timeline would be
// needlessly degraded.
test('privacy sieve: a private-origin mission joined to a second PRIVATE conversation keeps its title in the marker', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  upsertConversation(s.db, { id: 'secret2', ownerUserId: dan.id, title: 'S2', agentDeviceId: priv.deviceId })
  const TITLE = 'SECRET-MISSION-TITLE'
  const hidden = (await s.http('/missions', { method: 'POST', token: priv.token, body: { title: TITLE, convo_id: 'secret' } })).json.mission
  assert.equal((await s.http(`/missions/${hidden.id}/join`, { method: 'POST', token: priv.token, body: { convo_id: 'secret2' } })).status, 200)
  assert.equal((await s.http('/milestones', { method: 'POST', token: priv.token, body: { convo_id: 'secret2', kind: 'progress', title: 'step' } })).status, 201)
  const payloads = s.db.prepare("SELECT payload FROM events WHERE convo_id='secret2' AND type IN ('mission','milestone')").all().map((r) => JSON.parse(r.payload))
  assert.equal(payloads.length, 2)
  assert.equal(payloads.find((p) => p.action === 'joined').title, TITLE)
  assert.equal(payloads.find((p) => p.mission_num !== undefined && p.milestone_id).mission_title, TITLE)
  // The ordinary agent cannot replay either conversation in the first place.
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: 0 })
  await ws.waitFor((f) => f.op === 'hello_ok')
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(ws.journal().filter((f) => f.convo_id.startsWith('secret')), [])
  ws.close()
})

// Final review, minor: GET /missions/:id used to answer 200 with a `null`
// body if the mission vanished between visibleMission and missionDetail's own
// re-fetch. Forced deterministically (the db.prepare interception pattern
// above): delete the row just before the SECOND resolve of the same query.
test('GET /missions/:id: a mission that vanishes between the visibility gate and the detail read is 404, never 200 null', async (t) => {
  const { s, agent } = await fleet(t)
  const m = (await start(s, agent.token, {})).json.mission
  const realPrepare = s.db.prepare.bind(s.db)
  let seen = 0
  s.db.prepare = (sql) => {
    if (sql.startsWith('SELECT m.*,') && sql.includes('WHERE m.id=?')) {
      seen++
      if (seen === 2) realPrepare('DELETE FROM missions WHERE id=?').run(m.id)
    }
    return realPrepare(sql)
  }
  let r
  try { r = await s.http(`/missions/${m.id}`, { token: agent.token }) } finally { s.db.prepare = realPrepare }
  assert.equal(r.status, 404)
  assert.deepEqual(r.json, { error: 'not_found' })
})

// Final review, I4(a): GET /milestones?convo= is a per-conversation read and
// carries the same ownership + privacy gate as every other conversation read.
test('GET /milestones?convo=: 400 without a convo; 404 for unknown, another user\'s, and (for an ordinary agent) a private-owned one; the owner sees the list', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  await s.http('/missions', { method: 'POST', token: priv.token, body: { title: 'Hidden', convo_id: 'secret' } })
  assert.equal((await s.http('/milestones', { method: 'POST', token: priv.token, body: { convo_id: 'secret', kind: 'progress', title: 'private step' } })).status, 201)
  await start(s, agent.token, {})
  assert.equal((await post(s, agent.token, { title: 'public step' })).status, 201)

  assert.equal((await s.http('/milestones', { token: agent.token })).status, 400)
  assert.equal((await s.http('/milestones?convo=', { token: agent.token })).status, 400)
  assert.equal((await s.http('/milestones?convo=nope', { token: agent.token })).status, 404)
  assert.equal((await s.http('/milestones?convo=p1', { token: agent.token })).status, 404)
  assert.equal((await s.http('/milestones?convo=p1', { token: client })).status, 404)
  assert.equal((await s.http('/milestones?convo=secret', { token: agent.token })).status, 404)
  const asOwner = await s.http('/milestones?convo=secret', { token: client })
  assert.equal(asOwner.status, 200)
  assert.deepEqual(asOwner.json.milestones.map((l) => l.title), ['private step'])
  const asPrivateAgent = await s.http('/milestones?convo=secret', { token: priv.token })
  assert.deepEqual(asPrivateAgent.json.milestones.map((l) => l.title), ['private step'])
  assert.deepEqual((await s.http('/milestones?convo=c1', { token: agent.token })).json.milestones.map((l) => l.title), ['public step'])
})

// Final review, I4(b): the 200-conversation cap is a real 400, and seeding
// the conversations straight into SQL keeps it a millisecond test.
test('POST /missions/:id/join: 400 once the mission already holds CONVOS_MAX conversations', async (t) => {
  const { s, agent } = await fleet(t)
  const m = (await start(s, agent.token, {})).json.mission
  const ins = s.db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, mission_id, created_at) VALUES(?,?,'pad','running',?,0)")
  const userId = s.db.prepare('SELECT owner_user_id FROM conversations WHERE id=?').get('c1').owner_user_id
  for (let i = 0; i < CONVOS_MAX - 1; i++) ins.run(`pad${i}`, userId, m.id)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE mission_id=?').get(m.id).n, CONVOS_MAX)
  const full = await s.http(`/missions/${m.id}/join`, { method: 'POST', token: agent.token, body: { convo_id: 'c2' } })
  assert.equal(full.status, 400)
  assert.deepEqual(full.json, { error: 'bad_request' })
  assert.equal(s.db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('c2').mission_id, null)
  // One slot back and the same call succeeds — the cap is the only reason.
  s.db.prepare('UPDATE conversations SET mission_id=NULL WHERE id=?').run('pad0')
  assert.equal((await s.http(`/missions/${m.id}/join`, { method: 'POST', token: agent.token, body: { convo_id: 'c2' } })).status, 200)
})

// Final review, I4(c): the 502 path over real HTTP. The anchor marker is
// appended INSIDE createMilestone's transaction, so a failing append must
// leave no milestone row AND no marker event — not just a 502 status.
test('POST /milestones: a failing marker append is 502 marker_append_failed with no milestone row and no marker event', async (t) => {
  const { s, agent } = await fleet(t)
  await start(s, agent.token, {})
  const realPrepare = s.db.prepare.bind(s.db)
  const EVENT_INSERT = 'INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload, blob_ref, idem_key) VALUES(?,?,?,?,?,?,?,?,?)'
  s.db.prepare = (sql) => (sql === EVENT_INSERT
    ? { run: () => { throw new Error('disk on fire') } }
    : realPrepare(sql))
  let r
  try { r = await post(s, agent.token, { title: 'never lands' }) } finally { s.db.prepare = realPrepare }
  assert.equal(r.status, 502)
  assert.deepEqual(r.json, { error: 'marker_append_failed' })
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n, 0)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='milestone'").get().n, 0)
  // The next attempt, with the disk back, still works (nothing was wedged).
  assert.equal((await post(s, agent.token, { title: 'lands' })).status, 201)
})

// Final review minor: the fields and the mission move are ONE write. Over
// real HTTP that has to show as one marker and one `updated_at` — the two
// old statements stamped the row twice and could have half-applied.
test('PATCH /items/:id {title, mission}: both land in one write, one updated_at, one `updated` marker', async (t) => {
  const { s, agent } = await fleet(t)
  const m = (await start(s, agent.token, {})).json.mission
  const it = (await item(s, agent.token, { convo_id: 'c2' })).json.item
  assert.equal(it.mission_id, null)
  const before = s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='item'").get().n
  const r = await s.http(`/items/${it.id}`, { method: 'PATCH', token: agent.token, body: { title: 'Renamed', mission: `#${m.num}` } })
  assert.equal(r.status, 200)
  assert.equal(r.json.item.title, 'Renamed')
  assert.equal(r.json.item.mission_id, m.id)
  assert.equal(r.json.item.mission_num, m.num)
  const row = s.db.prepare('SELECT title, mission_id, updated_at FROM items WHERE id=?').get(it.id)
  assert.equal(row.title, 'Renamed'); assert.equal(row.mission_id, m.id)
  assert.equal(row.updated_at, r.json.item.updated_at)
  const markers = s.db.prepare("SELECT payload FROM events WHERE type='item' ORDER BY seq").all().slice(before)
  assert.equal(markers.length, 1)
  assert.equal(JSON.parse(markers[0].payload).action, 'updated')
  // An unknown or invisible mission is 404 and changes NOTHING, title included.
  const bad = await s.http(`/items/${it.id}`, { method: 'PATCH', token: agent.token, body: { title: 'Nope', mission: '#4242' } })
  assert.equal(bad.status, 404)
  assert.equal(s.db.prepare('SELECT title FROM items WHERE id=?').get(it.id).title, 'Renamed')
})

// Final review, I2 (accepted exception): three values let a filtered caller
// learn that hidden rows EXIST without ever naming them —
// `closed_over_open_items`, the close marker's `open_item_nums`, and
// `mission_num` on an item whose mission the caller cannot read. The ruling
// is that number-only exposure is allowed and documented (docs/protocol.md,
// "Accepted exception — numbers, never words"); this test pins BOTH halves,
// so neither the numbers nor the silence around them can drift.
test('accepted exception: hidden items are counted in closed_over_open_items and named by number in the close marker — never by title', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret2', ownerUserId: dan.id, title: 'S2', agentDeviceId: priv.deviceId })
  const pub = (await start(s, agent.token, {})).json.mission
  assert.equal((await s.http(`/missions/${pub.id}/join`, { method: 'POST', token: priv.token, body: { convo_id: 'secret2' } })).status, 200)
  const hiddenItem = (await s.http('/items', { method: 'POST', token: priv.token, body: { kind: 'task', title: 'SECRET-TITLE', convo_id: 'secret2' } })).json.item
  assert.equal(hiddenItem.mission_id, pub.id)

  // The hidden item BLOCKS the ordinary agent's close (it is open, whether
  // or not this caller may see it) but is never named in the 409.
  const blocked = await s.http(`/missions/${pub.id}/close`, { method: 'POST', token: agent.token, body: { summary: 'done' } })
  assert.equal(blocked.status, 409); assert.equal(blocked.json.blocked_by, 'agent_items')
  assert.deepEqual(blocked.json.items, [])
  assert.ok(!JSON.stringify(blocked.json).includes('SECRET-TITLE'))

  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const closed = await s.http(`/missions/${pub.id}/close`, { method: 'POST', token: client, body: { summary: 'closing over it' } })
  assert.equal(closed.status, 200)
  assert.equal(closed.json.mission.closed_over_open_items, 1)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.payload?.action === 'closed')
  ws.close()
  assert.deepEqual(marker.payload.open_item_nums, [hiddenItem.num])
  assert.ok(!JSON.stringify(marker.payload).includes('SECRET-TITLE'))

  // The ordinary agent reads the closed mission: the raw count crosses the
  // sieve, every WORD stays behind it.
  const asAgent = await s.http(`/missions/${pub.id}`, { token: agent.token })
  assert.equal(asAgent.status, 200)
  assert.equal(asAgent.json.mission.closed_over_open_items, 1)
  assert.equal(asAgent.json.mission.open_items, 0)
  assert.deepEqual(asAgent.json.items, [])
  assert.ok(!JSON.stringify(asAgent.json).includes('SECRET-TITLE'))
})

test('accepted exception: an item the caller CAN see carries mission_num for a mission it cannot — the number only, and the mission itself still 404s', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  const hidden = (await s.http('/missions', { method: 'POST', token: priv.token, body: { title: 'SECRET-TITLE', convo_id: 'secret' } })).json.mission
  const pubItem = (await item(s, agent.token, {})).json.item
  // Only the user can perform this move — the agent's own PATCH 404s (C1/Critical 3).
  assert.equal((await s.http(`/items/${pubItem.id}`, { method: 'PATCH', token: agent.token, body: { mission: hidden.id } })).status, 404)
  assert.equal((await s.http(`/items/${pubItem.id}`, { method: 'PATCH', token: client, body: { mission: hidden.id } })).status, 200)
  const seen = (await s.http(`/items/${pubItem.id}`, { token: agent.token })).json.item
  assert.equal(seen.mission_num, hidden.num)
  assert.equal(seen.mission_id, hidden.id)
  assert.ok(!JSON.stringify(seen).includes('SECRET-TITLE'))
  // The number is a dead end: it resolves to nothing on every mission route.
  assert.equal((await s.http(`/missions/%23${hidden.num}`, { token: agent.token })).status, 404)
  assert.equal((await s.http(`/missions/${hidden.id}`, { token: agent.token })).status, 404)
  assert.equal((await s.http('/missions', { token: agent.token })).json.missions.length, 0)
})

// Final review, I4(a): ownership. The brief named `GET /missions/:id/milestones`;
// there is no such route — a mission's milestones come back inside
// `GET /missions/:id`, and the per-conversation list is `GET /milestones?convo=`.
// Both are covered here, alongside every other mission route, from ANOTHER
// user's agent: numbers and ids are per-user, so a foreign caller must get the
// same 404 an unknown mission gets, never 403 and never a row.
test('ownership: another user\'s agent gets 404 on every mission route — detail, milestones, patch, join, close, item move', async (t) => {
  const { s, agent, patAgent } = await fleet(t)
  const m = (await start(s, agent.token, {})).json.mission
  assert.equal((await post(s, agent.token, { title: 'step' })).status, 201)
  const it = (await item(s, agent.token, {})).json.item

  for (const path of [`/missions/${m.id}`, `/missions/%23${m.num}`]) {
    const r = await s.http(path, { token: patAgent.token })
    assert.equal(r.status, 404, `${path} must 404 for another user`)
    assert.deepEqual(r.json, { error: 'not_found' })
  }
  assert.equal((await s.http(`/missions/${m.id}`, { method: 'PATCH', token: patAgent.token, body: { title: 'theirs' } })).status, 404)
  assert.equal((await s.http(`/missions/${m.id}/join`, { method: 'POST', token: patAgent.token, body: { convo_id: 'p1' } })).status, 404)
  assert.equal((await s.http(`/missions/${m.id}/close`, { method: 'POST', token: patAgent.token, body: { summary: 'mine now' } })).status, 404)
  // The per-conversation milestone list, by dan's convo id and by pat's own.
  assert.equal((await s.http('/milestones?convo=c1', { token: patAgent.token })).status, 404)
  assert.deepEqual((await s.http('/milestones?convo=p1', { token: patAgent.token })).json.milestones, [])
  // And dan's item is not a way in either.
  assert.equal((await s.http(`/items/${it.id}`, { method: 'PATCH', token: patAgent.token, body: { mission: m.id } })).status, 404)
  assert.equal((await s.http('/missions', { token: patAgent.token })).json.missions.length, 0)
  // Nothing changed on dan's side.
  const still = await s.http(`/missions/${m.id}`, { token: agent.token })
  assert.equal(still.json.mission.title, 'Missions'); assert.equal(still.json.mission.state, 'open')
  assert.equal(still.json.milestones.length, 1)
})

// Fix round 3, B1: repointItems (called from both createMission and
// joinMission via attachConversation) used to leave the repointed item's
// own updated_at untouched, so a client syncing GET /items?since= never
// learned the item gained a mission. `since` is captured strictly between
// the item's creation and the mission's creation (a real sleep either side,
// not just two Date.now() calls, since both run synchronously in the same
// millisecond otherwise) so the assertion actually exercises the bump: the
// item's ORIGINAL updated_at is before the cursor; only a bumped one clears it.
test('GET /items?since=: repointItems bumps the repointed items updated_at, so a since sync sees the new mission_id/mission_num', async (t) => {
  const { s, agent, client } = await fleet(t)
  const it = (await item(s, agent.token, {})).json.item
  await new Promise((r) => setTimeout(r, 10))
  const since = Date.now()
  await new Promise((r) => setTimeout(r, 10))
  const m = (await start(s, agent.token, {})).json.mission

  const synced = await s.http(`/items?since=${since}`, { token: client })
  assert.equal(synced.status, 200)
  const found = synced.json.items.find((x) => x.id === it.id)
  assert.ok(found, 'the repointed item must appear in a since= sync after gaining a mission')
  assert.equal(found.mission_id, m.id)
  assert.equal(found.mission_num, m.num)
  assert.ok(found.updated_at >= since)

  // Same bump on the join path, not just create: a second item on c2,
  // joined to the same mission after its own since cursor.
  const it2 = (await item(s, agent.token, { convo_id: 'c2' })).json.item
  await new Promise((r) => setTimeout(r, 10))
  const since2 = Date.now()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((await s.http(`/missions/${m.id}/join`, { method: 'POST', token: agent.token, body: { convo_id: 'c2' } })).status, 200)
  const synced2 = await s.http(`/items?since=${since2}`, { token: client })
  const found2 = synced2.json.items.find((x) => x.id === it2.id)
  assert.ok(found2, 'joinMission\'s repoint must also bump updated_at')
  assert.equal(found2.mission_id, m.id)
})

// Fix round 3, B2: `GET /missions` sorted on the STORED last_milestone_at
// (and the row's own updated_at), both of which a milestone posted on a
// private-owned conversation bumps whether or not the caller is allowed to
// see it — an ordinary agent's list could jump a mission to the top while
// its own row on that same list shows last_milestone: null, milestones: 0,
// disagreeing with the position it was just given. The fix orders a
// filtered caller's list on the SIEVED last-milestone timestamp instead;
// the owner's own (unsieved) list is unchanged.
test('GET /missions: list order follows the SIEVED last-milestone timestamp for a filtered caller — a hidden milestone cannot jump a mission to the top', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret2', ownerUserId: dan.id, title: 'S2', agentDeviceId: priv.deviceId })

  const older = (await start(s, agent.token, { convo_id: 'c1', title: 'Older' })).json.mission
  await new Promise((r) => setTimeout(r, 10))
  const newer = (await start(s, agent.token, { convo_id: 'c2', title: 'Newer' })).json.mission

  // Baseline, before any milestone: both last_milestone null, so the newer
  // mission (later created_at) sorts first for everyone.
  const baseline = (await s.http('/missions', { token: agent.token })).json.missions.map((x) => x.id)
  assert.deepEqual(baseline, [newer.id, older.id])

  // Join the private-owned convo to the OLDER mission, then post a milestone
  // from it — this bumps `older`'s stored last_milestone_at/updated_at, but
  // the milestone lives on a conversation the ordinary agent cannot see.
  assert.equal((await s.http(`/missions/${older.id}/join`, { method: 'POST', token: priv.token, body: { convo_id: 'secret2' } })).status, 200)
  const hidden = await post(s, priv.token, { convo_id: 'secret2', title: 'hidden step' })
  assert.equal(hidden.status, 201)

  const asAgent = await s.http('/missions', { token: agent.token })
  const olderForAgent = asAgent.json.missions.find((x) => x.id === older.id)
  assert.equal(olderForAgent.last_milestone, null)
  assert.equal(olderForAgent.milestones, 0)
  // The order must agree with the row it shows: `older` still has no
  // visible milestone, so it must not have jumped ahead of `newer`.
  assert.deepEqual(asAgent.json.missions.map((x) => x.id), [newer.id, older.id])

  // The user's own (unsieved) list sees the real milestone and puts `older` first.
  const asClient = await s.http('/missions', { token: client })
  assert.deepEqual(asClient.json.missions.map((x) => x.id), [older.id, newer.id])
  assert.equal(asClient.json.missions.find((x) => x.id === older.id).last_milestone.title, 'hidden step')
})
