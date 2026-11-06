import test from 'node:test'
import assert from 'node:assert/strict'
import { sign as rawSign } from 'node:crypto'
import { canonicalize } from '../src/federation-jcs.js'
import { parseStrict, MAX_DEPTH } from '../src/federation-json.js'
import {
  SIGNING_PREFIX, MAX_ENVELOPE_BYTES, FRESHNESS_MS,
  generateFederationKey, exportPublicKey, importPublicKey, keyFingerprint, formatFingerprint,
  newOpId, isOpId, isAddress, signingBytes, signEnvelope, parseEnvelope, verifyEnvelope, opHash,
} from '../src/federation-envelope.js'

const malformed = { message: 'malformed' }

// --- JCS (RFC 8785) ---------------------------------------------------------

test('jcs: RFC 8785 section 3.2.2 sample', () => {
  const input = JSON.parse('{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
    '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}')
  assert.equal(canonicalize(input),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
    '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}')
})

test('jcs: RFC 8785 section 3.2.3 key order is by UTF-16 code units', () => {
  const input = JSON.parse('{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh",' +
    '"1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}')
  // Compare strings: Object.keys would list the integer-like "1" first whatever the order.
  const order = ['\r', '1', '\u0080', '\u00f6', '\u20ac', '\ud83d\ude00', '\ufb33']
  assert.equal(canonicalize(input), '{' + order.map((k) => JSON.stringify(k) + ':' + JSON.stringify(input[k])).join(',') + '}')
})

test('jcs: numbers use the ECMAScript form (RFC 8785 appendix B)', () => {
  const cases = [
    [0, '0'], [-0, '0'], [5e-324, '5e-324'], [-5e-324, '-5e-324'],
    [1.7976931348623157e308, '1.7976931348623157e+308'], [9007199254740992, '9007199254740992'],
    [1e21, '1e+21'], [1e20, '100000000000000000000'], [0.000001, '0.000001'], [1e-7, '1e-7'],
  ]
  for (const [n, want] of cases) assert.equal(canonicalize(n), want, String(n))
})

test('jcs: nested objects sort at every depth; arrays keep order; whitespace never matters', () => {
  assert.equal(canonicalize({ b: [3, { z: 1, a: 2 }], a: 'x' }), '{"a":"x","b":[3,{"a":2,"z":1}]}')
  assert.equal(canonicalize(JSON.parse(' { "b" : 1 ,\n "a":2 } ')), canonicalize({ a: 2, b: 1 }))
})

test('jcs: refuses what JSON.stringify would quietly change', () => {
  for (const bad of [undefined, () => 1, Symbol('x'), 1n, NaN, Infinity, { a: undefined }, [undefined],
    '\ud800', { '\udc00': 1 }, new Date(0), new Map()]) {
    assert.throws(() => canonicalize(bad), { message: 'not_canonical' })
  }
})

test('jcs: a "__proto__" key from the strict parser is an ordinary key', () => {
  assert.equal(canonicalize(parseStrict('{"__proto__":1,"a":2}')), '{"__proto__":1,"a":2}')
})

// --- Strict I-JSON parser ---------------------------------------------------

test('strict parser: agrees with JSON.parse on valid input', () => {
  for (const s of ['{}', '[]', '0', '-0', '1.5e3', '"a\\u00e9\\n"', 'true', 'null',
    '{"a":[1,{"b":null}],"c":"\\ud83d\\ude00"}', ' \t\r\n[ 1 , 2 ] ']) {
    assert.deepEqual(parseStrict(s), JSON.parse(s), s)
    assert.deepEqual(parseStrict(Buffer.from(s)), JSON.parse(s), s)
  }
})

test('strict parser: refuses duplicate keys at any depth', () => {
  assert.throws(() => parseStrict('{"a":1,"a":2}'), malformed)
  assert.throws(() => parseStrict('{"x":[{"a":1,"b":2,"a":3}]}'), malformed)
  assert.throws(() => parseStrict('{"a":1,"\\u0061":2}'), malformed)
  assert.deepEqual(parseStrict('{"a":{"a":1}}'), { a: { a: 1 } })
})

test('strict parser: refuses lone surrogates, raw or escaped', () => {
  assert.throws(() => parseStrict('"\\ud800"'), malformed)
  assert.throws(() => parseStrict('"\\udc00x"'), malformed)
  assert.throws(() => parseStrict('{"\\ud800":1}'), malformed)
  assert.throws(() => parseStrict('"\ud800"'), malformed)
  assert.equal(parseStrict('"\\ud83d\\ude00"'), '😀')
})

