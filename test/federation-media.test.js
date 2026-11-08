import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createUser } from '../src/auth.js'
import { insertBlob } from '../src/db.js'
import { world, post, grantOf, incoming, offer } from './federation-world.js'
import { signEnvelope, newOpId } from '../src/federation-envelope.js'
import crypto from 'node:crypto'
import { Writable } from 'node:stream'
import { MEDIA_PATH, MEDIA_HEADER, purgeReplicaMedia, makeReplicaMedia, localMedia } from '../src/federation-media.js'
import { runReapMedia } from '../src/retention.js'

// Attachments of a read share across journals (phase 5 stage 8): bob opens
// an attachment of alice's shared mission on his own journal, which pulls
// its bytes from hers with a signed media.fetch the first time.

const upload = async (s, token, bytes, type = 'image/png') => {
  const r = await fetch(s.base + '/media', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: bytes })
  assert.equal(r.status, 200)
  return r.json()
}
const raw = async (s, token, path, headers = {}) => {
  const r = await fetch(s.base + path, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } })
  return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) }
}

async function shared(t) {
  const w = await world(t)
  const boxToken = (await w.a.http('/login', post({ username: 'alice', password: 'pw', device_name: 'alice-phone-2' }))).json.token
  w.bytes = Buffer.from('a garden plan, as a picture')
  const up = await upload(w.a, boxToken, w.bytes, 'text/plain')
  const q = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'question', title: 'Which layout?' }))).json.item
  await w.aliceBox(`/items/${q.id}/comments`, post({ convo_id: 'work', body: 'This one', attachments: [{ blob_ref: up.media_id, mime: 'text/plain', name: 'plan.txt', size: up.size }] }))
  // On an owner-only item of the same mission: never served.
  const secretBytes = Buffer.from('owner only')
  const up2 = await upload(w.a, boxToken, secretBytes, 'text/plain')
  const own = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'task', title: 'Owner only', private: true }))).json.item
  await w.aliceBox(`/items/${own.id}/comments`, post({ convo_id: 'work', body: 'mine', attachments: [{ blob_ref: up2.media_id, mime: 'text/plain', name: 'mine.txt', size: up2.size }] }))
  const g = await offer(w)
  await w.phones.bob(`/grants/${incoming(w.b)[0].id}/answer`, post({ decision: 'approve' }))
  await w.settle()
  assert.equal(grantOf(w.a, g.id).state, 'active')
  const bobToken = (await w.b.http('/login', post({ username: 'bob', password: 'pw', device_name: 'bob-raw' }))).json.token
  const [item] = (await w.phones.bob('/items?scope=shared')).json.items
  const [att] = (await w.phones.bob(`/items/${item.id}`)).json.comments[0].attachments
  return { w, g, up, up2, att, bobToken }
}

test('bob opens an attachment: his journal pulls it from alice\'s once, then keeps it', async (t) => {
  const { w, up, att, bobToken } = await shared(t)
  assert.deepEqual([att.name, att.mime, att.size], ['plan.txt', 'text/plain', up.size])
  assert.ok(/^[0-9a-f]{32}$/.test(att.blob_ref) && att.blob_ref !== up.media_id, 'a local id, not the owner\'s')
  const r = await raw(w.b, bobToken, `/media/${att.blob_ref}`)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, w.bytes)
  assert.equal(r.headers.get('content-disposition'), 'attachment')
  const row = w.b.db.prepare('SELECT * FROM fed_media WHERE id=?').get(att.blob_ref)
  assert.ok(row.disk_path && fs.existsSync(row.disk_path))
  // Counted in bob's quota.
  assert.equal(w.b.db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM fed_media WHERE user_id=? AND disk_path IS NOT NULL').get(row.user_id).n, up.size)
  // Served from the copy now: alice's blob can go and bob still reads it.
  w.a.db.prepare('UPDATE blobs SET disk_path=? WHERE id=?').run('/nonexistent', up.media_id)
  assert.deepEqual((await raw(w.b, bobToken, `/media/${att.blob_ref}`)).body, w.bytes)

  // Nobody else on bob's journal reads it.
  await createUser(w.b.db, 'carol', 'pw')
  const carol = (await w.b.http('/login', post({ username: 'carol', password: 'pw', device_name: 'carol-phone' }))).json.token
  assert.equal((await raw(w.b, carol, `/media/${att.blob_ref}`)).status, 404)
})

