import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizePeerText } from '../src/peer-text.js'

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

test('sanitizeConsentText strips format characters, bidi overrides included', async () => {
  const { sanitizeConsentText } = await import('../src/peer-text.js')
  assert.equal(sanitizeConsentText('a​b⁠c﻿d', 100), 'abcd')
  assert.equal(sanitizeConsentText('‮evil‬ ok ⁦x⁩', 100), 'evil ok x')
  assert.equal(sanitizeConsentText('​​', 100), '')
  assert.equal(sanitizeConsentText(null, 10), '')
})
test('sanitizeConsentText keeps ZWJ and ZWNJ so joined emoji survive', async () => {
  const { sanitizeConsentText } = await import('../src/peer-text.js')
  assert.equal(sanitizeConsentText('ping \u{1F469}‍\u{1F4BB}', 100), 'ping \u{1F469}‍\u{1F4BB}')
  assert.equal(sanitizeConsentText('a‌b', 100), 'a‌b')
})
test('sanitizePeerText itself is unchanged for format characters', () => {
  assert.equal(sanitizePeerText('a​b', 100), 'a​b')
})
