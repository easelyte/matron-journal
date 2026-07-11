import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
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
