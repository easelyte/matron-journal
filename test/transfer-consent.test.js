import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { recordJoined } from '../src/participants.js'
import { getTransfer, transferDir, recordChunk } from '../src/transfers.js'
import { recordConsentDecision, coordinatorApprovalsSince, getTransferConsentEnabled, CONSENT_TRANSFER_DAILY_CAP_DEFAULT } from '../src/consent.js'
import { transferConsentItemFields, humanSize } from '../src/transfer-consent.js'
import { widenConsentDecisionKinds, addTransferCauses, addTransferRecipient, addTransferConsentSetting } from '../src/db.js'
import { recordCarryOn } from '../src/cause-hops.js'
import Database from 'better-sqlite3'

// The `transfer` consent kind (Task 2): the card filed as a tracker item
// when a transfer is created, the user's Approve / Decline tap on it, and
// the Coordinator's answer through /consent/pending and /consent/answer.

const CHUNK = 10
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-transfer-consent-'))
  return path.join(dir, 'test.db')
}

function addConvo(db, id, userId, deviceId, title = id) {
  db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, created_at, agent_device_id) VALUES(?,?,?,'running',?,?)")
    .run(id, userId, title, Date.now(), deviceId)
}

// alice: box-a owns the room and sends from its session "Notes writer";
// box-b is joined with its session "Reviewer"; coord-box runs the
// Coordinator. A client token for the user's taps. Every frame sent to a
// device is recorded.
async function fleet(t, opts = {}) {
  const dbPath = tmpDbPath()
  const s = await startTestServer({ dbPath, transferMaxBytes: 100, transferUserQuotaBytes: 1000, transferChunkBytes: CHUNK, ...opts })
  t.after(() => s.close())
  const mediaDir = path.join(path.dirname(dbPath), 'media')
  const alice = await createUser(s.db, 'alice', 'pw')
  const a = createAgent(s.db, alice.id, 'box-a')
  const b = createAgent(s.db, alice.id, 'box-b')
  const coord = createAgent(s.db, alice.id, 'coord-box')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'phone' } })
  addConvo(s.db, 'room', alice.id, a.deviceId, 'Design review')
  addConvo(s.db, 'sess-a', alice.id, a.deviceId, 'Notes writer')
  addConvo(s.db, 'sess-b', alice.id, b.deviceId, 'Reviewer')
  addConvo(s.db, 'coord', alice.id, coord.deviceId, 'Coordinator')
  recordJoined(s.db, { convoId: 'room', agentDeviceId: b.deviceId, initiatorDeviceId: a.deviceId })
  s.db.prepare("UPDATE convo_agents SET target_convo_id='sess-b' WHERE convo_id='room' AND agent_device_id=?").run(b.deviceId)
  const client = login.json.token
  assert.equal((await s.http('/coordinator', { method: 'PUT', token: client, body: { convo_id: 'coord' } })).status, 200)
  const sent = []
  const orig = s.hub.sendToDevice.bind(s.hub)
  s.hub.sendToDevice = (userId, deviceId, frame) => { sent.push({ deviceId, frame }); return orig(userId, deviceId, frame) }
  return { s, mediaDir, alice, a, b, coord, client, sent }
}

const createBody = (over = {}) => ({
  room_id: 'room', from_convo_id: 'sess-a', name: 'notes.txt', size: 25, sha256: 'a'.repeat(64),
  content_type: 'text/plain', reason: 'the notes you asked for', scan: { verdict: 'clean', findings: [] }, ...over,
})

async function createTransfer(f, over) {
  const r = await f.s.http('/transfers', { method: 'POST', token: f.a.token, body: createBody(over) })
  assert.equal(r.status, 201)
  return r.json.transfer_id
}

// One stored chunk on disk, so a decline has something to delete.
function fakeChunk(f, id) {
  const p = path.join(transferDir(f.mediaDir, id), '0')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'x'.repeat(CHUNK))
  recordChunk(f.s.db, id, 0, CHUNK)
}

const itemOf = (f, id) => f.s.db.prepare('SELECT * FROM items WHERE id=?').get(getTransfer(f.s.db, id).item_id)
const tap = (f, itemId, action) => f.s.http(`/items/${itemId}/comments`, { method: 'POST', token: f.client, body: { action } })
const pending = (f) => f.s.http('/consent/pending?convo_id=coord', { token: f.coord.token })
const answer = (f, body) => f.s.http('/consent/answer', { method: 'POST', token: f.coord.token, body: { convo_id: 'coord', kind: 'transfer', ...body } })
const roomTexts = (f) => f.s.db.prepare("SELECT sender, payload FROM events WHERE convo_id='room' AND type='text'").all().map((e) => ({ sender: e.sender, body: JSON.parse(e.payload).body }))
const lastStatusNote = (f, itemId) => f.s.db.prepare("SELECT body, author FROM item_comments WHERE item_id=? AND kind='status' ORDER BY created_at DESC, rowid DESC").get(itemId)

