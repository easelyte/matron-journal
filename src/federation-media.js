// Attachments of a read share across journals (docs/protocol.md "Shares
// across journals": attachments). An attachment never rides in an envelope:
// the snapshot and events name it, and the grantee's journal pulls its bytes
// with a signed `media.fetch` the first time someone opens it.
//
//   GET /federation/v1/media   header Matron-Federation: base64url(envelope)
//     envelope {v, from: grantee, to: owner, op: 'media.fetch', id, ts,
//               body: {grant: gr_…, media: <owner's blob id>}, sig}
//
// The owner's journal checks the envelope as for an op (pinned key, fresh,
// to a user here), then that the grant is live and given to that address
// under that key, and that the blob is attached to a comment its grantee
// view shows (the same sieve as a grantee on one journal: never a consent
// mirror, an owner-only item, an item from a private box, or a withdrawn
// reply). Read-only, so there is no receipt: a replay inside the freshness
// window reads the same bytes again.
//
// The grantee's journal keeps one fed_media row per attachment of its copy,
// with an id of its own (the shape of a blob id), so the apps read it from
// GET /media/:id like any attachment. The bytes are fetched on first read,
// checked against the sha256 the record carried, counted in the grantee's
// media quota (db.js userBlobBytes), and kept until the share ends there.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { parseEnvelope, signEnvelope, verifyEnvelope, importPublicKey, newOpId } from './federation-envelope.js'
import { makeFederationLimiter } from './federation-inbound.js'
import { journalAllowed } from './federation-identity.js'
import { getGrantRaw } from './grants.js'
import { userBlobBytes } from './db.js'

export const MEDIA_OP = 'media.fetch'
export const MEDIA_PATH = '/federation/v1/media'
export const MEDIA_HEADER = 'matron-federation'
export const SHA_HEADER = 'matron-media-sha256'
const HEADER_MAX = 8192
const MEDIA_REF = /^[A-Za-z0-9_-]{1,128}$/
const fail = (code) => { throw new Error(code) }
const hostOf = (address) => address.slice(address.indexOf('@') + 1)
const nameOf = (address) => address.slice(0, address.indexOf('@'))
export const isMediaRef = (v) => typeof v === 'string' && MEDIA_REF.test(v)

// The headers a blob is served with, on either journal (as http.js GET
// /media/:id): the type is the uploader's, so it is never sniffed or shown
// inline on this origin.
const blobHeaders = (contentType, size) => ({
  'content-type': contentType,
  'content-length': String(size),
  'cache-control': 'private, max-age=31536000, immutable',
  'x-content-type-options': 'nosniff',
  'content-disposition': 'attachment',
})

// --- The owner's journal ----------------------------------------------------

// The blob `blobId`, if grant `g`'s grantee view shows a comment it is
// attached to. null otherwise.
export function grantedBlob(db, g, blobId) {
  return db.prepare(`SELECT b.* FROM blobs b WHERE b.id = @id AND EXISTS (
      SELECT 1 FROM item_comments ic JOIN items i ON i.id = ic.item_id
      WHERE i.mission_id = @m AND i.user_id = b.owner_user_id AND i.consent IS NULL AND i.private = 0
        AND ic.withdrawn_at IS NULL AND ic.attachments LIKE '%"blob_ref":"' || @id || '"%'
        AND NOT EXISTS (SELECT 1 FROM conversations pc JOIN private_devices pd ON pd.id = pc.agent_device_id WHERE pc.id = i.origin_convo_id))`)
    .get({ id: blobId, m: g.subject_id }) ?? null
}

