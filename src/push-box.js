// Sealed notification content ("the box"): what a push says, encrypted by
// the journal to one device's public key, so the push relay and Apple carry
// only ciphertext. The device's notification extension holds the private key
// and opens it (docs/protocol.md "Sealed notification content").
//
// The construction is HPKE (RFC 9180), base mode, single shot:
// DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305. It is written
// out here over node:crypto because node has no HPKE API; Apple's CryptoKit
// has one, and test/push-box.test.js pins a vector both sides agree on.
import crypto from 'node:crypto'

const KEM_ID = 0x0020 // DHKEM(X25519, HKDF-SHA256)
const KDF_ID = 0x0001 // HKDF-SHA256
const AEAD_ID = 0x0003 // ChaCha20-Poly1305
const NK = 32
const NN = 12
const NSECRET = 32
const KEY_BYTES = 32

// Bound into the key schedule, so a box sealed for another purpose never
// opens as a notification. A new content version gets a new string.
export const BOX_INFO = Buffer.from('matron-push-v1')
// The sealed JSON is padded with spaces to a multiple of this, so the
// ciphertext's length says little about the text inside.
export const BOX_PAD_BYTES = 256
// Largest padded plaintext. With the 32-byte encapsulated key and the
// 16-byte tag this is 2112 base64url characters, which leaves room in
// APNs' 4096-byte payload for the visible fallback alert around it.
export const BOX_MAX_PLAIN_BYTES = 1536
export const BOX_MAX_CHARS = Math.ceil((KEY_BYTES + BOX_MAX_PLAIN_BYTES + 16) * 4 / 3)
const BOX_RE = /^[A-Za-z0-9_-]+$/

const i2osp = (n, len) => {
  const b = Buffer.alloc(len)
  b.writeUIntBE(n, 0, len)
  return b
}
const KEM_SUITE = Buffer.concat([Buffer.from('KEM'), i2osp(KEM_ID, 2)])
const HPKE_SUITE = Buffer.concat([Buffer.from('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2)])
const VERSION = Buffer.from('HPKE-v1')
const EMPTY = Buffer.alloc(0)

const extract = (salt, ikm) => crypto.createHmac('sha256', salt.length ? salt : Buffer.alloc(32)).update(ikm).digest()
function expand(prk, info, len) {
  const out = []
  let prev = EMPTY
  for (let i = 1; Buffer.concat(out).length < len; i += 1) {
    prev = crypto.createHmac('sha256', prk).update(prev).update(info).update(Buffer.from([i])).digest()
    out.push(prev)
  }
  return Buffer.concat(out).subarray(0, len)
}
const labeledExtract = (suite, salt, label, ikm) => extract(salt, Buffer.concat([VERSION, suite, Buffer.from(label), ikm]))
const labeledExpand = (suite, prk, label, info, len) => expand(prk, Buffer.concat([i2osp(len, 2), VERSION, suite, Buffer.from(label), info]), len)

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const publicKeyObject = (raw) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64url(raw) }, format: 'jwk' })
const privateKeyObject = (raw, pub) => crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: b64url(raw), x: b64url(pub) }, format: 'jwk' })

function keySchedule(sharedSecret, info) {
  const pskIdHash = labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY)
  const infoHash = labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info)
  const context = Buffer.concat([Buffer.from([0]), pskIdHash, infoHash]) // mode_base
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, 'secret', EMPTY)
  return {
    key: labeledExpand(HPKE_SUITE, secret, 'key', context, NK),
    nonce: labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, NN),
  }
}

function sharedSecretOf(dh, enc, recipientPublic) {
  const prk = labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', dh)
  return labeledExpand(KEM_SUITE, prk, 'shared_secret', Buffer.concat([enc, recipientPublic]), NSECRET)
}

// A device's registered public key: 32 raw X25519 bytes, base64url without
// padding (43 characters). Returns the canonical string, or null.
export function parsePushKey(value) {
  if (typeof value !== 'string' || value.length !== 43 || !BOX_RE.test(value)) return null
  const raw = Buffer.from(value, 'base64url')
  return raw.length === KEY_BYTES ? b64url(raw) : null
}

