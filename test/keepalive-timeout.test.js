import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'

// Runs `fn` with MATRON_KEEPALIVE_TIMEOUT_MS set to `value` (unset when
// undefined) and puts back whatever the environment had.
async function withKeepAlive(t, value, fn) {
  const original = process.env.MATRON_KEEPALIVE_TIMEOUT_MS
  t.after(() => {
    if (original === undefined) delete process.env.MATRON_KEEPALIVE_TIMEOUT_MS
    else process.env.MATRON_KEEPALIVE_TIMEOUT_MS = original
  })
  if (value === undefined) delete process.env.MATRON_KEEPALIVE_TIMEOUT_MS
  else process.env.MATRON_KEEPALIVE_TIMEOUT_MS = value
  const s = await startTestServer()
  t.after(() => s.close())
  await fn(s)
}

// A reverse proxy reuses its connections to the journal. An idle one must
// outlive the proxy's own idle time, or a request sent down a connection
// the journal is closing is reset and the caller gets a 502.
test('idle HTTP connections are kept longer than a reverse proxy keeps them', async (t) => {
  await withKeepAlive(t, undefined, (s) => {
    assert.equal(s.server.keepAliveTimeout, 120000)
    assert.equal(s.server.headersTimeout, 60000, 'slow headers are still cut off as before')
  })
})

test('MATRON_KEEPALIVE_TIMEOUT_MS sets it', async (t) => {
  await withKeepAlive(t, '75000', (s) => {
    assert.equal(s.server.keepAliveTimeout, 75000)
    assert.equal(s.server.headersTimeout, 60000)
  })
})
