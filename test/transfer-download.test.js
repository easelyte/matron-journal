import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { recordJoined } from '../src/participants.js'
import { getTransfer, transferDir, transferChunkPath, setTransferState } from '../src/transfers.js'
import { releaseIfReady, transferNames } from '../src/transfer-consent.js'
import { hashingTransfers } from '../src/transfers-http.js'

// Agent-to-agent file transfers (Task 3): completing an upload against the
// declared sha256, the release once both approved and uploaded (exactly
// once, whichever comes second), the Range download for recipient devices,
// the receipt, and the bridge's catch-up list.

const CHUNK = 10
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const DATA = Buffer.from('abcdefghijklmnopqrstuvwxy') // 25 bytes, 3 chunks

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-transfer-download-'))
  return path.join(dir, 'test.db')
}

function addConvo(db, id, userId, deviceId, title = id) {
  db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, created_at, agent_device_id) VALUES(?,?,?,'running',?,?)")
    .run(id, userId, title, Date.now(), deviceId)
}

// alice: box-a owns the room and sends; box-b is joined (the recipient);
// box-c is hers but not in the room. A client token for the user's taps.
// Every frame sent to a device is recorded, and every wake asked for.
async function fleet(t, opts = {}) {
  const dbPath = tmpDbPath()
  const woken = []
  const waker = { enabled: true, wake: (name) => { woken.push(name); return true } }
  const s = await startTestServer({ dbPath, transferMaxBytes: 100, transferUserQuotaBytes: 1000, transferChunkBytes: CHUNK, waker, ...opts })
  t.after(() => s.close())
  const mediaDir = path.join(path.dirname(dbPath), 'media')
  const alice = await createUser(s.db, 'alice', 'pw')
  const a = createAgent(s.db, alice.id, 'box-a')
  const b = createAgent(s.db, alice.id, 'box-b')
  const c = createAgent(s.db, alice.id, 'box-c')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'phone' } })
  addConvo(s.db, 'room', alice.id, a.deviceId, 'Design review')
  addConvo(s.db, 'sess-a', alice.id, a.deviceId, 'Notes writer')
  addConvo(s.db, 'sess-b', alice.id, b.deviceId, 'Reviewer')
  addConvo(s.db, 'sess-c', alice.id, c.deviceId, 'Elsewhere')
  recordJoined(s.db, { convoId: 'room', agentDeviceId: b.deviceId, initiatorDeviceId: a.deviceId })
  const sent = []
  const orig = s.hub.sendToDevice.bind(s.hub)
  s.hub.sendToDevice = (userId, deviceId, frame) => { sent.push({ deviceId, frame }); return orig(userId, deviceId, frame) }
  return { s, mediaDir, alice, a, b, c, client: login.json.token, sent, woken }
}

async function createTransfer(f, over = {}) {
  const r = await f.s.http('/transfers', {
    method: 'POST', token: f.a.token,
    body: { room_id: 'room', from_convo_id: 'sess-a', name: 'notes.txt', size: DATA.length, sha256: sha(DATA), content_type: 'text/plain', scan: { verdict: 'clean', findings: [] }, ...over },
  })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  return r.json.transfer_id
}

async function putChunk(f, id, n, bytes) {
  const r = await fetch(`${f.s.base}/transfers/${id}/chunks/${n}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${f.a.token}`, 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha(bytes) },
    body: bytes,
  })
  assert.equal(r.status, 200)
}

async function uploadAll(f, id, data = DATA) {
  for (let n = 0; n * CHUNK < data.length; n++) await putChunk(f, id, n, data.subarray(n * CHUNK, (n + 1) * CHUNK))
}

const complete = (f, id, token = f.a.token) => f.s.http(`/transfers/${id}/complete`, { method: 'POST', token })
const itemOf = (f, id) => f.s.db.prepare('SELECT * FROM items WHERE id=?').get(getTransfer(f.s.db, id).item_id)
const tap = (f, id, action) => f.s.http(`/items/${getTransfer(f.s.db, id).item_id}/comments`, { method: 'POST', token: f.client, body: { action } })
const fileEvents = (f) => f.s.db.prepare("SELECT sender, payload, blob_ref FROM events WHERE convo_id='room' AND type='file'").all()
  .map((e) => ({ sender: e.sender, payload: JSON.parse(e.payload), blob_ref: e.blob_ref }))
