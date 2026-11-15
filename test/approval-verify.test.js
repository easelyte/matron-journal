import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyApproval, canonicalize as toolCanonicalize } from '../tools/approval-verify.mjs'
import { canonicalize } from '../src/federation-jcs.js'
import { generateApprovalKey, signForTest } from './approval-helpers.js'

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/approval-vectors.json', import.meta.url), 'utf8'))
// A file path for fs and the CLI (a URL's pathname keeps %-escapes, so a
// checkout under a path with a space would not be found), the URL to import.
const TOOL_URL = new URL('../tools/approval-verify.mjs', import.meta.url)
const TOOL = fileURLToPath(TOOL_URL)
const keys = { keys: [{ key_id: fx.key_id, public_key: fx.public_key, name: 'phone' }] }
const T0 = 1790000000000
const base = { journal: 'journal.example', user: 'alice' }
const SPAWN = JSON.parse(fx.statements.consent.statement).subject
const EXPECT = {
  item_tap: { ...base, type: 'item_tap', item_num: 7, action: 'Approve', reply_to: null, subject: { box: 'box-a' } },
  item_tap_reply: { ...base, type: 'item_tap', item_num: 7, action: 'Yes', reply_to: 'cm_def456', subject: { box: 'box-a' } },
  consent: { ...base, type: 'consent', subject: SPAWN },
  account: { ...base, type: 'account', subject: { op: 'link_device', code: 'BCDF2345' } },
}
const ok = (approval, expect, extra = {}) => verifyApproval(approval, { keys, expect, now: T0 + 1000, ...extra })

for (const type of ['item_tap', 'item_tap_reply', 'consent', 'account']) {
  test(`vector ${type} verifies`, () => {
    const r = ok(fx.statements[type], EXPECT[type])
    assert.equal(r.ok, true)
    assert.deepEqual(r.statement, JSON.parse(fx.statements[type].statement))
  })
}

test('a key missing from the pinned file is unknown_key though the signature is valid', () => {
  const r = verifyApproval(fx.statements.consent, { keys: { keys: [] }, expect: EXPECT.consent, now: T0 })
  assert.deepEqual(r, { ok: false, reason: 'unknown_key' })
})

test('a pinned entry whose public_key does not hash to its key_id is never used', () => {
  const other = generateApprovalKey()
  const bad = { keys: [{ key_id: fx.key_id, public_key: other.publicKey, name: 'x' }] }
  assert.equal(verifyApproval(fx.statements.consent, { keys: bad, expect: EXPECT.consent, now: T0 }).reason, 'unknown_key')
})

test('malformed keys file is unknown_key, never a throw', () => {
  for (const k of [null, 5, {}, { keys: 'x' }, { keys: [null, 3, { key_id: fx.key_id }] }]) {
    assert.equal(verifyApproval(fx.statements.consent, { keys: k, expect: EXPECT.consent, now: T0 }).reason, 'unknown_key')
  }
})

test('stale and future signed_at', () => {
  assert.equal(ok(fx.statements.consent, EXPECT.consent, { now: T0 + 5 * 60 * 1000 + 1 }).reason, 'stale')
  assert.equal(ok(fx.statements.consent, EXPECT.consent, { now: T0 + 5 * 60 * 1000 }).ok, true)
  assert.equal(ok(fx.statements.consent, EXPECT.consent, { now: T0 + 1000, maxAgeMs: 500 }).reason, 'stale')
  assert.equal(ok(fx.statements.consent, EXPECT.consent, { now: T0 - 60000 }).ok, true)
  assert.equal(ok(fx.statements.consent, EXPECT.consent, { now: T0 - 60001 }).reason, 'stale')
})

