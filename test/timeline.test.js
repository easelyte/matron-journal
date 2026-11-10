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
import { writeWeek } from '../src/week-stories.js'
import {
  weekRaw, projectMoves, projectWeeklyMoves, weeksList, weekDetail, wentQuiet, openLong, finished, cronRunsForTest,
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
    stories: [tale({ title: 'Both', project_ids: [b.p.id, a.p.id] }), tale({ title: 'Only private', project_ids: [b.p.id] })],
  })
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', b.p.id)
  const agent = weekDetail(db, 1, keyOf(-1), { ...at, excludePrivateOwned: true })
  assert.deepEqual(agent.stories.map((s) => s.title), ['Both'])
  assert.deepEqual(agent.stories[0].projects, [ref(a.p)])
  const client = weekDetail(db, 1, keyOf(-1), at)
  assert.deepEqual(client.stories.map((s) => s.title), ['Both', 'Only private'])
  assert.deepEqual(client.stories[0].projects, [ref(b.p), ref(a.p)])
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
      tale({ title: 'Deleted blob', project_ids: [a.p.id], media_blob_id: 'b-stored' }),
      tale({ title: 'None', project_ids: [bare.p.id] }),
    ],
  })
  const stories = () => weekDetail(db, 1, keyOf(-1), at).stories
  assert.deepEqual(stories()[0].media, { blob_id: 'b-stored', content_type: 'image/png', name: 'b-stored.png' })
  assert.equal(stories()[2].media, null)
  db.prepare("DELETE FROM blobs WHERE id = 'b-stored'").run()
  assert.deepEqual(stories()[0].media, { blob_id: 'b-week', content_type: 'image/png', name: 'b-week.png' })
  assert.deepEqual(stories()[1].media, stories()[0].media)
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
  assert.deepEqual(Object.keys(raw), ['week', 'start', 'end', 'final', 'written_at', 'current', 'stored', 'projects', 'more_projects'])
  assert.equal(raw.week, keyOf(-1)); assert.equal(raw.final, true); assert.equal(raw.current, false)
  assert.equal(raw.written_at, NOW); assert.equal(raw.more_projects, 0)
  assert.equal(weekRaw(db, 1, keyOf(0), at).current, true)
  assert.deepEqual(raw.projects.map((p) => p.project.title), ['Alpha', 'Bravo'])
  const alpha = raw.projects[0]
  assert.equal(alpha.status, 'On track'); assert.equal(raw.projects[1].status, null)
  assert.ok(alpha.moved > 12)
  assert.equal(alpha.milestones.length, 10)
  assert.deepEqual(alpha.milestones[0], { title: 'step 11', kind: 'progress', at: mid(-1, 11) })
  assert.ok(alpha.milestones.every((m, i, all) => i === 0 || all[i - 1].at >= m.at))
  assert.equal(alpha.items.length, 10)
  assert.deepEqual(Object.keys(alpha.items[0]), ['id', 'num', 'title', 'kind', 'state', 'awaiting', 'at'])
  assert.equal(alpha.items[0].id, items[0].id) // newest activity: the attachment comments
  assert.equal(alpha.media.length, 5)
  assert.deepEqual(alpha.media[0], { blob_id: 'b6', content_type: 'image/png', name: 'b6.png', at: mid(-1, 6) })
  assert.deepEqual(raw.stored, {
    lede: 'Lede.', final: false,
    stories: [{
      title: 'T', sentence: 'It shipped.', next: null, projects: [ref(b.p), ref(a.p)],
      items: [{ id: items[0].id, num: items[0].num, title: 'Item 0' }], media_blob_id: 'b3',
    }],
  })
  assert.equal(weekRaw(db, 1, '2026-11-10', at), null)
})

test('weekRaw caps the moving projects at 40 and counts the rest; applies the agent sieve; drops refs that no longer resolve', () => {
  const db = seeded()
  const ps = []
  for (let i = 1; i <= 43; i++) { const x = proj(db, `P${i}`); postAt(db, x.convo, 'm', mid(-1)); ps.push(x) }
  const raw = weekRaw(db, 1, keyOf(-1), at)
  assert.equal(raw.projects.length, 40); assert.equal(raw.more_projects, 3)
  const a = ps[0]
  const it = item(db, a.convo, 'task', 'Gone soon')
  put(db, -1, { lede: 'x', stories: [tale({ project_ids: [a.p.id], item_ids: [it.id] })] })
  db.prepare('DELETE FROM items WHERE id = ?').run(it.id)
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', ps[1].p.id)
  const out = weekRaw(db, 1, keyOf(-1), at)
  assert.deepEqual(out.stored.stories[0].items, [])
  assert.equal(out.projects.some((p) => p.project.id === ps[1].p.id), false)
  assert.equal(out.projects.length, 40); assert.equal(out.more_projects, 2)
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

test('weekRaw lists, per project, every item still waiting on the user, whatever the week\'s activity; newest first, capped at 10', () => {
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
  // Capped at 10.
  for (let i = 0; i < 12; i++) item(db, a.convo, 'question', `Q${i}`, { awaiting: 'user', now: mid(-3, i) })
  assert.equal(weekRaw(db, 1, keyOf(-1), at).projects.find((x) => x.project.id === a.p.id).needs_you.length, 10)
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
