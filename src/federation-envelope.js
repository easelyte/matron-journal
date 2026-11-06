// Signed federation envelopes (docs/protocol.md "Federation": envelopes).
// Pure functions: keys, op ids, signing, parsing and checking an envelope.
// No routes, no database — the inbound endpoint and the outbox build on
// these.
//
// An envelope is {v, from, to, op, id, ts, body, sig}. `sig` is Ed25519 over
// SIGNING_PREFIX followed by the JCS form of the envelope without `sig`; the
// prefix keeps a federation signature from being valid anywhere else the
// journal's key might sign. The receiver verifies over the JCS of the object
// it parsed, never over the bytes it received.
//
// An op gets its id once, when it is queued; every attempt keeps that id and
// body and is signed afresh with a new ts, so the freshness window applies
// to the attempt and a long outage never makes a retry stale.

import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'
import { canonicalize } from './federation-jcs.js'
import { parseStrict } from './federation-json.js'

export const SIGNING_PREFIX = 'matron-federation-v1\n'
export const MAX_ENVELOPE_BYTES = 1024 * 1024
export const FRESHNESS_MS = 5 * 60 * 1000

const fail = (code, extra) => { throw Object.assign(new Error(code), extra) }

// --- Keys -------------------------------------------------------------------

export function generateFederationKey() {
  return generateKeyPairSync('ed25519')
}

// The raw 32-byte public key, base64url without padding: how a journal's key
// is written in its well-known document and pinned on a contact row.
export function exportPublicKey(publicKey) {
  return publicKey.export({ format: 'jwk' }).x
}

export function importPublicKey(b64url) {
  if (typeof b64url !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(b64url)) fail('bad_key')
  if (Buffer.from(b64url, 'base64url').length !== 32) fail('bad_key')
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url }, format: 'jwk' })
  } catch { return fail('bad_key') }
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32(bytes) {
  let bits = 0, acc = 0, out = ''
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31]
  return out
}

// The journal fingerprint: the first 128 bits of SHA-256 of the raw public
// key, base32 (26 characters). An invite link carries it, and the invitee's
// journal refuses a well-known whose key does not match it.
export function keyFingerprint(publicKeyB64url) {
  const raw = Buffer.from(publicKeyB64url, 'base64url')
  return base32(createHash('sha256').update(raw).digest().subarray(0, 16))
}

// How people compare it: groups of four.
export function formatFingerprint(fp) {
  return fp.match(/.{1,4}/g).join(' ')
}