test('humanSize', () => {
  assert.equal(humanSize(25), '25 B')
  assert.equal(humanSize(2048), '2.0 KB')
  assert.equal(humanSize(33554432), '32.0 MB')
  assert.equal(humanSize(10737418240), '10.0 GB')
})

test('item fields: title, every body line, the three scan lines; peer text is kept out of markdown', () => {
  const row = {
    id: 'tr_' + '0'.repeat(32), name: 'notes.txt', size: 2048, sha256: 'b'.repeat(64), content_type: 'text/plain',
    reason: 'the notes `you` asked for', scan_verdict: 'clean', scan_findings: '[]',
  }
  const names = {
    senderBox: 'box-a', senderSession: 'Notes writer', roomTitle: 'Design review',
    recipients: [{ box: 'box-b', sessions: ['Reviewer'] }],
  }
  const f = transferConsentItemFields(row, names)
  assert.equal(f.title, 'Approve file transfer: notes.txt (2.0 KB) from box-a to Design review')
  assert.match(f.body, /box-a.*Notes writer/)
  assert.match(f.body, /box-b.*Reviewer/)
  assert.match(f.body, /Design review/)
  assert.match(f.body, /2\.0 KB \(2048 bytes\)/)
  assert.match(f.body, /text\/plain/)
  assert.ok(f.body.includes('`' + 'b'.repeat(64) + '`'))
  assert.ok(f.body.includes('```\nthe notes `you` asked for\n```'), 'the note is fenced like a spawn task')
  assert.match(f.body, /✅ clean/)
  assert.match(f.body, /Unanswered, it expires 7 days after it was sent\./)
  assert.deepEqual(f.labels, ['consent'])

  const flagged = transferConsentItemFields({ ...row, scan_verdict: 'flagged', scan_findings: JSON.stringify([{ kind: 'aws_key', line: 3 }, { kind: 'password', line: 'src.zip/a.env:2' }]) }, names)
  assert.ok(flagged.body.includes('⚠️ 2 possible secrets: `aws_key` (3), `password` (`src.zip/a.env:2`)'), flagged.body)
  const unscanned = transferConsentItemFields({ ...row, scan_verdict: 'not_scanned' }, names)
  assert.match(unscanned.body, /not scanned \(binary or unsupported format\)/)
  const marked = transferConsentItemFields({ ...row, name: '**my_notes**.txt' }, { ...names, senderBox: '[box](http://example.com)' })
  assert.ok(!marked.body.includes('[box](http://example.com)'))
  assert.ok(marked.body.includes('- **File:** `**my_notes**.txt`'), 'the file name sits in a code span')
  assert.ok(marked.title.startsWith('Approve file transfer: my_notes.txt (2.0 KB) from box'), marked.title)
})

test('create files the consent card: a top question for the user with Approve / Decline, invisible to agents', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  const row = getTransfer(f.s.db, id)
  assert.ok(row.item_id, 'the row points at its card')
  const item = itemOf(f, id)
  assert.equal(item.kind, 'question')
  assert.equal(item.awaiting, 'user')
  assert.equal(item.consent, 'transfer')
  assert.equal(item.origin_convo_id, 'sess-a')
  assert.equal(item.idem_key, `consent:transfer:${id}`)
  assert.deepEqual(JSON.parse(item.actions), ['Approve', 'Decline'])
  assert.deepEqual(JSON.parse(item.labels), ['consent'])
  assert.equal(item.title, 'Approve file transfer: notes.txt (25 B) from box-a to Design review')
  const mine = await f.s.http('/items', { token: f.client })
  assert.ok(mine.json.items.some((i) => i.id === item.id), 'the user sees it')
  for (const token of [f.a.token, f.b.token, f.coord.token]) {
    const list = await f.s.http('/items', { token })
    assert.equal(list.status, 200)
    assert.ok(!list.json.items.some((i) => i.id === item.id), 'no agent lists it')
    assert.equal((await f.s.http(`/items/${item.id}`, { token })).status, 404, 'no agent reads it')
  }
})

test('tap Approve: consent approved, the item closes, the bytes stay; a second tap is 409', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  fakeChunk(f, id)
  const item = itemOf(f, id)
  const r = await tap(f, item.id, 'Approve')
  assert.equal(r.status, 200)
  const row = getTransfer(f.s.db, id)
  assert.equal(row.consent, 'approved')
  assert.equal(row.phase, 'open')
  assert.equal(row.decided_by, 'user')
  assert.ok(row.approved_at)
  const closed = itemOf(f, id)
  assert.equal(closed.state, 'closed')
  assert.equal(closed.resolution, 'decided')
  assert.equal(lastStatusNote(f, item.id).author, 'user')
  assert.ok(fs.existsSync(path.join(transferDir(f.mediaDir, id), '0')))
  for (const action of ['Approve', 'Decline']) {
    const again = await tap(f, item.id, action)
    assert.equal(again.status, 409)
  }
  assert.equal(getTransfer(f.s.db, id).consent, 'approved')
  assert.equal(getTransfer(f.s.db, id).phase, 'open')
})

