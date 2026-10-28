import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUser, createAgent } from '../src/auth.js'
import { pinDevicePrivate } from '../src/db.js'
import {
  makeSummariser, makeConfiguredSummariser, resolveSummaryKey, makeWindowLimiter, parseSummaryUsers,
  ANTHROPIC_MESSAGES_URL, ANTHROPIC_VERSION, DEFAULT_SUMMARY_MODEL,
} from '../src/summarise.js'
import { SYSTEM_MAX_BYTES, PROMPT_MAX_BYTES } from '../src/summarise-http.js'
import { startTestServer } from './helpers.js'

// POST /summarise: a bridge's titles and rolling summaries, written with the
// journal's own key (src/summarise.js, src/summarise-http.js).

const SECRET_PROMPT = 'conversation text that must never be echoed'
const UPSTREAM_SECRET = 'upstream body that must never be echoed'

const quiet = () => {
  const lines = []
  return { lines, log: (l) => lines.push(l), error: (l) => lines.push(l) }
}

const completion = (over = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test-model',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'Fix the ' }, { type: 'text', text: 'login bug' }],
  usage: { input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 90, cache_creation_input_tokens: 30 },
  ...over,
})

// fetch stand-in: records each request, answers with `reply(seen)`.
function fakeFetch(reply = () => ({ body: completion() }), seen = []) {
  return async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal })
    const r = await reply(seen, init)
    if (r instanceof Error) throw r
    const status = r.status ?? 200
    return {
      ok: status < 400,
      status,
      body: { cancel: async () => {} },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    }
  }
}

async function fleet(t, opts = {}) {
  const out = quiet()
  const seen = []
  const summariser = opts.summariser === null ? null : makeSummariser({
    key: 'sk-test-key', fetchImpl: fakeFetch(opts.reply, seen), log: out, ...opts.make,
  })
  const s = await startTestServer({ summariser })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const bob = await createUser(s.db, 'bob', 'pw')
  const boxA = createAgent(s.db, alice.id, 'box-a')
  const boxB = createAgent(s.db, alice.id, 'box-b')
  const bobBox = createAgent(s.db, bob.id, 'box-c')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  const post = (token, body, headers) => s.http('/summarise', { method: 'POST', token, body, headers })
  return { s, seen, out, alice, boxA, boxB, bobBox, client: login.json.token, post }
}

