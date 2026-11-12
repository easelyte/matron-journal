import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { upsertConversation, append } from '../src/journal.js'
import { createItem, addComment, closeItem } from '../src/items.js'
import { createMission, joinMission, leaveMission, createMilestone } from '../src/missions.js'
import { createProject, listProjects, projectDetail } from '../src/projects.js'
import { projectFeed, parseCursor, cardFields, filesSqlForTest, milestonesSqlForTest } from '../src/projects-feed.js'

function seeded() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'alice','x',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','box-2','h',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(8,1,'client','mac','h3',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(9,1,'agent','priv-box','h2',0,1)").run()
  for (const id of ['c1', 'c2', 'c3']) upsertConversation(db, { id, ownerUserId: 1, title: id, agentDeviceId: 7 })
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
const image = (db, convoId, name, ts) => {
  const r = append(db, { userId: 1, convoId, sender: 'agent:x', type: 'image', blobRef: `b-${name}`, payload: { blob_ref: `b-${name}`, name, content_type: 'image/png', size: 9 } })
  if (ts != null) db.prepare('UPDATE events SET ts=? WHERE seq=?').run(ts, r.seq)
  return r
}
const att = (name) => ({ blob_ref: `b-${name}`, mime: 'image/png', name, size: 4 })

test('decisions: decision items in force and reversed, answered questions with the newest user answer (tap, words, transcript); open or cancelled questions, consent cards and other projects are left out', () => {
  const db = seeded()
  const p = project(db); const other = project(db, 'Other')
  const m1 = mission(db, 'c1', 'one'); file(db, m1.id, p.id)
  const m2 = mission(db, 'c2', 'two'); file(db, m2.id, other.id)
  const d = item(db, 'c1', 'decision', 'Launch on Wed', { now: 1000 })
  const rev = item(db, 'c1', 'decision', 'Old call', { now: 900 })
  closeItem(db, { userId: 1, itemId: rev.id, resolution: 'reversed', author: 'agent', deviceId: 7, now: 950 })
  const tapped = item(db, 'c1', 'question', 'Ship the chat?', { now: 100, actions: ['Ship it', 'Hold'] })
  addComment(db, { userId: 1, itemId: tapped.id, author: 'user', deviceId: 8, body: 'Ship it', action: 'Ship it', now: 200 })
  closeItem(db, { userId: 1, itemId: tapped.id, resolution: 'answered', author: 'agent', deviceId: 7, comment: 'shipping', now: 2000 })
  const worded = item(db, 'c1', 'question', 'Date?', { now: 100 })
  addComment(db, { userId: 1, itemId: worded.id, author: 'user', deviceId: 8, body: 'first thought', now: 150 })
  addComment(db, { userId: 1, itemId: worded.id, author: 'user', deviceId: 8, body: '7 Oct. The blog can follow.', now: 160 })
  addComment(db, { userId: 1, itemId: worded.id, author: 'agent', deviceId: 7, body: 'ok', now: 170 })
  closeItem(db, { userId: 1, itemId: worded.id, resolution: 'answered', author: 'agent', deviceId: 7, now: 1500 })
  const voiced = item(db, 'c1', 'question', 'Voice?', { now: 100 })
  addComment(db, { userId: 1, itemId: voiced.id, author: 'user', deviceId: 8, attachments: [att('note.m4a')], now: 120 })
  db.prepare("UPDATE item_comments SET attachments=? WHERE item_id=? AND author='user'")
    .run(JSON.stringify([{ ...att('note.m4a'), transcript: 'yes please' }]), voiced.id)
  closeItem(db, { userId: 1, itemId: voiced.id, resolution: 'answered', author: 'agent', deviceId: 7, now: 1200 })
  item(db, 'c1', 'question', 'Still open?')
  const dropped = item(db, 'c1', 'decision', 'Never took effect')
  closeItem(db, { userId: 1, itemId: dropped.id, resolution: 'cancelled', author: 'agent', deviceId: 7 })
  const cancelled = item(db, 'c1', 'question', 'Dropped')
  closeItem(db, { userId: 1, itemId: cancelled.id, resolution: 'cancelled', author: 'agent', deviceId: 7 })
  item(db, 'c1', 'decision', 'Consent mirror', { consent: 'spawn:x' })
  item(db, 'c2', 'decision', 'Other project call')
  const out = projectFeed(db, 1, p, 'decisions')
  assert.deepEqual(out.rows.map((r) => r.title), ['Ship the chat?', 'Date?', 'Voice?', 'Launch on Wed', 'Old call'])
  assert.equal(out.total, 5); assert.equal(out.next_before, null)
  const by = Object.fromEntries(out.rows.map((r) => [r.title, r]))
  assert.equal(by['Ship the chat?'].answer, 'Ship it')
  assert.equal(by['Date?'].answer, '7 Oct. The blog can follow.')
  assert.equal(by['Voice?'].answer, 'yes please')
  assert.equal(by['Launch on Wed'].answer, null); assert.equal(by['Launch on Wed'].id, d.id)
  assert.equal(by['Old call'].resolution, 'reversed')
  assert.equal(by['Date?'].mission_num, m1.num)
  for (const r of out.rows) for (const k of ['at', 'sort_key']) assert.equal(k in r, false, k)
})