// --- Op ids -----------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// A ULID: 48 bits of milliseconds then 80 random bits, Crockford base32.
export function newOpId(now = Date.now(), random = randomBytes(10)) {
  let t = now, time = ''
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  let bits = 0, acc = 0, rand = ''
  for (const b of random) {
    acc = ((acc << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      rand += CROCKFORD[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return time + rand
}

export const isOpId = (s) => typeof s === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(s)

// --- Envelopes --------------------------------------------------------------

// `name@host`, host lower case with an optional port. The name part is a
// journal user name; the host names the journal.
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/
const OP = /^[a-z]+(?:\.[a-z_]+){0,3}$/
const SIG = /^[A-Za-z0-9_-]{86}$/
const FIELDS = ['v', 'from', 'to', 'op', 'id', 'ts', 'body', 'sig']

export const isAddress = (s) => typeof s === 'string' && ADDRESS.test(s)

export function signingBytes(envelope) {
  const { sig, ...rest } = envelope
  return Buffer.concat([Buffer.from(SIGNING_PREFIX, 'ascii'), Buffer.from(canonicalize(rest), 'utf8')])
}

// Signs one attempt of an op. Pass the op's id and body unchanged on every
// retry; ts defaults to now. Throws what parseEnvelope would answer, or
// 'not_canonical', rather than return an envelope a receiver must refuse.
export function signEnvelope({ from, to, op, id, body, ts = Date.now() }, privateKey) {
  const envelope = { v: 1, from, to, op, id, ts, body }
  checkShape({ ...envelope, sig: 'A'.repeat(86) })
  const signed = { ...envelope, sig: sign(null, signingBytes(envelope), privateKey).toString('base64url') }
  // Never sign what a receiver would refuse to parse (an unsafe integer, deep
  // nesting, over 1 MiB): that op could only ever go dead.
  parseEnvelope(Buffer.from(JSON.stringify(signed), 'utf8'))
  return signed
}

// Bytes off the wire (a Buffer or Uint8Array; a string is measured in UTF-8)
// → a shape-checked envelope. Error codes, each one a
// permanent 4xx to the sender: 'too_large', 'malformed',
// 'unsupported_version'.
export function parseEnvelope(bytes) {
  const size = typeof bytes === 'string' ? Buffer.byteLength(bytes, 'utf8') : bytes.byteLength
  if (size > MAX_ENVELOPE_BYTES) fail('too_large')
  const envelope = parseStrict(bytes)
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) fail('malformed')
  if (envelope.v !== 1) fail(Object.hasOwn(envelope, 'v') ? 'unsupported_version' : 'malformed')
  checkShape(envelope)
  return envelope
}

function checkShape(e) {
  const keys = Object.keys(e)
  if (keys.length !== FIELDS.length || !FIELDS.every((k) => Object.hasOwn(e, k))) fail('malformed')
  if (e.v !== 1) fail('unsupported_version')
  if (!isAddress(e.from) || !isAddress(e.to)) fail('malformed')
  if (typeof e.op !== 'string' || !OP.test(e.op)) fail('malformed')
  if (!isOpId(e.id)) fail('malformed')
  if (!Number.isSafeInteger(e.ts) || e.ts <= 0) fail('malformed')
  if (e.body === null || typeof e.body !== 'object' || Array.isArray(e.body)) fail('malformed')
  if (typeof e.sig !== 'string' || !SIG.test(e.sig)) fail('malformed')
}

// Checks the signature against the key pinned for the sender, then the
// attempt's freshness. 'bad_signature' is permanent; 'stale' carries the
// receiver's clock so the sender can log the skew and retry with a fresh ts.
// The shape is checked again (a caller may hand over an object it built
// itself), then the signature, so an unsigned caller learns nothing about
// the receiver's clock.
export function verifyEnvelope(envelope, publicKey, { now = Date.now(), windowMs = FRESHNESS_MS } = {}) {
  checkShape(envelope)
  const sig = Buffer.from(envelope.sig, 'base64url')
  let ok = false
  try { ok = sig.length === 64 && verify(null, signingBytes(envelope), publicKey, sig) } catch { ok = false }
  if (!ok) fail('bad_signature')
  if (Math.abs(now - envelope.ts) > windowMs) fail('stale', { clock: now })
  return envelope
}

// What a receipt stores to tell a repeat of an op from a reused id: SHA-256
// of the JCS form of {op, body}, hex.
export function opHash({ op, body }) {
  return createHash('sha256').update(canonicalize({ op, body }), 'utf8').digest('hex')
}

// --- Responses --------------------------------------------------------------

// A receiver signs what it answers, so the sender can trust a stored
// response replayed for a repeat as much as a fresh one. The signature goes
// in the `matron-federation-sig` header, over RESPONSE_PREFIX followed by
// the JCS form of {id, status, body}: `id` is the op's id, so an answer to
// one op is never valid as the answer to another.
export const RESPONSE_PREFIX = 'matron-federation-v1-response\n'
export const RESPONSE_SIG_HEADER = 'matron-federation-sig'

const responseBytes = ({ id, status, body }) =>
  Buffer.concat([Buffer.from(RESPONSE_PREFIX, 'ascii'), Buffer.from(canonicalize({ id, status, body }), 'utf8')])

export function signResponse({ id, status, body }, privateKey) {
  return sign(null, responseBytes({ id, status, body }), privateKey).toString('base64url')
}

export function verifyResponse({ id, status, body, sig }, publicKey) {
  if (typeof sig !== 'string' || !SIG.test(sig)) return false
  try { return verify(null, responseBytes({ id, status, body }), publicKey, Buffer.from(sig, 'base64url')) } catch { return false }
}
