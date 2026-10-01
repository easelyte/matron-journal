import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { upsertConversation, append } from '../src/journal.js'
import { createItem } from '../src/items.js'
import { createMission, joinMission, closeMission, createMilestone, listMissions } from '../src/missions.js'
import {
  createProject, getProject, resolveProject, updateProject, closeProject, mergeProject, listProjects, projectDetail, MERGE_HOPS_MAX,
} from '../src/projects.js'

function seeded() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','dev-2','h',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(9,1,'agent','priv-box','h2',0,1)").run()
  for (const id of ['c1', 'c2', 'c3']) upsertConversation(db, { id, ownerUserId: 1, title: id, agentDeviceId: 7 })
  upsertConversation(db, { id: 'secret', ownerUserId: 1, title: 'S', agentDeviceId: 9 })
  return db
}
const mk = (db, extra = {}) => createProject(db, { userId: 1, deviceId: 7, createdBy: 'agent', title: 'Promo launch', ...extra })
const mission = (db, convoId, title, deviceId = 7) => createMission(db, { userId: 1, deviceId, createdBy: 'agent', convoId, title }).mission
const file = (db, missionId, projectId) => db.prepare('UPDATE missions SET project_id=? WHERE id=?').run(projectId, missionId)

test('createProject: shared numbering, pj_ id, optional origin, idempotent replay; getProject by id, #n and n', () => {
  const db = seeded()
  mission(db, 'c1', 'M')   // #1
  const r = mk(db, { idemKey: '7:k', convoId: 'c1', body: 'goal' })
  assert.equal(r.duplicate, false)
  assert.match(r.project.id, /^pj_/); assert.equal(r.project.num, 2); assert.equal(r.project.state, 'open')
  assert.equal(r.project.origin_convo_id, 'c1'); assert.equal(r.project.body, 'goal')
  for (const k of ['idem_key', 'status_device_id', 'status_hidden']) assert.equal(k in r.project, false, k)
  assert.equal(r.project.merged_into_num, null)
  assert.equal(mk(db, { idemKey: '7:k' }).duplicate, true)
  assert.equal(mk(db).project.origin_convo_id, null)
  for (const ref of [r.project.id, '#2', 2, '2']) assert.equal(getProject(db, 1, ref).id, r.project.id)
  assert.equal(getProject(db, 1, 'pj_nope'), null); assert.equal(getProject(db, 2, 2), null); assert.equal(getProject(db, 1, '#x'), null)
})

test('project sieve: private origin (conversation or device) hides the project; a privately written status reads four nulls', () => {
  const db = seeded()
  const fromSecret = mk(db, { convoId: 'secret', title: 'Secret project' }).project
  const byPrivateBox = createProject(db, { userId: 1, deviceId: 9, createdBy: 'agent', title: 'Box project' }).project
  const pub = mk(db).project
  for (const p of [fromSecret, byPrivateBox]) assert.equal(getProject(db, 1, p.id, { excludePrivateOwned: true }), null)
  assert.deepEqual(listProjects(db, 1, { excludePrivateOwned: true }).map((p) => p.id), [pub.id])
  assert.equal(listProjects(db, 1).length, 3)
  updateProject(db, { userId: 1, projectId: pub.id, fields: { status: 'Private news' }, statusWriter: { by: 'agent', convoId: 'secret', deviceId: 9 } })
  assert.equal(getProject(db, 1, pub.id).status, 'Private news')
  const sieved = getProject(db, 1, pub.id, { excludePrivateOwned: true })
  assert.deepEqual([sieved.status, sieved.status_by, sieved.status_convo_id, sieved.status_updated_at], [null, null, null, null])
})

test('updateProject: title/body/status as for missions; a status string needs a writer; null clears; closed refuses', () => {
  const db = seeded()
  const p = mk(db).project
  const up = updateProject(db, { userId: 1, projectId: p.id, fields: { title: 'Renamed', status: 'On track' }, statusWriter: { by: 'user', convoId: null, deviceId: 7 } })
  assert.equal(up.title, 'Renamed'); assert.equal(up.status, 'On track'); assert.equal(up.status_by, 'user'); assert.ok(up.status_updated_at)
  assert.throws(() => updateProject(db, { userId: 1, projectId: p.id, fields: { status: 'x' } }), /status_writer_required/)
  assert.equal(updateProject(db, { userId: 1, projectId: p.id, fields: { status: null } }).status_updated_at, null)
  assert.equal(updateProject(db, { userId: 1, projectId: 'pj_nope', fields: { title: 'x' } }), null)
  closeProject(db, { userId: 1, projectId: p.id, by: 'user', summary: 'done' })
  assert.throws(() => updateProject(db, { userId: 1, projectId: p.id, fields: { title: 'x' } }), /closed/)
})

