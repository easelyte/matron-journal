import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import net from 'node:net'
import { startTestServer } from './helpers.js'
import { createUser } from '../src/auth.js'

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-media-'))
  return path.join(dir, 'test.db')
}

async function loginToken(s, name, pw) {
  await createUser(s.db, name, pw)
  const r = await s.http('/login', { method: 'POST', body: { username: name, password: pw, device_name: 'x' } })
  return r.json.token
}

function listMediaFiles(mediaDir) {
  const out = []
  if (!fs.existsSync(mediaDir)) return out
  for (const shard of fs.readdirSync(mediaDir)) {
    const shardPath = path.join(mediaDir, shard)
    if (!fs.statSync(shardPath).isDirectory()) continue
    for (const f of fs.readdirSync(shardPath)) out.push(path.join(shard, f))
  }
  return out
}

test('media upload/download roundtrip: binary body, sha256, sharded layout, tmp cleanup', async (t) => {
  const dbPath = tmpDbPath()
  const s = await startTestServer({ dbPath })
  t.after(() => s.close())
  const token = await loginToken(s, 'dan', 'pw')
  const mediaDir = path.join(path.dirname(dbPath), 'media')

  // Deliberately non-UTF8 bytes so a string-based body handler would corrupt this.
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81]), crypto.randomBytes(8192)])
  const expectedSha = crypto.createHash('sha256').update(bytes).digest('hex')

  const up = await fetch(s.base + '/media', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
    body: bytes,
  })
  assert.equal(up.status, 200)
  const upJson = await up.json()
  assert.match(upJson.media_id, /^[0-9a-f]{32}$/)
  assert.equal(upJson.size, bytes.length)
  assert.equal(upJson.content_type, 'image/png')
  assert.equal(upJson.sha256, expectedSha)

  // Sharded disk layout: <root>/<id[0:2]>/<id>
  const finalPath = path.join(mediaDir, upJson.media_id.slice(0, 2), upJson.media_id)
  assert.ok(fs.existsSync(finalPath), 'blob missing from expected sharded path')
  assert.ok(!fs.existsSync(finalPath + '.tmp'), 'tmp file left behind after a successful upload')

  const down = await fetch(s.base + `/media/${upJson.media_id}`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(down.status, 200)
  assert.equal(down.headers.get('content-type'), 'image/png')
  assert.equal(down.headers.get('content-length'), String(bytes.length))
  assert.equal(down.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  const downBuf = Buffer.from(await down.arrayBuffer())
  assert.ok(downBuf.equals(bytes), 'downloaded bytes differ from uploaded bytes')
})

test('POST /media with no content-type header defaults to application/octet-stream', async (t) => {
  const s = await startTestServer({ dbPath: tmpDbPath() })
  t.after(() => s.close())
  const token = await loginToken(s, 'dan', 'pw')
  const up = await fetch(s.base + '/media', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: Buffer.from('no content-type here'),
  })
  assert.equal(up.status, 200)
  const upJson = await up.json()
  assert.equal(upJson.content_type, 'application/octet-stream')
})

test('POST /media and GET /media/:id require a bearer token', async (t) => {
  const s = await startTestServer({ dbPath: tmpDbPath() })
  t.after(() => s.close())
  const up = await fetch(s.base + '/media', { method: 'POST', body: Buffer.from('hi') })
  assert.equal(up.status, 401)
  const down = await fetch(s.base + '/media/' + 'a'.repeat(32))
  assert.equal(down.status, 401)
})

