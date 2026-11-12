import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser } from '../src/auth.js'
import {
  userTimeZone, weekStartOf, weekEndOf, previousWeekStart, formatWeekKey, parseWeekKey,
} from '../src/timeline.js'

import { upsertConversation, append } from '../src/journal.js'
import { createItem, addComment, closeItem } from '../src/items.js'
import { createMission, closeMission, createMilestone } from '../src/missions.js'
import { createProject, mergeProject, updateProject, closeProject } from '../src/projects.js'
import { writeWeek, validWeekEntries, writeWeekEntries, storedWeek } from '../src/week-stories.js'
import {
  weekRaw, weekIndex, INDEX, indexSqlForTest, RAW, cardItemsSqlForTest, allProjects, projectMoves, projectWeeklyMoves, weeksList, weekDetail, wentQuiet, openLong, finished, cronRunsForTest,
} from '../src/timeline.js'

const LON = 'Europe/London'

test('userTimeZone defaults to Europe/London and honours a stored zone', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  assert.equal(userTimeZone(db, alice.id), LON)
  const id = alice.id
  db.prepare('UPDATE users SET time_zone = ? WHERE id = ?').run('America/New_York', id)
  assert.equal(userTimeZone(db, id), 'America/New_York')
  db.prepare('UPDATE users SET time_zone = ? WHERE id = ?').run('Not/AZone', id)
  assert.equal(userTimeZone(db, id), LON)
  assert.equal(userTimeZone(db, 99999), LON)
})

test('weekStartOf is the local Monday 00:00 at or before the instant', () => {
  assert.equal(weekStartOf(Date.UTC(2026, 10, 9, 14, 0), LON), Date.UTC(2026, 10, 9, 0, 0))
  assert.equal(weekStartOf(Date.UTC(2026, 10, 9, 0, 0), LON), Date.UTC(2026, 10, 9, 0, 0))
  // Sunday 15 Nov 23:30 local (GMT) -> Monday 9 Nov.
  assert.equal(weekStartOf(Date.UTC(2026, 10, 15, 23, 30), LON), Date.UTC(2026, 10, 9, 0, 0))
  // BST: Sunday 4 Oct 23:30 local = 22:30 UTC -> Monday 28 Sep 00:00 BST = 27 Sep 23:00 UTC.
  assert.equal(weekStartOf(Date.UTC(2026, 9, 4, 22, 30), LON), Date.UTC(2026, 8, 27, 23, 0))
})

test('weekEndOf spans the 25 Oct 2026 clock change as a 169 hour week', () => {
  const start = weekStartOf(Date.UTC(2026, 9, 21), LON)
  assert.equal(weekEndOf(start, LON) - start, 169 * 3600e3)
  const plain = weekStartOf(Date.UTC(2026, 10, 10), LON)
  assert.equal(weekEndOf(plain, LON) - plain, 168 * 3600e3)
})

test('previousWeekStart steps back one local week across the change', () => {
  const nov2 = Date.UTC(2026, 10, 2, 0, 0)
  const oct26 = previousWeekStart(nov2, LON)
  assert.equal(oct26, Date.UTC(2026, 9, 26, 0, 0))
  const oct19 = previousWeekStart(oct26, LON) // Mon 19 Oct 00:00 BST
  assert.equal(oct19, Date.UTC(2026, 9, 18, 23, 0))
  assert.equal(oct26 - oct19, 169 * 3600e3)
  assert.equal(weekEndOf(oct19, LON), oct26)
})

test('formatWeekKey and parseWeekKey round-trip the local Monday date', () => {
  const start = weekStartOf(Date.UTC(2026, 9, 21), LON) // Mon 19 Oct, BST
  assert.equal(formatWeekKey(start, LON), '2026-10-19')
  assert.equal(parseWeekKey('2026-10-19', LON), start)
  const nov9 = Date.UTC(2026, 10, 9, 0, 0)
  assert.equal(formatWeekKey(nov9, LON), '2026-11-09')
  assert.equal(parseWeekKey('2026-11-09', LON), nov9)
  const ny = weekStartOf(Date.UTC(2026, 10, 11, 12), 'America/New_York')
  assert.equal(parseWeekKey(formatWeekKey(ny, 'America/New_York'), 'America/New_York'), ny)
})

test('parseWeekKey rejects non-Mondays, bad shapes and impossible dates', () => {
  assert.equal(parseWeekKey('2026-11-10', LON), null)
  assert.equal(parseWeekKey('2026-02-30', LON), null)
  assert.equal(parseWeekKey('2026-1-09', LON), null)
  assert.equal(parseWeekKey('nope', LON), null)
  assert.equal(parseWeekKey(undefined, LON), null)
})

test('an invalid zone falls back to Europe/London', () => {
  const t = Date.UTC(2026, 10, 9, 14, 0)
  assert.equal(weekStartOf(t, 'Bogus/Zone'), weekStartOf(t, LON))
})

test('weekStartOf handles the exact Monday boundary and sub-second edges', () => {
  const mon = Date.UTC(2026, 10, 9, 0, 0)
  assert.equal(weekStartOf(mon, LON), mon)
  assert.equal(weekStartOf(mon + 500, LON), mon)
  assert.equal(weekStartOf(mon - 1, LON), Date.UTC(2026, 10, 2, 0, 0))
  assert.equal(weekStartOf(weekEndOf(mon, LON) - 1, LON), mon)
})

// ---- projectMoves / projectWeeklyMoves ----

function seeded() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'alice','x',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','box-2','h',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(8,1,'client','mac','h3',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(9,1,'agent','priv-box','h2',0,1)").run()
  for (const id of ['c1', 'c2']) upsertConversation(db, { id, ownerUserId: 1, title: id, agentDeviceId: 7 })
  upsertConversation(db, { id: 'secret', ownerUserId: 1, title: 'S', agentDeviceId: 9 })
  return db
}
const project = (db, title = 'Promo launch') => createProject(db, { userId: 1, deviceId: 7, createdBy: 'agent', title }).project
const mission = (db, convoId, title, deviceId = 7) => createMission(db, { userId: 1, deviceId, createdBy: 'agent', convoId, title }).mission
const file = (db, missionId, projectId) => db.prepare('UPDATE missions SET project_id=? WHERE id=?').run(projectId, missionId)
const item = (db, convoId, kind, title, extra = {}) => createItem(db, {
  userId: 1, originDeviceId: convoId === 'secret' ? 9 : 7, createdBy: 'agent', kind, title, originConvoId: convoId, ...extra,
}).item
const post = (db, convoId, title, deviceId = 7) => createMilestone(db, {
  userId: 1, deviceId, createdBy: 'agent', convoId, kind: 'progress', title,
  appendMarker: (payload) => append(db, { userId: 1, convoId, sender: 'agent:x', type: 'milestone', payload }),
})

const T = 1_000_000
const WIN = { from: T, to: T + 1000 }
// Pin every timestamp a fixture wrote to T so the window is the only variable.
function pinAll(db, at) {
  for (const sql of [
    'UPDATE milestones SET created_at=?', 'UPDATE items SET created_at=?, updated_at=?',
    'UPDATE items SET closed_at=? WHERE closed_at IS NOT NULL', 'UPDATE item_comments SET created_at=?',
    'UPDATE missions SET created_at=?, updated_at=?', 'UPDATE missions SET closed_at=? WHERE closed_at IS NOT NULL',
  ]) db.prepare(sql).run(...Array(sql.split('?').length - 1).fill(at))
}
// A project with one mission on c1, everything the fixture adds pinned to T.
function lone(build) {
  const db = seeded()
  const p = project(db)
  const m = mission(db, 'c1', 'one'); file(db, m.id, p.id)
  build(db, m, p)
  pinAll(db, T)
  return { db, p }
}
const count = (db, p, opts = {}) => projectMoves(db, 1, { ...WIN, ...opts }).get(p.id) ?? 0

test('a milestone, an item creation, a user comment, an item close, a mission create and a mission close each count one move', () => {
  // A mission's own creation is one move, so each other kind is measured on top of it.
  const BASE = 1
  const moves = (build) => { const { db, p } = lone(build); return count(db, p) - BASE }
  assert.equal(moves(() => {}), 0)
  assert.equal(moves((db) => post(db, 'c1', 'shipped')), 1)
  assert.equal(moves((db) => item(db, 'c1', 'task', 'Do it')), 1)
  assert.equal(moves((db) => {
    const it = item(db, 'c1', 'task', 'Do it')
    addComment(db, { userId: 1, itemId: it.id, author: 'user', deviceId: 8, body: 'hello' })
  }), 2) // the item's creation + the comment
  assert.equal(moves((db) => {
    const it = item(db, 'c1', 'task', 'Do it')
    closeItem(db, { userId: 1, itemId: it.id, resolution: 'done', author: 'agent', deviceId: 7 })
  }), 2) // the item's creation + its close
  assert.equal(moves((db, m) => closeMission(db, { userId: 1, missionId: m.id, by: 'user', summary: 'done' })), 1)
})

test('chat events and a project status edit are not moves', () => {
  const { db, p } = lone((d) => {
    append(d, { userId: 1, convoId: 'c1', sender: 'agent:x', type: 'text', payload: { body: 'chatter' } })
  })
  db.prepare('UPDATE events SET ts=?').run(T)
  updateProject(db, { userId: 1, projectId: p.id, fields: { status: 'going well' }, statusWriter: { by: 'agent', deviceId: 7, convoId: 'c1' } })
  db.prepare('UPDATE projects SET status_updated_at=?, updated_at=?').run(T, T)
  assert.equal(count(db, p), 1) // only the mission's own creation
})

test('a withdrawn comment and an agent status line are not moves', () => {
  const { db, p } = lone((d) => {
    const it = item(d, 'c1', 'task', 'Do it')
    addComment(d, { userId: 1, itemId: it.id, author: 'user', deviceId: 8, body: 'oops' })
    d.prepare('UPDATE item_comments SET withdrawn_at=1 WHERE item_id=?').run(it.id)
    d.prepare("INSERT INTO item_comments(id,item_id,user_id,author,device_id,kind,body,created_at) VALUES('s1',?,1,'agent',7,'status','moved on',0)").run(it.id)
  })
  assert.equal(count(db, p), 2) // mission creation + item creation
})

test('a consent card created, commented on and closed counts 0', () => {
  const { db, p } = lone((d) => {
    const card = item(d, 'c1', 'decision', 'Approve the spawn', { consent: 'spawn:x' })
    addComment(d, { userId: 1, itemId: card.id, author: 'user', deviceId: 8, body: 'ok' })
    addComment(d, { userId: 1, itemId: card.id, author: 'agent', deviceId: 7, body: 'thanks' })
    closeItem(d, { userId: 1, itemId: card.id, resolution: 'decided', author: 'user', deviceId: 8 })
  })
  assert.equal(count(db, p), 1) // only the mission's own creation
})

test('the window is [from, to): activity outside it counts 0', () => {
  const { db, p } = lone((d) => post(d, 'c1', 'shipped'))
  assert.equal(projectMoves(db, 1, { from: T + 1, to: T + 2000 }).has(p.id), false)
  assert.equal(projectMoves(db, 1, { from: 0, to: T }).has(p.id), false)
  assert.equal(count(db, p), 2)
})

test('merged project moves roll up to the survivor', () => {
  const db = seeded()
  const survivor = project(db, 'Survivor'); const gone = project(db, 'Gone')
  const m1 = mission(db, 'c1', 'one'); file(db, m1.id, survivor.id)
  const m2 = mission(db, 'c2', 'two'); file(db, m2.id, gone.id)
  mergeProject(db, { userId: 1, projectId: gone.id, intoId: survivor.id, by: 'user' })
  // A mission still filed under the merged project (a late write) counts for the survivor.
  db.prepare('UPDATE missions SET project_id=? WHERE id=?').run(gone.id, m2.id)
  post(db, 'c2', 'late')
  pinAll(db, T)
  const moves = projectMoves(db, 1, WIN)
  assert.equal(moves.get(survivor.id), 3) // two missions + one milestone
  assert.equal(moves.has(gone.id), false)
})

test('excludePrivateOwned leaves out moves in a private conversation; false counts them', () => {
  const { db, p } = lone((d, m) => {
    d.prepare("UPDATE conversations SET mission_id=? WHERE id='secret'").run(m.id)
    item(d, 'secret', 'task', 'Private task')
    post(d, 'secret', 'private milestone', 9)
    const open = item(d, 'c1', 'task', 'Public task')
    addComment(d, { userId: 1, itemId: open.id, author: 'user', deviceId: 9, body: 'from the private box' })
  })
  assert.equal(count(db, p, { excludePrivateOwned: false }), 5) // mission, 2 items, milestone, comment
  assert.equal(count(db, p, { excludePrivateOwned: true }), 2) // mission + the public item
})

test('excludePrivateOwned leaves out a mission born in a private conversation, with its create and close', () => {
  const { db, p } = lone((d) => {
    const hidden = mission(d, 'secret', 'hidden', 9)
    file(d, hidden.id, d.prepare('SELECT project_id FROM missions WHERE title=?').get('one').project_id)
    closeMission(d, { userId: 1, missionId: hidden.id, by: 'user', summary: 'done' })
  })
  assert.equal(count(db, p, { excludePrivateOwned: false }), 3)
  assert.equal(count(db, p, { excludePrivateOwned: true }), 1)
})

test('projectWeeklyMoves gives one count per week, oldest first, zero for quiet weeks and quiet projects', () => {
  const db = seeded()
  const busy = project(db, 'Busy'); const quiet = project(db, 'Quiet')
  const m = mission(db, 'c1', 'one'); file(db, m.id, busy.id)
  const w0 = weekStartOf(Date.UTC(2026, 9, 19, 12), LON) // Mon 19 Oct (BST)
  const weeks = [w0, weekEndOf(w0, LON), weekEndOf(weekEndOf(w0, LON), LON)] // 19 Oct, 26 Oct, 2 Nov
  pinAll(db, weeks[0] + 3600e3) // the mission is created in week 0
  post(db, 'c1', 'a'); post(db, 'c1', 'b')
  db.prepare('UPDATE milestones SET created_at=?').run(weeks[2] + 5) // both in week 2
  const out = projectWeeklyMoves(db, 1, [busy.id, quiet.id], weeks, LON)
  assert.deepEqual(out.get(busy.id), [1, 0, 2])
  assert.deepEqual(out.get(quiet.id), [0, 0, 0])
  assert.equal(out.size, 2)
})

test('projectWeeklyMoves buckets the tail hour of the 169 hour week into that week, and the boundary into the next', () => {
  const db = seeded()
  const p = project(db)
  const m = mission(db, 'c1', 'one'); file(db, m.id, p.id)
  const w19 = weekStartOf(Date.UTC(2026, 9, 21), LON) // Mon 19 Oct 00:00 BST
  const w26 = weekEndOf(w19, LON) // Mon 26 Oct 00:00 GMT
  assert.equal(w26 - w19, 169 * 3600e3)
  const sunTail = Date.UTC(2026, 9, 25, 23, 30) // Sun 25 Oct 23:30 GMT, last hour of the week
  pinAll(db, w19 + 60e3)
  post(db, 'c1', 'tail'); post(db, 'c1', 'edge'); post(db, 'c1', 'start')
  const set = db.prepare('UPDATE milestones SET created_at=? WHERE title=?')
  set.run(sunTail, 'tail'); set.run(w26 - 1, 'edge'); set.run(w26, 'start')
  const out = projectWeeklyMoves(db, 1, [p.id], [w19, w26], LON)
  assert.deepEqual(out.get(p.id), [3, 1]) // mission + tail + edge | start
})

// ---- the five reads ----

const DAY = 86400e3
const NOW = Date.UTC(2026, 10, 11, 12) // Wed 11 Nov 2026, week of Mon 9 Nov
const W0 = weekStartOf(NOW, LON)
// Week n relative to the current one (0 = this week, -1 = last week): its
// start, a Wednesday-noon instant inside it, and its key.
const weekOf = (n) => weekStartOf(W0 + n * 7 * DAY + 2 * DAY, LON)
const mid = (n, hours = 0) => weekOf(n) + 2 * DAY + 12 * 3600e3 + hours * 3600e3
const keyOf = (n) => formatWeekKey(weekOf(n), LON)
const at = { now: NOW }

