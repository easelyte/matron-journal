import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { upsertConversation } from '../src/journal.js'
import { createItem, addComment } from '../src/items.js'
import { createMission } from '../src/missions.js'
import { createProject, mergeProject } from '../src/projects.js'
import { weekStartOf, formatWeekKey, previousWeekStart, weekEndOf } from '../src/timeline.js'
import { WEEK_LIMITS, validWeekEntries, writeWeekEntries, storedWeek, projectNotes, pictureRollupSqlForTest } from '../src/week-stories.js'

const LON = 'Europe/London'
const NOW = Date.UTC(2026, 10, 11, 12) // Wed 11 Nov 2026, week of Mon 9 Nov
const W0 = weekStartOf(NOW, LON)
const weekN = (n) => {
  let s = W0
  for (let i = 0; i < Math.abs(n); i++) s = n < 0 ? previousWeekStart(s, LON) : weekEndOf(s, LON)
  return s
}
const keyOf = (n) => formatWeekKey(weekN(n), LON)
const opts = { now: NOW }

// ---- validWeekEntries: references, pictures and notes ----

const entry = (over = {}) => ({ project: 'pj_a', sentence: 'The site went live.', ...over })

test('validWeekEntries trims, keeps final and notes, and ignores unknown keys', () => {
  assert.deepEqual(validWeekEntries({
    convo_id: 'ignored', final: true, extra: 1,
    entries: [entry({ next: ' Ship docs ', media_blob_id: 'b1', extra: true })],
    notes: [{ project_id: 4, note: ' Steady. ' }],
  }), {
    final: true,
    entries: [{ project: 'pj_a', sentence: 'The site went live.', next: 'Ship docs', media_blob_id: 'b1' }],
    notes: [{ project: 4, note: 'Steady.' }],
  })
  assert.deepEqual(validWeekEntries({ entries: [entry({ next: '  ' })] }), {
    final: false, notes: [], entries: [{ project: 'pj_a', sentence: 'The site went live.', next: null, media_blob_id: null }],
  })
})

test('validWeekEntries rejects malformed references, pictures and notes', () => {
  const bad = (body, why) => assert.equal(validWeekEntries({ entries: [], ...body }), null, why)
  bad({ entries: [entry({ project: 'p'.repeat(129) })] }, 'project ref > 128')
  bad({ entries: [entry({ project: ` ${'p'.repeat(129)} ` })] }, 'project ref > 128 after trim')
  bad({ notes: [{ project_id: 'p'.repeat(129), note: 'x' }] }, 'note ref > 128')
  bad({ entries: [entry({ media_blob_id: 'b'.repeat(129) })] }, 'blob id > 128')
  assert.ok(validWeekEntries({ entries: [entry({ project: 'p'.repeat(128), media_blob_id: 'b'.repeat(128) })] }), '128 is allowed')
  for (const r of [0, -1, '', {}, 1.5, null, true]) {
    bad({ entries: [entry({ project: r })] }, `project ref ${JSON.stringify(r)}`)
    bad({ notes: [{ project_id: r, note: 'x' }] }, `note ref ${JSON.stringify(r)}`)
  }
  bad({ entries: [entry({ media_blob_id: '' })] }, 'empty blob')
  bad({ entries: ['x'] }, 'entry type')
  bad({ notes: [{ project_id: 1, note: '  ' }] }, 'empty note')
  bad({ notes: [{ project_id: 1, note: 'x'.repeat(WEEK_LIMITS.noteMax + 1) }] }, 'long note')
  bad({ notes: Array.from({ length: WEEK_LIMITS.notesMax + 1 }, () => ({ project_id: 1, note: 'x' })) }, '51 notes')
  bad({ notes: ['x'] }, 'note type')
  bad({ notes: 'x' }, 'notes type')
})

// ---- writeWeekEntries ----

function seeded() {
  const db = openDb(':memory:')
  for (const [id, name] of [[1, 'alice'], [2, 'bob']]) db.prepare('INSERT INTO users(id, name, password_hash, created_at) VALUES(?,?,?,0)').run(id, name, 'x')
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','box-2','h',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(9,1,'agent','priv-box','h2',0,1)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(10,2,'agent','bob-box','h3',0)").run()
  upsertConversation(db, { id: 'c1', ownerUserId: 1, title: 'c1', agentDeviceId: 7 })
  upsertConversation(db, { id: 'secret', ownerUserId: 1, title: 'S', agentDeviceId: 9 })
  upsertConversation(db, { id: 'b1', ownerUserId: 2, title: 'b1', agentDeviceId: 10 })
  return db
}
const project = (db, title, { userId = 1, deviceId = 7 } = {}) => createProject(db, { userId, deviceId, createdBy: 'agent', title }).project
const mission = (db, convoId, projectId, deviceId = 7) =>
  createMission(db, { userId: 1, deviceId, createdBy: 'agent', convoId, title: `m-${convoId}`, projectId }).mission
