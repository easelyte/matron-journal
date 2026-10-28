import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { makeCloudTts, TTS_CACHE_TTL_MS } from '../src/cloud-tts.js'

const quiet = { log() {}, error() {} }
const audio = (bytes) => { const b = Buffer.from(bytes); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }

// Azure stand-in: records each request, answers `reply` ({status?, bytes?}).
function fakeAzure(reply = {}, seen = []) {
  return async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body })
    const r = typeof reply === 'function' ? reply(seen.length) : reply
    const status = r.status ?? 200
    return { ok: status < 400, status, arrayBuffer: async () => audio(r.bytes ?? 'AUDIO'), text: async () => 'azure says no' }
  }
}

// Azure stand-in whose requests the test releases by hand.
function gatedAzure() {
  const gates = []
  const impl = (url, init) => new Promise((resolve, reject) => {
    gates.push({ ok: (bytes = 'AUDIO') => resolve({ ok: true, status: 200, arrayBuffer: async () => audio(bytes), text: async () => '' }) })
    init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true })
  })
  return { impl, gates }
}

const until = async (pred, ms = 2000) => {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

// A journal with alice (a phone and an agent box) and whatever `tts` the test
// passes: a makeCloudTts built over a stand-in fetch, or null for "no key".
async function setup(t, { tts, ttsOpts = {}, fetchImpl, serverOpts = {}, autoClose = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-tts-http-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cacheDir = path.join(dir, 'tts-cache')
  const resolved = tts === undefined ? makeCloudTts({ key: 'k', cacheDir, fetchImpl, log: quiet, ...ttsOpts }) : tts
  const s = await startTestServer({ dbPath: path.join(dir, 'test.db'), tts: resolved, ...serverOpts })
  if (autoClose) t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-a')
  const token = (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'phone' } })).json.token
  // Raw fetch: the helper's http() only reads JSON.
  const speak = (body, tok = token) => fetch(`${s.base}/tts`, {
    method: 'POST',
    headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { s, dir, cacheDir, alice, agent, token, speak }
}

test('POST /tts: a client gets the audio bytes with its type, a strong ETag and a day of private caching; asked twice, Azure is called once', async (t) => {
  const seen = []
  const { speak } = await setup(t, { fetchImpl: fakeAzure({ bytes: 'MP3-BYTES' }, seen) })
  const r = await speak({ text: 'The deploy finished & all checks passed.' })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'audio/mpeg')
  assert.equal(r.headers.get('cache-control'), 'private, max-age=86400')
  assert.equal(r.headers.get('content-length'), '9')
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(r.headers.get('etag'), `"${crypto.createHash('sha256').update('MP3-BYTES').digest('hex')}"`)
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), Buffer.from('MP3-BYTES'))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://northeurope.tts.speech.microsoft.com/cognitiveservices/v1')
  assert.equal(seen[0].headers['X-Microsoft-OutputFormat'], 'audio-24khz-48kbitrate-mono-mp3')
  assert.match(seen[0].body, /<voice name="en-GB-Harry:MAI-Voice-2\.1-Flash">The deploy finished &amp; all checks passed\.<\/voice>/)

  const again = await speak({ text: 'The deploy finished & all checks passed.' })
  assert.equal(again.status, 200)
  assert.equal(again.headers.get('etag'), r.headers.get('etag'))
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), Buffer.from('MP3-BYTES'))
  assert.equal(seen.length, 1, 'the second answer came from the cache')

  const wav = await speak({ text: 'The deploy finished & all checks passed.', voice: 'en-GB-Emily', format: 'wav' })
  assert.equal(wav.status, 200)
  assert.equal(wav.headers.get('content-type'), 'audio/wav')
  await wav.arrayBuffer()
  assert.equal(seen.length, 2)
  assert.equal(seen[1].headers['X-Microsoft-OutputFormat'], 'riff-16khz-16bit-mono-pcm')
  assert.match(seen[1].body, /<voice name="en-GB-Emily:MAI-Voice-2\.1-Flash">/)
})

test('POST /tts and GET /tts/voices: no token 401; an agent token 403 and nothing reaches Azure', async (t) => {
  const seen = []
  const { s, agent, speak } = await setup(t, { fetchImpl: fakeAzure({}, seen) })
  const anon = await speak({ text: 'hello' }, null)
  assert.equal(anon.status, 401)
  assert.deepEqual(await anon.json(), { error: 'unauthenticated' })
  assert.equal((await s.http('/tts/voices')).status, 401)
  const fromAgent = await speak({ text: 'hello' }, agent.token)
  assert.equal(fromAgent.status, 403)
  assert.deepEqual(await fromAgent.json(), { error: 'forbidden' })
  const voices = await s.http('/tts/voices', { token: agent.token })
  assert.equal(voices.status, 403)
  assert.deepEqual(voices.json, { error: 'forbidden' })
  assert.equal(seen.length, 0)
})

