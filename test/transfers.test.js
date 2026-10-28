import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { recordJoined } from '../src/participants.js'
import { TRANSFER_CHUNK_BYTES, TRANSFER_MAX_AWAITING_PER_SENDER_DEFAULT, chunkCount, transferChunkPath, recipientDevices, setTransferState, getTransfer, reservedTransferBytes } from '../src/transfers.js'
import { hashingTransfers } from '../src/transfers-http.js'

// Agent-to-agent file transfers, the journal half (Task 1): the row, the
// chunked resumable upload, status and cancel. Small sizes throughout: the
// test server takes a tiny chunk size, file cap and quota.

const CHUNK = 10
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-transfers-'))
  return path.join(dir, 'test.db')
}

function addConvo(db, id, userId, deviceId) {
  db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, created_at, agent_device_id) VALUES(?,?,?,'running',?,?)")
    .run(id, userId, id, Date.now(), deviceId)
}

// alice owns box-a (room owner) and box-b (joined); box-c is hers but not in
// the room. A client token for the 403 case.
async function fleet(t, opts = {}) {
  const dbPath = tmpDbPath()
  const s = await startTestServer({ dbPath, transferMaxBytes: 100, transferUserQuotaBytes: 150, transferChunkBytes: CHUNK, ...opts })
  t.after(() => s.close())
  const mediaDir = path.join(path.dirname(dbPath), 'media')
  const alice = await createUser(s.db, 'alice', 'pw')
  const a = createAgent(s.db, alice.id, 'box-a')
  const b = createAgent(s.db, alice.id, 'box-b')
  const c = createAgent(s.db, alice.id, 'box-c')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'phone' } })
  addConvo(s.db, 'room', alice.id, a.deviceId)
  addConvo(s.db, 'sess-a', alice.id, a.deviceId)
  addConvo(s.db, 'sess-c', alice.id, c.deviceId)
  recordJoined(s.db, { convoId: 'room', agentDeviceId: b.deviceId, initiatorDeviceId: a.deviceId })
  return { s, mediaDir, alice, a, b, c, client: login.json.token }
}

const body = (over = {}) => ({
  room_id: 'room', from_convo_id: 'sess-a', name: 'notes.txt', size: 25, sha256: 'a'.repeat(64),
  content_type: 'text/plain', reason: 'the notes you asked for', scan: { verdict: 'clean', findings: [] }, ...over,
})

const create = (s, token, over) => s.http('/transfers', { method: 'POST', token, body: body(over) })