const item = (db, convoId, deviceId = 7) =>
  createItem(db, { userId: 1, originDeviceId: deviceId, createdBy: 'agent', kind: 'task', title: 'An item', originConvoId: convoId }).item
const blob = (db, id, userId = 1, type = 'image/png') =>
  db.prepare("INSERT INTO blobs(id, owner_user_id, content_type, size, sha256, disk_path, created_at) VALUES(?,?,?,4,'s','p',0)").run(id, userId, type)
const attach = (db, it, blobId) => addComment(db, {
  userId: 1, itemId: it.id, author: 'agent', deviceId: it.origin_device_id ?? 7, attachments: [{ blob_ref: blobId, mime: 'image/png', name: `${blobId}.png`, size: 4 }], now: NOW - 1000,
})
const input = (over = {}) => ({ entries: [], final: false, notes: [], ...over })
const body = (over) => validWeekEntries({ entries: [], ...over })
const write = (db, key, over, o = {}) => writeWeekEntries(db, 1, key, body(over), { ...opts, ...o })
const rows = (db) => db.prepare('SELECT COUNT(*) AS n FROM week_stories').get().n + db.prepare('SELECT COUNT(*) AS n FROM project_notes').get().n
const card = (projectRef, over = {}) => ({ project: projectRef, sentence: 'S.', ...over })

test('writeWeekEntries stores resolved ids: numbers become ids, a merged project becomes its survivor, notes too', () => {
  const db = seeded()
  const a = project(db, 'Alpha'); const b = project(db, 'Beta'); const c = project(db, 'Gamma')
  mission(db, 'c1', a.id)
  const it = item(db, 'c1')
  blob(db, 'b-shot'); attach(db, it, 'b-shot')
  mergeProject(db, { userId: 1, projectId: c.id, intoId: b.id, by: 'agent' })
  const r = write(db, keyOf(-1), {
    entries: [card(a.num, { sentence: 'It shipped.', next: 'Docs', media_blob_id: 'b-shot' }), card(c.id, { sentence: 'Merged.' })],
    notes: [{ project_id: c.num, note: 'Merged into beta.' }, { project_id: a.id, note: 'On track.' }],
  })
  assert.deepEqual(r, { ok: true, week: keyOf(-1), entries: 2 })
  const stored = storedWeek(db, 1, keyOf(-1))
  assert.equal(stored.week_key, keyOf(-1)); assert.equal(stored.lede, null)
  assert.equal(stored.written_at, NOW); assert.equal(stored.final, false)
  assert.deepEqual(stored.stories, [
    { title: null, sentence: 'It shipped.', next: 'Docs', project_ids: [a.id], item_ids: [], media_blob_id: 'b-shot' },
    { title: null, sentence: 'Merged.', next: null, project_ids: [b.id], item_ids: [], media_blob_id: null },
  ])
  assert.deepEqual([...projectNotes(db, 1, [a.id, b.id, c.id])].sort(), [[a.id, { note: 'On track.', written_at: NOW }], [b.id, { note: 'Merged into beta.', written_at: NOW }]].sort())
  assert.equal(storedWeek(db, 1, keyOf(-2)), null)
  assert.equal(storedWeek(db, 2, keyOf(-1)), null)
})

test('writeWeekEntries refuses a project that is not the user\'s, or hidden by the sieve, naming the ref', () => {
  const db = seeded()
  const theirs = project(db, 'Theirs', { userId: 2, deviceId: 10 })
  const secret = project(db, 'Secret', { deviceId: 9 })
  assert.deepEqual(write(db, keyOf(0), { entries: [card(theirs.id)] }), { error: 'bad_request', detail: 'unknown_project', ref: theirs.id })
  assert.deepEqual(write(db, keyOf(0), { entries: [card('pj_nope')] }), { error: 'bad_request', detail: 'unknown_project', ref: 'pj_nope' })
  assert.equal(write(db, keyOf(0), { entries: [card(secret.num)] }).ref, secret.num)
  assert.equal(write(db, keyOf(0), { entries: [card(secret.id)] }).detail, 'unknown_project')
  assert.equal(write(db, keyOf(0), { notes: [{ project_id: secret.id, note: 'x' }] }).detail, 'unknown_project')
  assert.equal(write(db, keyOf(0), { notes: [{ project_id: theirs.num + 100, note: 'x' }] }).detail, 'unknown_project')
  // Without the sieve (the option exists for other callers) the private project resolves.
  assert.equal(write(db, keyOf(0), { entries: [card(secret.id)] }, { excludePrivateOwned: false }).ok, true)
  // A project born in a private conversation (no private device on the row) is hidden too.
  const born = project(db, 'Born private')
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', born.id)
  assert.equal(write(db, keyOf(0), { entries: [card(born.id)] }).detail, 'unknown_project')
})

