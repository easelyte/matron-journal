import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'
import { saveGithubIdentity } from '../src/github-accounts.js'
import { createProject, closeProject, mergeProject } from '../src/projects.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'

async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  const priv = createAgent(s.db, dan.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  for (const id of ['c1', 'c2', 'c3']) upsertConversation(s.db, { id, ownerUserId: dan.id, title: id, agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'secret', ownerUserId: dan.id, title: 'S', agentDeviceId: priv.deviceId })
  const tok = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: 'mac' } })).json.token
  return { s, dan, pat, agent, priv, client: await tok('dan'), patClient: await tok('pat') }
}
const seedProject = (s, dan, deviceId, extra = {}) => createProject(s.db, { userId: dan.id, deviceId, createdBy: 'agent', title: 'Promo launch', ...extra }).project
const startMission = (s, token, body, headers = {}) => s.http('/missions', { method: 'POST', token, body: { title: 'M', convo_id: 'c1', ...body }, headers })

test('POST /missions {project}: files the new mission; unknown/hidden 404, closed 409 project_closed, bad type 400; ignored on existing and on an idem_key replay', async (t) => {
  const { s, dan, agent, priv } = await fleet(t)
  const p = seedProject(s, dan, agent.deviceId)
  const r = await startMission(s, agent.token, { project: `#${p.num}` })
  assert.equal(r.status, 201); assert.equal(r.json.mission.project_id, p.id); assert.equal(r.json.mission.project_num, p.num)
  // D5: the `existing: true` short-circuit ignores `project` outright — a
  // bogus reference here must NOT 404 (it would if the peek were removed).
  const again = await startMission(s, agent.token, { project: '#999', title: 'other' })
  assert.equal(again.status, 200); assert.equal(again.json.existing, true); assert.equal(again.json.mission.project_id, p.id)
  assert.equal((await startMission(s, agent.token, { convo_id: 'c2', project: '#999' })).status, 404)
  const hidden = seedProject(s, dan, priv.deviceId, { title: 'Hidden' })
  assert.equal((await startMission(s, agent.token, { convo_id: 'c2', project: hidden.id })).status, 404)
  const closed = seedProject(s, dan, agent.deviceId, { title: 'Done' })
  closeProject(s.db, { userId: dan.id, projectId: closed.id, by: 'user', summary: 'x' })
  const refused = await startMission(s, agent.token, { convo_id: 'c2', project: closed.num })
  assert.equal(refused.status, 409); assert.equal(refused.json.blocked_by, 'project_closed')
  assert.equal((await startMission(s, agent.token, { convo_id: 'c2', project: { id: p.id } })).status, 400)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM missions WHERE origin_convo_id='c2'").get().n, 0, 'nothing created on a refusal')
  // D5: an idem_key replay is the OTHER short-circuit createsNewMission must
  // catch — the second request names a closed project, and still gets back
  // the original mission with its original (unrelated) project untouched.
  const first = await startMission(s, agent.token, { convo_id: 'c3', project: p.id }, { 'idempotency-key': 'ik1' })
  assert.equal(first.status, 201); assert.equal(first.json.mission.project_id, p.id)
  const replay = await startMission(s, agent.token, { convo_id: 'c3', project: closed.id }, { 'idempotency-key': 'ik1' })
  assert.equal(replay.status, 200); assert.equal(replay.json.mission.id, first.json.mission.id); assert.equal(replay.json.mission.project_id, p.id)
})