test('decisions sieve: an item from a private conversation, or a mission born in one, is invisible to a filtered caller; so is an answer written from a private device', () => {
  const db = seeded()
  const p = project(db)
  const m1 = mission(db, 'c1', 'one'); file(db, m1.id, p.id)
  const hiddenM = mission(db, 'secret', 'hidden', 9); file(db, hiddenM.id, p.id)
  joinMission(db, { userId: 1, missionId: m1.id, convoId: 'secret' })
  item(db, 'secret', 'decision', 'Private call')
  db.prepare("UPDATE conversations SET mission_id=? WHERE id='c3'").run(hiddenM.id)
  item(db, 'c3', 'decision', 'On a hidden mission')
  const q = item(db, 'c1', 'question', 'Public Q')
  addComment(db, { userId: 1, itemId: q.id, author: 'user', deviceId: 9, body: 'private words' })
  closeItem(db, { userId: 1, itemId: q.id, resolution: 'answered', author: 'agent', deviceId: 7 })
  assert.equal(projectFeed(db, 1, p, 'decisions').total, 3)
  const sieved = projectFeed(db, 1, p, 'decisions', { excludePrivateOwned: true })
  assert.deepEqual(sieved.rows.map((r) => r.title), ['Public Q'])
  assert.equal(sieved.rows[0].answer, null)
  assert.equal(JSON.stringify(sieved).includes('rivate'), false)
})

test('files: item attachments and chat images posted while the conversation was on the mission, once each, newest first; outside the link window or another project, left out', () => {
  const db = seeded()
  const p = project(db); const other = project(db, 'Other')
  const m1 = mission(db, 'c1', 'one'); file(db, m1.id, p.id)
  const m2 = mission(db, 'c3', 'three'); file(db, m2.id, p.id)
  const m3 = mission(db, 'c2', 'two'); file(db, m3.id, other.id)
  db.prepare("UPDATE mission_conversations SET joined_at=1000, first_joined_at=1000 WHERE convo_id='c1'").run()
  image(db, 'c1', 'before.png', 500)
  image(db, 'c1', 'during.png', 2000)
  joinMission(db, { userId: 1, missionId: m2.id, convoId: 'c1' })
  db.prepare("UPDATE mission_conversations SET joined_at=1000, first_joined_at=1000 WHERE convo_id='c1'").run()
  image(db, 'c1', 'both.png', 3000)
  leaveMission(db, { userId: 1, missionId: m1.id, convoId: 'c1' })
  db.prepare("UPDATE mission_conversations SET ended_at=3500 WHERE mission_id=? AND convo_id='c1'").run(m1.id)
  db.prepare("UPDATE mission_conversations SET ended_at=3500 WHERE mission_id=? AND convo_id='c1'").run(m2.id)
  image(db, 'c1', 'after.png', 4000)
  image(db, 'c2', 'other.png', 2500)
  const it = item(db, 'c1', 'task', 'With pictures', { attachments: [att('a.png'), att('b.png')], now: 2500 })
  db.prepare('UPDATE items SET mission_id=? WHERE id=?').run(m1.id, it.id)
  addComment(db, { userId: 1, itemId: it.id, author: 'user', deviceId: 8, attachments: [att('reply.png')], now: 2600 })
  const out = projectFeed(db, 1, p, 'files')
  assert.deepEqual(out.rows.map((r) => r.name), ['both.png', 'reply.png', 'b.png', 'a.png', 'during.png'])
  assert.equal(out.total, 5)
  const both = out.rows[0]
  assert.equal(both.mission_num, Math.min(m1.num, m2.num)); assert.deepEqual(both.source, { convo_id: 'c1', seq: both.source.seq })
  assert.equal(both.blob_id, 'b-both.png'); assert.equal(both.content_type, 'image/png'); assert.equal(both.size, 9)
  assert.deepEqual(out.rows[1].source, { item_num: it.num }); assert.equal(out.rows[1].content_type, 'image/png')
  assert.equal(both.posted_at, 3000); assert.equal(out.rows[1].posted_at, 2600)
})