test('closeProject: an agent is blocked by open missions (listed through the sieve); the user closes over them, recorded, missions stay open and filed', () => {
  const db = seeded()
  const p = mk(db).project
  const open = mission(db, 'c1', 'Open work'); const hidden = mission(db, 'secret', 'Hidden work', 9)
  file(db, open.id, p.id); file(db, hidden.id, p.id)
  let err
  try { closeProject(db, { userId: 1, projectId: p.id, by: 'agent', summary: 's', excludePrivateOwned: true }) } catch (e) { err = e }
  assert.equal(err.message, 'open_missions'); assert.deepEqual(err.missions, [{ num: open.num, title: 'Open work' }])
  const r = closeProject(db, { userId: 1, projectId: p.id, by: 'user', summary: 'Shipped' })
  assert.equal(r.project.state, 'closed'); assert.equal(r.project.closed_by, 'user')
  assert.equal(r.project.closed_over_open_missions, 2); assert.equal(r.project.close_summary, 'Shipped')
  assert.equal(db.prepare('SELECT project_id, state FROM missions WHERE id=?').get(open.id).project_id, p.id)
  assert.throws(() => closeProject(db, { userId: 1, projectId: p.id, by: 'user', summary: 'again' }), /closed/)
  const empty = mk(db, { title: 'Empty' }).project
  assert.equal(closeProject(db, { userId: 1, projectId: empty.id, by: 'agent', summary: 'nothing left' }).project.state, 'closed')
})

test('mergeProject: moves every mission (open and closed), closes the source as merged; resolveProject follows the chain', () => {
  const db = seeded()
  const a = mk(db, { title: 'A' }).project; const b = mk(db, { title: 'B' }).project; const c = mk(db, { title: 'C' }).project
  const m1 = mission(db, 'c1', 'm1'); const m2 = mission(db, 'c2', 'm2')
  file(db, m1.id, a.id); file(db, m2.id, a.id)
  closeMission(db, { userId: 1, missionId: m2.id, by: 'user', summary: 'x' })
  const r = mergeProject(db, { userId: 1, projectId: a.id, intoId: b.id, by: 'user' })
  assert.deepEqual(r.movedMissionIds.sort(), [m1.id, m2.id].sort())
  assert.equal(r.merged.state, 'closed'); assert.equal(r.merged.merged_into, b.id); assert.equal(r.merged.merged_into_num, b.num)
  assert.equal(r.merged.close_summary, `Merged into #${b.num}`)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM missions WHERE project_id=?').get(b.id).n, 2)
  mergeProject(db, { userId: 1, projectId: b.id, intoId: c.id, by: 'agent' })
  const res = resolveProject(db, 1, `#${a.num}`)
  assert.equal(res.project.id, c.id); assert.deepEqual(res.mergedFrom, { id: a.id, num: a.num })
  assert.equal(resolveProject(db, 1, c.id).mergedFrom, null)
  assert.throws(() => mergeProject(db, { userId: 1, projectId: c.id, intoId: c.id, by: 'user' }), /same_project/)
  assert.throws(() => mergeProject(db, { userId: 1, projectId: a.id, intoId: c.id, by: 'user' }), /closed/)
  const d = mk(db, { title: 'D' }).project
  assert.throws(() => mergeProject(db, { userId: 1, projectId: d.id, intoId: a.id, by: 'user' }), /into_closed/)
})

test('listMissions {filed}: only missions filed in some project (what listProjects rolls up)', () => {
  const db = seeded()
  const p = mk(db).project
  const filed = mission(db, 'c1', 'Filed'); mission(db, 'c2', 'Loose')
  file(db, filed.id, p.id)
  assert.deepEqual(listMissions(db, 1, { filed: true }).map((m) => m.id), [filed.id])
  assert.equal(listMissions(db, 1).length, 2)
})