test('GET /media/:id -> 404 (not 403) for unknown id and for another user\'s blob', async (t) => {
  const s = await startTestServer({ dbPath: tmpDbPath() })
  t.after(() => s.close())
  const danToken = await loginToken(s, 'dan', 'pw')
  const patToken = await loginToken(s, 'pat', 'pw2')

  const unknown = await fetch(s.base + '/media/' + '0'.repeat(32), { headers: { authorization: `Bearer ${danToken}` } })
  assert.equal(unknown.status, 404)
  assert.deepEqual(await unknown.json(), { error: 'not_found' })

  const up = await fetch(s.base + '/media', {
    method: 'POST',
    headers: { authorization: `Bearer ${danToken}` },
    body: Buffer.from('dans secret file'),
  })
  const { media_id } = await up.json()

  const stolen = await fetch(s.base + `/media/${media_id}`, { headers: { authorization: `Bearer ${patToken}` } })
  assert.equal(stolen.status, 404)
  assert.deepEqual(await stolen.json(), { error: 'not_found' })

  // and the rightful owner can still fetch it
  const ok = await fetch(s.base + `/media/${media_id}`, { headers: { authorization: `Bearer ${danToken}` } })
  assert.equal(ok.status, 200)
})

test('POST /media over the size cap -> 413 too_large, nothing persisted, tmp file removed', async (t) => {
  const dbPath = tmpDbPath()
  const s = await startTestServer({ dbPath, mediaMaxBytes: 16 })
  t.after(() => s.close())
  const token = await loginToken(s, 'dan', 'pw')
  const mediaDir = path.join(path.dirname(dbPath), 'media')

  const up = await fetch(s.base + '/media', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: crypto.randomBytes(4096),
  })
  assert.equal(up.status, 413)
  assert.deepEqual(await up.json(), { error: 'too_large' })

  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0, 'a blob row was persisted despite the cap')
  assert.deepEqual(listMediaFiles(mediaDir), [], 'files were left behind on disk after a rejected oversized upload')
})

test('GET /media/:id sets nosniff + attachment so an uploader-chosen content-type cannot render inline', async (t) => {
  const dbPath = tmpDbPath()
  const s = await startTestServer({ dbPath })
  t.after(() => s.close())
  const token = await loginToken(s, 'dan', 'pw')

  const up = await fetch(s.base + '/media', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'text/html' },
    body: Buffer.from('<script>alert(1)</script>'),
  })
  const { media_id } = await up.json()

  const down = await fetch(s.base + `/media/${media_id}`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(down.status, 200)
  assert.equal(down.headers.get('content-type'), 'text/html', 'content-type is still echoed verbatim')
  assert.equal(down.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(down.headers.get('content-disposition'), 'attachment')
})

test('POST /media quota: an upload that would overshoot is rejected after receive (413), file cleaned up', async (t) => {
  const dbPath = tmpDbPath()
  const s = await startTestServer({ dbPath, mediaUserQuotaBytes: 6000 })
  t.after(() => s.close())
  const token = await loginToken(s, 'dan', 'pw')
  const mediaDir = path.join(path.dirname(dbPath), 'media')

  const first = await fetch(s.base + '/media', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: crypto.randomBytes(4000),
  })
  assert.equal(first.status, 200, 'a within-quota upload should succeed')

  // usedBytes (4000) is below quota so the body streams, but 4000 + 4000 > 6000,
  // so it's rejected once the size is known — and the just-written file deleted.
  const over = await fetch(s.base + '/media', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: crypto.randomBytes(4000),
  })
  assert.equal(over.status, 413)
  assert.deepEqual(await over.json(), { error: 'quota_exceeded' })
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 1, 'over-quota upload was persisted')
  assert.equal(listMediaFiles(mediaDir).length, 1, 'over-quota upload left a stray file on disk')
})