const roomTexts = (f) => f.s.db.prepare("SELECT sender, payload FROM events WHERE convo_id='room' AND type='text'").all().map((e) => ({ sender: e.sender, body: JSON.parse(e.payload).body }))
const frames = (f, event) => f.sent.filter((x) => x.frame.kind === 'transfer' && x.frame.event === event)
const download = (f, id, token = f.b.token, headers = {}) => fetch(`${f.s.base}/transfers/${id}/content`, { headers: { authorization: `Bearer ${token}`, ...headers } })
const received = (f, id, body, token = f.b.token) => f.s.http(`/transfers/${id}/received`, { method: 'POST', token, body })

// Uploaded, completed and approved: the file is out.
async function released(f, over) {
  const id = await createTransfer(f, over)
  await uploadAll(f, id)
  assert.equal((await complete(f, id)).status, 200)
  assert.equal((await tap(f, id, 'Approve')).status, 200)
  assert.equal(getTransfer(f.s.db, id).phase, 'released')
  return id
}

function assertReleasedOnce(f, id, { reason = null } = {}) {
  const row = getTransfer(f.s.db, id)
  assert.equal(row.phase, 'released')
  assert.ok(row.released_at)
  const events = fileEvents(f)
  assert.equal(events.length, 1, 'one durable file event in the room')
  assert.equal(events[0].sender, 'journal')
  assert.equal(events[0].blob_ref, null)
  assert.deepEqual(events[0].payload, {
    name: 'notes.txt', size: DATA.length, sha256: sha(DATA), content_type: 'text/plain', transfer_id: id, from_name: 'box-a', from_convo_id: 'sess-a', reason,
  })
  const ready = frames(f, 'ready')
  assert.equal(ready.length, 1, 'one ready frame')
  assert.equal(ready[0].deviceId, f.b.deviceId)
  assert.equal(ready[0].frame.transfer_id, id, 'top-level transfer_id, like every transfer frame')
  assert.deepEqual(ready[0].frame.transfer, {
    id, room_id: 'room', name: 'notes.txt', size: DATA.length, sha256: sha(DATA), content_type: 'text/plain', from_name: 'box-a', from_convo_id: 'sess-a', reason,
  })
}

test('approve, then complete: released exactly once; a repeat complete is a no-op 200', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  await uploadAll(f, id)
  assert.equal((await tap(f, id, 'Approve')).status, 200)
  assert.equal(getTransfer(f.s.db, id).phase, 'open', 'approved but not uploaded: not out yet')
  assert.equal(fileEvents(f).length, 0)
  const r = await complete(f, id)
  assert.equal(r.status, 200)
  assert.equal(r.json.upload, 'uploaded')
  assert.equal(getTransfer(f.s.db, id).upload, 'uploaded')
  assert.ok(getTransfer(f.s.db, id).uploaded_at)
  assertReleasedOnce(f, id)
  assert.deepEqual(f.woken, ['box-b'], 'the offline recipient box is woken')
  const again = await complete(f, id)
  assert.equal(again.status, 200)
  assertReleasedOnce(f, id)
})

test("the sender's note rides on the ready frame, the room's file event and the catch-up list", async (t) => {
  const f = await fleet(t)
  const note = 'the notes you asked for'
  const id = await released(f, { reason: note })
  assertReleasedOnce(f, id, { reason: note })
  const mine = await f.s.http('/transfers?for=me', { token: f.b.token })
  assert.equal(mine.json.transfers.length, 1)
  assert.equal(mine.json.transfers[0].reason, note)
})

test('complete, then approve: released exactly once', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  await uploadAll(f, id)
  assert.equal((await complete(f, id)).status, 200)
  const row = getTransfer(f.s.db, id)
  assert.equal(row.upload, 'uploaded')
  assert.equal(row.phase, 'open', 'uploaded but not approved: not out yet')
  assert.equal(fileEvents(f).length, 0)
  assert.equal(frames(f, 'ready').length, 0)
  assert.equal((await tap(f, id, 'Approve')).status, 200)
  assertReleasedOnce(f, id)
})

