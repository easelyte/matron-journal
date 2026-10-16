// test/search-docs.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMission, updateMission, createMilestone, joinMission, closeMission } from '../src/missions.js'
import { createItem, addComment } from '../src/items.js'
import { upsertMemory, deleteMemory } from '../src/memories.js'
import { createProject, updateProject, closeProject } from '../src/projects.js'
import { docVisibilitySql } from '../src/search-docs.js'
import { upsertConversation } from '../src/journal.js'
import { seed } from './search-fixtures.js'

const docs = (db, kind) => db.prepare('SELECT field, body FROM search_docs WHERE kind=? ORDER BY field').all(kind)
const match = (db, q) => db.prepare('SELECT d.kind, d.field FROM docs_fts f JOIN search_docs d ON d.id=f.rowid WHERE docs_fts MATCH ?').all(q)
const visible = (db, q, filtered, opts) => db.prepare(`SELECT d.kind, d.field FROM docs_fts f JOIN search_docs d ON d.id=f.rowid
  WHERE docs_fts MATCH ? AND d.user_id=1 AND ${docVisibilitySql(filtered, opts)}`).all(q)

test('a new mission indexes its title field; a status edit replaces the status doc', () => {
  const db = seed()
  const { mission } = createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'Harbour lantern export', body: 'csv for painted boats' })
  assert.deepEqual(docs(db, 'mission').map((d) => d.field), ['title'])
  updateMission(db, { userId: 1, missionId: mission.id, fields: { status: 'first draft of the sketchbook' }, statusWriter: { by: 'agent', convoId: 'c1', deviceId: 1 } })
  updateMission(db, { userId: 1, missionId: mission.id, fields: { status: 'shipped the watercolour' }, statusWriter: { by: 'agent', convoId: 'c1', deviceId: 1 } })
  assert.deepEqual(docs(db, 'mission').map((d) => d.field), ['status', 'title'])
  assert.equal(match(db, '"sketchbook"').length, 0, 'old status text no longer matches')
  assert.equal(match(db, '"watercolour"').length, 1)
})

test('milestones, items, comments and memories are indexed; a deleted memory leaves no doc', () => {
  const db = seed()
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'Feed the otters' })
  createMilestone(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'otters fed by nine o clock', appendMarker: () => ({ seq: 1 }) })
  const { item } = createItem(db, { userId: 1, originDeviceId: 1, originConvoId: 'c1', createdBy: 'agent', kind: 'task', title: 'count the sleepy otters' })
  addComment(db, { userId: 1, itemId: item.id, author: 'user', deviceId: 1, body: 'try the kelp basket' })
  const mem = upsertMemory(db, { userId: 1, name: 'quiet-hours', description: 'feed in the evening', body: '', type: 'feedback', scope: 'global', by: 'agent' })
  assert.equal(match(db, '"nine"').length, 1)
  assert.equal(match(db, '"sleepy"').length, 1)
  assert.equal(match(db, '"kelp"').length, 1)
  assert.equal(match(db, '"evening"').length, 1)
  deleteMemory(db, 1, mem.memory.id)
  assert.equal(match(db, '"evening"').length, 0)
  assert.equal(docs(db, 'memory').length, 0)
})

test('status comments (kind=status) are never indexed', () => {
  const db = seed()
  const { item } = createItem(db, { userId: 1, originDeviceId: 1, originConvoId: 'c1', createdBy: 'agent', kind: 'task', title: 't' })
  db.prepare(`INSERT INTO item_comments(id,item_id,user_id,author,device_id,kind,body,created_at) VALUES('ic_s',?,1,'agent',1,'status','reopened zebra',0)`).run(item.id)
  assert.equal(match(db, '"zebra"').length, 0)
})

test('installSearchDocs backfills existing rows once and is idempotent', async () => {
  const { installSearchDocs } = await import('../src/search-docs.js')
  const db = seed()
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'Gamma ray' })
  db.exec('DELETE FROM search_docs; DELETE FROM search_docs_state;')
  db.exec("INSERT INTO docs_fts(docs_fts) VALUES('rebuild'); INSERT INTO docs_fts_plain(docs_fts_plain) VALUES('rebuild')")
  installSearchDocs(db)
  installSearchDocs(db)
  assert.equal(docs(db, 'mission').length, 1)
  // createMission also gives the mission a default project of the same
  // title (default-project.js), which is indexed too (kind='project') — so
  // scope the FTS check to the mission doc specifically.
  assert.equal(match(db, '"gamma"').filter((r) => r.kind === 'mission').length, 1)
})