test('subject mismatch, extra subject key and missing subject key', () => {
  const { decision, ...missing } = SPAWN
  assert.ok(decision)
  assert.equal(ok(fx.statements.consent, { ...EXPECT.consent, subject: { ...SPAWN, ask: 'sp_2' } }).reason, 'mismatch')
  assert.equal(ok(fx.statements.consent, { ...EXPECT.consent, subject: missing }).reason, 'mismatch')
  assert.equal(ok(fx.statements.consent, { ...EXPECT.consent, subject: { ...SPAWN, x: 'y' } }).reason, 'mismatch')
  assert.equal(ok(fx.statements.consent, { ...EXPECT.consent, subject: {} }).reason, 'mismatch')
})

test('a tap is bound to the question it answered: reply_to is required, prompt_digest and item_id are checked when given', () => {
  const reply = fx.statements.item_tap_reply
  const st = JSON.parse(reply.statement)
  // The follow-up's tap never verifies as the item's own button, nor the reverse.
  assert.equal(ok(reply, { ...EXPECT.item_tap_reply, reply_to: null }).reason, 'mismatch')
  assert.equal(ok(reply, { ...EXPECT.item_tap_reply, reply_to: 'cm_other' }).reason, 'mismatch')
  assert.equal(ok(fx.statements.item_tap, { ...EXPECT.item_tap, reply_to: 'cm_def456' }).reason, 'mismatch')
  assert.equal(ok(reply, { ...EXPECT.item_tap_reply, prompt_digest: fx.reply_prompt_example.digest }).ok, true)
  assert.equal(st.prompt_digest, fx.reply_prompt_example.digest)
  assert.equal(ok(reply, { ...EXPECT.item_tap_reply, prompt_digest: fx.prompt_digest_example.digest }).reason, 'mismatch')
  assert.equal(ok(reply, { ...EXPECT.item_tap_reply, item_id: 'it_abc123' }).ok, true)
  assert.equal(ok(reply, { ...EXPECT.item_tap_reply, item_id: 'it_other' }).reason, 'mismatch')
  const { reply_to, ...noReply } = EXPECT.item_tap_reply
  assert.ok(reply_to)
  assert.throws(() => ok(reply, noReply), /reply_to/)
  for (const bad of [{ reply_to: 5 }, { reply_to: '' }, { reply_to: undefined }, { prompt_digest: 'XYZ' }, { prompt_digest: '' }, { prompt_digest: 5 },
    { item_id: '' }, { item_id: 7 }]) {
    assert.throws(() => ok(reply, { ...EXPECT.item_tap_reply, ...bad }), TypeError, JSON.stringify(bad))
  }
  for (const k of [{ reply_to: null }, { prompt_digest: fx.reply_prompt_example.digest }, { item_id: 'it_abc123' }]) {
    assert.throws(() => ok(fx.statements.consent, { ...EXPECT.consent, ...k }), TypeError, JSON.stringify(k))
    assert.throws(() => ok(fx.statements.account, { ...EXPECT.account, ...k }), TypeError, JSON.stringify(k))
  }
})

test('journal, user, type, item_num and action mismatches', () => {
  assert.equal(ok(fx.statements.item_tap, { ...EXPECT.item_tap, journal: 'other.example' }).reason, 'mismatch')
  assert.equal(ok(fx.statements.item_tap, { ...EXPECT.item_tap, user: 'bob' }).reason, 'mismatch')
  assert.equal(ok(fx.statements.item_tap, { ...EXPECT.consent, subject: { box: 'box-a' } }).reason, 'mismatch')
  assert.equal(ok(fx.statements.item_tap, { ...EXPECT.item_tap, item_num: 8 }).reason, 'mismatch')
  assert.equal(ok(fx.statements.item_tap, { ...EXPECT.item_tap, action: 'Deny' }).reason, 'mismatch')
  const { item_num, action, ...loose } = EXPECT.item_tap
  assert.throws(() => ok(fx.statements.item_tap, loose), TypeError)
  assert.throws(() => ok(fx.statements.item_tap, { ...loose, item_num }), TypeError)
  assert.throws(() => ok(fx.statements.item_tap, { ...loose, action }), TypeError)
})

