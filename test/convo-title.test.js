// Conversations named after their current mission (src/convo-title.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, snapshot, append } from '../src/journal.js'
import { searchMessages } from '../src/search.js'
import { composeTitle, missionLabel, autoTitleColumns, MISSION_NAME_MAX } from '../src/convo-title.js'
import { titlePrefix, sessionShortFromTitle } from '../src/room-title.js'
import { createMission, joinMission, leaveMission, updateMission, missionDetail, validateMissionFields } from '../src/missions.js'
import { recordJoined } from '../src/participants.js'
import { startTestServer, makeWsClient } from './helpers.js'

// ---------------------------------------------------------------------------
// The pure parts.
// ---------------------------------------------------------------------------

test('titlePrefix reads the marker(s) and short; no short means no marker either', () => {
  assert.deepEqual(titlePrefix('[ab] Fix the thing'), { marker: '', short: 'ab' })
  assert.deepEqual(titlePrefix('🐣 [cd] Spawned'), { marker: '🐣', short: 'cd' })
  assert.deepEqual(titlePrefix('↔️ [ef] Room'), { marker: '↔️', short: 'ef' })
  assert.deepEqual(titlePrefix('host bridge'), { marker: '', short: '' })
  assert.deepEqual(titlePrefix('🐣 no short'), { marker: '', short: '' })
  assert.deepEqual(titlePrefix('[WIP] ship it'), { marker: '', short: '' })
  assert.deepEqual(titlePrefix(null), { marker: '', short: '' })
  assert.deepEqual(autoTitleColumns('🐣 [cd] Spawned'), { auto_title: '🐣 [cd] Spawned', session_short: 'cd', title_marker: '🐣' })
  assert.deepEqual(autoTitleColumns('matron-journal'), { auto_title: 'matron-journal', session_short: null, title_marker: null })
})

test('missionLabel: the name when set, else the title cut at a word boundary to 40 with an ellipsis', () => {
  assert.equal(missionLabel({ name: '  Launch  ', title: 'Something much longer than the name' }), 'Launch')
  assert.equal(missionLabel({ name: '', title: 'Short title' }), 'Short title')
  assert.equal(missionLabel({ name: null, title: 'x'.repeat(40) }), 'x'.repeat(40), 'exactly 40 is not cut')
  const cut = missionLabel({ title: 'Conversations are named after their current mission everywhere' })
  assert.equal(cut, 'Conversations are named after their…')
  assert.ok([...cut].length <= 40)
  // The cut lands exactly on a space: the whole word before it is kept.
  assert.equal(missionLabel({ title: `${'a'.repeat(39)} tail` }), `${'a'.repeat(39)}…`)
  // Trailing punctuation before the cut is dropped, not left before the …
  assert.equal(missionLabel({ title: 'Ship the thing, then the other thing, then more' }), 'Ship the thing, then the other thing…')
  // One word longer than the cap: cut mid-word.
  assert.equal(missionLabel({ title: 'y'.repeat(60) }), `${'y'.repeat(39)}…`)
  // Code points, not UTF-16 units: an emoji is never split.
  const emoji = missionLabel({ title: '🚀'.repeat(50) })
  assert.equal(emoji, `${'🚀'.repeat(39)}…`)
})