// Seals `plaintext` (a Buffer) to `recipientKey` (a parsePushKey string).
// Returns enc || ciphertext || tag as base64url. `ephemeral` is a test seam:
// a fixed {publicKey, privateKey} pair of raw 32-byte Buffers.
export function sealBox(recipientKey, plaintext, { ephemeral } = {}) {
  const recipientPublic = Buffer.from(recipientKey, 'base64url')
  let eph = ephemeral
  if (!eph) {
    const pair = crypto.generateKeyPairSync('x25519')
    eph = {
      publicKey: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url'),
      privateKey: Buffer.from(pair.privateKey.export({ format: 'jwk' }).d, 'base64url'),
    }
  }
  const dh = crypto.diffieHellman({
    privateKey: privateKeyObject(eph.privateKey, eph.publicKey),
    publicKey: publicKeyObject(recipientPublic),
  })
  const { key, nonce } = keySchedule(sharedSecretOf(dh, eph.publicKey, recipientPublic), BOX_INFO)
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  return b64url(Buffer.concat([eph.publicKey, sealed]))
}

// The recipient's half, for tests: the device does this in its notification
// extension. `recipient` is {publicKey, privateKey} of raw 32-byte Buffers.
export function openBox(recipient, box) {
  const raw = Buffer.from(box, 'base64url')
  const enc = raw.subarray(0, KEY_BYTES)
  const body = raw.subarray(KEY_BYTES, raw.length - 16)
  const tag = raw.subarray(raw.length - 16)
  const dh = crypto.diffieHellman({
    privateKey: privateKeyObject(recipient.privateKey, recipient.publicKey),
    publicKey: publicKeyObject(enc),
  })
  const { key, nonce } = keySchedule(sharedSecretOf(dh, enc, recipient.publicKey), BOX_INFO)
  const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

// Is `value` shaped like a box? What the relay checks before forwarding one:
// it cannot tell ciphertext from anything else, only bound and constrain it.
export function isBoxShaped(value) {
  return typeof value === 'string' && value.length >= 64 && value.length <= BOX_MAX_CHARS && BOX_RE.test(value)
}

const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
// Cut on code points, so a cut never splits a surrogate pair.
function cut(text, max) {
  const chars = Array.from(text)
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text
}

export const BOX_TITLE_CHARS = 120
export const BOX_SUBTITLE_CHARS = 80
export const BOX_BODY_CHARS = 240

// The JSON a box carries, as padded bytes ready to seal. Keys:
//   v         1
//   title, subtitle?, body   what the notification shows
//   convo_id, seq            where a tap goes, and the event it stands for
//   kind                     the push category (attention | done | activity)
//   item?     {id, num, kind, actions: [label], reply_to?}  the tracker item
//             it is about; `actions` are the buttons it offers now, and
//             `reply_to` the comment they belong to (absent: the item's own)
// Text is shortened until the whole thing fits BOX_MAX_PLAIN_BYTES: the body
// first, then the subtitle, then the title.
export function boxPlaintext({ title, subtitle, body, convoId, seq, kind, item }) {
  const content = {
    v: 1,
    title: cut(oneLine(title), BOX_TITLE_CHARS),
    ...(oneLine(subtitle) ? { subtitle: cut(oneLine(subtitle), BOX_SUBTITLE_CHARS) } : {}),
    body: cut(oneLine(body), BOX_BODY_CHARS),
    convo_id: convoId,
    seq,
    kind,
    ...(item ? { item } : {}),
  }
  let json = Buffer.from(JSON.stringify(content))
  for (const field of ['body', 'subtitle', 'title']) {
    while (json.length > BOX_MAX_PLAIN_BYTES && content[field]) {
      const half = Math.floor(Array.from(content[field]).length / 2)
      content[field] = half < 8 ? '' : cut(content[field], half)
      json = Buffer.from(JSON.stringify(content))
    }
  }
  if (json.length > BOX_MAX_PLAIN_BYTES) return null
  const padded = Buffer.alloc(Math.ceil(json.length / BOX_PAD_BYTES) * BOX_PAD_BYTES, 0x20)
  json.copy(padded)
  return padded
}