test('tap Decline: bytes deleted, phase declined, sender told, room told; a second tap is 409', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  fakeChunk(f, id)
  const item = itemOf(f, id)
  const r = await tap(f, item.id, 'Decline')
  assert.equal(r.status, 200)
  const row = getTransfer(f.s.db, id)
  assert.equal(row.consent, 'declined')
  assert.equal(row.phase, 'declined')
  assert.equal(row.decided_by, 'user')
  assert.ok(row.deleted_at)
  assert.equal(fs.existsSync(transferDir(f.mediaDir, id)), false)
  assert.equal(f.s.db.prepare('SELECT COUNT(*) c FROM transfer_chunks WHERE transfer_id=?').get(id).c, 0)
  const frame = f.sent.find((x) => x.frame.kind === 'transfer' && x.frame.event === 'declined')
  assert.ok(frame)
  assert.equal(frame.deviceId, f.a.deviceId)
  assert.equal(frame.frame.transfer_id, id)
  assert.equal(typeof frame.frame.reason, 'string')
  assert.deepEqual(roomTexts(f), [{ sender: 'journal', body: 'Not sent: `notes.txt` was declined by the user.' }])
  const closed = itemOf(f, id)
  assert.equal(closed.state, 'closed')
  assert.equal(closed.resolution, 'decided')
  assert.match(lastStatusNote(f, item.id).body, /Declined by you/)
  const again = await tap(f, item.id, 'Decline')
  assert.equal(again.status, 409)
  assert.equal(roomTexts(f).length, 1, 'no second room event')
  // Freed quota: declined is terminal.
  assert.equal(f.s.db.prepare("SELECT COUNT(*) c FROM transfers WHERE phase IN ('open','released')").get().c, 0)
})

test('tap: an unknown label is 400 and changes nothing', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  const r = await tap(f, itemOf(f, id).id, 'Maybe')
  assert.equal(r.status, 400)
  assert.equal(getTransfer(f.s.db, id).consent, 'awaiting_user')
})

test('cancel by the sender closes the card as cancelled; a tap after is 409', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  const item = itemOf(f, id)
  assert.equal((await f.s.http(`/transfers/${id}`, { method: 'DELETE', token: f.a.token })).status, 200)
  const closed = itemOf(f, id)
  assert.equal(closed.state, 'closed')
  assert.equal(closed.resolution, 'cancelled')
  assert.match(lastStatusNote(f, item.id).body, /[Cc]ancelled/)
  assert.equal((await tap(f, item.id, 'Approve')).status, 409)
  assert.equal(getTransfer(f.s.db, id).consent, 'awaiting_user')
})

test('Coordinator: /consent/pending lists the transfer with the decision fields', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f, { scan: { verdict: 'flagged', findings: [{ kind: 'aws_key', line: 3 }] } })
  const r = await pending(f)
  assert.equal(r.status, 200)
  const ask = r.json.pending.find((p) => p.kind === 'transfer')
  assert.ok(ask)
  const row = getTransfer(f.s.db, id)
  assert.deepEqual(ask, {
    kind: 'transfer', id, created_at: row.created_at,
    from_device_id: f.a.deviceId, from_name: 'box-a', from_convo_id: 'sess-a', from_convo_title: 'Notes writer',
    room_id: 'room', room_title: 'Design review', to_names: ['box-b'],
    name: 'notes.txt', size: 25, sha256: 'a'.repeat(64), scan_verdict: 'flagged', scan_findings: [{ kind: 'aws_key', line: 3 }],
    reason: 'the notes you asked for', item_num: itemOf(f, id).num,
  })
  // Answered: no longer pending.
  assert.equal((await tap(f, itemOf(f, id).id, 'Decline')).status, 200)
  assert.ok(!(await pending(f)).json.pending.some((p) => p.kind === 'transfer'))
})

test('Coordinator: approving a flagged transfer is 403 secret_scan_flagged and changes nothing; declining it works', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f, { scan: { verdict: 'flagged', findings: [{ kind: 'aws_key', line: 3 }] } })
  const r = await answer(f, { id, decision: 'approve', reason: 'looks fine' })
  assert.equal(r.status, 403)
  assert.deepEqual(r.json, { error: 'forbidden', detail: 'secret_scan_flagged' })
  const row = getTransfer(f.s.db, id)
  assert.equal(row.consent, 'awaiting_user')
  assert.equal(row.phase, 'open')
  assert.equal(itemOf(f, id).state, 'open')
  assert.equal(f.s.db.prepare('SELECT COUNT(*) c FROM consent_decisions').get().c, 0)
  const d = await answer(f, { id, decision: 'decline', reason: 'it carries a key' })
  assert.equal(d.status, 200)
  assert.equal(getTransfer(f.s.db, id).phase, 'declined')
  assert.equal(getTransfer(f.s.db, id).decided_by, 'coordinator')
  assert.equal(getTransfer(f.s.db, id).decided_reason, 'it carries a key')
  assert.equal(lastStatusNote(f, itemOf(f, id).id).body, 'Declined by the Coordinator — it carries a key. The file was deleted; nothing was delivered.')
  assert.deepEqual(roomTexts(f), [{ sender: 'journal', body: 'Not sent: `notes.txt` was declined by the Coordinator: it carries a key' }])
  assert.ok(f.sent.some((x) => x.deviceId === f.a.deviceId && x.frame.kind === 'transfer' && x.frame.event === 'declined'))
  const dec = f.s.db.prepare('SELECT kind, ask_id, decision FROM consent_decisions').all()
  assert.deepEqual(dec.map((x) => ({ ...x })), [{ kind: 'transfer', ask_id: id, decision: 'decline' }])
})

