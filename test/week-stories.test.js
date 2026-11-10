import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { upsertConversation } from '../src/journal.js'
import { createItem, addComment } from '../src/items.js'
import { createMission } from '../src/missions.js'
import { createProject, mergeProject } from '../src/projects.js'
import { weekStartOf, formatWeekKey, previousWeekStart, weekEndOf } from '../src/timeline.js'
import { WEEK_LIMITS, validWeekWrite, writeWeek, storedWeek, projectNotes } from '../src/week-stories.js'

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

// ---- validWeekWrite ----

const story = (over = {}) => ({ title: 'Launch', sentence: 'The site went live.', project_ids: ['pj_a'], ...over })
const full = () => ({
  convo_id: 'ignored', lede: '  A good week.  ', final: true, extra: 1,
  stories: [story({ next: ' Ship docs ', item_ids: [3, 'it_x'], media_blob_id: 'b1', extra: true })],
  notes: [{ project_id: 4, note: ' Steady. ' }],
})

test('validWeekWrite accepts a full body, trims, and ignores unknown keys', () => {
  assert.deepEqual(validWeekWrite(full()), {
    lede: 'A good week.', final: true,
    stories: [{ title: 'Launch', sentence: 'The site went live.', next: 'Ship docs', project_ids: ['pj_a'], item_ids: [3, 'it_x'], media_blob_id: 'b1' }],
    notes: [{ project: 4, note: 'Steady.' }],
  })
})

test('validWeekWrite defaults: no lede, no final, no notes, optional story fields null or empty', () => {
  assert.deepEqual(validWeekWrite({ stories: [story()] }), {
    lede: null, final: false, notes: [],
    stories: [{ title: 'Launch', sentence: 'The site went live.', next: null, project_ids: ['pj_a'], item_ids: [], media_blob_id: null }],
  })
  assert.equal(validWeekWrite({ lede: '   ', stories: [] }).lede, null)
  assert.equal(validWeekWrite({ stories: [story({ next: '  ' })] }).stories[0].next, null)
  assert.deepEqual(validWeekWrite({}), { lede: null, stories: [], final: false, notes: [] })
})

test('validWeekWrite rejects malformed bodies', () => {
  const bad = (body, why) => assert.equal(validWeekWrite(body), null, why)
  bad(null, 'null'); bad([], 'array'); bad('x', 'string')
  bad({ lede: 'x'.repeat(WEEK_LIMITS.ledeMax + 1) }, 'long lede')
  bad({ lede: 5 }, 'lede type')
  bad({ stories: [story({ title: 'x'.repeat(81) })] }, 'title > 80')
  bad({ stories: [story({ title: '   ' })] }, 'blank title')
  bad({ stories: [story({ sentence: undefined })] }, 'sentence missing')
  bad({ stories: [story({ sentence: 'x'.repeat(301) })] }, 'sentence > 300')
  bad({ stories: [story({ next: 'x'.repeat(301) })] }, 'next > 300')
  bad({ stories: Array.from({ length: 9 }, () => story()) }, '9 stories')
  bad({ stories: 'nope' }, 'stories type')
  bad({ stories: ['x'] }, 'story type')
  bad({ stories: [story({ project_ids: [] })] }, 'project_ids empty')
  bad({ stories: [story({ project_ids: undefined })] }, 'project_ids missing')
  bad({ stories: [story({ project_ids: Array.from({ length: 11 }, (_, i) => i + 1) })] }, '11 projects')
  bad({ stories: [story({ item_ids: Array.from({ length: 11 }, (_, i) => i + 1) })] }, '11 items')
  bad({ stories: [story({ project_ids: ['p'.repeat(129)] })] }, 'project ref > 128')
  bad({ stories: [story({ item_ids: [` ${'i'.repeat(129)} `] })] }, 'item ref > 128 after trim')
  bad({ notes: [{ project_id: 'p'.repeat(129), note: 'x' }] }, 'note ref > 128')
  bad({ stories: [story({ media_blob_id: 'b'.repeat(129) })] }, 'blob id > 128')
  assert.ok(validWeekWrite({ stories: [story({ project_ids: ['p'.repeat(128)], media_blob_id: 'b'.repeat(128) })] }), '128 is allowed')
  for (const r of [0, -1, '', {}, 1.5, null, true]) {
    bad({ stories: [story({ project_ids: [r] })] }, `project ref ${JSON.stringify(r)}`)
    bad({ stories: [story({ item_ids: [r] })] }, `item ref ${JSON.stringify(r)}`)
    bad({ notes: [{ project_id: r, note: 'x' }] }, `note ref ${JSON.stringify(r)}`)
  }
  bad({ stories: [story({ media_blob_id: '' })] }, 'empty blob')
  bad({ stories: [story({ media_blob_id: 5 })] }, 'blob type')
  bad({ final: 'yes' }, 'final type')
  bad({ notes: [{ project_id: 1, note: '  ' }] }, 'empty note')
  bad({ notes: [{ project_id: 1, note: 'x'.repeat(301) }] }, 'long note')
  bad({ notes: Array.from({ length: 51 }, () => ({ project_id: 1, note: 'x' })) }, '51 notes')
  bad({ notes: ['x'] }, 'note type')
})