test('releaseIfReady twice, and two completes at once, give one room event', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  await uploadAll(f, id)
  assert.equal((await tap(f, id, 'Approve')).status, 200)
  // One hashes; the other is either a no-op 200 (it arrived after) or a
  // 409 hashing (it overlapped), never a second release.
  const both = await Promise.all([complete(f, id), complete(f, id)])
  assert.ok(both.some((r) => r.status === 200))
  for (const r of both) assert.ok(r.status === 200 || (r.status === 409 && r.json.detail === 'hashing'), JSON.stringify(r.json))
  assertReleasedOnce(f, id)

  const id2 = await createTransfer(f, { name: 'more.txt' })
  assert.ok(setTransferState(f.s.db, id2, { consent: 'approved', upload: 'uploaded' }))
  const ctx = { db: f.s.db, hub: f.s.hub, waker: null }
  assert.equal(releaseIfReady(ctx, id2), true)
  assert.equal(releaseIfReady(ctx, id2), false)
  assert.equal(fileEvents(f).filter((e) => e.payload.transfer_id === id2).length, 1)
  assert.equal(frames(f, 'ready').filter((x) => x.frame.transfer.id === id2).length, 1)
})

test('complete with a chunk missing: 409 missing_chunks listing them', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  await putChunk(f, id, 1, DATA.subarray(10, 20))
  const r = await complete(f, id)
  assert.equal(r.status, 409)
  assert.equal(r.json.error, 'missing_chunks')
  assert.deepEqual(r.json.missing, [0, 2])
  assert.equal(getTransfer(f.s.db, id).upload, 'uploading')
})

test('complete: only the sender; others 404', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  await uploadAll(f, id)
  assert.equal((await complete(f, id, f.b.token)).status, 404)
  assert.equal((await complete(f, id, f.c.token)).status, 404)
  assert.equal(getTransfer(f.s.db, id).upload, 'uploading')
})

test('a corrupted chunk on disk: complete 422 sha256_mismatch, failed, files gone, card closed, sender told', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  await uploadAll(f, id)
  fs.writeFileSync(transferChunkPath(f.mediaDir, id, 1), 'XXXXXXXXXX')
  const r = await complete(f, id)
  assert.equal(r.status, 422)
  assert.equal(r.json.error, 'sha256_mismatch')
  const row = getTransfer(f.s.db, id)
  assert.equal(row.upload, 'failed')
  assert.equal(row.phase, 'failed')
  assert.ok(row.deleted_at)
  assert.equal(fs.existsSync(transferDir(f.mediaDir, id)), false)
  assert.equal(f.s.db.prepare('SELECT COUNT(*) c FROM transfer_chunks WHERE transfer_id=?').get(id).c, 0)
  const item = itemOf(f, id)
  assert.equal(item.state, 'closed')
  assert.equal(item.resolution, 'cancelled')
  const failed = frames(f, 'failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].deviceId, f.a.deviceId)
  assert.equal(failed[0].frame.transfer_id, id)
  assert.equal(fileEvents(f).length, 0)
  assert.equal((await complete(f, id)).status, 409, 'a failed transfer stays failed')
  assert.equal((await tap(f, id, 'Approve')).status, 409)
})

test('download: 404 before approval, even once uploaded', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  await uploadAll(f, id)
  assert.equal((await complete(f, id)).status, 200)
  const r = await download(f, id)
  assert.equal(r.status, 404)
})

test('download: the full file equals the uploaded bytes, with attachment and nosniff', async (t) => {
  const f = await fleet(t)
  const id = await released(f)
  const r = await download(f, id)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-length'), String(DATA.length))
  assert.equal(r.headers.get('content-disposition'), 'attachment')
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(r.headers.get('accept-ranges'), 'bytes')
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(DATA))
})

test('download: Range bytes=5- returns the tail with 206; a-b crosses chunk boundaries', async (t) => {
  const f = await fleet(t)
  const id = await released(f)
  const tail = await download(f, id, f.b.token, { range: 'bytes=5-' })
  assert.equal(tail.status, 206)
  assert.equal(tail.headers.get('content-range'), `bytes 5-24/${DATA.length}`)
  assert.equal(tail.headers.get('content-length'), '20')
  assert.ok(Buffer.from(await tail.arrayBuffer()).equals(DATA.subarray(5)))
  const mid = await download(f, id, f.b.token, { range: 'bytes=8-21' })
  assert.equal(mid.status, 206)
  assert.equal(mid.headers.get('content-range'), `bytes 8-21/${DATA.length}`)
  assert.ok(Buffer.from(await mid.arrayBuffer()).equals(DATA.subarray(8, 22)))
  const last = await download(f, id, f.b.token, { range: 'bytes=24-24' })
  assert.equal(last.status, 206)
  assert.equal(Buffer.from(await last.arrayBuffer()).toString(), 'y')
  const past = await download(f, id, f.b.token, { range: 'bytes=25-' })
  assert.equal(past.status, 416)
  assert.equal(past.headers.get('content-range'), `bytes */${DATA.length}`)
  await past.arrayBuffer()
})