test('strict parser: refuses invalid UTF-8 and a byte-order mark', () => {
  assert.throws(() => parseStrict(Buffer.from([0x22, 0xc3, 0x28, 0x22])), malformed)
  assert.throws(() => parseStrict(Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22])), malformed)
  assert.throws(() => parseStrict(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), malformed)
})

test('strict parser: refuses integers it cannot hold exactly and non-finite numbers', () => {
  assert.equal(parseStrict('9007199254740991'), 9007199254740991)
  assert.equal(parseStrict('-9007199254740991'), -9007199254740991)
  for (const s of ['9007199254740992', '-9007199254740993', '1e30', '1E400', '-1e999']) {
    assert.throws(() => parseStrict(s), malformed, s)
  }
  assert.equal(parseStrict('0.5'), 0.5)
})

test('strict parser: refuses everything outside the JSON grammar', () => {
  for (const s of ['', ' ', '{', '[1,]', '{"a":1,}', '01', '1.', '.5', '+1', '-', '1e', 'NaN', 'Infinity',
    "'a'", '"a', '"\t"', '"\\x41"', '"\\u12"', '{a:1}', '[1] [2]', '{"a":1}x', '// c\n1', 'tru', 'nul']) {
    assert.throws(() => parseStrict(s), malformed, JSON.stringify(s))
  }
})

test('strict parser: refuses nesting past the depth limit', () => {
  assert.doesNotThrow(() => parseStrict('['.repeat(MAX_DEPTH) + ']'.repeat(MAX_DEPTH)))
  assert.throws(() => parseStrict('['.repeat(MAX_DEPTH + 1) + ']'.repeat(MAX_DEPTH + 1)), malformed)
  assert.throws(() => parseStrict('['.repeat(100000)), malformed)
})

// --- Keys, ids, addresses ---------------------------------------------------