// ---- writeWeek ----

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
const input = (over = {}) => ({ lede: null, stories: [], final: false, notes: [], ...over })
const body = (over) => validWeekWrite({ stories: [], ...over })
const write = (db, key, over, o = {}) => writeWeek(db, 1, key, body(over), { ...opts, ...o })
const rows = (db) => db.prepare('SELECT COUNT(*) AS n FROM week_stories').get().n + db.prepare('SELECT COUNT(*) AS n FROM project_notes').get().n

test('writeWeek stores resolved ids: numbers become ids, a merged project becomes its survivor', () => {
  const db = seeded()
  const a = project(db, 'Alpha'); const b = project(db, 'Beta'); const c = project(db, 'Gamma')
  mission(db, 'c1', a.id)
  const it = item(db, 'c1')
  blob(db, 'b-shot'); attach(db, it, 'b-shot')
  mergeProject(db, { userId: 1, projectId: c.id, intoId: b.id, by: 'agent' })
  const r = write(db, keyOf(-1), {
    lede: 'A busy week.',
    stories: [{ title: 'Launch', sentence: 'It shipped.', next: 'Docs', project_ids: [a.num, c.id, b.id, a.id], item_ids: [it.num, it.id], media_blob_id: 'b-shot' }],
    notes: [{ project_id: c.num, note: 'Merged into beta.' }, { project_id: a.id, note: 'On track.' }],
  })
  assert.deepEqual(r, { ok: true, week: keyOf(-1) })
  const stored = storedWeek(db, 1, keyOf(-1))
  assert.equal(stored.week_key, keyOf(-1)); assert.equal(stored.lede, 'A busy week.')
  assert.equal(stored.written_at, NOW); assert.equal(stored.final, false)
  assert.deepEqual(stored.stories, [{ title: 'Launch', sentence: 'It shipped.', next: 'Docs', project_ids: [a.id, b.id], item_ids: [it.id], media_blob_id: 'b-shot' }])
  assert.deepEqual([...projectNotes(db, 1, [a.id, b.id, c.id])].sort(), [[a.id, { note: 'On track.', written_at: NOW }], [b.id, { note: 'Merged into beta.', written_at: NOW }]].sort())
  assert.equal(storedWeek(db, 1, keyOf(-2)), null)
  assert.equal(storedWeek(db, 2, keyOf(-1)), null)
})