test('download: a non-recipient agent device and the sender get 404; a client 403', async (t) => {
  const f = await fleet(t)
  const id = await released(f)
  for (const token of [f.c.token, f.a.token]) {
    const r = await download(f, id, token)
    assert.equal(r.status, 404)
    await r.arrayBuffer()
  }
  const r = await download(f, id, f.client)
  assert.equal(r.status, 403)
  await r.arrayBuffer()
})

test('received: a wrong sha is 400 and changes nothing', async (t) => {
  const f = await fleet(t)
  const id = await released(f)
  assert.equal((await received(f, id, { sha256: 'b'.repeat(64) })).status, 400)
  assert.equal((await received(f, id, { sha256: 'nope' })).status, 400)
  assert.equal((await received(f, id, {})).status, 400)
  assert.equal(getTransfer(f.s.db, id).phase, 'released')
  assert.equal(frames(f, 'delivered').length, 0)
})

test('received: delivered, sender told, room told once; download stays open for the hour', async (t) => {
  const f = await fleet(t)
  const id = await released(f)
  assert.equal((await received(f, id, { sha256: sha(DATA) }, f.c.token)).status, 404, 'a non-recipient cannot confirm')
  const r = await received(f, id, { sha256: sha(DATA) })
  assert.equal(r.status, 200)
  const row = getTransfer(f.s.db, id)
  assert.equal(row.phase, 'delivered')
  assert.ok(row.delivered_at)
  const delivered = frames(f, 'delivered')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].deviceId, f.a.deviceId)
  assert.equal(delivered[0].frame.transfer_id, id)
  assert.deepEqual(roomTexts(f), [{ sender: 'journal', body: 'Delivered `notes.txt` (25 B), sha256 verified.' }])
  const again = await received(f, id, { sha256: sha(DATA) })
  assert.equal(again.status, 200)
  assert.equal(frames(f, 'delivered').length, 1)
  assert.equal(roomTexts(f).length, 1)

  const within = await download(f, id)
  assert.equal(within.status, 200)
  await within.arrayBuffer()
  f.s.db.prepare('UPDATE transfers SET delivered_at=? WHERE id=?').run(Date.now() - 3600001, id)
  const after = await download(f, id)
  assert.equal(after.status, 404)
  await after.arrayBuffer()
})

test('room notices in the journal\'s voice put the file name in a code span', async (t) => {
  const f = await fleet(t)
  const name = '[click](example.com) **now**.txt'
  const id = await released(f, { name })
  assert.equal((await received(f, id, { sha256: sha(DATA) })).status, 200)
  const declined = await createTransfer(f, { name })
  assert.equal((await tap(f, declined, 'Decline')).status, 200)
  assert.deepEqual(roomTexts(f).map((e) => e.body), [
    'Delivered `[click](example.com) **now**.txt` (25 B), sha256 verified.',
    'Not sent: `[click](example.com) **now**.txt` was declined by the user.',
  ])
  assert.ok(roomTexts(f).every((e) => e.sender === 'journal'))
})

test('GET /transfers?for=me lists only released, undelivered transfers for a recipient device', async (t) => {
  const f = await fleet(t)
  const out = await released(f)
  const done = await released(f, { name: 'done.txt' })
  assert.equal((await received(f, done, { sha256: sha(DATA) })).status, 200)
  const waiting = await createTransfer(f, { name: 'waiting.txt' })
  await uploadAll(f, waiting)
  assert.equal((await complete(f, waiting)).status, 200)

  const mine = await f.s.http('/transfers?for=me', { token: f.b.token })
  assert.equal(mine.status, 200)
  assert.deepEqual(mine.json.transfers, [{
    id: out, room_id: 'room', name: 'notes.txt', size: DATA.length, sha256: sha(DATA), content_type: 'text/plain', from_name: 'box-a', from_convo_id: 'sess-a', reason: null,
  }])
  for (const token of [f.c.token, f.a.token]) {
    const other = await f.s.http('/transfers?for=me', { token })
    assert.equal(other.status, 200)
    assert.deepEqual(other.json.transfers, [])
  }
  assert.equal((await f.s.http('/transfers', { token: f.b.token })).status, 400)
})