test('listProjects: rollups count mission activity, sum needs_you/open_items, and take the latest activity; state filter; newest activity first', () => {
  const db = seeded()
  const p = mk(db, { title: 'Busy' }).project; const q = mk(db, { title: 'Quiet one' }).project
  const running = mission(db, 'c1', 'r')
  const waiting = mission(db, 'c2', 'w'); db.prepare("UPDATE conversations SET session_state='done' WHERE id='c2'").run()
  createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'question', title: 'Q?', originConvoId: 'c2' })
  const done = mission(db, 'c3', 'd'); closeMission(db, { userId: 1, missionId: done.id, by: 'user', summary: 'x' })
  for (const m of [running, waiting, done]) file(db, m.id, p.id)
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000
  db.prepare('UPDATE projects SET created_at=? WHERE id=?').run(old, q.id)
  const rows = listProjects(db, 1)
  assert.deepEqual(rows.map((r) => r.id), [p.id, q.id])
  assert.deepEqual(rows[0].missions, { running: 1, waiting: 1, idle: 0, quiet: 0, closed: 1 })
  assert.equal(rows[0].needs_you, 1); assert.equal(rows[0].open_items, 1)
  assert.deepEqual(rows[1].missions, { running: 0, waiting: 0, idle: 0, quiet: 0, closed: 0 })
  assert.equal(rows[1].last_activity_at, old)
  closeProject(db, { userId: 1, projectId: q.id, by: 'user', summary: 'x' })
  assert.deepEqual(listProjects(db, 1, { state: 'open' }).map((r) => r.id), [p.id])
  assert.deepEqual(listProjects(db, 1, { state: 'closed' }).map((r) => r.id), [q.id])
})

test('projectDetail: missions, needs-you items with mission_num, 5 latest milestones with mission_num, sessions per box — all sieved', () => {
  const db = seeded()
  const p = mk(db).project
  const m1 = mission(db, 'c1', 'one'); const m2 = mission(db, 'c2', 'two')
  file(db, m1.id, p.id); file(db, m2.id, p.id)
  joinMission(db, { userId: 1, missionId: m1.id, convoId: 'secret' })
  createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'question', title: 'Public Q', originConvoId: 'c1' })
  createItem(db, { userId: 1, originDeviceId: 9, createdBy: 'agent', kind: 'question', title: 'Private Q', originConvoId: 'secret' })
  const post = (convoId, title, deviceId = 7) => createMilestone(db, {
    userId: 1, deviceId, createdBy: 'agent', convoId, kind: 'progress', title,
    appendMarker: (payload) => append(db, { userId: 1, convoId, sender: 'agent:x', type: 'milestone', payload }),
  })
  for (let i = 0; i < 6; i++) post('c2', `step ${i}`)
  post('secret', 'private step', 9)
  const full = projectDetail(db, 1, p)
  assert.deepEqual(full.missions.map((m) => m.id).sort(), [m1.id, m2.id].sort())
  assert.equal(full.needs_you.length, 2); assert.deepEqual(full.needs_you.map((i) => i.mission_num), [m1.num, m1.num])
  assert.equal(full.recent_milestones.length, 5); assert.equal(full.recent_milestones[0].title, 'private step')
  assert.equal(full.recent_milestones[0].mission_num, m1.num)
  assert.deepEqual(full.sessions_by_box, { 'dev-2': 2, 'priv-box': 1 })
  assert.equal(full.project.needs_you, 2)
  const sieved = projectDetail(db, 1, p, { excludePrivateOwned: true })
  assert.deepEqual(sieved.needs_you.map((i) => i.title), ['Public Q'])
  assert.equal(sieved.recent_milestones[0].title, 'step 5')
  assert.equal(JSON.stringify(sieved).includes('Private'), false)
  assert.equal(JSON.stringify(sieved).includes('private step'), false)
  assert.deepEqual(sieved.sessions_by_box, { 'dev-2': 2 })
  assert.equal(sieved.project.needs_you, 1)
})