test('Coordinator: approving a clean transfer works, is recorded for the daily cap and announced; the card says who', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  const r = await answer(f, { id, decision: 'approve', reason: 'notes between my own sessions' })
  assert.equal(r.status, 200)
  const row = getTransfer(f.s.db, id)
  assert.equal(row.consent, 'approved')
  assert.equal(row.decided_by, 'coordinator')
  assert.equal(row.decided_reason, 'notes between my own sessions')
  const item = itemOf(f, id)
  assert.equal(item.state, 'closed')
  assert.equal(lastStatusNote(f, item.id).body, 'Approved by the Coordinator — notes between my own sessions.')
  const dec = f.s.db.prepare('SELECT kind, ask_id, decision, convo_id FROM consent_decisions').all()
  assert.deepEqual(dec.map((x) => ({ ...x })), [{ kind: 'transfer', ask_id: id, decision: 'approve', convo_id: 'coord' }])
  const ev = f.s.db.prepare("SELECT convo_id, payload FROM events WHERE type='consent_decision'").get()
  assert.equal(ev.convo_id, 'sess-a')
  assert.equal(JSON.parse(ev.payload).transfer_id, id)
  // Already answered.
  const again = await answer(f, { id, decision: 'approve', reason: 'again' })
  assert.equal(again.status, 409)
  assert.equal((await tap(f, item.id, 'Decline')).status, 409)
})

test('Coordinator: an approval at the transfer cap is 409 daily_cap and leaves the ask for the user', async (t) => {
  const f = await fleet(t, { consentTransferDailyCap: 1 })
  recordConsentDecision(f.s.db, { userId: f.alice.id, kind: 'transfer', askId: 'tr_' + '1'.repeat(32), decision: 'approve', convoId: 'coord', reason: 'earlier' })
  const id = await createTransfer(f)
  const r = await answer(f, { id, decision: 'approve', reason: 'ok' })
  assert.equal(r.status, 409)
  assert.deepEqual(r.json, { error: 'conflict', detail: 'daily_cap', cap: 1 })
  assert.equal(getTransfer(f.s.db, id).consent, 'awaiting_user')
  assert.equal(itemOf(f, id).state, 'open')
})

test('Coordinator: transfers have a cap of their own: chat and spawn approvals do not use it up, and it does not use theirs', async (t) => {
  assert.equal(CONSENT_TRANSFER_DAILY_CAP_DEFAULT, 100)
  const f = await fleet(t, { consentDailyCap: 1, consentTransferDailyCap: 5 })
  recordConsentDecision(f.s.db, { userId: f.alice.id, kind: 'chat', askId: 'room/1', decision: 'approve', convoId: 'coord', reason: 'earlier' })
  const id = await createTransfer(f)
  assert.equal((await answer(f, { id, decision: 'approve', reason: 'ok' })).status, 200)
  assert.equal(coordinatorApprovalsSince(f.s.db, f.alice.id, 0), 1, 'the general count leaves transfers out')
  assert.equal(coordinatorApprovalsSince(f.s.db, f.alice.id, 0, { kind: 'transfer' }), 1)
})

test('Coordinator: the transfer cap reads MATRON_COORDINATOR_TRANSFER_DAILY_CAP; 0 is no cap', async (t) => {
  const prev = process.env.MATRON_COORDINATOR_TRANSFER_DAILY_CAP
  t.after(() => { if (prev === undefined) delete process.env.MATRON_COORDINATOR_TRANSFER_DAILY_CAP; else process.env.MATRON_COORDINATOR_TRANSFER_DAILY_CAP = prev })
  const earlier = (f, n) => {
    for (let i = 0; i < n; i++) recordConsentDecision(f.s.db, { userId: f.alice.id, kind: 'transfer', askId: `tr_${String(i).padStart(32, '0')}`, decision: 'approve', convoId: 'coord', reason: 'earlier' })
  }
  process.env.MATRON_COORDINATOR_TRANSFER_DAILY_CAP = '2'
  const two = await fleet(t)
  earlier(two, 2)
  assert.deepEqual((await answer(two, { id: await createTransfer(two), decision: 'approve', reason: 'ok' })).json, { error: 'conflict', detail: 'daily_cap', cap: 2 })
  process.env.MATRON_COORDINATOR_TRANSFER_DAILY_CAP = '0'
  const none = await fleet(t)
  earlier(none, CONSENT_TRANSFER_DAILY_CAP_DEFAULT)
  assert.equal((await answer(none, { id: await createTransfer(none), decision: 'approve', reason: 'ok' })).status, 200)
})