test('download: a content type that is not a plain header value is served as octet-stream', async (t) => {
  const f = await fleet(t)
  const id = await released(f, { content_type: 'text/plain; name=ünï€' })
  const r = await download(f, id)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'application/octet-stream')
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(DATA))
})

const reportFailed = (f, id, body, token = f.b.token) => f.s.http(`/transfers/${id}/failed`, { method: 'POST', token, body })

test('POST /failed: a recipient that could not save the file ends it; bytes go, sender and room are told; a repeat is a 200 no-op', async (t) => {
  const f = await fleet(t)
  const id = await released(f)
  const r = await reportFailed(f, id, { reason: 'disk full' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.phase, 'failed')
  const row = getTransfer(f.s.db, id)
  assert.equal(row.phase, 'failed')
  assert.ok(row.deleted_at)
  assert.equal(fs.existsSync(transferDir(f.mediaDir, id)), false)
  assert.equal(f.s.db.prepare('SELECT COUNT(*) c FROM transfer_chunks WHERE transfer_id=?').get(id).c, 0)
  const failed = frames(f, 'failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].deviceId, f.a.deviceId)
  assert.deepEqual(failed[0].frame, { kind: 'transfer', event: 'failed', transfer_id: id, reason: 'receiver: disk full' })
  assert.deepEqual(roomTexts(f), [{ sender: 'journal', body: 'Not received: `notes.txt` could not be saved on the receiving box: disk full' }])
  const dl = await download(f, id)
  assert.equal(dl.status, 404)
  await dl.arrayBuffer()

  const again = await reportFailed(f, id, { reason: 'disk full' })
  assert.equal(again.status, 200)
  assert.equal(frames(f, 'failed').length, 1, 'no second frame')
  assert.equal(roomTexts(f).length, 1, 'no second room line')
})

test('POST /failed: only a recipient device; the sender, a box outside the room and an unknown id are 404', async (t) => {
  const f = await fleet(t)
  const id = await released(f)
  for (const token of [f.a.token, f.c.token]) {
    const r = await reportFailed(f, id, { reason: 'nope' }, token)
    assert.equal(r.status, 404)
    assert.equal(r.json.error, 'not_found')
  }
  assert.equal((await reportFailed(f, 'tr_' + '0'.repeat(32), { reason: 'x' })).status, 404)
  assert.equal((await reportFailed(f, id, { reason: 'x' }, f.client)).status, 403)
  assert.equal(getTransfer(f.s.db, id).phase, 'released', 'nothing changed')
  assert.equal(frames(f, 'failed').length, 0)
})

test('POST /failed: only while released; open or delivered is 409 closed', async (t) => {
  const f = await fleet(t)
  const open = await createTransfer(f)
  const r = await reportFailed(f, open, { reason: 'x' })
  assert.equal(r.status, 409)
  assert.equal(r.json.error, 'closed')
  assert.equal(getTransfer(f.s.db, open).phase, 'open')

  const done = await released(f, { name: 'done.txt' })
  assert.equal((await received(f, done, { sha256: sha(DATA) })).status, 200)
  const late = await reportFailed(f, done, { reason: 'x' })
  assert.equal(late.status, 409)
  assert.equal(late.json.error, 'closed')
  assert.equal(getTransfer(f.s.db, done).phase, 'delivered')
})

test('POST /failed: the reason is flattened, stripped of markdown and capped at 200; a non-string is 400', async (t) => {
  const f = await fleet(t)
  const id = await released(f)
  assert.equal((await reportFailed(f, id, { reason: 42 })).status, 400)
  assert.equal(getTransfer(f.s.db, id).phase, 'released')
  const r = await reportFailed(f, id, { reason: 'no\nspace **left** ' + 'y'.repeat(400) })
  assert.equal(r.status, 200)
  const [frame] = frames(f, 'failed')
  assert.ok(frame.frame.reason.startsWith('receiver: no space left y'), frame.frame.reason)
  assert.ok(frame.frame.reason.length <= 'receiver: '.length + 200)
  const [line] = roomTexts(f)
  assert.ok(!/[\n*]/.test(line.body))
})

// A chunk PUT held open mid-body: one byte is sent at once, the rest on
// finish(). Resolves {status, json} once the server answers; destroyed
// after 5 s if finish() never comes.
function slowPut(f, id, n, bytes) {
  const req = http.request(`${f.s.base}/transfers/${id}/chunks/${n}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${f.a.token}`, 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha(bytes), 'content-length': String(bytes.length) },
  })
  const done = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
  })
  req.write(bytes.subarray(0, 1))
  // A test that fails before finish() must not leave the server waiting on
  // this socket at close.
  const guard = setTimeout(() => req.destroy(), 5000)
  guard.unref()
  return { finish: () => { clearTimeout(guard); req.end(bytes.subarray(1)); return done } }
}