// A project with one mission in its own conversation, both created at
// `createdAt` (the mission's creation is itself a move).
function proj(db, title, { createdAt = mid(-20) } = {}) {
  const convo = `k${db.prepare('SELECT COUNT(*) AS n FROM missions').get().n + 1}`
  upsertConversation(db, { id: convo, ownerUserId: 1, title: convo, agentDeviceId: 7 })
  const p = project(db, title)
  const { mission: m } = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: convo, title, projectId: p.id })
  db.prepare('UPDATE missions SET created_at=?, updated_at=? WHERE id=?').run(createdAt, createdAt, m.id)
  db.prepare('UPDATE projects SET created_at=?, updated_at=? WHERE id=?').run(createdAt, createdAt, p.id)
  return { p, m, convo }
}
const postAt = (db, convo, title, ts) => {
  const { milestone } = post(db, convo, title)
  db.prepare('UPDATE milestones SET created_at=? WHERE id=?').run(ts, milestone.id)
  return milestone
}
const closeAt = (db, m, ts) => {
  closeMission(db, { userId: 1, missionId: m.id, by: 'user', summary: 'done' })
  db.prepare('UPDATE missions SET closed_at=?, updated_at=? WHERE id=?').run(ts, ts, m.id)
}
const ref = (p) => ({ id: p.id, num: p.num, title: p.title })

test('weekDetail ranks stories by moves, caps them at 8 and lists the rest under also', () => {
  const db = seeded()
  const ps = []
  for (let i = 1; i <= 10; i++) {
    const { p, convo } = proj(db, `P${i}`)
    for (let j = 0; j < i; j++) postAt(db, convo, `P${i} step ${j}`, mid(-1, j))
    ps.push(p)
  }
  const out = weekDetail(db, 1, keyOf(-1), at)
  assert.equal(out.week, keyOf(-1)); assert.equal(out.start, weekOf(-1)); assert.equal(out.end, weekOf(0))
  assert.equal(out.final, true); assert.equal(out.lede, null)
  assert.deepEqual(out.stories.map((s) => s.project.title), ['P10', 'P9', 'P8', 'P7', 'P6', 'P5', 'P4', 'P3'])
  assert.deepEqual(out.stories[0].project, ref(ps[9]))
  assert.equal(out.stories[0].next, null)
  assert.equal(out.stories[0].title, null); assert.equal(out.written_at, null)
  assert.deepEqual(out.stories[0].projects, [ref(ps[9])])
  assert.deepEqual(out.also, [{ ...ref(ps[1]), moved: 2 }, { ...ref(ps[0]), moved: 1 }])
})

test("a story's sentence is the newest milestone of that week, not a newer one the week after", () => {
  const db = seeded()
  const { convo } = proj(db, 'Search')
  postAt(db, convo, 'Index built', mid(-1, -24))
  postAt(db, convo, 'Search page live', mid(-1, 24))
  postAt(db, convo, 'Search tuned', mid(0))
  const [story] = weekDetail(db, 1, keyOf(-1), at).stories
  assert.equal(story.sentence, 'Search page live')
  assert.equal(weekDetail(db, 1, keyOf(0), at).stories[0].sentence, 'Search tuned')
})

test("media is the newest image or video of that week on the project's missions, null when there is none", () => {
  const db = seeded()
  const { convo } = proj(db, 'Site')
  const plain = proj(db, 'Docs')
  const it = item(db, convo, 'task', 'Screens')
  const attach = (name, mime, ts) => addComment(db, {
    userId: 1, itemId: it.id, author: 'agent', deviceId: 7, attachments: [{ blob_ref: `b-${name}`, mime, name, size: 4 }], now: ts,
  })
  attach('old.png', 'image/png', mid(-1, -24))
  attach('demo.mp4', 'video/mp4', mid(-1, 0))
  attach('spec.pdf', 'application/pdf', mid(-1, 12))
  attach('next.png', 'image/png', mid(0))
  const docsItem = item(db, plain.convo, 'task', 'Docs')
  addComment(db, { userId: 1, itemId: docsItem.id, author: 'agent', deviceId: 7, attachments: [{ blob_ref: 'b-d.pdf', mime: 'application/pdf', name: 'd.pdf', size: 4 }], now: mid(-1) })
  db.prepare('UPDATE items SET created_at=?, updated_at=?').run(mid(-1), mid(-1))
  const stories = weekDetail(db, 1, keyOf(-1), at).stories
  const site = stories.find((s) => s.project.title === 'Site')
  assert.deepEqual(site.media, { blob_id: 'b-demo.mp4', content_type: 'video/mp4', name: 'demo.mp4' })
  assert.equal(stories.find((s) => s.project.title === 'Docs').media, null)
})

test("needs_you lists the open items awaiting the user on the project's missions, newest first, consent cards left out", () => {
  const db = seeded()
  const { convo, p } = proj(db, 'Billing')
  const other = proj(db, 'Other')
  postAt(db, convo, 'moved', mid(-1))
  const older = item(db, convo, 'question', 'Which plan?', { now: mid(-1) })
  const newer = item(db, convo, 'question', 'Ship it?', { now: mid(-1, 1) })
  item(db, convo, 'task', 'Agent work', { now: mid(-1) }) // awaits the agent
  const answered = item(db, convo, 'question', 'Old ask', { now: mid(-1) })
  closeItem(db, { userId: 1, itemId: answered.id, resolution: 'answered', author: 'agent', deviceId: 7 })
  item(db, convo, 'decision', 'Approve the spawn', { consent: 'spawn:x', awaiting: 'user', now: mid(-1) })
  item(db, other.convo, 'question', 'Elsewhere?', { now: mid(-1) })
  const story = weekDetail(db, 1, keyOf(-1), at).stories.find((s) => s.project.id === p.id)
  assert.deepEqual(story.needs_you, [
    { id: newer.id, num: newer.num, title: 'Ship it?', done: false },
    { id: older.id, num: older.num, title: 'Which plan?', done: false },
  ])
})

test('weekDetail empty: a week with no movement has no stories and nothing in also; a current week is not final; a bad key is null', () => {
  const db = seeded()
  proj(db, 'Old', { createdAt: mid(-9) })
  const empty = weekDetail(db, 1, keyOf(-3), at)
  assert.deepEqual(empty.stories, []); assert.deepEqual(empty.also, [])
  assert.equal(empty.final, true)
  assert.equal(weekDetail(db, 1, keyOf(0), at).final, false)
  assert.equal(weekDetail(db, 1, '2026-11-10', at), null)
  assert.equal(weekDetail(db, 1, 'nope', at), null)
})

test('weekDetail leaves out merged projects and, for a filtered caller, private-origin projects', () => {
  const db = seeded()
  const a = proj(db, 'Survivor'); const b = proj(db, 'Gone')
  postAt(db, a.convo, 'a', mid(-1)); postAt(db, b.convo, 'b', mid(-1, 1))
  mergeProject(db, { userId: 1, projectId: b.p.id, intoId: a.p.id, by: 'user' })
  const hidden = createProject(db, { userId: 1, deviceId: 9, createdBy: 'agent', title: 'Hidden', convoId: 'secret' }).project
  const hm = mission(db, 'c1', 'visible mission'); file(db, hm.id, hidden.id)
  db.prepare('UPDATE missions SET created_at=? WHERE id=?').run(mid(-1), hm.id)
  const all = weekDetail(db, 1, keyOf(-1), at)
  assert.deepEqual(all.stories.map((s) => s.project.title).sort(), ['Hidden', 'Survivor'])
  assert.equal(all.stories.find((s) => s.project.title === 'Survivor').sentence, 'b')
  const filtered = weekDetail(db, 1, keyOf(-1), { ...at, excludePrivateOwned: true })
  assert.deepEqual(filtered.stories.map((s) => s.project.title), ['Survivor'])
})

test('weeksList: one sentence per week for 0, 1, 2, 3 and 5 moving projects, newest first, back to the earliest mission', () => {
  const db = seeded()
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']
  const ps = names.map((n) => proj(db, n, { createdAt: mid(-5) }))
  // week -3: Alpha; -2: Alpha, Bravo; -1: Alpha, Bravo, Charlie; 0: all five,
  // Echo the busiest. Week -4 is quiet.
  const moves = { [-3]: [1], [-2]: [1, 2], [-1]: [1, 2, 3], 0: [1, 2, 3, 4, 5] }
  for (const [w, counts] of Object.entries(moves)) {
    counts.forEach((n, i) => { for (let j = 0; j < n; j++) postAt(db, ps[i].convo, `${names[i]} ${w}.${j}`, mid(Number(w), j)) })
  }
  const out = weeksList(db, 1, at)
  assert.deepEqual(out.weeks.map((w) => w.week), [0, -1, -2, -3, -4, -5].map(keyOf))
  assert.deepEqual(out.weeks.map((w) => w.sentence), [
    'Echo, Delta, Charlie and 2 more moved.',
    'Charlie, Bravo and Alpha moved.',
    'Bravo and Alpha moved.',
    'Alpha moved.',
    'A quiet week.',
    'Alpha, Bravo, Charlie and 2 more moved.', // each mission's creation, tied, by number
  ])
  assert.deepEqual(out.weeks.map((w) => w.moved), [5, 3, 2, 1, 0, 5])
  assert.equal(out.weeks[1].start, weekOf(-1)); assert.equal(out.weeks[1].end, weekOf(0))
  assert.equal(out.next_before, null)
})

test('weeksList pages backwards by week key and stops at the week of the earliest mission', () => {
  const db = seeded()
  proj(db, 'Alpha', { createdAt: mid(-5) })
  const first = weeksList(db, 1, { ...at, limit: 4 })
  assert.deepEqual(first.weeks.map((w) => w.week), [0, -1, -2, -3].map(keyOf))
  assert.equal(first.next_before, keyOf(-3))
  const second = weeksList(db, 1, { ...at, before: first.next_before, limit: 4 })
  assert.deepEqual(second.weeks.map((w) => w.week), [-4, -5].map(keyOf))
  assert.equal(second.next_before, null)
  const exact = weeksList(db, 1, { ...at, limit: 6 })
  assert.equal(exact.weeks.length, 6); assert.equal(exact.next_before, null)
  assert.equal(weeksList(db, 1, { ...at, before: '2026-11-10' }), null)
  // No missions at all: just this week.
  const fresh = weeksList(seeded(), 1, at)
  assert.deepEqual(fresh.weeks.map((w) => w.week), [keyOf(0)]); assert.equal(fresh.next_before, null)
})

test('wentQuiet: moved in two of the eight weeks before it stopped and not for 14 days; one-week, recent and finished projects left out', () => {
  const db = seeded()
  const quiet = proj(db, 'Quiet', { createdAt: mid(-6) })
  postAt(db, quiet.convo, 'paused', mid(-4))
  proj(db, 'Once', { createdAt: mid(-5) })
  const recent = proj(db, 'Recent', { createdAt: mid(-6) })
  postAt(db, recent.convo, 'still going', NOW - 10 * DAY)
  const done = proj(db, 'Done', { createdAt: mid(-6) })
  postAt(db, done.convo, 'wrapping up', mid(-5))
  closeAt(db, done.m, mid(-4))
  const out = wentQuiet(db, 1, at)
  assert.equal(out.total, 1)
  assert.deepEqual(out.rows, [{
    project: ref(quiet.p), last_moved_at: mid(-4), weekly: [0, 1, 0, 1, 0, 0, 0, 0], note: null,
  }])
})

test('wentQuiet ranks by moves in the eight weeks before it stopped, shows the top 10 and counts them all', () => {
  const db = seeded()
  for (let i = 1; i <= 12; i++) {
    const { convo } = proj(db, `Q${i}`, { createdAt: mid(-8) })
    for (let j = 0; j < i; j++) postAt(db, convo, `Q${i}.${j}`, mid(-4, j))
  }
  const out = wentQuiet(db, 1, at)
  assert.equal(out.total, 12)
  assert.deepEqual(out.rows.map((r) => r.project.title), ['Q12', 'Q11', 'Q10', 'Q9', 'Q8', 'Q7', 'Q6', 'Q5', 'Q4', 'Q3'])
  assert.equal(out.rows[0].weekly.length, 8)
})

test('openLong: a live project created 22 days ago is in, oldest first; 20 days ago and finished ones are out', () => {
  const db = seeded()
  const old = proj(db, 'Old', { createdAt: NOW - 40 * DAY })
  const mid22 = proj(db, 'Middle', { createdAt: NOW - 22 * DAY })
  postAt(db, mid22.convo, 'step', mid(0))
  proj(db, 'Young', { createdAt: NOW - 20 * DAY })
  const fin = proj(db, 'Finished', { createdAt: NOW - 30 * DAY })
  closeAt(db, fin.m, NOW - 25 * DAY)
  const closed = proj(db, 'Closed', { createdAt: NOW - 30 * DAY })
  closeProject(db, { userId: 1, projectId: closed.p.id, by: 'user', summary: 'stop' })
  const out = openLong(db, 1, at)
  assert.equal(out.total, 2)
  assert.deepEqual(out.rows.map((r) => r.project), [ref(old.p), ref(mid22.p)])
  assert.equal(out.rows[0].created_at, NOW - 40 * DAY)
  assert.equal(out.rows[0].last_moved_at, NOW - 40 * DAY)
  assert.equal(out.rows[1].last_moved_at, mid(0))
  assert.deepEqual(out.rows[1].weekly, [0, 0, 0, 0, 1, 0, 0, 1]) // created in week -3, a milestone this week
  assert.equal(out.rows[0].note, null)
})

test('finished: projects whose missions are all closed and closed projects, newest first, paged; live and merged ones left out', () => {
  const db = seeded()
  const allClosed = proj(db, 'All closed')
  closeAt(db, allClosed.m, NOW - 5 * DAY)
  const closed = proj(db, 'Closed')
  const gone = proj(db, 'Gone')
  mergeProject(db, { userId: 1, projectId: gone.p.id, intoId: closed.p.id, by: 'user' })
  closeProject(db, { userId: 1, projectId: closed.p.id, by: 'user', summary: 'stop' })
  db.prepare('UPDATE projects SET closed_at=? WHERE id=?').run(NOW - 2 * DAY, closed.p.id)
  const older = proj(db, 'Older')
  closeAt(db, older.m, NOW - 9 * DAY)
  proj(db, 'Live')
  const out = finished(db, 1, at)
  assert.deepEqual(out.rows, [
    { project: ref(closed.p), finished_at: NOW - 2 * DAY },
    { project: ref(allClosed.p), finished_at: NOW - 5 * DAY },
    { project: ref(older.p), finished_at: NOW - 9 * DAY },
  ])
  assert.equal(out.next_before, null)
  const p1 = finished(db, 1, { ...at, limit: 2 })
  assert.deepEqual(p1.rows.map((r) => r.project.title), ['Closed', 'All closed'])
  assert.equal(p1.next_before, `${NOW - 5 * DAY}:${allClosed.p.id}`)
  const p2 = finished(db, 1, { ...at, limit: 2, before: p1.next_before })
  assert.deepEqual(p2.rows.map((r) => r.project.title), ['Older'])
  assert.equal(p2.next_before, null)
  assert.equal(finished(db, 1, { ...at, before: 'bad cursor' }), null)
})

test('finished leaves out an open project that never had a mission, keeps a closed one, and keeps a closed project with open missions', () => {
  const db = seeded()
  const leftover = proj(db, 'Leftover')
  const target = proj(db, 'Target')
  file(db, leftover.m.id, target.p.id) // the move empties Leftover
  const emptyClosed = project(db, 'Empty closed')
  closeProject(db, { userId: 1, projectId: emptyClosed.id, by: 'user', summary: 'never started' })
  const stillOpen = proj(db, 'Closed over open missions')
  closeProject(db, { userId: 1, projectId: stillOpen.p.id, by: 'user', summary: 'stop' })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM missions WHERE project_id=? AND state='open'").get(stillOpen.p.id).n, 1)
  const titles = finished(db, 1, at).rows.map((r) => r.project.title)
  assert.ok(!titles.includes('Leftover'))
  assert.ok(!titles.includes('Target'))
  assert.ok(titles.includes('Empty closed'))
  assert.ok(titles.includes('Closed over open missions'))
})

