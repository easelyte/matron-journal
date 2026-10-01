import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { backfillMissionLinks, healMissionLinks, hasActiveLink } from '../src/mission-links.js'
import { upsertConversation, snapshot } from '../src/journal.js'
import { createItem } from '../src/items.js'
import {
  createMission, joinMission, closeMission, leaveMission, createMilestone, CONVOS_MAX,
  missionDetail, conversationMissions, getMission, foldSubchats, OTHER_MISSIONS_MAX,
  updateMission, activityOf, QUIET_MS,
} from '../src/missions.js'
import { append } from '../src/journal.js'

const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
const indexes = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name)
const tmpPath = (tag) => path.join(os.tmpdir(), `${tag}-${process.pid}-${Date.now()}.sqlite`)
const rmDb = (p) => { for (const s of ['', '-wal', '-shm']) fs.rmSync(`${p}${s}`, { force: true }) }

const PROJECT_COLS = [
  'id', 'user_id', 'num', 'state', 'title', 'body',
  'status', 'status_by', 'status_convo_id', 'status_device_id', 'status_updated_at',
  'close_summary', 'closed_by', 'closed_over_open_missions', 'closed_at', 'merged_into',
  'origin_convo_id', 'origin_device_id', 'created_by', 'idem_key', 'created_at', 'updated_at',
]

test('schema: mission_conversations and projects exist; missions gains project_id; constraints hold', () => {
  const db = openDb(':memory:')
  assert.deepEqual(cols(db, 'mission_conversations'), ['mission_id', 'convo_id', 'user_id', 'how', 'joined_at', 'ended_at'])
  assert.deepEqual(cols(db, 'projects'), PROJECT_COLS)
  assert.ok(cols(db, 'missions').includes('project_id'))
  for (const n of ['idx_mc_convo', 'idx_projects_user_state', 'idx_missions_project']) assert.ok(indexes(db).includes(n), n)
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  const link = db.prepare('INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at) VALUES(?,?,1,?,0)')
  link.run('ms_a', 'c1', 'joined')
  assert.throws(() => link.run('ms_a', 'c1', 'joined'), /UNIQUE/)
  assert.throws(() => link.run('ms_b', 'c1', 'teleported'), /CHECK/)
  const pj = db.prepare("INSERT INTO projects(id,user_id,num,title,origin_device_id,created_by,created_at,updated_at) VALUES(?,1,?,'P',1,'agent',0,0)")
  pj.run('pj_a', 5)
  assert.throws(() => pj.run('pj_b', 5), /UNIQUE/)
  const row = db.prepare('SELECT state, body, closed_over_open_missions FROM projects WHERE id=?').get('pj_a')
  assert.deepEqual(row, { state: 'open', body: '', closed_over_open_missions: 0 })
  assert.throws(() => db.prepare("UPDATE projects SET state='archived' WHERE id='pj_a'").run(), /CHECK/)
})

test('schema: opening a pre-projects database adds the tables, project_id and its index once', () => {
  const p = tmpPath('projects-migration')
  try {
    openDb(p).close()
    const raw = new Database(p)
    raw.exec('DROP INDEX IF EXISTS idx_missions_project')
    raw.exec('ALTER TABLE missions DROP COLUMN project_id')
    raw.exec('DROP TABLE mission_conversations')
    raw.exec('DROP TABLE projects')
    raw.close()

    const db2 = openDb(p)
    assert.ok(cols(db2, 'missions').includes('project_id'))
    assert.deepEqual(cols(db2, 'projects'), PROJECT_COLS)
    assert.ok(indexes(db2).includes('idx_missions_project'))
    const after = { missions: cols(db2, 'missions'), projects: cols(db2, 'projects'), links: cols(db2, 'mission_conversations') }
    db2.close()

    const db3 = openDb(p)
    assert.deepEqual({ missions: cols(db3, 'missions'), projects: cols(db3, 'projects'), links: cols(db3, 'mission_conversations') }, after)
    db3.close()
  } finally { rmDb(p) }
})

const linkMap = (db) => Object.fromEntries(db.prepare('SELECT * FROM mission_conversations ORDER BY mission_id, convo_id').all()
  .map((r) => [`${r.mission_id}/${r.convo_id}`, { how: r.how, joined_at: r.joined_at, ended_at: r.ended_at }]))