const tmpFiles = (f, id) => { try { return fs.readdirSync(transferDir(f.mediaDir, id)).filter((x) => x.endsWith('.tmp')) } catch { return [] } }

// Until the slow PUT's temp file is on disk: its body is being read.
async function untilInFlight(f, id) {
  for (let i = 0; i < 500 && tmpFiles(f, id).length === 0; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(tmpFiles(f, id).length > 0, 'the slow PUT reached the body')
}

test('a chunk PUT that finishes after the upload completed leaves the verified chunks in place; the file stays downloadable', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  await uploadAll(f, id)
  const put = slowPut(f, id, 0, Buffer.from('ZZZZZZZZZZ'))
  await untilInFlight(f, id)
  // The state a /complete leaves, as if one had won the race with this PUT.
  assert.ok(setTransferState(f.s.db, id, { upload: 'uploaded', uploaded_at: Date.now() }))
  assert.equal((await tap(f, id, 'Approve')).status, 200)
  assert.equal(getTransfer(f.s.db, id).phase, 'released')
  const r = await put.finish()
  assert.equal(r.status, 409)
  assert.equal(r.json.error, 'closed')
  assert.deepEqual(tmpFiles(f, id), [], 'its temp file is gone')
  assert.deepEqual(fs.readFileSync(transferChunkPath(f.mediaDir, id, 0)), DATA.subarray(0, CHUNK), 'chunk 0 is the verified one')
  const got = await download(f, id)
  assert.equal(got.status, 200)
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), DATA)
})

test('complete while a chunk PUT is in flight is 409 hashing; once it lands, complete succeeds', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  await uploadAll(f, id)
  const put = slowPut(f, id, 0, DATA.subarray(0, CHUNK))
  await untilInFlight(f, id)
  const early = await complete(f, id)
  assert.equal(early.status, 409)
  assert.equal(early.json.error, 'conflict')
  assert.equal(early.json.detail, 'hashing')
  assert.equal(getTransfer(f.s.db, id).upload, 'uploading')
  assert.equal((await put.finish()).status, 200)
  assert.equal((await complete(f, id)).status, 200)
  assert.equal(getTransfer(f.s.db, id).upload, 'uploaded')
})

test('a chunk PUT whose body lands while a complete is hashing is 409 closed and never renamed into place', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  await uploadAll(f, id)
  const put = slowPut(f, id, 0, Buffer.from('ZZZZZZZZZZ'))
  await untilInFlight(f, id)
  hashingTransfers.add(id)
  try {
    const r = await put.finish()
    assert.equal(r.status, 409)
    assert.equal(r.json.error, 'closed')
  } finally {
    hashingTransfers.delete(id)
  }
  assert.deepEqual(fs.readFileSync(transferChunkPath(f.mediaDir, id, 0)), DATA.subarray(0, CHUNK))
  assert.deepEqual(tmpFiles(f, id), [])
  assert.equal((await complete(f, id)).status, 200)
})

test('a chunk PUT that finishes after a cancel still clears the transfer directory', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  await putChunk(f, id, 0, DATA.subarray(0, CHUNK))
  const put = slowPut(f, id, 1, DATA.subarray(CHUNK, 2 * CHUNK))
  await untilInFlight(f, id)
  assert.equal((await f.s.http(`/transfers/${id}`, { method: 'DELETE', token: f.a.token })).status, 200)
  const r = await put.finish()
  assert.equal(r.status, 409)
  assert.equal(fs.existsSync(transferDir(f.mediaDir, id)), false)
})