// Raw response, for headers.
async function rawPost(s, token, body) {
  return fetch(`${s.base}/summarise`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('auth: an agent device token is served; a client token is 403; no or a bad token is 401', async (t) => {
  const f = await fleet(t)
  const ok = await f.post(f.boxA.token, { prompt: 'hi' })
  assert.equal(ok.status, 200)
  assert.deepEqual(await f.post(f.client, { prompt: 'hi' }), { status: 403, json: { error: 'forbidden' } })
  assert.deepEqual(await f.post(null, { prompt: 'hi' }), { status: 401, json: { error: 'unauthenticated' } })
  assert.deepEqual(await f.post('nope', { prompt: 'hi' }), { status: 401, json: { error: 'unauthenticated' } })
  assert.equal(f.seen.length, 1, 'only the agent call reached upstream')
})

test('happy path: the contract request upstream, the contract response back', async (t) => {
  const f = await fleet(t)
  const r = await f.post(f.boxA.token, { system: 'Title this conversation.', prompt: SECRET_PROMPT })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, {
    text: 'Fix the login bug',
    model: 'claude-test-model',
    usage: { inputTokens: 120, outputTokens: 8, cacheReadTokens: 90, cacheWriteTokens: 30 },
  })
  const [call] = f.seen
  assert.equal(call.url, ANTHROPIC_MESSAGES_URL)
  assert.equal(call.headers['x-api-key'], 'sk-test-key')
  assert.equal(call.headers['anthropic-version'], ANTHROPIC_VERSION)
  assert.ok(call.signal, 'a timeout signal rides on the request')
  assert.deepEqual(call.body, {
    model: DEFAULT_SUMMARY_MODEL,
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    system: [{ type: 'text', text: 'Title this conversation.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: SECRET_PROMPT }],
  })
  // The log line attributes the spend, and carries no conversation text.
  assert.ok(f.out.lines.some((l) => l.includes(`device=${f.boxA.deviceId} ok in=120 out=8 cache_read=90 cache_write=30`)))
  assert.ok(!f.out.lines.join('\n').includes(SECRET_PROMPT))
  assert.ok(!f.out.lines.join('\n').includes('sk-test-key'))
})

test('no system: the upstream body has no system key', async (t) => {
  const f = await fleet(t)
  assert.equal((await f.post(f.boxA.token, { prompt: 'p' })).status, 200)
  assert.equal('system' in f.seen[0].body, false)
  assert.equal((await f.post(f.boxA.token, { prompt: 'p', system: '' })).status, 200)
  assert.equal('system' in f.seen[1].body, false)
})

test('body: prompt required and a string, system a string; caps in UTF-8 bytes are 413', async (t) => {
  const f = await fleet(t)
  for (const body of [{}, { prompt: '' }, { prompt: 5 }, { prompt: ['x'] }, { prompt: 'x', system: 3 }, { prompt: 'x', system: {} }]) {
    assert.deepEqual(await f.post(f.boxA.token, body), { status: 400, json: { error: 'bad_request' } }, JSON.stringify(body))
  }
  const notJson = await rawPost(f.s, f.boxA.token, '{nope')
  assert.equal(notJson.status, 400)
  const arr = await rawPost(f.s, f.boxA.token, '[]')
  assert.equal(arr.status, 400)
  // At the cap passes; one byte over (a 3-byte character in place of a
  // 1-byte one counts as three) is 413.
  assert.equal((await f.post(f.boxA.token, { prompt: 'a'.repeat(PROMPT_MAX_BYTES) })).status, 200)
  assert.deepEqual(await f.post(f.boxA.token, { prompt: 'a'.repeat(PROMPT_MAX_BYTES - 2) + '€' }), { status: 413, json: { error: 'too_large' } })
  assert.equal((await f.post(f.boxA.token, { prompt: 'x', system: 's'.repeat(SYSTEM_MAX_BYTES) })).status, 200)
  assert.deepEqual(await f.post(f.boxA.token, { prompt: 'x', system: 's'.repeat(SYSTEM_MAX_BYTES + 1) }), { status: 413, json: { error: 'too_large' } })
  // A body past the whole-request cap is the shared 413 from readBody.
  const huge = await rawPost(f.s, f.boxA.token, JSON.stringify({ prompt: 'a'.repeat(3 * 1024 * 1024) })).catch((e) => e)
  if (!(huge instanceof Error)) assert.equal(huge.status, 413)
  assert.equal(f.seen.length, 2, 'only the two at-cap requests went upstream')
})

test('no key configured: 503 summariser_unavailable, for agents; clients still 403', async (t) => {
  const f = await fleet(t, { summariser: null })
  assert.deepEqual(await f.post(f.boxA.token, { prompt: 'hi' }), { status: 503, json: { error: 'summariser_unavailable' } })
  assert.deepEqual(await f.post(f.client, { prompt: 'hi' }), { status: 403, json: { error: 'forbidden' } })
})

test('upstream failures are 502 upstream_failed, and never echo the upstream body or the prompt', async (t) => {
  const cases = [
    ['non-200', () => ({ status: 529, body: { error: { message: UPSTREAM_SECRET } } })],
    ['400', () => ({ status: 400, body: { error: { message: UPSTREAM_SECRET } } })],
    ['network', () => new TypeError(`fetch failed ${UPSTREAM_SECRET}`)],
    ['max_tokens', () => ({ body: completion({ stop_reason: 'max_tokens', content: [{ type: 'text', text: UPSTREAM_SECRET }] }) })],
    ['refusal', () => ({ body: completion({ stop_reason: 'refusal' }) })],
    ['empty text', () => ({ body: completion({ content: [{ type: 'text', text: '  ' }] }) })],
    ['no content', () => ({ body: completion({ content: [] }) })],
    ['not json', () => ({ body: undefined, status: 200 })],
  ]
  for (const [name, reply] of cases) {
    const f = await fleet(t, {
      reply: name === 'not json'
        ? () => ({ status: 200, body: null })
        : reply,
    })
    const res = await rawPost(f.s, f.boxA.token, { prompt: SECRET_PROMPT })
    const text = await res.text()
    assert.equal(res.status, 502, name)
    assert.deepEqual(JSON.parse(text), { error: 'upstream_failed' }, name)
    const logged = f.out.lines.join('\n')
    for (const secret of [UPSTREAM_SECRET, SECRET_PROMPT, 'sk-test-key']) {
      assert.ok(!text.includes(secret), `${name}: response clean`)
      assert.ok(!logged.includes(secret), `${name}: log clean`)
    }
    assert.ok(f.out.lines.some((l) => l.includes(`device=${f.boxA.deviceId} upstream failed`)), name)
  }
})

test('upstream timeout: 502, logged as a timeout', async (t) => {
  const f = await fleet(t, {
    make: { timeoutMs: 50 },
    reply: (seen, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    }),
  })
  assert.deepEqual(await f.post(f.boxA.token, { prompt: 'p' }), { status: 502, json: { error: 'upstream_failed' } })
  assert.ok(f.out.lines.some((l) => l.includes('upstream failed: timeout')))
})

test('per-device hourly budget: 429 rate_limited with Retry-After; another device is unaffected', async (t) => {
  let now = 1_000_000
  const f = await fleet(t, { make: { deviceHourly: 2, now: () => now } })
  assert.equal((await f.post(f.boxA.token, { prompt: 'p' })).status, 200)
  now += 600_000
  assert.equal((await f.post(f.boxA.token, { prompt: 'p' })).status, 200)
  const res = await rawPost(f.s, f.boxA.token, { prompt: 'p' })
  assert.equal(res.status, 429)
  assert.deepEqual(await res.json(), { error: 'rate_limited' })
  // The first hit ages out 50 minutes from now.
  assert.equal(res.headers.get('retry-after'), String(50 * 60))
  assert.equal((await f.post(f.boxB.token, { prompt: 'p' })).status, 200)
  assert.equal(f.seen.length, 3)
  now += 50 * 60 * 1000
  assert.equal((await f.post(f.boxA.token, { prompt: 'p' })).status, 200)
})

test('global concurrency cap: a call past it is 429 with Retry-After, not queued upstream', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  const f = await fleet(t, { make: { concurrency: 1 }, reply: async () => { await gate; return { body: completion() } } })
  const first = f.post(f.boxA.token, { prompt: 'p' })
  while (f.seen.length < 1) await new Promise((r) => setTimeout(r, 5))
  const res = await rawPost(f.s, f.boxB.token, { prompt: 'p' })
  assert.equal(res.status, 429)
  assert.ok(Number(res.headers.get('retry-after')) >= 1)
  release()
  assert.equal((await first).status, 200)
  assert.equal(f.seen.length, 1)
})

test('a busy refusal does not spend the hourly budget; a call that gets a slot does, upstream failure included', async (t) => {
  let release
  let gate = new Promise((r) => { release = r })
  let fail = false
  const f = await fleet(t, {
    make: { concurrency: 1, deviceHourly: 2 },
    reply: async () => { await gate; return fail ? { status: 500, body: { error: UPSTREAM_SECRET } } : { body: completion() } },
  })
  // box-b holds the only slot; box-a is refused busy many times over.
  const holder = f.post(f.boxB.token, { prompt: 'p' })
  while (f.seen.length < 1) await new Promise((r) => setTimeout(r, 5))
  for (let i = 0; i < 5; i++) {
    const r = await rawPost(f.s, f.boxA.token, { prompt: 'p' })
    assert.equal(r.status, 429)
    assert.equal(r.headers.get('retry-after'), '2', 'busy, not out of budget')
  }
  release()
  assert.equal((await holder).status, 200)
  gate = Promise.resolve()
  // box-a still has both of its calls: one fails upstream, one succeeds…
  fail = true
  assert.equal((await f.post(f.boxA.token, { prompt: 'p' })).status, 502)
  fail = false
  assert.equal((await f.post(f.boxA.token, { prompt: 'p' })).status, 200)
  // …and both were charged, the failure too.
  const res = await rawPost(f.s, f.boxA.token, { prompt: 'p' })
  assert.equal(res.status, 429)
  assert.ok(Number(res.headers.get('retry-after')) > 2, 'out of budget: the hour-long wait')
  const m = (await f.s.http('/metrics', { token: f.client })).json.summarise
  const a = m.devices.find((d) => d.device_id === f.boxA.deviceId)
  assert.deepEqual(a.outcomes, { busy: 5, upstream_failed: 1, ok: 1, rate_limited: 1 })
})

test('GET /metrics: per-device spend for the caller\'s own devices only; totals for everyone', async (t) => {
  const f = await fleet(t)
  await f.post(f.boxA.token, { prompt: 'p' })
  await f.post(f.boxA.token, { prompt: 'p' })
  await f.post(f.bobBox.token, { prompt: 'p' })
  const m = (await f.s.http('/metrics', { token: f.client })).json.summarise
  assert.equal(m.enabled, true)
  assert.equal(m.requests, 3)
  assert.deepEqual(m.outcomes, { ok: 3 })
  assert.equal(m.input_tokens, 360)
  assert.deepEqual(m.devices.map((d) => d.device_id), [f.boxA.deviceId])
  assert.deepEqual(m.devices[0], {
    device_id: f.boxA.deviceId, requests: 2, outcomes: { ok: 2 },
    input_tokens: 240, output_tokens: 16, cache_read_tokens: 180, cache_write_tokens: 60,
  })
  // A private box's usage is hidden from an ordinary agent, shown to the app.
  pinDevicePrivate(f.s.db, f.boxA.deviceId, true)
  assert.deepEqual((await f.s.http('/metrics', { token: f.boxB.token })).json.summarise.devices, [])
  assert.equal((await f.s.http('/metrics', { token: f.client })).json.summarise.devices.length, 1)
})

test('makeWindowLimiter: rolling window, retryAfterMs until the oldest hit ages out', () => {
  let now = 0
  const l = makeWindowLimiter({ max: 2, windowMs: 1000, now: () => now })
  assert.deepEqual(l.take(1), { ok: true })
  now = 400
  assert.deepEqual(l.take(1), { ok: true })
  assert.deepEqual(l.take(1), { ok: false, retryAfterMs: 600 })
  assert.deepEqual(l.take(2), { ok: true })
  now = 1000
  assert.deepEqual(l.take(1), { ok: true })
  // check never records.
  const c = makeWindowLimiter({ max: 1, windowMs: 1000, now: () => now })
  for (let i = 0; i < 3; i++) assert.deepEqual(c.check(7), { ok: true })
  assert.deepEqual(c.take(7), { ok: true })
  assert.deepEqual(c.check(7), { ok: false, retryAfterMs: 1000 })
})

test('key: env first, else the _FILE, trimmed; none is no summariser', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarise-key-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'key')
  fs.writeFileSync(file, 'sk-from-file\n')
  assert.equal(resolveSummaryKey({ MATRON_SUMMARY_ANTHROPIC_KEY_FILE: file }), 'sk-from-file')
  assert.equal(resolveSummaryKey({ MATRON_SUMMARY_ANTHROPIC_KEY: ' sk-env ', MATRON_SUMMARY_ANTHROPIC_KEY_FILE: file }), 'sk-env')
  assert.equal(resolveSummaryKey({}), '')
  assert.equal(makeSummariser({ key: '' }), null)
  const out = quiet()
  assert.equal(makeConfiguredSummariser({ env: {}, log: out }), null)
})