test('openLong includes a project created exactly 21 days ago', () => {
  const db = seeded()
  const edge = proj(db, 'Edge', { createdAt: NOW - 21 * DAY })
  proj(db, 'Just short', { createdAt: NOW - 21 * DAY + 1 })
  const out = openLong(db, 1, at)
  assert.deepEqual(out.rows.map((r) => r.project), [ref(edge.p)])
})

test('wentQuiet includes a project whose last move is exactly 14 days ago', () => {
  const db = seeded()
  const edge = proj(db, 'Edge', { createdAt: NOW - 20 * DAY })
  postAt(db, edge.convo, 'last', NOW - 14 * DAY)
  const short = proj(db, 'Just short', { createdAt: NOW - 20 * DAY })
  postAt(db, short.convo, 'last', NOW - 14 * DAY + 1)
  const out = wentQuiet(db, 1, at)
  assert.deepEqual(out.rows.map((r) => [r.project.title, r.last_moved_at]), [['Edge', NOW - 14 * DAY]])
})

test('the 22 Mar 2027 week spans the March clock change as 167 hours', () => {
  const start = weekStartOf(Date.UTC(2027, 2, 24, 12), LON)
  assert.equal(start, Date.UTC(2027, 2, 22, 0, 0)) // Mon 22 Mar 00:00 GMT
  const end = weekEndOf(start, LON)
  assert.equal(end, Date.UTC(2027, 2, 28, 23, 0)) // Mon 29 Mar 00:00 BST
  assert.equal(end - start, 167 * 3600e3)
  assert.equal(formatWeekKey(end, LON), '2027-03-29')
  assert.equal(previousWeekStart(end, LON), start)
  assert.equal(weekStartOf(end - 1, LON), start)
})

test("weekDetail's needs_you is bounded to the week: an item created the week after is not on the earlier card", () => {
  const db = seeded()
  const { convo, p } = proj(db, 'Billing')
  postAt(db, convo, 'moved', mid(-1))
  postAt(db, convo, 'moved again', mid(0))
  const then = item(db, convo, 'question', 'Which plan?', { now: mid(-1) })
  const later = item(db, convo, 'question', 'Ship it?', { now: mid(0) })
  const card = (n) => weekDetail(db, 1, keyOf(n), at).stories.find((s) => s.project.id === p.id)
  assert.deepEqual(card(-1).needs_you.map((r) => r.id), [then.id])
  assert.deepEqual(card(0).needs_you.map((r) => r.id), [later.id, then.id])
})

test('wentQuiet over 200 candidates reuses week boundaries: about one croner run per candidate, not sixteen', () => {
  const db = seeded()
  const N = 200
  for (let i = 0; i < N; i++) {
    const { convo } = proj(db, `Q${i}`, { createdAt: mid(-5 - (i % 7) - (i % 3)) })
    postAt(db, convo, 'last', mid(-3 - (i % 7)))
  }
  const before = cronRunsForTest()
  const out = wentQuiet(db, 1, at)
  const runs = cronRunsForTest() - before
  assert.equal(out.total, N)
  assert.ok(runs <= N + 40, `${runs} croner runs for ${N} candidates`)
})

test("week media follows missions still filed under a merged project onto the survivor's card", () => {
  const db = seeded()
  const survivor = proj(db, 'Survivor'); const gone = proj(db, 'Gone')
  mergeProject(db, { userId: 1, projectId: gone.p.id, intoId: survivor.p.id, by: 'user' })
  db.prepare('UPDATE missions SET project_id=? WHERE id=?').run(gone.p.id, gone.m.id) // a late write
  const it = item(db, gone.convo, 'task', 'Screens', { now: mid(-1) })
  addComment(db, { userId: 1, itemId: it.id, author: 'agent', deviceId: 7, attachments: [{ blob_ref: 'b-shot.png', mime: 'image/png', name: 'shot.png', size: 4 }], now: mid(-1, 1) })
  const [story] = weekDetail(db, 1, keyOf(-1), at).stories
  assert.equal(story.project.id, survivor.p.id)
  assert.deepEqual(story.media, { blob_id: 'b-shot.png', content_type: 'image/png', name: 'shot.png' })
})

// ---- Coordinator-written weeks (phase 2) ----

const blobRow = (db, id, mime = 'image/png') =>
  db.prepare("INSERT INTO blobs(id, owner_user_id, content_type, size, sha256, disk_path, created_at) VALUES(?,1,?,4,'s','p',0)").run(id, mime)
const attachAt = (db, it, blobId, ts, mime = 'image/png') => addComment(db, {
  userId: 1, itemId: it.id, author: 'agent', deviceId: 7, attachments: [{ blob_ref: blobId, mime, name: `${blobId}.png`, size: 4 }], now: ts,
})
// A story as the Coordinator writes it (project_ids etc. are references).
const tale = (over = {}) => ({ title: 'Launch', sentence: 'It shipped.', next: null, project_ids: [], item_ids: [], media_blob_id: null, ...over })
const put = (db, n, { lede = null, stories = [], final = false, notes = [] } = {}, o = {}) => {
  const r = writeWeek(db, 1, keyOf(n), { lede, stories, final, notes }, { now: NOW, excludePrivateOwned: false, ...o })
  assert.equal(r.ok, true, JSON.stringify(r))
}

test('a stored week wins: lede, stories in the stored order, written_at, final from the store', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const b = proj(db, 'Bravo')
  postAt(db, a.convo, 'a1', mid(0)); postAt(db, b.convo, 'b1', mid(0)); postAt(db, b.convo, 'b2', mid(0, 1))
  put(db, 0, {
    lede: 'A big week. Two things shipped.', final: false,
    stories: [tale({ title: 'First', project_ids: [a.p.id], next: 'Docs' }), tale({ title: 'Second', sentence: 'Done.', project_ids: [b.p.id, a.p.id] })],
  })
  const out = weekDetail(db, 1, keyOf(0), at)
  assert.equal(out.lede, 'A big week. Two things shipped.'); assert.equal(out.written_at, NOW); assert.equal(out.final, false)
  assert.deepEqual(out.stories.map((s) => s.title), ['First', 'Second'])
  assert.deepEqual(out.stories[0], {
    title: 'First', project: ref(a.p), projects: [ref(a.p)], sentence: 'It shipped.', next: 'Docs', needs_you: [], media: null,
    marks: { for_you: 0, done: 0, next: true },
  })
  assert.deepEqual(out.stories[1].projects, [ref(b.p), ref(a.p)])
  assert.deepEqual(out.stories[1].project, ref(b.p))
  assert.deepEqual(out.also, [])
  // The end-of-week floor still applies to a stored week that is not marked final.
  put(db, -1, { lede: 'Last week.', stories: [tale({ project_ids: [a.p.id] })] })
  assert.equal(weekDetail(db, 1, keyOf(-1), at).final, true)
})

test('a stored week marked final is final: the store flag wins over a clock that says the week is open', () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  postAt(db, a.convo, 'a1', mid(-2))
  put(db, -2, { lede: 'Done.', final: true })
  assert.equal(weekDetail(db, 1, keyOf(-2), at).final, true)
  assert.equal(weekDetail(db, 1, keyOf(-2), { now: weekOf(-2) + DAY }).final, true)
})

test('a notes-only row counts as not written: the computed page, sentence and written false', () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  postAt(db, a.convo, 'a1', mid(-1))
  put(db, -1, { notes: [{ project: a.p.id, note: 'Steady.' }] })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM week_stories').get().n, 1)
  const d = weekDetail(db, 1, keyOf(-1), at)
  assert.equal(d.lede, null); assert.equal(d.written_at, null); assert.equal(d.stories[0].title, null)
  const w = weeksList(db, 1, at).weeks.find((x) => x.week === keyOf(-1))
  assert.equal(w.written, false); assert.equal(w.sentence, 'Alpha moved.')
  assert.equal(weekRaw(db, 1, keyOf(-1), at).stored, null)
})

test('a merged project in a story resolves to the survivor; duplicates collapse', () => {
  const db = seeded()
  const a = proj(db, 'Survivor'); const b = proj(db, 'Gone')
  postAt(db, a.convo, 'a', mid(-1))
  put(db, -1, { lede: 'x', stories: [tale({ project_ids: [b.p.id, a.p.id] })] })
  mergeProject(db, { userId: 1, projectId: b.p.id, intoId: a.p.id, by: 'user' })
  const [story] = weekDetail(db, 1, keyOf(-1), at).stories
  assert.deepEqual(story.projects, [ref(a.p)]); assert.deepEqual(story.project, ref(a.p))
})

test('a project made private after the write vanishes from an agent read but shows on a client read; a story with no visible project is dropped', () => {
  const db = seeded()
  const a = proj(db, 'Open'); const b = proj(db, 'Turned private')
  postAt(db, a.convo, 'a', mid(-1)); postAt(db, b.convo, 'b', mid(-1))
  put(db, -1, {
    lede: 'x',
    stories: [tale({ title: 'Both', project_ids: [a.p.id, b.p.id] }), tale({ title: 'Only private', project_ids: [b.p.id] })],
  })
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', b.p.id)
  const agent = weekDetail(db, 1, keyOf(-1), { ...at, excludePrivateOwned: true })
  assert.deepEqual(agent.stories.map((s) => s.title), ['Both'])
  assert.deepEqual(agent.stories[0].projects, [ref(a.p)])
  const client = weekDetail(db, 1, keyOf(-1), at)
  assert.deepEqual(client.stories.map((s) => s.title), ['Both', 'Only private'])
  assert.deepEqual(client.stories[0].projects, [ref(a.p), ref(b.p)])
})

test('needs_you resolves stored items live: closed is done, still awaiting is not, deleted and hidden ones are dropped', () => {
  const db = seeded()
  const a = proj(db, 'Billing')
  postAt(db, a.convo, 'a', mid(-1))
  const open = item(db, a.convo, 'question', 'Which plan?')
  const closed = item(db, a.convo, 'question', 'Ship it?')
  const gone = item(db, a.convo, 'question', 'Deleted?')
  const hid = item(db, a.convo, 'question', 'Hidden later?')
  const agentTask = item(db, a.convo, 'task', 'Agent work')
  put(db, -1, { lede: 'x', stories: [tale({ project_ids: [a.p.id], item_ids: [open.id, closed.id, gone.id, hid.id, agentTask.id] })] })
  closeItem(db, { userId: 1, itemId: closed.id, resolution: 'answered', author: 'agent', deviceId: 7 })
  db.prepare('DELETE FROM items WHERE id = ?').run(gone.id)
  db.prepare('UPDATE items SET origin_convo_id = ? WHERE id = ?').run('secret', hid.id)
  const needs = (o) => weekDetail(db, 1, keyOf(-1), { ...at, ...o }).stories[0].needs_you
  assert.deepEqual(needs({ excludePrivateOwned: true }), [
    { id: open.id, num: open.num, title: 'Which plan?', done: false },
    { id: closed.id, num: closed.num, title: 'Ship it?', done: true },
    { id: agentTask.id, num: agentTask.num, title: 'Agent work', done: true },
  ])
  assert.deepEqual(needs().map((n) => n.title), ['Which plan?', 'Ship it?', 'Hidden later?', 'Agent work'])
})

test('story media: the stored blob when it exists, else the main project week roll-up, else null', () => {
  const db = seeded()
  const a = proj(db, 'Site'); const bare = proj(db, 'Bare')
  postAt(db, a.convo, 'a', mid(-1)); postAt(db, bare.convo, 'b', mid(-1))
  const it = item(db, a.convo, 'task', 'Screens')
  blobRow(db, 'b-stored'); attachAt(db, it, 'b-stored', mid(-3))
  blobRow(db, 'b-week'); attachAt(db, it, 'b-week', mid(-1))
  put(db, -1, {
    lede: 'x', stories: [
      tale({ title: 'Stored', project_ids: [a.p.id], media_blob_id: 'b-stored' }),
      tale({ title: 'None', project_ids: [bare.p.id] }),
    ],
  })
  const stories = () => weekDetail(db, 1, keyOf(-1), at).stories
  assert.deepEqual(stories()[0].media, { blob_id: 'b-stored', content_type: 'image/png', name: 'b-stored.png' })
  assert.equal(stories()[1].media, null)
  db.prepare("DELETE FROM blobs WHERE id = 'b-stored'").run()
  assert.deepEqual(stories()[0].media, { blob_id: 'b-week', content_type: 'image/png', name: 'b-week.png' })
})

test('story media hidden by the sieve falls back to null for an agent and still shows for a client', () => {
  const db = seeded()
  const a = proj(db, 'Site')
  postAt(db, a.convo, 'a', mid(-1))
  const hidden = item(db, 'secret', 'task', 'Private shot')
  blobRow(db, 'b-secret'); attachAt(db, hidden, 'b-secret', mid(-1))
  put(db, -1, { lede: 'x', stories: [tale({ project_ids: [a.p.id], media_blob_id: 'b-secret' })] })
  assert.equal(weekDetail(db, 1, keyOf(-1), { ...at, excludePrivateOwned: true }).stories[0].media, null)
  assert.equal(weekDetail(db, 1, keyOf(-1), at).stories[0].media.blob_id, 'b-secret')
})

test('also: the projects that moved and no remaining story names, with their counts', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const b = proj(db, 'Bravo'); const c = proj(db, 'Charlie')
  for (let i = 0; i < 3; i++) postAt(db, a.convo, `a${i}`, mid(-1, i))
  for (let i = 0; i < 2; i++) postAt(db, b.convo, `b${i}`, mid(-1, i))
  postAt(db, c.convo, 'c', mid(-1))
  // Bravo is named as a second project of Alpha's story; Charlie is not named.
  put(db, -1, { lede: 'x', stories: [tale({ project_ids: [a.p.id, b.p.id] })] })
  assert.deepEqual(weekDetail(db, 1, keyOf(-1), at).also, [{ ...ref(c.p), moved: 1 }])
  // A project hidden from the caller no longer counts as named or as moved: Bravo still anchors the story.
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', a.p.id)
  const out = weekDetail(db, 1, keyOf(-1), { ...at, excludePrivateOwned: true })
  assert.deepEqual(out.stories.map((s) => s.projects), [[ref(b.p)]])
  assert.deepEqual(out.also.map((x) => x.title), ['Charlie'])
  // With every named project hidden the story is dropped and names nothing.
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', b.p.id)
  const bare = weekDetail(db, 1, keyOf(-1), { ...at, excludePrivateOwned: true })
  assert.deepEqual(bare.stories, []); assert.deepEqual(bare.also.map((x) => x.title), ['Charlie'])
})

test("weeksList: the sentence is the lede's first sentence, written says so, and the computed sentence stays when there is none", () => {
  const db = seeded()
  const a = proj(db, 'Alpha', { createdAt: mid(-5) })
  for (const n of [-3, -2, -1, 0]) postAt(db, a.convo, `s${n}`, mid(n))
  put(db, -1, { lede: 'A. B.' })
  put(db, -2, { lede: 'No stop' })
  put(db, -3, { lede: '  Wow! Really?  ' })
  put(db, 0, { lede: 'Is it done? Not yet.' })
  const w = (key) => weeksList(db, 1, at).weeks.find((x) => x.week === key)
  assert.equal(w(keyOf(-1)).sentence, 'A.'); assert.equal(w(keyOf(-1)).written, true)
  assert.equal(w(keyOf(-2)).sentence, 'No stop')
  assert.equal(w(keyOf(-3)).sentence, 'Wow!')
  assert.equal(w(keyOf(0)).sentence, 'Is it done?')
  assert.equal(w(keyOf(-4)).written, false); assert.equal(w(keyOf(-4)).sentence, 'A quiet week.')
  // A stored row with stories but no lede keeps the computed sentence and is written.
  put(db, -2, { stories: [tale({ project_ids: [a.p.id] })] })
  assert.equal(w(keyOf(-2)).sentence, 'Alpha moved.'); assert.equal(w(keyOf(-2)).written, true)
})