// One recipient device per transfer.

test('create: a room with two possible recipient devices is 409 multiple_recipients and creates nothing', async (t) => {
  const f = await fleet(t)
  recordJoined(f.s.db, { convoId: 'room', agentDeviceId: f.c.deviceId, initiatorDeviceId: f.a.deviceId })
  const r = await f.s.http('/transfers', {
    method: 'POST', token: f.a.token,
    body: { room_id: 'room', from_convo_id: 'sess-a', name: 'notes.txt', size: DATA.length, sha256: sha(DATA), scan: { verdict: 'clean', findings: [] } },
  })
  assert.equal(r.status, 409)
  assert.equal(r.json.error, 'conflict')
  assert.equal(r.json.detail, 'multiple_recipients')
  assert.match(r.json.message, /one/)
  assert.equal(f.s.db.prepare('SELECT COUNT(*) c FROM transfers').get().c, 0)
})

test('the recipient device is stored at create; a box that joins later is not a recipient', async (t) => {
  const f = await fleet(t)
  const id = await createTransfer(f)
  assert.equal(getTransfer(f.s.db, id).recipient_device_id, f.b.deviceId)
  recordJoined(f.s.db, { convoId: 'room', agentDeviceId: f.c.deviceId, initiatorDeviceId: f.a.deviceId })
  assert.deepEqual(transferNames(f.s.db, getTransfer(f.s.db, id)).recipients.map((r) => r.box), ['box-b'], 'the card names only the stored recipient')
  await uploadAll(f, id)
  assert.equal((await complete(f, id)).status, 200)
  assert.equal((await tap(f, id, 'Approve')).status, 200)
  assert.deepEqual(frames(f, 'ready').map((x) => x.deviceId), [f.b.deviceId])
  const r = await download(f, id, f.c.token)
  assert.equal(r.status, 404)
  await r.arrayBuffer()
  assert.equal((await received(f, id, { sha256: sha(DATA) }, f.c.token)).status, 404)
  assert.equal((await f.s.http(`/transfers/${id}/failed`, { method: 'POST', token: f.c.token, body: { reason: 'x' } })).status, 404)
  assert.deepEqual((await f.s.http('/transfers?for=me', { token: f.c.token })).json.transfers, [])
  assert.equal((await f.s.http('/transfers?for=me', { token: f.b.token })).json.transfers.length, 1)
  const ok = await download(f, id)
  assert.equal(ok.status, 200)
  await ok.arrayBuffer()
})

test('a same-device room delivers to the sender\'s own device', async (t) => {
  const f = await fleet(t)
  addConvo(f.s.db, 'same', f.alice.id, f.a.deviceId, 'Two sessions')
  recordJoined(f.s.db, { convoId: 'same', agentDeviceId: f.a.deviceId, initiatorDeviceId: f.a.deviceId })
  const id = await released(f, { room_id: 'same' })
  assert.equal(getTransfer(f.s.db, id).recipient_device_id, f.a.deviceId)
  assert.deepEqual(frames(f, 'ready').map((x) => x.deviceId), [f.a.deviceId])
  const got = await download(f, id, f.a.token)
  assert.equal(got.status, 200)
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), DATA)
  const r = await download(f, id, f.b.token)
  assert.equal(r.status, 404)
  await r.arrayBuffer()
  assert.equal((await received(f, id, { sha256: sha(DATA) }, f.a.token)).status, 200)
  assert.equal(getTransfer(f.s.db, id).phase, 'delivered')
})

test('a row from before the recipient column falls back to the room\'s recipients', async (t) => {
  const f = await fleet(t)
  const id = await released(f)
  f.s.db.prepare('UPDATE transfers SET recipient_device_id=NULL WHERE id=?').run(id)
  const r = await download(f, id)
  assert.equal(r.status, 200)
  await r.arrayBuffer()
  assert.equal((await f.s.http('/transfers?for=me', { token: f.b.token })).json.transfers.length, 1)
  const c = await download(f, id, f.c.token)
  assert.equal(c.status, 404)
  await c.arrayBuffer()
})