test('POST /tts: 400 bad_request for missing, empty, too-long text, an unknown format or a body that is not JSON; 400 unknown_voice off the list', async (t) => {
  const seen = []
  const { speak } = await setup(t, { fetchImpl: fakeAzure({}, seen) })
  const expect = async (body, status, error) => {
    const r = await speak(body)
    assert.equal(r.status, status, JSON.stringify(body).slice(0, 60))
    assert.equal(r.headers.get('content-type'), 'application/json')
    assert.deepEqual(await r.json(), { error })
  }
  await expect({}, 400, 'bad_request')
  await expect({ text: '' }, 400, 'bad_request')
  await expect({ text: '   ' }, 400, 'bad_request')
  await expect({ text: 42 }, 400, 'bad_request')
  await expect({ text: 'x'.repeat(2001) }, 400, 'bad_request')
  await expect({ text: 'hi', format: 'ogg' }, 400, 'bad_request')
  await expect('not json', 400, 'bad_request')
  await expect('["text"]', 400, 'bad_request')
  await expect({ text: 'hi', voice: 'en-US-Jenny' }, 400, 'unknown_voice')
  await expect({ text: 'hi', voice: 'en-GB-Harry"><break time="60s"/>' }, 400, 'unknown_voice')
  assert.equal(seen.length, 0)
  assert.equal((await speak({ text: `  ${'x'.repeat(2000)}  ` })).status, 200)
})

test('POST /tts: over the daily budget is 429 tts_budget_exceeded, and a cached line still plays', async (t) => {
  const seen = []
  const { speak } = await setup(t, { fetchImpl: fakeAzure({}, seen), ttsOpts: { dailyChars: 20 } })
  assert.equal((await speak({ text: 'x'.repeat(20) })).status, 200)
  const over = await speak({ text: 'one more' })
  assert.equal(over.status, 429)
  assert.deepEqual(await over.json(), { error: 'tts_budget_exceeded' })
  assert.equal(seen.length, 1)
  assert.equal((await speak({ text: 'x'.repeat(20) })).status, 200, 'a cache hit is free')
  assert.equal(seen.length, 1)
})

test('POST /tts: with every slot and the queue taken it is 503 tts_busy with Retry-After; an Azure failure is 502 tts_failed', async (t) => {
  const g = gatedAzure()
  const { speak } = await setup(t, { fetchImpl: g.impl, ttsOpts: { concurrency: 1, maxQueued: 0 } })
  const held = speak({ text: 'first' })
  await until(() => g.gates.length === 1)
  const busy = await speak({ text: 'second' })
  assert.equal(busy.status, 503)
  assert.equal(busy.headers.get('retry-after'), '1')
  assert.deepEqual(await busy.json(), { error: 'tts_busy' })
  g.gates[0].ok('FIRST')
  assert.equal((await held).status, 200)

  const failing = await setup(t, { fetchImpl: fakeAzure({ status: 500 }) })
  const bad = await failing.speak({ text: 'hello' })
  assert.equal(bad.status, 502)
  assert.deepEqual(await bad.json(), { error: 'tts_failed' }, 'Azure\'s own words never reach the caller')
})

test('no key: POST /tts and GET /tts/voices answer 501 tts_unconfigured', async (t) => {
  const { s, token, speak } = await setup(t, { tts: null })
  assert.equal(s.tts, null)
  const r = await speak({ text: 'hello' })
  assert.equal(r.status, 501)
  assert.deepEqual(await r.json(), { error: 'tts_unconfigured' })
  const v = await s.http('/tts/voices', { token })
  assert.equal(v.status, 501)
  assert.deepEqual(v.json, { error: 'tts_unconfigured' })
})

test('GET /tts/voices: the allow-list and the default; other methods on the two paths are 404', async (t) => {
  const { s, token } = await setup(t, { fetchImpl: fakeAzure() })
  const v = await s.http('/tts/voices', { token })
  assert.equal(v.status, 200)
  assert.deepEqual(v.json, {
    voices: [
      { id: 'en-GB-Harry', name: 'Harry', locale: 'en-GB', gender: 'male' },
      { id: 'en-GB-Emily', name: 'Emily', locale: 'en-GB', gender: 'female' },
    ],
    default: 'en-GB-Harry',
  })
  assert.equal((await s.http('/tts', { token })).status, 404)
  assert.equal((await s.http('/tts/voices', { method: 'POST', token, body: { x: 1 } })).status, 404)
})