test('writeWeek refuses a project that is not the user\'s, or hidden by the sieve, naming the ref', () => {
  const db = seeded()
  const theirs = project(db, 'Theirs', { userId: 2, deviceId: 10 })
  const secret = project(db, 'Secret', { deviceId: 9 })
  const story = (ref) => ({ title: 'T', sentence: 'S.', project_ids: [ref] })
  assert.deepEqual(write(db, keyOf(0), { stories: [story(theirs.id)] }), { error: 'bad_request', detail: 'unknown_project', ref: theirs.id })
  assert.deepEqual(write(db, keyOf(0), { stories: [story('pj_nope')] }), { error: 'bad_request', detail: 'unknown_project', ref: 'pj_nope' })
  assert.equal(write(db, keyOf(0), { stories: [story(secret.num)] }).ref, secret.num)
  assert.equal(write(db, keyOf(0), { stories: [story(secret.id)] }).detail, 'unknown_project')
  assert.equal(write(db, keyOf(0), { notes: [{ project_id: secret.id, note: 'x' }] }).detail, 'unknown_project')
  assert.equal(write(db, keyOf(0), { notes: [{ project_id: theirs.num + 100, note: 'x' }] }).detail, 'unknown_project')
  // Without the sieve (the option exists for other callers) the private project resolves.
  assert.equal(write(db, keyOf(0), { stories: [story(secret.id)] }, { excludePrivateOwned: false }).ok, true)
  // A project born in a private conversation (no private device on the row) is hidden too.
  const born = project(db, 'Born private')
  db.prepare('UPDATE projects SET origin_convo_id = ? WHERE id = ?').run('secret', born.id)
  assert.equal(write(db, keyOf(0), { stories: [story(born.id)] }).detail, 'unknown_project')
})

test('writeWeek refuses an unknown item, a private item, another user\'s item', () => {
  const db = seeded()
  const a = project(db, 'Alpha')
  mission(db, 'c1', a.id)
  const priv = project(db, 'P2'); mission(db, 'secret', priv.id, 9)
  const hidden = item(db, 'secret', 9)
  const mine = item(db, 'c1')
  const theirs = createItem(db, { userId: 2, originDeviceId: 10, createdBy: 'agent', kind: 'task', title: 'Bob item', originConvoId: 'b1' }).item
  const story = (item_ids) => ({ title: 'T', sentence: 'S.', project_ids: [a.id], item_ids })
  assert.deepEqual(write(db, keyOf(0), { stories: [story([999])] }), { error: 'bad_request', detail: 'unknown_item', ref: 999 })
  assert.deepEqual(write(db, keyOf(0), { stories: [story(['it_nope'])] }), { error: 'bad_request', detail: 'unknown_item', ref: 'it_nope' })
  assert.equal(write(db, keyOf(0), { stories: [story([hidden.id])] }).detail, 'unknown_item')
  assert.equal(write(db, keyOf(0), { stories: [story([hidden.num])] }).detail, 'unknown_item')
  // Another user's item, by id and by number (bob's number also exists for alice).
  assert.deepEqual(write(db, keyOf(0), { stories: [story([theirs.id])] }), { error: 'bad_request', detail: 'unknown_item', ref: theirs.id })
  assert.equal(write(db, keyOf(0), { stories: [story([theirs.id])] }, { excludePrivateOwned: false }).detail, 'unknown_item')
  assert.equal(write(db, keyOf(0), { stories: [story([mine.num])] }).ok, true)
  assert.equal(write(db, keyOf(0), { stories: [story([hidden.id])] }, { excludePrivateOwned: false }).ok, true)
})