test('PATCH /missions/:id {project}: moves and detaches with a project_changed marker on the origin; a closed mission may be refiled but not edited; a colleague never sees project_id', async (t) => {
  const { s, dan, pat, agent, client, patClient } = await fleet(t)
  const p = seedProject(s, dan, agent.deviceId); const q = seedProject(s, dan, agent.deviceId, { title: 'Other' })
  const m = (await startMission(s, agent.token, {})).json.mission
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const patch = (body, token = agent.token) => s.http(`/missions/${m.id}`, { method: 'PATCH', token, body })
  const filed = await patch({ project: p.id })
  assert.equal(filed.status, 200); assert.equal(filed.json.mission.project_num, p.num)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.payload.action === 'updated')
  assert.equal(marker.convo_id, 'c1'); assert.equal(marker.payload.project_changed, true)
  ws.close()
  assert.equal((await patch({ project: null })).json.mission.project_id, null)
  await s.http(`/missions/${m.id}/close`, { method: 'POST', token: client, body: { summary: 'done' } })
  const refiled = await patch({ project: `#${q.num}` })
  assert.equal(refiled.status, 200); assert.equal(refiled.json.mission.project_id, q.id)
  assert.equal((await patch({ title: 'x' })).status, 409)
  assert.equal((await patch({ project: q.id, title: 'x' })).status, 409, 'a closed mission refiles with project alone')
  assert.equal((await patch({})).status, 400)
  // A merged project is closed on its own row (§4.2 "writes address the row
  // itself"); naming it directly is the same refusal as any other closed one.
  const src = seedProject(s, dan, agent.deviceId, { title: 'Src' })
  mergeProject(s.db, { userId: dan.id, projectId: src.id, intoId: q.id, by: 'user' })
  const mergedRef = await patch({ project: src.id })
  assert.equal(mergedRef.status, 409); assert.equal(mergedRef.json.blocked_by, 'project_closed')
  // A colleague reading the shared mission never learns which project it is in.
  for (const [u, gid] of [[dan, 1], [pat, 2]]) {
    saveGithubIdentity(s.db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: u.name, scopes: ['github.com/matronhq'] }, token: `t${gid}`, now: 1 })
  }
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, repo: 'github.com/matronhq/x' })
  const shared = await s.http('/missions?scope=shared', { token: patClient })
  assert.equal(shared.json.missions.length, 1)
  assert.equal(shared.json.missions[0].project_id, null); assert.equal(shared.json.missions[0].project_num, null)
})

const newProject = (s, token, body = {}, headers = {}) => s.http('/projects', { method: 'POST', token, body: { title: 'Promo launch', ...body }, headers })

test('POST/GET/PATCH /projects: any agent creates (idempotent), lists with rollups, sets status; 400/404 on junk; a private-origin project is invisible to an ordinary agent', async (t) => {
  const { s, agent, priv, client } = await fleet(t)
  const r = await newProject(s, agent.token, { body: 'Launch week', convo_id: 'c1' }, { 'idempotency-key': 'p1' })
  assert.equal(r.status, 201)
  const p = r.json.project
  assert.match(p.id, /^pj_/); assert.equal(p.origin_convo_id, 'c1')
  assert.deepEqual(p.missions, { running: 0, waiting: 0, idle: 0, quiet: 0, closed: 0 })
  assert.equal((await newProject(s, agent.token, {}, { 'idempotency-key': 'p1' })).status, 200)
  assert.equal((await newProject(s, agent.token, { title: '' })).status, 400)
  assert.equal((await newProject(s, agent.token, { convo_id: 'nope' })).status, 404)
  const nullConvo = await newProject(s, agent.token, { title: 'No convo', convo_id: null })
  assert.equal(nullConvo.status, 201, 'convo_id: null is the same as leaving it out'); assert.equal(nullConvo.json.project.origin_convo_id, null)
  assert.equal((await newProject(s, client, { title: 'From the app' })).status, 201)
  await startMission(s, agent.token, { project: p.id })
  const list = await s.http('/projects?state=open', { token: client })
  assert.equal(list.status, 200)
  const row = list.json.projects.find((x) => x.id === p.id)
  assert.equal(row.missions.running, 1); assert.equal(typeof row.last_activity_at, 'number')
  assert.equal((await s.http('/projects?state=bogus', { token: client })).status, 400)
  const st = await s.http(`/projects/${p.num}`, { method: 'PATCH', token: agent.token, body: { status: 'Launch Wed', convo_id: 'c1' } })
  assert.equal(st.status, 200); assert.equal(st.json.project.status, 'Launch Wed'); assert.equal(st.json.project.status_convo_id, 'c1')
  assert.equal((await s.http(`/projects/${p.num}`, { method: 'PATCH', token: agent.token, body: { status: 'x'.repeat(601) } })).status, 400)
  assert.equal((await s.http(`/projects/${p.num}`, { method: 'PATCH', token: agent.token, body: {} })).status, 400)
  const hidden = (await newProject(s, priv.token, { title: 'Secret', convo_id: 'secret' })).json.project
  assert.equal((await s.http(`/projects/${hidden.num}`, { token: agent.token })).status, 404)
  assert.equal((await s.http('/projects', { token: agent.token })).json.projects.some((x) => x.id === hidden.id), false)
  assert.equal((await s.http(`/projects/${hidden.num}`, { token: client })).status, 200)
  const detail = await s.http(`/projects/${p.id}`, { token: client })
  assert.deepEqual(Object.keys(detail.json).sort(), ['missions', 'needs_you', 'project', 'recent_milestones', 'sessions_by_box'])
  assert.deepEqual(detail.json.sessions_by_box, { 'dev-2': 1 })
})