test('weeksList reads the stored weeks in one query for the page', () => {
  const db = seeded()
  const a = proj(db, 'Alpha', { createdAt: mid(-5) })
  for (const n of [-3, -2, -1]) { postAt(db, a.convo, `s${n}`, mid(n)); put(db, n, { lede: 'Hi.' }) }
  let reads = 0
  const prepare = db.prepare.bind(db)
  db.prepare = (sql) => { if (/FROM week_stories/.test(sql)) reads += 1; return prepare(sql) }
  weeksList(db, 1, at)
  assert.equal(reads, 1)
})

test('notes on went-quiet and open-long rows: shown when fresh, null when older than the last move', () => {
  const db = seeded()
  const quiet = proj(db, 'Quiet', { createdAt: mid(-6) })
  postAt(db, quiet.convo, 'paused', mid(-4))
  const stale = proj(db, 'Stale', { createdAt: mid(-6) })
  postAt(db, stale.convo, 'paused', mid(-4))
  const noNote = proj(db, 'NoNote', { createdAt: mid(-6) })
  postAt(db, noNote.convo, 'paused', mid(-4))
  const longOld = proj(db, 'Long', { createdAt: NOW - 40 * DAY })
  const longStale = proj(db, 'LongStale', { createdAt: NOW - 39 * DAY })
  postAt(db, longStale.convo, 'late step', NOW - 2 * DAY)
  const setNote = (p, note, written) => db.prepare('INSERT INTO project_notes(user_id, project_id, note, written_at) VALUES(1,?,?,?)').run(p.id, note, written)
  setNote(quiet.p, 'Waiting on legal.', mid(-4) + 1)
  setNote(stale.p, 'Old note.', mid(-4) - 1)
  setNote(longOld.p, 'Parked deliberately.', NOW - 30 * DAY) // after its only move (creation, 40 days ago)
  setNote(longStale.p, 'Stale long.', NOW - 3 * DAY) // before its move 2 days ago
  const notes = (rows) => Object.fromEntries(rows.map((r) => [r.project.title, r.note]))
  assert.deepEqual(notes(wentQuiet(db, 1, at).rows), { Quiet: 'Waiting on legal.', Stale: null, NoNote: null })
  const long = notes(openLong(db, 1, at).rows)
  assert.equal(long.Long, 'Parked deliberately.'); assert.equal(long.LongStale, null)
  assert.equal(long.Quiet, 'Waiting on legal.'); assert.equal(long.Stale, null)
})

const RAW_KEYS = [
  'week', 'start', 'end', 'final', 'written_at', 'current', 'stored', 'projects', 'projects_total', 'offset', 'next_offset', 'more_projects',
]

test('weekRaw: the moving projects with status, milestones, items and media, capped; stored refs; bad key null', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const b = proj(db, 'Bravo')
  updateProject(db, { userId: 1, projectId: a.p.id, fields: { status: 'On track' }, statusWriter: { by: 'agent', deviceId: 7, convoId: 'c1' } })
  for (let i = 0; i < 12; i++) postAt(db, a.convo, `step ${i}`, mid(-1, i))
  postAt(db, b.convo, 'b', mid(-1))
  const items = []
  for (let i = 0; i < 12; i++) items.push(item(db, a.convo, 'task', `Item ${i}`))
  db.prepare('UPDATE items SET created_at = ?, updated_at = ?').run(mid(-1), mid(-1))
  for (let i = 0; i < 7; i++) { blobRow(db, `b${i}`); attachAt(db, items[0], `b${i}`, mid(-1, i)) }
  attachAt(db, items[0], 'doc', mid(-1, 9), 'application/pdf')
  put(db, -1, {
    lede: 'Lede.', stories: [tale({ title: 'T', project_ids: [b.p.id, a.p.id], item_ids: [items[0].id], media_blob_id: 'b3' })],
  })
  const raw = weekRaw(db, 1, keyOf(-1), at)
  assert.deepEqual(Object.keys(raw), RAW_KEYS)
  assert.equal(raw.week, keyOf(-1)); assert.equal(raw.final, true); assert.equal(raw.current, false)
  assert.equal(raw.written_at, NOW)
  assert.equal(raw.projects_total, 2); assert.equal(raw.offset, 0); assert.equal(raw.next_offset, null); assert.equal(raw.more_projects, 0)
  assert.equal(weekRaw(db, 1, keyOf(0), at).current, true)
  assert.deepEqual(raw.projects.map((p) => p.project.title), ['Alpha', 'Bravo'])
  const alpha = raw.projects[0]
  assert.equal(alpha.status, 'On track'); assert.equal(raw.projects[1].status, null)
  assert.ok(alpha.moved > 12)
  assert.equal(alpha.milestones.length, 6)
  assert.deepEqual(alpha.milestones[0], { title: 'step 11', kind: 'progress', at: mid(-1, 11) })
  assert.ok(alpha.milestones.every((m, i, all) => i === 0 || all[i - 1].at >= m.at))
  assert.equal(alpha.items.length, 6)
  assert.deepEqual(Object.keys(alpha.items[0]), ['id', 'num', 'title', 'kind', 'state', 'awaiting', 'at'])
  assert.equal(alpha.items[0].id, items[0].id) // newest activity: the attachment comments
  assert.equal(alpha.media.length, 3)
  assert.deepEqual(alpha.media[0], { blob_id: 'b6', content_type: 'image/png', name: 'b6.png', at: mid(-1, 6) })
  assert.deepEqual(raw.stored, {
    lede: 'Lede.', final: false, legacy: true,
    stories: [{
      title: 'T', sentence: 'It shipped.', next: null, projects: [ref(b.p), ref(a.p)],
      items: [{ id: items[0].id, num: items[0].num, title: 'Item 0' }], media_blob_id: 'b3',
    }],
  })
  assert.equal(weekRaw(db, 1, '2026-11-10', at), null)
})

test('weekRaw returns one page of the moving projects and counts them all; applies the agent sieve; drops refs that no longer resolve', () => {
  const db = seeded()
  const ps = []
  for (let i = 1; i <= 43; i++) { const x = proj(db, `P${i}`); postAt(db, x.convo, 'm', mid(-1)); ps.push(x) }
  const raw = weekRaw(db, 1, keyOf(-1), at)
  assert.equal(raw.projects.length, 12); assert.equal(raw.projects_total, 43); assert.equal(raw.more_projects, 31)
  const a = ps[0]
  const it = item(db, a.convo, 'task', 'Gone soon')
  put(db, -1, { lede: 'x', stories: [tale({ project_ids: [a.p.id], item_ids: [it.id] })] })
  db.prepare('DELETE FROM items WHERE id = ?').run(it.id)
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', ps[1].p.id)
  const out = weekRaw(db, 1, keyOf(-1), at)
  assert.deepEqual(out.stored.stories[0].items, [])
  assert.equal(out.projects.some((p) => p.project.id === ps[1].p.id), false)
  assert.equal(out.projects.length, 12); assert.equal(out.projects_total, 42); assert.equal(out.more_projects, 30)
  assert.equal(weekRaw(db, 1, keyOf(-1), { ...at, limit: 20, offset: 40 }).projects.some((p) => p.project.id === ps[1].p.id), false)
})

test('weekRaw runs one items query for all the shown projects, reading only the week', () => {
  const db = seeded()
  const ps = [proj(db, 'Alpha'), proj(db, 'Bravo'), proj(db, 'Charlie')]
  const old = []
  for (const { p, convo } of ps) {
    postAt(db, convo, 'm', mid(-1))
    old.push(item(db, convo, 'task', `${p.title} old`, { now: mid(-5) }))
    item(db, convo, 'task', `${p.title} new`, { now: mid(-1) })
  }
  for (const it of old) addComment(db, { userId: 1, itemId: it.id, author: 'agent', deviceId: 7, body: 'x', now: mid(-4) })
  db.prepare('UPDATE items SET updated_at = created_at').run()
  let runs = 0; let sql = ''
  const prepare = db.prepare.bind(db)
  db.prepare = (q) => {
    const st = prepare(q)
    if (!/ROW_NUMBER/.test(q)) return st
    sql = q
    return { all: (a) => { runs += 1; return st.all(a) } }
  }
  const raw = weekRaw(db, 1, keyOf(-1), at)
  assert.equal(runs, 1)
  assert.deepEqual(raw.projects.map((x) => x.items.map((i) => i.title)).sort(), [['Alpha new'], ['Bravo new'], ['Charlie new']])
  // The week's range is inside every arm of the activity union, so nothing outside it is read.
  const arms = sql.slice(sql.indexOf('FROM (SELECT i.id AS item_id'), sql.indexOf(') ev'))
  assert.equal((arms.match(/>= @start AND [a-z.]+_at < @end/g) ?? []).length, 3)
})

test("weekRaw applies the agent sieve to milestones, items and pictures, and leaves consent cards out of items", () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  db.prepare("UPDATE conversations SET mission_id = ? WHERE id = 'secret'").run(a.m.id)
  postAt(db, a.convo, 'public milestone', mid(-1))
  post(db, 'secret', 'private milestone', 9)
  db.prepare("UPDATE milestones SET created_at = ? WHERE title = 'private milestone'").run(mid(-1, 1))
  const pub = item(db, a.convo, 'task', 'Public task', { now: mid(-1) })
  const priv = item(db, 'secret', 'task', 'Private task', { now: mid(-1, 1) })
  item(db, a.convo, 'decision', 'Approve the spawn', { consent: 'spawn:x', awaiting: 'user', now: mid(-1, 2) })
  const quiet = item(db, a.convo, 'task', 'Old public task', { now: mid(-5) })
  addComment(db, { userId: 1, itemId: quiet.id, author: 'user', deviceId: 9, body: 'from the private box', now: mid(-1, 3) })
  db.prepare('UPDATE items SET updated_at = created_at').run()
  blobRow(db, 'b-pub'); attachAt(db, pub, 'b-pub', mid(-1))
  blobRow(db, 'b-sec'); attachAt(db, priv, 'b-sec', mid(-1, 1))
  const view = (o) => { const [x] = weekRaw(db, 1, keyOf(-1), { ...at, ...o }).projects; return x }
  const agent = view({ excludePrivateOwned: true })
  assert.deepEqual(agent.milestones.map((m) => m.title), ['public milestone'])
  assert.deepEqual(agent.items.map((i) => i.title), ['Public task'])
  assert.deepEqual(agent.media.map((m) => m.blob_id), ['b-pub'])
  const all = view({ excludePrivateOwned: false })
  assert.deepEqual(all.milestones.map((m) => m.title), ['private milestone', 'public milestone'])
  assert.deepEqual(all.items.map((i) => i.title), ['Old public task', 'Private task', 'Public task'])
  assert.deepEqual(all.media.map((m) => m.blob_id), ['b-sec', 'b-pub'])
})

test('a stored item whose mission sits in a project the agent cannot see is dropped from an agent read', () => {
  const db = seeded()
  const a = proj(db, 'Open'); const b = proj(db, 'Turned private')
  postAt(db, a.convo, 'a', mid(-1))
  const it = item(db, b.convo, 'question', 'Hidden by project')
  put(db, -1, { lede: 'x', stories: [tale({ project_ids: [a.p.id], item_ids: [it.id] })] })
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', b.p.id)
  assert.deepEqual(weekDetail(db, 1, keyOf(-1), { ...at, excludePrivateOwned: true }).stories[0].needs_you, [])
  assert.equal(weekDetail(db, 1, keyOf(-1), at).stories[0].needs_you.length, 1)
  assert.deepEqual(weekRaw(db, 1, keyOf(-1), at).stored.stories[0].items, [])
})

// ---- Review fixes: waiting items in the raw read, zone changes, non-picture media ----

test('weekRaw lists, per project, every item still waiting on the user, whatever the week\'s activity; newest first, capped at 5', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const b = proj(db, 'Bravo')
  postAt(db, a.convo, 'a1', mid(-1)); postAt(db, b.convo, 'b1', mid(-1))
  // Waiting for weeks, no activity in the week asked about: not in `items`, but in `needs_you`.
  const stale = item(db, a.convo, 'question', 'Old question', { awaiting: 'user', now: mid(-5) })
  const answered = item(db, a.convo, 'question', 'Answered', { awaiting: 'agent', now: mid(-5) })
  const closed = item(db, a.convo, 'question', 'Closed', { awaiting: 'user', now: mid(-5) })
  closeItem(db, { userId: 1, itemId: closed.id, resolution: 'answered', author: 'user', deviceId: 8 })
  item(db, a.convo, 'decision', 'Approve the spawn', { consent: 'spawn:x', awaiting: 'user', now: mid(-5) })
  const later = item(db, a.convo, 'question', 'Created after the week', { awaiting: 'user', now: mid(0) })
  const fresh = item(db, a.convo, 'question', 'Fresh question', { awaiting: 'user', now: mid(-1) })
  const raw = weekRaw(db, 1, keyOf(-1), at)
  const alpha = raw.projects.find((x) => x.project.id === a.p.id)
  assert.deepEqual(alpha.needs_you, [stale, fresh].reverse().map((i) => ({ id: i.id, num: i.num, title: i.title })))
  assert.ok(!alpha.items.some((i) => i.id === stale.id), 'the stale item has no activity in the week')
  assert.ok(![answered, closed, later].some((i) => alpha.needs_you.some((n) => n.id === i.id)))
  assert.deepEqual(raw.projects.find((x) => x.project.id === b.p.id).needs_you, [])
  // The apps' fallback card for the same week shows the same set.
  const card = weekDetail(db, 1, keyOf(-1), at).stories.find((s) => s.project.id === a.p.id)
  assert.deepEqual(card.needs_you.map((n) => n.id), alpha.needs_you.map((n) => n.id))
  // Capped at 5, the newest kept.
  for (let i = 0; i < 12; i++) item(db, a.convo, 'question', `Q${i}`, { awaiting: 'user', now: mid(-3, i) })
  assert.deepEqual(weekRaw(db, 1, keyOf(-1), at).projects.find((x) => x.project.id === a.p.id).needs_you.map((n) => n.title),
    ['Fresh question', 'Q11', 'Q10', 'Q9', 'Q8'])
})

test('weekRaw needs_you applies the agent sieve', () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  db.prepare("UPDATE conversations SET mission_id = ? WHERE id = 'secret'").run(a.m.id)
  postAt(db, a.convo, 'a1', mid(-1))
  item(db, a.convo, 'question', 'Public', { awaiting: 'user', now: mid(-5) })
  item(db, 'secret', 'question', 'Private', { awaiting: 'user', now: mid(-5) })
  const titles = (o) => weekRaw(db, 1, keyOf(-1), { ...at, ...o }).projects[0].needs_you.map((n) => n.title).sort()
  assert.deepEqual(titles({ excludePrivateOwned: true }), ['Public'])
  assert.deepEqual(titles({ excludePrivateOwned: false }), ['Private', 'Public'])
})

test('a written week is still written after the user changes time zone', () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  postAt(db, a.convo, 'a1', mid(-1))
  put(db, -1, { lede: 'Last week. Went well.', stories: [tale({ title: 'T', project_ids: [a.p.id] })] })
  db.prepare("UPDATE users SET time_zone = 'America/New_York' WHERE id = 1").run()
  const detail = weekDetail(db, 1, keyOf(-1), at)
  assert.equal(detail.lede, 'Last week. Went well.'); assert.equal(detail.stories[0].title, 'T')
  const listed = weeksList(db, 1, at).weeks.find((w) => w.week === keyOf(-1))
  assert.equal(listed.written, true); assert.equal(listed.sentence, 'Last week.')
  assert.equal(weekRaw(db, 1, keyOf(-1), at).stored.lede, 'Last week. Went well.')
  // A rewrite after the change replaces the row rather than adding a second.
  put(db, -1, { lede: 'Rewritten.', stories: [tale({ title: 'U', project_ids: [a.p.id] })] })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM week_stories').get().n, 1)
  assert.equal(weekDetail(db, 1, keyOf(-1), at).lede, 'Rewritten.')
})