test('composeTitle: marker and short kept, mission label after; anything unsuitable keeps the auto title', () => {
  const mission = { name: null, title: 'Mission-named conversations' }
  assert.equal(composeTitle({ autoTitle: '[ab] Fix it', short: 'ab', mission }), '[ab] Mission-named conversations')
  assert.equal(composeTitle({ autoTitle: '🐣 [ab] Fix it', marker: '🐣', short: 'ab', mission }), '🐣 [ab] Mission-named conversations')
  assert.equal(composeTitle({ autoTitle: '[ab] Fix it', short: 'ab', mission: { name: 'Naming', title: 'ignored' } }), '[ab] Naming')
  assert.equal(composeTitle({ autoTitle: '[ab] Fix it', short: 'ab', mission: null }), '[ab] Fix it', 'no mission')
  assert.equal(composeTitle({ autoTitle: 'host bridge', short: '', mission }), 'host bridge', 'no short')
  assert.equal(composeTitle({ autoTitle: '[ab] Fix it', short: 'ab', mission, excluded: true }), '[ab] Fix it', 'excluded row')
  assert.equal(composeTitle({ autoTitle: '↔️ [ab] Room', marker: '↔️', short: 'ab', mission }), '↔️ [ab] Room', 'room marker')
  assert.equal(composeTitle({ autoTitle: '🔗 [ab] Room', marker: '🔗', short: 'ab', mission }), '🔗 [ab] Room', 'legacy room marker')
  assert.equal(composeTitle({ autoTitle: '[ab] D:ab ↔️ E:cd', short: 'ab', mission }), '[ab] D:ab ↔️ E:cd', 'room title shape')
  assert.equal(composeTitle({ autoTitle: '[ab] Fix it', short: 'ab', mission: { name: '', title: '   ' } }), '[ab] Fix it', 'empty label')
  assert.equal(composeTitle({ autoTitle: null, short: '', mission }), '')
  // The composed title still parses back to the same short — every short
  // reader (spawn room tags, the apps' SessionTag) keeps working.
  assert.equal(sessionShortFromTitle(composeTitle({ autoTitle: '🐣 [cd] x', marker: '🐣', short: 'cd', mission })), 'cd')
})

test('validateMissionFields: name trimmed, empty is none, over 40 refused with a detail; projects ignore it', () => {
  assert.deepEqual(validateMissionFields({ title: 'T', name: '  Launch ' }, { withName: true }), { ok: true, value: { title: 'T', name: 'Launch' } })
  assert.deepEqual(validateMissionFields({ title: 'T', name: '   ' }, { withName: true }), { ok: true, value: { title: 'T', name: null } })
  assert.deepEqual(validateMissionFields({ name: null }, { partial: true, withName: true }), { ok: true, value: { name: null } })
  assert.deepEqual(validateMissionFields({ title: 'T', name: 'n'.repeat(MISSION_NAME_MAX) }, { withName: true }).value.name, 'n'.repeat(40))
  assert.deepEqual(validateMissionFields({ title: 'T', name: 'n'.repeat(41) }, { withName: true }), { ok: false, detail: 'name_too_long' })
  assert.deepEqual(validateMissionFields({ title: 'T', name: 7 }, { withName: true }), { ok: false, detail: 'bad_name' })
  assert.deepEqual(validateMissionFields({ title: 'T', name: 'a\nb' }, { withName: true }), { ok: false, detail: 'bad_name' })
  assert.deepEqual(validateMissionFields({ title: 'T', name: 'Launch' }), { ok: true, value: { title: 'T' } })
})

// ---------------------------------------------------------------------------
// The journal's state.
// ---------------------------------------------------------------------------

async function seed() {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const box = createAgent(db, alice.id, 'box-2')
  const up = (id, title, extra = {}) => upsertConversation(db, { id, ownerUserId: alice.id, title, sessionState: 'running', agentDeviceId: box.deviceId, ...extra })
  const mission = (convoId, title, more = {}) => createMission(db, { userId: alice.id, deviceId: box.deviceId, createdBy: 'agent', convoId, title, ...more })
  const row = (id) => db.prepare('SELECT title, auto_title, session_short, title_marker FROM conversations WHERE id=?').get(id)
  return { db, alice, box, up, mission, row }
}

test('convo_upsert without a mission keeps today\'s title; with one, the title is the mission\'s and auto_title the bridge\'s', async () => {
  const { db, alice, up, mission, row } = await seed()
  const r = up('c1', '[ab] Fix the login bug')
  assert.equal(r.title, '[ab] Fix the login bug')
  assert.deepEqual(row('c1'), { title: '[ab] Fix the login bug', auto_title: '[ab] Fix the login bug', session_short: 'ab', title_marker: null })

  const out = mission('c1', 'Login overhaul')
  assert.deepEqual(out.retitled.map((c) => [c.id, c.title]), [['c1', '[ab] Login overhaul']])
  assert.equal(row('c1').title, '[ab] Login overhaul')

  // The bridge's next title lands in auto_title; the display title holds.
  const again = up('c1', '[ab] Now fixing the logout bug')
  assert.equal(again.title, '[ab] Login overhaul')
  assert.equal(again.auto_title, '[ab] Now fixing the logout bug')
  assert.equal(again.metaChanged, true, 'auto_title changed: apps learn the new second line')
  assert.equal(up('c1', '[ab] Now fixing the logout bug').metaChanged, false, 'nothing changed')
  // A state-only upsert touches neither.
  assert.equal(up('c1', undefined).title, '[ab] Login overhaul')

  // The snapshot carries both.
  const snap = snapshot(db, alice.id).conversations.find((c) => c.id === 'c1')
  assert.equal(snap.title, '[ab] Login overhaul')
  assert.equal(snap.auto_title, '[ab] Now fixing the logout bug')
})