test('writeWeekEntries refuses an unknown blob, another user\'s, one only a private conversation holds, one in no roll-up', () => {
  const db = seeded()
  const a = project(db, 'Alpha'); mission(db, 'c1', a.id)
  const priv = project(db, 'P2'); mission(db, 'secret', priv.id, 9)
  const mine = item(db, 'c1'); const hidden = item(db, 'secret', 9)
  blob(db, 'b-mine'); attach(db, mine, 'b-mine')
  blob(db, 'b-secret'); attach(db, hidden, 'b-secret')
  blob(db, 'b-bob', 2)
  blob(db, 'b-loose')
  const pictured = (id) => card(a.id, { media_blob_id: id })
  for (const id of ['b-none', 'b-bob', 'b-secret', 'b-loose']) {
    assert.deepEqual(write(db, keyOf(0), { entries: [pictured(id)] }), { error: 'bad_request', detail: 'unknown_blob', ref: id }, id)
  }
  assert.equal(write(db, keyOf(0), { entries: [pictured('b-mine')] }).ok, true)
  assert.equal(write(db, keyOf(0), { entries: [pictured('b-secret')] }, { excludePrivateOwned: false }).ok, true)
  assert.equal(write(db, keyOf(0), { entries: [pictured('b-bob')] }, { excludePrivateOwned: false }).detail, 'unknown_blob')
})