test('a bad signature is signature', () => {
  const a = { ...fx.statements.consent, signature: fx.statements.account.signature }
  assert.equal(ok(a, EXPECT.consent).reason, 'signature')
  assert.equal(ok({ ...fx.statements.consent, signature: '!!' }, EXPECT.consent).reason, 'signature')
})

test('signature is checked before mismatch, mismatch before stale', () => {
  const a = { ...fx.statements.consent, signature: fx.statements.account.signature }
  assert.equal(ok(a, { ...EXPECT.consent, user: 'bob' }).reason, 'signature')
  assert.equal(ok(fx.statements.consent, { ...EXPECT.consent, user: 'bob' }, { now: T0 + 1e9 }).reason, 'mismatch')
})

test('bad_statement cases never throw', () => {
  const s = JSON.parse(fx.statements.consent.statement)
  const sig = fx.statements.consent.signature
  const k = generateApprovalKey()
  const pinned = { keys: [{ key_id: k.keyId, public_key: k.publicKey, name: 'k' }] }
  const sign = (o) => signForTest(k.privateKeyPem, { ...s, key_id: k.keyId, ...o })
  const run = (a) => verifyApproval(a, { keys: pinned, expect: EXPECT.consent, now: T0 })
  assert.equal(run(sign({})).ok, true) // the well-formed baseline passes
  for (const a of [null, undefined, 5, 'x', [], {}, { statement: 5, signature: sig }, { statement: '{', signature: sig },
    { statement: fx.statements.consent.statement }, { statement: ' ' + fx.statements.consent.statement, signature: sig },
    { statement: JSON.stringify(s, null, 1), signature: sig },
    sign({ v: 2 }), sign({ type: 'bogus' }), sign({ extra: 1 }), sign({ item: { id: 'a', num: 1, reply_to: null } }),
    sign({ action: 'Approve' }), sign({ nonce: '' }), sign({ signed_at: 1.5 }), sign({ subject: { a: 1 } }),
    sign({ subject: { a: 'x'.repeat(201) } }), sign({ subject: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, 'v'])) }),
    sign({ subject: [] }), sign({ journal: 5 })]) {
    assert.equal(run(a).reason, 'bad_statement', JSON.stringify(a)?.slice(0, 80))
  }
  // item_tap shape rules
  const tap = JSON.parse(fx.statements.item_tap.statement)
  const tsign = (o) => signForTest(k.privateKeyPem, { ...tap, key_id: k.keyId, ...o })
  const trun = (a) => verifyApproval(a, { keys: pinned, expect: EXPECT.item_tap, now: T0 })
  for (const o of [{ item: undefined }, { item: { id: 'a', num: 1 } }, { item: { id: 'a', num: 1.5, reply_to: null } },
    { item: { id: 'a', num: 1, reply_to: 5 } }, { action: '' }, { prompt_digest: 5 }]) {
    const obj = { ...tap, key_id: k.keyId, ...o }
    for (const key of Object.keys(obj)) if (obj[key] === undefined) delete obj[key]
    assert.equal(trun(signForTest(k.privateKeyPem, obj)).reason, 'bad_statement', JSON.stringify(o))
  }
  assert.equal(trun(tsign({})).ok, true) // the well-formed tap baseline passes
})

test('a signed Deny tap and a misspelt key never verify as an approval', () => {
  const k = generateApprovalKey()
  const pinned = { keys: [{ key_id: k.keyId, public_key: k.publicKey, name: 'k' }] }
  const tap = JSON.parse(fx.statements.item_tap.statement)
  const deny = signForTest(k.privateKeyPem, { ...tap, key_id: k.keyId, action: 'Deny', item: { id: 'it_x', num: 999, reply_to: null } })
  const { item_num, action, ...loose } = EXPECT.item_tap
  assert.throws(() => verifyApproval(deny, { keys: pinned, expect: loose, now: T0 }), TypeError)
  assert.throws(() => verifyApproval(deny, { keys: pinned, expect: { ...loose, itemNum: 7, action }, now: T0 }), TypeError)
  assert.equal(verifyApproval(deny, { keys: pinned, expect: EXPECT.item_tap, now: T0 }).reason, 'mismatch')
  assert.equal(verifyApproval(deny, { keys: pinned, expect: { ...EXPECT.item_tap, item_num: 999 }, now: T0 }).reason, 'mismatch')
  assert.equal(verifyApproval(deny, { keys: pinned, expect: { ...EXPECT.item_tap, item_num: 999, action: 'Deny' }, now: T0 }).ok, true)
})