test('a stored picture that is not an image or video reads as missing: the week\'s roll-up picture shows instead', () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  const it = item(db, a.convo, 'task', 'T', { now: mid(-1) })
  blobRow(db, 'b-pic'); attachAt(db, it, 'b-pic', mid(-1))
  blobRow(db, 'b-doc', 'application/pdf'); attachAt(db, it, 'b-doc', mid(-1, 1), 'application/pdf')
  put(db, -1, { lede: 'x', stories: [tale({ project_ids: [a.p.id], media_blob_id: 'b-pic' })] })
  // Only a write that skipped the check could store a document; forge one.
  db.prepare("UPDATE week_stories SET stories = replace(stories, 'b-pic', 'b-doc')").run()
  assert.equal(weekDetail(db, 1, keyOf(-1), at).stories[0].media.blob_id, 'b-pic')
  assert.equal(weekRaw(db, 1, keyOf(-1), at).stored.stories[0].media_blob_id, null)
})

test('weekRaw: a status written by a private device reads as null', () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  updateProject(db, { userId: 1, projectId: a.p.id, fields: { status: 'Secret plans' }, statusWriter: { by: 'agent', deviceId: 9, convoId: null } })
  postAt(db, a.convo, 'step', mid(-1))
  assert.equal(weekRaw(db, 1, keyOf(-1), at).projects[0].status, null)
})

test('a note written before a merge follows the project into its survivor', () => {
  const db = seeded()
  const gone = proj(db, 'Gone', { createdAt: NOW - 40 * DAY })
  const survivor = proj(db, 'Survivor', { createdAt: NOW - 40 * DAY })
  db.prepare('INSERT INTO project_notes(user_id, project_id, note, written_at) VALUES(1,?,?,?)').run(gone.p.id, 'Left mid-way.', NOW - DAY)
  mergeProject(db, { userId: 1, projectId: gone.p.id, intoId: survivor.p.id, by: 'user' })
  const row = openLong(db, 1, at).rows.find((r) => r.project.id === survivor.p.id)
  assert.equal(row.note, 'Left mid-way.')
})

// ---- A week written as one entry per project ----

// An entry as the Coordinator writes it (project is a reference).
const entry = (p, over = {}) => ({ project: p.id, sentence: 'It shipped.', ...over })
const putEntries = (db, n, { entries = [], final = false, notes = [] } = {}, o = {}) =>
  writeWeekEntries(db, 1, keyOf(n), validWeekEntries({ entries, final, notes }), { now: NOW, excludePrivateOwned: false, ...o })

// ---- The raw week read in pages, bounded in size ----

// Every page of last week's raw read, following next_offset from 0.
function rawPages(db, opts = {}) {
  const pages = []
  for (let offset = 0; offset != null; offset = pages.at(-1).next_offset) {
    pages.push(weekRaw(db, 1, keyOf(-1), { ...at, ...opts, offset }))
    assert.ok(pages.length <= 100, 'paging ends')
  }
  return pages
}
// A project that moved last week carrying as much as one project can: a
// title and a status at their limits and more milestones, items, waiting
// items and pictures than the read keeps, every title 200 characters.
function heavy(db, n) {
  const long = (what) => `${what} `.padEnd(200, 'x')
  const x = proj(db, long(`Project ${n}`))
  updateProject(db, { userId: 1, projectId: x.p.id, fields: { status: 's'.repeat(600) }, statusWriter: { by: 'agent', deviceId: 7, convoId: 'c1' } })
  for (let i = 0; i < 6; i++) postAt(db, x.convo, long(`Step ${i}`), mid(-1, i))
  const items = []
  for (let i = 0; i < 6; i++) items.push(item(db, x.convo, 'task', long(`Task ${i}`), { now: mid(-1, i) }))
  for (let i = 0; i < 5; i++) item(db, x.convo, 'question', long(`Question ${i}`), { awaiting: 'user', now: mid(-5, i) })
  for (let i = 0; i < 3; i++) {
    const id = `b${n}-${i}`
    blobRow(db, id)
    addComment(db, { userId: 1, itemId: items[0].id, author: 'agent', deviceId: 7, attachments: [{ blob_ref: id, mime: 'image/png', name: `${long(id)}.png`, size: 4 }], now: mid(-1, 7 + i) })
  }
  return x
}

test('weekRaw pages the moving projects: 12 a page, the total, where the next page starts, the stored week on the first page only', () => {
  const db = seeded()
  const ps = []
  for (let i = 1; i <= 30; i++) { const x = proj(db, `P${i}`); postAt(db, x.convo, 'm', mid(-1)); ps.push(x) }
  put(db, -1, { lede: 'Lede.', stories: [tale({ project_ids: [ps[0].p.id] })] })
  const one = weekRaw(db, 1, keyOf(-1), at)
  assert.deepEqual(Object.keys(one), RAW_KEYS)
  assert.equal(one.projects.length, 12); assert.equal(one.projects_total, 30)
  assert.equal(one.offset, 0); assert.equal(one.next_offset, 12); assert.equal(one.more_projects, 18)
  assert.equal(one.stored.lede, 'Lede.')
  const two = weekRaw(db, 1, keyOf(-1), { ...at, offset: 12 })
  assert.equal(two.projects.length, 12); assert.equal(two.projects_total, 30)
  assert.equal(two.offset, 12); assert.equal(two.next_offset, 24); assert.equal(two.more_projects, 6)
  // The stored week is on the first page only; what it says about the week is on every page.
  assert.equal(two.stored, null); assert.equal(two.written_at, NOW); assert.equal(two.final, true)
  const last = weekRaw(db, 1, keyOf(-1), { ...at, offset: 24 })
  assert.equal(last.projects.length, 6); assert.equal(last.offset, 24); assert.equal(last.next_offset, null); assert.equal(last.more_projects, 0)
  assert.deepEqual([one, two, last].flatMap((r) => r.projects.map((x) => x.project.id)), ps.map((x) => x.p.id))
  // A chosen page size, and an offset at or past the end.
  const wide = weekRaw(db, 1, keyOf(-1), { ...at, offset: 5, limit: 20 })
  assert.deepEqual(wide.projects.map((x) => x.project.id), ps.slice(5, 25).map((x) => x.p.id))
  assert.equal(wide.next_offset, 25); assert.equal(wide.more_projects, 5)
  const exact = weekRaw(db, 1, keyOf(-1), { ...at, offset: 10, limit: 20 })
  assert.equal(exact.projects.length, 20); assert.equal(exact.next_offset, null); assert.equal(exact.more_projects, 0)
  for (const offset of [30, 99]) {
    const past = weekRaw(db, 1, keyOf(-1), { ...at, offset })
    assert.deepEqual(past.projects, []); assert.equal(past.projects_total, 30)
    assert.equal(past.offset, offset); assert.equal(past.next_offset, null); assert.equal(past.more_projects, 0)
  }
  // A week nothing moved in.
  const quiet = weekRaw(db, 1, keyOf(-3), at)
  assert.deepEqual(quiet.projects, []); assert.equal(quiet.projects_total, 0); assert.equal(quiet.next_offset, null); assert.equal(quiet.more_projects, 0)
})

test('weekRaw: a page never exceeds 36,000 characters', () => {
  const db = seeded()
  const ps = []
  for (let n = 1; n <= 20; n++) ps.push(heavy(db, n))
  // A stored week at its own limits is part of the first page.
  put(db, -1, {
    lede: 'l'.repeat(600),
    stories: ps.slice(0, 8).map((x, i) => tale({ title: `Story ${i}`, sentence: 's'.repeat(300), next: 'n'.repeat(300), project_ids: [x.p.id] })),
  })
  assert.equal(RAW.maxChars, 36_000)
  const first = weekRaw(db, 1, keyOf(-1), { ...at, limit: 20 })
  assert.equal(first.projects_total, 20)
  // Twenty were asked for; the page shrank to fit and the next page starts where it stopped.
  assert.ok(first.projects.length >= 1 && first.projects.length < 20, `${first.projects.length} projects`)
  assert.equal(first.next_offset, first.projects.length)
  assert.equal(first.more_projects, 20 - first.projects.length)
  assert.equal(first.projects[0].milestones.length, 6); assert.equal(first.projects[0].items.length, 6)
  assert.equal(first.projects[0].needs_you.length, 5); assert.equal(first.projects[0].media.length, 3)
  for (const limit of [20, 12, 7]) {
    const pages = rawPages(db, { limit })
    for (const page of pages) {
      const size = JSON.stringify(page).length
      assert.ok(size <= 36_000, `limit ${limit}, offset ${page.offset}: ${size} characters`)
      assert.ok(page.projects.length >= 1 && page.projects.length <= limit)
      assert.equal(page.more_projects, 20 - page.offset - page.projects.length)
      assert.equal(page.next_offset, page.more_projects ? page.offset + page.projects.length : null)
    }
    // Paging from next_offset reaches every project exactly once, in rank order.
    assert.deepEqual(pages.flatMap((page) => page.projects.map((x) => x.project.id)), ps.map((x) => x.p.id), `limit ${limit}`)
  }
})

// A stored week as large as the grouped-stories write allowed: 8 stories,
// each naming 10 projects and 10 items, every text at its limit and every
// title 200 characters. Twenty heavy projects moved; the rest are only named.
function largeStoredWeek(db) {
  const long = (what) => `${what} `.padEnd(200, 'x')
  const ps = []
  for (let n = 1; n <= 20; n++) ps.push(heavy(db, n))
  const stories = []
  for (let s = 0; s < 8; s++) {
    const named = [ps[s].p.id]
    while (named.length < 10) named.push(proj(db, long(`Named ${s}.${named.length}`)).p.id)
    const items = []
    for (let i = 0; i < 10; i++) items.push(item(db, ps[s].convo, 'task', long(`Stored ${s}.${i}`), { now: mid(-6) }).id)
    stories.push(tale({ title: 't'.repeat(80), sentence: 's'.repeat(300), next: 'n'.repeat(300), project_ids: named, item_ids: items }))
  }
  put(db, -1, { lede: 'l'.repeat(600), stories })
  return ps
}

test('weekRaw: a large stored week gives up its items to keep the first page within the bound', () => {
  const db = seeded()
  const ps = largeStoredWeek(db)
  const first = weekRaw(db, 1, keyOf(-1), { ...at, limit: 20 })
  const size = JSON.stringify(first).length
  assert.ok(size <= RAW.maxChars, `${size} characters`)
  assert.equal(first.stored.items_omitted, true)
  assert.equal(first.stored.stories.length, 8)
  for (const s of first.stored.stories) assert.deepEqual(s.items, [])
  // The stories keep their text and, while the page fits, every project they name.
  assert.equal(first.stored.projects_omitted, undefined)
  assert.equal(first.stored.stories[0].projects.length, 10)
  assert.equal(first.stored.stories[0].sentence, 's'.repeat(300)); assert.equal(first.stored.lede, 'l'.repeat(600))
  assert.equal(first.stored.legacy, true)
  // Still one moving project on the page, and paging reaches the rest.
  assert.equal(first.projects.length, 1); assert.equal(first.projects[0].project.id, ps[0].p.id)
  assert.equal(first.projects_total, 20); assert.equal(first.next_offset, 1); assert.equal(first.more_projects, 19)
  const pages = rawPages(db, { limit: 20 })
  for (const page of pages) assert.ok(JSON.stringify(page).length <= RAW.maxChars, `offset ${page.offset}`)
  assert.deepEqual(pages.flatMap((page) => page.projects.map((x) => x.project.id)), ps.map((x) => x.p.id))
  assert.equal(pages[1].stored, null)
})

test('weekRaw: a stored week still too large without its items keeps one project a story', () => {
  const db = seeded()
  const ps = largeStoredWeek(db)
  // Titles longer than a project is given today.
  db.prepare("UPDATE projects SET title = title || ?").run('y'.repeat(200))
  const first = weekRaw(db, 1, keyOf(-1), { ...at, limit: 20 })
  const size = JSON.stringify(first).length
  assert.ok(size <= RAW.maxChars, `${size} characters`)
  assert.equal(first.stored.items_omitted, true); assert.equal(first.stored.projects_omitted, true)
  assert.equal(first.stored.stories.length, 8)
  first.stored.stories.forEach((s, i) => {
    assert.deepEqual(s.items, [])
    assert.deepEqual(s.projects.map((p) => p.id), [ps[i].p.id], 'the main project stays')
  })
  assert.equal(first.projects.length, 1); assert.equal(first.next_offset, 1)
})

test('weekRaw: a stored week that fits is returned whole, with no omission flags', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); postAt(db, a.convo, 'a', mid(-1))
  const it = item(db, a.convo, 'task', 'Invoices', { now: mid(-1) })
  put(db, -1, { stories: [tale({ project_ids: [a.p.id], item_ids: [it.id] })] })
  const { stored } = weekRaw(db, 1, keyOf(-1), at)
  assert.deepEqual(Object.keys(stored), ['lede', 'final', 'legacy', 'stories'])
  assert.equal(stored.stories[0].items.length, 1)
})

test('weekRaw: one project with every cap at its limit is far under the page bound', () => {
  const db = seeded()
  heavy(db, 1)
  const raw = weekRaw(db, 1, keyOf(-1), { ...at, limit: 1 })
  const [x] = raw.projects
  assert.equal(x.milestones.length, RAW.milestones); assert.equal(x.items.length, RAW.items)
  assert.equal(x.needs_you.length, RAW.needsYou); assert.equal(x.media.length, RAW.media)
  assert.equal(x.status.length, RAW.statusMax)
  for (const row of [...x.milestones, ...x.items, ...x.needs_you]) assert.equal(row.title.length, RAW.titleMax)
  const size = JSON.stringify(x).length
  assert.ok(size < RAW.maxChars / 5, `${size} characters`)
  assert.ok(JSON.stringify(raw).length < RAW.maxChars / 5)
})

test('weekRaw clips a milestone, item or waiting item title to 140 characters and a status to 300, ending with an ellipsis', () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  const long = 'A long title. '.repeat(15).slice(0, 200)
  postAt(db, a.convo, long, mid(-1, 3)); postAt(db, a.convo, 'm'.repeat(140), mid(-1, 2)); postAt(db, a.convo, 'm'.repeat(141), mid(-1, 1))
  item(db, a.convo, 'question', long, { awaiting: 'user', now: mid(-1) })
  updateProject(db, { userId: 1, projectId: a.p.id, fields: { status: 's'.repeat(301) }, statusWriter: { by: 'agent', deviceId: 7, convoId: 'c1' } })
  const [x] = weekRaw(db, 1, keyOf(-1), at).projects
  const clipped = `${long.slice(0, 139)}…`
  assert.equal(clipped.length, 140)
  assert.deepEqual(x.milestones.map((m) => m.title), [clipped, 'm'.repeat(140), `${'m'.repeat(139)}…`])
  assert.equal(x.items[0].title, clipped); assert.equal(x.needs_you[0].title, clipped)
  assert.equal(x.status, `${'s'.repeat(299)}…`); assert.equal(x.status.length, 300)
  // At the limit a status is whole.
  updateProject(db, { userId: 1, projectId: a.p.id, fields: { status: 's'.repeat(300) }, statusWriter: { by: 'agent', deviceId: 7, convoId: 'c1' } })
  assert.equal(weekRaw(db, 1, keyOf(-1), at).projects[0].status, 's'.repeat(300))
  // A clip never ends on half a character.
  postAt(db, a.convo, `${'e'.repeat(138)}😀 and more`, mid(-1, 4))
  assert.equal(weekRaw(db, 1, keyOf(-1), at).projects[0].milestones[0].title, `${'e'.repeat(138)}…`)
})