test('keys: export and import round-trip; bad keys are refused', () => {
  const { publicKey } = generateFederationKey()
  const pub = exportPublicKey(publicKey)
  assert.match(pub, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(exportPublicKey(importPublicKey(pub)), pub)
  for (const bad of ['', 'x', pub + 'A', pub.slice(0, 42) + '=', 42, null]) {
    assert.throws(() => importPublicKey(bad), { message: 'bad_key' })
  }
})

test('fingerprint: 26 base32 characters, stable, differs per key', () => {
  const a = exportPublicKey(generateFederationKey().publicKey)
  const b = exportPublicKey(generateFederationKey().publicKey)
  assert.match(keyFingerprint(a), /^[a-z2-7]{26}$/)
  assert.equal(keyFingerprint(a), keyFingerprint(a))
  assert.notEqual(keyFingerprint(a), keyFingerprint(b))
  assert.match(formatFingerprint(keyFingerprint(a)), /^([a-z2-7]{4} ){6}[a-z2-7]{2}$/)
})

test('op ids: ULIDs that sort by time', () => {
  const a = newOpId(1700000000000)
  const b = newOpId(1700000000001)
  assert.ok(isOpId(a) && isOpId(b))
  assert.ok(a < b)
  assert.equal(newOpId(0, Buffer.alloc(10)), '0'.repeat(26))
  assert.equal(newOpId(281474976710655, Buffer.alloc(10, 0xff)), '7' + 'Z'.repeat(25))
  for (const bad of ['', '8' + '0'.repeat(25), '0'.repeat(25), '0'.repeat(25) + 'I', 'a'.repeat(26), 1]) {
    assert.equal(isOpId(bad), false, String(bad))
  }
})

test('addresses: name@host', () => {
  for (const ok of ['alice@example.com', 'bob.b-2@journal.example.org', 'carol@localhost:8443']) assert.ok(isAddress(ok), ok)
  for (const bad of ['alice', '@example.com', 'alice@', 'alice@Example.com', 'a b@example.com',
    'alice@example..com', 'alice@-x.example', 'alice@example.com/x', 'alice@example.com:', 'al\nice@example.com']) {
    assert.equal(isAddress(bad), false, bad)
  }
})

// --- Envelopes --------------------------------------------------------------

const alice = generateFederationKey()
const mallory = generateFederationKey()
const T = 1700000000000
const op = (over = {}) => ({ from: 'alice@a.example', to: 'bob@b.example', op: 'mission.event', id: newOpId(T), body: { n: 1 }, ts: T, ...over })
const wire = (e) => Buffer.from(JSON.stringify(e))

test('envelope: signs the prefix plus the JCS form without sig', () => {
  const e = signEnvelope(op(), alice.privateKey)
  assert.equal(e.v, 1)
  assert.match(e.sig, /^[A-Za-z0-9_-]{86}$/)
  const { sig, ...rest } = e
  assert.equal(signingBytes(e).toString('utf8'), SIGNING_PREFIX + canonicalize(rest))
})

test('envelope: round trip over the wire, in any key order and spacing', () => {
  const e = signEnvelope(op({ body: { z: [1, 2], a: 'é' } }), alice.privateKey)
  const shuffled = Object.fromEntries(Object.entries(e).reverse())
  const parsed = parseEnvelope(Buffer.from(JSON.stringify(shuffled, null, 2)))
  assert.deepEqual(verifyEnvelope(parsed, alice.publicKey, { now: T }), e)
})

test('envelope: any change to a signed field breaks the signature', () => {
  const e = signEnvelope(op(), alice.privateKey)
  const tampered = [
    { from: 'mallory@a.example' }, { to: 'carol@b.example' }, { op: 'mission.write' },
    { id: newOpId(T + 1) }, { ts: T + 1 }, { body: { n: 2 } }, { body: { n: 1, extra: true } },
  ]
  for (const t of tampered) {
    const p = parseEnvelope(wire({ ...e, ...t }))
    assert.throws(() => verifyEnvelope(p, alice.publicKey, { now: T }), { message: 'bad_signature' }, JSON.stringify(t))
  }
})

test('envelope: a signature by another key, or a signature for another context, is refused', () => {
  const forged = signEnvelope(op(), mallory.privateKey)
  assert.throws(() => verifyEnvelope(parseEnvelope(wire(forged)), alice.publicKey, { now: T }), { message: 'bad_signature' })
  // The same key signing the bare JCS bytes (no prefix) does not make a federation signature.
  const { sig, ...rest } = signEnvelope(op(), alice.privateKey)
  const bare = rawSign(null, Buffer.from(canonicalize(rest)), alice.privateKey).toString('base64url')
  assert.throws(() => verifyEnvelope(parseEnvelope(wire({ ...rest, sig: bare })), alice.publicKey, { now: T }), { message: 'bad_signature' })
})

test('envelope: freshness applies to the attempt; a re-signed retry of an old op is fresh', () => {
  const first = signEnvelope(op(), alice.privateKey)
  const later = T + 3 * 24 * 3600 * 1000
  assert.throws(() => verifyEnvelope(first, alice.publicKey, { now: later }), (err) => err.message === 'stale' && err.clock === later)
  assert.throws(() => verifyEnvelope(first, alice.publicKey, { now: T - FRESHNESS_MS - 1 }), { message: 'stale' })
  assert.doesNotThrow(() => verifyEnvelope(first, alice.publicKey, { now: T + FRESHNESS_MS }))
  const retry = signEnvelope({ ...op(), id: first.id, body: first.body, ts: later }, alice.privateKey)
  assert.equal(retry.id, first.id)
  assert.doesNotThrow(() => verifyEnvelope(retry, alice.publicKey, { now: later }))
  assert.equal(opHash(retry), opHash(first))
})

test('envelope: a bad signature is reported before the clock', () => {
  const forged = signEnvelope(op(), mallory.privateKey)
  assert.throws(() => verifyEnvelope(forged, alice.publicKey, { now: T + 10 * FRESHNESS_MS }), { message: 'bad_signature' })
})

test('envelope: shape and version errors', () => {
  const e = signEnvelope(op(), alice.privateKey)
  assert.throws(() => parseEnvelope(wire({ ...e, v: 2 })), { message: 'unsupported_version' })
  assert.throws(() => parseEnvelope(wire({ ...e, v: '1' })), { message: 'unsupported_version' })
  const { v, ...noV } = e
  assert.throws(() => parseEnvelope(wire(noV)), malformed)
  const { sig, ...noSig } = e
  for (const bad of [noSig, { ...e, extra: 1 }, { ...e, from: 'alice' }, { ...e, to: 'Bob@B' }, { ...e, op: 'Mission' },
    { ...e, op: '' }, { ...e, id: 'x' }, { ...e, ts: 0 }, { ...e, ts: '1' }, { ...e, ts: 1.5 },
    { ...e, body: [] }, { ...e, body: null }, { ...e, body: 'x' }, { ...e, sig: 'x' }, [e], 'x', null]) {
    assert.throws(() => parseEnvelope(wire(bad)), malformed, JSON.stringify(bad))
  }
  assert.throws(() => parseEnvelope(Buffer.from(JSON.stringify(e).replace('"op"', '"op":"x","op"'))), malformed)
})

test('envelope: at most 1 MiB', () => {
  assert.throws(() => parseEnvelope(Buffer.alloc(MAX_ENVELOPE_BYTES + 1, 0x20)), { message: 'too_large' })
  const big = signEnvelope(op({ body: { pad: 'x'.repeat(MAX_ENVELOPE_BYTES - 400) } }), alice.privateKey)
  assert.ok(wire(big).length <= MAX_ENVELOPE_BYTES)
  assert.doesNotThrow(() => verifyEnvelope(parseEnvelope(wire(big)), alice.publicKey, { now: T }))
})

test('envelope: signing refuses a body that is not plain canonical data', () => {
  assert.throws(() => signEnvelope(op({ body: { n: 2n } }), alice.privateKey), { message: 'not_canonical' })
  assert.throws(() => signEnvelope(op({ body: { s: '\ud800' } }), alice.privateKey), { message: 'not_canonical' })
  assert.throws(() => signEnvelope(op({ from: 'alice' }), alice.privateKey), malformed)
})

test('opHash: same op and body hash alike whatever the key order; another body differs', () => {
  assert.equal(opHash({ op: 'a.b', body: { x: 1, y: 2 } }), opHash({ op: 'a.b', body: { y: 2, x: 1 } }))
  assert.notEqual(opHash({ op: 'a.b', body: { x: 1 } }), opHash({ op: 'a.b', body: { x: 2 } }))
  assert.notEqual(opHash({ op: 'a.b', body: { x: 1 } }), opHash({ op: 'a.c', body: { x: 1 } }))
})


test('strict parser and jcs: refuse Unicode noncharacters (I-JSON)', () => {
  for (const s of ['"\\uffff"', '"\\ufffe"', '"\\ufdd0"', '"\\ufdef"', '"\\ud83f\\udfff"', '"\\udbff\\udffe"', '{"\\uffff":1}', '"￿"']) {
    assert.throws(() => parseStrict(s), malformed, s)
  }
  for (const ok of ['"\\ufdcf"', '"\\ufdf0"', '"\\ufffd"', '"\\ud83f\\udffd"']) assert.doesNotThrow(() => parseStrict(ok), ok)
  for (const bad of ['￿', '﷐', '\u{1fffe}', '\u{10ffff}', { '￿': 1 }]) {
    assert.throws(() => canonicalize(bad), { message: 'not_canonical' })
  }
})

test('jcs: arrays are serialised by index, never through an overridden iterator', () => {
  const a = [1, 2]
  a[Symbol.iterator] = function* () { yield 9 }
  assert.equal(canonicalize(a), '[1,2]')
})

test('envelope: signing refuses what every receiver would refuse to parse', () => {
  assert.throws(() => signEnvelope(op({ body: { n: 2 ** 53 } }), alice.privateKey), malformed)
  let deep = {}
  for (let i = 0; i < MAX_DEPTH; i++) deep = { d: deep }
  assert.throws(() => signEnvelope(op({ body: deep }), alice.privateKey), malformed)
  assert.throws(() => signEnvelope(op({ body: { pad: 'x'.repeat(MAX_ENVELOPE_BYTES) } }), alice.privateKey), { message: 'too_large' })
})

test('envelope: the size cap is measured in bytes, whatever the input type', () => {
  const text = '{"pad":"' + 'é'.repeat(MAX_ENVELOPE_BYTES / 2) + '"}'
  assert.ok(text.length <= MAX_ENVELOPE_BYTES && Buffer.byteLength(text) > MAX_ENVELOPE_BYTES)
  assert.throws(() => parseEnvelope(text), { message: 'too_large' })
  assert.throws(() => parseEnvelope(new Uint8Array(Buffer.from(text))), { message: 'too_large' })
})

test('envelope: verify checks the shape of an object it is handed directly', () => {
  const e = signEnvelope(op(), alice.privateKey)
  const { ts, ...noTs } = e
  assert.throws(() => verifyEnvelope(noTs, alice.publicKey, { now: T }), malformed)
  assert.throws(() => verifyEnvelope({ ...e, extra: 1 }, alice.publicKey, { now: T }), malformed)
})

test('addresses: the name starts with a letter or digit', () => {
  for (const bad of ['_alice@example.com', '.alice@example.com', '-alice@example.com']) assert.equal(isAddress(bad), false, bad)
})