test('makeConfiguredSummariser: key from _FILE reaches upstream; model and limits from env; an unreadable file is loud and off', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarise-key-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'key')
  fs.writeFileSync(file, 'sk-from-file\n')
  const seen = []
  const out = quiet()
  const s = makeConfiguredSummariser({
    env: { MATRON_SUMMARY_ANTHROPIC_KEY_FILE: file, MATRON_SUMMARY_MODEL: 'claude-other', MATRON_SUMMARY_DEVICE_HOURLY: '1' },
    log: out, fetchImpl: fakeFetch(undefined, seen),
  })
  const who = { deviceId: 9, userId: 1 }
  assert.equal((await s.summarise(who, { prompt: 'p' })).status, 'ok')
  assert.equal(seen[0].headers['x-api-key'], 'sk-from-file')
  assert.equal(seen[0].body.model, 'claude-other')
  assert.equal((await s.summarise(who, { prompt: 'p' })).status, 'rate_limited')
  assert.ok(!out.lines.join('\n').includes('sk-from-file'))

  const bad = quiet()
  assert.equal(makeConfiguredSummariser({ env: { MATRON_SUMMARY_ANTHROPIC_KEY_FILE: path.join(dir, 'missing') }, log: bad }), null)
  assert.ok(bad.lines.some((l) => l.includes('unreadable')))
})

