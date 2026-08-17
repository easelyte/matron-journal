import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizePeerText, PEER_BODY_CAP, PEER_NAME_CAP } from '../src/peer-text.js'

test('flattens control characters and newlines to single spaces', () => {
  assert.equal(sanitizePeerText('a\nb\r\nc\td\x00e', 100), 'a b c d e')
})
test('collapses runs, trims, caps', () => {
  assert.equal(sanitizePeerText('  a \n\n  b  ', 100), 'a b')
  assert.equal(sanitizePeerText('x'.repeat(10), 4), 'xxxx')
})
test('non-strings coerce, nullish becomes empty', () => {
  assert.equal(sanitizePeerText(null, 10), '')
  assert.equal(sanitizePeerText(undefined, 10), '')
  assert.equal(sanitizePeerText(42, 10), '42')
})

// T-2.1: PEER_BODY_CAP exported + default; body/name cap boundaries.
test('exports PEER_BODY_CAP=2000 and PEER_NAME_CAP=80', () => {
  assert.equal(PEER_BODY_CAP, 2000)
  assert.equal(PEER_NAME_CAP, 80)
})
test('default max is PEER_BODY_CAP; over-cap truncates, name cap independent', () => {
  assert.equal(sanitizePeerText('z'.repeat(3000)).length, PEER_BODY_CAP) // default cap
  assert.equal(sanitizePeerText('z'.repeat(3000), PEER_BODY_CAP).length, 2000)
  assert.equal(sanitizePeerText('n'.repeat(200), PEER_NAME_CAP).length, 80)
})

// T-2.1: adversarial injection — zero-width + bidi (Unicode Cf), not just Cc.
// A body must never forge a second chat line or hide/reorder text.
test('flattens zero-width and bidi-override injection (Unicode Cf)', () => {
  // zero-width space / non-joiner / joiner / BOM between letters
  assert.equal(sanitizePeerText('a​b‌c‍d﻿e', 100), 'a b c d e')
  // bidi overrides (Trojan-Source class): RLO/PDF must not survive
  assert.equal(sanitizePeerText('safe‮live‬end', 100), 'safe live end')
  // combined CR/LF/control + zero-width collapses with no residual Cc/Cf char
  const out = sanitizePeerText('x\r\n​y ‮z', 100)
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(out), `residual control/format char in ${JSON.stringify(out)}`)
})
