import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'

test('login → snapshot → pagination over HTTP', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'hunter22')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'T' })
  append(s.db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })

  const bad = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'no', device_name: 'x' } })
  assert.equal(bad.status, 403)
  const ok = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'mac' } })
  assert.equal(ok.status, 200)

  assert.equal((await s.http('/snapshot', {})).status, 401)
  const snap = await s.http('/snapshot', { token: ok.json.token })
  assert.equal(snap.json.seq, 1)
  assert.equal(snap.json.conversations.length, 1)

  const page = await s.http('/convo/c1/messages?limit=10', { token: ok.json.token })
  assert.equal(page.json.events[0].payload.body, 'hi')
  // pagination shape must match the WS journal frame shape (minus `kind`) and must not
  // leak internal columns like user_id, idem_key, blob_ref
  assert.deepEqual(Object.keys(page.json.events[0]).sort(), ['convo_id', 'payload', 'sender', 'seq', 'ts', 'type'])

  await createUser(s.db, 'pat', 'pw')
  const pat = await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw', device_name: 'x' } })
  // Unauthorized and missing are indistinguishable: both 404, same body as
  // GET /media/:id's unknown-id response — never 403 (that would leak that
  // the convo id exists at all).
  const forbidden = await s.http('/convo/c1/messages', { token: pat.json.token })
  assert.equal(forbidden.status, 404)
  assert.deepEqual(forbidden.json, { error: 'not_found' })
  const unknown = await s.http('/convo/does-not-exist/messages', { token: ok.json.token })
  assert.equal(unknown.status, 404)
  assert.deepEqual(unknown.json, { error: 'not_found' })
})

test('GET /convo/:id/messages validates limit, before_seq, and percent-encoding', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id })
  for (let i = 0; i < 5; i++) {
    append(s.db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: `m${i}` } })
  }
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const token = login.json.token

  for (const limit of ['0', '-1', 'abc', '1.5', 'NaN']) {
    const r = await s.http(`/convo/c1/messages?limit=${limit}`, { token })
    assert.equal(r.status, 400, `limit=${limit} should be 400`)
    assert.deepEqual(r.json, { error: 'bad_request' })
  }
  // over 200 is clamped, not rejected
  const clamped = await s.http('/convo/c1/messages?limit=500', { token })
  assert.equal(clamped.status, 200)
  const atCap = await s.http('/convo/c1/messages?limit=200', { token })
  assert.equal(atCap.status, 200)

  for (const beforeSeq of ['abc', '1.5', 'Infinity']) {
    const r = await s.http(`/convo/c1/messages?before_seq=${beforeSeq}`, { token })
    assert.equal(r.status, 400, `before_seq=${beforeSeq} should be 400`)
    assert.deepEqual(r.json, { error: 'bad_request' })
  }
  const validBeforeSeq = await s.http('/convo/c1/messages?before_seq=3', { token })
  assert.equal(validBeforeSeq.status, 200)

  // malformed percent-encoding in the convo id path segment
  const badEncoding = await fetch(s.base + '/convo/%zz/messages', { headers: { authorization: `Bearer ${token}` } })
  assert.equal(badEncoding.status, 400)
  assert.deepEqual(await badEncoding.json(), { error: 'bad_request' })
})

test('POST /login and /push/register reject a non-object JSON body (null, array, bare primitive) with 400, not 500', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'pw')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const token = login.json.token

  // Each /login attempt gets its own cf-connecting-ip so this loop doesn't
  // trip the 5/min per-IP rate limiter (unrelated to what's under test here).
  let nextIp = 1
  const postRaw = (path, rawBody, tok) => fetch(s.base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': `10.9.9.${nextIp++}`,
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    body: rawBody,
  })

  for (const rawBody of ['null', '"a string"', '42', 'true', '[1,2,3]']) {
    const r1 = await postRaw('/login', rawBody)
    assert.equal(r1.status, 400, `/login body=${rawBody}`)
    assert.deepEqual(await r1.json(), { error: 'bad_request' })

    const r2 = await postRaw('/push/register', rawBody, token)
    assert.equal(r2.status, 400, `/push/register body=${rawBody}`)
    assert.deepEqual(await r2.json(), { error: 'bad_request' })
  }
  // genuinely malformed JSON syntax also 400s at the same shared guard, not 500
  const r3 = await postRaw('/login', '{not json')
  assert.equal(r3.status, 400)
  assert.deepEqual(await r3.json(), { error: 'bad_request' })
})

