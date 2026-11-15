#!/usr/bin/env node
// approval-verify.mjs: verify a signed approval offline, against pinned keys.
//
// An approval key is a device-held P-256 key that signs a statement for a
// dangerous action. A box that acts on such a request uses this file to check
// the signature itself instead of trusting the journal that relayed it.
//
// Vendoring: copy this one file. It is dependency-free (only node:crypto and
// node:fs, nothing from the journal's source) and carries its own RFC 8785
// canonical-JSON serialiser. Needs Node 20 or later.
//
// Pin the keys. The keys file ({"keys":[{"key_id","public_key","name"}]}) must
// be installed by configuration management, owned by root and not writable by
// the user the box's agent runs as. NEVER fetch keys from the journal, and
// never take them from the approval itself: a journal that can name the key
// can sign anything. A pinned entry whose public_key does not hash to its
// key_id is ignored.
//
// Wire formats: ES256 (ECDSA P-256, SHA-256). public_key is base64url of the
// 65-byte uncompressed point (0x04 || X || Y); key_id is the lowercase hex
// SHA-256 of those 65 bytes; signature is base64url of the ASN.1 DER
// signature; approval is {statement: <canonical JSON string>, signature}.
//
// Checks, in this order, the first failure being the reason returned:
//   bad_statement  the statement is not the RFC 8785 canonical string of a
//                  well-formed statement (v 1; type item_tap|consent|account;
//                  journal, user, key_id, nonce, signed_at, subject; item_tap
//                  also item {id,num,reply_to}, action, prompt_digest, which
//                  the other types must not carry; no unknown keys; subject a
//                  flat object of at most 12 string keys and values, each at
//                  most 200 characters)
//   unknown_key    key_id is not in the pinned file
//   signature      the signature does not verify under the pinned key
//   mismatch       journal, user, type, subject, or for a tap the item
//                  number, button label, reply_to (and prompt_digest and
//                  item id when given) differ from what the caller expects
//                  (see `expect`; subject must match exactly, extra or
//                  missing keys fail)
//   stale          signed_at is older than maxAgeMs (default 5 minutes) or
//                  more than 60 seconds in the future
//
// Freshness: pick maxAgeMs per kind of request. The five-minute default
// suits taps and unlocks only. The journal forwards a consent approval (a
// spawn, a chat invite, a file transfer) when the box can take it: after a
// wake, at the box's next hello, once an upload completes, so it can be
// minutes to hours old when it arrives. A window too short for the kind
// refuses genuine approvals as stale.
//
// Single use is the CALLER's job. This file keeps no state: after a successful
// verify, record statement.nonce in your own ledger (inside the same
// transaction as the action, ideally) and refuse a nonce seen before.
//
// API: verifyApproval(approval, {keys, expect, now, maxAgeMs}) returns
// {ok:true, statement} or {ok:false, reason}. It never throws on a bad
// approval or bad keys. A malformed `expect` or option is a bug in the caller
// and throws TypeError. expect = {journal, user, type, subject, item_num,
// action, reply_to, prompt_digest?, item_id?}: journal, user, type and
// subject are always required (subject may be {}). For type item_tap,
// item_num (integer), action (the button label) and reply_to are required
// too, so a tap can never verify without its item, its button and the
// question it answered being named: reply_to is the id of the follow-up
// comment whose buttons were tapped, or null for the item's own buttons (a
// follow-up's "Yes" must not pass for the item's). prompt_digest (lowercase
// hex, the digest of the question's words as the box asked them) and
// item_id (the item's id string) are optional and compared when given; a
// bridge should always pass prompt_digest for a tap, or a statement signed
// for the same item, button and reply_to verifies after the question's words
// changed (while its nonce is new to you and signed_at in the window). For
// consent and account all five must be absent. Any other key in expect (a
// misspelling, say) is a TypeError.
//
// CLI: approval-verify.mjs --keys FILE --expect JSON [--max-age-ms N] < approval.json
// (--expect is the same object as above, as JSON: a tap's must carry
// "reply_to", null or the follow-up comment's id; --max-age-ms is at least 1.)
// Exit 0 and the statement as JSON on stdout when valid; exit 1 and the reason
// on stderr when not; exit 2 and a usage line for bad arguments or an
// unreadable keys file. It never touches the network.

import crypto from 'node:crypto'
import fs from 'node:fs'