test('Coordinator: bad id is 400, an unknown or another user\'s transfer is 404, its own transfer cannot be approved', async (t) => {
  const f = await fleet(t)
  assert.equal((await answer(f, { id: 'nope', decision: 'approve', reason: 'x' })).status, 400)
  assert.equal((await answer(f, { id: 'tr_' + 'f'.repeat(32), decision: 'approve', reason: 'x' })).status, 404)
  // A transfer sent from the Coordinator's own conversation, into a room
  // of its own with box-a (one recipient per transfer).
  addConvo(f.s.db, 'pair', f.alice.id, f.a.deviceId, 'Pair')
  recordJoined(f.s.db, { convoId: 'pair', agentDeviceId: f.coord.deviceId, initiatorDeviceId: f.a.deviceId })
  const own = await f.s.http('/transfers', { method: 'POST', token: f.coord.token, body: createBody({ room_id: 'pair', from_convo_id: 'coord' }) })
  assert.equal(own.status, 201)
  const r = await answer(f, { id: own.json.transfer_id, decision: 'approve', reason: 'mine' })
  assert.equal(r.status, 403)
  assert.equal(r.json.detail, 'own_ask_unverified')
  assert.equal(getTransfer(f.s.db, own.json.transfer_id).consent, 'awaiting_user')
})

test('upload finished and the sha matches: unaffected by the card (a real chunk upload still works after approval)', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f, { size: 5, sha256: sha(Buffer.from('hello')) })
  assert.equal((await tap(f, itemOf(f, id).id, 'Approve')).status, 200)
  const r = await fetch(`${f.s.base}/transfers/${id}/chunks/0`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${f.a.token}`, 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha(Buffer.from('hello')) },
    body: Buffer.from('hello'),
  })
  assert.equal(r.status, 200)
})

test('Coordinator: a transfer a user-only box takes part in is the user\'s to approve (403 user_only); pending says so', async (t) => {
  const f = await fleet(t)
  f.s.db.prepare('UPDATE devices SET consent_user_only=1 WHERE id=?').run(f.b.deviceId)
  const id = await createTransfer(f)
  assert.equal((await pending(f)).json.pending.find((p) => p.id === id).user_only, true)
  const r = await answer(f, { id, decision: 'approve', reason: 'ok' })
  assert.equal(r.status, 403)
  assert.equal(r.json.detail, 'user_only')
  assert.equal(getTransfer(f.s.db, id).consent, 'awaiting_user')
  assert.equal((await answer(f, { id, decision: 'decline', reason: 'not mine to allow' })).status, 200)
})

test('migration: an existing consent_decisions table is widened to take kind transfer, rows kept', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE consent_decisions(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK(kind IN ('chat','spawn')),
  ask_id     TEXT NOT NULL,
  decision   TEXT NOT NULL CHECK(decision IN ('approve','decline')),
  convo_id   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_consent_decisions_user ON consent_decisions(user_id, created_at);
ALTER TABLE consent_decisions ADD COLUMN cause_kind TEXT;`)
  db.prepare("INSERT INTO consent_decisions(user_id, kind, ask_id, decision, convo_id, reason, created_at, cause_kind) VALUES(1,'chat','r/1','approve','c','why',5,'user')").run()
  assert.throws(() => db.prepare("INSERT INTO consent_decisions(user_id, kind, ask_id, decision, convo_id, reason, created_at) VALUES(1,'transfer','x','approve','c','why',6)").run())
  assert.equal(widenConsentDecisionKinds(db), true)
  assert.equal(widenConsentDecisionKinds(db), false, 'idempotent')
  db.prepare("INSERT INTO consent_decisions(user_id, kind, ask_id, decision, convo_id, reason, created_at) VALUES(1,'transfer','x','approve','c','why',6)").run()
  assert.deepEqual(db.prepare('SELECT kind, cause_kind FROM consent_decisions ORDER BY id').all().map((r) => ({ ...r })), [{ kind: 'chat', cause_kind: 'user' }, { kind: 'transfer', cause_kind: null }])
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_consent_decisions_user'").get())
})

test('decline room line: the Coordinator\'s reason is flattened and stripped of markdown', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  const reason = 'line one\n**bold** [link](example.com) ' + 'x'.repeat(150)
  assert.equal((await answer(f, { id, decision: 'decline', reason })).status, 200)
  const [line] = roomTexts(f)
  assert.equal(line.sender, 'journal')
  assert.ok(line.body.startsWith('Not sent: `notes.txt` was declined by the Coordinator: line one bold linkexample.com x'), line.body)
  const said = line.body.slice('Not sent: `notes.txt` was declined by the Coordinator: '.length)
  assert.ok(said.length <= 200, `reason capped: ${said.length}`)
  assert.ok(!/[\n*[\]]/.test(line.body))
})