test('POST /login rejects structurally invalid bodies with 400 bad_request, never 500', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')

  // Each attempt gets its own cf-connecting-ip so this test never trips the
  // 5/min per-IP rate limiter (unrelated to what's under test here).
  let nextIp = 1
  const postRaw = (rawBody) => fetch(s.base + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `10.8.8.${nextIp++}` },
    body: rawBody,
  })

  const malformed = [
    ['{}', 'empty object'],
    ['{"username":"dan"}', 'missing password'],
    ['{"password":"hunter22"}', 'missing username'],
    ['{"username":42,"password":"hunter22"}', 'non-string username'],
    ['{"username":"dan","password":42}', 'non-string password'],
    ['{"username":"","password":"hunter22"}', 'empty-string username'],
    ['{"username":"dan","password":""}', 'empty-string password'],
    ['{"username":null,"password":null}', 'null fields'],
    ['{not json', 'unparseable body'],
    ['', 'empty body'],
  ]
  for (const [rawBody, label] of malformed) {
    const r = await postRaw(rawBody)
    assert.equal(r.status, 400, `${label} (body=${JSON.stringify(rawBody)}) should be 400`)
    assert.deepEqual(await r.json(), { error: 'bad_request' }, `${label} body`)
  }

  // Malformed attempts must not have fed the per-username login guard: a
  // real login for the username they named still succeeds immediately.
  const ok = await postRaw(JSON.stringify({ username: 'dan', password: 'hunter22', device_name: 'mac' }))
  assert.equal(ok.status, 200)

  // Regression: a well-formed body with wrong credentials keeps its existing
  // semantics — 403 bad_credentials, not 400.
  const wrong = await postRaw(JSON.stringify({ username: 'dan', password: 'wrong', device_name: 'mac' }))
  assert.equal(wrong.status, 403)
  assert.deepEqual(await wrong.json(), { error: 'bad_credentials' })

  // device_name: optional, but when present it must be a string (or null).
  // A non-primitive here used to reach issueDevice's INSERT bind and 500 —
  // with VALID credentials. A numeric one used to bind fine and return 200;
  // that is now deliberately tightened to 400 (junk shape).
  const objDevice = await postRaw(JSON.stringify({ username: 'dan', password: 'hunter22', device_name: { a: 1 } }))
  assert.equal(objDevice.status, 400, 'object device_name should be 400')
  assert.deepEqual(await objDevice.json(), { error: 'bad_request' })
  const numDevice = await postRaw(JSON.stringify({ username: 'dan', password: 'hunter22', device_name: 42 }))
  assert.equal(numDevice.status, 400, 'numeric device_name should be 400')
  assert.deepEqual(await numDevice.json(), { error: 'bad_request' })
  // absent and null device_name stay valid logins (default device name)
  const absentDevice = await postRaw(JSON.stringify({ username: 'dan', password: 'hunter22' }))
  assert.equal(absentDevice.status, 200, 'absent device_name should be 200')
  const nullDevice = await postRaw(JSON.stringify({ username: 'dan', password: 'hunter22', device_name: null }))
  assert.equal(nullDevice.status, 200, 'null device_name should be 200')
})

test('an unexpected internal error responds 500 with a generic body only, no message leak, and the server stays up', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const mute = t.mock.method(console, 'error', () => {}) // the catch is expected to log; keep test output clean
  s.db.exec('DROP TABLE conversations')
  const r = await s.http('/snapshot', { token: login.json.token })
  assert.equal(r.status, 500)
  assert.deepEqual(r.json, { error: 'internal' })
  assert.ok(mute.mock.callCount() >= 1, 'expected the error to be logged server-side')
  // server keeps answering other requests after an internal error
  assert.equal((await s.http('/snapshot', {})).status, 401)
})