async function putChunk(s, token, id, n, bytes, digest = sha(bytes)) {
  const r = await fetch(`${s.base}/transfers/${id}/chunks/${n}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-chunk-sha256': digest },
    body: bytes,
  })
  let j = null
  try { j = await r.json() } catch { /* empty */ }
  return { status: r.status, json: j }
}

test('chunk size constant and chunk count', () => {
  assert.equal(TRANSFER_CHUNK_BYTES, 33554432)
  assert.equal(chunkCount(1), 1)
  assert.equal(chunkCount(TRANSFER_CHUNK_BYTES), 1)
  assert.equal(chunkCount(TRANSFER_CHUNK_BYTES + 1), 2)
  assert.equal(chunkCount(25, 10), 3)
})

test('create: 201 with chunk_bytes and chunks = ceil(size / chunk_bytes); row starts open', async (t) => {
  const { s, a } = await fleet(t)
  const r = await create(s, a.token)
  assert.equal(r.status, 201)
  assert.match(r.json.transfer_id, /^tr_[0-9a-f]+$/)
  assert.equal(r.json.chunk_bytes, CHUNK)
  assert.equal(r.json.chunks, 3)
  const row = getTransfer(s.db, r.json.transfer_id)
  assert.equal(row.phase, 'open')
  assert.equal(row.consent, 'awaiting_user')
  assert.equal(row.upload, 'uploading')
  assert.equal(row.scan_verdict, 'clean')
  assert.deepEqual(JSON.parse(row.scan_findings), [])
})

test('create: a client device is refused 403', async (t) => {
  const { s, client } = await fleet(t)
  const r = await create(s, client)
  assert.equal(r.status, 403)
})

test('create: a device not in the room gets 404, as does an unknown room', async (t) => {
  const { s, c } = await fleet(t)
  assert.equal((await create(s, c.token, { from_convo_id: 'sess-c' })).status, 404)
  assert.equal((await create(s, c.token, { from_convo_id: 'sess-c', room_id: 'nope' })).status, 404)
})

test('create: bad shapes are 400', async (t) => {
  const { s, a } = await fleet(t)
  for (const over of [
    { sha256: 'xyz' },
    { name: '' },
    { name: 'x'.repeat(256) },
    { size: 0 },
    { size: 1.5 },
    { scan: { verdict: 'maybe', findings: [] } },
    { scan: { verdict: 'flagged', findings: Array.from({ length: 51 }, () => ({ kind: 'aws_key', line: 1 })) } },
    { scan: { verdict: 'flagged', findings: [{ kind: 'aws_key', line: 0 }] } },
  ]) {
    assert.equal((await create(s, a.token, over)).status, 400, JSON.stringify(over).slice(0, 80))
  }
})

test('create: name is sanitised; findings keep only kind and line', async (t) => {
  const { s, a } = await fleet(t)
  const r = await create(s, a.token, {
    name: 'two\nlines.txt',
    scan: { verdict: 'flagged', findings: [{ kind: 'aws_key', line: 3, value: 'AKIA-should-not-be-kept' }, { kind: 'pem', line: 'inner/a.pem:2' }] },
  })
  assert.equal(r.status, 201)
  const row = getTransfer(s.db, r.json.transfer_id)
  assert.equal(row.name, 'two lines.txt')
  assert.deepEqual(JSON.parse(row.scan_findings), [{ kind: 'aws_key', line: 3 }, { kind: 'pem', line: 'inner/a.pem:2' }])
})

test('create: a person room is refused 403 person_room', async (t) => {
  const { s, alice, a } = await fleet(t)
  const bob = await createUser(s.db, 'bob', 'pw')
  const bobBox = createAgent(s.db, bob.id, 'box-b')
  s.db.prepare(`INSERT INTO person_rooms(id, owner_user_id, owner_room_id, owner_device_id, guest_user_id, guest_device_id, state, created_at, updated_at)
    VALUES('pr_1', ?, 'room', ?, ?, ?, 'joined', 1, 1)`).run(alice.id, a.deviceId, bob.id, bobBox.deviceId)
  const r = await create(s, a.token)
  assert.equal(r.status, 403)
  assert.equal(r.json.error, 'person_room')
})

test('create: size over the cap is 413 too_large', async (t) => {
  const { s, a } = await fleet(t)
  const r = await create(s, a.token, { size: 101 })
  assert.equal(r.status, 413)
  assert.equal(r.json.error, 'too_large')
})

test('create: two creates summing over the quota — the second is 413 quota_exceeded', async (t) => {
  const { s, a } = await fleet(t)
  assert.equal((await create(s, a.token, { size: 100 })).status, 201)
  const r = await create(s, a.token, { size: 60 })
  assert.equal(r.status, 413)
  assert.equal(r.json.error, 'quota_exceeded')
})

test('quota: a cancelled transfer no longer reserves its size', async (t) => {
  const { s, a } = await fleet(t)
  const first = await create(s, a.token, { size: 100 })
  assert.equal((await s.http(`/transfers/${first.json.transfer_id}`, { method: 'DELETE', token: a.token })).status, 200)
  assert.equal((await create(s, a.token, { size: 100 })).status, 201)
})

test('chunk: a wrong sha256 is 400 chunk_mismatch and leaves no file at the chunk path', async (t) => {
  const { s, a, mediaDir } = await fleet(t)
  const { json: { transfer_id: id } } = await create(s, a.token)
  const bytes = Buffer.from('0123456789')
  const r = await putChunk(s, a.token, id, 0, bytes, 'b'.repeat(64))
  assert.equal(r.status, 400)
  assert.equal(r.json.error, 'chunk_mismatch')
  assert.ok(!fs.existsSync(transferChunkPath(mediaDir, id, 0)))
  const dir = path.dirname(transferChunkPath(mediaDir, id, 0))
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], 'no tmp file left behind')
})

test('chunk: a wrong size is 400 chunk_mismatch (short middle chunk, long last chunk)', async (t) => {
  const { s, a, mediaDir } = await fleet(t)
  const { json: { transfer_id: id } } = await create(s, a.token)
  assert.equal((await putChunk(s, a.token, id, 0, Buffer.from('short'))).status, 400)
  assert.equal((await putChunk(s, a.token, id, 2, Buffer.from('toolong'))).status, 400)
  assert.ok(!fs.existsSync(transferChunkPath(mediaDir, id, 0)))
  assert.ok(!fs.existsSync(transferChunkPath(mediaDir, id, 2)))
})

test('chunk: stored at the chunk path; a re-PUT of the same chunk succeeds; GET lists received', async (t) => {
  const { s, a, b, mediaDir } = await fleet(t)
  const { json: { transfer_id: id } } = await create(s, a.token)
  const c0 = Buffer.from('0123456789')
  const c2 = Buffer.from('abcde')
  assert.deepEqual(await putChunk(s, a.token, id, 0, c0), { status: 200, json: { n: 0 } })
  assert.deepEqual(await putChunk(s, a.token, id, 0, c0), { status: 200, json: { n: 0 } })
  assert.deepEqual(await putChunk(s, a.token, id, 2, c2), { status: 200, json: { n: 2 } })
  assert.ok(fs.readFileSync(transferChunkPath(mediaDir, id, 0)).equals(c0))
  assert.ok(fs.readFileSync(transferChunkPath(mediaDir, id, 2)).equals(c2))

  const g = await s.http(`/transfers/${id}`, { token: a.token })
  assert.equal(g.status, 200)
  assert.deepEqual(g.json, { id, phase: 'open', consent: 'awaiting_user', upload: 'uploading', size: 25, chunk_bytes: CHUNK, chunks: 3, received: [0, 2] })
  // A recipient (joined box-b) can read the status too.
  assert.equal((await s.http(`/transfers/${id}`, { token: b.token })).status, 200)
})

test('chunk: only the sender device may upload (404 otherwise); n out of range is 400', async (t) => {
  const { s, a, b } = await fleet(t)
  const { json: { transfer_id: id } } = await create(s, a.token)
  assert.equal((await putChunk(s, b.token, id, 0, Buffer.from('0123456789'))).status, 404)
  assert.equal((await putChunk(s, a.token, 'tr_nope', 0, Buffer.from('0123456789'))).status, 404)
  assert.equal((await putChunk(s, a.token, id, 3, Buffer.from('0123456789'))).status, 400)
})

test('GET: a device outside the room gets 404; a client gets 403', async (t) => {
  const { s, a, c, client } = await fleet(t)
  const { json: { transfer_id: id } } = await create(s, a.token)
  assert.equal((await s.http(`/transfers/${id}`, { token: c.token })).status, 404)
  assert.equal((await s.http(`/transfers/${id}`, { token: client })).status, 403)
})

test('DELETE by the sender: phase cancelled, files removed; a later PUT is 409 closed', async (t) => {
  const { s, a, b, mediaDir } = await fleet(t)
  const { json: { transfer_id: id } } = await create(s, a.token)
  assert.equal((await putChunk(s, a.token, id, 0, Buffer.from('0123456789'))).status, 200)
  const dir = path.join(mediaDir, 'transfers', id)
  assert.ok(fs.existsSync(dir))

  assert.equal((await s.http(`/transfers/${id}`, { method: 'DELETE', token: b.token })).status, 404, 'only the sender cancels')
  const d = await s.http(`/transfers/${id}`, { method: 'DELETE', token: a.token })
  assert.equal(d.status, 200)
  assert.equal(d.json.phase, 'cancelled')
  assert.ok(!fs.existsSync(dir))
  assert.equal(getTransfer(s.db, id).phase, 'cancelled')
  assert.ok(getTransfer(s.db, id).deleted_at > 0)

  const p = await putChunk(s, a.token, id, 1, Buffer.from('0123456789'))
  assert.equal(p.status, 409)
  assert.equal(p.json.error, 'closed')
  assert.ok(!fs.existsSync(dir), 'a refused PUT leaves nothing behind')
})

test('setTransferState is guarded: a transition from a wrong prior state is refused', async (t) => {
  const { s, a } = await fleet(t)
  const { json: { transfer_id: id } } = await create(s, a.token)
  assert.equal(setTransferState(s.db, id, { consent: 'approved', approved_at: 5 }), true)
  assert.equal(setTransferState(s.db, id, { consent: 'declined' }), false, 'already answered')
  assert.equal(setTransferState(s.db, id, { phase: 'delivered' }), false, 'open cannot jump to delivered')
  assert.equal(setTransferState(s.db, id, { phase: 'cancelled' }), true)
  assert.equal(setTransferState(s.db, id, { phase: 'cancelled' }), false, 'terminal')
  assert.throws(() => setTransferState(s.db, id, { user_id: 9 }), /column/)
})

test('recipientDevices: owner + joined minus the sender; the sender only in a same-device room', async (t) => {
  const { s, alice, a, b } = await fleet(t)
  assert.deepEqual(recipientDevices(s.db, 'room', a.deviceId), [b.deviceId])
  assert.deepEqual(recipientDevices(s.db, 'room', b.deviceId), [a.deviceId])
  addConvo(s.db, 'same', alice.id, a.deviceId)
  recordJoined(s.db, { convoId: 'same', agentDeviceId: a.deviceId, initiatorDeviceId: a.deviceId })
  assert.deepEqual(recipientDevices(s.db, 'same', a.deviceId), [a.deviceId])
})

test('create: once a sender has the cap of transfers awaiting the user, the next is 409 too_many_awaiting', async (t) => {
  const { s, a } = await fleet(t, { transferMaxAwaitingPerSender: 2 })
  const one = await create(s, a.token, { size: 5 })
  const two = await create(s, a.token, { size: 5 })
  assert.equal(one.status, 201)
  assert.equal(two.status, 201)
  const before = s.db.prepare('SELECT COUNT(*) c FROM transfers').get().c
  const third = await create(s, a.token, { size: 5 })
  assert.equal(third.status, 409)
  assert.equal(third.json.error, 'conflict')
  assert.equal(third.json.detail, 'too_many_awaiting')
  assert.match(third.json.message, /waiting for the user's approval/)
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM transfers').get().c, before, 'nothing was created')

  // An approved one no longer counts, nor does a cancelled one.
  assert.ok(setTransferState(s.db, one.json.transfer_id, { consent: 'approved' }))
  assert.equal((await create(s, a.token, { size: 5 })).status, 201)
  assert.equal((await create(s, a.token, { size: 5 })).status, 409)
  assert.equal((await s.http(`/transfers/${two.json.transfer_id}`, { method: 'DELETE', token: a.token })).status, 200)
  assert.equal((await create(s, a.token, { size: 5 })).status, 201)
})

test('the awaiting cap defaults to 50 and reads MATRON_TRANSFER_MAX_AWAITING_PER_SENDER', async (t) => {
  assert.equal(TRANSFER_MAX_AWAITING_PER_SENDER_DEFAULT, 50)
  const prev = process.env.MATRON_TRANSFER_MAX_AWAITING_PER_SENDER
  process.env.MATRON_TRANSFER_MAX_AWAITING_PER_SENDER = '1'
  t.after(() => {
    if (prev === undefined) delete process.env.MATRON_TRANSFER_MAX_AWAITING_PER_SENDER
    else process.env.MATRON_TRANSFER_MAX_AWAITING_PER_SENDER = prev
  })
  const { s, a } = await fleet(t)
  assert.equal((await create(s, a.token, { size: 5 })).status, 201)
  const r = await create(s, a.token, { size: 5 })
  assert.equal(r.status, 409)
  assert.equal(r.json.detail, 'too_many_awaiting')
})

test('create: a room with nobody to receive is 409 no_recipients and reserves nothing', async (t) => {
  const { s, a, alice } = await fleet(t)
  addConvo(s.db, 'solo', alice.id, a.deviceId)
  const r = await create(s, a.token, { room_id: 'solo' })
  assert.equal(r.status, 409)
  assert.equal(r.json.error, 'conflict')
  assert.equal(r.json.detail, 'no_recipients')
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM transfers').get().c, 0)
  assert.equal(reservedTransferBytes(s.db, alice.id), 0)
})

test('complete: while one complete is hashing, a second is 409 hashing and a chunk PUT is 409 closed', async (t) => {
  const { s, a } = await fleet(t)
  const data = Buffer.from('abcdefghijklmnopqrstuvwxy')
  const id = (await create(s, a.token, { sha256: sha(data) })).json.transfer_id
  for (let n = 0; n < 3; n++) assert.equal((await putChunk(s, a.token, id, n, data.subarray(n * CHUNK, (n + 1) * CHUNK))).status, 200)

  hashingTransfers.add(id)
  try {
    const second = await s.http(`/transfers/${id}/complete`, { method: 'POST', token: a.token })
    assert.equal(second.status, 409)
    assert.equal(second.json.error, 'conflict')
    assert.equal(second.json.detail, 'hashing')
    const put = await putChunk(s, a.token, id, 0, data.subarray(0, CHUNK))
    assert.equal(put.status, 409)
    assert.equal(put.json.error, 'closed')
  } finally {
    hashingTransfers.delete(id)
  }
  assert.equal(getTransfer(s.db, id).upload, 'uploading', 'the refused calls changed nothing')

  const done = await s.http(`/transfers/${id}/complete`, { method: 'POST', token: a.token })
  assert.equal(done.status, 200)
  assert.equal(getTransfer(s.db, id).upload, 'uploaded')
  assert.equal(hashingTransfers.has(id), false, 'released after the hash')
})

test('complete: two at once; one hashes, the other is 409 hashing or a 200 no-op', async (t) => {
  const { s, a } = await fleet(t)
  const data = Buffer.from('abcdefghijklmnopqrstuvwxy')
  const id = (await create(s, a.token, { sha256: sha(data) })).json.transfer_id
  for (let n = 0; n < 3; n++) assert.equal((await putChunk(s, a.token, id, n, data.subarray(n * CHUNK, (n + 1) * CHUNK))).status, 200)
  const both = await Promise.all([1, 2].map(() => s.http(`/transfers/${id}/complete`, { method: 'POST', token: a.token })))
  for (const r of both) assert.ok(r.status === 200 || (r.status === 409 && r.json.detail === 'hashing'), JSON.stringify(r.json))
  assert.ok(both.some((r) => r.status === 200))
  assert.equal(hashingTransfers.has(id), false)
})

test('complete: the hashing hold is released when the hash fails (sha256 mismatch)', async (t) => {
  const { s, a } = await fleet(t)
  const data = Buffer.from('abcdefghijklmnopqrstuvwxy')
  const id = (await create(s, a.token)).json.transfer_id // declared sha256 is 'a'*64: a mismatch
  for (let n = 0; n < 3; n++) assert.equal((await putChunk(s, a.token, id, n, data.subarray(n * CHUNK, (n + 1) * CHUNK))).status, 200)
  assert.equal((await s.http(`/transfers/${id}/complete`, { method: 'POST', token: a.token })).status, 422)
  assert.equal(hashingTransfers.has(id), false)
})