// Sets process.env keys for one test and puts back what was there.
function withEnv(t, vars) {
  const saved = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  })
}
const TTS_ENV_OFF = {
  MATRON_TTS_AZURE_KEY: undefined, MATRON_TTS_AZURE_KEY_FILE: undefined, MATRON_TTS_AZURE_REGION: undefined,
  MATRON_TTS_MODEL: undefined, MATRON_TTS_VOICE: undefined, MATRON_TTS_DAILY_CHARS: undefined, MATRON_TTS_DISABLED: undefined,
  MATRON_STT_AZURE_KEY: undefined, MATRON_STT_AZURE_KEY_FILE: undefined, MATRON_STT_AZURE_ENDPOINT: undefined,
}

test('startServer builds the synthesiser from the environment: a key turns it on, MATRON_TTS_DISABLED=1 turns it off, no key is off', async (t) => {
  const origLog = console.log
  console.log = () => {}
  t.after(() => { console.log = origLog })
  withEnv(t, { ...TTS_ENV_OFF, MATRON_TTS_AZURE_KEY: 'not-a-real-key', MATRON_TTS_VOICE: 'en-GB-Emily' })
  const on = await setup(t, { serverOpts: { tts: undefined } })
  assert.equal(on.s.tts.label, 'Azure MAI-Voice-2.1-Flash at northeurope.tts.speech.microsoft.com')
  const v = await on.s.http('/tts/voices', { token: on.token })
  assert.equal(v.status, 200)
  assert.equal(v.json.default, 'en-GB-Emily')

  process.env.MATRON_TTS_DISABLED = '1'
  const off = await setup(t, { serverOpts: { tts: undefined } })
  assert.equal(off.s.tts, null)
  assert.equal((await off.s.http('/tts/voices', { token: off.token })).status, 501)

  delete process.env.MATRON_TTS_DISABLED
  delete process.env.MATRON_TTS_AZURE_KEY
  const none = await setup(t, { serverOpts: { tts: undefined } })
  assert.equal(none.s.tts, null)
})

test('the cache sweep runs at boot and on its timer, in tts-cache beside the database', async (t) => {
  const origLog = console.log
  const logs = []
  console.log = (...a) => logs.push(a.join(' '))
  t.after(() => { console.log = origLog })
  withEnv(t, { ...TTS_ENV_OFF, MATRON_TTS_AZURE_KEY: 'not-a-real-key' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-tts-sweep-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cacheDir = path.join(dir, 'tts-cache')
  fs.mkdirSync(cacheDir)
  const plant = (name, ageMs) => {
    const p = path.join(cacheDir, name)
    fs.writeFileSync(p, 'clip')
    const at = new Date(Date.now() - ageMs)
    fs.utimesSync(p, at, at)
    return p
  }
  const old = plant(`${'a'.repeat(64)}.mp3`, TTS_CACHE_TTL_MS + 60000)
  const fresh = plant(`${'b'.repeat(64)}.wav`, 60000)
  const s = await startTestServer({ dbPath: path.join(dir, 'test.db'), ttsSweepIntervalMs: 20 })
  t.after(() => s.close())
  assert.equal(fs.existsSync(old), false, 'swept at boot')
  assert.equal(fs.existsSync(fresh), true)
  assert.ok(logs.some((l) => l === 'tts: removed 1 cached clip(s) older than 24h'))
  const later = plant(`${'c'.repeat(64)}.mp3`, TTS_CACHE_TTL_MS + 60000)
  await until(() => !fs.existsSync(later))
  assert.equal(fs.existsSync(fresh), true)
})

test('close(): a POST /tts still waiting on Azure is answered 502 at once instead of holding shutdown for its timeout', async (t) => {
  const g = gatedAzure()
  const { s, speak } = await setup(t, { fetchImpl: g.impl, autoClose: false })
  const pending = speak({ text: 'never answered' })
  await until(() => g.gates.length === 1)
  const closing = s.close()
  t.after(() => closing)
  const r = await Promise.race([pending, new Promise((res) => setTimeout(() => res(null), 2000))])
  assert.ok(r, 'answered within 2 seconds of close(), not after the 20 s Azure timeout')
  assert.equal(r.status, 502)
  assert.deepEqual(await r.json(), { error: 'tts_failed' })
})