test('alice\'s journal serves only what the share shows, to the journal it was shared with', async (t) => {
  const { w, g, up, up2 } = await shared(t)
  const fetchAs = (from, body, key = w.b.federation.key.privateKey) => {
    const envelope = signEnvelope({ from, to: 'alice@a.example', op: 'media.fetch', id: newOpId(), body, ts: Date.now() }, key)
    return raw(w.a, null, MEDIA_PATH, { [MEDIA_HEADER]: Buffer.from(JSON.stringify(envelope)).toString('base64url') })
  }
  const ok = await fetchAs('bob@b.example', { grant: g.id, media: up.media_id })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, w.bytes)
  assert.equal((await fetchAs('bob@b.example', { grant: g.id, media: up2.media_id })).status, 404, 'an owner-only item\'s attachment')
  assert.equal((await fetchAs('carol@b.example', { grant: g.id, media: up.media_id })).status, 403, 'not the grantee')
  assert.equal((await fetchAs('bob@b.example', { grant: g.id, media: up.media_id }, w.a.federation.key.privateKey)).status, 403, 'not their key')
  assert.equal((await raw(w.a, null, MEDIA_PATH)).status, 400)
  assert.equal((await raw(w.a, null, MEDIA_PATH, { [MEDIA_HEADER]: 'nope' })).status, 400)
  const stale = signEnvelope({ from: 'bob@b.example', to: 'alice@a.example', op: 'media.fetch', id: newOpId(), body: { grant: g.id, media: up.media_id }, ts: Date.now() - 3600_000 }, w.b.federation.key.privateKey)
  assert.equal((await raw(w.a, null, MEDIA_PATH, { [MEDIA_HEADER]: Buffer.from(JSON.stringify(stale)).toString('base64url') })).status, 401)
  // Ended: nothing more.
  assert.equal((await w.phones.alice(`/grants/${g.id}`, { method: 'DELETE' })).status, 200)
  assert.equal((await fetchAs('bob@b.example', { grant: g.id, media: up.media_id })).status, 403)
})

test('when the share ends the copy\'s attachments go, bytes and all', async (t) => {
  const { w, g, att, bobToken } = await shared(t)
  assert.equal((await raw(w.b, bobToken, `/media/${att.blob_ref}`)).status, 200)
  const file = w.b.db.prepare('SELECT disk_path FROM fed_media WHERE id=?').get(att.blob_ref).disk_path
  assert.equal((await w.phones.alice(`/grants/${g.id}`, { method: 'DELETE' })).status, 200)
  await w.settle()
  assert.equal((await raw(w.b, bobToken, `/media/${att.blob_ref}`)).status, 404)
  assert.equal(purgeReplicaMedia(w.b.db), 1)
  assert.ok(!fs.existsSync(file))
  assert.equal(w.b.db.prepare('SELECT COUNT(*) AS n FROM fed_media').get().n, 0)
})

test('bytes that do not match, or a full quota, are not kept', async (t) => {
  const { w, att, bobToken } = await shared(t)
  w.b.db.prepare("UPDATE fed_media SET sha256=? WHERE id=?").run('0'.repeat(64), att.blob_ref)
  assert.equal((await raw(w.b, bobToken, `/media/${att.blob_ref}`)).status, 502)
  assert.equal(w.b.db.prepare('SELECT disk_path FROM fed_media WHERE id=?').get(att.blob_ref).disk_path, null)
  const bob = w.b.db.prepare("SELECT id FROM users WHERE name='bob'").get().id
  insertBlob(w.b.db, { id: 'f'.repeat(32), ownerUserId: bob, contentType: 'text/plain', size: 10 * 1024 ** 4, sha256: '0'.repeat(64), diskPath: '/nonexistent' })
  assert.equal((await raw(w.b, bobToken, `/media/${att.blob_ref}`)).status, 413)
})