test('a title with no short is never mission-named ("host bridge")', async () => {
  const { up, mission, row } = await seed()
  up('host', 'host bridge')
  mission('host', 'Something')
  assert.equal(row('host').title, 'host bridge')
})

test('join, leave and the nextCurrent move each recompose the title', async () => {
  const { db, alice, up, mission, row } = await seed()
  up('c1', '🐣 [ab] Spawned topic')
  up('c2', '[cd] Other')
  const a = mission('c1', 'Mission A').mission
  const b = mission('c2', 'Mission B').mission
  assert.equal(row('c1').title, '🐣 [ab] Mission A')

  const j = joinMission(db, { userId: alice.id, missionId: b.id, convoId: 'c1' })
  assert.deepEqual(j.retitled.map((c) => c.title), ['🐣 [ab] Mission B'])
  assert.equal(joinMission(db, { userId: alice.id, missionId: b.id, convoId: 'c1' }).retitled.length, 0, 'already current: no-op')

  // Leaving the current one falls back to A, still active.
  const l = leaveMission(db, { userId: alice.id, missionId: b.id, convoId: 'c1' })
  assert.equal(l.currentMissionId, a.id)
  assert.deepEqual(l.retitled.map((c) => c.title), ['🐣 [ab] Mission A'])

  // Leaving the last one: back to the bridge's own title.
  const last = leaveMission(db, { userId: alice.id, missionId: a.id, convoId: 'c1' })
  assert.equal(last.currentMissionId, null)
  assert.deepEqual(last.retitled.map((c) => c.title), ['🐣 [ab] Spawned topic'])
  assert.equal(row('c1').title, '🐣 [ab] Spawned topic')
})

test('a mission title or name edit recomposes every conversation whose current mission it is', async () => {
  const { db, alice, up, mission, row } = await seed()
  up('c1', '[ab] One'); up('c2', '[cd] Two'); up('c3', '[ef] Three')
  const m = mission('c1', 'Original').mission
  joinMission(db, { userId: alice.id, missionId: m.id, convoId: 'c2' })
  const other = mission('c3', 'Elsewhere').mission
  joinMission(db, { userId: alice.id, missionId: m.id, convoId: 'c3' })
  joinMission(db, { userId: alice.id, missionId: other.id, convoId: 'c3' }) // c3: on m, but other is current

  let retitled = []
  const onRetitled = (rows) => { retitled = rows }
  updateMission(db, { userId: alice.id, missionId: m.id, fields: { title: 'Renamed' }, onRetitled })
  assert.deepEqual(retitled.map((c) => [c.id, c.title]).sort(), [['c1', '[ab] Renamed'], ['c2', '[cd] Renamed']])
  assert.equal(row('c3').title, '[ef] Elsewhere')

  updateMission(db, { userId: alice.id, missionId: m.id, fields: { name: 'Short' }, onRetitled })
  assert.deepEqual(retitled.map((c) => c.title).sort(), ['[ab] Short', '[cd] Short'])
  updateMission(db, { userId: alice.id, missionId: m.id, fields: { title: 'Renamed again' }, onRetitled })
  assert.deepEqual(retitled, [], 'the name still wins: nothing changed')
  updateMission(db, { userId: alice.id, missionId: m.id, fields: { name: null }, onRetitled })
  assert.deepEqual(retitled.map((c) => c.title).sort(), ['[ab] Renamed again', '[cd] Renamed again'])
  // A body edit recomposes nothing.
  retitled = 'untouched'
  updateMission(db, { userId: alice.id, missionId: m.id, fields: { body: 'b' }, onRetitled })
  assert.equal(retitled, 'untouched')
})

