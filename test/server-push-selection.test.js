import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveApnsClient } from '../src/server.js'

const APNS_VARS = ['MATRON_APNS_KEY_FILE', 'MATRON_APNS_KEY_ID', 'MATRON_APNS_TEAM_ID', 'MATRON_APNS_TOPIC', 'MATRON_PUSH_GATEWAY_URL']

// Every test rewrites push-related env; snapshot and restore around each so
// test order (and the developer's own shell env) can't leak in.
function withEnv(t, vars) {
  const saved = {}
  for (const k of APNS_VARS) { saved[k] = process.env[k]; delete process.env[k] }
  Object.assign(process.env, vars)
  t.after(() => {
    for (const k of APNS_VARS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
}

function writeTestKey() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-key-'))
  const keyFile = path.join(dir, 'AuthKey_TEST.p8')
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  return keyFile
}

test('no push env at all → disabled (undefined client)', (t) => {
  withEnv(t, {})
  const { client, owned } = resolveApnsClient(undefined)
  assert.equal(client, undefined)
  assert.equal(owned, false)
})

test('an injected client always wins', (t) => {
  withEnv(t, { MATRON_PUSH_GATEWAY_URL: 'https://push.matron.chat' })
  const sentinel = { send: async () => ({ status: 200, reason: null }), close: () => {} }
  const { client, owned } = resolveApnsClient(sentinel)
  assert.equal(client, sentinel)
  assert.equal(owned, false)
})

test('MATRON_PUSH_GATEWAY_URL alone → gateway client that POSTs /push to that URL', async (t) => {
  const hits = []
  const relay = http.createServer((req, res) => {
    hits.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 200, reason: null }))
  })
  await new Promise((res) => relay.listen(0, '127.0.0.1', res))
  t.after(() => relay.close())

  withEnv(t, { MATRON_PUSH_GATEWAY_URL: `http://127.0.0.1:${relay.address().port}` })
  const { client, owned } = resolveApnsClient(undefined)
  assert.equal(owned, true)
  t.after(() => client.close())
  const result = await client.send({
    deviceToken: 'a'.repeat(64), env: 'prod',
    payload: { aps: { alert: { title: 't', body: 'b' } } },
    priority: 10, pushType: 'alert', category: 'attention',
  })
  assert.equal(result.status, 200)
  assert.deepEqual(hits, ['/push'])
})

test('malformed MATRON_PUSH_GATEWAY_URL → disabled, not a boot crash', (t) => {
  withEnv(t, { MATRON_PUSH_GATEWAY_URL: 'push.matron.chat' }) // missing scheme
  const { client, owned } = resolveApnsClient(undefined)
  assert.equal(client, undefined)
  assert.equal(owned, false)
})

test('all four MATRON_APNS_* set beats the gateway URL (direct APNs wins)', async (t) => {
  // If the gateway were (wrongly) selected, it would POST here — it must not.
  const hits = []
  const relay = http.createServer((req, res) => { hits.push(req.url); res.end('{}') })
  await new Promise((res) => relay.listen(0, '127.0.0.1', res))
  t.after(() => relay.close())

  withEnv(t, {
    MATRON_APNS_KEY_FILE: writeTestKey(),
    MATRON_APNS_KEY_ID: 'KID',
    MATRON_APNS_TEAM_ID: 'TEAM',
    MATRON_APNS_TOPIC: 'chat.matron.app',
    MATRON_PUSH_GATEWAY_URL: `http://127.0.0.1:${relay.address().port}`,
  })
  const { client, owned } = resolveApnsClient(undefined)
  assert.equal(owned, true)
  t.after(() => client.close())
  // Direct client with an unreachable connect target: resolves a transport
  // failure (never rejects) — and, decisively, never touched the relay.
  const result = await client.send({
    deviceToken: 'a'.repeat(64), env: 'prod', payload: {}, priority: 5, pushType: 'alert',
  })
  assert.ok(result.status === 0 || result.status >= 400)
  assert.deepEqual(hits, [])
})