test('weekRaw: stored.legacy is true for a week of grouped stories and false for one entry per project', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const b = proj(db, 'Bravo')
  postAt(db, a.convo, 'a', mid(-1)); postAt(db, b.convo, 'b', mid(-1))
  const legacy = () => weekRaw(db, 1, keyOf(-1), at).stored.legacy
  putEntries(db, -1, { entries: [entry(a.p), entry(b.p)] })
  assert.equal(legacy(), false)
  // A titled card, even on one project.
  put(db, -1, { stories: [tale({ title: 'Launch', project_ids: [a.p.id] })] })
  assert.equal(legacy(), true)
  // An untitled story naming two projects: judged as stored, before any project drops out of sight.
  put(db, -1, { stories: [tale({ title: 'Launch', project_ids: [a.p.id, b.p.id] })] })
  db.prepare("UPDATE week_stories SET stories = replace(stories, '\"title\":\"Launch\"', '\"title\":null')").run()
  assert.equal(weekRaw(db, 1, keyOf(-1), at).stored.stories[0].title, null)
  assert.equal(legacy(), true)
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', b.p.id)
  assert.equal(weekRaw(db, 1, keyOf(-1), at).stored.stories[0].projects.length, 1)
  assert.equal(legacy(), true)
  // A frozen week with no cards is not a grouped one.
  putEntries(db, -2, { final: true })
  assert.equal(weekRaw(db, 1, keyOf(-2), at).stored.legacy, false)
})

test('validWeekEntries: 0..8 entries, each a project and a sentence of 1..300; next and the picture are optional', () => {
  const e = { project: 3, sentence: ' It shipped. ' }
  assert.deepEqual(validWeekEntries({ entries: [] }), { entries: [], final: false, notes: [] })
  assert.deepEqual(validWeekEntries({ entries: [e], final: true, notes: [{ project_id: 'p1', note: 'Steady.' }] }), {
    entries: [{ project: 3, sentence: 'It shipped.', next: null, media_blob_id: null }], final: true, notes: [{ project: 'p1', note: 'Steady.' }],
  })
  assert.deepEqual(validWeekEntries({ entries: [{ project: 'p1', sentence: 's', next: 'Docs', media_blob_id: 'b1' }] }).entries,
    [{ project: 'p1', sentence: 's', next: 'Docs', media_blob_id: 'b1' }])
  assert.equal(validWeekEntries({ entries: Array(8).fill(e) }).entries.length, 8)
  assert.equal(validWeekEntries({ entries: Array(9).fill(e) }), null)
  assert.equal(validWeekEntries({ entries: [{ ...e, sentence: 'x'.repeat(300) }] }).entries[0].sentence.length, 300)
  for (const bad of [
    { sentence: 's' }, { project: 0, sentence: 's' }, { project: '', sentence: 's' }, { project: 3 }, { project: 3, sentence: ' ' },
    { project: 3, sentence: 'x'.repeat(301) }, { project: 3, sentence: 's', next: 'x'.repeat(301) }, { project: 3, sentence: 's', next: 5 },
    { project: 3, sentence: 's', media_blob_id: 5 }, 'nope', null,
  ]) assert.equal(validWeekEntries({ entries: [bad] }), null, JSON.stringify(bad))
  for (const bad of [null, [], { entries: 'x' }, { entries: [], final: 'yes' }, { entries: [], notes: [{ project_id: 3 }] }]) {
    assert.equal(validWeekEntries(bad), null, JSON.stringify(bad))
  }
})

test('validWeekEntries needs its entries: a body without the list is malformed, an empty list is a week with no cards', () => {
  const note = { project_id: 3, note: 'Steady.' }
  for (const bad of [
    {}, { entries: null }, { entries: {} }, { entries: 0 }, { notes: [note] }, { final: false },
    { lede: 'A busy week.', stories: [{ title: 'Launch', sentence: 'It shipped.', project_ids: [3] }] },
  ]) assert.equal(validWeekEntries(bad), null, JSON.stringify(bad))
  assert.deepEqual(validWeekEntries({ entries: [], notes: [note] }), { entries: [], final: false, notes: [{ project: 3, note: 'Steady.' }] })
})

test('validWeekEntries drops a title, project_ids, item_ids or lede it is sent', () => {
  const out = validWeekEntries({ lede: 'A big week.', title: 'x', entries: [{ project: 3, sentence: 's', title: 'Launch', project_ids: [4], item_ids: [5], lede: 'y' }] })
  assert.deepEqual(out, { entries: [{ project: 3, sentence: 's', next: null, media_blob_id: null }], final: false, notes: [] })
})

test('writeWeekEntries stores one story per entry: no title, no lede, one resolved project, no items', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const b = proj(db, 'Bravo')
  blobRow(db, 'b-shot')
  const r = putEntries(db, 0, {
    entries: [entry(b.p, { project: b.p.num, next: 'Docs', media_blob_id: 'b-shot' }), entry(a.p, { sentence: 'Done.' })],
    notes: [{ project_id: a.p.id, note: 'Steady.' }],
  })
  assert.deepEqual(r, { ok: true, week: keyOf(0), entries: 2 })
  assert.deepEqual(storedWeek(db, 1, keyOf(0)), {
    week_key: keyOf(0), lede: null, written_at: NOW, final: false,
    stories: [
      { title: null, sentence: 'It shipped.', next: 'Docs', project_ids: [b.p.id], item_ids: [], media_blob_id: 'b-shot' },
      { title: null, sentence: 'Done.', next: null, project_ids: [a.p.id], item_ids: [], media_blob_id: null },
    ],
  })
  assert.equal(db.prepare('SELECT note FROM project_notes WHERE project_id = ?').get(a.p.id).note, 'Steady.')
  // A second write replaces the week's entries and the note.
  assert.deepEqual(putEntries(db, 0, { entries: [entry(a.p)], notes: [{ project_id: a.p.num, note: 'Faster.' }] }), { ok: true, week: keyOf(0), entries: 1 })
  assert.deepEqual(storedWeek(db, 1, keyOf(0)).stories.map((s) => s.project_ids), [[a.p.id]])
  assert.deepEqual(db.prepare('SELECT note FROM project_notes').all(), [{ note: 'Faster.' }])
})

test('writeWeekEntries replaces a week written as grouped stories, lede and all', () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  put(db, 0, { lede: 'A big week.', stories: [tale({ project_ids: [a.p.id] })] })
  assert.equal(putEntries(db, 0, { entries: [entry(a.p)] }).ok, true)
  const w = storedWeek(db, 1, keyOf(0))
  assert.equal(w.lede, null); assert.deepEqual(w.stories.map((s) => s.title), [null])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM week_stories').get().n, 1)
})

test('writeWeekEntries refuses two entries on one project, by id and number or through a merge, and stores nothing', () => {
  const db = seeded()
  const a = proj(db, 'Survivor'); const b = proj(db, 'Gone')
  assert.deepEqual(putEntries(db, 0, { entries: [entry(a.p), entry(b.p), entry(a.p, { project: a.p.num })] }),
    { error: 'bad_request', detail: 'duplicate_project', ref: a.p.num })
  mergeProject(db, { userId: 1, projectId: b.p.id, intoId: a.p.id, by: 'user' })
  assert.deepEqual(putEntries(db, 0, { entries: [entry(a.p), entry(b.p)] }), { error: 'bad_request', detail: 'duplicate_project', ref: b.p.id })
  assert.equal(storedWeek(db, 1, keyOf(0)), null)
  // One entry on the merged project is stored under the survivor.
  assert.equal(putEntries(db, 0, { entries: [entry(b.p)] }).ok, true)
  assert.deepEqual(storedWeek(db, 1, keyOf(0)).stories[0].project_ids, [a.p.id])
})

test('writeWeekEntries: an unknown or private project and an unknown picture name the reference and store nothing', () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  const hidden = createProject(db, { userId: 1, deviceId: 9, createdBy: 'agent', title: 'Hidden', convoId: 'secret' }).project
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', hidden.id)
  blobRow(db, 'b-doc', 'application/pdf')
  const sieved = { excludePrivateOwned: true }
  assert.deepEqual(putEntries(db, 0, { entries: [entry(a.p), entry(a.p, { project: 9999 })] }), { error: 'bad_request', detail: 'unknown_project', ref: 9999 })
  assert.deepEqual(putEntries(db, 0, { entries: [entry(hidden)] }, sieved), { error: 'bad_request', detail: 'unknown_project', ref: hidden.id })
  assert.deepEqual(putEntries(db, 0, { notes: [{ project_id: hidden.num, note: 'x' }] }, sieved), { error: 'bad_request', detail: 'unknown_project', ref: hidden.num })
  for (const blob of ['b-nope', 'b-doc']) {
    assert.deepEqual(putEntries(db, 0, { entries: [entry(a.p, { media_blob_id: blob })] }), { error: 'bad_request', detail: 'unknown_blob', ref: blob })
  }
  assert.equal(storedWeek(db, 1, keyOf(0)), null)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_notes').get().n, 0)
  // Unsieved, the private project is the user's own and can be written.
  assert.equal(putEntries(db, 0, { entries: [entry(hidden)] }).ok, true)
})

test('writeWeekEntries keeps the week rules: a real week in reach, final only once it has ended, a final week replaced only by a final write', () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  const write = (key, final = false) => writeWeekEntries(db, 1, key, validWeekEntries({ entries: [entry(a.p)], final }), { now: NOW })
  assert.deepEqual(write('2026-11-10'), { error: 'bad_request', detail: 'bad_week' })
  assert.deepEqual(write(keyOf(1)), { error: 'bad_request', detail: 'week_out_of_range' })
  assert.deepEqual(write(keyOf(-11)), { error: 'bad_request', detail: 'week_out_of_range' })
  assert.equal(write(keyOf(-10)).ok, true)
  assert.deepEqual(write(keyOf(0), true), { error: 'bad_request', detail: 'week_not_ended' })
  assert.equal(write(keyOf(-1), true).ok, true)
  assert.deepEqual(write(keyOf(-1)), { error: 'conflict', detail: 'week_final' })
  assert.equal(write(keyOf(-1), true).ok, true)
  assert.equal(storedWeek(db, 1, keyOf(-1)).final, true)
  // A week grouped stories made final is as frozen as one written by entries.
  put(db, -2, { lede: 'Done.', final: true })
  assert.deepEqual(write(keyOf(-2)), { error: 'conflict', detail: 'week_final' })
})

// ---- Marks on each week card, one card per project ----

const cardOf = (db, n, p, o = {}) => weekDetail(db, 1, keyOf(n), { ...at, ...o }).stories.find((s) => s.project.id === p.id)

test('marks.for_you counts the open items awaiting the user: not a consent card, an item awaiting the agent or one created the week after', () => {
  const db = seeded()
  const a = proj(db, 'Billing'); const other = proj(db, 'Other')
  postAt(db, a.convo, 'moved', mid(-1)); postAt(db, other.convo, 'moved', mid(-1))
  item(db, a.convo, 'question', 'Which plan?', { now: mid(-1) })
  item(db, a.convo, 'question', 'Ship it?', { now: mid(-3) })
  item(db, a.convo, 'decision', 'Approve the spawn', { consent: 'spawn:x', awaiting: 'user', now: mid(-1) })
  item(db, a.convo, 'task', 'Agent work', { now: mid(-1) })
  const later = item(db, a.convo, 'question', 'Created after the week', { now: mid(0) })
  item(db, other.convo, 'question', 'Elsewhere?', { now: mid(-1) })
  assert.equal(cardOf(db, -1, a.p).marks.for_you, 2)
  assert.equal(cardOf(db, 0, a.p).marks.for_you, 3)
  assert.equal(cardOf(db, -1, other.p).marks.for_you, 1)
  // A written week counts the same way, and only what is still open now.
  assert.equal(putEntries(db, -1, { entries: [entry(a.p)], final: true }).ok, true)
  assert.equal(cardOf(db, -1, a.p).marks.for_you, 2)
  closeItem(db, { userId: 1, itemId: later.id, resolution: 'answered', author: 'user', deviceId: 8, now: NOW })
  db.prepare("UPDATE items SET state='closed', awaiting=NULL, closed_at=? WHERE title = 'Which plan?'").run(NOW)
  assert.equal(cardOf(db, -1, a.p).marks.for_you, 1)
})

test('marks.done counts the items closed in the week, not the week before or after, consent cards left out', () => {
  const db = seeded()
  const a = proj(db, 'Billing'); const other = proj(db, 'Other')
  postAt(db, a.convo, 'moved', mid(-1))
  const close = (convo, title, ts, extra = {}) => {
    const it = item(db, convo, 'task', title, { now: mid(-4), ...extra })
    closeItem(db, { userId: 1, itemId: it.id, resolution: 'done', author: 'agent', deviceId: 7, now: ts })
  }
  close(a.convo, 'Invoices', mid(-1))
  close(a.convo, 'Receipts', weekOf(-1)) // the first instant of the week
  close(a.convo, 'Before', mid(-2))
  close(a.convo, 'After', weekOf(0)) // the first instant of the next
  close(a.convo, 'Approve the spawn', mid(-1), { consent: 'spawn:x', awaiting: 'user' })
  close(other.convo, 'Elsewhere', mid(-1))
  item(db, a.convo, 'task', 'Still open', { now: mid(-1) })
  assert.equal(cardOf(db, -1, a.p).marks.done, 2)
  assert.equal(cardOf(db, -2, a.p).marks.done, 1)
  assert.equal(cardOf(db, 0, a.p).marks.done, 1)
  assert.equal(putEntries(db, -1, { entries: [entry(a.p)], final: true }).ok, true)
  assert.equal(cardOf(db, -1, a.p).marks.done, 2)
})

test("a card's item counts reach items through their mission, never through the consent index", () => {
  const db = seeded()
  const a = proj(db, 'Billing')
  for (const sieved of [false, true]) {
    for (const [name, sql] of Object.entries(cardItemsSqlForTest(sieved))) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ userId: 1, projectId: a.p.id, start: weekOf(-1), end: weekOf(0) })
      const text = plan.map((r) => r.detail).join('\n')
      assert.doesNotMatch(text, /idx_items_consent/, `${name}, sieved ${sieved}`)
      assert.match(text, /SEARCH i USING INDEX idx_items_mission \(mission_id=\?/, `${name}, sieved ${sieved}`)
      // The projects merged into this one are found among the user's own.
      assert.doesNotMatch(text, /SCAN q\b/, `${name}, sieved ${sieved}`)
      assert.match(text, /SEARCH q USING INDEX idx_projects_user_state \(user_id=\?/, `${name}, sieved ${sieved}`)
    }
  }
})

test('marks.next is true only with a next; the computed card carries marks too, next false', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const b = proj(db, 'Bravo')
  postAt(db, a.convo, 'a1', mid(-1)); postAt(db, b.convo, 'b1', mid(-1))
  assert.deepEqual(cardOf(db, -1, a.p).marks, { for_you: 0, done: 0, next: false })
  assert.equal(putEntries(db, -1, { entries: [entry(a.p, { next: 'Docs' }), entry(b.p)], final: true }).ok, true)
  assert.deepEqual(cardOf(db, -1, a.p).marks, { for_you: 0, done: 0, next: true })
  assert.deepEqual(cardOf(db, -1, b.p).marks, { for_you: 0, done: 0, next: false })
  // A grouped story written with an empty next has none.
  put(db, -1, { stories: [tale({ project_ids: [a.p.id], next: '' })], final: true })
  assert.equal(cardOf(db, -1, a.p).marks.next, false)
})

test("marks leave out items in a private conversation for an agent and count them for a client", () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  db.prepare("UPDATE conversations SET mission_id = ? WHERE id = 'secret'").run(a.m.id)
  postAt(db, a.convo, 'a1', mid(-1))
  item(db, a.convo, 'question', 'Public', { now: mid(-1) })
  item(db, 'secret', 'question', 'Private', { now: mid(-1) })
  for (const convo of [a.convo, 'secret']) {
    const it = item(db, convo, 'task', `Closed in ${convo}`, { now: mid(-1) })
    closeItem(db, { userId: 1, itemId: it.id, resolution: 'done', author: 'agent', deviceId: 7, now: mid(-1, 1) })
  }
  const marks = (o) => cardOf(db, -1, a.p, o).marks
  assert.deepEqual(marks({ excludePrivateOwned: true }), { for_you: 1, done: 1, next: false })
  assert.deepEqual(marks(), { for_you: 2, done: 2, next: false })
  assert.equal(putEntries(db, -1, { entries: [entry(a.p)], final: true }).ok, true)
  assert.deepEqual(marks({ excludePrivateOwned: true }), { for_you: 1, done: 1, next: false })
  assert.deepEqual(marks(), { for_you: 2, done: 2, next: false })
})