test('backfill: the first open with an empty link table recovers current, origin, inherited and history links; later opens never touch it', () => {
  const p = tmpPath('mc-backfill')
  try {
    const db1 = openDb(p)
    db1.exec(`
      INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0), (2,'pat','x',0);
      INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','dev-2','h',0);
      INSERT INTO conversations(id, owner_user_id, title, created_at, mission_id, parent_convo_id) VALUES
        ('origin',1,'o',100,'ms_a',NULL), ('joiner',1,'j',200,'ms_a',NULL), ('kid',1,'k',300,'ms_a','origin'),
        ('mover',1,'m',400,'ms_b',NULL), ('quiet',1,'q',500,NULL,NULL), ('foreign',2,'f',600,NULL,NULL);
      INSERT INTO missions(id,user_id,num,state,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at) VALUES
        ('ms_a',1,1,'open','A','origin',7,'agent',1000,1000),
        ('ms_b',1,2,'open','B','mover',7,'agent',2000,2000),
        ('ms_old',1,3,'closed','Old','mover',7,'agent',50,50);
      INSERT INTO milestones(id,mission_id,user_id,num,kind,title,convo_id,seq,device_id,created_by,created_at) VALUES
        ('ml_1','ms_old',1,4,'progress','x','mover',1,7,'agent',60),
        ('ml_2','ms_old',1,5,'progress','y','mover',2,7,'agent',70),
        ('ml_3','ms_a',1,6,'progress','z','joiner',3,7,'agent',1500),
        ('ml_4','ms_a',1,7,'progress','f','foreign',4,7,'agent',1600);
      INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at,mission_id) VALUES
        ('it_1',1,8,'task','closed',1024,'t','mover',7,'agent',80,80,'ms_old');
      INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload) VALUES
        (1, 10, 'joiner', 1200, 'agent:dev-2', 'mission', '{"mission_id":"ms_a","num":1,"action":"joined","by":"agent"}');
      DELETE FROM mission_conversations;
    `)
    db1.close()

    const db2 = openDb(p)
    assert.deepEqual(linkMap(db2), {
      'ms_a/joiner': { how: 'joined', joined_at: 1200, ended_at: null },     // joined_at from its joined marker
      'ms_a/kid': { how: 'inherited', joined_at: 1000, ended_at: null },     // sub-chat; max(300, 1000)
      'ms_a/origin': { how: 'origin', joined_at: 1000, ended_at: null },     // max(100, 1000)
      'ms_b/mover': { how: 'origin', joined_at: 2000, ended_at: null },
      'ms_old/mover': { how: 'backfill', joined_at: 60, ended_at: 80 },      // first/last milestone-or-item trace
      // 'ms_a/foreign' is absent: the conversation belongs to another user.
    })
    // Invariant: every current pointer has an active link.
    assert.equal(db2.prepare(`SELECT COUNT(*) AS n FROM conversations c WHERE c.mission_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM mission_conversations l WHERE l.mission_id = c.mission_id AND l.convo_id = c.id AND l.ended_at IS NULL)`).get().n, 0)
    assert.equal(backfillMissionLinks(db2), 0, 'a non-empty table is never backfilled again')
    // A legitimate leave: the link ends AND the pointer moves off. (Ending the
    // link while the pointer stays is the rollback state the heal repairs.)
    db2.prepare("UPDATE mission_conversations SET ended_at=9999 WHERE convo_id='joiner'").run()
    db2.prepare("UPDATE conversations SET mission_id=NULL WHERE id='joiner'").run()
    db2.close()

    const db3 = openDb(p)
    assert.equal(db3.prepare('SELECT COUNT(*) AS n FROM mission_conversations').get().n, 5)
    assert.equal(db3.prepare("SELECT ended_at FROM mission_conversations WHERE convo_id='joiner'").get().ended_at, 9999, 'an ended link stays ended')
    db3.close()
  } finally { rmDb(p) }
})

test('backfill: a malformed mission-marker payload never aborts openDb; the link falls back to its non-marker joined_at', () => {
  const p = tmpPath('mc-backfill-bad-json')
  try {
    const db1 = openDb(p)
    db1.exec(`
      INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0);
      INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','dev-2','h',0);
      INSERT INTO conversations(id, owner_user_id, title, created_at, mission_id, parent_convo_id) VALUES
        ('origin',1,'o',100,'ms_a',NULL), ('joiner',1,'j',200,'ms_a',NULL);
      INSERT INTO missions(id,user_id,num,state,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at) VALUES
        ('ms_a',1,1,'open','A','origin',7,'agent',1000,1000);
      -- Malformed JSON: not valid, so json_extract would raise 'malformed JSON'
      -- without the json_valid guard. It carries a ts (150) earlier than the
      -- fallback (max(200,1000)=1000), so if it were (wrongly) used as the
      -- marker, joined_at would read 150 instead of 1000.
      INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload) VALUES
        (1, 10, 'joiner', 150, 'agent:dev-2', 'mission', '{not json');
      DELETE FROM mission_conversations;
    `)
    db1.close()

    const db2 = openDb(p) // must not throw
    assert.deepEqual(linkMap(db2), {
      'ms_a/joiner': { how: 'joined', joined_at: 1000, ended_at: null }, // marker ignored (invalid JSON); falls back to max(200,1000)
      'ms_a/origin': { how: 'origin', joined_at: 1000, ended_at: null },
    })
    db2.close()
  } finally { rmDb(p) }
})

test('backfill: a history trace from the Coordinator conversation (items it filed into missions) never becomes a link; a normal conversation\'s does', () => {
  const p = tmpPath('mc-backfill-coord')
  try {
    const db1 = openDb(p)
    db1.exec(`
      INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0);
      INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','dev-2','h',0);
      INSERT INTO user_settings(user_id, coordinator_convo_id, updated_at) VALUES(1,'coord',0);
      INSERT INTO conversations(id, owner_user_id, title, created_at, mission_id, parent_convo_id) VALUES
        ('coord',1,'c',100,NULL,NULL), ('mover',1,'m',200,NULL,NULL);
      INSERT INTO missions(id,user_id,num,state,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at) VALUES
        ('ms_x',1,1,'open','X','mover',7,'agent',50,50);
      INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at,mission_id) VALUES
        ('it_c',1,2,'task','open',1024,'moved by coord','coord',7,'agent',60,60,'ms_x'),
        ('it_m',1,3,'task','open',2048,'moved by mover','mover',7,'agent',70,70,'ms_x');
      DELETE FROM mission_conversations;
    `)
    db1.close()
    const db2 = openDb(p)
    assert.deepEqual(linkMap(db2), { 'ms_x/mover': { how: 'backfill', joined_at: 70, ended_at: 70 } })
    db2.close()
  } finally { rmDb(p) }
})