test('the attachment record crosses with what the protocol names, and private ones not at all', async (t) => {
  const { w, up, up2 } = await shared(t)
  const text = w.a.db.prepare("SELECT body FROM fed_outbox WHERE op IN ('mission.snapshot','mission.event')").all().map((r) => r.body).join('\n')
  assert.ok(text.includes(up.media_id))
  assert.ok(!text.includes(up2.media_id), 'an owner-only item\'s attachment never crosses')
  for (const body of w.a.db.prepare("SELECT body FROM fed_outbox WHERE op IN ('mission.snapshot','mission.event')").all().map((r) => JSON.parse(r.body))) {
    const items = body.items ?? (body.kind === 'item' && body.record ? [body.record] : [])
    for (const i of items) for (const c of i.comments) for (const a of c.attachments ?? []) {
      assert.deepEqual(Object.keys(a).filter((k) => !['media', 'name', 'mime', 'size', 'sha256', 'width', 'height', 'transcript'].includes(k)), [])
    }
  }
})

test('an attachment on the item\'s own description crosses too', async (t) => {
  const { w, bobToken } = await shared(t)
  const token = (await w.a.http('/login', post({ username: 'alice', password: 'pw', device_name: 'alice-phone-3' }))).json.token
  const bytes = Buffer.from('seed list')
  const up = await upload(w.a, token, bytes, 'text/plain')
  await w.aliceBox('/items', post({ convo_id: 'work', kind: 'task', title: 'Buy seeds', attachments: [{ blob_ref: up.media_id, mime: 'text/plain', name: 'seeds.txt', size: up.size }] }))
  await w.settle()
  const item = (await w.phones.bob('/items?scope=shared')).json.items.find((i) => i.title === 'Buy seeds')
  const one = (await w.phones.bob(`/items/${item.id}`)).json
  assert.deepEqual(one.item.attachments.map((a) => a.name), ['seeds.txt'])
  const r = await raw(w.b, bobToken, `/media/${one.item.attachments[0].blob_ref}`)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, bytes)
})

test('the size that crosses is the blob\'s, not the one written on the attachment', async (t) => {
  const { w, bobToken } = await shared(t)
  const token = (await w.a.http('/login', post({ username: 'alice', password: 'pw', device_name: 'alice-phone-3' }))).json.token
  const bytes = Buffer.from('a picture of the shed')
  const up = await upload(w.a, token, bytes, 'image/png')
  const q = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'task', title: 'Paint the shed' }))).json.item
  await w.aliceBox(`/items/${q.id}/comments`, post({ convo_id: 'work', body: 'Like this', attachments: [{ blob_ref: up.media_id, mime: 'image/png', name: 'shed.png', size: up.size + 100 }] }))
  await w.settle()
  const item = (await w.phones.bob('/items?scope=shared')).json.items.find((i) => i.title === 'Paint the shed')
  assert.equal(item.has_image, true, 'the list shows the picture hint')
  const [att] = (await w.phones.bob(`/items/${item.id}`)).json.comments.at(-1).attachments
  assert.equal(att.size, up.size)
  const r = await raw(w.b, bobToken, `/media/${att.blob_ref}`)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, bytes)
})

test('over quota, the reaper drops kept copies first and the next read pulls them again', async (t) => {
  const { w, att, bobToken } = await shared(t)
  assert.equal((await raw(w.b, bobToken, `/media/${att.blob_ref}`)).status, 200)
  const file = w.b.db.prepare('SELECT disk_path FROM fed_media WHERE id=?').get(att.blob_ref).disk_path
  const r = runReapMedia(w.b.db, { quotaBytes: w.bytes.length + 2 })
  assert.equal(r.reaped, 1)
  assert.equal(r.bytesFreed, w.bytes.length)
  assert.ok(!fs.existsSync(file))
  assert.equal(w.b.db.prepare('SELECT disk_path FROM fed_media WHERE id=?').get(att.blob_ref).disk_path, null)
  const again = await raw(w.b, bobToken, `/media/${att.blob_ref}`)
  assert.equal(again.status, 200)
  assert.deepEqual(again.body, w.bytes)
})