// GET /federation/v1/media. → true when the path was ours.
export function makeMediaHandler({ db, federation, limiter = makeFederationLimiter(), now = Date.now, log = console }) {
  const findPeer = db.prepare('SELECT host, key_pub, state FROM fed_peers WHERE host=?')
  const send = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store' })
    res.end(text)
  }
  return async function handleMedia(req, res, url) {
    if (url.pathname !== MEDIA_PATH) return false
    if (!federation?.enabled) { send(res, 404, { error: 'not_found' }); return true }
    if (req.method !== 'GET') { res.setHeader('allow', 'GET'); send(res, 405, { error: 'method_not_allowed' }); return true }
    let envelope
    try {
      const raw = req.headers[MEDIA_HEADER]
      if (typeof raw !== 'string' || raw.length > HEADER_MAX) fail('malformed')
      envelope = parseEnvelope(Buffer.from(raw, 'base64url'))
    } catch { send(res, 400, { error: 'malformed' }); return true }
    if (envelope.op !== MEDIA_OP) { send(res, 400, { error: 'unknown_op' }); return true }
    const { grant, media } = envelope.body ?? {}
    if (typeof grant !== 'string' || !isMediaRef(media)) { send(res, 400, { error: 'malformed' }); return true }
    if (hostOf(envelope.to) !== federation.host) { send(res, 403, { error: 'not_here' }); return true }
    const host = hostOf(envelope.from)
    const peer = journalAllowed(federation, host) ? findPeer.get(host) : null
    let error = null
    if (!peer || peer.state !== 'active') error = peer ? 'peer_refused' : 'unknown_journal'
    else {
      try { verifyEnvelope(envelope, importPublicKey(peer.key_pub), { now: now() }) } catch (err) { error = err }
    }
    // The limits of POST /federation/v1: a journal that proved its key from
    // its own bucket, anyone else from the strangers' one.
    // Attachments have a bucket of their own per peer, so opening a thread
    // full of pictures does not hold up that journal's ops, or the reverse.
    if (!(!error ? limiter.take(`media:${host}`) : limiter.takeStranger())) { res.setHeader('retry-after', '1'); send(res, 429, { error: 'rate_limited' }); return true }
    if (typeof error === 'string') { send(res, 403, { error }); return true }
    if (error) {
      if (error.message === 'stale') send(res, 401, { error: 'stale', clock: error.clock })
      else send(res, 403, { error: 'bad_signature' })
      return true
    }
    // The grant, live, theirs, under the key that signed.
    const g = getGrantRaw(db, grant)
    const contact = g ? db.prepare('SELECT state, peer_journal_key FROM contacts WHERE id=?').get(g.contact_id) : null
    if (!g || g.state !== 'active' || g.subject_kind !== 'mission' || g.level === 'owner' || g.owner_name !== nameOf(envelope.to)
      || `${g.grantee_name}@${g.grantee_journal}` !== envelope.from || contact?.state !== 'active' || contact.peer_journal_key !== peer.key_pub) {
      send(res, 403, { error: 'not_shared' })
      return true
    }
    const blob = grantedBlob(db, g, media)
    if (!blob) { send(res, 404, { error: 'not_found' }); return true }
    let stat
    try { stat = await fs.promises.stat(blob.disk_path) } catch { stat = null }
    if (!stat || stat.size !== blob.size) {
      log.error?.(`federation: media ${blob.id} is unreadable or the wrong size on disk`)
      send(res, 500, { error: 'internal' })
      return true
    }
    res.writeHead(200, { ...blobHeaders(blob.content_type, blob.size), [SHA_HEADER]: blob.sha256 })
    await pipeline(fs.createReadStream(blob.disk_path), res).catch(() => {})
    return true
  }
}

// --- The grantee's journal --------------------------------------------------

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i