test('heal: every open restores the invariant after old code wrote a pointer with no active link (a rollback); a second open changes nothing', () => {
  const p = tmpPath('mc-heal')
  try {
    const db1 = openDb(p)
    db1.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
    db1.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','dev-2','h',0)").run()
    for (const id of ['c1', 'c2', 'c3']) upsertConversation(db1, { id, ownerUserId: 1, title: id, agentDeviceId: 7 })
    const a = createMission(db1, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', title: 'A' }).mission
    joinMission(db1, { userId: 1, missionId: a.id, convoId: 'c3' })
    // Old code: c2 is pointed at A with no link at all; c3's link was ended
    // but its pointer stayed.
    db1.prepare('UPDATE conversations SET mission_id=? WHERE id=?').run(a.id, 'c2')
    db1.prepare("UPDATE mission_conversations SET ended_at=5 WHERE convo_id='c3'").run()
    db1.close()

    const db2 = openDb(p)
    assert.ok(hasActiveLink(db2, a.id, 'c2'))
    assert.ok(hasActiveLink(db2, a.id, 'c3'))
    assert.equal(db2.prepare("SELECT how FROM mission_conversations WHERE convo_id='c2'").get().how, 'backfill')
    assert.equal(db2.prepare("SELECT how FROM mission_conversations WHERE convo_id='c3'").get().how, 'joined', 'a reactivated link keeps its how')
    assert.deepEqual(missionDetail(db2, 1, a.id).conversations.map((c) => c.id).sort(), ['c1', 'c2', 'c3'])
    assert.equal(leaveMission(db2, { userId: 1, missionId: a.id, convoId: 'c2' }).left, true)
    const before = linkMap(db2)
    db2.close()

    const db3 = openDb(p)
    assert.deepEqual(linkMap(db3), before, 'a second open changes nothing')
    assert.equal(healMissionLinks(db3), 0)
    db3.close()
  } finally { rmDb(p) }
})

function seeded() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(7,1,'agent','dev-2','h',0)").run()
  for (const id of ['c1', 'c2', 'c3']) upsertConversation(db, { id, ownerUserId: 1, title: id.toUpperCase(), agentDeviceId: 7 })
  return db
}
function withPrivateBox() {
  const db = seeded()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at, private) VALUES(9,1,'agent','priv-box','h2',0,1)").run()
  upsertConversation(db, { id: 'secret', ownerUserId: 1, title: 'S', agentDeviceId: 9 })
  return db
}
const linksOf = (db, convoId) => db.prepare('SELECT mission_id, how, ended_at FROM mission_conversations WHERE convo_id=? ORDER BY rowid').all(convoId)
const currentOf = (db, convoId) => db.prepare('SELECT mission_id FROM conversations WHERE id=?').get(convoId).mission_id
const startOn = (db, convoId, title, extra = {}) => createMission(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId, title, ...extra }).mission
const join = (db, missionId, convoId, extra = {}) => joinMission(db, { userId: 1, missionId, convoId, ...extra })
function packLinks(db, missionId, n, prefix) {
  const conv = db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, mission_id, created_at) VALUES(?,1,'x','running',?,0)")
  const link = db.prepare("INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at) VALUES(?,?,1,'joined',0)")
  for (let i = 0; i < n; i++) { conv.run(`${prefix}${i}`, missionId); link.run(missionId, `${prefix}${i}`) }
}

test('createMission: the attached origin gets an active origin link; attach:false links nothing', () => {
  const db = seeded()
  const a = startOn(db, 'c1', 'A')
  assert.deepEqual(linksOf(db, 'c1'), [{ mission_id: a.id, how: 'origin', ended_at: null }])
  startOn(db, 'c2', 'Parked', { attach: false })
  assert.deepEqual(linksOf(db, 'c2'), [])
  assert.equal(currentOf(db, 'c2'), null)
})

test('joinMission: a second mission becomes current and the first stays active; re-joining current is a no-op; joining an also-on mission is current_changed; closed refuses', () => {
  const db = seeded()
  const a = startOn(db, 'c1', 'A')
  const b = startOn(db, 'c2', 'B')
  const { item } = createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'task', title: 'T', originConvoId: 'c1' })
  const j = join(db, b.id, 'c1')
  assert.equal(j.action, 'joined'); assert.equal(j.mission.id, b.id)
  assert.equal(currentOf(db, 'c1'), b.id)
  assert.deepEqual(linksOf(db, 'c1'), [
    { mission_id: a.id, how: 'origin', ended_at: null },
    { mission_id: b.id, how: 'joined', ended_at: null },
  ])
  // An item already on a mission stays there; only unassigned items follow.
  assert.equal(db.prepare('SELECT mission_id FROM items WHERE id=?').get(item.id).mission_id, a.id)
  assert.equal(join(db, b.id, 'c1').action, null)
  const back = join(db, a.id, 'c1')
  assert.equal(back.action, 'current_changed'); assert.equal(currentOf(db, 'c1'), a.id)
  assert.equal(linksOf(db, 'c1').length, 2)
  closeMission(db, { userId: 1, missionId: b.id, by: 'user', summary: 'done' })
  assert.throws(() => join(db, b.id, 'c1'), /closed/)
})