test('kept copies go even when the rest of the user\'s files cannot be reaped', async (t) => {
  const { w, att, bobToken } = await shared(t)
  assert.equal((await raw(w.b, bobToken, `/media/${att.blob_ref}`)).status, 200)
  // A fresh upload of bob's own: under the orphan grace period, never reaped.
  await upload(w.b, bobToken, Buffer.alloc(200, 1), 'application/octet-stream')
  const r = runReapMedia(w.b.db, { quotaBytes: 100 })
  assert.equal(r.reaped, 1)
  assert.equal(w.b.db.prepare('SELECT disk_path FROM fed_media WHERE id=?').get(att.blob_ref).disk_path, null)
  assert.equal(w.b.db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n, 1, 'bob\'s own upload stays')
})

test('a record naming other bytes for the same media drops the kept copy', async (t) => {
  const { w, up, att, bobToken } = await shared(t)
  assert.equal((await raw(w.b, bobToken, `/media/${att.blob_ref}`)).status, 200)
  const row = w.b.db.prepare('SELECT * FROM fed_media WHERE id=?').get(att.blob_ref)
  const incoming = w.b.db.prepare('SELECT * FROM fed_grants_in WHERE id=?').get(row.fg_id)
  // The same bytes again keep the copy.
  localMedia(w.b.db, incoming, { media: up.media_id, mime: row.mime, size: row.size, sha256: row.sha256 })
  assert.equal(w.b.db.prepare('SELECT disk_path FROM fed_media WHERE id=?').get(att.blob_ref).disk_path, row.disk_path)
  localMedia(w.b.db, incoming, { media: up.media_id, mime: row.mime, size: row.size, sha256: '1'.repeat(64) })
  assert.equal(w.b.db.prepare('SELECT disk_path FROM fed_media WHERE id=?').get(att.blob_ref).disk_path, null)
  assert.ok(!fs.existsSync(row.disk_path))
})

test('pulls of different files at once count against the quota together', async (t) => {
  const { w, att } = await shared(t)
  const token = (await w.a.http('/login', post({ username: 'alice', password: 'pw', device_name: 'alice-phone-3' }))).json.token
  const more = Buffer.from('a second garden plan, same size')
  const up = await upload(w.a, token, more, 'text/plain')
  const q = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'task', title: 'Second plan' }))).json.item
  await w.aliceBox(`/items/${q.id}/comments`, post({ convo_id: 'work', body: 'And this', attachments: [{ blob_ref: up.media_id, mime: 'text/plain', name: 'two.txt', size: up.size }] }))
  await w.settle()
  const second = w.b.db.prepare('SELECT id FROM fed_media WHERE ref=?').get(up.media_id).id
  const bySha = new Map([[crypto.createHash('sha256').update(w.bytes).digest('hex'), w.bytes], [crypto.createHash('sha256').update(more).digest('hex'), more]])
  const client = {
    async request(url, opts) {
      await new Promise((r) => setTimeout(r, 50))
      const env = JSON.parse(Buffer.from(opts.headers[MEDIA_HEADER], 'base64url').toString())
      const row = w.b.db.prepare('SELECT sha256 FROM fed_media WHERE ref=?').get(env.body.media)
      return { status: 200, body: bySha.get(row.sha256) }
    },
  }
  const media = makeReplicaMedia({ db: w.b.db, federation: w.b.federation, client, mediaDir: fs.mkdtempSync('/tmp/fedmedia-'), mediaMaxBytes: 1e6, quotaBytes: w.bytes.length + more.length - 1 })
  const bob = w.b.db.prepare("SELECT id FROM users WHERE name='bob'").get().id
  const res = () => Object.assign(new Writable({ write(_c, _e, cb) { cb() } }), { status: 0, writeHead(s) { this.status = s } })
  const [r1, r2] = [res(), res()]
  await Promise.all([media.serve({}, r1, { userId: bob }, att.blob_ref).catch(() => {}), media.serve({}, r2, { userId: bob }, second).catch(() => {})])
  assert.deepEqual([r1.status, r2.status].sort(), [200, 413])
})