test('one card per project, the first wins: grouped stories that share a main project, and entries merged after the write', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const b = proj(db, 'Bravo'); const c = proj(db, 'Charlie')
  for (const x of [a, b, c]) postAt(db, x.convo, 'moved', mid(-1))
  put(db, -1, {
    lede: 'x', stories: [
      tale({ title: 'First', project_ids: [a.p.id], next: 'Docs' }),
      tale({ title: 'Second', sentence: 'Again.', project_ids: [a.p.id, b.p.id] }),
      tale({ title: 'Third', project_ids: [c.p.id] }),
    ],
  })
  const grouped = weekDetail(db, 1, keyOf(-1), at)
  assert.deepEqual(grouped.stories.map((s) => s.title), ['First', 'Third'])
  assert.deepEqual(grouped.stories[0].marks, { for_you: 0, done: 0, next: true })
  // Bravo is on no card that is left, so it is not lost: it moved.
  assert.deepEqual(grouped.also.map((x) => x.title), ['Bravo'])

  assert.equal(putEntries(db, -1, { entries: [entry(b.p, { sentence: 'Bravo first.' }), entry(c.p), entry(a.p, { sentence: 'Alpha last.' })], final: true }).ok, true)
  const done = item(db, b.convo, 'task', 'Bravo work', { now: mid(-1) })
  closeItem(db, { userId: 1, itemId: done.id, resolution: 'done', author: 'agent', deviceId: 7, now: mid(-1, 1) })
  mergeProject(db, { userId: 1, projectId: b.p.id, intoId: a.p.id, by: 'user' })
  const merged = weekDetail(db, 1, keyOf(-1), at)
  assert.deepEqual(merged.stories.map((s) => [s.project.title, s.sentence]), [['Alpha', 'Bravo first.'], ['Charlie', 'It shipped.']])
  assert.equal(merged.stories[0].marks.done, 1)
  assert.deepEqual(merged.also, [])
})

test('an entry reads back as a card with no title of its own', () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  postAt(db, a.convo, 'a1', mid(-1))
  assert.equal(putEntries(db, -1, { entries: [entry(a.p, { next: 'Docs' })], final: true }).ok, true)
  const out = weekDetail(db, 1, keyOf(-1), at)
  assert.equal(out.lede, null)
  assert.deepEqual(out.stories, [{
    title: null, project: ref(a.p), projects: [ref(a.p)], sentence: 'It shipped.', next: 'Docs', needs_you: [], media: null,
    marks: { for_you: 0, done: 0, next: true },
  }])
})

// ---- Every live project, most recently moved first ----

test('allProjects: live projects newest move first with their open missions; finished and merged ones left out, a merged one counted for its survivor', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const b = proj(db, 'Bravo'); const c = proj(db, 'Charlie')
  postAt(db, a.convo, 'a', mid(-3)); postAt(db, b.convo, 'b', mid(-1)); postAt(db, c.convo, 'c', mid(-2))
  // Bravo: a second open mission and a closed one.
  const more = (title) => createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title, projectId: b.p.id, attach: false }).mission
  more('two')
  const shut = more('shut')
  db.prepare('UPDATE missions SET created_at=?, updated_at=? WHERE project_id=? AND id != ?').run(mid(-9), mid(-9), b.p.id, b.m.id)
  closeAt(db, shut, mid(-8))
  const done = proj(db, 'Done'); closeAt(db, done.m, mid(0))
  // Merged into Alpha: not a row of its own, and its mission and move are now Alpha's.
  const gone = proj(db, 'Gone'); postAt(db, gone.convo, 'g', mid(0, -1))
  mergeProject(db, { userId: 1, projectId: gone.p.id, intoId: a.p.id, by: 'user' })
  const closed = proj(db, 'Closed'); closeProject(db, { userId: 1, projectId: closed.p.id, by: 'user', summary: 'stop' })
  const out = allProjects(db, 1, at)
  assert.deepEqual(out, {
    total: 3,
    rows: [
      { project: ref(a.p), last_moved_at: mid(0, -1), open_missions: 2 },
      { project: ref(b.p), last_moved_at: mid(-1), open_missions: 2 },
      { project: ref(c.p), last_moved_at: mid(-2), open_missions: 1 },
    ],
    next_before: null,
  })
})

test('allProjects pages by a cursor of the last move and the project id; total counts every live project; ties go by id, descending', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const b = proj(db, 'Bravo'); const c = proj(db, 'Charlie'); const d = proj(db, 'Delta')
  postAt(db, a.convo, 'a', mid(-1))
  for (const x of [b, c, d]) postAt(db, x.convo, 'same instant', mid(-2))
  const tied = [b, c, d].map((x) => x.p).sort((x, y) => (x.id < y.id ? 1 : -1))
  const one = allProjects(db, 1, { ...at, limit: 2 })
  assert.equal(one.total, 4)
  assert.deepEqual(one.rows.map((r) => r.project.id), [a.p.id, tied[0].id])
  assert.equal(one.next_before, `${mid(-2)}:${tied[0].id}`)
  const two = allProjects(db, 1, { ...at, limit: 2, before: one.next_before })
  assert.equal(two.total, 4)
  assert.deepEqual(two.rows.map((r) => r.project.id), [tied[1].id, tied[2].id])
  assert.equal(two.next_before, null)
  const three = allProjects(db, 1, { ...at, limit: 3 })
  assert.deepEqual(allProjects(db, 1, { ...at, before: three.next_before }).rows.map((r) => r.project.id), [tied[2].id])
  assert.equal(allProjects(db, 1, { ...at, before: 'bad cursor' }), null)
  assert.deepEqual(allProjects(openDb(':memory:'), 1, at), { total: 0, rows: [], next_before: null })
})

test('allProjects under the agent sieve: no private-origin project, and a private mission neither counts nor moves a project', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); postAt(db, a.convo, 'a', mid(-2))
  // A private mission on a visible project, with a newer milestone.
  createMission(db, { userId: 1, deviceId: 9, createdBy: 'agent', convoId: 'secret', title: 'quiet work', projectId: a.p.id })
  db.prepare("UPDATE missions SET created_at=?, updated_at=? WHERE title='quiet work'").run(mid(-5), mid(-5))
  postAt(db, 'secret', 'hidden step', mid(-1))
  const hidden = proj(db, 'Hidden')
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', hidden.p.id)
  const all = allProjects(db, 1, at)
  assert.equal(all.total, 2)
  assert.deepEqual(all.rows.find((r) => r.project.id === a.p.id), { project: ref(a.p), last_moved_at: mid(-1), open_missions: 2 })
  const sieved = allProjects(db, 1, { ...at, excludePrivateOwned: true })
  assert.deepEqual(sieved, { total: 1, rows: [{ project: ref(a.p), last_moved_at: mid(-2), open_missions: 1 }], next_before: null })
})

// ---- The week index: every moving project in one bounded read ----

const INDEX_KEYS = ['week', 'start', 'end', 'final', 'written_at', 'current', 'stored', 'projects_total', 'projects', 'more_projects']
const ROW_KEYS = ['id', 'num', 'title', 'moved', 'milestones', 'done', 'for_you', 'media', 'newest']
const indexOf = (db, n = -1, o = {}) => weekIndex(db, 1, keyOf(n), { ...at, ...o })
const sizeOf = (x) => JSON.stringify(x).length
// `count` projects that moved last week, each with one milestone; titles as given.
function crowd(db, count, { title = (i) => `P${i}`, milestone = () => 'm' } = {}) {
  const ps = []
  for (let i = 1; i <= count; i++) { const x = proj(db, title(i)); postAt(db, x.convo, milestone(i), mid(-1)); ps.push(x) }
  return ps
}
const longTitle = (i) => `Project ${i} `.padEnd(200, 'x')
const longStep = (i) => `Step ${i} `.padEnd(200, 'y')

test('weekIndex: one compact row per moving project with its counts for the week; a quiet week and a bad key', () => {
  const db = seeded()
  const a = proj(db, 'Promo launch'); const b = proj(db, 'Bravo'); proj(db, 'Quiet')
  postAt(db, a.convo, 'before', mid(-2))
  for (let i = 0; i < 3; i++) postAt(db, a.convo, `step ${i}`, mid(-1, i))
  postAt(db, a.convo, 'after', mid(0))
  postAt(db, b.convo, 'b', mid(-1))
  // Closed in the week, the week before and the week after; a consent card closed in the week.
  const closed = (title, created, closedAt, extra = {}) => {
    const it = item(db, a.convo, 'task', title, { now: created, ...extra })
    db.prepare("UPDATE items SET state='closed', awaiting=NULL, closed_at=? WHERE id=?").run(closedAt, it.id)
    return it
  }
  const shown = closed('Done in the week', mid(-3), mid(-1))
  closed('Done earlier', mid(-3), mid(-2))
  closed('Done later', mid(-3), mid(0))
  closed('Consent, closed', mid(-3), mid(-1), { consent: 'spawn:y' })
  // Waiting on the user: two created before the week ended, one after, one consent card, one on the agent.
  item(db, a.convo, 'question', 'Which plan?', { now: mid(-1) })
  item(db, a.convo, 'question', 'Ship it?', { now: mid(-4) })
  item(db, a.convo, 'question', 'Asked later', { now: mid(0) })
  item(db, a.convo, 'decision', 'Approve the spawn', { consent: 'spawn:x', awaiting: 'user', now: mid(-1) })
  item(db, a.convo, 'task', 'Agent work', { now: mid(-4) })
  // Two pictures and a document in the week, a picture the week after.
  blobRow(db, 'pic1'); attachAt(db, shown, 'pic1', mid(-1, 1))
  blobRow(db, 'vid1', 'video/mp4'); attachAt(db, shown, 'vid1', mid(-1, 2), 'video/mp4')
  attachAt(db, shown, 'doc1', mid(-1, 3), 'application/pdf')
  blobRow(db, 'pic2'); attachAt(db, shown, 'pic2', mid(0))
  const out = indexOf(db)
  assert.deepEqual(Object.keys(out), INDEX_KEYS)
  assert.equal(out.week, keyOf(-1)); assert.equal(out.start, weekOf(-1)); assert.equal(out.end, weekOf(0))
  assert.equal(out.final, true); assert.equal(out.current, false); assert.equal(out.written_at, null); assert.equal(out.stored, null)
  assert.equal(out.projects_total, 2); assert.equal(out.more_projects, 0)
  assert.deepEqual(out.projects.map((r) => Object.keys(r)), [ROW_KEYS, ROW_KEYS])
  const moved = weekRaw(db, 1, keyOf(-1), at).projects[0].moved
  assert.deepEqual(out.projects, [
    { id: a.p.id, num: a.p.num, title: 'Promo launch', moved, milestones: 3, done: 1, for_you: 2, media: 2, newest: 'step 2' },
    { id: b.p.id, num: b.p.num, title: 'Bravo', moved: 1, milestones: 1, done: 0, for_you: 0, media: 0, newest: 'b' },
  ])
  // The counts are the ones a week card shows for the same project.
  const card = cardOf(db, -1, a.p)
  assert.equal(out.projects[0].done, card.marks.done); assert.equal(out.projects[0].for_you, card.marks.for_you)
  // The current week: not final, and the items of this week.
  const now = indexOf(db, 0)
  assert.equal(now.current, true); assert.equal(now.final, false)
  assert.deepEqual(now.projects.map((r) => [r.title, r.milestones, r.done, r.for_you, r.media, r.newest]), [['Promo launch', 1, 1, 3, 1, 'after']])
  // A week nothing moved in, and a key that is not a week.
  assert.deepEqual({ ...indexOf(db, -6), start: 0, end: 0 }, {
    week: keyOf(-6), start: 0, end: 0, final: true, written_at: null, current: false, stored: null, projects_total: 0, projects: [], more_projects: 0,
  })
  assert.equal(weekIndex(db, 1, '2026-11-10', at), null)
})

test('weekIndex counts through the agent sieve: work in a private conversation is in no count, and is all there unsieved', () => {
  const db = seeded()
  const a = proj(db, 'Promo launch')
  db.prepare("UPDATE conversations SET mission_id = ? WHERE id = 'secret'").run(a.m.id)
  postAt(db, a.convo, 'public milestone', mid(-1))
  post(db, 'secret', 'private milestone', 9)
  db.prepare("UPDATE milestones SET created_at = ? WHERE title = 'private milestone'").run(mid(-1, 1))
  const pub = item(db, a.convo, 'question', 'Public ask', { now: mid(-1) })
  const priv = item(db, 'secret', 'question', 'Private ask', { now: mid(-1) })
  const done = item(db, 'secret', 'task', 'Private task', { now: mid(-3) })
  db.prepare("UPDATE items SET state='closed', awaiting=NULL, closed_at=? WHERE id=?").run(mid(-1), done.id)
  blobRow(db, 'b-pub'); attachAt(db, pub, 'b-pub', mid(-1))
  blobRow(db, 'b-sec'); attachAt(db, priv, 'b-sec', mid(-1, 1))
  const row = (o) => { const [r] = indexOf(db, -1, o).projects; return [r.milestones, r.done, r.for_you, r.media, r.newest] }
  assert.deepEqual(row({ excludePrivateOwned: true }), [1, 0, 1, 1, 'public milestone'])
  assert.deepEqual(row({}), [1, 0, 1, 1, 'public milestone']) // sieved unless told otherwise
  assert.deepEqual(row({ excludePrivateOwned: false }), [2, 1, 2, 2, 'private milestone'])
  // A project born on a private device is no row at all.
  const hidden = proj(db, 'Hidden'); postAt(db, hidden.convo, 'h', mid(-1))
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', hidden.p.id)
  assert.deepEqual(indexOf(db).projects.map((r) => r.title), ['Promo launch'])
  assert.equal(indexOf(db).projects_total, 1)
  assert.equal(indexOf(db, -1, { excludePrivateOwned: false }).projects_total, 2)
})

test('weekIndex ranks as the raw pages do, most moves first and ties by number, and credits a merged project to its survivor', () => {
  const db = seeded()
  const ps = crowd(db, 30)
  for (let i = 0; i < 3; i++) postAt(db, ps[20].convo, `more ${i}`, mid(-1, 1 + i))
  postAt(db, ps[7].convo, 'more', mid(-1, 1))
  const out = indexOf(db)
  assert.deepEqual(out.projects.slice(0, 3).map((r) => [r.title, r.moved]), [['P21', 4], ['P8', 2], ['P1', 1]])
  assert.deepEqual(out.projects.map((r) => r.id), rawPages(db).flatMap((page) => page.projects.map((x) => x.project.id)))
  assert.deepEqual(out.projects.map((r) => r.moved), rawPages(db).flatMap((page) => page.projects.map((x) => x.moved)))
  mergeProject(db, { userId: 1, projectId: ps[7].p.id, intoId: ps[0].p.id, by: 'user' })
  const merged = indexOf(db)
  assert.equal(merged.projects_total, 29)
  assert.deepEqual(merged.projects.slice(0, 2).map((r) => [r.title, r.moved, r.milestones, r.newest]), [['P21', 4, 4, 'more 2'], ['P1', 3, 3, 'more']])
})

test('weekIndex clips a title to 80 characters and the newest milestone to 100, ending with an ellipsis', () => {
  const db = seeded()
  crowd(db, 1, { title: () => `${'t'.repeat(78)}😀tail`, milestone: longStep })
  const [row] = indexOf(db).projects
  assert.equal(INDEX.titleMax, 80); assert.equal(INDEX.newestMax, 100)
  assert.equal(row.title, `${'t'.repeat(78)}…`) // never half of a pair
  assert.equal(row.newest.length, 100); assert.ok(row.newest.endsWith('…'))
})