test('a malformed expect is a TypeError', () => {
  assert.throws(() => ok(fx.statements.consent, { ...EXPECT.consent, item_num: 7 }), TypeError)
  assert.throws(() => ok(fx.statements.consent, { ...EXPECT.consent, action: 'Approve' }), TypeError)
  assert.throws(() => ok(fx.statements.consent, { ...EXPECT.consent, extra: 1 }), TypeError)
  for (const e of [null, 5, {}, { ...EXPECT.consent, subject: undefined }, { ...EXPECT.consent, journal: '' },
    { ...EXPECT.consent, subject: { a: 1 } }, { ...EXPECT.item_tap, item_num: '7' }, { ...EXPECT.item_tap, action: 3 }]) {
    assert.throws(() => verifyApproval(fx.statements.consent, { keys, expect: e, now: T0 }), TypeError)
  }
  assert.throws(() => verifyApproval(fx.statements.consent, undefined), TypeError)
})

test('a fresh key and statement verify with default now', () => {
  const k = generateApprovalKey()
  const a = signForTest(k.privateKeyPem, { v: 1, type: 'account', journal: 'journal.example', user: 'alice', key_id: k.keyId, nonce: 'n1', signed_at: Date.now(), subject: {} })
  const r = verifyApproval(a, { keys: { keys: [{ key_id: k.keyId, public_key: k.publicKey, name: 'k' }] }, expect: { ...base, type: 'account', subject: {} } })
  assert.equal(r.ok, true)
})

test('the tool JCS output equals src canonicalize', () => {
  const samples = [
    ...Object.values(fx.statements).map((s) => JSON.parse(s.statement)),
    { s: 'héllo wörld ✓ 日本語 😀 \u0007 "q" \\ / \n', n: [1e21, 1e-7, 0, -0.5, 123456789012, 1.5e300], b: [true, false, null], z: { b: 1, a: [], 'é': 2, '😀': 3, '～': 4 } },
    { 'ǆ': 1, A: 2, a: 3, '': 4 },
    'plain', 7, null, [],
  ]
  for (const v of samples) assert.equal(toolCanonicalize(v), canonicalize(v))
  assert.equal(toolCanonicalize({ n: 1e21 }), '{"n":1e+21}')
})

test('the tool JCS refuses what src refuses', () => {
  for (const v of [undefined, NaN, Infinity, 1n, () => 1, '\ud800', '￿', new Date(0)]) {
    assert.throws(() => toolCanonicalize(v), /not_canonical/)
  }
})

test('the module imports only node:crypto and node:fs', () => {
  const src = fs.readFileSync(TOOL, 'utf8')
  const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  assert.deepEqual(specs.sort(), ['node:crypto', 'node:fs'])
  assert.doesNotMatch(src, /\bimport\s*\(|\brequire\s*\(/)
})

// CLI
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-verify-'))
const keysFile = path.join(dir, 'keys.json')
fs.writeFileSync(keysFile, JSON.stringify(keys))
const cli = (args, input) => spawnSync(process.execPath, [TOOL, ...args], { input, encoding: 'utf8' })

test('CLI: valid approval exits 0 and prints the statement', () => {
  const r = cli(['--keys', keysFile, '--expect', JSON.stringify(EXPECT.consent), '--max-age-ms', '99999999999999'], JSON.stringify(fx.statements.consent))
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), JSON.parse(fx.statements.consent.statement))
})