test('joinMission: records the how it is given; a reactivated backfill link takes the new how', () => {
  const db = seeded()
  const a = startOn(db, 'c1', 'A')
  join(db, a.id, 'c2', { how: 'spawned' })
  assert.equal(linksOf(db, 'c2')[0].how, 'spawned')
  db.prepare("INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at, ended_at) VALUES(?, 'c3', 1, 'backfill', 1, 2)").run(a.id)
  assert.equal(join(db, a.id, 'c3').action, 'joined')
  assert.deepEqual(linksOf(db, 'c3'), [{ mission_id: a.id, how: 'joined', ended_at: null }])
})

test('activateLink: spawned replaces joined on a reactivation; nothing else upgrades or downgrades', () => {
  const db = seeded()
  const a = startOn(db, 'c1', 'A')
  const b = startOn(db, 'c2', 'B')
  join(db, a.id, 'c3')
  leaveMission(db, { userId: 1, missionId: a.id, convoId: 'c3' })
  join(db, a.id, 'c3', { how: 'spawned' })
  assert.deepEqual(linksOf(db, 'c3'), [{ mission_id: a.id, how: 'spawned', ended_at: null }], 'joined → spawned')
  leaveMission(db, { userId: 1, missionId: a.id, convoId: 'c3' })
  join(db, a.id, 'c3')
  assert.equal(linksOf(db, 'c3')[0].how, 'spawned', 'spawned is never downgraded to joined')
  join(db, b.id, 'c1', { how: 'spawned' })
  leaveMission(db, { userId: 1, missionId: a.id, convoId: 'c1' })
  join(db, a.id, 'c1', { how: 'spawned' })
  assert.equal(linksOf(db, 'c1').find((l) => l.mission_id === a.id).how, 'origin', 'origin is never replaced')
})

test('joinMission: the cap counts active top-level links only — a sub-chat always joins, an ended link frees a slot', () => {
  const db = seeded()
  const m = startOn(db, 'c1', 'A')
  packLinks(db, m.id, CONVOS_MAX - 1, 'pad')   // c1 + 199 = 200 top-level
  assert.throws(() => join(db, m.id, 'c2'), /too_many_convos/)
  assert.equal(currentOf(db, 'c2'), null)
  upsertConversation(db, { id: 'kid', ownerUserId: 1, title: 'k', agentDeviceId: 7, parentConvoId: 'c2' })
  assert.equal(join(db, m.id, 'kid').action, 'joined')
  db.prepare("UPDATE mission_conversations SET ended_at=1 WHERE convo_id='pad0'").run()
  assert.equal(join(db, m.id, 'c2').action, 'joined')
})

test('inheritance: a sub-chat inherits its parent\'s CURRENT mission with an inherited link, even when that mission is at the top-level cap', () => {
  const db = seeded()
  startOn(db, 'c1', 'A')
  const b = startOn(db, 'c2', 'B')
  join(db, b.id, 'c1')
  packLinks(db, b.id, CONVOS_MAX - 2, 'pad')   // c2 + c1 + 198 = 200 top-level
  upsertConversation(db, { id: 'kid', ownerUserId: 1, title: 'k', agentDeviceId: 7, parentConvoId: 'c1' })
  assert.equal(currentOf(db, 'kid'), b.id)
  assert.deepEqual(linksOf(db, 'kid'), [{ mission_id: b.id, how: 'inherited', ended_at: null }])
  // A later upsert never adds or changes a link.
  upsertConversation(db, { id: 'kid', ownerUserId: 1, title: 'k2' })
  assert.equal(linksOf(db, 'kid').length, 1)
})

const pinJoined = (db, missionId, convoId, at) =>
  db.prepare('UPDATE mission_conversations SET joined_at=? WHERE mission_id=? AND convo_id=?').run(at, missionId, convoId)

test('leaveMission: leaving the current falls back to the most recently joined open active link; leaving another keeps the pointer; a repeat is a no-op; rejoin reactivates', () => {
  const db = seeded()
  const a = startOn(db, 'c1', 'A'); const b = startOn(db, 'c2', 'B'); const c = startOn(db, 'c3', 'C')
  join(db, b.id, 'c1'); join(db, c.id, 'c1')
  // Pin the join order: Date.now() can repeat within a millisecond.
  pinJoined(db, a.id, 'c1', 100); pinJoined(db, b.id, 'c1', 200); pinJoined(db, c.id, 'c1', 300)
  const r = leaveMission(db, { userId: 1, missionId: c.id, convoId: 'c1' })
  assert.deepEqual([r.left, r.currentChanged, r.currentMissionId], [true, true, b.id])
  assert.equal(r.mission.id, c.id)
  assert.equal(currentOf(db, 'c1'), b.id)
  assert.ok(linksOf(db, 'c1').find((l) => l.mission_id === c.id).ended_at > 0)
  const r2 = leaveMission(db, { userId: 1, missionId: a.id, convoId: 'c1' })
  assert.deepEqual([r2.left, r2.currentChanged, r2.currentMissionId], [true, false, b.id])
  const r3 = leaveMission(db, { userId: 1, missionId: a.id, convoId: 'c1' })
  assert.equal(r3.left, false, 'an ended link: 200 no-op, never 404')
  assert.throws(() => leaveMission(db, { userId: 1, missionId: b.id, convoId: 'c3' }), /no_link/)
  assert.throws(() => leaveMission(db, { userId: 1, missionId: 'ms_nope', convoId: 'c1' }), /no_mission/)
  // Rejoining reactivates the ended link with its original how.
  assert.equal(join(db, a.id, 'c1').action, 'joined')
  assert.deepEqual(linksOf(db, 'c1').find((l) => l.mission_id === a.id), { mission_id: a.id, how: 'origin', ended_at: null })
  assert.equal(currentOf(db, 'c1'), a.id)
})