test('createMission stores the name and names the conversation with it', async () => {
  const { up, mission, row } = await seed()
  up('c1', '[ab] Topic')
  const out = mission('c1', 'A long mission title nobody wants in a chat list', { name: 'Launch' })
  assert.equal(out.mission.name, 'Launch')
  assert.equal(row('c1').title, '[ab] Launch')
})

test('excluded rows keep the bridge\'s title: sub-chats, rooms, spawn rooms and private-origin missions', async () => {
  const { db, alice, box, up, mission, row } = await seed()
  up('parent', '[ab] Parent')
  const m = mission('parent', 'Mission').mission
  // A sub-chat inherits the mission at creation but is never renamed.
  up('child', '[cd] Subagent work', { parentConvoId: 'parent' })
  assert.equal(db.prepare('SELECT mission_id FROM conversations WHERE id=?').get('child').mission_id, m.id)
  assert.equal(row('child').title, '[cd] Subagent work')
  // An agent-chat room joined to the mission.
  const peer = createAgent(db, alice.id, 'box-3')
  up('room', '[ef] Room talk')
  recordJoined(db, { convoId: 'room', agentDeviceId: peer.deviceId, initiatorDeviceId: box.deviceId })
  joinMission(db, { userId: alice.id, missionId: m.id, convoId: 'room' })
  assert.equal(row('room').title, '[ef] Room talk')
  // A ↔️ room title, even without a participant row.
  up('room2', '↔️ [gh] Chat')
  joinMission(db, { userId: alice.id, missionId: m.id, convoId: 'room2' })
  assert.equal(row('room2').title, '↔️ [gh] Chat')
  // A mission born on a private box never names a public conversation.
  const priv = createAgent(db, alice.id, 'secret')
  db.prepare('UPDATE devices SET private=1 WHERE id=?').run(priv.deviceId)
  upsertConversation(db, { id: 'pc', ownerUserId: alice.id, title: '[pp] Private', agentDeviceId: priv.deviceId })
  const pm = createMission(db, { userId: alice.id, deviceId: priv.deviceId, createdBy: 'agent', convoId: 'pc', title: 'Secret plan' }).mission
  assert.equal(row('pc').title, '[pp] Secret plan', 'a private conversation may carry its own mission\'s name')
  up('pub', '[qq] Public')
  joinMission(db, { userId: alice.id, missionId: pm.id, convoId: 'pub' })
  assert.equal(row('pub').title, '[qq] Public')
})

test('missionDetail lists auto_title beside title', async () => {
  const { db, alice, up, mission } = await seed()
  up('c1', '[ab] Topic')
  const m = mission('c1', 'Mission').mission
  const d = missionDetail(db, alice.id, m.id)
  assert.equal(d.conversations[0].title, '[ab] Mission')
  assert.equal(d.conversations[0].auto_title, '[ab] Topic')
})

test('migration: an existing database gains the columns and auto_title/short/marker are backfilled from title', () => {
  const dbPath = path.join(os.tmpdir(), `convo-title-migration-${process.pid}-${Date.now()}.sqlite`)
  try {
    const db1 = openDb(dbPath)
    db1.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'alice','x',0)").run()
    const ins = db1.prepare("INSERT INTO conversations(id, owner_user_id, title, created_at) VALUES(?,1,?,0)")
    ins.run('a', '🐣 [ab] Spawned'); ins.run('b', 'host bridge'); ins.run('c', '[cd] Plain')
    db1.close()
    const raw = new Database(dbPath)
    for (const c of ['auto_title', 'session_short', 'title_marker']) raw.exec(`ALTER TABLE conversations DROP COLUMN ${c}`)
    raw.exec('ALTER TABLE missions DROP COLUMN name')
    raw.close()

    const db = openDb(dbPath)
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
    for (const c of ['auto_title', 'session_short', 'title_marker']) assert.ok(cols('conversations').includes(c))
    assert.ok(cols('missions').includes('name'))
    const rows = db.prepare('SELECT id, title, auto_title, session_short, title_marker FROM conversations ORDER BY id').all()
    assert.deepEqual(rows, [
      { id: 'a', title: '🐣 [ab] Spawned', auto_title: '🐣 [ab] Spawned', session_short: 'ab', title_marker: '🐣' },
      { id: 'b', title: 'host bridge', auto_title: 'host bridge', session_short: null, title_marker: null },
      { id: 'c', title: '[cd] Plain', auto_title: '[cd] Plain', session_short: 'cd', title_marker: null },
    ])
    db.close()
    // Idempotent: a second open changes nothing.
    const db3 = openDb(dbPath)
    assert.equal(db3.prepare('SELECT auto_title FROM conversations WHERE id=?').get('a').auto_title, '🐣 [ab] Spawned')
    db3.close()
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true })
  }
})