test('parseSummaryUsers: trimmed names, empty entries dropped; unset or nothing left is null (everyone)', () => {
  assert.deepEqual(parseSummaryUsers(' alice , ,bob,, '), new Set(['alice', 'bob']))
  assert.deepEqual(parseSummaryUsers('alice'), new Set(['alice']))
  for (const raw of [undefined, null, '', '   ', ',', ' , ,, ']) assert.equal(parseSummaryUsers(raw), null, JSON.stringify(raw))
})

test('MATRON_SUMMARY_USERS set: a listed user\'s box gets 200, an unlisted user\'s box 503 without an upstream call', async (t) => {
  const f = await fleet(t, { make: { users: parseSummaryUsers(' alice, ,carol ,') } })
  assert.equal((await f.post(f.boxA.token, { prompt: 'p' })).status, 200)
  const res = await rawPost(f.s, f.bobBox.token, { prompt: SECRET_PROMPT })
  assert.equal(res.status, 503)
  assert.deepEqual(await res.json(), { error: 'summariser_unavailable' })
  assert.equal(f.seen.length, 1, 'the unlisted call never went upstream')
  // Still attributed to the device, in the log and in /metrics.
  assert.ok(f.out.lines.some((l) => l.includes(`device=${f.bobBox.deviceId} user=`) && l.includes('not allowed')))
  assert.ok(!f.out.lines.join('\n').includes(SECRET_PROMPT))
  const m = (await f.s.http('/metrics', { token: f.client })).json.summarise
  assert.deepEqual(m.outcomes, { ok: 1, not_allowed: 1 })
  // A client of an unlisted user is still a client: 403, not 503.
  const bobLogin = await f.s.http('/login', { method: 'POST', body: { username: 'bob', password: 'pw', device_name: 'phone' } })
  assert.equal((await f.post(bobLogin.json.token, { prompt: 'p' })).status, 403)
})