test('leaveMission: a closed mission is never the fallback — leaving the last open one leaves the conversation on none, and an unnamed milestone then answers no_mission', () => {
  const db = seeded()
  const a = startOn(db, 'c1', 'A'); const b = startOn(db, 'c2', 'B')
  join(db, b.id, 'c1')
  closeMission(db, { userId: 1, missionId: a.id, by: 'user', summary: 'done' })
  const r = leaveMission(db, { userId: 1, missionId: b.id, convoId: 'c1' })
  assert.deepEqual([r.left, r.currentChanged, r.currentMissionId], [true, false, null])
  assert.equal(currentOf(db, 'c1'), null)
  assert.equal(linksOf(db, 'c1').find((l) => l.mission_id === a.id).ended_at, null, 'the closed mission keeps its active link as history')
  const appendMarker = (payload) => append(db, { userId: 1, convoId: 'c1', sender: 'agent:dev-2', type: 'milestone', payload })
  assert.throws(() => createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 'x', appendMarker }), /no_mission/)
})

test('missionDetail: rows carry current/how/joined_at/ended_at/parent_convo_id/subchat_count; active only by default, ended after them with history; sub-chats fold under their nearest linked ancestor unless subchats; sieved', () => {
  const db = withPrivateBox()
  const a = startOn(db, 'c1', 'A'); const b = startOn(db, 'c2', 'B')
  upsertConversation(db, { id: 'kid', ownerUserId: 1, title: 'kid', agentDeviceId: 7, parentConvoId: 'c1' })       // inherits A
  upsertConversation(db, { id: 'grandkid', ownerUserId: 1, title: 'gk', agentDeviceId: 7, parentConvoId: 'kid' })  // inherits A
  upsertConversation(db, { id: 'pkid', ownerUserId: 1, title: 'pk', agentDeviceId: 9, parentConvoId: 'c1' })       // private sub-chat, inherits A
  upsertConversation(db, { id: 'c4', ownerUserId: 1, title: 'C4', agentDeviceId: 7 })
  upsertConversation(db, { id: 'stray', ownerUserId: 1, title: 'st', agentDeviceId: 7, parentConvoId: 'c4' })      // parent not on A
  join(db, a.id, 'c2')              // c2 current on A, B stays active
  join(db, a.id, 'stray')
  join(db, a.id, 'c3'); leaveMission(db, { userId: 1, missionId: a.id, convoId: 'c3' })
  for (const [id, at] of [['c1', 100], ['kid', 110], ['grandkid', 120], ['pkid', 130], ['c3', 150], ['c2', 200], ['stray', 300]]) pinJoined(db, a.id, id, at)

  const row = (c) => [c.id, c.current, c.how, c.ended_at === null, c.subchat_count]
  const active = [
    ['c1', true, 'origin', true, 3],
    ['c2', true, 'joined', true, 0],
    ['stray', true, 'joined', true, 0],   // parent c4 is not on A: never hidden
  ]
  // Default (spec §7): an old app copies this list into its members table
  // without reading ended_at, so a conversation that left is not on it.
  const full = missionDetail(db, 1, a.id)
  assert.deepEqual(full.conversations.map(row), active)
  const c1 = full.conversations[0]
  for (const k of ['id', 'title', 'state', 'box', 'parent_convo_id', 'current', 'how', 'joined_at', 'ended_at', 'subchat_count', 'other_missions']) assert.ok(k in c1, k)
  assert.deepEqual([c1.title, c1.box, c1.parent_convo_id, c1.joined_at], ['C1', 'dev-2', null, 100])
  assert.equal(full.conversations.find((c) => c.id === 'stray').parent_convo_id, 'c4')
  assert.deepEqual(full.conversations[1].other_missions.map((m) => [m.id, m.current, m.active]), [[b.id, false, true]], 'c2 is also on B')
  // history: the ended link follows every active row, with ended_at set.
  const hist = missionDetail(db, 1, a.id, { history: true })
  assert.deepEqual(hist.conversations.map(row), [...active, ['c3', false, 'joined', false, 0]])
  assert.ok(hist.conversations[3].ended_at >= hist.conversations[3].joined_at)
  const expanded = missionDetail(db, 1, a.id, { subchats: true })
  assert.deepEqual(expanded.conversations.map((c) => c.id), ['c1', 'kid', 'grandkid', 'pkid', 'c2', 'stray'])
  assert.deepEqual(expanded.conversations.slice(1, 4).map((c) => [c.parent_convo_id, c.how]), [['c1', 'inherited'], ['kid', 'inherited'], ['c1', 'inherited']])
  const both = missionDetail(db, 1, a.id, { subchats: true, history: true })
  assert.deepEqual(both.conversations.map((c) => c.id), ['c1', 'kid', 'grandkid', 'pkid', 'c2', 'stray', 'c3'])
  const sieved = missionDetail(db, 1, a.id, { excludePrivateOwned: true })
  assert.equal(sieved.conversations[0].subchat_count, 2, 'the private sub-chat is neither listed nor counted')
  assert.equal(missionDetail(db, 1, a.id, { excludePrivateOwned: true, subchats: true }).conversations.some((c) => c.id === 'pkid'), false)
  // The row count is active TOP-LEVEL links: c1 and c2 (stray is a sub-chat; c3 ended).
  assert.equal(getMission(db, 1, a.id).conversations, 2)
})