test('files sieve: a private conversation\'s images and a private-origin mission\'s attachments are invisible to a filtered caller', () => {
  const db = seeded()
  const p = project(db)
  const m1 = mission(db, 'c1', 'one'); file(db, m1.id, p.id)
  const hiddenM = mission(db, 'secret', 'hidden', 9); file(db, hiddenM.id, p.id)
  assert.notEqual(hiddenM.id, m1.id)
  joinMission(db, { userId: 1, missionId: m1.id, convoId: 'secret' })
  image(db, 'secret', 'private.png')
  image(db, 'c1', 'public.png')
  db.prepare("UPDATE conversations SET mission_id=? WHERE id='c3'").run(hiddenM.id)
  item(db, 'c3', 'task', 'Hidden attach', { attachments: [att('hidden.png')] })
  assert.equal(projectFeed(db, 1, p, 'files').total, 3)
  const sieved = projectFeed(db, 1, p, 'files', { excludePrivateOwned: true })
  assert.deepEqual(sieved.rows.map((r) => r.name), ['public.png'])
})

test('paging: limit and next_before walk every milestone once, ties on one timestamp included; parseCursor refuses junk', () => {
  const db = seeded()
  const p = project(db)
  const m1 = mission(db, 'c1', 'one'); file(db, m1.id, p.id)
  for (let i = 0; i < 7; i++) post(db, 'c1', `step ${i}`)
  db.prepare('UPDATE milestones SET created_at=5000').run()
  const seen = []
  let before = null
  for (let pages = 0; pages < 10; pages++) {
    const out = projectFeed(db, 1, p, 'milestones', { limit: 3, before })
    assert.equal(out.total, 7)
    seen.push(...out.rows.map((r) => r.title))
    if (!out.next_before) break
    before = parseCursor(out.next_before)
  }
  assert.deepEqual(seen, ['step 6', 'step 5', 'step 4', 'step 3', 'step 2', 'step 1', 'step 0'])
  assert.equal(projectFeed(db, 1, p, 'milestones').rows[0].mission_num, m1.num)
  assert.equal(parseCursor(null), null)
  for (const junk of ['', 'x', '12', '12:', 'a:b', "1:'; DROP"]) assert.equal(parseCursor(junk), undefined, junk)
})

test('card fields: waiting_on is the newest item awaiting the user with a count of the rest, latest is the newest milestone, sessions_now counts live top-level sessions; all sieved', () => {
  const db = seeded()
  const p = project(db); const empty = project(db, 'Empty')
  const m1 = mission(db, 'c1', 'one'); file(db, m1.id, p.id)
  const m2 = mission(db, 'c2', 'two'); file(db, m2.id, p.id)
  joinMission(db, { userId: 1, missionId: m1.id, convoId: 'secret' })
  item(db, 'c1', 'question', 'Older ask', { now: 100 })
  item(db, 'c2', 'question', 'Newer ask', { now: 200 })
  item(db, 'secret', 'question', 'Private ask', { now: 300 })
  item(db, 'c1', 'task', 'Agent task')
  post(db, 'c2', 'public step'); post(db, 'secret', 'private step', 9)
  db.prepare("UPDATE milestones SET created_at = CASE title WHEN 'public step' THEN 10 ELSE 20 END").run()
  const full = cardFields(db, 1).get(p.id)
  assert.equal(full.waiting_on.title, 'Private ask'); assert.equal(full.waiting_on.more, 2)
  assert.equal(full.latest.title, 'private step'); assert.equal(full.latest.mission_num, m1.num)
  assert.equal(full.sessions_now, 3)
  const sieved = cardFields(db, 1, { excludePrivateOwned: true }).get(p.id)
  assert.equal(sieved.waiting_on.title, 'Newer ask'); assert.equal(sieved.waiting_on.more, 1)
  assert.equal(sieved.waiting_on.mission_num, m2.num); assert.equal(sieved.waiting_on.kind, 'question')
  assert.equal(sieved.latest.title, 'public step'); assert.equal(sieved.sessions_now, 2)
  const rows = listProjects(db, 1)
  const row = rows.find((r) => r.id === p.id)
  assert.equal(row.waiting_on.title, 'Private ask'); assert.equal(typeof row.sessions_now, 'number')
  const none = rows.find((r) => r.id === empty.id)
  assert.deepEqual([none.waiting_on, none.latest, none.sessions_now], [null, null, 0])
})