test("the picture check reads only the user's own missions, never every user's comments or mission links", () => {
  const db = seeded()
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${pictureRollupSqlForTest}`).all({ userId: 1, blobId: 'b-mine' })
  const text = plan.map((r) => r.detail).join('\n')
  assert.doesNotMatch(text, /SCAN (ic|l|m|i|e)\b/)
  // Both arms of the roll-up start from the user's missions.
  assert.equal((text.match(/SEARCH m USING INDEX idx_missions_user_state \(user_id=\?/g) ?? []).length, 2)
  assert.match(text, /SEARCH i USING INDEX idx_items_mission \(mission_id=\?/)
  assert.match(text, /SEARCH ic USING INDEX idx_item_comments_item \(item_id=\?/)
  assert.match(text, /SEARCH l USING INDEX sqlite_autoindex_mission_conversations_1 \(mission_id=\?/)
})

test('writeWeekEntries refuses a blob that is not an image or a video; a video is accepted', () => {
  const db = seeded()
  const a = project(db, 'P'); mission(db, 'c1', a.id)
  const mine = item(db, 'c1')
  for (const [id, type] of [['b-pdf', 'application/pdf'], ['b-log', 'text/plain'], ['b-vid', 'video/mp4']]) { blob(db, id, 1, type); attach(db, mine, id) }
  const pictured = (id) => card(a.id, { media_blob_id: id })
  for (const o of [{}, { excludePrivateOwned: false }]) {
    assert.deepEqual(write(db, keyOf(0), { entries: [pictured('b-pdf')] }, o), { error: 'bad_request', detail: 'unknown_blob', ref: 'b-pdf' })
    assert.equal(write(db, keyOf(0), { entries: [pictured('b-log')] }, o).detail, 'unknown_blob')
    assert.equal(write(db, keyOf(0), { entries: [pictured('b-vid')] }, o).ok, true)
  }
})

test('writeWeekEntries finds the week by its key after a time-zone change: the final flag still holds and a rewrite replaces the row', () => {
  const db = seeded()
  const a = project(db, 'Alpha')
  assert.equal(write(db, keyOf(-1), { final: true, entries: [card(a.id, { sentence: 'one' })] }).ok, true)
  db.prepare("UPDATE users SET time_zone = 'America/New_York' WHERE id = 1").run()
  assert.equal(storedWeek(db, 1, keyOf(-1)).stories[0].sentence, 'one')
  assert.deepEqual(write(db, keyOf(-1), { entries: [card(a.id, { sentence: 'two' })] }), { error: 'conflict', detail: 'week_final' })
  assert.equal(write(db, keyOf(-1), { final: true, entries: [card(a.id, { sentence: 'three' })] }).ok, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM week_stories').get().n, 1)
  assert.equal(storedWeek(db, 1, keyOf(-1)).stories[0].sentence, 'three')
})

test('writeWeekEntries: the week must be a Monday key, started, and at most reachWeeks back', () => {
  const db = seeded()
  assert.deepEqual(write(db, '2026-11-10'), { error: 'bad_request', detail: 'bad_week' })
  assert.equal(write(db, 'nope').detail, 'bad_week')
  assert.deepEqual(write(db, keyOf(1)), { error: 'bad_request', detail: 'week_out_of_range' })
  assert.equal(write(db, keyOf(-10)).ok, true)
  assert.deepEqual(write(db, keyOf(-11)), { error: 'bad_request', detail: 'week_out_of_range' })
  assert.equal(write(db, keyOf(0)).ok, true)
  // A week that has just begun is in range; one second before it begins is not.
  assert.equal(write(db, keyOf(1), {}, { now: weekN(1) }).ok, true)
  assert.equal(write(db, keyOf(1), {}, { now: weekEndOf(weekN(0), LON) - 1 }).detail, 'week_out_of_range')
})

test('writeWeekEntries: a rewrite replaces the entries; a second note replaces the first', () => {
  const db = seeded()
  const a = project(db, 'Alpha'); const b = project(db, 'Beta')
  write(db, keyOf(0), { entries: [card(a.id, { sentence: 'one' }), card(b.id, { sentence: 'two' })], notes: [{ project_id: a.id, note: 'first' }] })
  write(db, keyOf(0), { entries: [card(b.id, { sentence: 'three' })], notes: [{ project_id: a.num, note: 'second' }] }, { now: NOW + 5 })
  assert.deepEqual(storedWeek(db, 1, keyOf(0)).stories.map((x) => x.sentence), ['three'])
  assert.deepEqual(projectNotes(db, 1, [a.id]).get(a.id), { note: 'second', written_at: NOW + 5 })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM week_stories').get().n, 1)
  assert.equal(projectNotes(db, 1, []).size, 0)
  assert.equal(projectNotes(db, 2, [a.id]).size, 0)
})

test('writeWeekEntries writes nothing at all when any reference fails', () => {
  const db = seeded()
  const a = project(db, 'Alpha')
  const r = write(db, keyOf(0), {
    entries: [card(a.id)],
    notes: [{ project_id: a.id, note: 'ok' }, { project_id: 'pj_missing', note: 'bad' }],
  })
  assert.equal(r.detail, 'unknown_project')
  assert.equal(rows(db), 0)
  const r2 = write(db, keyOf(0), { entries: [card(a.id, { media_blob_id: 'nope' })], notes: [{ project_id: a.id, note: 'ok' }] })
  assert.equal(r2.detail, 'unknown_blob')
  assert.equal(rows(db), 0)
  // And a failing rewrite leaves the earlier week as it was.
  assert.equal(write(db, keyOf(0), { entries: [card(a.id, { sentence: 'kept' })], notes: [{ project_id: a.id, note: 'kept' }] }).ok, true)
  assert.equal(write(db, keyOf(0), { entries: [card(a.id, { sentence: 'lost' })], notes: [{ project_id: 'pj_missing', note: 'x' }] }).ok, undefined)
  assert.equal(storedWeek(db, 1, keyOf(0)).stories[0].sentence, 'kept')
  assert.equal(projectNotes(db, 1, [a.id]).get(a.id).note, 'kept')
})

test('writeWeekEntries takes an already-normalised input directly', () => {
  const db = seeded()
  const a = project(db, 'Alpha')
  assert.equal(writeWeekEntries(db, 1, keyOf(0), input({ entries: [{ project: a.id, sentence: 'direct', next: null, media_blob_id: null }] }), opts).ok, true)
  assert.equal(storedWeek(db, 1, keyOf(0)).stories[0].sentence, 'direct')
})

test('writeWeekEntries: a non-final week can be rewritten and then finished; after that only a final rewrite replaces it', () => {
  const db = seeded()
  const a = project(db, 'Alpha')
  const says = (sentence, final = false) => ({ final, entries: [card(a.id, { sentence })] })
  assert.equal(write(db, keyOf(-2), says('a')).ok, true)
  assert.equal(write(db, keyOf(-2), says('b')).ok, true)
  assert.equal(write(db, keyOf(-2), says('c', true)).ok, true)
  assert.equal(storedWeek(db, 1, keyOf(-2)).final, true)
  assert.deepEqual(write(db, keyOf(-2), says('d')), { error: 'conflict', detail: 'week_final' })
  assert.equal(storedWeek(db, 1, keyOf(-2)).stories[0].sentence, 'c')
  assert.equal(write(db, keyOf(-2), says('e', true)).ok, true)
  assert.equal(storedWeek(db, 1, keyOf(-2)).stories[0].sentence, 'e')
})