test('close and merge: user or Coordinator only (403 not_coordinator otherwise); open missions block the Coordinator; merge moves missions with markers and redirects reads and /lookup', async (t) => {
  const { s, dan, agent, client } = await fleet(t)
  const a = (await newProject(s, agent.token, { title: 'A' })).json.project
  const b = (await newProject(s, agent.token, { title: 'B' })).json.project
  const m = (await startMission(s, agent.token, { project: a.id })).json.mission
  const close = (id, token, extra = {}) => s.http(`/projects/${id}/close`, { method: 'POST', token, body: { summary: 'done', ...extra } })
  const merge = (id, token, extra = {}) => s.http(`/projects/${id}/merge`, { method: 'POST', token, body: { into: b.id, ...extra } })
  for (const extra of [{}, { convo_id: 'c1' }]) {
    const r = await close(a.id, agent.token, extra)
    assert.equal(r.status, 403); assert.deepEqual(r.json, { error: 'forbidden', detail: 'not_coordinator' })
    assert.equal((await merge(a.id, agent.token, extra)).status, 403)
  }
  setCoordinatorConvoId(s.db, dan.id, 'c2')
  const blocked = await close(a.id, agent.token, { convo_id: 'c2' })
  assert.equal(blocked.status, 409); assert.equal(blocked.json.blocked_by, 'open_missions')
  assert.deepEqual(blocked.json.missions, [{ num: m.num, title: 'M' }])
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const merged = await merge(a.id, agent.token, { convo_id: 'c2' })
  assert.equal(merged.status, 200)
  assert.equal(merged.json.project.id, b.id); assert.equal(merged.json.merged.merged_into, b.id)
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'mission' && f.payload.action === 'updated' && f.payload.project_changed)
  assert.equal(marker.payload.num, m.num); assert.equal(marker.convo_id, 'c1')
  ws.close()
  assert.equal((await s.http(`/missions/${m.id}`, { token: client })).json.mission.project_id, b.id)
  const redirected = await s.http(`/projects/${a.num}`, { token: client })
  assert.equal(redirected.status, 200); assert.equal(redirected.json.project.id, b.id)
  assert.deepEqual(redirected.json.merged_from, { id: a.id, num: a.num })
  const look = await s.http(`/lookup?user=dan&num=${a.num}`, { token: client })
  assert.deepEqual(look.json, { kind: 'project', id: b.id, merged_from: a.id, owner: { user_id: dan.id, name: 'dan' } })
  assert.deepEqual((await s.http(`/lookup?user=dan&num=${b.num}`, { token: client })).json, { kind: 'project', id: b.id, owner: { user_id: dan.id, name: 'dan' } })
  assert.equal((await s.http(`/projects/${a.id}`, { method: 'PATCH', token: client, body: { title: 'x' } })).status, 409, 'writes address the merged row')
  assert.equal((await merge(b.id, client, { into: b.id })).status, 400)
  const c = (await newProject(s, client, { title: 'C' })).json.project
  assert.equal((await merge(c.id, client, { into: a.id })).status, 409)
  assert.equal((await merge(c.id, client, { into: '#999' })).status, 404)
  const forced = await close(b.id, client)
  assert.equal(forced.status, 200); assert.equal(forced.json.project.closed_over_open_missions, 1)
  assert.equal((await close(b.id, client)).status, 409)
})

