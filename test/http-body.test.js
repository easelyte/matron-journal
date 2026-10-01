import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readRawBody, readBody } from '../src/http-body.js'

// readRawBody's cap counts wire bytes, and decoding survives a multibyte
// character split across chunks (src/http-body.js).

const req = (chunks) => Readable.from(chunks.map((c) => Buffer.from(c)))

test('a multibyte character split across two chunks decodes intact', async () => {
  const euro = Buffer.from('{"a":"€"}')
  const at = euro.indexOf(0xe2) + 1 // inside the 3-byte €
  const r = Readable.from([euro.subarray(0, at), euro.subarray(at)])
  assert.deepEqual(await readBody(r), { a: '€' })
})

test('the cap counts bytes, not characters: 100 € (300 bytes) trips a 256-byte cap', async () => {
  await assert.rejects(readRawBody(req(['€'.repeat(100)]), { maxBytes: 256 }), (e) => e.statusCode === 413)
  assert.equal(await readRawBody(req(['€'.repeat(85)]), { maxBytes: 256 }), '€'.repeat(85)) // 255 bytes
})

test('the default cap is 1e6 bytes', async () => {
  assert.equal((await readRawBody(req(['x'.repeat(1e6)]))).length, 1e6)
  await assert.rejects(readRawBody(req(['x'.repeat(1e6), 'x'])), (e) => e.statusCode === 413)
})