test('triggers survive the items table rebuild (old database)', async () => {
  const { rebuildItemsForNotice } = await import('../src/db.js')
  const { installSearchDocs } = await import('../src/search-docs.js')
  const db = seed()
  // Simulate the pre-notice items table, then the boot sequence.
  const def = db.prepare("SELECT sql FROM sqlite_master WHERE name='items'").get().sql
  db.pragma('foreign_keys = OFF')
  db.exec(`CREATE TABLE items_old AS SELECT * FROM items; DROP TABLE items;`)
  db.exec(def.replace("'task','question','decision','notice'", "'task','question','decision'"))
  db.exec('DROP TABLE items_old')
  db.pragma('foreign_keys = ON')
  rebuildItemsForNotice(db)
  installSearchDocs(db)
  createItem(db, { userId: 1, originDeviceId: 1, originConvoId: 'c1', createdBy: 'agent', kind: 'task', title: 'quokka census' })
  assert.equal(match(db, '"quokka"').length, 1)
})

test('a private box\'s status, milestone and item on a PUBLIC mission are hidden from an ordinary agent only', () => {
  const db = seed()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(2,1,'agent','box-b','h2',0,1)").run()
  upsertConversation(db, { id: 'cp', ownerUserId: 1, title: 'private chat', agentDeviceId: 2 })
  const { mission } = createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'Public walrus mission' })
  // box-b joins the public mission from its own (private-owned) conversation
  // — the real way a status, milestone or item ends up filed from there
  // (createMilestone/createItem both resolve the posting conversation's
  // CURRENT mission; missionRef would need an active link too).
  joinMission(db, { userId: 1, missionId: mission.id, convoId: 'cp' })
  updateMission(db, { userId: 1, missionId: mission.id, fields: { status: 'secret narwhal status' }, statusWriter: { by: 'agent', convoId: 'cp', deviceId: 2 } })
  createMilestone(db, { userId: 1, deviceId: 2, createdBy: 'agent', convoId: 'cp', kind: 'progress', title: 'narwhal milestone', appendMarker: () => ({ seq: 2 }) })
  createItem(db, { userId: 1, originDeviceId: 2, originConvoId: 'cp', createdBy: 'agent', kind: 'task', title: 'narwhal task' })
  // The mission's own title (born on the PUBLIC c1/box-a) stays visible to
  // an ordinary agent; its auto-created default project shares the title
  // and is scoped out here so this assertion is about the mission doc only.
  assert.equal(visible(db, '"walrus"', true).filter((r) => r.kind === 'mission').length, 1)
  assert.equal(visible(db, '"narwhal"', true).length, 0, 'status, milestone and item from the private-owned convo are all hidden')
  assert.equal(visible(db, '"narwhal"', false).length, 3, 'the owner sees the status, milestone and item docs')
})

test('a mission born on a private box hides all its docs; a privately saved memory is hidden; a comment on a hidden item is hidden too', () => {
  const db = seed()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(2,1,'agent','box-b','h2',0,1)").run()
  upsertConversation(db, { id: 'cp', ownerUserId: 1, title: 'p', agentDeviceId: 2 })
  createMission(db, { userId: 1, deviceId: 2, createdBy: 'agent', convoId: 'cp', title: 'Private axolotl' })
  upsertMemory(db, { userId: 1, name: 'axolotl-rule', description: 'axolotl', body: '', type: 'feedback', scope: 'global', originConvoId: 'cp', originDeviceId: 2, by: 'agent' })
  // visible(false): the mission's title doc, its auto-created default
  // project's (same-titled) title doc, and the memory's text doc.
  assert.equal(visible(db, '"axolotl"', false).length, 3)
  assert.equal(visible(db, '"axolotl"', true).length, 0, 'mission, default project and memory are all private-owned')

  const { item } = createItem(db, { userId: 1, originDeviceId: 2, originConvoId: 'cp', createdBy: 'agent', kind: 'task', title: 'quiet task' })
  addComment(db, { userId: 1, itemId: item.id, author: 'agent', deviceId: 2, convoId: 'cp', body: 'wombat follow-up' })
  assert.equal(visible(db, '"wombat"', false).length, 1, 'the owner sees the comment on the hidden item')
  assert.equal(visible(db, '"wombat"', true).length, 0, 'a comment on an item from a private-owned conversation is hidden from an ordinary agent')
})