// One attachment as it crossed (federation-replica.js readComment checks
// the rest): the local row for it, created on first sight. → the local id.
export function localMedia(d, incoming, a) {
  const mime = MIME.test(a.mime) ? a.mime.toLowerCase() : 'application/octet-stream'
  // Kept bytes stay bound to the hash they were checked against: a record
  // naming other bytes for the same media drops the copy, and the next read
  // pulls the new ones.
  const was = d.prepare('SELECT disk_path, sha256, size FROM fed_media WHERE fg_id=? AND ref=?').get(incoming.id, a.media)
  if (was?.disk_path && (was.sha256 !== a.sha256 || was.size !== a.size)) fs.rmSync(was.disk_path, { force: true })
  d.prepare(`INSERT INTO fed_media(id, fg_id, user_id, ref, mime, size, sha256, created_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(fg_id, ref) DO UPDATE SET mime=excluded.mime, size=excluded.size, sha256=excluded.sha256,
      disk_path = CASE WHEN fed_media.sha256 = excluded.sha256 AND fed_media.size = excluded.size THEN fed_media.disk_path END,
      fetched_at = CASE WHEN fed_media.sha256 = excluded.sha256 AND fed_media.size = excluded.size THEN fed_media.fetched_at END`)
    .run(crypto.randomBytes(16).toString('hex'), incoming.id, incoming.user_id, a.media, mime, a.size, a.sha256, Date.now())
  return d.prepare('SELECT id FROM fed_media WHERE fg_id=? AND ref=?').get(incoming.id, a.media).id
}

// A fed_media row the user may read now: their share is live, its contact
// too, and their copy still shows the attachment.
function readableRow(db, userId, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return null
  return db.prepare(`SELECT f.*, g.peer_grant_ref, g.owner_name, g.peer_host, g.user_id AS grantee_user_id FROM fed_media f
    JOIN fed_grants_in g ON g.id = f.fg_id AND g.state = 'active'
    JOIN contacts c ON c.id = g.contact_id AND c.state = 'active'
    WHERE f.id = @id AND f.user_id = @user AND g.user_id = @user
      AND EXISTS (SELECT 1 FROM fed_replica_items r WHERE r.fg_id = f.fg_id AND (r.comments LIKE '%"blob_ref":"' || f.id || '"%' OR r.attachments LIKE '%"blob_ref":"' || f.id || '"%'))`)
    .get({ id, user: userId }) ?? null
}

