import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { keyIdOf, parseStatement, promptDigest, verifySignature } from '../src/approvals.js'
import { canonicalize } from '../src/federation-jcs.js'
import { consentSubject } from '../src/consent-subject.js'
import { generateApprovalKey, signForTest } from './approval-helpers.js'

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/approval-vectors.json', import.meta.url), 'utf8'))
const tap = fx.statements.item_tap

test('keyIdOf matches the fixture and rejects bad points', () => {
  assert.equal(keyIdOf(fx.public_key), fx.key_id)
  const raw = Buffer.from(fx.public_key, 'base64url')
  assert.throws(() => keyIdOf(raw.subarray(0, 64).toString('base64url')), /bad_public_key/)
  assert.throws(() => keyIdOf(raw.subarray(0, 33).toString('base64url')), /bad_public_key/)
  const off = Buffer.from(raw); off[64] ^= 1
  assert.throws(() => keyIdOf(off.toString('base64url')), /bad_public_key/)
  assert.throws(() => keyIdOf(42), /bad_public_key/)
})

test('parseStatement accepts the fixture statements', () => {
  for (const s of Object.values(fx.statements)) assert.deepEqual(parseStatement(s.statement), JSON.parse(s.statement))
})

test('parseStatement refuses non-canonical statements', () => {
  const obj = JSON.parse(tap.statement)
  const reversed = JSON.stringify(Object.fromEntries(Object.entries(obj).reverse()))
  assert.notEqual(reversed, tap.statement)
  for (const s of [tap.statement.replace('{"', '{ "'), reversed, tap.statement.replace(/"signed_at":(\d+)/, '"signed_at":$1.0')]) {
    assert.notEqual(s, tap.statement)
    assert.equal(parseStatement(s), null, s)
  }
  for (const s of ['not json', '', '[]', 'null']) assert.equal(parseStatement(s), null, s)
  for (const s of [undefined, null, 5, {}, []]) assert.equal(parseStatement(s), null)
})

test('parseStatement enforces each field rule on canonical strings', () => {
  const base = JSON.parse(tap.statement)
  const consent = JSON.parse(fx.statements.consent.statement)
  const account = JSON.parse(fx.statements.account.statement)
  const keys = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => ['k' + i, 'v']))
  const cases = {
    'v:2': { ...base, v: 2 },
    'type x': { ...base, type: 'x' },
    '13 subject keys': { ...base, subject: keys(13) },
    '201-char subject value': { ...base, subject: { a: 'x'.repeat(201) } },
    '201-char subject key': { ...base, subject: { ['k'.repeat(201)]: 'v' } },
    'nested subject value': { ...base, subject: { a: { b: 'c' } } },
    'non-string subject value': { ...base, subject: { a: 1 } },
    'subject not an object': { ...base, subject: [] },
    'unknown key': { ...base, extra: 1 },
    'missing action': (({ action, ...r }) => r)(base),
    'fractional signed_at': { ...base, signed_at: 1.5 },
    'string item.num': { ...base, item: { ...base.item, num: '7' } },
    'extra item key': { ...base, item: { ...base.item, x: 'y' } },
    'consent with action': { ...consent, action: 'x' },
    'consent with item': { ...consent, item: base.item },
    'empty nonce': { ...base, nonce: '' },
  }
  for (const [name, o] of Object.entries(cases)) {
    const s = canonicalize(o)
    assert.equal(canonicalize(JSON.parse(s)), s, name)
    assert.equal(parseStatement(s), null, name)
  }
  const ok = { ...base, subject: keys(12) }
  assert.deepEqual(parseStatement(canonicalize(ok)), ok)
  const lim = { ...base, subject: { ['k'.repeat(200)]: 'x'.repeat(200) } }
  assert.deepEqual(parseStatement(canonicalize(lim)), lim)
  const empty = { ...account, subject: {} }
  assert.deepEqual(parseStatement(canonicalize(empty)), empty)
})

test('verifySignature', () => {
  assert.equal(verifySignature(fx.public_key, tap.statement, tap.signature), true)
  assert.equal(verifySignature(fx.public_key, tap.statement.replace('Approve', 'Approvf'), tap.signature), false)
  const other = generateApprovalKey()
  const forged = signForTest(other.privateKeyPem, JSON.parse(tap.statement))
  assert.equal(forged.statement, tap.statement)
  assert.equal(verifySignature(fx.public_key, forged.statement, forged.signature), false)
  assert.equal(verifySignature(other.publicKey, forged.statement, forged.signature), true)
  assert.equal(verifySignature(fx.public_key, tap.statement, '!!!not base64!!!'), false)
  assert.equal(verifySignature('garbage', tap.statement, tap.signature), false)
  assert.equal(verifySignature(fx.public_key, tap.statement, ''), false)
})

test('promptDigest', () => {
  const { input, digest } = fx.prompt_digest_example
  assert.equal(promptDigest(input), digest)
  assert.notEqual(promptDigest({ body: input.body }), digest)
})

test('the vectors carry subjects the journal really builds', () => {
  const { kind, ask } = fx.consent_ask_example
  assert.deepEqual(JSON.parse(fx.statements.consent.statement).subject, consentSubject(kind, ask))
  assert.deepEqual(JSON.parse(fx.statements.account.statement).subject, { op: 'link_device', code: 'BCDF2345' })
  const reply = JSON.parse(fx.statements.item_tap_reply.statement)
  assert.equal(reply.item.reply_to, 'cm_def456')
  assert.equal(reply.prompt_digest, promptDigest(fx.reply_prompt_example.input))
  assert.equal(fx.reply_prompt_example.digest, promptDigest(fx.reply_prompt_example.input))
  for (const s of Object.values(fx.statements)) assert.equal(verifySignature(fx.public_key, s.statement, s.signature), true)
})

test('promptDigest refuses malformed input', () => {
  for (const bad of [{}, { body: 1 }, { title: 1, body: 'B' }, { title: null, body: 'B' }, null, undefined]) {
    assert.throws(() => promptDigest(bad), TypeError)
  }
  assert.doesNotThrow(() => promptDigest({ title: '', body: '' }))
})