test('weekIndex: 200 projects with long names fit in 36,000 characters with every project present', () => {
  const db = seeded()
  const ps = crowd(db, 200, { title: longTitle, milestone: longStep })
  const out = indexOf(db)
  assert.ok(sizeOf(out) <= RAW.maxChars, `${sizeOf(out)} characters`)
  assert.equal(out.projects.length, 200); assert.equal(out.projects_total, 200); assert.equal(out.more_projects, 0)
  assert.deepEqual(out.projects.map((r) => r.id), ps.map((x) => x.p.id))
  assert.ok(out.projects.every((r) => r.moved === 1 && r.milestones === 1))
})

test('weekIndex shrinks from the last-ranked project upward: the newest milestone first, then the title, then the project', () => {
  const db = seeded()
  const ps = crowd(db, 100, { title: longTitle, milestone: longStep })
  // The index of the first row that gave something up (the count when none did).
  const firstWhere = (rows, gaveUp) => { const i = rows.findIndex(gaveUp); return i < 0 ? rows.length : i }
  const check = (out, total) => {
    assert.ok(sizeOf(out) <= RAW.maxChars, `${total}: ${sizeOf(out)} characters`)
    assert.equal(out.projects_total, total); assert.equal(out.projects.length + out.more_projects, total)
    const rows = out.projects
    const bare = firstWhere(rows, (r) => r.newest === null)
    const short = firstWhere(rows, (r) => r.title.length <= INDEX.titleMin)
    // Each loss is a run at the end of the ranking, and a later step starts only when the one before is used up.
    assert.ok(rows.every((r, i) => (r.newest === null) === (i >= bare)), `${total}: newest`)
    assert.ok(rows.every((r, i) => r.title.length === (i >= short ? INDEX.titleMin : INDEX.titleMax)), `${total}: titles`)
    if (short < rows.length) assert.equal(bare, 0, `${total}: titles shrink only once no newest is left`)
    if (out.more_projects) assert.equal(short, 0, `${total}: projects go only once every title is short`)
    return { bare, short }
  }
  // 100: nothing lost.
  let s = check(indexOf(db), 100)
  assert.deepEqual(s, { bare: 100, short: 100 })
  // 130: the last-ranked lose their newest milestone, no title is cut.
  ps.push(...crowd(db, 30, { title: (i) => longTitle(100 + i), milestone: longStep }))
  s = check(indexOf(db), 130)
  assert.ok(s.bare > 0 && s.bare < 130, `bare from ${s.bare}`); assert.equal(s.short, 130)
  assert.equal(indexOf(db).more_projects, 0)
  // 200: every newest gone, some titles short, every project present.
  crowd(db, 70, { title: (i) => longTitle(130 + i), milestone: longStep })
  s = check(indexOf(db), 200)
  assert.equal(s.bare, 0); assert.ok(s.short > 0 && s.short < 200, `short from ${s.short}`)
  assert.equal(indexOf(db).more_projects, 0)
  // 600: within the bound, the last-ranked dropped and counted.
  crowd(db, 400, { title: (i) => longTitle(200 + i), milestone: longStep })
  const out = indexOf(db)
  check(out, 600)
  assert.ok(out.more_projects > 0 && out.projects.length >= 200, `${out.projects.length} kept`)
  assert.deepEqual(out.projects.map((r) => r.num), out.projects.map((r) => r.num).sort((x, y) => x - y)) // the first-ranked are the ones kept
  // One more project would not have fitted.
  const one = { ...out.projects.at(-1) }
  assert.ok(sizeOf({ ...out, projects: [...out.projects, one], more_projects: out.more_projects - 1 }) > RAW.maxChars)
})

test('weekIndex: 200 projects with ordinary names keep their titles whole', () => {
  const db = seeded()
  crowd(db, 200, { title: (i) => `Promo launch, phase ${i}`, milestone: (i) => `Shipped part ${i} of the launch` })
  const out = indexOf(db)
  assert.ok(sizeOf(out) <= RAW.maxChars)
  assert.equal(out.projects.length, 200)
  assert.ok(out.projects.every((r) => r.title.startsWith('Promo launch, phase ')))
})

test('weekIndex stored: each story as its main project and sentence, through a merge and the sieve; legacy as the raw read says it', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const b = proj(db, 'Bravo'); const c = proj(db, 'Charlie'); const long = proj(db, longTitle(4))
  for (const x of [a, b, c, long]) postAt(db, x.convo, 'm', mid(-1))
  assert.equal(indexOf(db).stored, null)
  putEntries(db, -1, { entries: [entry(b.p, { sentence: 'Bravo shipped.' }), entry(a.p, { sentence: 'Alpha moved.' }), entry(c.p), entry(long.p)] })
  const out = indexOf(db)
  assert.equal(out.written_at, NOW)
  assert.deepEqual(Object.keys(out.stored), ['final', 'legacy', 'entries'])
  assert.equal(out.stored.final, false); assert.equal(out.stored.legacy, false)
  assert.deepEqual(out.stored.entries.slice(0, 3), [
    { project: ref(b.p), sentence: 'Bravo shipped.' }, { project: ref(a.p), sentence: 'Alpha moved.' }, { project: ref(c.p), sentence: 'It shipped.' },
  ])
  assert.equal(out.stored.entries[3].project.title.length, 80)
  // A project merged after the write reads as its survivor; one turned private drops its entry for an agent.
  mergeProject(db, { userId: 1, projectId: b.p.id, intoId: a.p.id, by: 'user' })
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', c.p.id)
  assert.deepEqual(indexOf(db).stored.entries.slice(0, 2), [{ project: ref(a.p), sentence: 'Bravo shipped.' }, { project: ref(a.p), sentence: 'Alpha moved.' }])
  assert.equal(indexOf(db).stored.entries.length, 3)
  assert.equal(indexOf(db, -1, { excludePrivateOwned: false }).stored.entries.length, 4)
  // Grouped stories: the first project of each, and legacy.
  put(db, -1, { lede: 'Lede.', stories: [tale({ title: 'T', sentence: 'Both moved.', project_ids: [long.p.id, a.p.id] })], final: true })
  const grouped = indexOf(db).stored
  assert.equal(grouped.final, true); assert.equal(grouped.legacy, true)
  assert.equal(grouped.legacy, weekRaw(db, 1, keyOf(-1), at).stored.legacy)
  assert.deepEqual(grouped.entries.map((e) => [e.project.id, e.sentence]), [[long.p.id, 'Both moved.']])
})

// Every statement run through `db` while `read` runs.
function statementsOf(db, read) {
  const prepare = db.prepare.bind(db)
  let runs = 0
  const counted = (st) => new Proxy(st, {
    get: (target, key) => {
      const v = target[key]
      if (typeof v !== 'function') return v
      if (key === 'pluck' || key === 'raw' || key === 'expand') return (...a) => counted(v.apply(target, a))
      if (key === 'get' || key === 'all' || key === 'run' || key === 'iterate') return (...a) => { runs += 1; return v.apply(target, a) }
      return v.bind(target)
    },
  })
  db.prepare = (sql) => counted(prepare(sql))
  try { read() } finally { db.prepare = prepare }
  return runs
}

test('weekIndex runs the same few statements for 3 projects as for 150', () => {
  const db = seeded()
  const ps = crowd(db, 3)
  putEntries(db, -1, { entries: [entry(ps[0].p)] })
  const few = statementsOf(db, () => indexOf(db))
  assert.ok(few >= 5 && few <= 8, `${few} statements`)
  crowd(db, 147)
  let out
  const many = statementsOf(db, () => { out = indexOf(db) })
  assert.equal(out.projects.length, 150)
  assert.equal(many, few)
  // The raw page, by contrast, reads each of its projects in turn.
  assert.ok(statementsOf(db, () => weekRaw(db, 1, keyOf(-1), at)) > many)
})

test("the week index's grouped counts start from the user's missions and reach items through their mission, never through the consent index", () => {
  const db = seeded()
  proj(db, 'Billing')
  for (const sieved of [false, true]) {
    const sql = indexSqlForTest(sieved)
    assert.deepEqual(Object.keys(sql), ['milestones', 'items', 'media'])
    const planOf = (name) => db.prepare(`EXPLAIN QUERY PLAN ${sql[name]}`).all({ userId: 1, start: weekOf(-1), end: weekOf(0) }).map((r) => r.detail).join('\n')
    const count = (text, re) => (text.match(re) ?? []).length
    const fromMissions = /SEARCH m USING INDEX idx_missions_user_state \(user_id=\?/g
    for (const name of Object.keys(sql)) {
      const text = planOf(name)
      const what = `${name}, sieved ${sieved}`
      assert.doesNotMatch(text, /idx_items_consent/, what)
      assert.doesNotMatch(text, /SCAN (m|i|l|ic|p|e|c)\b/, what)
      assert.equal(count(text, fromMissions), name === 'media' ? 2 : 1, what)
    }
    // The week's milestones of each mission, by their date.
    assert.match(planOf('milestones'), /SEARCH l USING INDEX idx_milestones_mission \(mission_id=\? AND created_at>\? AND created_at<\?/, `sieved ${sieved}`)
    assert.match(planOf('items'), /SEARCH i USING INDEX idx_items_mission \(mission_id=\?/, `sieved ${sieved}`)
    // Pictures: the week's comments of each mission's items, and the media events of its conversations.
    assert.match(planOf('media'), /SEARCH i USING INDEX idx_items_mission \(mission_id=\?/, `sieved ${sieved}`)
    assert.match(planOf('media'), /SEARCH ic USING INDEX idx_item_comments_item \(item_id=\? AND created_at>\? AND created_at<\?/, `sieved ${sieved}`)
    assert.match(planOf('media'), /SEARCH e USING INDEX idx_events_media \(convo_id=\?/, `sieved ${sieved}`)
  }
})

test('weekIndex counts a picture posted in a conversation of two projects once for each', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const b = proj(db, 'Bravo')
  postAt(db, a.convo, 'a', mid(-1)); postAt(db, b.convo, 'b', mid(-1))
  db.prepare("INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at) VALUES(?,?,1,'joined',?)").run(b.m.id, a.convo, mid(-20))
  db.prepare('UPDATE mission_conversations SET joined_at = ?, first_joined_at = NULL').run(mid(-20))
  blobRow(db, 'shot')
  const e = append(db, { userId: 1, convoId: a.convo, sender: 'agent:x', type: 'image', payload: { blob_ref: 'shot', name: 'shot.png', content_type: 'image/png', size: 4 }, blobRef: 'shot' })
  db.prepare('UPDATE events SET ts = ? WHERE seq = ?').run(mid(-1), e.seq)
  const media = Object.fromEntries(indexOf(db).projects.map((r) => [r.title, r.media]))
  assert.deepEqual(media, { Alpha: 1, Bravo: 1 })
  const raw = Object.fromEntries(weekRaw(db, 1, keyOf(-1), at).projects.map((x) => [x.project.title, x.media.length]))
  assert.deepEqual(raw, media)
})

// ---- The raw read of named projects ----

const pickedOf = (db, picked, o = {}) => weekRaw(db, 1, keyOf(-1), { ...at, picked, ...o })

test('weekRaw picked: exactly the named projects in the order given, by id and by number, each once, with the page shape of each', () => {
  const db = seeded()
  const ps = crowd(db, 30)
  for (let i = 0; i < 2; i++) postAt(db, ps[9].convo, `more ${i}`, mid(-1, 1 + i))
  put(db, -1, { lede: 'Lede.', stories: [tale({ project_ids: [ps[0].p.id] })] })
  const out = pickedOf(db, [ps[25].p.id, String(ps[9].p.num), ps[2].p.num, ps[25].p.num, `${ps[2].p.id}`])
  assert.deepEqual(Object.keys(out), [...RAW_KEYS, 'omitted'])
  assert.deepEqual(out.projects.map((x) => x.project), [ref(ps[25].p), ref(ps[9].p), ref(ps[2].p)])
  assert.deepEqual(out.projects.map((x) => x.moved), [1, 3, 1])
  assert.equal(out.projects_total, 30); assert.equal(out.offset, 0); assert.equal(out.next_offset, null); assert.equal(out.more_projects, 0)
  assert.deepEqual(out.omitted, [])
  assert.equal(out.stored.lede, 'Lede.'); assert.equal(out.written_at, NOW)
  // Each project is what its row on a page is.
  const pages = rawPages(db).flatMap((page) => page.projects)
  for (const x of out.projects) assert.deepEqual(x, pages.find((y) => y.project.id === x.project.id))
  assert.deepEqual(out.projects[1].milestones.map((m) => m.title), ['more 1', 'more 0', 'm'])
  // The page read is as it was.
  assert.deepEqual(Object.keys(weekRaw(db, 1, keyOf(-1), at)), RAW_KEYS)
  assert.equal(pickedOf(db, [ps[0].p.id], {}).projects.length, 1)
  assert.equal(weekRaw(db, 1, '2026-11-10', { ...at, picked: [ps[0].p.id] }), null)
})

test('weekRaw picked: a merged project reads as its survivor, unknown and hidden ones are left out, a project that did not move comes with moved 0', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const gone = proj(db, 'Gone'); const hidden = proj(db, 'Hidden'); const still = proj(db, 'Still')
  for (const x of [a, gone, hidden]) postAt(db, x.convo, 'm', mid(-1))
  postAt(db, still.convo, 'long ago', mid(-4))
  item(db, still.convo, 'question', 'Still waiting?', { now: mid(-4) })
  mergeProject(db, { userId: 1, projectId: gone.p.id, intoId: a.p.id, by: 'user' })
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', hidden.p.id)
  const out = pickedOf(db, [gone.p.num, 'pj_nope', 999, hidden.p.id, hidden.p.num, still.p.id, a.p.id])
  // The merged one stands where it was named; its survivor, named again later, is not repeated.
  assert.deepEqual(out.projects.map((x) => [x.project.title, x.moved]), [['Alpha', 2], ['Still', 0]])
  assert.equal(out.projects_total, 1)
  assert.deepEqual(out.projects[1].milestones, []); assert.deepEqual(out.projects[1].items, [])
  assert.deepEqual(out.projects[1].needs_you.map((n) => n.title), ['Still waiting?'])
  // Without the sieve the hidden one is there.
  assert.deepEqual(pickedOf(db, [hidden.p.id, a.p.id], { excludePrivateOwned: false }).projects.map((x) => x.project.title), ['Hidden', 'Alpha'])
  // Nothing the caller may see: no projects, the week as it is.
  const none = pickedOf(db, [hidden.p.id, 'pj_nope'])
  assert.deepEqual(none.projects, []); assert.equal(none.projects_total, 1); assert.deepEqual(none.omitted, [])
})

test('weekRaw picked: twelve heavy projects stay within 36,000 characters; the ones dropped from the end are named in omitted', () => {
  const db = seeded()
  const ps = []
  for (let n = 1; n <= 12; n++) ps.push(heavy(db, n))
  const ids = ps.map((x) => x.p.id).reverse()
  const out = pickedOf(db, ids)
  assert.ok(sizeOf(out) <= RAW.maxChars, `${sizeOf(out)} characters`)
  assert.ok(out.projects.length >= 1 && out.projects.length < 12, `${out.projects.length} projects`)
  assert.deepEqual(out.projects.map((x) => x.project.id), ids.slice(0, out.projects.length))
  assert.deepEqual(out.omitted, ids.slice(out.projects.length))
  assert.equal(out.more_projects, 0); assert.equal(out.next_offset, null); assert.equal(out.projects_total, 12)
  // The caps and clipping of a page.
  const [first] = out.projects
  assert.equal(first.milestones.length, 6); assert.equal(first.items.length, 6); assert.equal(first.needs_you.length, 5); assert.equal(first.media.length, 3)
  assert.equal(first.status.length, 300); assert.equal(first.milestones[0].title.length, 140)
  // Asking again for what was left out reaches every project.
  const seen = out.projects.map((x) => x.project.id)
  for (let left = out.omitted; left.length;) {
    const more = pickedOf(db, left)
    assert.ok(more.projects.length >= 1)
    seen.push(...more.projects.map((x) => x.project.id))
    left = more.omitted
  }
  assert.deepEqual(seen, ids)
})