test('MATRON_SUMMARY_USERS matches the user name exactly', async (t) => {
  const f = await fleet(t, { make: { users: parseSummaryUsers('Alice') } })
  assert.deepEqual(await f.post(f.boxA.token, { prompt: 'p' }), { status: 503, json: { error: 'summariser_unavailable' } })
})

test('MATRON_SUMMARY_USERS unset or empty: every user allowed', async (t) => {
  for (const users of [null, parseSummaryUsers(''), parseSummaryUsers(' , ')]) {
    const f = await fleet(t, { make: { users } })
    assert.equal((await f.post(f.boxA.token, { prompt: 'p' })).status, 200)
    assert.equal((await f.post(f.bobBox.token, { prompt: 'p' })).status, 200)
  }
})

test('makeConfiguredSummariser reads MATRON_SUMMARY_USERS', () => {
  const out = quiet()
  const s = makeConfiguredSummariser({ env: { MATRON_SUMMARY_ANTHROPIC_KEY: 'k', MATRON_SUMMARY_USERS: 'alice, bob' }, log: out })
  const who = { deviceId: 3, userId: 1 }
  assert.equal(s.allows(who, 'alice'), true)
  assert.equal(s.allows(who, 'bob'), true)
  assert.equal(s.allows(who, 'carol'), false)
  assert.equal(s.allows(who, undefined), false)
  const open = makeConfiguredSummariser({ env: { MATRON_SUMMARY_ANTHROPIC_KEY: 'k' }, log: out })
  assert.equal(open.allows(who, 'carol'), true)
})
