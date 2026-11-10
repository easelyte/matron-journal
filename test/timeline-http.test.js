import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { storedWeek } from '../src/week-stories.js'
import { pinDevicePrivate } from '../src/db.js'
import { createProject, closeProject } from '../src/projects.js'
import { createMission, closeMission, createMilestone } from '../src/missions.js'
import { weekStartOf, formatWeekKey, previousWeekStart, weekEndOf, parseWeekKey, userTimeZone } from '../src/timeline.js'

async function fleet(t) {
  const s = await startTestServer({})
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-2')
  const priv = createAgent(s.db, alice.id, 'private-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'c1', agentDeviceId: agent.deviceId })
  upsertConversation(s.db, { id: 'secret', ownerUserId: alice.id, title: 'S', agentDeviceId: priv.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  return { s, alice, agent, priv, client: login.json.token }
}
const thisWeek = (s, alice) => {
  const tz = userTimeZone(s.db, alice.id)
  return formatWeekKey(weekStartOf(Date.now(), tz), tz)
}
const lastWeek = (s, alice) => {
  const tz = userTimeZone(s.db, alice.id)
  return formatWeekKey(previousWeekStart(weekStartOf(Date.now(), tz), tz), tz)
}
const nextWeek = (s, alice) => {
  const tz = userTimeZone(s.db, alice.id)
  return formatWeekKey(weekEndOf(weekStartOf(Date.now(), tz), tz), tz)
}
const get = (s, path, token) => s.http(path, { token })

test('every timeline route is 401 without a token', async (t) => {
  const { s } = await fleet(t)
  for (const p of ['/timeline/weeks', '/timeline/weeks/2026-11-09', '/timeline/quiet', '/timeline/long', '/timeline/finished']) {
    assert.equal((await get(s, p, undefined)).status, 401, p)
  }
})

test('a client reads all five routes, each in the shape the timeline reads return', async (t) => {
  const { s, alice, agent, client } = await fleet(t)
  const p = createProject(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', title: 'Promo launch' }).project
  const m = createMission(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', convoId: 'c1', title: 'one', projectId: p.id }).mission
  const weeks = await get(s, '/timeline/weeks', client)
  assert.equal(weeks.status, 200)
  assert.equal(weeks.json.weeks[0].week, thisWeek(s, alice))
  assert.equal(weeks.json.weeks[0].moved, 1)
  assert.equal(weeks.json.next_before, null)
  assert.deepEqual(Object.keys(weeks.json).sort(), ['next_before', 'weeks'])
  const detail = await get(s, `/timeline/weeks/${thisWeek(s, alice)}`, client)
  assert.equal(detail.status, 200)
  assert.equal(detail.json.week, thisWeek(s, alice)); assert.equal(detail.json.final, false)
  assert.deepEqual(detail.json.stories.map((x) => x.project.title), ['Promo launch'])
  assert.deepEqual(detail.json.also, [])
  const quiet = await get(s, '/timeline/quiet', client)
  assert.equal(quiet.status, 200); assert.deepEqual(quiet.json, { total: 0, rows: [] })
  const long = await get(s, '/timeline/long', client)
  assert.equal(long.status, 200); assert.deepEqual(long.json, { total: 0, rows: [] })
  const open = await get(s, '/timeline/finished', client)
  assert.equal(open.status, 200); assert.deepEqual(open.json, { rows: [], next_before: null })
  closeMission(s.db, { userId: alice.id, missionId: m.id, by: 'user', summary: 'done' })
  const done = await get(s, '/timeline/finished', client)
  assert.equal(done.json.rows.length, 1)
  assert.equal(done.json.rows[0].project.title, 'Promo launch')
  assert.equal(typeof done.json.rows[0].finished_at, 'number')
})

test(':week must be a real Monday week key, else 400', async (t) => {
  const { s, alice, client } = await fleet(t)
  assert.equal((await get(s, `/timeline/weeks/${lastWeek(s, alice)}`, client)).status, 200)
  for (const bad of ['2026-11-10', '2026-02-30', 'nope', '2026-11-9', '%E0%A4%A']) {
    assert.equal((await get(s, `/timeline/weeks/${bad}`, client)).status, 400, bad)
  }
})

test('weeks: limit must be an integer in 1..52 and before a Monday week key, else 400; before pages back', async (t) => {
  const { s, alice, agent, client } = await fleet(t)
  for (const bad of ['0', '53', '-1', '1.5', 'x', '']) {
    assert.equal((await get(s, `/timeline/weeks?limit=${bad}`, client)).status, 400, `limit=${bad}`)
  }
  for (const ok of ['1', '52']) assert.equal((await get(s, `/timeline/weeks?limit=${ok}`, client)).status, 200, `limit=${ok}`)
  for (const bad of ['2026-11-10', 'junk', '']) {
    assert.equal((await get(s, `/timeline/weeks?before=${bad}`, client)).status, 400, `before=${bad}`)
  }
  // The current week is the page's first week; paging before it starts the week earlier.
  const p = createProject(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', title: 'Old' }).project
  const m = createMission(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', convoId: 'c1', title: 'old', projectId: p.id }).mission
  s.db.prepare('UPDATE missions SET created_at = ? WHERE id = ?').run(Date.now() - 20 * 86400e3, m.id)
  const first = await get(s, '/timeline/weeks?limit=2', client)
  assert.equal(first.json.weeks.length, 2)
  assert.ok(first.json.next_before)
  const next = await get(s, `/timeline/weeks?limit=2&before=${first.json.next_before}`, client)
  assert.equal(next.status, 200)
  const tz = userTimeZone(s.db, alice.id)
  assert.equal(next.json.weeks[0].week, formatWeekKey(previousWeekStart(parseWeekKey(first.json.next_before, tz), tz), tz))
})
test('finished: limit must be an integer in 1..100 and before a cursor, else 400; before pages', async (t) => {
  const { s, alice, agent, client } = await fleet(t)
  for (const bad of ['0', '101', '-1', '2.5', 'x', '']) {
    assert.equal((await get(s, `/timeline/finished?limit=${bad}`, client)).status, 400, `limit=${bad}`)
  }
  for (const ok of ['1', '100']) assert.equal((await get(s, `/timeline/finished?limit=${ok}`, client)).status, 200, `limit=${ok}`)
  for (const bad of ['junk', '12', ':abc', '']) {
    assert.equal((await get(s, `/timeline/finished?before=${bad}`, client)).status, 400, `before=${bad}`)
  }
  const ids = []
  for (const [i, title] of ['A', 'B', 'C'].entries()) {
    const p = createProject(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', title }).project
    closeProject(s.db, { userId: alice.id, projectId: p.id, by: 'user', summary: 'x' })
    s.db.prepare('UPDATE projects SET closed_at = ? WHERE id = ?').run(1_000_000 + i, p.id)
    ids.push(p.id)
  }
  const page1 = await get(s, '/timeline/finished?limit=2', client)
  assert.deepEqual(page1.json.rows.map((r) => r.project.title), ['C', 'B'])
  assert.ok(page1.json.next_before)
  const page2 = await get(s, `/timeline/finished?limit=2&before=${encodeURIComponent(page1.json.next_before)}`, client)
  assert.deepEqual(page2.json.rows.map((r) => r.project.title), ['A'])
  assert.equal(page2.json.next_before, null)
})

test('an agent device does not see a private-origin project; the client does', async (t) => {
  const { s, alice, agent, priv, client } = await fleet(t)
  const hidden = createProject(s.db, { userId: alice.id, deviceId: priv.deviceId, createdBy: 'agent', title: 'Hidden', convoId: 'secret' }).project
  closeProject(s.db, { userId: alice.id, projectId: hidden.id, by: 'user', summary: 'x' })
  const open = createProject(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', title: 'Visible' }).project
  closeProject(s.db, { userId: alice.id, projectId: open.id, by: 'user', summary: 'x' })
  const titles = async (token) => (await get(s, '/timeline/finished', token)).json.rows.map((r) => r.project.title).sort()
  assert.deepEqual(await titles(client), ['Hidden', 'Visible'])
  assert.deepEqual(await titles(agent.token), ['Visible'])
})

test('non-GET methods and unknown timeline paths are not handled (404)', async (t) => {
  const { s, client } = await fleet(t)
  assert.equal((await s.http('/timeline/weeks', { method: 'POST', token: client, body: {} })).status, 404)
  assert.equal((await get(s, '/timeline/nope', client)).status, 404)
  assert.equal((await get(s, '/timeline/weeks/2026-11-09/extra', client)).status, 404)
})

// ---- POST /timeline/weeks/:week (the Coordinator's write) ----

async function coordinatorFleet(t) {
  const f = await fleet(t)
  upsertConversation(f.s.db, { id: 'coord', ownerUserId: f.alice.id, title: 'Coordinator', agentDeviceId: f.agent.deviceId })
  setCoordinatorConvoId(f.s.db, f.alice.id, 'coord')
  const p = createProject(f.s.db, { userId: f.alice.id, deviceId: f.agent.deviceId, createdBy: 'agent', title: 'Promo launch' }).project
  return { ...f, p }
}
const put = (s, week, token, body) => s.http(`/timeline/weeks/${week}`, { method: 'POST', token, body })
const goodBody = (p, over = {}) => ({
  convo_id: 'coord', lede: 'A busy week.', final: false,
  stories: [{ title: 'Launch', sentence: 'It shipped.', project_ids: [p.num] }],
  notes: [{ project_id: p.id, note: 'On track.' }], ...over,
})

test('POST /timeline/weeks/:week: 401 without a token, 403 for a client token', async (t) => {
  const { s, alice, client, p } = await coordinatorFleet(t)
  assert.equal((await put(s, thisWeek(s, alice), undefined, goodBody(p))).status, 401)
  assert.deepEqual(await put(s, thisWeek(s, alice), client, goodBody(p)), { status: 403, json: { error: 'forbidden' } })
  assert.equal(storedWeek(s.db, alice.id, thisWeek(s, alice)), null)
})

test('POST /timeline/weeks/:week: only the Coordinator naming its own conversation', async (t) => {
  const { s, alice, agent, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  assert.deepEqual(await put(s, week, agent.token, goodBody(p, { convo_id: 'c1' })), { status: 403, json: { error: 'forbidden', detail: 'not_coordinator' } })
  assert.deepEqual(await put(s, week, agent.token, goodBody(p, { convo_id: undefined })), { status: 403, json: { error: 'forbidden', detail: 'not_coordinator' } })
  assert.equal((await put(s, week, agent.token, goodBody(p, { convo_id: 'nope' }))).status, 404)
  assert.equal((await put(s, week, agent.token, goodBody(p, { convo_id: 7 }))).status, 400)
  assert.equal(storedWeek(s.db, alice.id, thisWeek(s, alice)), null)
})

test('POST /timeline/weeks/:week: the Coordinator writes a week, 201, and the row is stored with resolved ids', async (t) => {
  const { s, alice, agent, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  const r = await put(s, week, agent.token, goodBody(p))
  assert.deepEqual(r, { status: 201, json: { week, written: true, final: false } })
  const stored = storedWeek(s.db, alice.id, thisWeek(s, alice))
  assert.equal(stored.lede, 'A busy week.')
  assert.deepEqual(stored.stories[0].project_ids, [p.id])
  assert.equal(s.db.prepare('SELECT note FROM project_notes WHERE project_id = ?').get(p.id).note, 'On track.')
})

test('POST /timeline/weeks/:week: malformed bodies and bad weeks are 400, unknown refs name the ref', async (t) => {
  const { s, alice, agent, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  for (const bad of [{ stories: [{ title: 'x'.repeat(81), sentence: 's', project_ids: [p.id] }] }, { stories: [{ title: 'x', sentence: 's', project_ids: [] }] }, { final: 'yes' }, { lede: 5 }]) {
    assert.deepEqual(await put(s, week, agent.token, goodBody(p, bad)), { status: 400, json: { error: 'bad_request' } })
  }
  assert.deepEqual(await put(s, '2026-11-10', agent.token, goodBody(p)), { status: 400, json: { error: 'bad_request', detail: 'bad_week' } })
  assert.equal((await put(s, '%E0%A4%A', agent.token, goodBody(p))).status, 400)
  assert.deepEqual(await put(s, nextWeek(s, alice), agent.token, goodBody(p)), { status: 400, json: { error: 'bad_request', detail: 'week_out_of_range' } })
  assert.deepEqual(await put(s, week, agent.token, goodBody(p, { final: true })), { status: 400, json: { error: 'bad_request', detail: 'week_not_ended' } })
  assert.deepEqual(
    await put(s, week, agent.token, goodBody(p, { stories: [{ title: 'x', sentence: 's', project_ids: [9999] }] })),
    { status: 400, json: { error: 'bad_request', detail: 'unknown_project', ref: 9999 } })
})

test('POST /timeline/weeks/:week: a non-final write over a final week is 409; a final rewrite is 201', async (t) => {
  const { s, alice, agent, p } = await coordinatorFleet(t)
  const week = lastWeek(s, alice)
  assert.deepEqual(await put(s, week, agent.token, goodBody(p, { final: true })), { status: 201, json: { week, written: true, final: true } })
  assert.deepEqual(await put(s, week, agent.token, goodBody(p)), { status: 409, json: { error: 'conflict', detail: 'week_final' } })
  assert.equal((await put(s, week, agent.token, goodBody(p, { final: true, lede: 'Rewritten.' }))).status, 201)
  assert.equal(storedWeek(s.db, alice.id, lastWeek(s, alice)).lede, 'Rewritten.')
})

test('POST /timeline/weeks/:week: a private-device Coordinator still cannot name private work', async (t) => {
  const { s, alice, priv } = await coordinatorFleet(t)
  setCoordinatorConvoId(s.db, alice.id, 'secret')
  const hidden = createProject(s.db, { userId: alice.id, deviceId: priv.deviceId, createdBy: 'agent', title: 'Hidden' }).project
  const r = await put(s, thisWeek(s, alice), priv.token, goodBody(hidden, { convo_id: 'secret', notes: [] }))
  assert.deepEqual(r, { status: 400, json: { error: 'bad_request', detail: 'unknown_project', ref: hidden.num } })
})

// ---- GET /timeline/weeks/:week?raw=1 (the Coordinator's raw read) and the reads over a written week ----

test('raw read: 401 without a token, 403 for a client, 400 for a bad key, agents get the shape', async (t) => {
  const { s, alice, agent, client, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  assert.equal((await get(s, `/timeline/weeks/${week}?raw=1`, undefined)).status, 401)
  assert.deepEqual(await get(s, `/timeline/weeks/${week}?raw=1`, client), { status: 403, json: { error: 'forbidden' } })
  assert.equal((await get(s, '/timeline/weeks/2026-11-10?raw=1', agent.token)).status, 400)
  createMission(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', convoId: 'c1', title: 'one', projectId: p.id })
  const r = await get(s, `/timeline/weeks/${week}?raw=1`, agent.token)
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.json), ['week', 'start', 'end', 'final', 'written_at', 'current', 'stored', 'projects', 'more_projects'])
  assert.equal(r.json.current, true); assert.equal(r.json.stored, null); assert.equal(r.json.written_at, null)
  assert.deepEqual(r.json.projects.map((x) => x.project.title), ['Promo launch'])
  assert.deepEqual(Object.keys(r.json.projects[0]), ['project', 'moved', 'status', 'milestones', 'items', 'media', 'needs_you'])
  // raw=0 and other values are the ordinary read, open to the client.
  assert.equal((await get(s, `/timeline/weeks/${week}?raw=0`, client)).status, 200)
})

test('raw=1 on the quiet and long lists is always sieved for an agent, even on a private device; a client and a plain read are unchanged', async (t) => {
  const { s, alice, agent, priv, client } = await coordinatorFleet(t)
  const old = Date.now() - 60 * 86400e3
  const hidden = createProject(s.db, { userId: alice.id, deviceId: priv.deviceId, createdBy: 'agent', title: 'Hidden', convoId: 'secret' }).project
  const open = createProject(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', title: 'Open' }).project
  for (const [p, convoId, device] of [[hidden, 'secret', priv.deviceId], [open, 'c1', agent.deviceId]]) {
    const { mission: m } = createMission(s.db, { userId: alice.id, deviceId: device, createdBy: 'agent', convoId, title: p.title, projectId: p.id })
    s.db.prepare('UPDATE missions SET created_at = ?, updated_at = ? WHERE id = ?').run(old, old, m.id)
    s.db.prepare('UPDATE projects SET created_at = ?, updated_at = ? WHERE id = ?').run(old, old, p.id)
    // Two weeks of moves, then silence: quiet; created long ago: open a long time.
    for (const days of [50, 40]) {
      const { milestone } = createMilestone(s.db, {
        userId: alice.id, deviceId: device, createdBy: 'agent', convoId, kind: 'progress', title: 'm',
        appendMarker: (payload) => append(s.db, { userId: alice.id, convoId, sender: 'agent:x', type: 'milestone', payload }),
      })
      s.db.prepare('UPDATE milestones SET created_at = ? WHERE id = ?').run(Date.now() - days * 86400e3, milestone.id)
    }
  }
  for (const route of ['quiet', 'long']) {
    const titles = async (path, token) => (await get(s, path, token)).json.rows.map((r) => r.project.title).sort()
    // Without raw=1 the private device's agent sees its own work, as before.
    assert.deepEqual(await titles(`/timeline/${route}`, priv.token), ['Hidden', 'Open'], `${route} plain, private agent`)
    assert.deepEqual(await titles(`/timeline/${route}?raw=1`, priv.token), ['Open'], `${route} raw, private agent`)
    assert.deepEqual(await titles(`/timeline/${route}?raw=1`, agent.token), ['Open'], `${route} raw, ordinary agent`)
    // A client sending raw=1 gets the normal read.
    assert.deepEqual(await titles(`/timeline/${route}?raw=1`, client), await titles(`/timeline/${route}`, client), `${route} client`)
  }
})

test('raw read always applies the agent sieve, even on a private device; a written week shows in the plain reads', async (t) => {
  const { s, alice, agent, priv, client, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  const hidden = createProject(s.db, { userId: alice.id, deviceId: priv.deviceId, createdBy: 'agent', title: 'Hidden', convoId: 'secret' }).project
  createMission(s.db, { userId: alice.id, deviceId: priv.deviceId, createdBy: 'agent', convoId: 'secret', title: 'priv', projectId: hidden.id })
  createMission(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', convoId: 'c1', title: 'one', projectId: p.id })
  for (const token of [agent.token, priv.token]) {
    const r = await get(s, `/timeline/weeks/${week}?raw=1`, token)
    assert.deepEqual(r.json.projects.map((x) => x.project.title), ['Promo launch'])
  }
  assert.equal((await put(s, week, agent.token, goodBody(p))).status, 201)
  const raw = await get(s, `/timeline/weeks/${week}?raw=1`, agent.token)
  assert.equal(raw.json.stored.lede, 'A busy week.')
  assert.deepEqual(raw.json.stored.stories[0].projects.map((x) => x.id), [p.id])
  const detail = await get(s, `/timeline/weeks/${week}`, client)
  assert.equal(detail.json.lede, 'A busy week.'); assert.equal(detail.json.stories[0].title, 'Launch')
  assert.deepEqual(detail.json.stories[0].projects, [{ id: p.id, num: p.num, title: p.title }])
  assert.equal(typeof detail.json.written_at, 'number')
  const list = await get(s, '/timeline/weeks', client)
  assert.equal(list.json.weeks[0].sentence, 'A busy week.'); assert.equal(list.json.weeks[0].written, true)
})