test('CLI: prints the exact signed statement string', () => {
  const k = generateApprovalKey()
  const kf = path.join(dir, 'k2.json'); fs.writeFileSync(kf, JSON.stringify({ keys: [{ key_id: k.keyId, public_key: k.publicKey, name: 'k' }] }))
  const subject = { 10: 'a', 9: 'b' }
  const a = signForTest(k.privateKeyPem, { v: 1, type: 'account', journal: 'journal.example', user: 'alice', key_id: k.keyId, nonce: 'n', signed_at: Date.now(), subject })
  const r = cli(['--keys', kf, '--expect', JSON.stringify({ ...base, type: 'account', subject })], JSON.stringify(a))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, a.statement + '\n')
})

test('CLI: a follow-up tap verifies only with its reply_to in --expect', () => {
  const inp = JSON.stringify(fx.statements.item_tap_reply)
  const good = cli(['--keys', keysFile, '--expect', JSON.stringify(EXPECT.item_tap_reply), '--max-age-ms', '99999999999999'], inp)
  assert.equal(good.status, 0, good.stderr)
  const item = cli(['--keys', keysFile, '--expect', JSON.stringify({ ...EXPECT.item_tap_reply, reply_to: null }), '--max-age-ms', '99999999999999'], inp)
  assert.equal(item.status, 1); assert.equal(item.stderr.trim(), 'mismatch')
  const { reply_to, ...noReply } = EXPECT.item_tap_reply
  assert.ok(reply_to)
  assert.equal(cli(['--keys', keysFile, '--expect', JSON.stringify(noReply)], inp).status, 2)
})

test('CLI: refusals exit 1 with the reason on stderr', () => {
  assert.ok(Date.now() > T0 + 5 * 60 * 1000, 'the fixture must be older than the default window')
  const stale = cli(['--keys', keysFile, '--expect', JSON.stringify(EXPECT.consent)], JSON.stringify(fx.statements.consent))
  assert.equal(stale.status, 1); assert.equal(stale.stderr.trim(), 'stale'); assert.equal(stale.stdout, '')
  const mm = cli(['--keys', keysFile, '--expect', JSON.stringify({ ...EXPECT.consent, user: 'bob' }), '--max-age-ms', '99999999999999'], JSON.stringify(fx.statements.consent))
  assert.equal(mm.status, 1); assert.equal(mm.stderr.trim(), 'mismatch')
  const bad = cli(['--keys', keysFile, '--expect', JSON.stringify(EXPECT.consent)], 'not json')
  assert.equal(bad.status, 1); assert.equal(bad.stderr.trim(), 'bad_statement')
})

test('CLI: bad arguments exit 2 with usage', () => {
  const inp = JSON.stringify(fx.statements.consent)
  for (const args of [[], ['--keys', keysFile], ['--expect', '{}'], ['--keys', keysFile, '--expect', 'nope'],
    ['--keys', path.join(dir, 'missing.json'), '--expect', JSON.stringify(EXPECT.consent)],
    ['--keys', keysFile, '--expect', JSON.stringify(EXPECT.consent), '--max-age-ms', 'x'],
    ['--keys', keysFile, '--expect', JSON.stringify(EXPECT.consent), '--bogus'],
    ['--keys', keysFile, '--expect', JSON.stringify(EXPECT.consent), '--max-age-ms', '9'.repeat(300)],
    ['--keys', keysFile, '--expect', JSON.stringify(EXPECT.consent), '--max-age-ms', '0'],
    ['--keys', keysFile, '--expect', '{}']]) {
    const r = cli(args, inp)
    assert.equal(r.status, 2, args.join(' ') + r.stderr)
    assert.match(r.stderr, /usage/i)
  }
  const notJson = path.join(dir, 'bad.json'); fs.writeFileSync(notJson, 'zzz')
  assert.equal(cli(['--keys', notJson, '--expect', JSON.stringify(EXPECT.consent)], inp).status, 2)
})

test('importing the module does not run the CLI', () => {
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(TOOL_URL.href)}).then(() => console.log('imported'))`], { encoding: 'utf8', input: '' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /imported/)
})
