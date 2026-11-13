import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sealBox, openBox, boxPlaintext, parsePushKey, isBoxShaped,
  BOX_MAX_CHARS, BOX_MAX_PLAIN_BYTES, BOX_PAD_BYTES,
} from '../src/push-box.js'
import { RECIPIENT, EPHEMERAL, keyPairFrom } from './push-box-fixture.js'

const CONTENT = {
  title: 'Ship the release notes?', subtitle: 'Question · Docs',
  body: 'Two options: ship now, or wait for the screenshots.',
  convoId: 'c-1', seq: 42, kind: 'attention',
  item: { id: 'it_1', num: 12, kind: 'question', actions: ['Ship', 'Wait'] },
}

// The same vector is pinned in the Apple app's tests, where CryptoKit's HPKE
// opens it: the two implementations agree byte for byte.
const VECTOR = 'pSB6orUR--of_qx2eAlOOaZ21Ut5_WVkw9NJ3JPhGE2q0JsD_VvSzNA6StCz9rGrWiKgFQF6uyobsVS05yZ6fYhuxU9XxTlI-PJHA6_XgxRA73hDFGeTlN-WqmuK43qJY9VfUyyoxcvJ_S7RfIJCgceCpmIO8xnQm6Apt1RuYKCcJ6vw2wWsW0dnXV2HKDHDaHZ7IJR1EzzhGaQcXftdYY1C45aLoh3_6ZVCGDz_zbXiKy96b10UIsTZcpqMBw5Ap_eBZuf2GZCaBUlDxxeJf1EI3Z17WXX8jUzMQznoVy2Etxh8oobnhG7D61pEqmStSIbp3AJJk6hvmOi2JViIWhWg59oIgWpDEisthHRrZk1XZfR14wD7EDRL2roWOHpN5Aiz0BPT91zJyX7NzyKFLA'
const VECTOR_CONTENT = { ...CONTENT, subtitle: 'Docs' }

test('HPKE vector: a fixed ephemeral key gives the pinned box', () => {
  assert.equal(RECIPIENT.key, 'uLHqgzncBWWOwTpUixAlfi0qAZ_p0tSU6vRJv7LCvi4')
  assert.equal(sealBox(RECIPIENT.key, boxPlaintext(VECTOR_CONTENT), { ephemeral: EPHEMERAL }), VECTOR)
  assert.deepEqual(JSON.parse(openBox(RECIPIENT, VECTOR)), {
    v: 1, title: 'Ship the release notes?', subtitle: 'Docs',
    body: 'Two options: ship now, or wait for the screenshots.',
    convo_id: 'c-1', seq: 42, kind: 'attention',
    item: { id: 'it_1', num: 12, kind: 'question', actions: ['Ship', 'Wait'] },
  })
})

test('a box opens only with its recipient key, differs every time, and does not open if altered', () => {
  const plain = boxPlaintext(CONTENT)
  const a = sealBox(RECIPIENT.key, plain)
  const b = sealBox(RECIPIENT.key, plain)
  assert.notEqual(a, b)
  assert.ok(openBox(RECIPIENT, a).equals(plain))
  assert.ok(!Buffer.from(a, 'base64url').includes(Buffer.from('release notes')))
  assert.throws(() => openBox(keyPairFrom('someone else'), a))
  const raw = Buffer.from(a, 'base64url')
  raw[40] ^= 1
  assert.throws(() => openBox(RECIPIENT, raw.toString('base64url')))
})

test('plaintext is padded to a fixed step, so length says little about the text', () => {
  const short = boxPlaintext({ ...CONTENT, body: 'ok' })
  const longer = boxPlaintext({ ...CONTENT, body: 'a rather longer body than ok' })
  assert.equal(short.length, BOX_PAD_BYTES)
  assert.equal(longer.length, short.length)
  assert.equal(sealBox(RECIPIENT.key, short).length, sealBox(RECIPIENT.key, longer).length)
  assert.doesNotThrow(() => JSON.parse(short))
})

test('long text is cut to fit: one line, whole characters, never over the cap', () => {
  const p = JSON.parse(boxPlaintext({ ...CONTENT, title: 'T'.repeat(500), subtitle: 'S'.repeat(500), body: 'line one\n\n  line two ' + 'b'.repeat(900) }))
  assert.equal(Array.from(p.title).length, 120)
  assert.equal(Array.from(p.subtitle).length, 80)
  assert.equal(Array.from(p.body).length, 240)
  assert.ok(p.body.startsWith('line one line two b'))
  assert.ok(p.body.endsWith('…'))
  // Four-byte characters, and buttons at their longest: still under the cap.
  const wide = boxPlaintext({
    ...CONTENT, title: '😀'.repeat(200), subtitle: '😀'.repeat(200), body: '😀'.repeat(500),
    item: { id: 'it_' + 'x'.repeat(40), num: 123456, kind: 'question', actions: Array(4).fill('😀'.repeat(40)), reply_to: 'ic_' + 'y'.repeat(40) },
  })
  assert.ok(wide.length <= BOX_MAX_PLAIN_BYTES)
  const parsed = JSON.parse(wide)
  assert.equal(parsed.item.actions.length, 4)
  assert.ok(!/[\uD800-\uDBFF]$/.test(parsed.body), 'no split surrogate pair')
  assert.ok(sealBox(RECIPIENT.key, wide).length <= BOX_MAX_CHARS)
})

test('content that cannot fit even with no body is refused, not sent broken', () => {
  assert.equal(boxPlaintext({ ...CONTENT, item: { id: 'x'.repeat(3000), num: 1, kind: 'question', actions: [] } }), null)
})

test('parsePushKey: 32 raw bytes as unpadded base64url, nothing else', () => {
  assert.equal(parsePushKey(RECIPIENT.key), RECIPIENT.key)
  for (const bad of [null, undefined, 42, '', 'abc', RECIPIENT.key + '=', RECIPIENT.key.slice(1), RECIPIENT.key + 'AA', RECIPIENT.publicKey.toString('base64').replace(/=+$/, '').replace(/[-_]/g, '+').slice(0, 42) + '+']) {
    assert.equal(parsePushKey(bad), null, String(bad))
  }
})

test('isBoxShaped: base64url within the length bounds', () => {
  assert.ok(isBoxShaped(VECTOR))
  assert.ok(!isBoxShaped('x'.repeat(63)))
  assert.ok(!isBoxShaped('x'.repeat(BOX_MAX_CHARS + 1)))
  assert.ok(!isBoxShaped(VECTOR + '='))
  assert.ok(!isBoxShaped(undefined))
})
