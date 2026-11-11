import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { upsertConversation, append } from '../src/journal.js'
import { createItem, addComment, closeItem } from '../src/items.js'
import { createMission, closeMission, createMilestone } from '../src/missions.js'
import { createProject, mergeProject, updateProject, resolveProject } from '../src/projects.js'
import { writeWeek } from '../src/week-stories.js'
import { weekStartOf, formatWeekKey, projectMoveTimes, movesSqlForTest, liveMedia, IN_PROJECT } from '../src/timeline.js'
import { projectFeed, filesSqlForTest, milestonesSqlForTest } from '../src/projects-feed.js'
import { projectPage, projectHistory, PROJECT_PAGE, PROJECT_HISTORY } from '../src/timeline-project.js'

// ---- fixtures: alice (user 1) with an ordinary box (7), a client (8) and a
// private box (9, the `secret` conversation) ----

const LON = 'Europe/London'
const DAY = 86400e3
const NOW = Date.UTC(2026, 10, 11, 12) // Wed 11 Nov 2026, week of Mon 9 Nov
const W0 = weekStartOf(NOW, LON)
// Week n relative to the current one (0 = this week, -1 = last week): its
// start, a Wednesday-noon instant inside it, and its key.
const weekOf = (n) => weekStartOf(W0 + n * 7 * DAY + 2 * DAY, LON)
const mid = (n, hours = 0) => weekOf(n) + 2 * DAY + 12 * 3600e3 + hours * 3600e3
const keyOf = (n) => formatWeekKey(weekOf(n), LON)
const at = { now: NOW }
const sieved = { now: NOW, excludePrivateOwned: true }

function seeded() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'alice','x',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','box-2','h',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(8,1,'client','mac','h3',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(9,1,'agent','priv-box','h2',0,1)").run()
  upsertConversation(db, { id: 'secret', ownerUserId: 1, title: 'S', agentDeviceId: 9 })
  return db
}
// A mission in its own conversation on the project, created at `createdAt`
// (a mission's creation is itself a move).
function missionOn(db, p, title, createdAt) {
  const convo = `k${db.prepare('SELECT COUNT(*) AS n FROM missions').get().n + 1}`
  upsertConversation(db, { id: convo, ownerUserId: 1, title: convo, agentDeviceId: 7 })
  const { mission: m } = createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: convo, title, projectId: p.id })
  db.prepare('UPDATE missions SET created_at=?, updated_at=? WHERE id=?').run(createdAt, createdAt, m.id)
  return { m, convo }
}
// A project with one mission, both created at `createdAt`.
function proj(db, title, { createdAt = mid(-20) } = {}) {
  const p = createProject(db, { userId: 1, deviceId: 7, createdBy: 'agent', title }).project
  db.prepare('UPDATE projects SET created_at=?, updated_at=? WHERE id=?').run(createdAt, createdAt, p.id)
  return { p, ...missionOn(db, p, title, createdAt) }
}
// A mission born on the private box, on the project.
function privateMission(db, p, createdAt) {
  const { mission: m } = createMission(db, { userId: 1, deviceId: 9, createdBy: 'agent', convoId: 'secret', title: 'quiet work', projectId: p.id })
  db.prepare('UPDATE missions SET created_at=?, updated_at=? WHERE id=?').run(createdAt, createdAt, m.id)
  return m
}
const postAt = (db, convoId, title, ts) => {
  const { milestone } = createMilestone(db, {
    userId: 1, deviceId: convoId === 'secret' ? 9 : 7, createdBy: 'agent', convoId, kind: 'progress', title,
    appendMarker: (payload) => append(db, { userId: 1, convoId, sender: 'agent:x', type: 'milestone', payload }),
  })
  db.prepare('UPDATE milestones SET created_at=? WHERE id=?').run(ts, milestone.id)
  return milestone
}
const closeAt = (db, m, ts) => {
  closeMission(db, { userId: 1, missionId: m.id, by: 'user', summary: 'done' })
  db.prepare('UPDATE missions SET closed_at=?, updated_at=? WHERE id=?').run(ts, ts, m.id)
}
const item = (db, convoId, kind, title, extra = {}) => createItem(db, {
  userId: 1, originDeviceId: convoId === 'secret' ? 9 : 7, createdBy: 'agent', kind, title, originConvoId: convoId, ...extra,
}).item
const blobRow = (db, id, mime = 'image/png') =>
  db.prepare("INSERT INTO blobs(id, owner_user_id, content_type, size, sha256, disk_path, created_at) VALUES(?,1,?,4,'s','p',0)").run(id, mime)