test('migration: existing conversations on a mission are named once, without convo_meta; rooms, sub-chats and system rows untouched', async () => {
  const dbPath = path.join(os.tmpdir(), `convo-title-recompose-${process.pid}-${Date.now()}.sqlite`)
  try {
    const db1 = openDb(dbPath)
    const alice = await createUser(db1, 'alice', 'pw')
    const box = createAgent(db1, alice.id, 'box-2')
    const peer = createAgent(db1, alice.id, 'box-3')
    const ins = db1.prepare('INSERT INTO conversations(id, owner_user_id, title, created_at, parent_convo_id, system, agent_device_id) VALUES(?,?,?,0,?,?,?)')
    ins.run('named', alice.id, '[ab] Generated topic', null, null, box.deviceId)
    ins.run('titled', alice.id, '🐣 [cd] Other topic', null, null, box.deviceId)
    ins.run('sub', alice.id, '[ef] Subagent', 'named', null, box.deviceId)
    ins.run('room', alice.id, '[gh] Room talk', null, null, box.deviceId)
    ins.run('sys', alice.id, '[ij] People', null, 'people', null)
    ins.run('host', alice.id, 'host bridge', null, null, box.deviceId)
    recordJoined(db1, { convoId: 'room', agentDeviceId: peer.deviceId, initiatorDeviceId: box.deviceId })
    const mk = db1.prepare(`INSERT INTO missions(id,user_id,num,state,title,name,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
      VALUES(?,?,?,'open',?,?,'named',?,'agent',0,0)`)
    mk.run('ms_named', alice.id, 901, 'A long mission title nobody wants in the list', 'Launch', box.deviceId)
    mk.run('ms_plain', alice.id, 902, 'Conversations are named after their current mission everywhere', null, box.deviceId)
    const on = db1.prepare('UPDATE conversations SET mission_id=? WHERE id=?')
    for (const id of ['named', 'sub', 'room', 'sys', 'host']) on.run('ms_named', id)
    on.run('ms_plain', 'titled')
    db1.close()
    // Back to the pre-migration shape: no auto_title columns, heal done.
    const raw = new Database(dbPath)
    for (const c of ['auto_title', 'session_short', 'title_marker']) raw.exec(`ALTER TABLE conversations DROP COLUMN ${c}`)
    raw.pragma('user_version = 1')
    raw.prepare('UPDATE conversations SET title=? WHERE id=?').run('[ab] Generated topic', 'named')
    raw.prepare('UPDATE conversations SET title=? WHERE id=?').run('🐣 [cd] Other topic', 'titled')
    const eventsBefore = raw.prepare('SELECT COUNT(*) n FROM events').get().n
    raw.close()

    const db = openDb(dbPath)
    const t = (id) => db.prepare('SELECT title, auto_title FROM conversations WHERE id=?').get(id)
    assert.deepEqual(t('named'), { title: '[ab] Launch', auto_title: '[ab] Generated topic' })
    assert.deepEqual(t('titled'), { title: '🐣 [cd] Conversations are named after their…', auto_title: '🐣 [cd] Other topic' })
    assert.equal(t('sub').title, '[ef] Subagent')
    assert.equal(t('room').title, '[gh] Room talk')
    assert.deepEqual(t('sys'), { title: '[ij] People', auto_title: null })
    assert.equal(t('host').title, 'host bridge')
    assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, eventsBefore, 'no convo_meta written')
    assert.equal(db.pragma('user_version', { simple: true }), 2)
    db.close()
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true })
  }
})