test('missionDetail history: an ended sub-chat never folds into an active row, so subchat_count is the same with or without history', () => {
  const db = seeded()
  const a = startOn(db, 'c1', 'A')
  upsertConversation(db, { id: 'kid', ownerUserId: 1, title: 'kid', agentDeviceId: 7, parentConvoId: 'c1' })
  upsertConversation(db, { id: 'kid2', ownerUserId: 1, title: 'kid2', agentDeviceId: 7, parentConvoId: 'c1' })
  leaveMission(db, { userId: 1, missionId: a.id, convoId: 'kid2' })
  pinJoined(db, a.id, 'c1', 100); pinJoined(db, a.id, 'kid', 110); pinJoined(db, a.id, 'kid2', 120)
  const counts = (d) => d.conversations.map((c) => [c.id, c.subchat_count])
  assert.deepEqual(counts(missionDetail(db, 1, a.id)), [['c1', 1]])
  assert.deepEqual(counts(missionDetail(db, 1, a.id, { history: true })), [['c1', 1], ['kid2', 0]])
})

test('foldSubchats: nearest linked ancestor, cycle-safe, input order kept', () => {
  const rows = [
    { id: 'a', parent_convo_id: null }, { id: 'b', parent_convo_id: 'a' }, { id: 'c', parent_convo_id: 'gone' },
    { id: 'd', parent_convo_id: 'c' }, { id: 'x', parent_convo_id: 'y' }, { id: 'y', parent_convo_id: 'x' },
  ]
  assert.deepEqual(foldSubchats(rows).map((r) => [r.id, r.subchat_count]), [['a', 1], ['c', 1], ['x', 0], ['y', 0]], 'a parent cycle folds nothing away')
  assert.deepEqual(foldSubchats(rows, { subchats: true }).map((r) => r.id), ['a', 'b', 'c', 'd', 'x', 'y'])
  assert.equal(rows[0].subchat_count, undefined, 'the input rows are not mutated')
})

test('conversationMissions: current first, then active newest-joined, then ended newest; link fields; a private-origin mission is hidden from a filtered caller', () => {
  const db = withPrivateBox()
  const a = startOn(db, 'c1', 'A'); const b = startOn(db, 'c2', 'B'); const c = startOn(db, 'c3', 'C')
  const h = createMission(db, { userId: 1, deviceId: 9, createdBy: 'agent', convoId: 'secret', title: 'Hidden' }).mission
  join(db, b.id, 'c1'); join(db, h.id, 'c1'); join(db, c.id, 'c1')
  leaveMission(db, { userId: 1, missionId: a.id, convoId: 'c1' })
  pinJoined(db, b.id, 'c1', 200); pinJoined(db, h.id, 'c1', 250); pinJoined(db, c.id, 'c1', 300)
  const full = conversationMissions(db, 1, 'c1')
  assert.deepEqual(full.map((m) => [m.id, m.current, m.active, m.how]), [
    [c.id, true, true, 'joined'], [h.id, false, true, 'joined'], [b.id, false, true, 'joined'], [a.id, false, false, 'origin'],
  ])
  assert.ok(full[3].ended_at > 0); assert.equal(full[0].ended_at, null); assert.equal(full[0].joined_at, 300)
  assert.equal(full[0].title, 'C'); assert.equal(typeof full[0].conversations, 'number')
  const sieved = conversationMissions(db, 1, 'c1', { excludePrivateOwned: true })
  assert.deepEqual(sieved.map((m) => m.id), [c.id, b.id, a.id])
  assert.equal(JSON.stringify(sieved).includes('Hidden'), false)
})