test('scan: a sensitive_file finding names an archive member with no line number; the card shows it', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f, { name: 'src.zip', scan: { verdict: 'flagged', findings: [{ kind: 'sensitive_file', line: 'app/.env' }, { kind: 'aws_key', line: 4 }] } })
  assert.deepEqual(JSON.parse(getTransfer(f.s.db, id).scan_findings), [{ kind: 'sensitive_file', line: 'app/.env' }, { kind: 'aws_key', line: 4 }])
  const body = itemOf(f, id).body
  assert.ok(body.includes('`sensitive_file` (`app/.env`)'), body)
  assert.ok(body.includes('`aws_key` (4)'), body)
  const empty = await f.s.http('/transfers', { method: 'POST', token: f.a.token, body: createBody({ scan: { verdict: 'flagged', findings: [{ kind: 'sensitive_file', line: '  ' }] } }) })
  assert.equal(empty.status, 400, 'an empty member name is still refused')
  const long = await f.s.http('/transfers', { method: 'POST', token: f.a.token, body: createBody({ scan: { verdict: 'flagged', findings: [{ kind: 'sensitive_file', line: 'a'.repeat(301) }] } }) })
  assert.equal(long.status, 400, 'over FINDING_LINE_MAX is refused')
})

// Device privacy: an ordinary (non-private) Coordinator neither lists, is
// nudged about, nor answers a transfer a private device takes part in —
// the same rule as chat and spawn asks.
const markPrivate = (f, deviceId) => f.s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(deviceId)
const nudges = (f) => f.sent.filter((x) => x.deviceId === f.coord.deviceId && x.frame.kind === 'consent' && x.frame.event === 'pending')

for (const [who, pick] of [['sending box', (f) => f.a.deviceId], ['receiving box', (f) => f.b.deviceId]]) {
  test(`private: a transfer whose ${who} is private is hidden from an ordinary Coordinator and is 404 to answer`, async (t) => {
    const f = await fleet(t)
    markPrivate(f, pick(f))
    const id = await createTransfer(f)
    assert.ok(!(await pending(f)).json.pending.some((p) => p.id === id))
    assert.equal(nudges(f).length, 0, 'no nudge either')
    for (const decision of ['approve', 'decline']) {
      const r = await answer(f, { id, decision, reason: 'ok' })
      assert.equal(r.status, 404, decision)
      assert.deepEqual(r.json, { error: 'not_found' })
    }
    assert.equal(getTransfer(f.s.db, id).consent, 'awaiting_user')
    assert.equal(f.s.db.prepare('SELECT COUNT(*) c FROM consent_decisions').get().c, 0)
  })
}

test('private: a transfer from a private-owned conversation, or into a private-owned room, is hidden from an ordinary Coordinator', async (t) => {
  const f = await fleet(t)
  const priv = createAgent(f.s.db, f.alice.id, 'box-p')
  // The sending session is handed to a private box after the ask parked.
  const fromConvo = await createTransfer(f)
  f.s.db.prepare("UPDATE conversations SET agent_device_id=? WHERE id='sess-a'").run(priv.deviceId)
  markPrivate(f, priv.deviceId)
  assert.ok(!(await pending(f)).json.pending.some((p) => p.id === fromConvo))
  assert.equal((await answer(f, { id: fromConvo, decision: 'decline', reason: 'x' })).status, 404)
  f.s.db.prepare("UPDATE conversations SET agent_device_id=? WHERE id='sess-a'").run(f.a.deviceId)
  assert.ok((await pending(f)).json.pending.some((p) => p.id === fromConvo), 'back with an ordinary owner')
  // The room's recorded owner is a private box (box-b, joined, sends).
  addConvo(f.s.db, 'room-p', f.alice.id, priv.deviceId, 'Private room')
  recordJoined(f.s.db, { convoId: 'room-p', agentDeviceId: f.a.deviceId, initiatorDeviceId: priv.deviceId })
  const room = await createTransfer(f, { room_id: 'room-p' })
  assert.ok(!(await pending(f)).json.pending.some((p) => p.id === room))
  assert.equal((await answer(f, { id: room, decision: 'approve', reason: 'x' })).status, 404)
})

test('private: a private Coordinator lists and answers a transfer a private box takes part in', async (t) => {
  const f = await fleet(t)
  markPrivate(f, f.b.deviceId)
  markPrivate(f, f.coord.deviceId)
  const id = await createTransfer(f)
  assert.ok((await pending(f)).json.pending.some((p) => p.id === id))
  assert.equal(nudges(f).length, 1)
  assert.equal((await answer(f, { id, decision: 'approve', reason: 'between my own sessions' })).status, 200)
})

test('private: only a waiting transfer counts — an answered one is the same 409 whatever box it involves', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  assert.equal((await tap(f, itemOf(f, id).id, 'Decline')).status, 200)
  const ordinary = await answer(f, { id, decision: 'approve', reason: 'x' })
  markPrivate(f, f.b.deviceId)
  const priv = await answer(f, { id, decision: 'approve', reason: 'x' })
  assert.equal(ordinary.status, 409)
  assert.equal(priv.status, ordinary.status)
  assert.deepEqual(priv.json, ordinary.json)
})