test('a project whose status was written from a private-owned conversation hides that status, not its title', () => {
  const db = seed()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(2,1,'agent','box-b','h2',0,1)").run()
  upsertConversation(db, { id: 'cp', ownerUserId: 1, title: 'p', agentDeviceId: 2 })
  const { project } = createProject(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'Public hedgehog project' })
  updateProject(db, { userId: 1, projectId: project.id, fields: { status: 'secret pangolin status' }, statusWriter: { by: 'agent', convoId: 'cp', deviceId: 2 } })
  assert.equal(visible(db, '"hedgehog"', true).length, 1, 'the project title stays visible: it was born on the public c1/box-a')
  assert.equal(visible(db, '"pangolin"', true).length, 0, 'a status written from a private-owned conversation is hidden from an ordinary agent')
  assert.equal(visible(db, '"pangolin"', false).length, 1, 'the owner sees the status')
})

// Every filtered assertion above expects 0 for
// milestone/item/comment/memory, so a predicate that always returns 0 for
// those kinds would also pass. Pin the positive case: a public-origin doc
// of each kind stays visible with excludePrivateOwned=true.
test('public milestone, item, comment and memory docs stay visible to an ordinary agent', () => {
  const db = seed()
  createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'Otter survey' })
  createMilestone(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'otter milestone', appendMarker: () => ({ seq: 1 }) })
  const { item } = createItem(db, { userId: 1, originDeviceId: 1, originConvoId: 'c1', createdBy: 'agent', kind: 'task', title: 'otter task' })
  addComment(db, { userId: 1, itemId: item.id, author: 'agent', deviceId: 1, convoId: 'c1', body: 'otter comment' })
  upsertMemory(db, { userId: 1, name: 'otter-rule', description: 'otter', body: '', type: 'feedback', scope: 'global', originConvoId: 'c1', originDeviceId: 1, by: 'agent' })
  const hits = visible(db, '"otter"', true)
  assert.ok(hits.some((r) => r.kind === 'milestone'), 'milestone visible')
  assert.ok(hits.some((r) => r.kind === 'item'), 'item visible')
  assert.ok(hits.some((r) => r.kind === 'comment'), 'comment visible')
  assert.ok(hits.some((r) => r.kind === 'memory'), 'memory visible')
})

// A closed PUBLIC mission's and project's close_summary stay visible to
// an ordinary agent, as on the read routes: missionRow/projectRow never
// gate close_summary on who closed it, only closed_convo_id itself.
test("a closed public mission's and project's summary stay visible to an ordinary agent", () => {
  const db = seed()
  const { mission } = createMission(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'Heron rollout' })
  closeMission(db, { userId: 1, missionId: mission.id, by: 'agent', summary: 'wrapped the heron migration' })
  const { project } = createProject(db, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'Heron project' })
  closeProject(db, { userId: 1, projectId: project.id, by: 'agent', summary: 'closed the heron project' })
  assert.equal(visible(db, '"migration"', true).length, 1, "the mission's close_summary stays visible")
  assert.equal(visible(db, '"closed the heron"', true).length, 1, "the project's close_summary stays visible")
})

// A consent-mirror item (and its comment)
// is hidden from EVERY agent, private ones included — items-http.js's
// `excludeConsent: who.kind==='agent'` is independent of excludePrivateOwned.
// docVisibilitySql must let a caller ask for exactly that: consent filtering
// on its own, privacy filtering on its own, or both together.
test('a consent item and its comment are hidden under excludeConsent, with or without excludePrivateOwned', () => {
  const db = seed()
  const { item } = createItem(db, {
    userId: 1, originDeviceId: 1, originConvoId: 'c1', createdBy: 'agent', kind: 'task', title: 'gibbon consent ask', consent: 'spawn',
  })
  addComment(db, { userId: 1, itemId: item.id, author: 'agent', deviceId: 1, convoId: 'c1', body: 'gibbon consent note' })
  // Neither flag set: visible (both default false → '1').
  assert.equal(visible(db, '"gibbon"', false).length, 2)
  // excludePrivateOwned alone: the item is not private-owned, so it stays
  // visible — callers decide about consent on their own.
  assert.equal(visible(db, '"gibbon"', true).length, 2)
  // excludeConsent alone (the private-agent case): hidden even though
  // excludePrivateOwned is false.
  assert.equal(visible(db, '"gibbon"', false, { excludeConsent: true }).length, 0)
  // Both set (the ordinary-agent case): still hidden.
  assert.equal(visible(db, '"gibbon"', true, { excludeConsent: true }).length, 0)
})
