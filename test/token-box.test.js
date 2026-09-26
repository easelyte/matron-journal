import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTokenBox, PLAIN_BOX, isSealed, tokenHash } from '../src/token-box.js'

const KEY = 'ab'.repeat(32)

test('token box: seal/open round-trips, output is prefixed and never repeats, tamper and wrong key throw', () => {
  const box = makeTokenBox(KEY)
  assert.equal(box.enabled, true)
  const a = box.seal('gho_secret'); const b = box.seal('gho_secret')
  assert.ok(isSealed(a) && isSealed(b)); assert.notEqual(a, b, 'a fresh IV every time')
  assert.ok(!a.includes('gho_secret'))
  assert.equal(box.open(a), 'gho_secret'); assert.equal(box.open(b), 'gho_secret')
  assert.equal(box.open('plain-legacy'), 'plain-legacy', 'pre-key rows read through')
  assert.throws(() => box.open(a.slice(0, -2) + 'AA'), /token_unreadable/)
  assert.throws(() => makeTokenBox('cd'.repeat(32)).open(a), /token_unreadable/)
})

test('token box: without a key it is a pass-through that refuses sealed values; bad keys are rejected; hash is stable', () => {
  assert.equal(PLAIN_BOX.enabled, false)
  assert.equal(PLAIN_BOX.seal('x'), 'x'); assert.equal(PLAIN_BOX.open('x'), 'x')
  assert.throws(() => PLAIN_BOX.open(makeTokenBox(KEY).seal('x')), /token_sealed/)
  assert.equal(makeTokenBox('').enabled, false); assert.equal(makeTokenBox(undefined).enabled, false)
  assert.throws(() => makeTokenBox('short'), /MATRON_TOKEN_KEY/)
  assert.throws(() => makeTokenBox('zz'.repeat(32)), /MATRON_TOKEN_KEY/)
  assert.equal(tokenHash('x'), tokenHash('x')); assert.notEqual(tokenHash('x'), tokenHash('y')); assert.match(tokenHash('x'), /^[0-9a-f]{64}$/)
})