test('close and merge sieve both ends first: a project the filtered Coordinator cannot see is 404 as :id or as into; a hidden mission moved by a merge is never echoed', async (t) => {
  const { s, dan, agent, priv, client } = await fleet(t)
  setCoordinatorConvoId(s.db, dan.id, 'c2')
  const pub = (await newProject(s, agent.token, { title: 'Pub' })).json.project
  const pub2 = (await newProject(s, agent.token, { title: 'Pub2' })).json.project
  const hidden = (await newProject(s, priv.token, { title: 'Hidden', convo_id: 'secret' })).json.project
  const coord = { convo_id: 'c2' }
  const close = (id) => s.http(`/projects/${id}/close`, { method: 'POST', token: agent.token, body: { summary: 'done', ...coord } })
  const merge = (id, into) => s.http(`/projects/${id}/merge`, { method: 'POST', token: agent.token, body: { into, ...coord } })
  assert.deepEqual((await close(hidden.id)).json, { error: 'not_found' })
  assert.equal((await merge(hidden.id, pub.id)).status, 404)
  assert.equal((await merge(pub.id, hidden.num)).status, 404)
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE state='closed'").get().n, 0, 'nothing written on a refusal')
  // A private-origin mission filed into a project the Coordinator CAN see
  // still moves with it (every mission moves) — but its id never comes back.
  const secretMission = (await s.http('/missions', { method: 'POST', token: priv.token, body: { title: 'Private work', convo_id: 'secret', project: pub.id } })).json.mission
  const r = await merge(pub.id, pub2.id)
  assert.equal(r.status, 200)
  const text = JSON.stringify(r.json)
  assert.equal(text.includes(secretMission.id), false); assert.equal(text.includes('Private work'), false)
  assert.equal(r.json.project.missions.running + r.json.project.missions.idle + r.json.project.missions.waiting, 0, 'the hidden mission adds to no rollup')
  assert.equal((await s.http(`/missions/${secretMission.id}`, { token: client })).json.mission.project_id, pub2.id)
})

test('a merge chain A into B then B into C: /lookup #A and GET /projects/A both land on C with merged_from', async (t) => {
  const { s, dan, client } = await fleet(t)
  const mk = async (title) => (await newProject(s, client, { title })).json.project
  const pa = await mk('A'); const pb = await mk('B'); const pc = await mk('C')
  const merge = (src, into) => s.http(`/projects/${src.id}/merge`, { method: 'POST', token: client, body: { into: into.id } })
  assert.equal((await merge(pa, pb)).status, 200)
  assert.equal((await merge(pb, pc)).status, 200)
  const look = await s.http(`/lookup?user=dan&num=${pa.num}`, { token: client })
  assert.deepEqual(look.json, { kind: 'project', id: pc.id, merged_from: pa.id, owner: { user_id: dan.id, name: 'dan' } })
  const read = await s.http(`/projects/${pa.id}`, { token: client })
  assert.equal(read.status, 200); assert.equal(read.json.project.id, pc.id)
  assert.deepEqual(read.json.merged_from, { id: pa.id, num: pa.num })
})