test('login for an unknown username still gets the normal rejection, not a 500', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const r = await s.http('/login', { method: 'POST', body: { username: 'nobody-here', password: 'x', device_name: 'y' } })
  assert.equal(r.status, 403)
  assert.deepEqual(r.json, { error: 'bad_credentials' })
})

test('POST /push/register: client devices can register/unregister an apns token; agents get 403', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'phone' } })
  const token = login.json.token
  const deviceId = login.json.device_id

  const reg = await s.http('/push/register', { method: 'POST', token, body: { apns_token: 'abc123', environment: 'sandbox' } })
  assert.equal(reg.status, 200)
  let row = s.db.prepare('SELECT apns_token, apns_env FROM devices WHERE id=?').get(deviceId)
  assert.equal(row.apns_token, 'abc123')
  assert.equal(row.apns_env, 'sandbox')

  // {apns_token: null} unregisters (both columns cleared)
  const unreg = await s.http('/push/register', { method: 'POST', token, body: { apns_token: null } })
  assert.equal(unreg.status, 200)
  row = s.db.prepare('SELECT apns_token, apns_env FROM devices WHERE id=?').get(deviceId)
  assert.equal(row.apns_token, null)
  assert.equal(row.apns_env, null)

  // bad environment -> 400, nothing stored
  const badEnv = await s.http('/push/register', { method: 'POST', token, body: { apns_token: 'abc123', environment: 'staging' } })
  assert.equal(badEnv.status, 400)
  assert.deepEqual(badEnv.json, { error: 'bad_request' })

  // missing/non-string apns_token -> 400
  const missingToken = await s.http('/push/register', { method: 'POST', token, body: { environment: 'prod' } })
  assert.equal(missingToken.status, 400)
  const numericToken = await s.http('/push/register', { method: 'POST', token, body: { apns_token: 12345, environment: 'prod' } })
  assert.equal(numericToken.status, 400)

  // still unregistered after all the rejected attempts
  row = s.db.prepare('SELECT apns_token, apns_env FROM devices WHERE id=?').get(deviceId)
  assert.equal(row.apns_token, null)

  // agent (kind='agent') devices are forbidden, not just unauthenticated
  const ag = createAgent(s.db, dan.id, 'bridge')
  const agentReg = await s.http('/push/register', { method: 'POST', token: ag.token, body: { apns_token: 'xyz', environment: 'prod' } })
  assert.equal(agentReg.status, 403)
  assert.deepEqual(agentReg.json, { error: 'forbidden' })

  // no bearer token -> 401
  const noAuth = await s.http('/push/register', { method: 'POST', body: { apns_token: 'x', environment: 'prod' } })
  assert.equal(noAuth.status, 401)
})

