// Approval keys: statement format and signature verification. A device holds
// a P-256 key and signs a statement (ES256) for a dangerous action; this
// module is the pure format/crypto layer. The public key travels as base64url
// of the 65-byte uncompressed point (0x04 || X || Y), the key id is the
// lowercase hex SHA-256 of those 65 bytes, the signature is base64url of the
// ASN.1 DER signature, and the signed bytes are the RFC 8785 canonical string
// of the statement.

import crypto from 'node:crypto'
import { canonicalize } from './federation-jcs.js'

const TYPES = ['item_tap', 'consent', 'account']
const SUBJECT_MAX_KEYS = 12
const SUBJECT_MAX_LEN = 200
const COMMON = ['v', 'type', 'journal', 'user', 'key_id', 'nonce', 'signed_at', 'subject']
const TAP_ONLY = ['item', 'action', 'prompt_digest']

function publicKeyObject(publicKeyB64u) {
  if (typeof publicKeyB64u !== 'string') throw new Error('bad_public_key')
  const raw = Buffer.from(publicKeyB64u, 'base64url')
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('bad_public_key')
  try {
    // Throws unless the point is on the curve.
    const key = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
      format: 'jwk',
    })
    return { key, raw }
  } catch {
    throw new Error('bad_public_key')
  }
}

export function keyIdOf(publicKeyB64u) {
  return crypto.createHash('sha256').update(publicKeyObject(publicKeyB64u).raw).digest('hex')
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string' && v.length > 0

export function validSubject(s) {
  if (!isObj(s)) return false
  const entries = Object.entries(s)
  if (entries.length > SUBJECT_MAX_KEYS) return false
  return entries.every(([k, v]) => k.length <= SUBJECT_MAX_LEN && typeof v === 'string' && v.length <= SUBJECT_MAX_LEN)
}

// The statement object when `s` is the canonical string of a well-formed
// statement, otherwise null. Never throws.
export function parseStatement(s) {
  try {
    if (typeof s !== 'string') return null
    const o = JSON.parse(s)
    if (!isObj(o) || canonicalize(o) !== s) return null
    if (o.v !== 1 || !TYPES.includes(o.type)) return null
    if (!['journal', 'user', 'key_id', 'nonce'].every((k) => isStr(o[k]))) return null
    if (!Number.isSafeInteger(o.signed_at) || !validSubject(o.subject)) return null
    const tap = o.type === 'item_tap'
    const allowed = tap ? [...COMMON, ...TAP_ONLY] : COMMON
    if (Object.keys(o).some((k) => !allowed.includes(k))) return null
    if (tap) {
      const it = o.item
      if (!isObj(it) || Object.keys(it).sort().join() !== 'id,num,reply_to') return null
      if (typeof it.id !== 'string' || !Number.isSafeInteger(it.num)) return null
      if (it.reply_to !== null && typeof it.reply_to !== 'string') return null
      if (!isStr(o.action) || typeof o.prompt_digest !== 'string') return null
    }
    return o
  } catch {
    return null
  }
}

// What a signed tap commits to: an item's title and body, or a comment's body.
export function promptDigest(input) {
  if (!isObj(input)) throw new TypeError('bad_prompt')
  const { title, body } = input
  if (typeof body !== 'string' || (title !== undefined && typeof title !== 'string')) throw new TypeError('bad_prompt')
  const prompt = title === undefined ? { body } : { title, body }
  return crypto.createHash('sha256').update(canonicalize(prompt), 'utf8').digest('hex')
}

export function verifySignature(publicKeyB64u, statementString, signatureB64u) {
  try {
    if (typeof statementString !== 'string' || typeof signatureB64u !== 'string') return false
    const { key } = publicKeyObject(publicKeyB64u)
    return crypto.verify('sha256', Buffer.from(statementString, 'utf8'), key, Buffer.from(signatureB64u, 'base64url'))
  } catch {
    return false
  }
}
