import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { storedWeek } from '../src/week-stories.js'
import { pinDevicePrivate } from '../src/db.js'
import { createProject, closeProject, mergeProject } from '../src/projects.js'
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
  for (const p of ['/timeline/weeks', '/timeline/weeks/2026-11-09', '/timeline/quiet', '/timeline/long', '/timeline/finished', '/timeline/projects']) {
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

// ---- GET /timeline/projects (every live project) ----

const liveProject = (s, alice, agent, title, movedAt, { convoId = 'c1' } = {}) => {
  const p = createProject(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', title, convoId }).project
  const m = createMission(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', convoId, title, projectId: p.id, attach: false }).mission
  s.db.prepare('UPDATE missions SET created_at = ?, updated_at = ? WHERE id = ?').run(movedAt, movedAt, m.id)
  return { p, m }
}

test('projects: live projects most recently moved first, each with its last move and open missions; total counts them all; before pages', async (t) => {
  const { s, alice, agent, client } = await fleet(t)
  assert.deepEqual((await get(s, '/timeline/projects', client)).json, { total: 0, rows: [], next_before: null })
  const a = liveProject(s, alice, agent, 'A', 1_000_000)
  const b = liveProject(s, alice, agent, 'B', 3_000_000)
  const c = liveProject(s, alice, agent, 'C', 2_000_000)
  const done = liveProject(s, alice, agent, 'Done', 4_000_000)
  closeMission(s.db, { userId: alice.id, missionId: done.m.id, by: 'user', summary: 'done' })
  const all = await get(s, '/timeline/projects', client)
  assert.equal(all.status, 200)
  assert.deepEqual(all.json, {
    total: 3,
    rows: [
      { project: { id: b.p.id, num: b.p.num, title: 'B' }, last_moved_at: 3_000_000, open_missions: 1 },
      { project: { id: c.p.id, num: c.p.num, title: 'C' }, last_moved_at: 2_000_000, open_missions: 1 },
      { project: { id: a.p.id, num: a.p.num, title: 'A' }, last_moved_at: 1_000_000, open_missions: 1 },
    ],
    next_before: null,
  })
  const page1 = await get(s, '/timeline/projects?limit=2', client)
  assert.equal(page1.json.total, 3)
  assert.deepEqual(page1.json.rows.map((r) => r.project.title), ['B', 'C'])
  assert.equal(page1.json.next_before, `2000000:${c.p.id}`)
  const page2 = await get(s, `/timeline/projects?limit=2&before=${encodeURIComponent(page1.json.next_before)}`, client)
  assert.equal(page2.json.total, 3)
  assert.deepEqual(page2.json.rows.map((r) => r.project.title), ['A'])
  assert.equal(page2.json.next_before, null)
  // An agent reads the same list.
  assert.deepEqual((await get(s, '/timeline/projects', agent.token)).json, all.json)
})

test('projects: limit must be an integer in 1..100 and before a cursor, else 400', async (t) => {
  const { s, client } = await fleet(t)
  for (const bad of ['0', '101', '-1', '2.5', 'x', '']) {
    assert.equal((await get(s, `/timeline/projects?limit=${bad}`, client)).status, 400, `limit=${bad}`)
  }
  for (const ok of ['1', '100']) assert.equal((await get(s, `/timeline/projects?limit=${ok}`, client)).status, 200, `limit=${ok}`)
  for (const bad of ['junk', '12', ':abc', '']) {
    assert.equal((await get(s, `/timeline/projects?before=${bad}`, client)).status, 400, `before=${bad}`)
  }
  assert.equal((await get(s, '/timeline/projects/', client)).status, 404)
})

test('projects: an agent device does not see a private-origin project; the client does', async (t) => {
  const { s, alice, agent, priv, client } = await fleet(t)
  liveProject(s, alice, priv, 'Hidden', 2_000_000, { convoId: 'secret' })
  liveProject(s, alice, agent, 'Visible', 1_000_000)
  const read = async (token) => (await get(s, '/timeline/projects', token)).json
  assert.deepEqual((await read(client)).rows.map((r) => r.project.title), ['Hidden', 'Visible'])
  assert.equal((await read(client)).total, 2)
  assert.deepEqual((await read(agent.token)).rows.map((r) => r.project.title), ['Visible'])
  assert.equal((await read(agent.token)).total, 1)
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

// ---- POST /timeline/weeks/:week/entries (the Coordinator's write, one entry per project) ----

const putEntries = (s, week, token, body) => s.http(`/timeline/weeks/${week}/entries`, { method: 'POST', token, body })
const entriesBody = (p, over = {}) => ({
  convo_id: 'coord', final: false,
  entries: [{ project: p.num, sentence: 'It shipped.' }],
  notes: [{ project_id: p.id, note: 'On track.' }], ...over,
})
const another = (s, alice, agent, title) => createProject(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', title }).project

test('POST /timeline/weeks/:week/entries: 401 without a token, 403 for a client, only the Coordinator naming its own conversation', async (t) => {
  const { s, alice, agent, client, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  assert.equal((await putEntries(s, week, undefined, entriesBody(p))).status, 401)
  assert.deepEqual(await putEntries(s, week, client, entriesBody(p)), { status: 403, json: { error: 'forbidden' } })
  assert.deepEqual(await putEntries(s, week, agent.token, entriesBody(p, { convo_id: 'c1' })), { status: 403, json: { error: 'forbidden', detail: 'not_coordinator' } })
  assert.deepEqual(await putEntries(s, week, agent.token, entriesBody(p, { convo_id: undefined })), { status: 403, json: { error: 'forbidden', detail: 'not_coordinator' } })
  assert.equal((await putEntries(s, week, agent.token, entriesBody(p, { convo_id: 'nope' }))).status, 404)
  assert.equal((await putEntries(s, week, agent.token, entriesBody(p, { convo_id: 7 }))).status, 400)
  assert.equal(storedWeek(s.db, alice.id, week), null)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM project_notes').get().n, 0)
})

test('POST /timeline/weeks/:week/entries: the Coordinator writes a week, 201, stored as one untitled story per project with no lede', async (t) => {
  const { s, alice, agent, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  const q = another(s, alice, agent, 'Site refresh')
  const r = await putEntries(s, week, agent.token, entriesBody(p, {
    entries: [{ project: p.num, sentence: 'It shipped.', next: 'Docs' }, { project: q.id, sentence: 'Half way.' }],
  }))
  assert.deepEqual(r, { status: 201, json: { week, written: true, final: false, entries: 2 } })
  const stored = storedWeek(s.db, alice.id, week)
  assert.equal(stored.lede, null); assert.equal(stored.final, false)
  assert.deepEqual(stored.stories, [
    { title: null, sentence: 'It shipped.', next: 'Docs', project_ids: [p.id], item_ids: [], media_blob_id: null },
    { title: null, sentence: 'Half way.', next: null, project_ids: [q.id], item_ids: [], media_blob_id: null },
  ])
  assert.equal(s.db.prepare('SELECT note FROM project_notes WHERE project_id = ?').get(p.id).note, 'On track.')
  // Notes upsert: a later write replaces the note, and no entries is a valid week.
  assert.deepEqual(await putEntries(s, week, agent.token, { convo_id: 'coord', entries: [], notes: [{ project_id: p.num, note: 'Slipping.' }] }),
    { status: 201, json: { week, written: true, final: false, entries: 0 } })
  assert.deepEqual(s.db.prepare('SELECT note FROM project_notes').all(), [{ note: 'Slipping.' }])
  assert.deepEqual(storedWeek(s.db, alice.id, week).stories, [])
})

test('POST /timeline/weeks/:week/entries: 8 entries are stored, 9 are a bare 400; malformed entries and bad weeks are 400', async (t) => {
  const { s, alice, agent, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  const nine = [p, ...Array.from({ length: 8 }, (_, i) => another(s, alice, agent, `Project ${i}`))].map((x) => ({ project: x.id, sentence: 'Moved.' }))
  assert.deepEqual(await putEntries(s, week, agent.token, entriesBody(p, { entries: nine })), { status: 400, json: { error: 'bad_request' } })
  const bad = [
    { entries: [{ sentence: 's' }] }, { entries: [{ project: p.id }] }, { entries: [{ project: p.id, sentence: '' }] },
    { entries: [{ project: p.id, sentence: 'x'.repeat(301) }] }, { entries: [{ project: p.id, sentence: 's', next: 'x'.repeat(301) }] },
    { entries: [{ project: p.id, sentence: 's', media_blob_id: 5 }] }, { entries: 'x' }, { final: 'yes' },
  ]
  for (const over of bad) {
    assert.deepEqual(await putEntries(s, week, agent.token, entriesBody(p, over)), { status: 400, json: { error: 'bad_request' } }, JSON.stringify(over))
  }
  assert.equal(storedWeek(s.db, alice.id, week), null)
  assert.deepEqual(await putEntries(s, '2026-11-10', agent.token, entriesBody(p)), { status: 400, json: { error: 'bad_request', detail: 'bad_week' } })
  assert.equal((await putEntries(s, '%E0%A4%A', agent.token, entriesBody(p))).status, 400)
  assert.deepEqual(await putEntries(s, nextWeek(s, alice), agent.token, entriesBody(p)), { status: 400, json: { error: 'bad_request', detail: 'week_out_of_range' } })
  assert.deepEqual(await putEntries(s, week, agent.token, entriesBody(p, { entries: nine.slice(0, 8) })),
    { status: 201, json: { week, written: true, final: false, entries: 8 } })
  assert.equal(storedWeek(s.db, alice.id, week).stories.length, 8)
})

test('POST /timeline/weeks/:week/entries: a body without entries is 400 and the stored week is left as it was', async (t) => {
  const { s, alice, agent, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  assert.equal((await putEntries(s, week, agent.token, entriesBody(p))).status, 201)
  const before = storedWeek(s.db, alice.id, week)
  assert.equal(before.stories.length, 1)
  const bad = [
    // The grouped write's shape, sent to this route.
    { convo_id: 'coord', lede: 'A busy week.', stories: [{ title: 'Launch', sentence: 'It shipped.', project_ids: [p.num] }] },
    { convo_id: 'coord', stories: [{ title: 'Launch', sentence: 'It shipped.', project_ids: [p.num] }] },
    // Notes only.
    { convo_id: 'coord', notes: [{ project_id: p.id, note: 'Slipping.' }] },
    { convo_id: 'coord', entries: null, notes: [{ project_id: p.id, note: 'Slipping.' }] },
    { convo_id: 'coord' },
  ]
  for (const body of bad) {
    assert.deepEqual(await putEntries(s, week, agent.token, body), { status: 400, json: { error: 'bad_request' } }, JSON.stringify(body))
    assert.deepEqual(storedWeek(s.db, alice.id, week), before, JSON.stringify(body))
  }
  assert.deepEqual(s.db.prepare('SELECT note FROM project_notes').all(), [{ note: 'On track.' }])
})

test('POST /timeline/weeks/:week/entries: a title, project_ids or lede in the body or an entry is ignored, never stored', async (t) => {
  const { s, alice, agent, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  const q = another(s, alice, agent, 'Site refresh')
  const r = await putEntries(s, week, agent.token, entriesBody(p, {
    lede: 'A busy week.', title: 'Week', project_ids: [q.id], stories: [{ title: 'Launch', sentence: 'x', project_ids: [q.id] }],
    entries: [{ project: p.id, sentence: 'It shipped.', title: 'Launch', project_ids: [q.id], item_ids: [1], lede: 'A busy week.' }],
  }))
  assert.equal(r.status, 201)
  const stored = storedWeek(s.db, alice.id, week)
  assert.equal(stored.lede, null)
  assert.deepEqual(stored.stories, [{ title: null, sentence: 'It shipped.', next: null, project_ids: [p.id], item_ids: [], media_blob_id: null }])
})

test('POST /timeline/weeks/:week/entries: two entries on one project, an unknown project and an unknown picture are 400 naming the ref', async (t) => {
  const { s, alice, agent, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  const two = (second) => entriesBody(p, { entries: [{ project: p.id, sentence: 'One.' }, second] })
  assert.deepEqual(await putEntries(s, week, agent.token, two({ project: p.num, sentence: 'Two.' })),
    { status: 400, json: { error: 'bad_request', detail: 'duplicate_project', ref: p.num } })
  assert.deepEqual(await putEntries(s, week, agent.token, two({ project: 9999, sentence: 'Two.' })),
    { status: 400, json: { error: 'bad_request', detail: 'unknown_project', ref: 9999 } })
  assert.deepEqual(await putEntries(s, week, agent.token, entriesBody(p, { entries: [{ project: p.id, sentence: 'One.', media_blob_id: 'b-nope' }] })),
    { status: 400, json: { error: 'bad_request', detail: 'unknown_blob', ref: 'b-nope' } })
  assert.equal(storedWeek(s.db, alice.id, week), null)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM project_notes').get().n, 0)
})

test('POST /timeline/weeks/:week/entries: final only once the week has ended; a non-final write over a final week is 409; a final rewrite is 201', async (t) => {
  const { s, alice, agent, p } = await coordinatorFleet(t)
  assert.deepEqual(await putEntries(s, thisWeek(s, alice), agent.token, entriesBody(p, { final: true })),
    { status: 400, json: { error: 'bad_request', detail: 'week_not_ended' } })
  const week = lastWeek(s, alice)
  assert.deepEqual(await putEntries(s, week, agent.token, entriesBody(p, { final: true })), { status: 201, json: { week, written: true, final: true, entries: 1 } })
  assert.deepEqual(await putEntries(s, week, agent.token, entriesBody(p)), { status: 409, json: { error: 'conflict', detail: 'week_final' } })
  const again = entriesBody(p, { final: true, entries: [{ project: p.id, sentence: 'Rewritten.' }] })
  assert.equal((await putEntries(s, week, agent.token, again)).status, 201)
  assert.equal(storedWeek(s.db, alice.id, week).stories[0].sentence, 'Rewritten.')
  // The grouped write sees the same frozen week.
  assert.deepEqual(await put(s, week, agent.token, goodBody(p)), { status: 409, json: { error: 'conflict', detail: 'week_final' } })
})

test('POST /timeline/weeks/:week/entries: a private-device Coordinator still cannot name private work', async (t) => {
  const { s, alice, priv } = await coordinatorFleet(t)
  setCoordinatorConvoId(s.db, alice.id, 'secret')
  const hidden = createProject(s.db, { userId: alice.id, deviceId: priv.deviceId, createdBy: 'agent', title: 'Hidden' }).project
  const r = await putEntries(s, thisWeek(s, alice), priv.token, entriesBody(hidden, { convo_id: 'secret', notes: [] }))
  assert.deepEqual(r, { status: 400, json: { error: 'bad_request', detail: 'unknown_project', ref: hidden.num } })
  assert.equal(storedWeek(s.db, alice.id, thisWeek(s, alice)), null)
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
  assert.deepEqual(Object.keys(r.json), [
    'week', 'start', 'end', 'final', 'written_at', 'current', 'stored', 'projects', 'projects_total', 'offset', 'next_offset', 'more_projects',
  ])
  assert.equal(r.json.current, true); assert.equal(r.json.stored, null); assert.equal(r.json.written_at, null)
  assert.equal(r.json.projects_total, 1); assert.equal(r.json.offset, 0); assert.equal(r.json.next_offset, null); assert.equal(r.json.more_projects, 0)
  assert.deepEqual(r.json.projects.map((x) => x.project.title), ['Promo launch'])
  assert.deepEqual(Object.keys(r.json.projects[0]), ['project', 'moved', 'status', 'milestones', 'items', 'media', 'needs_you'])
  // raw=0 and other values are the ordinary read, open to the client.
  assert.equal((await get(s, `/timeline/weeks/${week}?raw=0`, client)).status, 200)
})

test('raw read: offset and limit page the projects; offset must be an integer from 0 and limit one in 1..20, else 400; a client is still 403', async (t) => {
  const { s, alice, agent, client, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  const all = [p]
  for (let i = 1; i <= 24; i++) all.push(another(s, alice, agent, `Project ${i}`))
  for (const x of all) {
    upsertConversation(s.db, { id: `k${x.num}`, ownerUserId: alice.id, title: x.title, agentDeviceId: agent.deviceId })
    createMission(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', convoId: `k${x.num}`, title: 'one', projectId: x.id })
  }
  assert.equal((await put(s, week, agent.token, goodBody(p))).status, 201)
  const raw = (query, token = agent.token) => get(s, `/timeline/weeks/${week}?raw=1${query}`, token)
  for (const bad of ['&offset=-1', '&offset=x', '&offset=', '&offset=1.5', '&offset=1e2', '&limit=0', '&limit=21', '&limit=x', '&limit=', '&limit=-3', '&offset=0&limit=99']) {
    assert.deepEqual(await raw(bad), { status: 400, json: { error: 'bad_request' } }, bad)
  }
  for (const query of ['', '&offset=0', '&offset=12&limit=20', '&offset=-1']) {
    assert.deepEqual(await raw(query, client), { status: 403, json: { error: 'forbidden' } }, query)
  }
  const ids = (r) => r.json.projects.map((x) => x.project.id)
  const one = await raw('')
  assert.equal(one.status, 200)
  assert.equal(one.json.projects.length, 12); assert.equal(one.json.projects_total, 25)
  assert.equal(one.json.offset, 0); assert.equal(one.json.next_offset, 12); assert.equal(one.json.more_projects, 13)
  assert.equal(one.json.stored.legacy, true)
  const two = await raw('&offset=12')
  assert.equal(two.json.projects.length, 12); assert.equal(two.json.offset, 12); assert.equal(two.json.next_offset, 24)
  assert.equal(two.json.stored, null); assert.equal(typeof two.json.written_at, 'number')
  const three = await raw('&offset=24')
  assert.equal(three.json.projects.length, 1); assert.equal(three.json.next_offset, null); assert.equal(three.json.more_projects, 0)
  assert.deepEqual([...ids(one), ...ids(two), ...ids(three)].sort(), all.map((x) => x.id).sort())
  const wide = await raw('&offset=5&limit=20')
  assert.equal(wide.json.projects.length, 20); assert.equal(wide.json.offset, 5); assert.equal(wide.json.next_offset, null)
  assert.equal((await raw('&limit=1')).json.next_offset, 1)
  assert.deepEqual((await raw('&offset=400')).json.projects, [])
  // The ordinary read takes no paging: the parameters are not looked at.
  assert.equal((await get(s, `/timeline/weeks/${week}?offset=x&limit=0`, client)).status, 200)
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

// ---- GET /timeline/weeks/:week?raw=1&index=1 and &projects= (the whole week in one read, then the picked projects) ----

// `count` more projects, each with a mission of its own made now (a move this week).
function moving(s, alice, agent, count, first = 1) {
  const out = []
  for (let i = first; i < first + count; i++) {
    const x = another(s, alice, agent, `Project ${i}`)
    upsertConversation(s.db, { id: `k${x.num}`, ownerUserId: alice.id, title: x.title, agentDeviceId: agent.deviceId })
    createMission(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', convoId: `k${x.num}`, title: 'one', projectId: x.id })
    out.push(x)
  }
  return out
}

test('week index: 401 without a token, 403 for a client, 400 for a bad key; an agent gets every moving project in one response', async (t) => {
  const { s, alice, agent, client, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  const path = `/timeline/weeks/${week}?raw=1&index=1`
  assert.equal((await get(s, path, undefined)).status, 401)
  assert.deepEqual(await get(s, path, client), { status: 403, json: { error: 'forbidden' } })
  assert.deepEqual(await get(s, '/timeline/weeks/2026-11-10?raw=1&index=1', agent.token), { status: 400, json: { error: 'bad_request' } })
  createMission(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', convoId: 'c1', title: 'one', projectId: p.id })
  createMilestone(s.db, {
    userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'Shipped',
    appendMarker: (payload) => append(s.db, { userId: alice.id, convoId: 'c1', sender: 'agent:x', type: 'milestone', payload }),
  })
  const all = [p, ...moving(s, alice, agent, 39)]
  assert.equal((await put(s, week, agent.token, goodBody(p))).status, 201)
  const r = await get(s, path, agent.token)
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.json), ['week', 'start', 'end', 'final', 'written_at', 'current', 'stored', 'projects_total', 'projects', 'more_projects'])
  assert.equal(r.json.week, week); assert.equal(r.json.current, true); assert.equal(r.json.final, false)
  assert.equal(r.json.projects_total, 40); assert.equal(r.json.projects.length, 40); assert.equal(r.json.more_projects, 0)
  assert.deepEqual(r.json.projects[0], { id: p.id, num: p.num, title: 'Promo launch', moved: 2, milestones: 1, done: 0, for_you: 0, media: 0, newest: 'Shipped' })
  assert.deepEqual(r.json.projects.map((x) => x.id).sort(), all.map((x) => x.id).sort())
  assert.deepEqual(r.json.stored, { final: false, legacy: true, entries: [{ project: { id: p.id, num: p.num, title: p.title }, sentence: 'It shipped.' }] })
  // The same ranking as the pages.
  const pages = []
  for (let offset = 0; offset != null; offset = pages.at(-1).next_offset) pages.push((await get(s, `/timeline/weeks/${week}?raw=1&limit=20&offset=${offset}`, agent.token)).json)
  assert.deepEqual(r.json.projects.map((x) => x.id), pages.flatMap((page) => page.projects.map((x) => x.project.id)))
})

test('picked projects: the named ones in the order given, by id and number, each once, through a merge; hidden and unknown ones left out; a client is 403', async (t) => {
  const { s, alice, agent, priv, client, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  const picked = (refs, token = agent.token) => get(s, `/timeline/weeks/${week}?raw=1&projects=${refs}`, token)
  createMission(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', convoId: 'c1', title: 'one', projectId: p.id })
  const [a, b, gone] = moving(s, alice, agent, 3)
  const still = another(s, alice, agent, 'Still')
  const hidden = createProject(s.db, { userId: alice.id, deviceId: priv.deviceId, createdBy: 'agent', title: 'Hidden', convoId: 'secret' }).project
  createMission(s.db, { userId: alice.id, deviceId: priv.deviceId, createdBy: 'agent', convoId: 'secret', title: 'priv', projectId: hidden.id })
  mergeProject(s.db, { userId: alice.id, projectId: gone.id, intoId: a.id, by: 'user' })
  assert.equal((await put(s, week, agent.token, goodBody(p))).status, 201)
  assert.equal((await get(s, `/timeline/weeks/${week}?raw=1&projects=${p.id}`, undefined)).status, 401)
  assert.deepEqual(await picked(p.id, client), { status: 403, json: { error: 'forbidden' } })
  for (const token of [agent.token, priv.token]) {
    const r = await picked(`${b.id},${gone.num},${hidden.id},${hidden.num},pj_nope,999,${still.num},${b.num},${a.id},${p.num}`, token)
    assert.equal(r.status, 200)
    assert.deepEqual(Object.keys(r.json), [
      'week', 'start', 'end', 'final', 'written_at', 'current', 'stored', 'projects', 'projects_total', 'offset', 'next_offset', 'more_projects', 'omitted',
    ])
    assert.deepEqual(r.json.projects.map((x) => [x.project.title, x.moved]), [['Project 2', 1], ['Project 1', 2], ['Still', 0], ['Promo launch', 1]])
    assert.deepEqual(Object.keys(r.json.projects[0]), ['project', 'moved', 'status', 'milestones', 'items', 'media', 'needs_you'])
    assert.equal(r.json.projects_total, 3); assert.equal(r.json.offset, 0); assert.equal(r.json.next_offset, null); assert.equal(r.json.more_projects, 0)
    assert.deepEqual(r.json.omitted, [])
    assert.equal(r.json.stored.lede, 'A busy week.')
  }
  // Only refs that name nothing the agent may see: still a read of the week.
  const none = await picked(`${hidden.id},999`)
  assert.equal(none.status, 200); assert.deepEqual(none.json.projects, []); assert.equal(none.json.projects_total, 3)
  assert.equal((await picked(p.id)).json.projects.length, 1)
  assert.equal((await get(s, `/timeline/weeks/2026-11-10?raw=1&projects=${p.id}`, agent.token)).status, 400)
})

test('week index and picked projects: 1..12 well-formed refs, not together, and neither with offset or limit, else 400', async (t) => {
  const { s, alice, agent, client, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  const raw = (query, token = agent.token) => get(s, `/timeline/weeks/${week}?raw=1${query}`, token)
  const twelve = Array.from({ length: 12 }, (_, i) => i + 1).join(',')
  assert.equal((await raw(`&projects=${twelve}`)).status, 200)
  assert.equal((await raw('&index=1')).status, 200)
  for (const bad of [
    `&projects=${twelve},13`, '&projects=', '&projects=,', `&projects=${p.id},`, `&projects=,${p.id}`, '&projects=1,,2', '&projects=0', '&projects=-1',
    '&projects=1.5', '&projects=%231', '&projects=x', '&projects=pj_', '&projects=pj_a-b', '&projects=1%202', `&projects=${p.id}%20`,
    `&index=1&projects=${p.id}`, `&projects=${p.id}&index=1`, '&index=1&offset=0', '&index=1&limit=12', `&projects=${p.id}&offset=0`, `&projects=${p.id}&limit=5`,
    `&projects=${p.id}&offset=x`, '&index=0', '&index=', '&index=true', `&index=0&projects=${p.id}`,
  ]) {
    assert.deepEqual(await raw(bad), { status: 400, json: { error: 'bad_request' } }, bad)
    assert.deepEqual(await raw(bad, client), { status: 403, json: { error: 'forbidden' } }, `${bad}, client`)
  }
  // Without raw=1 neither parameter is looked at: the ordinary read, open to the client.
  assert.equal((await get(s, `/timeline/weeks/${week}?index=1&projects=,`, client)).status, 200)
  assert.ok('stories' in (await get(s, `/timeline/weeks/${week}?index=1`, client)).json)
})

test('week index and picked projects always apply the agent sieve, even on a private device', async (t) => {
  const { s, alice, agent, priv, p } = await coordinatorFleet(t)
  const week = thisWeek(s, alice)
  const hidden = createProject(s.db, { userId: alice.id, deviceId: priv.deviceId, createdBy: 'agent', title: 'Hidden', convoId: 'secret' }).project
  createMission(s.db, { userId: alice.id, deviceId: priv.deviceId, createdBy: 'agent', convoId: 'secret', title: 'priv', projectId: hidden.id })
  createMission(s.db, { userId: alice.id, deviceId: agent.deviceId, createdBy: 'agent', convoId: 'c1', title: 'one', projectId: p.id })
  for (const token of [agent.token, priv.token]) {
    const index = await get(s, `/timeline/weeks/${week}?raw=1&index=1`, token)
    assert.deepEqual(index.json.projects.map((x) => x.title), ['Promo launch'])
    assert.equal(index.json.projects_total, 1)
    const picked = await get(s, `/timeline/weeks/${week}?raw=1&projects=${hidden.id},${p.id}`, token)
    assert.deepEqual(picked.json.projects.map((x) => x.project.title), ['Promo launch'])
  }
})

// ---- GET /timeline/projects/:id (the project page's summary) ----

test('project page: 401 without a token; 404 for an unknown project', async (t) => {
  const { s, client } = await fleet(t)
  assert.equal((await get(s, '/timeline/projects/1', undefined)).status, 401)
  for (const unknown of ['999', 'pj_nope', 'nope', '0']) {
    const r = await get(s, `/timeline/projects/${unknown}`, client)
    assert.equal(r.status, 404, unknown)
    assert.deepEqual(r.json, { error: 'not_found' }, unknown)
  }
  assert.equal((await get(s, '/timeline/projects/%E0%A4%A', client)).status, 400)
  assert.equal((await get(s, '/timeline/projects/1/extra', client)).status, 404)
})

test('project page: by id or number, in the shape projectPage returns', async (t) => {
  const { s, alice, agent, client } = await fleet(t)
  const { p } = liveProject(s, alice, agent, 'Promo launch', 1_000_000)
  const expected = {
    project: { id: p.id, num: p.num, title: 'Promo launch', state: 'open', live: true },
    sentence: null, sentence_source: null, next: null,
    needs_you: [], needs_you_total: 0, media: null,
    counts: { weeks: 1, missions_open: 1, missions_done: 0, files: 0 },
  }
  for (const ref of [p.id, String(p.num)]) {
    const r = await get(s, `/timeline/projects/${ref}`, client)
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, expected)
  }
  assert.deepEqual((await get(s, `/timeline/projects/${p.id}`, agent.token)).json, expected)
})

test('project page: a merged project answers as its survivor with merged_from', async (t) => {
  const { s, alice, agent, client } = await fleet(t)
  const a = liveProject(s, alice, agent, 'Survivor', 1_000_000)
  const gone = liveProject(s, alice, agent, 'Gone', 2_000_000)
  mergeProject(s.db, { userId: alice.id, projectId: gone.p.id, intoId: a.p.id, by: 'user' })
  for (const ref of [gone.p.id, String(gone.p.num)]) {
    const r = await get(s, `/timeline/projects/${ref}`, client)
    assert.equal(r.status, 200)
    assert.equal(r.json.project.id, a.p.id); assert.equal(r.json.project.title, 'Survivor')
    assert.deepEqual(r.json.merged_from, { id: gone.p.id, num: gone.p.num })
    assert.equal(r.json.counts.missions_open, 2)
  }
  assert.equal('merged_from' in (await get(s, `/timeline/projects/${a.p.id}`, client)).json, false)
})

test('project page: an agent device gets 404 for a private-origin project; the client reads it', async (t) => {
  const { s, alice, agent, priv, client } = await fleet(t)
  const hidden = liveProject(s, alice, priv, 'Hidden', 2_000_000, { convoId: 'secret' })
  assert.equal((await get(s, `/timeline/projects/${hidden.p.id}`, agent.token)).status, 404)
  assert.equal((await get(s, `/timeline/projects/${hidden.p.num}`, agent.token)).status, 404)
  const mine = await get(s, `/timeline/projects/${hidden.p.id}`, client)
  assert.equal(mine.status, 200); assert.equal(mine.json.project.title, 'Hidden')
  // On a visible project, the private box's mission is not counted for the agent.
  const open = liveProject(s, alice, agent, 'Visible', 1_000_000)
  createMission(s.db, { userId: alice.id, deviceId: priv.deviceId, createdBy: 'agent', convoId: 'secret', title: 'quiet work', projectId: open.p.id, attach: false })
  assert.equal((await get(s, `/timeline/projects/${open.p.id}`, client)).json.counts.missions_open, 2)
  assert.equal((await get(s, `/timeline/projects/${open.p.id}`, agent.token)).json.counts.missions_open, 1)
})

// ---- GET /timeline/projects/:id/history (the project's weeks) ----

test('project history: 401 without a token; 404 for an unknown project and, for an agent device, a private-origin one', async (t) => {
  const { s, alice, priv, agent, client } = await fleet(t)
  assert.equal((await get(s, '/timeline/projects/1/history', undefined)).status, 401)
  assert.equal((await get(s, '/timeline/projects/999/history', client)).status, 404)
  const hidden = liveProject(s, alice, priv, 'Hidden', 2_000_000, { convoId: 'secret' })
  assert.equal((await get(s, `/timeline/projects/${hidden.p.id}/history`, agent.token)).status, 404)
  assert.equal((await get(s, `/timeline/projects/${hidden.p.id}/history`, client)).status, 200)
  assert.equal((await get(s, `/timeline/projects/${hidden.p.id}/history/more`, client)).status, 404)
})

test('project history: the weeks the project moved, newest first, by id or number; limit and before page; a merged project reads as its survivor', async (t) => {
  const { s, alice, agent, client } = await fleet(t)
  const tz = userTimeZone(s.db, alice.id)
  const w0 = weekStartOf(Date.now(), tz)
  const w1 = previousWeekStart(w0, tz); const w2 = previousWeekStart(w1, tz); const w3 = previousWeekStart(w2, tz)
  const key = (w) => formatWeekKey(w, tz)
  const { p } = liveProject(s, alice, agent, 'Promo launch', w3 + 3600e3)
  const gone = liveProject(s, alice, agent, 'Gone', w1 + 3600e3)
  const all = await get(s, `/timeline/projects/${p.id}/history`, client)
  assert.equal(all.status, 200)
  assert.deepEqual(all.json, {
    weeks: [{ week: key(w3), start: w3, end: w2, card: null, milestones: [], more_milestones: 0 }],
    next_before: null,
  })
  mergeProject(s.db, { userId: alice.id, projectId: gone.p.id, intoId: p.id, by: 'user' })
  for (const ref of [p.id, String(p.num), gone.p.id, String(gone.p.num)]) {
    const r = await get(s, `/timeline/projects/${ref}/history`, client)
    assert.deepEqual(r.json.weeks.map((w) => w.week), [key(w1), key(w3)], ref)
    assert.equal(r.json.next_before, null)
  }
  const page1 = await get(s, `/timeline/projects/${p.id}/history?limit=1`, client)
  assert.deepEqual(page1.json.weeks.map((w) => w.week), [key(w1)])
  assert.equal(page1.json.next_before, key(w1))
  const page2 = await get(s, `/timeline/projects/${p.id}/history?limit=1&before=${page1.json.next_before}`, agent.token)
  assert.deepEqual(page2.json.weeks.map((w) => w.week), [key(w3)])
  assert.equal(page2.json.next_before, null)
})

test('project history: limit must be an integer in 1..26 and before a Monday week key, else 400', async (t) => {
  const { s, alice, agent, client } = await fleet(t)
  const { p } = liveProject(s, alice, agent, 'Promo launch', 1_000_000)
  const path = `/timeline/projects/${p.id}/history`
  for (const bad of ['0', '27', '-1', '2.5', 'x', '']) assert.equal((await get(s, `${path}?limit=${bad}`, client)).status, 400, `limit=${bad}`)
  for (const ok of ['1', '26']) assert.equal((await get(s, `${path}?limit=${ok}`, client)).status, 200, `limit=${ok}`)
  for (const bad of ['2026-11-10', '2026-02-30', 'nope', '']) assert.equal((await get(s, `${path}?before=${bad}`, client)).status, 400, `before=${bad}`)
  assert.equal((await get(s, `${path}?before=${thisWeek(s, alice)}`, client)).status, 200)
})

// ---- raw=1 on the project routes (the Coordinator's reads) ----

test('raw=1 on the project routes is always sieved for an agent, even on a private device; a client and a plain read are unchanged', async (t) => {
  const { s, alice, agent, priv, client } = await fleet(t)
  const hidden = liveProject(s, alice, priv, 'Hidden', 2_000_000, { convoId: 'secret' })
  const open = liveProject(s, alice, agent, 'Open', 1_000_000)
  // The private box's mission on the visible project, a month after its own.
  const quiet = createMission(s.db, { userId: alice.id, deviceId: priv.deviceId, createdBy: 'agent', convoId: 'secret', title: 'quiet work', projectId: open.p.id, attach: false }).mission
  s.db.prepare('UPDATE missions SET created_at = ?, updated_at = ? WHERE id = ?').run(30 * 86400e3, 30 * 86400e3, quiet.id)
  const titles = async (path, token) => (await get(s, path, token)).json.rows.map((r) => r.project.title).sort()
  const status = async (path, token) => (await get(s, path, token)).status
  const page = `/timeline/projects/${hidden.p.id}`

  // Without raw=1 the private device's agent sees its own work, as before.
  assert.deepEqual(await titles('/timeline/projects', priv.token), ['Hidden', 'Open'])
  assert.equal(await status(page, priv.token), 200)
  assert.equal(await status(`${page}/history`, priv.token), 200)
  assert.equal((await get(s, `/timeline/projects/${open.p.id}`, priv.token)).json.counts.missions_open, 2)
  assert.equal((await get(s, `/timeline/projects/${open.p.id}/history`, priv.token)).json.weeks.length, 2)

  // With it, the private-origin project is no row and is not found, by id or
  // number, and a visible project is read without the private box's work.
  for (const token of [priv.token, agent.token]) {
    assert.deepEqual(await titles('/timeline/projects?raw=1', token), ['Open'])
    assert.deepEqual(await titles('/timeline/projects?raw=1&limit=5', token), ['Open'])
    assert.equal((await get(s, '/timeline/projects?raw=1', token)).json.total, 1)
    assert.equal(await status(`${page}?raw=1`, token), 404)
    assert.equal(await status(`/timeline/projects/${hidden.p.num}?raw=1`, token), 404)
    assert.equal(await status(`${page}/history?raw=1`, token), 404)
    assert.equal(await status(`${page}/history?raw=1&limit=3`, token), 404)
    assert.equal((await get(s, `/timeline/projects/${open.p.id}?raw=1`, token)).json.counts.missions_open, 1)
    assert.equal((await get(s, `/timeline/projects/${open.p.id}/history?raw=1`, token)).json.weeks.length, 1)
  }

  // A client sending raw=1 gets the normal read.
  assert.deepEqual(await titles('/timeline/projects?raw=1', client), ['Hidden', 'Open'])
  assert.deepEqual(await get(s, `${page}?raw=1`, client), await get(s, page, client))
  assert.equal(await status(`${page}?raw=1`, client), 200)
  assert.deepEqual(await get(s, `${page}/history?raw=1`, client), await get(s, `${page}/history`, client))
  assert.equal(await status(`${page}/history?raw=1`, client), 200)
  assert.equal((await get(s, `/timeline/projects/${open.p.id}?raw=1`, client)).json.counts.missions_open, 2)
})