test('POST /password: happy path, all three rejects, agent 403, and the old device token stays valid after change', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'hunter22')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'mac' } })
  const token = login.json.token

  // missing/non-string old_password -> 400 bad_request, nothing changed
  const noOld = await s.http('/password', { method: 'POST', token, body: { new_password: 'newlongpw1' } })
  assert.equal(noOld.status, 400)
  assert.deepEqual(noOld.json, { error: 'bad_request' })

  // weak/missing new_password -> 400 weak_password
  const weak = await s.http('/password', { method: 'POST', token, body: { old_password: 'hunter22', new_password: 'short' } })
  assert.equal(weak.status, 400)
  assert.deepEqual(weak.json, { error: 'weak_password' })
  const missingNew = await s.http('/password', { method: 'POST', token, body: { old_password: 'hunter22' } })
  assert.equal(missingNew.status, 400)
  assert.deepEqual(missingNew.json, { error: 'weak_password' })

  // wrong old_password -> 401, after a real verify (not an oracle shortcut)
  const badOld = await s.http('/password', { method: 'POST', token, body: { old_password: 'nope-wrong', new_password: 'newlongpw1' } })
  assert.equal(badOld.status, 401)
  assert.deepEqual(badOld.json, { error: 'bad_password' })

  // agent tokens are forbidden outright, even with valid old/new passwords
  const ag = createAgent(s.db, dan.id, 'bridge')
  const agentAttempt = await s.http('/password', { method: 'POST', token: ag.token, body: { old_password: 'hunter22', new_password: 'newlongpw1' } })
  assert.equal(agentAttempt.status, 403)
  assert.deepEqual(agentAttempt.json, { error: 'forbidden' })

  // no bearer token -> 401
  const noAuth = await s.http('/password', { method: 'POST', body: { old_password: 'hunter22', new_password: 'newlongpw1' } })
  assert.equal(noAuth.status, 401)

  // none of the rejects actually changed the password
  const stillOld = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'x' } })
  assert.equal(stillOld.status, 200)

  // happy path
  const ok = await s.http('/password', { method: 'POST', token, body: { old_password: 'hunter22', new_password: 'newlongpw1' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json, { ok: true })

  // the old password no longer logs in, the new one does
  const oldFails = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'x' } })
  assert.equal(oldFails.status, 403)
  const newWorks = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'newlongpw1', device_name: 'x' } })
  assert.equal(newWorks.status, 200)

  // the device token used to change the password stays valid (documented:
  // existing device tokens are unaffected by a password change)
  const stillAuthed = await s.http('/snapshot', { token })
  assert.equal(stillAuthed.status, 200)
})

test('login rate limit returns 429', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'pw')
  for (let i = 0; i < 5; i++) {
    await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'wrong', device_name: 'x' } })
  }
  const r = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'x' } })
  assert.equal(r.status, 429)
})

test('login rate limit keys on cf-connecting-ip, not the tunnel-shared socket address', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'pw')
  await createUser(s.db, 'pat', 'pw2')

  const loginAs = (cfIp, username, password) => fetch(s.base + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': cfIp },
    body: JSON.stringify({ username, password, device_name: 'x' }),
  })

  // Behind the tunnel every request arrives from the same socket (127.0.0.1), so
  // without per-header keying this would lock out every client after 5 bad logins
  // from any one of them. Exhaust the limit for client A...
  for (let i = 0; i < 5; i++) await loginAs('1.1.1.1', 'dan', 'wrong')
  const blockedA = await loginAs('1.1.1.1', 'dan', 'wrong')
  assert.equal(blockedA.status, 429)

  // ...client B, a different cf-connecting-ip, must still be able to log in.
  // B is a different user: dan is per-username locked at this point regardless of IP.
  const okB = await loginAs('2.2.2.2', 'pat', 'pw2')
  assert.equal(okB.status, 200)
})

test('per-username lockout blocks distributed brute force across IPs', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'pw')
  await createUser(s.db, 'pat', 'pw2')

  const loginAs = (cfIp, username, password) => fetch(s.base + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': cfIp },
    body: JSON.stringify({ username, password, device_name: 'x' }),
  })

  // 5 failures against one username from 5 DIFFERENT IPs: each IP is used once,
  // so the per-IP limiter never trips - only per-username tracking can catch this.
  for (let i = 0; i < 5; i++) {
    assert.equal((await loginAs(`10.0.0.${i}`, 'dan', 'wrong')).status, 403)
  }
  // 6th attempt from a fresh IP is locked out - even with the CORRECT password
  // (the guard runs before the verify, so a locked username gives no oracle).
  const blocked = await loginAs('10.0.0.99', 'dan', 'pw')
  assert.equal(blocked.status, 429)
  const body = await blocked.json()
  assert.equal(body.error, 'locked_out')
  assert.ok(body.retry_after >= 1)
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1)
  // other usernames are unaffected by dan's lockout
  assert.equal((await loginAs('10.0.0.99', 'pat', 'pw2')).status, 200)
})

