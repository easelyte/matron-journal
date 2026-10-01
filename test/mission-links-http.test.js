import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'
import { saveGithubIdentity } from '../src/github-accounts.js'

async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  const patAgent = createAgent(s.db, pat.id, 'pat-box')
  for (const id of ['c1', 'c2', 'c3']) upsertConversation(s.db, { id, ownerUserId: dan.id, title: id.toUpperCase(), agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, title: 'P1', agentDeviceId: patAgent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  return { s, dan, pat, agent, patAgent, client: login.json.token }
}
const start = (s, token, body) => s.http('/missions', { method: 'POST', token, body: { title: 'A', convo_id: 'c1', ...body } })
const join = (s, token, missionId, convoId) => s.http(`/missions/${missionId}/join`, { method: 'POST', token, body: { convo_id: convoId } })
const markerCount = (s, convoId, action) => s.db.prepare(
  "SELECT COUNT(*) AS n FROM events WHERE convo_id=? AND type='mission' AND json_extract(payload,'$.action')=?").get(convoId, action).n

test('POST /missions/:id/join: a conversation on another mission now joins (200, was 409 other_mission), becomes current, and the marker says which', async (t) => {
  const { s, agent, client } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const b = (await start(s, agent.token, { title: 'B', convo_id: 'c2' })).json.mission
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const j = await join(s, agent.token, b.id, 'c1')
  assert.equal(j.status, 200); assert.equal(j.json.mission.id, b.id)
  const joined = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.convo_id === 'c1' && f.payload.action === 'joined')
  assert.equal(joined.payload.num, b.num)
  assert.equal((await join(s, agent.token, a.id, 'c1')).status, 200)
  const moved = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.convo_id === 'c1' && f.payload.action === 'current_changed')
  assert.equal(moved.payload.num, a.num)
  ws.close()
  // Re-joining the current mission: 200, no new marker.
  assert.equal((await join(s, agent.token, a.id, 'c1')).status, 200)
  assert.equal(markerCount(s, 'c1', 'current_changed'), 1)
  assert.equal(markerCount(s, 'c1', 'joined'), 1)
})

test('POST /missions/:id/leave: ends the link, moves current, writes left + current_changed; repeat is a 200 no-op; no link, foreign or unknown convo is 404', async (t) => {
  const { s, agent, client } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const b = (await start(s, agent.token, { title: 'B', convo_id: 'c2' })).json.mission
  await join(s, agent.token, b.id, 'c1')
  const leave = (missionId, convoId, token = agent.token) => s.http(`/missions/${missionId}/leave`, { method: 'POST', token, body: { convo_id: convoId } })
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await leave(b.id, 'c1')
  assert.equal(r.status, 200)
  assert.equal(r.json.mission.id, b.id); assert.equal(r.json.current_mission.id, a.id)
  const left = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.convo_id === 'c1' && f.payload.action === 'left')
  assert.equal(left.payload.num, b.num)
  const moved = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.convo_id === 'c1' && f.payload.action === 'current_changed')
  assert.equal(moved.payload.num, a.num)
  ws.close()
  const again = await leave(b.id, 'c1')
  assert.equal(again.status, 200); assert.equal(markerCount(s, 'c1', 'left'), 1)
  assert.equal((await leave(b.id, 'c3')).status, 404, 'no link')
  assert.equal((await leave(b.id, 'p1')).status, 404, 'another user\'s conversation')
  assert.equal((await leave(b.id, 'nope')).status, 404)
  // Leaving the last one: current_mission null, and no current_changed marker.
  const last = await leave(a.id, 'c1')
  assert.equal(last.status, 200); assert.equal(last.json.current_mission, null)
  assert.equal(markerCount(s, 'c1', 'current_changed'), 1)
})

test('GET /conversations/:id/missions: the header list for own conversations only; 404 for another user\'s, an unknown one, or (ordinary agent) a private-owned one', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const b = (await start(s, agent.token, { title: 'B', convo_id: 'c2' })).json.mission
  await join(s, agent.token, b.id, 'c1')
  for (const token of [agent.token, client]) {
    const r = await s.http('/conversations/c1/missions', { token })
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.missions.map((m) => [m.num, m.current, m.active]), [[b.num, true, true], [a.num, false, true]])
  }
  assert.equal((await s.http('/conversations/p1/missions', { token: client })).status, 404)
  assert.equal((await s.http('/conversations/nope/missions', { token: client })).status, 404)
  assert.equal((await s.http('/conversations/c1/missions', { method: 'POST', token: client, body: {} })).status, 404)
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  assert.equal((await s.http('/conversations/secret/missions', { token: agent.token })).status, 404)
  const own = await s.http('/conversations/secret/missions', { token: client })
  assert.equal(own.status, 200); assert.deepEqual(own.json.missions, [])
})