// Turn causes: the sender may stamp the causes of the asking turn on the
// create, in the shape a chat or spawn ask frame carries them.
test('causes: stored on the transfer and shown on its pending row; absent or null stores none', async (t) => {
  const f = await fleet(t)
  const causes = [{ kind: 'user_message', ref: 'sess-a:12', at: 5 }, { kind: 'room_message', ref: 'room:room@3' }]
  const id = await createTransfer(f, { causes })
  assert.deepEqual(JSON.parse(getTransfer(f.s.db, id).causes), causes)
  assert.deepEqual((await pending(f)).json.pending.find((p) => p.id === id).causes, causes)
  for (const none of [undefined, null]) {
    const other = await createTransfer(f, { causes: none, name: `n-${none}.txt` })
    assert.equal(getTransfer(f.s.db, other).causes, null)
    assert.ok(!('causes' in (await pending(f)).json.pending.find((p) => p.id === other)))
  }
})

test('causes: a bad shape is 400 and nothing is created', async (t) => {
  const f = await fleet(t)
  const bads = [
    [], 'user_message', {}, [{ kind: 'nope' }], [{ kind: 'user_message', ref: 7 }],
    [{ kind: 'user_message', ref: 'x'.repeat(201) }], Array.from({ length: 9 }, () => ({ kind: 'other' })),
  ]
  for (const causes of bads) {
    const r = await f.s.http('/transfers', { method: 'POST', token: f.a.token, body: createBody({ causes }) })
    assert.equal(r.status, 400, JSON.stringify(causes))
  }
  assert.equal(f.s.db.prepare('SELECT COUNT(*) c FROM transfers').get().c, 0)
})

test('causes: a transfer the Coordinator had another session send is the user\'s to approve (own_ask_unverified)', async (t) => {
  const f = await fleet(t)
  const coId = recordCarryOn(f.s.db, { userId: f.alice.id, fromConvoId: 'coord', targetConvoId: 'sess-a', causes: [{ kind: 'user_message', ref: 'coord:1' }] })
  const id = await createTransfer(f, { causes: [{ kind: 'carry_on', ref: `carry_on:${coId}` }] })
  const r = await answer(f, { id, decision: 'approve', reason: 'the user asked me' })
  assert.equal(r.status, 403)
  assert.equal(r.json.detail, 'own_ask_unverified')
  assert.equal(getTransfer(f.s.db, id).consent, 'awaiting_user')
  assert.equal((await answer(f, { id, decision: 'decline', reason: 'not mine to allow' })).status, 200)
})

// The user's switch "Let the Coordinator approve file transfers": off by
// default; while on, a transfer the Coordinator had another session send is
// answered like any other. Flagged files, user-only boxes and the
// Coordinator's own sends stay the user's either way.
const switchTransfers = (f, on, token = f.client) => f.s.http('/coordinator', { method: 'PUT', token, body: { transfer_consent: on } })
async function relayedTransfer(f, over = {}) {
  const coId = recordCarryOn(f.s.db, { userId: f.alice.id, fromConvoId: 'coord', targetConvoId: 'sess-a', causes: [{ kind: 'room_message', ref: 'room:elsewhere' }] })
  return createTransfer(f, { causes: [{ kind: 'carry_on', ref: `carry_on:${coId}` }], ...over })
}

test('transfer switch: off by default; only the user\'s client sets it; GET carries it for both kinds; consent alone leaves it', async (t) => {
  const f = await fleet(t)
  assert.deepEqual((await f.s.http('/coordinator', { token: f.client })).json, { convo_id: 'coord', consent: true, transfer_consent: false })
  assert.equal((await switchTransfers(f, true, f.coord.token)).status, 403)
  assert.equal((await switchTransfers(f, true, f.a.token)).status, 403)
  assert.equal((await switchTransfers(f, 'yes')).status, 400)
  assert.equal(getTransferConsentEnabled(f.s.db, f.alice.id), false)
  const on = await switchTransfers(f, true)
  assert.equal(on.status, 200)
  assert.deepEqual(on.json, { convo_id: 'coord', consent: true, transfer_consent: true })
  assert.equal((await f.s.http('/coordinator', { token: f.coord.token })).json.transfer_consent, true)
  assert.equal((await f.s.http('/coordinator', { method: 'PUT', token: f.client, body: { consent: false } })).json.transfer_consent, true)
  const both = await f.s.http('/coordinator', { method: 'PUT', token: f.client, body: { convo_id: 'coord', consent: true, transfer_consent: false } })
  assert.deepEqual(both.json, { convo_id: 'coord', consent: true, transfer_consent: false })
})