const TYPES = ['item_tap', 'consent', 'account']
const SUBJECT_MAX_KEYS = 12
const SUBJECT_MAX_LEN = 200
const COMMON = ['v', 'type', 'journal', 'user', 'key_id', 'nonce', 'signed_at', 'subject']
const TAP_ONLY = ['item', 'action', 'prompt_digest']
const TAP_EXPECT = ['item_num', 'action', 'reply_to', 'prompt_digest', 'item_id']
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000
const FUTURE_SKEW_MS = 60 * 1000

// RFC 8785 canonical JSON (same output as the journal's serialiser).
const NONCHARACTER = /[\uFDD0-\uFDEF\uFFFE\uFFFF]|[\uD83F\uD87F\uD8BF\uD8FF\uD93F\uD97F\uD9BF\uD9FF\uDA3F\uDA7F\uDABF\uDAFF\uDB3F\uDB7F\uDBBF\uDBFF][\uDFFE\uDFFF]/
const isIJsonString = (s) => s.isWellFormed() && !NONCHARACTER.test(s)
const notCanonical = () => { throw new Error('not_canonical') }

export function canonicalize(value) {
  return ser(value, 0)
}

function ser(v, depth) {
  if (depth > 128) notCanonical()
  if (v === null) return 'null'
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(v)) notCanonical()
      return JSON.stringify(v)
    case 'string':
      if (!isIJsonString(v)) notCanonical()
      return JSON.stringify(v)
    case 'object': {
      if (Array.isArray(v)) {
        const parts = []
        for (let i = 0; i < v.length; i++) parts.push(ser(v[i], depth + 1))
        return '[' + parts.join(',') + ']'
      }
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) notCanonical()
      return '{' + Object.keys(v).sort().map((k) => {
        if (!isIJsonString(k)) notCanonical()
        return JSON.stringify(k) + ':' + ser(v[k], depth + 1)
      }).join(',') + '}'
    }
    default: return notCanonical()
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string' && v.length > 0

function validSubject(s) {
  if (!isObj(s)) return false
  const entries = Object.entries(s)
  if (entries.length > SUBJECT_MAX_KEYS) return false
  return entries.every(([k, v]) => k.length <= SUBJECT_MAX_LEN && typeof v === 'string' && v.length <= SUBJECT_MAX_LEN)
}

// The statement object when `s` is the canonical string of a well-formed
// statement, otherwise null.
function parseStatement(s) {
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

// { key, id } for a base64url 65-byte uncompressed P-256 point on the curve,
// else null.
function loadPublicKey(publicKeyB64u) {
  try {
    if (typeof publicKeyB64u !== 'string') return null
    const raw = Buffer.from(publicKeyB64u, 'base64url')
    if (raw.length !== 65 || raw[0] !== 0x04) return null
    const key = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
      format: 'jwk',
    })
    return { key, id: crypto.createHash('sha256').update(raw).digest('hex') }
  } catch {
    return null
  }
}

// The usable key for `keyId` from the pinned file content, or null.
function pinnedKey(keys, keyId) {
  if (!isObj(keys) || !Array.isArray(keys.keys)) return null
  for (const entry of keys.keys) {
    if (!isObj(entry) || entry.key_id !== keyId) continue
    const k = loadPublicKey(entry.public_key)
    if (k && k.id === keyId) return k.key
  }
  return null
}

function checkExpect(e) {
  if (!isObj(e)) throw new TypeError('expect must be an object')
  if (!isStr(e.journal) || !isStr(e.user)) throw new TypeError('expect.journal and expect.user are required strings')
  if (!TYPES.includes(e.type)) throw new TypeError('expect.type must be item_tap, consent or account')
  if (!validSubject(e.subject)) throw new TypeError('expect.subject is required: a flat object of strings (may be empty)')
  const known = ['journal', 'user', 'type', 'subject', ...TAP_EXPECT]
  const unknown = Object.keys(e).find((k) => !known.includes(k))
  if (unknown !== undefined) throw new TypeError(`unknown expect key: ${unknown}`)
  if (e.type === 'item_tap') {
    if (!Number.isSafeInteger(e.item_num)) throw new TypeError('expect.item_num (integer) is required for item_tap')
    if (!isStr(e.action)) throw new TypeError('expect.action (non-empty string) is required for item_tap')
    if (!Object.hasOwn(e, 'reply_to') || (e.reply_to !== null && !isStr(e.reply_to))) {
      throw new TypeError('expect.reply_to (a comment id, or null for the item\'s own buttons) is required for item_tap')
    }
    if (e.prompt_digest !== undefined && !(typeof e.prompt_digest === 'string' && /^[0-9a-f]+$/.test(e.prompt_digest))) {
      throw new TypeError('expect.prompt_digest must be a lowercase hex string')
    }
    if (e.item_id !== undefined && !isStr(e.item_id)) throw new TypeError('expect.item_id must be a non-empty string')
  } else if (TAP_EXPECT.some((k) => Object.hasOwn(e, k))) {
    throw new TypeError(`expect.${TAP_EXPECT.join(', expect.')} are only for item_tap`)
  }
}

