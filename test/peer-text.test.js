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