// ---------------------------------------------------------------------------
// The wire.
// ---------------------------------------------------------------------------

async function wired(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const box = createAgent(s.db, alice.id, 'box-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: null })
  const agent = await makeWsClient(s.base, { token: box.token, cursor: null })
  t.after(() => { client.close(); agent.close() })
  await client.waitFor((f) => f.op === 'hello_ok')
  await agent.waitFor((f) => f.op === 'hello_ok')
  const metas = (convoId) => client.journal().filter((f) => f.type === 'convo_meta' && f.convo_id === convoId).map((f) => f.payload)
  const waitMeta = (convoId, title) => client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta' && f.convo_id === convoId && f.payload.title === title)
  return { s, alice, box, client, agent, token: login.json.token, metas, waitMeta }
}

test('wire: convo_upsert, mission create/join/leave and rename fan convo_meta with title and auto_title', async (t) => {
  const { s, box, client, agent, metas, waitMeta } = await wired(t)
  agent.send({ op: 'convo_upsert', convo_id: 'c1', title: '[ab] Fix it', session_state: 'running' })
  const first = await waitMeta('c1', '[ab] Fix it')
  assert.deepEqual(first.payload, { title: '[ab] Fix it', auto_title: '[ab] Fix it', parent_convo_id: null, agent_device_id: box.deviceId, agent_kind: null, summary: "", summary_updated_at: 0, repo: null })

  const created = await s.http('/missions', { method: 'POST', token: box.token, body: { convo_id: 'c1', title: 'Mission one', name: '  M1 ' } })
  assert.equal(created.status, 201)
  assert.equal(created.json.mission.name, 'M1')
  const named = await waitMeta('c1', '[ab] M1')
  assert.equal(named.sender, 'journal')
  assert.deepEqual(named.payload, { title: '[ab] M1', auto_title: '[ab] Fix it', parent_convo_id: null, agent_device_id: box.deviceId, repo: null })

  // The bridge's new topic: display title holds, auto_title moves.
  agent.send({ op: 'convo_upsert', convo_id: 'c1', title: '[ab] New topic' })
  await client.waitFor((f) => f.type === 'convo_meta' && f.payload?.auto_title === '[ab] New topic')

  // Rename fan-out.
  const patched = await s.http(`/missions/${created.json.mission.num}`, { method: 'PATCH', token: box.token, body: { name: null, title: 'Mission one, renamed' } })
  assert.equal(patched.status, 200)
  assert.equal(patched.json.mission.name, null)
  await waitMeta('c1', '[ab] Mission one, renamed')

  // Join a second mission, then leave it and the first.
  agent.send({ op: 'convo_upsert', convo_id: 'c2', title: '[cd] Other' })
  await waitMeta('c2', '[cd] Other')
  const second = await s.http('/missions', { method: 'POST', token: box.token, body: { convo_id: 'c2', title: 'Mission two' } })
  await waitMeta('c2', '[cd] Mission two')
  assert.equal((await s.http(`/missions/${second.json.mission.num}/join`, { method: 'POST', token: box.token, body: { convo_id: 'c1' } })).status, 200)
  await waitMeta('c1', '[ab] Mission two')
  assert.equal((await s.http(`/missions/${second.json.mission.num}/leave`, { method: 'POST', token: box.token, body: { convo_id: 'c1' } })).status, 200)
  await waitMeta('c1', '[ab] Mission one, renamed')
  assert.equal((await s.http(`/missions/${created.json.mission.num}/leave`, { method: 'POST', token: box.token, body: { convo_id: 'c1' } })).status, 200)
  await waitMeta('c1', '[ab] New topic')

  // No meta for a no-op: re-sending the same title emits nothing.
  const before = metas('c1').length
  agent.send({ op: 'convo_upsert', convo_id: 'c1', title: '[ab] New topic' })
  agent.send({ op: 'convo_upsert', convo_id: 'c1', title: '[ab] Fence' })
  await client.waitFor((f) => f.type === 'convo_meta' && f.payload?.auto_title === '[ab] Fence')
  assert.equal(metas('c1').length, before + 1)

  // Snapshot and mission detail carry auto_title.
  const snap = await s.http('/snapshot', { token: box.token })
  const c2 = snap.json.conversations.find((c) => c.id === 'c2')
  assert.equal(c2.title, '[cd] Mission two'); assert.equal(c2.auto_title, '[cd] Other')
  const detail = await s.http(`/missions/${second.json.mission.num}`, { token: box.token })
  assert.equal(detail.json.conversations.find((c) => c.id === 'c2').auto_title, '[cd] Other')
})

test('wire: mission name validation answers 400 with a detail on create and update', async (t) => {
  const { s, box, agent, waitMeta } = await wired(t)
  agent.send({ op: 'convo_upsert', convo_id: 'c1', title: '[ab] Fix it' })
  await waitMeta('c1', '[ab] Fix it')
  const long = await s.http('/missions', { method: 'POST', token: box.token, body: { convo_id: 'c1', title: 'T', name: 'n'.repeat(41) } })
  assert.equal(long.status, 400)
  assert.deepEqual(long.json, { error: 'bad_request', detail: 'name_too_long' })
  const bad = await s.http('/missions', { method: 'POST', token: box.token, body: { convo_id: 'c1', title: 'T', name: 5 } })
  assert.deepEqual(bad.json, { error: 'bad_request', detail: 'bad_name' })
  const ok = await s.http('/missions', { method: 'POST', token: box.token, body: { convo_id: 'c1', title: 'T' } })
  assert.equal(ok.json.mission.name, null)
  const patch = await s.http(`/missions/${ok.json.mission.num}`, { method: 'PATCH', token: box.token, body: { name: 'n'.repeat(41) } })
  assert.equal(patch.status, 400)
  assert.equal(patch.json.detail, 'name_too_long')
  // The plain 400 (no detail) is unchanged for other bad fields.
  const noTitle = await s.http('/missions', { method: 'POST', token: box.token, body: { convo_id: 'c1' } })
  assert.deepEqual(noTitle.json, { error: 'bad_request' })
})

test('wire: /roster carries each session\'s current mission number', async (t) => {
  const { s, alice, box, agent, waitMeta } = await wired(t)
  agent.send({ op: 'convo_upsert', convo_id: 'c1', title: '[ab] One' })
  agent.send({ op: 'convo_upsert', convo_id: 'c2', title: '[cd] Two' })
  await waitMeta('c2', '[cd] Two')
  const m = await s.http('/missions', { method: 'POST', token: box.token, body: { convo_id: 'c1', title: 'Roster mission' } })
  const roster = await s.http('/roster', { token: box.token })
  const byId = Object.fromEntries(roster.json.conversations.map((c) => [c.id, c]))
  assert.equal(byId.c1.mission_num, m.json.mission.num)
  assert.equal(byId.c1.title, '[ab] Roster mission')
  assert.equal(byId.c2.mission_num, null)
  // A private-origin mission's number is withheld from an ordinary agent.
  const priv = createAgent(s.db, alice.id, 'secret')
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(priv.deviceId)
  upsertConversation(s.db, { id: 'pc', ownerUserId: alice.id, title: '[pp] P', agentDeviceId: priv.deviceId })
  const pm = createMission(s.db, { userId: alice.id, deviceId: priv.deviceId, createdBy: 'agent', convoId: 'pc', title: 'Secret' }).mission
  joinMission(s.db, { userId: alice.id, missionId: pm.id, convoId: 'c2' })
  const filtered = await s.http('/roster', { token: box.token })
  assert.equal(filtered.json.conversations.find((c) => c.id === 'c2').mission_num, null)
  const own = await s.http('/roster', { token: priv.token })
  assert.equal(own.json.conversations.find((c) => c.id === 'c2').mission_num, pm.num)
})

test('search hits carry the composed title', async () => {
  const { db, alice, up, mission } = await seed()
  up('c1', '[ab] Topic')
  mission('c1', 'Searchable')
  append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:box-2', type: 'text', payload: { body: 'needle in the haystack' } })
  const { hits } = searchMessages(db, alice.id, { query: 'needle' })
  assert.equal(hits[0].title, '[ab] Searchable')
})