test('missionDetail other_missions: each row names the conversation\'s OTHER missions (current first, then active, then ended; capped); a private-origin one is hidden from a filtered caller', () => {
  const db = withPrivateBox()
  const a = startOn(db, 'c1', 'A'); const b = startOn(db, 'c2', 'B')
  const h = createMission(db, { userId: 1, deviceId: 9, createdBy: 'agent', convoId: 'secret', title: 'Hidden' }).mission
  join(db, b.id, 'c1')                  // c1: B current, A also-on
  const rowOf = (detail, id) => detail.conversations.find((c) => c.id === id)
  const onB = missionDetail(db, 1, b.id)
  assert.deepEqual(rowOf(onB, 'c1').other_missions.map((m) => [m.num, m.title, m.current, m.active]), [[a.num, 'A', false, true]])
  assert.deepEqual(rowOf(onB, 'c2').other_missions, [], 'c2 is on B only')
  const onA = missionDetail(db, 1, a.id)
  const other = rowOf(onA, 'c1').other_missions
  assert.deepEqual(other.map((m) => [m.id, m.current, m.active, m.ended_at]), [[b.id, true, true, null]])
  for (const k of ['id', 'num', 'title', 'current', 'active', 'joined_at', 'ended_at']) assert.ok(k in other[0], k)
  // Leaving B: c1's row on A now shows B as ended ("moved to" / "earlier").
  join(db, h.id, 'c1')                  // c1: H current, B and A active
  leaveMission(db, { userId: 1, missionId: b.id, convoId: 'c1' })
  const full = rowOf(missionDetail(db, 1, a.id), 'c1').other_missions
  assert.deepEqual(full.map((m) => [m.id, m.current, m.active]), [[h.id, true, true], [b.id, false, false]])
  const sieved = rowOf(missionDetail(db, 1, a.id, { excludePrivateOwned: true }), 'c1').other_missions
  assert.deepEqual(sieved.map((m) => m.id), [b.id], 'the private-origin mission is neither named nor counted')
  assert.equal(JSON.stringify(sieved).includes('Hidden'), false)
  // Capped: c3 on A plus six more missions lists only OTHER_MISSIONS_MAX of them.
  join(db, a.id, 'c3')
  for (let i = 0; i < 6; i++) join(db, startOn(db, 'c3', `X${i}`, { attach: false }).id, 'c3')
  assert.equal(OTHER_MISSIONS_MAX, 5)
  const capped = rowOf(missionDetail(db, 1, a.id), 'c3').other_missions
  assert.equal(capped.length, OTHER_MISSIONS_MAX)
  assert.equal(capped[0].current, true, 'the current mission is never the one cut')
})

test('missionDetail: a filtered caller never learns a hidden (private-device) parent\'s id through a sub-chat row; the owner does', () => {
  const db = withPrivateBox()
  const a = startOn(db, 'secret', 'Private-born', { deviceId: 9 })
  upsertConversation(db, { id: 'pubkid', ownerUserId: 1, title: 'pk', agentDeviceId: 7, parentConvoId: 'secret' })  // inherits a
  upsertConversation(db, { id: 'c4', ownerUserId: 1, title: 'C4', agentDeviceId: 7 })
  upsertConversation(db, { id: 'stray', ownerUserId: 1, title: 'st', agentDeviceId: 7, parentConvoId: 'c4' })
  const b = startOn(db, 'c1', 'Public')
  join(db, b.id, 'pubkid'); join(db, b.id, 'stray')
  const rowOf = (d, id) => d.conversations.find((c) => c.id === id)
  const owner = missionDetail(db, 1, b.id)
  assert.equal(rowOf(owner, 'pubkid').parent_convo_id, 'secret')
  const sieved = missionDetail(db, 1, b.id, { excludePrivateOwned: true })
  assert.equal(rowOf(sieved, 'pubkid').parent_convo_id, null)
  assert.equal(JSON.stringify(sieved.conversations).includes('secret'), false)
  assert.equal(rowOf(sieved, 'stray').parent_convo_id, 'c4', 'a visible parent off the mission is still named')
  assert.equal(a.origin_convo_id, 'secret')
})

test('createMilestone: default posts to the current mission; mission names any ACTIVE link; ended, unrelated, unknown or hidden → not_linked and nothing is written', () => {
  const db = withPrivateBox()
  const a = startOn(db, 'c1', 'A'); const b = startOn(db, 'c2', 'B'); const c = startOn(db, 'c3', 'C')
  const h = createMission(db, { userId: 1, deviceId: 9, createdBy: 'agent', convoId: 'secret', title: 'Hidden' }).mission
  join(db, h.id, 'c1'); join(db, b.id, 'c1')   // c1: A origin, H active, B current
  const appendMarker = (payload) => append(db, { userId: 1, convoId: 'c1', sender: 'agent:dev-2', type: 'milestone', payload })
  const post = (extra) => createMilestone(db, { userId: 1, deviceId: 7, createdBy: 'agent', convoId: 'c1', kind: 'progress', title: 't', appendMarker, ...extra })
  assert.equal(post({}).mission.id, b.id, 'no name → the NEW current mission')
  assert.equal(post({ missionRef: `#${a.num}` }).mission.id, a.id)
  assert.equal(post({ missionRef: a.num }).mission.id, a.id)
  assert.equal(post({ missionRef: a.id }).mission.id, a.id)
  leaveMission(db, { userId: 1, missionId: a.id, convoId: 'c1' })
  const before = db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n
  const events = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='milestone'").get().n
  for (const ref of [a.id, `#${c.num}`, '#9999', 'nonsense']) assert.throws(() => post({ missionRef: ref }), /not_linked/, String(ref))
  assert.throws(() => post({ missionRef: h.id, excludePrivateOwned: true }), /not_linked/, 'hidden to a filtered caller')
  assert.equal(post({ missionRef: h.id }).mission.id, h.id, 'the unfiltered caller may')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n, before + 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='milestone'").get().n, events + 1)
})