test("writeWeek's item numbers are per user: bob's same number is alice's own item, bob's number alice lacks is unknown", () => {
  const db = seeded()
  const a = project(db, 'Alpha'); mission(db, 'c1', a.id)
  const mine = item(db, 'c1')
  const bobs = []
  while (bobs.length < mine.num + 2) {
    bobs.push(createItem(db, { userId: 2, originDeviceId: 10, createdBy: 'agent', kind: 'task', title: 'Bob item', originConvoId: 'b1' }).item)
  }
  const sameNum = bobs.find((x) => x.num === mine.num)
  const onlyBobs = bobs.find((x) => x.num === mine.num + 2)
  assert.ok(sameNum && onlyBobs)
  const story = (item_ids) => ({ title: 'T', sentence: 'S.', project_ids: [a.id], item_ids })
  assert.equal(write(db, keyOf(0), { stories: [story([mine.num])] }).ok, true)
  assert.deepEqual(storedWeek(db, 1, keyOf(0)).stories[0].item_ids, [mine.id]) // not bob's item with the same number
  assert.deepEqual(write(db, keyOf(0), { stories: [story([onlyBobs.num])] }), { error: 'bad_request', detail: 'unknown_item', ref: onlyBobs.num })
  assert.equal(write(db, keyOf(0), { stories: [story([sameNum.id])] }).detail, 'unknown_item')
})

test('writeWeek refuses an unknown blob, another user\'s, one only a private conversation holds, one in no roll-up', () => {
  const db = seeded()
  const a = project(db, 'Alpha'); mission(db, 'c1', a.id)
  const priv = project(db, 'P2'); mission(db, 'secret', priv.id, 9)
  const mine = item(db, 'c1'); const hidden = item(db, 'secret', 9)
  blob(db, 'b-mine'); attach(db, mine, 'b-mine')
  blob(db, 'b-secret'); attach(db, hidden, 'b-secret')
  blob(db, 'b-bob', 2)
  blob(db, 'b-loose')
  const story = (id) => ({ title: 'T', sentence: 'S.', project_ids: [a.id], media_blob_id: id })
  for (const id of ['b-none', 'b-bob', 'b-secret', 'b-loose']) {
    assert.deepEqual(write(db, keyOf(0), { stories: [story(id)] }), { error: 'bad_request', detail: 'unknown_blob', ref: id }, id)
  }
  assert.equal(write(db, keyOf(0), { stories: [story('b-mine')] }).ok, true)
  assert.equal(write(db, keyOf(0), { stories: [story('b-secret')] }, { excludePrivateOwned: false }).ok, true)
  assert.equal(write(db, keyOf(0), { stories: [story('b-bob')] }, { excludePrivateOwned: false }).detail, 'unknown_blob')
})

test('writeWeek refuses a blob that is not an image or a video; a video is accepted', () => {
  const db = seeded()
  const a = project(db, 'P'); mission(db, 'c1', a.id)
  const mine = item(db, 'c1')
  for (const [id, type] of [['b-pdf', 'application/pdf'], ['b-log', 'text/plain'], ['b-vid', 'video/mp4']]) { blob(db, id, 1, type); attach(db, mine, id) }
  const story = (id) => ({ title: 'T', sentence: 'S.', project_ids: [a.id], media_blob_id: id })
  for (const o of [{}, { excludePrivateOwned: false }]) {
    assert.deepEqual(write(db, keyOf(0), { stories: [story('b-pdf')] }, o), { error: 'bad_request', detail: 'unknown_blob', ref: 'b-pdf' })
    assert.equal(write(db, keyOf(0), { stories: [story('b-log')] }, o).detail, 'unknown_blob')
    assert.equal(write(db, keyOf(0), { stories: [story('b-vid')] }, o).ok, true)
  }
})