test('transfer switch off: a relayed transfer is refused, and the refusal names the switch', async (t) => {
  const f = await fleet(t)
  const id = await relayedTransfer(f)
  const r = await answer(f, { id, decision: 'approve', reason: 'screenshots for the article' })
  assert.equal(r.status, 403)
  assert.equal(r.json.detail, 'own_ask_unverified')
  assert.match(r.json.why, /Coordinator file approvals are off/)
  assert.equal(getTransfer(f.s.db, id).consent, 'awaiting_user')
})

test('transfer switch on: the Coordinator approves a transfer it had another session send; the decision names the switch', async (t) => {
  const f = await fleet(t)
  assert.equal((await switchTransfers(f, true)).status, 200)
  const id = await relayedTransfer(f)
  const r = await answer(f, { id, decision: 'approve', reason: 'screenshots for the article' })
  assert.equal(r.status, 200)
  const row = getTransfer(f.s.db, id)
  assert.equal(row.consent, 'approved')
  assert.equal(row.decided_by, 'coordinator')
  assert.equal(lastStatusNote(f, itemOf(f, id).id).body, 'Approved by the Coordinator — screenshots for the article.')
  const dec = f.s.db.prepare('SELECT kind, ask_id, decision, cause_kind, cause_ref FROM consent_decisions').all()
  assert.deepEqual(dec.map((x) => ({ ...x })), [{ kind: 'transfer', ask_id: id, decision: 'approve', cause_kind: 'setting', cause_ref: 'transfer_consent' }])
})

test('transfer switch on: flagged files, user-only boxes and the Coordinator\'s own sends stay the user\'s', async (t) => {
  const f = await fleet(t)
  assert.equal((await switchTransfers(f, true)).status, 200)
  const flagged = await relayedTransfer(f, { scan: { verdict: 'flagged', findings: [{ kind: 'aws_key', line: 3 }] } })
  assert.deepEqual((await answer(f, { id: flagged, decision: 'approve', reason: 'ok' })).json, { error: 'forbidden', detail: 'secret_scan_flagged' })
  addConvo(f.s.db, 'pair', f.alice.id, f.a.deviceId, 'Pair')
  recordJoined(f.s.db, { convoId: 'pair', agentDeviceId: f.coord.deviceId, initiatorDeviceId: f.a.deviceId })
  const own = await f.s.http('/transfers', { method: 'POST', token: f.coord.token, body: createBody({ room_id: 'pair', from_convo_id: 'coord' }) })
  const ownR = await answer(f, { id: own.json.transfer_id, decision: 'approve', reason: 'mine' })
  assert.equal(ownR.status, 403)
  assert.equal(ownR.json.detail, 'own_ask_unverified')
  f.s.db.prepare('UPDATE devices SET consent_user_only=1 WHERE id=?').run(f.b.deviceId)
  const desk = await relayedTransfer(f, { name: 'desk.txt' })
  assert.deepEqual((await answer(f, { id: desk, decision: 'approve', reason: 'ok' })).json, { error: 'forbidden', detail: 'user_only' })
  for (const id of [flagged, own.json.transfer_id, desk]) assert.equal(getTransfer(f.s.db, id).consent, 'awaiting_user')
  assert.equal(f.s.db.prepare('SELECT COUNT(*) c FROM consent_decisions').get().c, 0)
})

test('transfer switch on, then off again: a relayed transfer is the user\'s once more', async (t) => {
  const f = await fleet(t)
  await switchTransfers(f, true)
  await switchTransfers(f, false)
  const id = await relayedTransfer(f)
  assert.equal((await answer(f, { id, decision: 'approve', reason: 'ok' })).status, 403)
})

test('migration: an existing user_settings table gains coordinator_transfer_consent, off, rows kept', () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE user_settings(user_id INTEGER PRIMARY KEY, coordinator_consent INTEGER NOT NULL DEFAULT 1, updated_at INTEGER)')
  db.prepare('INSERT INTO user_settings(user_id, coordinator_consent, updated_at) VALUES(1, 1, 5)').run()
  addTransferConsentSetting(db)
  addTransferConsentSetting(db)
  assert.deepEqual({ ...db.prepare('SELECT user_id, coordinator_consent, coordinator_transfer_consent FROM user_settings').get() }, { user_id: 1, coordinator_consent: 1, coordinator_transfer_consent: 0 })
})

test('migration: an existing transfers table gains a nullable causes column, rows kept', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE transfers(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL)`)
  db.prepare("INSERT INTO transfers(id, user_id, name) VALUES('tr_1', 1, 'a.txt')").run()
  addTransferCauses(db)
  addTransferCauses(db)
  assert.deepEqual({ ...db.prepare('SELECT id, causes FROM transfers').get() }, { id: 'tr_1', causes: null })
})

test('migration: an existing transfers table gains a nullable recipient_device_id column, rows kept', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE transfers(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL)`)
  db.prepare("INSERT INTO transfers(id, user_id, name) VALUES('tr_1', 1, 'a.txt')").run()
  addTransferRecipient(db)
  addTransferRecipient(db)
  assert.deepEqual({ ...db.prepare('SELECT id, recipient_device_id FROM transfers').get() }, { id: 'tr_1', recipient_device_id: null })
})