test('POST /media quota: once a user is at quota, further uploads are rejected up front (before the body streams)', async (t) => {
  const dbPath = tmpDbPath()
  const s = await startTestServer({ dbPath, mediaUserQuotaBytes: 8000 })
  t.after(() => s.close())
  const token = await loginToken(s, 'dan', 'pw')
  const mediaDir = path.join(path.dirname(dbPath), 'media')

  // Fill exactly to quota (0 + 8000 <= 8000) so usedBytes reaches the ceiling.
  const fill = await fetch(s.base + '/media', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: crypto.randomBytes(8000),
  })
  assert.equal(fill.status, 200)

  // usedBytes (8000) >= quota (8000): rejected before receiveBlob runs, so no
  // second file is ever written.
  const blocked = await fetch(s.base + '/media', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: crypto.randomBytes(16),
  })
  assert.equal(blocked.status, 413)
  assert.deepEqual(await blocked.json(), { error: 'quota_exceeded' })
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 1)
  assert.equal(listMediaFiles(mediaDir).length, 1, 'a pre-rejected upload should never touch disk')

  // Quota is per-user: a different user is unaffected by dan hitting his ceiling.
  const patToken = await loginToken(s, 'pat', 'pw2')
  const patUp = await fetch(s.base + '/media', {
    method: 'POST', headers: { authorization: `Bearer ${patToken}` }, body: crypto.randomBytes(4000),
  })
  assert.equal(patUp.status, 200, 'quota must be scoped per user, not global')
})

test('POST /media with an empty body -> 400 empty, nothing persisted', async (t) => {
  const dbPath = tmpDbPath()
  const s = await startTestServer({ dbPath })
  t.after(() => s.close())
  const token = await loginToken(s, 'dan', 'pw')
  const mediaDir = path.join(path.dirname(dbPath), 'media')

  const up = await fetch(s.base + '/media', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: Buffer.alloc(0),
  })
  assert.equal(up.status, 400)
  assert.deepEqual(await up.json(), { error: 'empty' })

  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0)
  assert.deepEqual(listMediaFiles(mediaDir), [])
})

test('a write-stream error during the final flush rejects instead of hanging (fails closed)', async () => {
  const { receiveBlob } = await import('../src/media.js')
  const { PassThrough, Writable } = await import('node:stream')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-media-flush-'))

  // A sink that accepts every chunk but fails at end()-time flush — the shape
  // of ENOSPC/EIO surfacing only when buffered data is forced out on close.
  const failing = new Writable({
    write(chunk, enc, cb) { cb() },
    final(cb) { cb(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })) },
  })

  const req = new PassThrough()
  const p = receiveBlob(req, { root, maxBytes: 1000, createWriteStream: () => failing })
  req.end('some bytes')

  // The buggy behavior is a promise that never settles (the HTTP request would
  // hang forever), so race against a timeout instead of awaiting bare.
  const outcome = await Promise.race([
    p.then(() => 'resolved', (e) => e),
    new Promise((r) => setTimeout(() => r('hung'), 2000)),
  ])
  assert.notEqual(outcome, 'hung', 'receiveBlob never settled after a flush-time write error')
  assert.notEqual(outcome, 'resolved', 'receiveBlob resolved despite a flush-time write error')
  assert.match(outcome.message, /no space left/)
})

test('unauthenticated POST /media (401, pre-body-read reject) closes the connection instead of leaving an unread body to poison a keep-alive socket', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const url = new URL(s.base)

  const result = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => {
      const body = 'x'.repeat(4096) // never read server-side: auth fails before any body listener attaches
      socket.write(
        `POST /media HTTP/1.1\r\nHost: ${url.host}\r\nConnection: keep-alive\r\nContent-Length: ${body.length}\r\n\r\n${body}`
      )
    })
    let data = ''
    socket.on('data', (d) => { data += d.toString() })
    socket.on('close', () => resolve({ data, closed: true }))
    socket.on('error', reject)
    const bail = setTimeout(() => { if (!socket.destroyed) { socket.destroy(); resolve({ data, closed: false }) } }, 3000)
    socket.on('close', () => clearTimeout(bail))
  })

  assert.match(result.data, /^HTTP\/1\.1 401/)
  assert.ok(result.closed, 'the server must close the connection after an early (pre-body-read) reject rather than leaving it open for a keep-alive reuse that could desync on the unread body')
})