test('writeWeek finds the week by its key after a time-zone change: the final flag still holds and a rewrite replaces the row', () => {
  const db = seeded()
  assert.equal(write(db, keyOf(-1), { final: true, lede: 'one' }).ok, true)
  db.prepare("UPDATE users SET time_zone = 'America/New_York' WHERE id = 1").run()
  assert.equal(storedWeek(db, 1, keyOf(-1)).lede, 'one')
  assert.deepEqual(write(db, keyOf(-1), { lede: 'two' }), { error: 'conflict', detail: 'week_final' })
  assert.equal(write(db, keyOf(-1), { final: true, lede: 'three' }).ok, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM week_stories').get().n, 1)
  assert.equal(storedWeek(db, 1, keyOf(-1)).lede, 'three')
})

test('writeWeek: the week must be a Monday key, started, and at most reachWeeks back', () => {
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

test('writeWeek: final needs an ended week; a final week only takes a final rewrite', () => {
  const db = seeded()
  assert.deepEqual(write(db, keyOf(0), { final: true }), { error: 'bad_request', detail: 'week_not_ended' })
  assert.equal(write(db, keyOf(-1), { final: true, lede: 'one' }).ok, true)
  assert.equal(storedWeek(db, 1, keyOf(-1)).final, true)
  assert.deepEqual(write(db, keyOf(-1), { lede: 'two' }), { error: 'conflict', detail: 'week_final' })
  assert.equal(storedWeek(db, 1, keyOf(-1)).lede, 'one')
  assert.equal(write(db, keyOf(-1), { final: true, lede: 'three' }).ok, true)
  assert.equal(storedWeek(db, 1, keyOf(-1)).lede, 'three')
  // A non-final week can be rewritten and then finished.
  assert.equal(write(db, keyOf(-2), { lede: 'a' }).ok, true)
  assert.equal(write(db, keyOf(-2), { lede: 'b' }).ok, true)
  assert.equal(write(db, keyOf(-2), { lede: 'c', final: true }).ok, true)
  assert.equal(storedWeek(db, 1, keyOf(-2)).lede, 'c')
})

test('writeWeek: a rewrite replaces the stories; a second note replaces the first', () => {
  const db = seeded()
  const a = project(db, 'Alpha')
  const s = (title) => ({ title, sentence: 'S.', project_ids: [a.id] })
  write(db, keyOf(0), { stories: [s('one'), s('two')], notes: [{ project_id: a.id, note: 'first' }] })
  write(db, keyOf(0), { stories: [s('three')], notes: [{ project_id: a.num, note: 'second' }] }, { now: NOW + 5 })
  assert.deepEqual(storedWeek(db, 1, keyOf(0)).stories.map((x) => x.title), ['three'])
  assert.deepEqual(projectNotes(db, 1, [a.id]).get(a.id), { note: 'second', written_at: NOW + 5 })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM week_stories').get().n, 1)
  assert.equal(projectNotes(db, 1, []).size, 0)
  assert.equal(projectNotes(db, 2, [a.id]).size, 0)
})

test('writeWeek writes nothing at all when any reference fails', () => {
  const db = seeded()
  const a = project(db, 'Alpha')
  const r = write(db, keyOf(0), {
    lede: 'x',
    stories: [{ title: 'T', sentence: 'S.', project_ids: [a.id] }],
    notes: [{ project_id: a.id, note: 'ok' }, { project_id: 'pj_missing', note: 'bad' }],
  })
  assert.equal(r.detail, 'unknown_project')
  assert.equal(rows(db), 0)
  const r2 = write(db, keyOf(0), { stories: [{ title: 'T', sentence: 'S.', project_ids: [a.id], media_blob_id: 'nope' }], notes: [{ project_id: a.id, note: 'ok' }] })
  assert.equal(r2.detail, 'unknown_blob')
  assert.equal(rows(db), 0)
  // And a failing rewrite leaves the earlier week as it was.
  assert.equal(write(db, keyOf(0), { lede: 'kept', notes: [{ project_id: a.id, note: 'kept' }] }).ok, true)
  assert.equal(write(db, keyOf(0), { lede: 'lost', notes: [{ project_id: 'pj_missing', note: 'x' }] }).ok, undefined)
  assert.equal(storedWeek(db, 1, keyOf(0)).lede, 'kept')
  assert.equal(projectNotes(db, 1, [a.id]).get(a.id).note, 'kept')
})

test('writeWeek takes an already-normalised input directly', () => {
  const db = seeded()
  assert.equal(writeWeek(db, 1, keyOf(0), input({ lede: 'direct' }), opts).ok, true)
  assert.equal(storedWeek(db, 1, keyOf(0)).lede, 'direct')
})