test('successful login resets the per-username failure count', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'pw')
  const loginAs = (cfIp, password) => fetch(s.base + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': cfIp },
    body: JSON.stringify({ username: 'dan', password, device_name: 'x' }),
  })
  // 4 failures (below the threshold of 5), then a success...
  for (let i = 0; i < 4; i++) await loginAs(`10.0.1.${i}`, 'wrong')
  assert.equal((await loginAs('10.0.1.50', 'pw')).status, 200)
  // ...4 more failures: without the reset these would be failures 5-8 and lock
  // the account; with it the count restarted from zero.
  for (let i = 0; i < 4; i++) await loginAs(`10.0.2.${i}`, 'wrong')
  assert.equal((await loginAs('10.0.2.50', 'pw')).status, 200)
})

test('oversized login body gets 413 and server stays responsive', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const big = JSON.stringify({ username: 'x'.repeat(1_100_000), password: 'y', device_name: 'z' })
  const r = await fetch(s.base + '/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: big,
  }).catch(() => null)
  if (r) assert.equal(r.status, 413)
  const after = await s.http('/snapshot', {})
  assert.equal(after.status, 401)
})

test('server stops consuming an oversized streaming body', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { request } = await import('node:http')
  const bytesWritten = await new Promise((resolve) => {
    const req = request(s.base + '/login', { method: 'POST', headers: { 'content-type': 'application/json' } })
    let written = 0
    let done = false
    const finish = () => { if (!done) { done = true; resolve(written) } }
    const chunk = 'x'.repeat(65536)
    req.on('error', finish)
    req.on('response', (res) => { res.resume(); res.on('end', () => setTimeout(finish, 100)) })
    setTimeout(finish, 4000)
    const pump = () => {
      while (written < 32e6 && !done) {
        written += chunk.length
        if (!req.write(chunk)) { req.once('drain', pump); return }
      }
      if (!done) req.end()
    }
    pump()
  })
  assert.ok(bytesWritten < 16e6, `client managed to write ${bytesWritten} bytes — server still consuming`)
})

test('PUT /push/prefs merges partial updates and echoes everywhere', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'password1')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password1', device_name: 'phone' } })
  const token = login.json.token

  // Defaults echo all-on from GET /devices.
  const before = await s.http('/devices', { token })
  assert.deepEqual(before.json.devices[0].push_prefs, { attention: true, done: true, activity: true })

  // Partial update merges.
  const r1 = await s.http('/push/prefs', { method: 'PUT', token, body: { activity: false } })
  assert.equal(r1.status, 200)
  assert.deepEqual(r1.json.push_prefs, { attention: true, done: true, activity: false })
  const r2 = await s.http('/push/prefs', { method: 'PUT', token, body: { done: false } })
  assert.deepEqual(r2.json.push_prefs, { attention: true, done: false, activity: false })

  // Echoed from /devices and /push/register.
  const after = await s.http('/devices', { token })
  assert.deepEqual(after.json.devices[0].push_prefs, { attention: true, done: false, activity: false })
  const reg = await s.http('/push/register', { method: 'POST', token, body: { apns_token: 'ab'.repeat(32), environment: 'prod' } })
  assert.equal(reg.status, 200)
  assert.deepEqual(reg.json.push_prefs, { attention: true, done: false, activity: false })
})

test('PUT /push/prefs validation: unknown fields, non-boolean values, agent devices', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'password1')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'password1' } })
  const token = login.json.token

  assert.equal((await s.http('/push/prefs', { method: 'PUT', token, body: { wake: false } })).status, 400)
  assert.equal((await s.http('/push/prefs', { method: 'PUT', token, body: { attention: 'no' } })).status, 400)
  assert.equal((await s.http('/push/prefs', { method: 'PUT', token, body: {} })).status, 200, 'an empty body is a valid no-op')

  const agent = createAgent(s.db, login.json.user_id, 'bridge')
  assert.equal((await s.http('/push/prefs', { method: 'PUT', token: agent.token, body: { attention: false } })).status, 403)
})