test('resolveProject: a 2-hop chain (A into B, B into C) resolves A to C through getProject refs of every form', () => {
  const db = seeded()
  const a = mk(db, { title: 'A' }).project; const b = mk(db, { title: 'B' }).project; const c = mk(db, { title: 'C' }).project
  mergeProject(db, { userId: 1, projectId: a.id, intoId: b.id, by: 'user' })
  mergeProject(db, { userId: 1, projectId: b.id, intoId: c.id, by: 'user' })
  for (const ref of [a.id, `#${a.num}`, a.num]) {
    const res = resolveProject(db, 1, ref)
    assert.equal(res.project.id, c.id)
    assert.deepEqual(res.mergedFrom, { id: a.id, num: a.num })
  }
  const fromB = resolveProject(db, 1, b.id)
  assert.equal(fromB.project.id, c.id); assert.deepEqual(fromB.mergedFrom, { id: b.id, num: b.num })
  assert.equal(resolveProject(db, 1, 'pj_nope'), null)
})

test('mergeProject flattens: every project earlier merged into the source now points straight at the survivor', () => {
  const db = seeded()
  const a = mk(db, { title: 'A' }).project; const b = mk(db, { title: 'B' }).project; const c = mk(db, { title: 'C' }).project
  const d = mk(db, { title: 'D' }).project
  mergeProject(db, { userId: 1, projectId: a.id, intoId: b.id, by: 'user' })
  mergeProject(db, { userId: 1, projectId: d.id, intoId: b.id, by: 'user' })
  db.prepare('UPDATE projects SET updated_at=1 WHERE id IN (?,?)').run(a.id, d.id)
  mergeProject(db, { userId: 1, projectId: b.id, intoId: c.id, by: 'user' })
  const into = (p) => db.prepare('SELECT merged_into FROM projects WHERE id=?').get(p.id).merged_into
  assert.deepEqual([into(a), into(d), into(b), into(c)], [c.id, c.id, c.id, null])
  const updatedAt = (p) => db.prepare('SELECT updated_at FROM projects WHERE id=?').get(p.id).updated_at
  assert.ok(updatedAt(a) > 1 && updatedAt(d) > 1, 'a flattened row is bumped so incremental readers see its new pointer')
  // The one-hop pointer is what "Merged into #N" reads now.
  assert.equal(getProject(db, 1, a.id).merged_into_num, c.num)
})

// Flattening means mergeProject never writes a chain; the cap guards
// chains it did not write (rows merged before flattening, hand edits).
test('resolveProject: follows at most MERGE_HOPS_MAX hops of an unflattened chain', () => {
  const db = seeded()
  const chain = Array.from({ length: MERGE_HOPS_MAX + 2 }, (_, i) => mk(db, { title: `P${i}` }).project)
  for (let i = 0; i < chain.length - 1; i++) {
    db.prepare("UPDATE projects SET state='closed', merged_into=? WHERE id=?").run(chain[i + 1].id, chain[i].id)
  }
  // chain[0] is MERGE_HOPS_MAX + 1 hops from the survivor: the walk stops after 16.
  const capped = resolveProject(db, 1, chain[0].id)
  assert.equal(capped.project.id, chain[MERGE_HOPS_MAX].id)
  assert.equal(capped.project.merged_into, chain[MERGE_HOPS_MAX + 1].id)
  assert.deepEqual(capped.mergedFrom, { id: chain[0].id, num: chain[0].num })
  // chain[1] is exactly MERGE_HOPS_MAX hops away: it reaches the survivor.
  const exact = resolveProject(db, 1, chain[1].id)
  assert.equal(exact.project.id, chain[MERGE_HOPS_MAX + 1].id); assert.equal(exact.project.state, 'open')
  // A cycle (never written by mergeProject, not guarded by the schema) still terminates.
  const x = mk(db, { title: 'X' }).project; const y = mk(db, { title: 'Y' }).project
  db.prepare('UPDATE projects SET merged_into=? WHERE id=?').run(y.id, x.id)
  db.prepare('UPDATE projects SET merged_into=? WHERE id=?').run(x.id, y.id)
  assert.equal(resolveProject(db, 1, x.id).project.id, x.id)
})

test('resolveProject: a hop into a project the caller cannot see resolves to nothing', () => {
  const db = seeded()
  const pub = mk(db, { title: 'Public' }).project
  const hidden = mk(db, { title: 'Hidden', convoId: 'secret' }).project
  mergeProject(db, { userId: 1, projectId: pub.id, intoId: hidden.id, by: 'user' })
  assert.equal(resolveProject(db, 1, pub.id, { excludePrivateOwned: true }), null)
  assert.equal(resolveProject(db, 1, pub.id).project.id, hidden.id)
})
