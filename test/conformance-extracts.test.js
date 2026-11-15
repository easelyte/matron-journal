// Decoder extracts (test/fixtures/conformance/payloads/): generated from the
// fixtures, byte-identical across generations, and checked against the committed set.
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateExtracts, readCommitted, missingFrames, resolveSample } from '../tools/conformance/extracts.js'
import { validatePayloadExtract } from '../tools/conformance/schema.js'

// A handful of fixtures with live tokens, device ids and timestamps. The full
// set takes about as long as the whole conformance suite, so the tests here
// replay a subset; `npm run conformance:check` regenerates and compares all of it.
const SUBSET = ['01_login.json', '09a_media_roundtrip.json', '13_tool_stream.json', '14_items_roundtrip.json']

test('extracts are byte-identical across two generations', async () => {
  const a = await generateExtracts(undefined, { only: SUBSET })
  const b = await generateExtracts(undefined, { only: SUBSET })
  assert.ok(a.size >= 8, `expected a real set of extracts, got ${a.size}`)
  assert.deepEqual([...a.keys()], [...b.keys()])
  for (const [name, text] of a) assert.equal(b.get(name), text, `${name} differs between generations`)
})

test('a fresh generation from a subset of the fixtures is held verbatim by the committed payloads/ (regenerate with: npm run conformance:extracts)', async () => {
  const fresh = await generateExtracts(undefined, { only: SUBSET })
  assert.deepEqual(missingFrames(fresh, readCommitted()), [])
})

test('every committed extract validates, is named after its type, and holds no variable nodes or live secrets', () => {
  const committed = readCommitted()
  assert.ok(committed.size > 10)
  for (const [name, text] of committed) {
    const doc = JSON.parse(text)
    assert.deepEqual(validatePayloadExtract(doc), [], name)
    assert.equal(name, `${doc.type}.json`)
    assert.ok(!/\$bind|\$ref|\$type|\$ignore/.test(text), `${name} still holds a variable node`)
  }
})

test('resolveSample keeps literals, samples variable nodes by name, and agrees across uses of one binding', () => {
  const t = { a: 'lit', id: { $bind: 'dev' }, again: { $ref: 'dev' }, ts: { $type: 'integer' }, nested: [{ $ignore: true }] }
  const actual = { a: 'lit', id: 41, again: 41, ts: 1794639539325, nested: ['x'] }
  const s = resolveSample(t, actual)
  assert.equal(s.a, 'lit')
  assert.equal(s.id, s.again)
  assert.notEqual(s.id, 41)
  assert.equal(s.ts, 1700000000000)
  assert.deepEqual(s.nested, ['sample-nested'])
})