test('projectDetail carries the first page of each kind with totals', () => {
  const db = seeded()
  const p = project(db)
  const m1 = mission(db, 'c1', 'one'); file(db, m1.id, p.id)
  for (let i = 0; i < 8; i++) post(db, 'c1', `step ${i}`)
  item(db, 'c1', 'decision', 'A call')
  const out = projectDetail(db, 1, p)
  assert.equal(out.milestones.total, 8); assert.equal(out.milestones.rows.length, 6); assert.equal(typeof out.milestones.next_before, 'string')
  assert.equal(out.decisions.total, 1); assert.equal(out.decisions.next_before, null)
  assert.deepEqual(out.files, { total: 0, rows: [], next_before: null })
  assert.equal(out.recent_milestones.length, 5, 'kept for older apps')
})

test('files query reads a linked conversation through idx_events_media, never every event of the user, and items through their mission', () => {
  const db = seeded()
  const p = project(db)
  const m1 = mission(db, 'c1', 'one'); file(db, m1.id, p.id)
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM (${filesSqlForTest(false)})`).all({ projectId: p.id, userId: 1 })
  const text = plan.map((r) => r.detail).join('\n')
  assert.match(text, /idx_events_media/)
  assert.doesNotMatch(text, /SEARCH e USING INDEX sqlite_autoindex_events_1/)
  // The item arm reaches a file from the project's missions, through their
  // items to the items' comments; never through the consent index.
  assert.doesNotMatch(text, /idx_items_consent/)
  assert.match(text, /SEARCH i USING INDEX idx_items_mission \(mission_id=\?/)
  assert.match(text, /SEARCH ic USING INDEX idx_item_comments_item \(item_id=\?/)
  assert.equal((text.match(/SEARCH m USING INDEX idx_missions_project \(project_id=\?/g) ?? []).length, 2)
})

test("milestones query finds the project's missions through idx_missions_project, never every mission of the user", () => {
  const db = seeded()
  const p = project(db)
  const m1 = mission(db, 'c1', 'one'); file(db, m1.id, p.id)
  for (const sieve of [false, true]) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM (${milestonesSqlForTest(sieve)})`).all({ projectId: p.id, userId: 1 })
    const text = plan.map((r) => r.detail).join('\n')
    assert.doesNotMatch(text, /idx_missions_user_state|SCAN (m|l)\b/, `sieved ${sieve}`)
    assert.match(text, /SEARCH m USING INDEX idx_missions_project \(project_id=\?/, `sieved ${sieve}`)
    assert.match(text, /SEARCH l USING INDEX idx_milestones_mission \(mission_id=\?/, `sieved ${sieve}`)
  }
})

test('waiting_on counts a consent card like the needs_you number does', () => {
  const db = seeded()
  const p = project(db)
  const m1 = mission(db, 'c1', 'one'); file(db, m1.id, p.id)
  item(db, 'c1', 'question', 'Approve the spawn?', { consent: 'spawn:x' })
  const row = listProjects(db, 1).find((r) => r.id === p.id)
  assert.equal(row.needs_you, 1); assert.equal(row.waiting_on.title, 'Approve the spawn?'); assert.equal(row.waiting_on.more, 0)
})

test('files: a conversation that leaves the mission and rejoins it keeps its first stint\'s files', () => {
  const db = seeded()
  const p = project(db)
  const m1 = mission(db, 'c1', 'one'); file(db, m1.id, p.id)
  db.prepare("UPDATE mission_conversations SET joined_at=1000, first_joined_at=NULL WHERE convo_id='c1'").run()
  image(db, 'c1', 'first-stint.png', 2000)
  leaveMission(db, { userId: 1, missionId: m1.id, convoId: 'c1' })
  joinMission(db, { userId: 1, missionId: m1.id, convoId: 'c1' })
  const link = db.prepare("SELECT joined_at, first_joined_at FROM mission_conversations WHERE convo_id='c1'").get()
  assert.ok(link.joined_at > 2000, 'a rejoin re-stamps joined_at')
  assert.equal(link.first_joined_at, 1000, 'the first start survives the rejoin')
  image(db, 'c1', 'second-stint.png')
  assert.deepEqual(projectFeed(db, 1, p, 'files').rows.map((r) => r.name), ['second-stint.png', 'first-stint.png'])
})