test('GET /missions/:id folds sub-chats by default and lists them with ?subchats=1', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  upsertConversation(s.db, { id: 'kid', ownerUserId: dan.id, title: 'kid', agentDeviceId: agent.deviceId, parentConvoId: 'c1' })
  // Pin the order: both links can be stamped in the same millisecond.
  s.db.prepare("UPDATE mission_conversations SET joined_at=1 WHERE convo_id='c1'").run()
  const folded = await s.http(`/missions/${a.num}`, { token: client })
  assert.deepEqual(folded.json.conversations.map((c) => [c.id, c.subchat_count]), [['c1', 1]])
  assert.deepEqual(folded.json.conversations[0].other_missions, [])
  assert.equal(folded.json.mission.conversations, 1)
  const open = await s.http(`/missions/${a.num}?subchats=1`, { token: client })
  assert.deepEqual(open.json.conversations.map((c) => [c.id, c.parent_convo_id]), [['c1', null], ['kid', 'c1']])
})

test('GET /missions/:id lists only ACTIVE links by default (old apps never see a conversation that left); ?history=1 adds ended ones with ended_at; both flags combine', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  await join(s, agent.token, a.id, 'c2')
  upsertConversation(s.db, { id: 'kid', ownerUserId: dan.id, title: 'kid', agentDeviceId: agent.deviceId, parentConvoId: 'c1' })
  await s.http(`/missions/${a.id}/leave`, { method: 'POST', token: agent.token, body: { convo_id: 'c2' } })
  for (const [id, at] of [['c1', 1], ['kid', 2], ['c2', 3]]) s.db.prepare('UPDATE mission_conversations SET joined_at=? WHERE convo_id=?').run(at, id)
  const ids = async (q) => (await s.http(`/missions/${a.num}${q}`, { token: client })).json.conversations.map((c) => [c.id, c.ended_at === null])
  assert.deepEqual(await ids(''), [['c1', true]])
  assert.deepEqual(await ids('?history=1'), [['c1', true], ['c2', false]])
  assert.deepEqual(await ids('?subchats=1'), [['c1', true], ['kid', true]])
  assert.deepEqual(await ids('?subchats=1&history=1'), [['c1', true], ['kid', true], ['c2', false]])
  const hist = await s.http(`/missions/${a.num}?history=1`, { token: client })
  assert.equal(typeof hist.json.conversations[1].ended_at, 'number')
})

test('close gate: an agent naming a conversation that is ALSO ON the mission (active, not current) may close it; one that left may not', async (t) => {
  const { s, agent } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const b = (await start(s, agent.token, { title: 'B', convo_id: 'c2' })).json.mission
  await join(s, agent.token, b.id, 'c1')                        // c1 current on B, still active on A
  await join(s, agent.token, a.id, 'c3')
  await s.http(`/missions/${a.id}/leave`, { method: 'POST', token: agent.token, body: { convo_id: 'c3' } })
  const close = (convoId) => s.http(`/missions/${a.id}/close`, { method: 'POST', token: agent.token, body: { summary: 'done', convo_id: convoId } })
  const refused = await close('c3')
  assert.equal(refused.status, 403); assert.equal(refused.json.detail, 'not_coordinator')
  const ok = await close('c1')
  assert.equal(ok.status, 200)
  assert.deepEqual([ok.json.mission.state, ok.json.mission.closed_convo_id], ['closed', 'c1'])
})