test('snapshot: rows carry the current mission_id and mission_count (every link, ended ones too); a filtered caller loses private-origin missions from both', () => {
  const db = withPrivateBox()
  const a = startOn(db, 'c1', 'A'); const b = startOn(db, 'c2', 'B')
  join(db, b.id, 'c1'); leaveMission(db, { userId: 1, missionId: a.id, convoId: 'c1' })   // c1: B current, A ended
  const h = createMission(db, { userId: 1, deviceId: 9, createdBy: 'agent', convoId: 'secret', title: 'Hidden' }).mission
  join(db, h.id, 'c3')                                                                     // user put public c3 on a private-origin mission
  const row = (snap, id) => snap.conversations.find((c) => c.id === id)
  const full = snapshot(db, 1)
  assert.deepEqual([row(full, 'c1').mission_id, row(full, 'c1').mission_count], [b.id, 2])
  assert.deepEqual([row(full, 'c2').mission_id, row(full, 'c2').mission_count], [b.id, 1])
  assert.deepEqual([row(full, 'c3').mission_id, row(full, 'c3').mission_count], [h.id, 1])
  const sieved = snapshot(db, 1, { excludePrivateOwned: true })
  assert.deepEqual([row(sieved, 'c3').mission_id, row(sieved, 'c3').mission_count], [null, 0])
  assert.deepEqual([row(sieved, 'c1').mission_id, row(sieved, 'c1').mission_count], [b.id, 2])
  assert.equal(row(sieved, 'secret'), undefined)
})

test('activityOf: closed > running > waiting (a waiting session or needs-you) > quiet (≥ 7 days) > idle', () => {
  const now = 100 * QUIET_MS
  const base = { state: 'open', running: 0, waiting: 0, needsYou: 0, lastActivityAt: now }
  assert.equal(QUIET_MS, 7 * 24 * 60 * 60 * 1000)
  assert.equal(activityOf({ ...base, state: 'closed', running: 2 }, now), 'closed')
  assert.equal(activityOf({ ...base, running: 1, waiting: 1, needsYou: 1 }, now), 'running')
  assert.equal(activityOf({ ...base, waiting: 1, lastActivityAt: 0 }, now), 'waiting')
  assert.equal(activityOf({ ...base, needsYou: 2, lastActivityAt: 0 }, now), 'waiting')
  assert.equal(activityOf({ ...base, lastActivityAt: now - QUIET_MS }, now), 'quiet')
  assert.equal(activityOf({ ...base, lastActivityAt: now - QUIET_MS + 1 }, now), 'idle')
})

test('mission rows: activity follows linked sessions, needs-you, messages and closing; last_activity_at; project fields present', () => {
  const db = seeded()
  const m = startOn(db, 'c1', 'A')
  const row = () => getMission(db, 1, m.id)
  assert.equal(row().activity, 'running')
  assert.equal(row().project_id, null); assert.equal(row().project_num, null)
  assert.ok(row().last_activity_at >= row().created_at)
  db.prepare("UPDATE conversations SET session_state='waiting' WHERE id='c1'").run()
  assert.equal(row().activity, 'waiting')
  db.prepare("UPDATE conversations SET session_state='done' WHERE id='c1'").run()
  assert.equal(row().activity, 'idle')
  const old = Date.now() - 8 * 24 * 60 * 60 * 1000
  db.prepare('UPDATE missions SET created_at=? WHERE id=?').run(old, m.id)
  db.prepare('UPDATE mission_conversations SET joined_at=? WHERE mission_id=?').run(old, m.id)
  assert.equal(row().activity, 'quiet'); assert.equal(row().last_activity_at, old)
  append(db, { userId: 1, convoId: 'c1', sender: 'agent:dev-2', type: 'text', payload: { body: 'back' } })
  assert.equal(row().activity, 'idle', 'a message in a linked conversation is activity')
  createItem(db, { userId: 1, originDeviceId: 7, createdBy: 'agent', kind: 'question', title: 'Q?', originConvoId: 'c1' })
  assert.equal(row().activity, 'waiting', 'needs-you')
  closeMission(db, { userId: 1, missionId: m.id, by: 'user', summary: 'done' })
  assert.equal(row().activity, 'closed')
})

test('activity is sieved: a private box\'s running session or a privately written status never makes a mission look live to an ordinary agent', () => {
  const db = withPrivateBox()
  const m = startOn(db, 'c1', 'A')
  db.prepare("UPDATE conversations SET session_state='done' WHERE id='c1'").run()
  join(db, m.id, 'secret')
  assert.equal(getMission(db, 1, m.id).activity, 'running')
  assert.equal(getMission(db, 1, m.id, { excludePrivateOwned: true }).activity, 'idle')
  const old = Date.now() - 8 * 24 * 60 * 60 * 1000
  db.prepare("UPDATE conversations SET session_state='done' WHERE id='secret'").run()
  db.prepare('UPDATE missions SET created_at=? WHERE id=?').run(old, m.id)
  db.prepare('UPDATE mission_conversations SET joined_at=? WHERE mission_id=?').run(old, m.id)
  updateMission(db, { userId: 1, missionId: m.id, fields: { status: 'Private progress' }, statusWriter: { by: 'agent', convoId: 'secret', deviceId: 9 } })
  assert.equal(getMission(db, 1, m.id).activity, 'idle', 'the fresh status counts for the owner')
  assert.equal(getMission(db, 1, m.id, { excludePrivateOwned: true }).activity, 'quiet', 'but not through the sieve')
})
