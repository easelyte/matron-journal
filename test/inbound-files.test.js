import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import http from 'node:http'
import { createSource, setSourceEnabled, rotateSourceKey, getSource } from '../src/inbound.js'
import { reserveFile, sniffType, cleanFileName, FILE_MAX_BYTES, FILE_ATTACH_MS, UPLOAD_TICKET_MS } from '../src/inbound-files.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n')

async function world(t, { caps = {}, server = {} } = {}) {
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-files-'))
  const s = await startTestServer({ unseenNudge: false, mediaDir, ...server })
  t.after(async () => { await s.close(); fs.rmSync(mediaDir, { recursive: true, force: true }) })
  const alice = await createUser(s.db, 'alice', 'pw')
  const box = createAgent(s.db, alice.id, 'box-a')
  const phone = (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'phone' } })).json.token
  const { source, key } = createSource(s.db, alice.id, 'Scout', caps)
  const ws = await makeWsClient(s.base, { token: phone, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { try { ws.close() } catch { /* already closed */ } })
  const out = async (r) => ({ status: r.status, headers: r.headers, json: await r.json().catch(() => null) })
  const json = (p, body, k = key) => fetch(s.base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(k ? { authorization: `Bearer ${k}` } : {}) }, body: JSON.stringify(body) }).then(out)
  const upload = (bytes, { name = 'chart.png', k = key, type = 'application/octet-stream' } = {}) =>
    fetch(`${s.base}/inbound/files?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': type, ...(k ? { authorization: `Bearer ${k}` } : {}) }, body: bytes }).then(out)
  const tool = async (name, args) => (await json('/inbound/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json.result
  const events = () => s.db.prepare('SELECT seq, sender, type, payload, blob_ref FROM events WHERE convo_id=? ORDER BY seq').all(source.convo_id).map((e) => ({ ...e, payload: JSON.parse(e.payload) }))
  return { s, alice, box, phone, ws, source, key, json, upload, tool, events, mediaDir, report: (body) => json('/inbound/reports', body) }
}

test('sniffType and cleanFileName: the bytes decide the type, and the name is made plain', () => {
  assert.equal(sniffType(PNG).contentType, 'image/png')
  assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).contentType, 'image/jpeg')
  assert.equal(sniffType(Buffer.from('GIF89a..')).contentType, 'image/gif')
  assert.equal(sniffType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')).contentType, 'image/webp')
  assert.equal(sniffType(PDF).contentType, 'application/pdf')
  for (const bad of ['<svg xmlns="http://www.w3.org/2000/svg">', '<html>', 'PK\x03\x04', '', 'MZ']) assert.equal(sniffType(Buffer.from(bad, 'latin1')), null, bad)
  assert.equal(cleanFileName('../../etc/chart.final.png', 'png'), 'chart.final.png')
  assert.equal(cleanFileName('report.exe', 'pdf'), 'report.pdf')
  assert.equal(cleanFileName('a [b](c) <i>.jpeg', 'jpg'), 'a bc i.jpg')
  assert.equal(cleanFileName('', 'gif'), 'file.gif')
  assert.equal(cleanFileName('..', 'gif'), 'file.gif')
})

test('a file uploaded with the key and named by a report follows it as a message of its own', async (t) => {
  const w = await world(t)
  const up = await w.upload(PNG, { name: 'chart.exe', type: 'text/html' })
  assert.equal(up.status, 201)
  assert.deepEqual({ ...up.json, file_id: 'x' }, { file_id: 'x', name: 'chart.png', content_type: 'image/png', size: PNG.length })
  const doc = await w.upload(PDF, { name: 'notes.pdf' })
  assert.equal(doc.json.content_type, 'application/pdf')
  // Nothing is shown until a report names it.
  assert.deepEqual(w.events(), [])
  const r = await w.report({ title: 'T', body: 'With a chart.', files: [up.json.file_id, doc.json.file_id] })
  assert.equal(r.status, 201)
  const ev = w.events()
  assert.deepEqual(ev.map((e) => [e.sender, e.type]), [['journal', 'convo_meta'], ['source:Scout', 'text'], ['source:Scout', 'image'], ['source:Scout', 'file']])
  const src = { from: 'source', source: { id: w.source.id, name: 'Scout' } }
  assert.deepEqual(ev[2].payload, { blob_ref: ev[2].blob_ref, name: 'chart.png', content_type: 'image/png', size: PNG.length, width: 1, height: 1, ...src })
  assert.deepEqual(ev[3].payload, { blob_ref: ev[3].blob_ref, name: 'notes.pdf', content_type: 'application/pdf', size: PDF.length, ...src })
  const live = await w.ws.waitFor((f) => f.kind === 'journal' && f.type === 'image' && f.convo_id === w.source.convo_id)
  assert.equal(live.payload.blob_ref, ev[2].blob_ref)
  // The user's app reads the bytes as it reads any attachment, typed by the journal.
  const got = await fetch(`${w.s.base}/media/${ev[2].blob_ref}`, { headers: { authorization: `Bearer ${w.phone}` } })
  assert.equal(got.status, 200)
  assert.equal(got.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG)
  // The same report sent again is a duplicate, not a refusal, and shows nothing.
  const again = await w.report({ title: 'T', body: 'With a chart.', files: [up.json.file_id, doc.json.file_id] })
  assert.deepEqual([again.status, again.json], [200, { accepted: false, duplicate: true }])
  assert.equal(w.events().length, 4)
  // A file is shown once; the same words with no file are another report.
  assert.equal((await w.report({ body: 'Again.', files: [up.json.file_id] })).status, 400)
  assert.equal((await w.report({ title: 'T', body: 'With a chart.' })).status, 201)
  assert.equal((await w.report({ title: 'T', body: 'With a chart.' })).json.duplicate, true)
})

test('what is refused: other types, big files, no key, bad file lists, another source\'s file, an old file', async (t) => {
  const w = await world(t)
  for (const bad of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('<html><script>1</script>'), Buffer.from('PK\x03\x04zip')]) {
    const r = await w.upload(bad, { name: 'x.png', type: 'image/png' })
    assert.equal(r.status, 415)
  }
  assert.equal((await w.upload(Buffer.alloc(0))).status, 400)
  // Over the cap the journal answers and closes without reading, which a
  // client may see as the connection closing.
  assert.equal((await w.upload(Buffer.concat([PNG, Buffer.alloc(FILE_MAX_BYTES)])).catch(() => ({ status: 413 }))).status, 413)
  assert.equal((await w.upload(PNG, { k: null })).status, 401)
  assert.equal((await w.upload(PNG, { k: w.box.token })).status, 401)
  // Nothing refused is kept, on disk or in the table of blobs.
  assert.equal(w.s.db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0)
  assert.deepEqual(fs.readdirSync(w.mediaDir).flatMap((d) => fs.readdirSync(path.join(w.mediaDir, d))), [])
  for (const files of ['mif_x', [1], ['a', 'b', 'c', 'd', 'e'], ['']]) assert.equal((await w.report({ body: 'x', files })).status, 400, JSON.stringify(files))
  assert.equal((await w.report({ body: 'x', files: ['mif_unknown'] })).status, 400)
  const other = createSource(w.s.db, w.alice.id, 'Other')
  const theirs = await w.upload(PNG, { k: other.key })
  assert.equal(theirs.status, 201)
  assert.equal((await w.report({ body: 'x', files: [theirs.json.file_id] })).status, 400)
  const mine = await w.upload(PNG)
  w.s.db.prepare('UPDATE inbound_files SET created_at=? WHERE id=?').run(Date.now() - FILE_ATTACH_MS - 1000, mine.json.file_id)
  assert.equal((await w.report({ body: 'x', files: [mine.json.file_id] })).status, 400)
  // A refused report shows nothing.
  assert.deepEqual(w.events(), [])
  // No agent reads a source's file, even with its id.
  const fresh = await w.upload(PNG)
  assert.equal((await w.report({ body: 'y', files: [fresh.json.file_id] })).status, 201)
  const blob = w.events().find((e) => e.type === 'image').blob_ref
  assert.equal((await fetch(`${w.s.base}/media/${blob}`, { headers: { authorization: `Bearer ${w.box.token}` } })).status, 404)
})

test('request_upload: an address that takes one file, once, for a while, with no key', async (t) => {
  const w = await world(t)
  const asked = await w.tool('request_upload', { name: 'plot.png' })
  assert.equal(asked.isError, false)
  const place = JSON.parse(asked.content[0].text)
  assert.deepEqual(Object.keys(place), ['file_id', 'upload_url', 'method', 'expires_in_seconds'])
  assert.equal(place.expires_in_seconds, UPLOAD_TICKET_MS / 1000)
  assert.ok(place.upload_url.startsWith(`${w.s.base}/inbound/uploads/`))
  assert.equal(place.upload_url.includes(w.key), false)
  // Not uploaded yet: a report cannot name it.
  assert.equal((await w.report({ body: 'x', files: [place.file_id] })).status, 400)
  const put = await fetch(place.upload_url, { method: 'PUT', body: PNG })
  assert.equal(put.status, 201)
  assert.deepEqual(await put.json(), { file_id: place.file_id, name: 'plot.png', content_type: 'image/png', size: PNG.length })
  // The address is spent; a made-up one is the same 404.
  // (No body on these: a refusal closes the connection without reading one.)
  assert.equal((await fetch(place.upload_url, { method: 'PUT' })).status, 404)
  assert.equal((await fetch(`${w.s.base}/inbound/uploads/${'a'.repeat(43)}`, { method: 'PUT' })).status, 404)
  const posted = await w.tool('post_report', { body: 'A plot.', files: [place.file_id] })
  assert.deepEqual(posted, { content: [{ type: 'text', text: 'Posted.' }], isError: false })
  assert.deepEqual(w.events().map((e) => e.type), ['convo_meta', 'text', 'image'])
})

test('an upload address that waited too long, or whose source was disabled, is gone', async (t) => {
  const w = await world(t)
  const late = JSON.parse((await w.tool('request_upload', {})).content[0].text)
  w.s.db.prepare('UPDATE inbound_files SET created_at=? WHERE id=?').run(Date.now() - UPLOAD_TICKET_MS - 1000, late.file_id)
  assert.equal((await fetch(late.upload_url, { method: 'PUT' })).status, 404)
  // A replaced key takes its waiting addresses with it.
  const old = JSON.parse((await w.tool('request_upload', {})).content[0].text)
  const key = rotateSourceKey(w.s.db, w.source.id)
  assert.equal((await fetch(old.upload_url, { method: 'PUT' })).status, 404)
  const off = JSON.parse((await w.json('/inbound/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'request_upload', arguments: {} } }, key)).json.result.content[0].text)
  setSourceEnabled(w.s.db, w.source.id, false)
  assert.equal((await fetch(off.upload_url, { method: 'PUT' })).status, 404)
  assert.equal(w.s.db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0)
})

test('files have their own cap, and count against the user\'s media quota', async (t) => {
  const w = await world(t, { caps: { hourlyMax: 1, dailyMax: 1 }, server: { mediaUserQuotaBytes: PNG.length + PDF.length } })
  for (let i = 0; i < 2; i++) assert.equal((await w.upload(i ? PDF : PNG)).status, 201, String(i))
  assert.equal((await w.upload(PNG)).status, 413)
  assert.equal((await w.upload(PNG)).status, 413)
  const over = await w.upload(PNG)
  assert.equal(over.status, 429)
  assert.ok(Number(over.headers.get('retry-after')) > 0)
  const asked = await w.tool('request_upload', {})
  assert.equal(asked.isError, true)
  assert.match(asked.content[0].text, /over its limit for files/)
})

test('a locked account takes no file and hands out no upload address', async (t) => {
  const w = await world(t)
  const before = JSON.parse((await w.tool('request_upload', {})).content[0].text)
  w.s.db.prepare('INSERT INTO panic_locks(user_id, since) VALUES(?,?)').run(w.alice.id, Date.now())
  assert.equal((await w.upload(PNG)).status, 403)
  const asked = await w.tool('request_upload', {})
  assert.equal(asked.isError, true)
  assert.match(asked.content[0].text, /the account is locked/)
  assert.equal((await fetch(before.upload_url, { method: 'PUT', body: PNG })).status, 403)
  assert.equal(w.s.db.prepare('SELECT COUNT(*) n FROM inbound_files').get().n, 1)
  assert.equal(w.s.db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0)
})

test('an account locked while a file is on its way keeps none of it', async (t) => {
  const w = await world(t)
  const u = new URL(`${w.s.base}/inbound/files?name=chart.png`)
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { authorization: `Bearer ${w.key}`, 'content-type': 'application/octet-stream', 'content-length': PNG.length } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
    req.on('error', reject)
    req.write(PNG.subarray(0, 20))
    setTimeout(() => {
      w.s.db.prepare('INSERT INTO panic_locks(user_id, since) VALUES(?,?)').run(w.alice.id, Date.now())
      req.end(PNG.subarray(20))
    }, 150)
  })
  assert.equal(status, 403)
  assert.equal(w.s.db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0)
  assert.equal(w.s.db.prepare('SELECT COUNT(*) n FROM inbound_files WHERE blob_id IS NOT NULL').get().n, 0)
})

test('a request that began under a replaced key gets no place for a file', async (t) => {
  const w = await world(t)
  const stale = getSource(w.s.db, w.source.id)
  assert.equal(reserveFile(w.s.db, stale, { ticket: true }).status, 'ok')
  rotateSourceKey(w.s.db, w.source.id)
  assert.equal(w.s.db.prepare('SELECT COUNT(*) n FROM inbound_files WHERE secret_hash IS NOT NULL AND blob_id IS NULL').get().n, 0)
  assert.deepEqual(reserveFile(w.s.db, stale, { ticket: true }), { status: 'gone' })
  assert.deepEqual(reserveFile(w.s.db, stale), { status: 'gone' })
})