function sameSubject(a, b) {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => kb.includes(k) && a[k] === b[k])
}

export function verifyApproval(approval, opts) {
  if (!isObj(opts)) throw new TypeError('options must be an object')
  const { keys, expect } = opts
  checkExpect(expect)
  const now = opts.now === undefined ? Date.now() : opts.now
  const maxAgeMs = opts.maxAgeMs === undefined ? DEFAULT_MAX_AGE_MS : opts.maxAgeMs
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new TypeError('now must be a finite number')
  if (typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new TypeError('maxAgeMs must be a non-negative number')

  const fail = (reason) => ({ ok: false, reason })
  if (!isObj(approval) || typeof approval.statement !== 'string' || typeof approval.signature !== 'string') return fail('bad_statement')
  const st = parseStatement(approval.statement)
  if (!st) return fail('bad_statement')

  const key = pinnedKey(keys, st.key_id)
  if (!key) return fail('unknown_key')

  let valid = false
  try {
    valid = crypto.verify('sha256', Buffer.from(approval.statement, 'utf8'), key, Buffer.from(approval.signature, 'base64url'))
  } catch {
    valid = false
  }
  if (!valid) return fail('signature')

  if (st.journal !== expect.journal || st.user !== expect.user || st.type !== expect.type) return fail('mismatch')
  if (expect.type === 'item_tap') {
    if (st.item.num !== expect.item_num || st.action !== expect.action || st.item.reply_to !== expect.reply_to) return fail('mismatch')
    if (expect.prompt_digest !== undefined && st.prompt_digest !== expect.prompt_digest) return fail('mismatch')
    if (expect.item_id !== undefined && st.item.id !== expect.item_id) return fail('mismatch')
  }
  if (!sameSubject(st.subject, expect.subject)) return fail('mismatch')

  if (st.signed_at < now - maxAgeMs || st.signed_at > now + FUTURE_SKEW_MS) return fail('stale')
  return { ok: true, statement: st }
}

const USAGE = 'usage: approval-verify.mjs --keys FILE --expect JSON [--max-age-ms N] < approval.json\n'
  + '  --expect  {"journal","user","type","subject"}; for item_tap also "item_num", "action" and\n'
  + '            "reply_to" (null, or the follow-up comment id), optionally "prompt_digest" and "item_id"\n'
  + '  --max-age-ms  how old signed_at may be, at least 1 (default 300000)'

function main(argv) {
  const usage = (msg) => { process.stderr.write((msg ? msg + '\n' : '') + USAGE + '\n'); return 2 }
  let keysFile, expectJson, maxAgeMs
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = argv[i + 1]
    if (a === '--keys' && v !== undefined) { keysFile = v; i++ }
    else if (a === '--expect' && v !== undefined) { expectJson = v; i++ }
    else if (a === '--max-age-ms' && v !== undefined) {
      maxAgeMs = Number(v)
      if (!/^\d+$/.test(v) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) return usage('bad --max-age-ms')
      i++
    } else return usage(`bad argument: ${a}`)
  }
  if (keysFile === undefined || expectJson === undefined) return usage()
  let keys, expect
  try { keys = JSON.parse(fs.readFileSync(keysFile, 'utf8')) } catch { return usage('cannot read keys file') }
  try { expect = JSON.parse(expectJson); checkExpect(expect) } catch { return usage('bad --expect') }
  let approval
  try { approval = JSON.parse(fs.readFileSync(0, 'utf8')) } catch { approval = null }
  const r = verifyApproval(approval, { keys, expect, maxAgeMs })
  if (!r.ok) { process.stderr.write(r.reason + '\n'); return 1 }
  // The exact signed string, so key order is what was signed.
  process.stdout.write(approval.statement + '\n')
  return 0
}

function runDirectly() {
  try {
    return process.argv[1] !== undefined
      && fs.realpathSync(process.argv[1]) === fs.realpathSync(decodeURIComponent(new URL(import.meta.url).pathname))
  } catch {
    return false
  }
}

if (runDirectly()) process.exitCode = main(process.argv.slice(2))