// A file on a comment of the item, posted at `ts`.
const attachAt = (db, it, blobId, ts, mime = 'image/png') => {
  blobRow(db, blobId, mime)
  return addComment(db, {
    userId: 1, itemId: it.id, author: 'agent', deviceId: 7, attachments: [{ blob_ref: blobId, mime, name: `${blobId}.png`, size: 4 }], now: ts,
  })
}
// A story as the Coordinator writes it (project_ids etc. are references).
const tale = (over = {}) => ({ title: 'Launch', sentence: 'It shipped.', next: null, project_ids: [], item_ids: [], media_blob_id: null, ...over })
const put = (db, n, stories, o = {}) => {
  const r = writeWeek(db, 1, keyOf(n), { lede: null, stories, final: false, notes: [] }, { now: NOW, excludePrivateOwned: false, ...o })
  assert.equal(r.ok, true, JSON.stringify(r))
}
const pic = (id) => ({ blob_id: id, content_type: 'image/png', name: `${id}.png` })
const page = (db, p, o = at) => projectPage(db, 1, resolveProject(db, 1, p.id, o).project, o)
// How many statements `fn` runs: every get, all, run or iterate of a prepared
// statement, so one prepared once and run per row counts per row.
function statementsRun(db, fn) {
  let n = 0
  const prepare = db.prepare.bind(db)
  const counted = (stmt) => new Proxy(stmt, {
    get(target, key) {
      const value = target[key]
      if (typeof value !== 'function') return value
      return (...a) => {
        if (['get', 'all', 'run', 'iterate'].includes(key)) n += 1
        const out = value.apply(target, a)
        return out === target ? counted(target) : out
      }
    },
  })
  db.prepare = (sql) => counted(prepare(sql))
  try { fn() } finally { db.prepare = prepare }
  return n
}
// The SQL of every statement `fn` prepares.
function prepared(db, fn) {
  const out = []
  const prepare = db.prepare.bind(db)
  db.prepare = (sql) => { out.push(sql); return prepare(sql) }
  try { fn() } finally { db.prepare = prepare }
  return out
}
const planOf = (db, sql, args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(args).map((r) => r.detail).join('\n')

// ---- the project's moves ----

// The whole-user moves credited to the project, newest first.
const userMoves = (db, p, sieve) => db.prepare(`SELECT at FROM (${movesSqlForTest.user(sieve)}) WHERE project_id = @projectId ORDER BY at DESC`)
  .pluck().all({ userId: 1, projectId: p.id })

test("projectMoveTimes: a project's moves read through its missions are the whole-user moves credited to it, sieved and not, through a merge", () => {
  const db = seeded()
  const a = proj(db, 'Survivor', { createdAt: mid(-9) }); const gone = proj(db, 'Gone', { createdAt: mid(-12) })
  const other = proj(db, 'Other', { createdAt: mid(-11) })
  // One of every kind of move on the survivor, on the project merged into it,
  // on the private box, and on a project that must not be counted.
  for (const [convo, base] of [[a.convo, -8], [gone.convo, -10], [other.convo, -7]]) {
    postAt(db, convo, 'A step', mid(base))
    const it = item(db, convo, 'task', 'A task', { now: mid(base, 1) })
    addComment(db, { userId: 1, itemId: it.id, author: 'agent', deviceId: 7, body: 'Seen', now: mid(base, 2) })
    addComment(db, { userId: 1, itemId: it.id, author: 'agent', deviceId: 9, body: 'From the private box', now: mid(base, 3) })
    closeItem(db, { userId: 1, itemId: it.id, resolution: 'done', author: 'agent', deviceId: 7, now: mid(base, 4) })
    item(db, convo, 'question', 'Approve the spawn', { now: mid(base, 5), consent: `spawn:${convo}`, awaiting: 'user' })
  }
  const closing = missionOn(db, a.p, 'Short work', mid(-6)); closeAt(db, closing.m, mid(-5))
  const hidden = privateMission(db, a.p, mid(-4))
  postAt(db, 'secret', 'Private step', mid(-3))
  item(db, 'secret', 'task', 'Private task', { now: mid(-3, 1) })
  closeAt(db, hidden, mid(-2))
  mergeProject(db, { userId: 1, projectId: gone.p.id, intoId: a.p.id, by: 'user' })
  for (const sieve of [false, true]) {
    const mine = projectMoveTimes(db, 1, a.p.id, { excludePrivateOwned: sieve })
    assert.deepEqual(mine, userMoves(db, a.p, sieve), `sieved ${sieve}`)
    assert.deepEqual(projectMoveTimes(db, 1, other.p.id, { excludePrivateOwned: sieve }), userMoves(db, other.p, sieve), `other, sieved ${sieve}`)
  }
  const all = projectMoveTimes(db, 1, a.p.id); const seen = projectMoveTimes(db, 1, a.p.id, { excludePrivateOwned: true })
  // Survivor and merged project: a mission created, a milestone, an item
  // created and closed, two comments (the close writes none), the consent
  // card left out; plus the short mission (2) and the private one (created,
  // closed, a milestone, an item).
  assert.equal(all.length, 2 * 6 + 2 + 4)
  assert.ok(all.includes(mid(-10)), 'a move made on the project merged into it')
  assert.ok(all.includes(mid(-3)) && !seen.includes(mid(-3)), 'the private milestone is sieved')
  // The sieve drops the private mission's moves and each private-box comment.
  assert.equal(seen.length, all.length - 4 - 2)
})

test("a project's moves are reached through its missions, never through the consent index or every mission of the user", () => {
  const db = seeded()
  const a = proj(db, 'Billing')
  for (const sieve of [false, true]) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${movesSqlForTest.project(sieve)}`).all({ userId: 1, projectId: a.p.id })
    const text = plan.map((r) => r.detail).join('\n')
    const count = (re) => (text.match(re) ?? []).length
    assert.doesNotMatch(text, /idx_items_consent/, `sieved ${sieve}`)
    assert.doesNotMatch(text, /idx_missions_user_state/, `sieved ${sieve}`)
    assert.doesNotMatch(text, /SCAN (m|i|l|ic|q)\b/, `sieved ${sieve}`)
    // Each arm finds the projects merged into this one among the user's own.
    assert.equal(count(/SEARCH q USING INDEX idx_projects_user_state \(user_id=\?/g), 6, `sieved ${sieve}`)
    // Six arms, each from the project's missions; three of them go on to the
    // missions' items, one to their milestones, one to the items' comments.
    assert.equal(count(/SEARCH m USING INDEX idx_missions_project \(project_id=\?/g), 6, `sieved ${sieve}`)
    assert.equal(count(/SEARCH i USING INDEX idx_items_mission \(mission_id=\?/g), 3, `sieved ${sieve}`)
    assert.equal(count(/SEARCH l USING INDEX idx_milestones_mission \(mission_id=\?/g), 1, `sieved ${sieve}`)
    assert.equal(count(/SEARCH ic USING INDEX idx_item_comments_item \(item_id=\?/g), 1, `sieved ${sieve}`)
  }
})

test("the moves of every project are reached through the user's missions, never through the consent index", () => {
  const db = seeded()
  for (const sieve of [false, true]) {
    const inner = movesSqlForTest.user(sieve)
    // As written, and as the reads use it: the newest move per project, and
    // the moves of a span of weeks.
    for (const [name, sql, args] of [
      ['plain', inner, {}],
      ['newest', `SELECT project_id, MAX(at) AS at FROM (${inner}) GROUP BY project_id`, {}],
      ['span', `SELECT project_id, COUNT(*) AS n FROM (${inner}) WHERE at >= @from AND at < @to GROUP BY project_id`, { from: 0, to: 1 }],
    ]) {
      const text = planOf(db, sql, { userId: 1, ...args })
      const count = (re) => (text.match(re) ?? []).length
      const what = `${name}, sieved ${sieve}`
      assert.doesNotMatch(text, /idx_items_consent/, what)
      assert.doesNotMatch(text, /SCAN (m|i|l|ic|p)\b/, what)
      // Six arms, each from the user's missions; three of them go on to the
      // missions' items, one to their milestones, one to the items' comments.
      assert.equal(count(/SEARCH m USING INDEX idx_missions_user_state \(user_id=\?/g), 6, what)
      assert.equal(count(/SEARCH i USING INDEX idx_items_mission \(mission_id=\?/g), 3, what)
      assert.equal(count(/SEARCH l USING INDEX idx_milestones_mission \(mission_id=\?/g), 1, what)
      assert.equal(count(/SEARCH ic USING INDEX idx_item_comments_item \(item_id=\?/g), 1, what)
    }
  }
})

// ---- projectPage ----

test('projectPage: a bare project, in full', () => {
  const db = seeded()
  const a = proj(db, 'Promo launch')
  assert.deepEqual(page(db, a.p), {
    project: { id: a.p.id, num: a.p.num, title: 'Promo launch', state: 'open', live: true },
    sentence: null, sentence_source: null, next: null,
    needs_you: [], needs_you_total: 0, media: null,
    counts: { weeks: 1, missions_open: 1, missions_done: 0, files: 0 },
  })
})

test('projectPage sentence: the status, else the newest milestone title, else null', () => {
  const db = seeded()
  const a = proj(db, 'Promo launch')
  const read = () => { const { sentence, sentence_source: source } = page(db, a.p); return [sentence, source] }
  assert.deepEqual(read(), [null, null])
  postAt(db, a.convo, 'Drafted the page', mid(-2))
  postAt(db, a.convo, 'Page is live', mid(-1))
  postAt(db, a.convo, 'An older step', mid(-3))
  assert.deepEqual(read(), ['Page is live', 'milestone'])
  updateProject(db, { userId: 1, projectId: a.p.id, fields: { status: 'Waiting on the last screenshots.' }, statusWriter: { by: 'agent', deviceId: 7, convoId: null } })
  assert.deepEqual(read(), ['Waiting on the last screenshots.', 'status'])
})

test('projectPage sentence under the agent sieve: a status from the private box and a private milestone are not read', () => {
  const db = seeded()
  const a = proj(db, 'Promo launch')
  privateMission(db, a.p, mid(-20))
  postAt(db, a.convo, 'Public step', mid(-2))
  postAt(db, 'secret', 'Private step', mid(-1))
  updateProject(db, { userId: 1, projectId: a.p.id, fields: { status: 'Secret plans' }, statusWriter: { by: 'agent', deviceId: 9, convoId: null } })
  assert.equal(page(db, a.p).sentence, 'Secret plans')
  const agent = page(db, a.p, sieved)
  assert.equal(agent.sentence, 'Public step'); assert.equal(agent.sentence_source, 'milestone')
})

test('projectPage next: from the newest stored week whose story has the project as its main project; null when that story has none', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const b = proj(db, 'Bravo')
  const next = () => page(db, a.p).next
  assert.equal(next(), null)
  put(db, -3, [tale({ project_ids: [a.p.id], next: 'Old plan' })])
  put(db, -2, [tale({ project_ids: [a.p.id], next: 'Docs' })])
  assert.equal(next(), 'Docs')
  // A newer week that does not name it, or names it behind another project, changes nothing.
  put(db, -1, [tale({ project_ids: [b.p.id, a.p.id], next: 'Not ours' })])
  assert.equal(next(), 'Docs')
  assert.equal(page(db, b.p).next, 'Not ours')
  // A newer week that names it without a next: nothing comes next.
  put(db, -1, [tale({ project_ids: [a.p.id] }), tale({ project_ids: [a.p.id, b.p.id], next: 'The second story loses' })])
  assert.equal(next(), null)
})

test('projectPage next follows a merge: a week written about a project merged into this one counts', () => {
  const db = seeded()
  const a = proj(db, 'Survivor'); const gone = proj(db, 'Gone')
  put(db, -1, [tale({ project_ids: [gone.p.id], next: 'Carry on' })])
  assert.equal(page(db, a.p).next, null)
  mergeProject(db, { userId: 1, projectId: gone.p.id, intoId: a.p.id, by: 'user' })
  assert.equal(page(db, a.p).next, 'Carry on')
})

test('projectPage needs_you: open items awaiting the user, newest first, at most 10 with the full count; consent cards left out', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const other = proj(db, 'Other')
  const made = []
  for (let i = 0; i < 12; i++) made.push(item(db, a.convo, 'question', `Q${i}`, { now: mid(-1, i) }))
  item(db, a.convo, 'question', 'Approve the spawn', { now: mid(0), consent: 'spawn:x', awaiting: 'user' })
  item(db, a.convo, 'task', 'Agent work', { now: mid(0) })
  item(db, other.convo, 'question', 'Elsewhere', { now: mid(0) })
  const out = page(db, a.p)
  assert.equal(out.needs_you_total, 12)
  assert.equal(PROJECT_PAGE.needsYou, 10)
  assert.deepEqual(out.needs_you, made.slice(2).reverse().map((it) => ({ id: it.id, num: it.num, title: it.title })))
})

test('projectPage media: the stored pick when it is newer than the newest file, the file when the file is newer', () => {
  const db = seeded()
  const a = proj(db, 'Site')
  const it = item(db, a.convo, 'task', 'Screens', { now: mid(-6) })
  assert.equal(page(db, a.p).media, null)
  attachAt(db, it, 'b-pick', mid(-5))
  attachAt(db, it, 'b-doc', mid(-2), 'application/pdf')
  attachAt(db, it, 'b-old', mid(-3))
  // No stored week: the newest picture, never the newer document.
  assert.deepEqual(page(db, a.p).media, pic('b-old'))
  // Last week's pick dates from the end of that week, after the newest file.
  put(db, -1, [tale({ project_ids: [a.p.id], media_blob_id: 'b-pick' })])
  assert.deepEqual(page(db, a.p).media, pic('b-pick'))
  // A file posted since is newer.
  attachAt(db, it, 'b-new', weekOf(0) + 3600e3)
  assert.deepEqual(page(db, a.p).media, pic('b-new'))
})

test('projectPage media: a pick in the week still running dates from when it was written', () => {
  const db = seeded()
  const a = proj(db, 'Site')
  const it = item(db, a.convo, 'task', 'Screens', { now: mid(-6) })
  attachAt(db, it, 'b-pick', mid(-5))
  put(db, 0, [tale({ project_ids: [a.p.id], media_blob_id: 'b-pick' })], { now: NOW - DAY })
  assert.deepEqual(page(db, a.p).media, pic('b-pick'))
  attachAt(db, it, 'b-after', NOW - 3600e3)
  assert.deepEqual(page(db, a.p).media, pic('b-after'))
})

test('projectPage media: a pick whose blob is gone falls back to an older pick that resolves, then to the roll-up', () => {
  const db = seeded()
  const a = proj(db, 'Site')
  const it = item(db, a.convo, 'task', 'Screens', { now: mid(-6) })
  attachAt(db, it, 'b-first', mid(-6))
  attachAt(db, it, 'b-second', mid(-5))
  attachAt(db, it, 'b-file', mid(-4))
  put(db, -2, [tale({ project_ids: [a.p.id], media_blob_id: 'b-first' })])
  put(db, -1, [tale({ project_ids: [a.p.id], media_blob_id: 'b-second' })])
  assert.deepEqual(page(db, a.p).media, pic('b-second'))
  db.prepare("DELETE FROM blobs WHERE id = 'b-second'").run()
  assert.deepEqual(page(db, a.p).media, pic('b-first'))
  db.prepare("DELETE FROM blobs WHERE id = 'b-first'").run()
  assert.deepEqual(page(db, a.p).media, pic('b-file'))
})

test('projectPage counts: open and closed missions, files, and the local weeks the project moved in', () => {
  const db = seeded()
  const a = proj(db, 'Alpha', { createdAt: mid(-3) })
  missionOn(db, a.p, 'two', mid(-3, 1))
  const third = missionOn(db, a.p, 'three', mid(-3, 2))
  closeAt(db, third.m, mid(-1))
  const it = item(db, a.convo, 'task', 'Screens', { now: mid(-1, 1) })
  attachAt(db, it, 'b1', mid(-1, 2)); attachAt(db, it, 'b2', mid(-1, 3)); attachAt(db, it, 'b3', mid(-1, 4), 'application/pdf')
  // Sunday 23:30 is still that week; the next Monday 00:00 would be another.
  postAt(db, a.convo, 'late on Sunday', weekOf(0) - 30 * 60e3)
  const other = proj(db, 'Other'); postAt(db, other.convo, 'elsewhere', mid(-2))
  assert.deepEqual(page(db, a.p).counts, { weeks: 2, missions_open: 2, missions_done: 1, files: 3 })
  postAt(db, a.convo, 'Monday', weekOf(0))
  assert.equal(page(db, a.p).counts.weeks, 3)
})

test('projectPage: a project with no open mission is not live', () => {
  const db = seeded()
  const a = proj(db, 'Alpha')
  closeAt(db, a.m, mid(-1))
  const out = page(db, a.p)
  assert.deepEqual(out.project, { id: a.p.id, num: a.p.num, title: 'Alpha', state: 'open', live: false })
  assert.deepEqual(out.counts, { weeks: 2, missions_open: 0, missions_done: 1, files: 0 })
})

test('projectPage: a merged project answers as its survivor, with the work done before the merge', () => {
  const db = seeded()
  const a = proj(db, 'Survivor', { createdAt: mid(-4) }); const gone = proj(db, 'Gone', { createdAt: mid(-6) })
  postAt(db, gone.convo, 'Before the merge', mid(-2))
  item(db, gone.convo, 'question', 'Which plan?', { now: mid(-2, 1) })
  mergeProject(db, { userId: 1, projectId: gone.p.id, intoId: a.p.id, by: 'user' })
  const r = resolveProject(db, 1, gone.p.num)
  assert.deepEqual(r.mergedFrom, { id: gone.p.id, num: gone.p.num })
  const out = projectPage(db, 1, r.project, at)
  assert.equal(out.project.id, a.p.id); assert.equal(out.project.title, 'Survivor'); assert.equal(out.project.live, true)
  assert.equal(out.sentence, 'Before the merge')
  assert.deepEqual(out.needs_you.map((n) => n.title), ['Which plan?'])
  assert.deepEqual(out.counts, { weeks: 3, missions_open: 2, missions_done: 0, files: 0 })
})

test('projectPage under the agent sieve: a private-origin project is not found, and the counts leave out the secret conversation', () => {
  const db = seeded()
  const a = proj(db, 'Alpha', { createdAt: mid(-3) })
  privateMission(db, a.p, mid(-5))
  postAt(db, 'secret', 'Private step', mid(-4))
  const hid = item(db, 'secret', 'question', 'Private question', { now: mid(-3, 1) })
  attachAt(db, hid, 'b-secret', mid(-3, 2))
  const open = item(db, a.convo, 'question', 'Public question', { now: mid(-3, 3) })
  attachAt(db, open, 'b-public', mid(-3, 4))
  put(db, -1, [tale({ project_ids: [a.p.id], media_blob_id: 'b-secret' })])
  const client = page(db, a.p)
  assert.deepEqual(client.counts, { weeks: 3, missions_open: 2, missions_done: 0, files: 2 })
  assert.equal(client.needs_you_total, 2)
  assert.deepEqual(client.media, pic('b-secret'))
  const agent = page(db, a.p, sieved)
  assert.deepEqual(agent.counts, { weeks: 1, missions_open: 1, missions_done: 0, files: 1 })
  assert.equal(agent.needs_you_total, 1)
  assert.deepEqual(agent.needs_you.map((n) => n.title), ['Public question'])
  assert.deepEqual(agent.media, pic('b-public'))
  const hidden = proj(db, 'Hidden')
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', hidden.p.id)
  assert.equal(resolveProject(db, 1, hidden.p.id, { excludePrivateOwned: true }), null)
  assert.notEqual(resolveProject(db, 1, hidden.p.id), null)
})

test('projectPage: eight statements with a status and no stored pick, however many weeks are stored; the files roll-up is read once', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const b = proj(db, 'Bravo')
  updateProject(db, { userId: 1, projectId: a.p.id, fields: { status: 'Going well.' }, statusWriter: { by: 'agent', deviceId: 7, convoId: null } })
  const it = item(db, a.convo, 'task', 'Shots', { now: mid(-3) })
  attachAt(db, it, 'b-one', mid(-3, 1))
  // The route resolves the project first; the page itself is counted.
  const count = () => { const { project } = resolveProject(db, 1, a.p.id); return statementsRun(db, () => projectPage(db, 1, project, at)) }
  put(db, -1, [tale({ project_ids: [a.p.id, b.p.id] })])
  // The zone, the mission counts, the stored weeks, the projects their
  // stories name, the files, the waiting items and their count, the moves.
  assert.equal(count(), 8)
  for (let n = 2; n <= 9; n++) put(db, -n, [tale({ project_ids: [a.p.id, b.p.id] })])
  assert.equal(count(), 8)
  // Without a status, one more for the newest milestone; with a stored pick,
  // two more to resolve it.
  updateProject(db, { userId: 1, projectId: a.p.id, fields: { status: '' }, statusWriter: { by: 'agent', deviceId: 7, convoId: null } })
  assert.equal(count(), 9)
  put(db, -1, [tale({ project_ids: [a.p.id], media_blob_id: 'b-one' })])
  assert.equal(count(), 11)
  const files = prepared(db, () => page(db, a.p)).filter((sql) => /json_each\(ic\.attachments\)/.test(sql) && /@projectId/.test(sql))
  assert.equal(files.length, 1, 'the newest picture and the files count come from one statement')
})

test('projectPage files: the count and the newest picture come from one read; files that are not pictures count but are never the picture', () => {
  const db = seeded()
  const a = proj(db, 'Alpha'); const other = proj(db, 'Other')
  const it = item(db, a.convo, 'task', 'Papers', { now: mid(-5) })
  attachAt(db, it, 'b-doc', mid(-2), 'application/pdf')
  attachAt(db, item(db, other.convo, 'task', 'Elsewhere', { now: mid(-5) }), 'b-other', mid(-1))
  let out = page(db, a.p)
  assert.equal(out.media, null); assert.equal(out.counts.files, 1)
  attachAt(db, it, 'b-old', mid(-4)); attachAt(db, it, 'b-new', mid(-3), 'video/mp4')
  out = page(db, a.p)
  assert.deepEqual(out.media, { blob_id: 'b-new', content_type: 'video/mp4', name: 'b-new.png' })
  assert.equal(out.counts.files, 3)
})

test('a story naming a private-origin project: the project stays invisible to a sieved caller and visible to a client', () => {
  const db = seeded()
  const a = proj(db, 'Alpha', { createdAt: mid(-6) }); const hidden = proj(db, 'Hidden', { createdAt: mid(-6) })
  const gone = proj(db, 'Gone', { createdAt: mid(-6) })
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', hidden.p.id)
  // The story's first project is the private-origin one: a client reads the
  // story as being about it, a sieved caller as being about the next it names.
  put(db, -1, [tale({ project_ids: [hidden.p.id, a.p.id], sentence: 'Both moved.', next: 'Ship it' })])
  postAt(db, a.convo, 'A step', mid(-1)); postAt(db, hidden.convo, 'A hidden step', mid(-1))
  assert.equal(page(db, a.p).next, null)
  assert.equal(page(db, hidden.p).next, 'Ship it')
  assert.equal(page(db, a.p, sieved).next, 'Ship it')
  assert.equal(history(db, a.p).weeks[0].card, null)
  assert.deepEqual(history(db, hidden.p).weeks[0].card, { sentence: 'Both moved.', media: null })
  assert.deepEqual(history(db, a.p, sieved).weeks[0].card, { sentence: 'Both moved.', media: null })
  // The same through a merge: a project merged into the private-origin one.
  put(db, -2, [tale({ project_ids: [gone.p.id, a.p.id], next: 'After the merge' })])
  mergeProject(db, { userId: 1, projectId: gone.p.id, intoId: hidden.p.id, by: 'user' })
  put(db, -1, [])
  assert.equal(page(db, a.p).next, null)
  assert.equal(page(db, hidden.p).next, 'After the merge')
  assert.equal(page(db, a.p, sieved).next, 'After the merge')
})

test("the files roll-up and the milestones of a project start from its missions, and a picture lookup from the user's, never from the consent index", () => {
  const db = seeded()
  const a = proj(db, 'Billing')
  for (const sieve of [false, true]) {
    const text = planOf(db, `SELECT * FROM (${filesSqlForTest(sieve, IN_PROJECT)})`, { userId: 1, projectId: a.p.id })
    assert.doesNotMatch(text, /idx_items_consent|idx_missions_user_state|SCAN (m|i|ic|e|l|q)\b/, `sieved ${sieve}`)
    assert.equal((text.match(/SEARCH q USING INDEX idx_projects_user_state \(user_id=\?/g) ?? []).length, 2, `sieved ${sieve}`)
    assert.equal((text.match(/SEARCH m USING INDEX idx_missions_project \(project_id=\?/g) ?? []).length, 2, `sieved ${sieve}`)
    assert.match(text, /SEARCH i USING INDEX idx_items_mission \(mission_id=\?/, `sieved ${sieve}`)
    assert.match(text, /SEARCH ic USING INDEX idx_item_comments_item \(item_id=\?/, `sieved ${sieve}`)
    assert.match(text, /SEARCH e USING INDEX idx_events_media \(convo_id=\?/, `sieved ${sieve}`)
    // The history's milestones start from the project's missions too.
    const steps = planOf(db, `SELECT * FROM (${milestonesSqlForTest(sieve, IN_PROJECT)})`, { userId: 1, projectId: a.p.id })
    assert.doesNotMatch(steps, /idx_missions_user_state|SCAN (m|l|q)\b/, `milestones, sieved ${sieve}`)
    assert.match(steps, /SEARCH m USING INDEX idx_missions_project \(project_id=\?/, `milestones, sieved ${sieve}`)
    assert.match(steps, /SEARCH l USING INDEX idx_milestones_mission \(mission_id=\?/, `milestones, sieved ${sieve}`)
    blobRow(db, `b-${sieve}`)
    const [lookup] = prepared(db, () => liveMedia(db, 1, [`b-${sieve}`], sieve)).filter((sql) => /json_each\(ic\.attachments\)/.test(sql))
    const found = planOf(db, lookup, { userId: 1, ids: '[]' })
    assert.doesNotMatch(found, /idx_items_consent|SCAN (m|i|ic|e|l)\b/, `lookup, sieved ${sieve}`)
    assert.equal((found.match(/SEARCH m USING INDEX idx_missions_user_state \(user_id=\?/g) ?? []).length, 2, `lookup, sieved ${sieve}`)
    assert.match(found, /SEARCH i USING INDEX idx_items_mission \(mission_id=\?/, `lookup, sieved ${sieve}`)
  }
})

test("every read of one project finds the projects merged into it among the user's own, never by reading every user's projects", () => {
  const db = seeded()
  const a = proj(db, 'Billing')
  postAt(db, a.convo, 'A step', mid(-1))
  put(db, -1, [tale({ project_ids: [a.p.id] })])
  const args = { userId: 1, projectId: a.p.id, start: 0, end: 1, weeks: '[]', from: 0, to: 1 }
  for (const sieve of [false, true]) {
    const o = { excludePrivateOwned: sieve }
    const merged = prepared(db, () => { projectPage(db, 1, a.p, o); projectHistory(db, 1, a.p, o) })
      .filter((sql) => /q\.merged_into/.test(sql))
    // The page: missions, the newest milestone, files, needs-you and its
    // count, moves. The history: moves, a week's picture, milestones.
    assert.equal(merged.length, 9, `sieved ${sieve}`)
    for (const sql of merged) {
      const text = planOf(db, sql, Object.fromEntries(Object.entries(args).filter(([k]) => sql.includes(`@${k}`))))
      assert.doesNotMatch(text, /SCAN q\b/, `sieved ${sieve}: ${sql}`)
      assert.match(text, /SEARCH q USING INDEX idx_projects_user_state \(user_id=\?/, `sieved ${sieve}: ${sql}`)
    }
  }
})

// ---- projectHistory ----

const history = (db, p, o = at) => projectHistory(db, 1, resolveProject(db, 1, p.id, o).project, o)
const head = (n) => ({ week: keyOf(n), start: weekOf(n), end: weekOf(n + 1) })
// The project feed's milestone rows with these titles, in the feed's order.
const feedRows = (db, p, titles, o = {}) => projectFeed(db, 1, p, 'milestones', { limit: 100, ...o }).rows.filter((r) => titles.includes(r.title))

test('projectHistory: every local week the project moved, newest first, quiet weeks left out; a card where a week was written about it', () => {
  const db = seeded()
  const a = proj(db, 'Alpha', { createdAt: mid(-6) }); const b = proj(db, 'Bravo', { createdAt: mid(-6) })
  postAt(db, a.convo, 'Drafted', mid(-4)); postAt(db, a.convo, 'Reviewed', mid(-4, 1))
  postAt(db, a.convo, 'Shipped', mid(-1))
  postAt(db, b.convo, 'Elsewhere', mid(-2))
  put(db, -4, [tale({ project_ids: [a.p.id], sentence: 'The draft went round.', next: 'Ship it' })])
  // Written weeks that are not about it: one names it second, one not at all.
  put(db, -1, [tale({ project_ids: [b.p.id, a.p.id], sentence: 'Mostly Bravo.' })])
  put(db, -2, [tale({ project_ids: [b.p.id] })])
  const out = history(db, a.p)
  assert.deepEqual(out, {
    weeks: [
      { ...head(-1), card: null, milestones: feedRows(db, a.p, ['Shipped']), more_milestones: 0 },
      { ...head(-4), card: { sentence: 'The draft went round.', media: null }, milestones: feedRows(db, a.p, ['Reviewed', 'Drafted']), more_milestones: 0 },
      { ...head(-6), card: null, milestones: [], more_milestones: 0 },
    ],
    next_before: null,
  })
  assert.deepEqual(out.weeks[1].milestones.map((m) => m.title), ['Reviewed', 'Drafted'])
})

test('projectHistory milestones are in the project feed shape, so a reader can jump to one in its conversation', () => {
  const db = seeded()
  const a = proj(db, 'Alpha', { createdAt: mid(-1) })
  const posted = postAt(db, a.convo, 'Shipped', mid(-1, 1))
  const [row] = history(db, a.p).weeks[0].milestones
  assert.deepEqual(row, projectFeed(db, 1, a.p, 'milestones').rows[0])
  assert.equal(row.id, posted.id); assert.equal(row.convo_id, a.convo); assert.equal(row.mission_num, a.m.num)
  assert.equal(row.kind, 'progress'); assert.equal(row.created_at, mid(-1, 1)); assert.equal(typeof row.seq, 'number')
  for (const internal of ['at', 'sort_key', 'total', 'idem_key', 'user_id']) assert.equal(internal in row, false, internal)
})

test('projectHistory: at most 20 milestones a week, the newest, with how many more; a week with item activity only has none', () => {
  const db = seeded()
  const a = proj(db, 'Alpha', { createdAt: mid(-3) })
  for (let i = 0; i < 23; i++) postAt(db, a.convo, `Step ${i}`, mid(-2) + i * 60e3)
  item(db, a.convo, 'task', 'Tidy up', { now: mid(-1) })
  const out = history(db, a.p)
  assert.deepEqual(out.weeks.map((w) => w.week), [keyOf(-1), keyOf(-2), keyOf(-3)])
  assert.deepEqual(out.weeks[0].milestones, []); assert.equal(out.weeks[0].more_milestones, 0)
  assert.equal(PROJECT_HISTORY.milestones, 20)
  assert.deepEqual(out.weeks[1].milestones.map((m) => m.title), Array.from({ length: 20 }, (_, i) => `Step ${22 - i}`))
  assert.equal(out.weeks[1].more_milestones, 3)
})

test('projectHistory pages by week key: limit weeks a page, next_before the last week shown; a before that is not a week key is null', () => {
  const db = seeded()
  const a = proj(db, 'Alpha', { createdAt: mid(-9) })
  for (const n of [-7, -5, -3, -1]) postAt(db, a.convo, `Week ${n}`, mid(n))
  const keys = (o) => { const r = history(db, a.p, { ...at, ...o }); return [r.weeks.map((w) => w.week), r.next_before] }
  assert.equal(PROJECT_HISTORY.page, 8)
  assert.deepEqual(keys({}), [[keyOf(-1), keyOf(-3), keyOf(-5), keyOf(-7), keyOf(-9)], null])
  assert.deepEqual(keys({ limit: 2 }), [[keyOf(-1), keyOf(-3)], keyOf(-3)])
  assert.deepEqual(keys({ limit: 2, before: keyOf(-3) }), [[keyOf(-5), keyOf(-7)], keyOf(-7)])
  assert.deepEqual(keys({ limit: 2, before: keyOf(-7) }), [[keyOf(-9)], null])
  assert.deepEqual(keys({ limit: 5 }), [[keyOf(-1), keyOf(-3), keyOf(-5), keyOf(-7), keyOf(-9)], null])
  // A quiet week is a fine place to page from; a week before the first is empty.
  assert.deepEqual(keys({ before: keyOf(-4) }), [[keyOf(-5), keyOf(-7), keyOf(-9)], null])
  assert.deepEqual(keys({ before: keyOf(-9) }), [[], null])
  for (const bad of ['2026-11-10', 'nope', '']) assert.equal(history(db, a.p, { ...at, before: bad }), null, bad)
})

test('projectHistory card media: the stored pick when it resolves, else the newest picture of that week, else null', () => {
  const db = seeded()
  const a = proj(db, 'Site', { createdAt: mid(-6) })
  const it = item(db, a.convo, 'task', 'Screens', { now: mid(-6) })
  attachAt(db, it, 'b-pick', mid(-5))
  attachAt(db, it, 'b-week', mid(-2)); attachAt(db, it, 'b-doc', mid(-2, 1), 'application/pdf')
  postAt(db, a.convo, 'Plain week', mid(-1))
  for (const n of [-1, -2]) put(db, n, [tale({ project_ids: [a.p.id], media_blob_id: n === -2 ? 'b-pick' : null })])
  const media = () => Object.fromEntries(history(db, a.p).weeks.map((w) => [w.week, w.card && w.card.media]))
  assert.deepEqual(media(), { [keyOf(-1)]: null, [keyOf(-2)]: pic('b-pick'), [keyOf(-5)]: null, [keyOf(-6)]: null })
  db.prepare("DELETE FROM blobs WHERE id = 'b-pick'").run()
  assert.deepEqual(media()[keyOf(-2)], pic('b-week'))
})

test("projectHistory: a merged project's history includes the moves made before the merge, and the weeks written about it", () => {
  const db = seeded()
  const a = proj(db, 'Survivor', { createdAt: mid(-2) }); const gone = proj(db, 'Gone', { createdAt: mid(-6) })
  postAt(db, gone.convo, 'Before the merge', mid(-4))
  put(db, -4, [tale({ project_ids: [gone.p.id], sentence: 'Gone got going.' })])
  assert.deepEqual(history(db, a.p).weeks.map((w) => w.week), [keyOf(-2)])
  mergeProject(db, { userId: 1, projectId: gone.p.id, intoId: a.p.id, by: 'user' })
  const out = projectHistory(db, 1, resolveProject(db, 1, gone.p.id).project, at)
  assert.deepEqual(out.weeks.map((w) => w.week), [keyOf(-2), keyOf(-4), keyOf(-6)])
  assert.deepEqual(out.weeks[1].card, { sentence: 'Gone got going.', media: null })
  assert.deepEqual(out.weeks[1].milestones.map((m) => m.title), ['Before the merge'])
})

test('projectHistory under the agent sieve: no week, milestone or picture from the secret conversation', () => {
  const db = seeded()
  const a = proj(db, 'Alpha', { createdAt: mid(-6) })
  privateMission(db, a.p, mid(-5))
  postAt(db, 'secret', 'Private step', mid(-3))
  postAt(db, a.convo, 'Public step', mid(-3, 1))
  const hid = item(db, 'secret', 'task', 'Private shot', { now: mid(-3, 2) })
  attachAt(db, hid, 'b-secret', mid(-3, 3))
  put(db, -3, [tale({ project_ids: [a.p.id], sentence: 'A step.', media_blob_id: 'b-secret' })])
  const client = history(db, a.p)
  assert.deepEqual(client.weeks.map((w) => w.week), [keyOf(-3), keyOf(-5), keyOf(-6)])
  assert.deepEqual(client.weeks[0].milestones.map((m) => m.title), ['Public step', 'Private step'])
  assert.deepEqual(client.weeks[0].card, { sentence: 'A step.', media: pic('b-secret') })
  const agent = history(db, a.p, sieved)
  assert.deepEqual(agent.weeks.map((w) => w.week), [keyOf(-3), keyOf(-6)])
  assert.deepEqual(agent.weeks[0].milestones, feedRows(db, a.p, ['Public step'], { excludePrivateOwned: true }))
  assert.deepEqual(agent.weeks[0].milestones.map((m) => m.title), ['Public step'])
  assert.deepEqual(agent.weeks[0].card, { sentence: 'A step.', media: null })
})

test('projectHistory: five statements and one per returned week, whatever lies behind the page and however many cards need a picture', () => {
  const db = seeded()
  const a = proj(db, 'Alpha', { createdAt: mid(-9) })
  const it = item(db, a.convo, 'task', 'Shots', { now: mid(-9, 1) })
  const { project } = resolveProject(db, 1, a.p.id)
  const count = (limit) => statementsRun(db, () => projectHistory(db, 1, project, { ...at, limit }))
  const week = (n) => { postAt(db, a.convo, `Week ${n}`, mid(n)); attachAt(db, it, `b${n}`, mid(n, 1)); put(db, n, [tale({ project_ids: [a.p.id] })]) }
  for (const n of [-1, -2]) week(n)
  // The zone, the moves, the stored weeks, the projects their stories name
  // and the pictures of the weeks shown; then each week's milestones.
  assert.equal(count(2), 5 + 2)
  for (const n of [-3, -4, -5, -6, -7, -8]) week(n)
  assert.equal(count(2), 5 + 2)
  assert.equal(count(8), 5 + 8)
  const out = history(db, a.p, { ...at, limit: 8 })
  assert.deepEqual(out.weeks.map((w) => w.card?.media?.blob_id), [-1, -2, -3, -4, -5, -6, -7, -8].map((n) => `b${n}`))
  // No card at all: neither the named projects nor the pictures are read. A pick that
  // resolves costs two statements, whatever the number of cards.
  for (const n of [-1, -2]) put(db, n, [])
  assert.equal(count(2), 3 + 2)
  for (const n of [-1, -2]) put(db, n, [tale({ project_ids: [a.p.id], media_blob_id: 'b-8' })])
  assert.equal(count(2), 6 + 2)
})

test("projectHistory card media: each week's own newest picture in one read, a week with none null, a pick kept, the sieve applied", () => {
  const db = seeded()
  const a = proj(db, 'Alpha', { createdAt: mid(-9) }); const other = proj(db, 'Other', { createdAt: mid(-9) })
  privateMission(db, a.p, mid(-9, 1))
  const it = item(db, a.convo, 'task', 'Shots', { now: mid(-9, 2) })
  const hid = item(db, 'secret', 'task', 'Private shots', { now: mid(-9, 3) })
  const far = item(db, other.convo, 'task', 'Elsewhere', { now: mid(-9, 4) })
  attachAt(db, it, 'b1-old', mid(-1)); attachAt(db, it, 'b1-new', mid(-1, 2)); attachAt(db, it, 'b1-doc', mid(-1, 3), 'application/pdf')
  attachAt(db, far, 'b1-other', mid(-1, 4))
  attachAt(db, it, 'b2-first', weekOf(-2)) // the first instant of its week
  attachAt(db, it, 'b3-public', mid(-3)); attachAt(db, hid, 'b3-secret', mid(-3, 1))
  postAt(db, a.convo, 'Quiet on pictures', mid(-4))
  attachAt(db, it, 'b5-own', mid(-5)); attachAt(db, it, 'b5-pick', mid(-5, -1))
  for (const n of [-1, -2, -3, -4]) put(db, n, [tale({ project_ids: [a.p.id] })])
  put(db, -5, [tale({ project_ids: [a.p.id], media_blob_id: 'b5-pick' })])
  const media = (o) => Object.fromEntries(history(db, a.p, o).weeks.filter((w) => w.card).map((w) => [w.week, w.card.media?.blob_id ?? null]))
  assert.deepEqual(media(at), {
    [keyOf(-1)]: 'b1-new', [keyOf(-2)]: 'b2-first', [keyOf(-3)]: 'b3-secret', [keyOf(-4)]: null, [keyOf(-5)]: 'b5-pick',
  })
  assert.deepEqual(media(sieved), {
    [keyOf(-1)]: 'b1-new', [keyOf(-2)]: 'b2-first', [keyOf(-3)]: 'b3-public', [keyOf(-4)]: null, [keyOf(-5)]: 'b5-pick',
  })
  assert.deepEqual(history(db, a.p).weeks[0].card.media, pic('b1-new'))
})