test('rate-limited POST /login (429, pre-body-read reject) also closes the connection rather than leaving an unread body behind', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const url = new URL(s.base)

  // Exhaust the per-IP login rate limiter first so the NEXT request hits the
  // 429 branch before readBody() is ever called.
  for (let i = 0; i < 5; i++) {
    await fetch(s.base + '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.9' },
      body: JSON.stringify({ username: 'nobody', password: 'wrong', device_name: 'x' }),
    })
  }

  const result = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => {
      const body = JSON.stringify({ username: 'nobody', password: 'wrong', device_name: 'x' })
      socket.write(
        `POST /login HTTP/1.1\r\nHost: ${url.host}\r\nConnection: keep-alive\r\ncf-connecting-ip: 9.9.9.9\r\ncontent-type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`
      )
    })
    let data = ''
    socket.on('data', (d) => { data += d.toString() })
    socket.on('close', () => resolve({ data, closed: true }))
    socket.on('error', reject)
    const bail = setTimeout(() => { if (!socket.destroyed) { socket.destroy(); resolve({ data, closed: false }) } }, 3000)
    socket.on('close', () => clearTimeout(bail))
  })

  assert.match(result.data, /^HTTP\/1\.1 429/)
  assert.ok(result.closed, 'the rate-limited pre-body-read reject must also close the connection')
})

test('POST /media: if the DB insert fails after the blob file was already renamed into place, the orphaned file is cleaned up (unlinked) before the 500', async (t) => {
  const dbPath = tmpDbPath()
  const s = await startTestServer({ dbPath })
  t.after(() => s.close())
  const token = await loginToken(s, 'dan', 'pw')
  const mediaDir = path.join(path.dirname(dbPath), 'media')

  const mute = t.mock.method(console, 'error', () => {})
  s.db.exec('DROP TABLE blobs') // forces insertBlob to throw AFTER receiveBlob already renamed the file into place

  const up = await fetch(s.base + '/media', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: Buffer.from('this must not be left orphaned on disk'),
  })
  assert.equal(up.status, 500)
  assert.deepEqual(await up.json(), { error: 'internal' })
  assert.ok(mute.mock.callCount() >= 1, 'expected the error to be logged server-side')

  assert.deepEqual(listMediaFiles(mediaDir), [], 'the renamed blob file was left orphaned on disk after the DB insert failed')
})

test('GET /media/:id: a DB row whose file is missing or size-mismatched on disk gets a clean 500, never a 200-then-reset', async (t) => {
  const dbPath = tmpDbPath()
  const s = await startTestServer({ dbPath })
  t.after(() => s.close())
  const token = await loginToken(s, 'dan', 'pw')

  const up = await fetch(s.base + '/media', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: Buffer.from('will be corrupted on disk after upload'),
  })
  const { media_id } = await up.json()
  const row = s.db.prepare('SELECT disk_path FROM blobs WHERE id=?').get(media_id)

  const mute = t.mock.method(console, 'error', () => {})

  // Ops-error simulation: the file on disk no longer matches the DB row.
  fs.writeFileSync(row.disk_path, 'short')
  const short = await fetch(s.base + `/media/${media_id}`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(short.status, 500, 'a size-mismatched file must be a clean 500, not a 200 with truncated/reset body')
  assert.deepEqual(await short.json(), { error: 'internal' })

  fs.unlinkSync(row.disk_path)
  const missing = await fetch(s.base + `/media/${media_id}`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(missing.status, 500, 'a missing file must be a clean 500, not a 200-then-reset')
  assert.deepEqual(await missing.json(), { error: 'internal' })

  assert.ok(mute.mock.callCount() >= 2, 'both failure modes should be logged server-side')
})

test('an agent-kind device can also upload media (not just client devices)', async (t) => {
  const { createAgent } = await import('../src/auth.js')
  const s = await startTestServer({ dbPath: tmpDbPath() })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const { token } = createAgent(s.db, dan.id, 'agent-1')
  const up = await fetch(s.base + '/media', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: Buffer.from('agent-uploaded'),
  })
  assert.equal(up.status, 200)
})