test('shared view reads active links: a joined shared conversation shows, sub-chats fold (count equals list), and one that left drops out', async (t) => {
  const { s, dan, pat, agent } = await fleet(t)
  const link = (u, gid) => saveGithubIdentity(s.db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: u.name, scopes: ['github.com/matronhq'] }, token: `t${gid}`, now: 1 })
  link(dan, 1); link(pat, 2)
  const patClient = (await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw', device_name: 'mac' } })).json.token
  const repo = 'github.com/matronhq/journal'
  // Born on c2 (no repo): shared only through the joined c1.
  const m = (await start(s, agent.token, { title: 'Born elsewhere', convo_id: 'c2' })).json.mission
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, agentDeviceId: agent.deviceId, repo })
  await join(s, agent.token, m.id, 'c1')
  upsertConversation(s.db, { id: 'kid', ownerUserId: dan.id, title: 'kid', agentDeviceId: agent.deviceId, parentConvoId: 'c1', repo })
  s.db.prepare("UPDATE mission_conversations SET joined_at=1 WHERE convo_id='c1'").run()
  const detail = await s.http(`/missions/${m.id}`, { token: patClient })
  assert.equal(detail.status, 200)
  assert.deepEqual(detail.json.conversations.map((c) => [c.id, c.subchat_count]), [['c1', 1]])
  assert.equal(detail.json.mission.conversations, detail.json.conversations.length)
  const listed = (await s.http('/missions?scope=shared', { token: patClient })).json.missions
  assert.deepEqual(listed.map((x) => [x.id, x.conversations]), [[m.id, 1]])
  const open = await s.http(`/missions/${m.id}?subchats=1`, { token: patClient })
  assert.deepEqual(open.json.conversations.map((c) => [c.id, c.parent_convo_id]), [['c1', null], ['kid', 'c1']])
  // c1 and its sub-chat leave: nothing shared is left on the mission, so pat loses it.
  for (const id of ['kid', 'c1']) await s.http(`/missions/${m.id}/leave`, { method: 'POST', token: agent.token, body: { convo_id: id } })
  assert.equal((await s.http(`/missions/${m.id}`, { token: patClient })).status, 404)
  assert.deepEqual((await s.http('/missions?scope=shared', { token: patClient })).json.missions, [])
})

test('shared view: a shared sub-chat whose parent the colleague cannot read carries parent_convo_id null', async (t) => {
  const { s, dan, pat, agent, client } = await fleet(t)
  const link = (u, gid) => saveGithubIdentity(s.db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: u.name, scopes: ['github.com/matronhq'] }, token: `t${gid}`, now: 1 })
  link(dan, 1); link(pat, 2)
  const patClient = (await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw', device_name: 'mac' } })).json.token
  const repo = 'github.com/matronhq/journal'
  // c2 has no repo: pat cannot read it. Its sub-chat kid carries a shared repo.
  const m = (await start(s, agent.token, { title: 'M', convo_id: 'c2' })).json.mission
  upsertConversation(s.db, { id: 'kid', ownerUserId: dan.id, title: 'kid', agentDeviceId: agent.deviceId, parentConvoId: 'c2', repo })
  const shared = await s.http(`/missions/${m.id}`, { token: patClient })
  assert.equal(shared.status, 200)
  assert.deepEqual(shared.json.conversations.map((c) => [c.id, c.parent_convo_id]), [['kid', null]])
  assert.equal(JSON.stringify(shared.json.conversations).includes('c2'), false)
  const own = await s.http(`/missions/${m.id}?subchats=1`, { token: client })
  assert.equal(own.json.conversations.find((c) => c.id === 'kid').parent_convo_id, 'c2')
})

test('POST /milestones {mission}: names an also-on mission; 409 not_linked when not an active link; 400 on a bad type; old callers unchanged', async (t) => {
  const { s, agent } = await fleet(t)
  const a = (await start(s, agent.token, {})).json.mission
  const b = (await start(s, agent.token, { title: 'B', convo_id: 'c2' })).json.mission
  await join(s, agent.token, b.id, 'c1')
  const post = (body) => s.http('/milestones', { method: 'POST', token: agent.token, body: { convo_id: 'c1', kind: 'progress', title: 'step', ...body } })
  const plain = await post({})
  assert.equal(plain.status, 201); assert.equal(plain.json.mission.id, b.id)
  const named = await post({ mission: `#${a.num}` })
  assert.equal(named.status, 201); assert.equal(named.json.milestone.mission_id, a.id)
  const marker = s.db.prepare("SELECT payload FROM events WHERE type='milestone' AND seq=?").get(named.json.milestone.seq)
  assert.equal(JSON.parse(marker.payload).mission_num, a.num)
  const c = (await start(s, agent.token, { title: 'C', convo_id: 'c3' })).json.mission
  const refused = await post({ mission: c.num })
  assert.equal(refused.status, 409); assert.deepEqual(refused.json, { error: 'conflict', blocked_by: 'not_linked' })
  assert.equal((await post({ mission: { id: a.id } })).status, 400)
  assert.equal((await post({ mission: null })).status, 201, 'null = the current mission')
})