// `federation` the identity, `client` the outbound client. → {serve, purge}
export function makeReplicaMedia({ db, federation, client, mediaDir, mediaMaxBytes, quotaBytes = Infinity, now = Date.now, log = console }) {
  const inFlight = new Map()
  // Bytes being pulled, per user: pulls of different files at once count
  // against the quota together.
  const pending = new Map()
  const root = path.join(mediaDir, 'fed')

  async function fetchBytes(row) {
    const peer = db.prepare("SELECT base_url FROM fed_peers WHERE host=? AND state='active'").get(row.peer_host)
    if (!peer) fail('unreachable')
    const grantee = db.prepare('SELECT name FROM users WHERE id=?').get(row.grantee_user_id).name
    const envelope = signEnvelope({
      from: `${grantee}@${federation.host}`, to: `${row.owner_name}@${row.peer_host}`, op: MEDIA_OP, id: newOpId(now()),
      body: { grant: row.peer_grant_ref, media: row.ref }, ts: now(),
    }, federation.key.privateKey)
    const header = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')
    const pull = async () => {
      try {
        return await client.request(new URL(MEDIA_PATH, peer.base_url).href, { headers: { [MEDIA_HEADER]: header }, maxBytes: mediaMaxBytes })
      } catch (err) {
        return fail(err.message === 'too_large' ? 'too_large' : 'unreachable')
      }
    }
    let r = await pull()
    // Their journal's limits: wait as it asks (a second or two at most,
    // someone is waiting on this read) and try once more; still limited is
    // `busy`, which the reader can retry.
    if (r.status === 429) {
      const wait = Math.min(2, Math.max(0, Number(r.headers?.['retry-after']) || 1))
      await new Promise((resolve) => setTimeout(resolve, wait * 1000))
      r = await pull()
      if (r.status === 429) fail('busy')
    }
    if (r.status === 404 || r.status === 403) fail('gone')
    if (r.status !== 200) fail('unreachable')
    const sha = crypto.createHash('sha256').update(r.body).digest('hex')
    if (sha !== row.sha256 || r.body.length !== row.size) fail('mismatch')
    return r.body
  }

  // Fetches and keeps the bytes of `row`, once however many readers ask.
  function cache(row) {
    if (inFlight.has(row.id)) return inFlight.get(row.id)
    const p = (async () => {
      const held = pending.get(row.user_id) ?? 0
      if (userBlobBytes(db, row.user_id) + held + row.size > quotaBytes) fail('quota_exceeded')
      pending.set(row.user_id, held + row.size)
      try { return await keep(row) } finally {
        const left = (pending.get(row.user_id) ?? 0) - row.size
        if (left > 0) pending.set(row.user_id, left); else pending.delete(row.user_id)
      }
    })().finally(() => inFlight.delete(row.id))
    inFlight.set(row.id, p)
    return p
  }

  async function keep(row) {
    const bytes = await fetchBytes(row)
    const finalPath = path.join(root, row.id.slice(0, 2), row.id)
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true })
    await fs.promises.writeFile(`${finalPath}.tmp`, bytes)
    await fs.promises.rename(`${finalPath}.tmp`, finalPath)
    // The share may have ended while the bytes were on their way.
    // So may the record, naming other bytes: keep these only if they are
    // still the ones it names.
    const kept = db.prepare('UPDATE fed_media SET disk_path=?, fetched_at=? WHERE id=? AND disk_path IS NULL AND sha256=? AND size=?')
      .run(finalPath, now(), row.id, row.sha256, row.size).changes
    if (!kept || !readableRow(db, row.user_id, row.id)) { await fs.promises.unlink(finalPath).catch(() => {}); fail('gone') }
    return finalPath
  }

  // GET /media/:id for an attachment of a copy. → false when `id` is none
  // the user may read (the caller answers its usual 404).
  async function serve(req, res, who, id) {
    const row = readableRow(db, who.userId, id)
    if (!row) return false
    let file = row.disk_path
    if (!file) {
      try { file = await cache(row) } catch (err) {
        const [status, error] = { quota_exceeded: [413, 'quota_exceeded'], too_large: [413, 'too_large'], gone: [404, 'not_found'], busy: [503, 'peer_busy'] }[err.message] ?? [502, 'peer_unreachable']
        if (status === 502) log.error?.(`federation: media ${row.id} from ${row.peer_host}: ${err.message}`)
        const text = JSON.stringify({ error: error })
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...(status === 503 ? { 'retry-after': '5' } : {}) })
        res.end(text)
        return true
      }
    }
    let stat
    try { stat = await fs.promises.stat(file) } catch { stat = null }
    if (!stat || stat.size !== row.size) {
      // Gone from disk: forget it, and the next read fetches it again.
      db.prepare('UPDATE fed_media SET disk_path=NULL, fetched_at=NULL WHERE id=?').run(row.id)
      const text = JSON.stringify({ error: 'internal' })
      res.writeHead(500, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) })
      res.end(text)
      return true
    }
    res.writeHead(200, blobHeaders(row.mime, row.size))
    await pipeline(fs.createReadStream(file), res).catch(() => {})
    return true
  }

  return { serve, purge: () => purgeReplicaMedia(db) }
}

// Drops every fed_media row whose share is no longer active here, or whose
// copy no longer shows it, and the bytes kept for it. → rows dropped.
export function purgeReplicaMedia(db) {
  const rows = db.prepare(`SELECT f.id, f.disk_path FROM fed_media f LEFT JOIN fed_grants_in g ON g.id = f.fg_id
    WHERE g.id IS NULL OR g.state <> 'active'
      OR NOT EXISTS (SELECT 1 FROM fed_replica_items r WHERE r.fg_id = f.fg_id AND (r.comments LIKE '%"blob_ref":"' || f.id || '"%' OR r.attachments LIKE '%"blob_ref":"' || f.id || '"%'))`).all()
  for (const r of rows) {
    if (r.disk_path) { try { fs.unlinkSync(r.disk_path) } catch { /* already gone */ } }
    db.prepare('DELETE FROM fed_media WHERE id=?').run(r.id)
  }
  return rows.length
}
