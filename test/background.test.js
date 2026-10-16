// test/background.test.js — pacing for the startup backfills and the vector
// indexer (src/background.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import { throttle, cancellableDelay } from '../src/background.js'
import { embedOneByOne } from '../src/embedder.js'
import { resolveZeroableEnv } from '../src/server.js'

const busyFor = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }

test('throttle rests ratio × the batch time, timed from the end of the last rest', async () => {
  const pause = throttle({ ratio: 1 })
  busyFor(300)
  let t = Date.now()
  await pause()
  assert.ok(Date.now() - t >= 290, `rested ${Date.now() - t} ms after a 300 ms batch`)
  // A short batch right after gets a short rest, not the previous one again.
  busyFor(5)
  t = Date.now()
  await pause()
  assert.ok(Date.now() - t < 200, `rested ${Date.now() - t} ms after a 5 ms batch`)
})

test('throttle with ratio 0 is a single event-loop turn', async () => {
  const pause = throttle({ ratio: 0 })
  busyFor(300)
  const t = Date.now()
  await pause()
  assert.ok(Date.now() - t < 200)
})

test('the pacing env knobs accept 0, and fall back to the default on garbage', () => {
  assert.equal(resolveZeroableEnv('X', '0', 30000), 0)
  assert.equal(resolveZeroableEnv('X', undefined, 30000), 30000)
  assert.equal(resolveZeroableEnv('X', '5000', 30000), 5000)
  const warn = console.warn
  console.warn = () => {}
  try {
    assert.equal(resolveZeroableEnv('X', '-1', 30000), 30000)
    assert.equal(resolveZeroableEnv('X', 'soon', 1), 1)
  } finally { console.warn = warn }
})

test('cancellableDelay resolves early when cancelled', async () => {
  const d = cancellableDelay(60_000)
  const t = Date.now()
  setTimeout(() => d.cancel(), 10)
  await d.promise
  assert.ok(Date.now() - t < 1000)
})

test('embedOneByOne runs the model on one text at a time and frees each output', async () => {
  const calls = []
  let disposed = 0
  const fe = async (input, opts) => {
    calls.push({ input, opts })
    const data = Float32Array.from([input.length, 1, 2])
    return { dims: [1, 3], data, dispose: () => { disposed++ } }
  }
  const vecs = await embedOneByOne(fe)(['ab', 'c'.repeat(5000)])
  assert.deepEqual(calls.map((c) => typeof c.input), ['string', 'string'], 'never an array: no padded batch')
  assert.equal(calls[1].input.length, 2000, 'long text is cut before tokenising')
  assert.deepEqual(calls[0].opts, { pooling: 'cls', normalize: true })
  assert.deepEqual(vecs.map((v) => Array.from(v)), [[2, 1, 2], [2000, 1, 2]])
  assert.equal(disposed, 2)
})
