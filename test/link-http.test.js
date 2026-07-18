import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { makeLinkStore } from '../src/link.js'

async function loggedInClient(s, username = 'dan', password = 'hunter22', deviceName = 'phone') {
  await createUser(s.db, username, password)
  const login = await s.http('/login', { method: 'POST', body: { username, password, device_name: deviceName } })
  return login.json
}

test('happy path: start → claim → status shows claimant → approve → poll mints a client device with username', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)

  const start = await s.http('/link/start', { method: 'POST', token: me.token, body: {} })
  assert.equal(start.status, 200)
  assert.match(start.json.link_code, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$/)
  assert.equal(start.json.expires_in, 120)

  // waiting before anyone claims
  const waiting = await s.http('/link/status', { method: 'POST', token: me.token, body: {} })
  assert.equal(waiting.json.status, 'waiting')

  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: start.json.link_code, device_name: '  Pixel 9  ' } })
  assert.equal(claim.status, 200)
  assert.equal(claim.json.status, 'claimed')
  assert.match(claim.json.claim_token, /^[0-9a-f]{64}$/)
  assert.ok(claim.json.expires_in > 0)

  // the approve screen sees the (trimmed) device name and requester IP
  const st = await s.http('/link/status', { method: 'POST', token: me.token, body: {} })
  assert.equal(st.json.status, 'claimed')
  assert.equal(st.json.device_name, 'Pixel 9')
  assert.equal(typeof st.json.requester_ip, 'string')
  assert.ok(st.json.requester_ip.length > 0)

  // pending before approve; and crucially NO device row exists yet
  const pending = await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })
  assert.deepEqual(pending.json, { status: 'pending' })
  let roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.length, 1) // just the phone

  const approve = await s.http('/link/approve', { method: 'POST', token: me.token, body: { link_code: start.json.link_code } })
  assert.equal(approve.status, 200)
  assert.deepEqual(approve.json, { status: 'approved' })
  // still no device row: mint happens at poll, not approve
  roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.length, 1)

  const poll = await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })
  assert.equal(poll.status, 200)
  assert.equal(poll.json.status, 'approved')
  assert.match(poll.json.token, /^[0-9a-f]{64}$/)
  assert.ok(Number.isInteger(poll.json.device_id))
  assert.equal(poll.json.user_id, me.user_id)
  assert.equal(poll.json.username, 'dan') // apps store this as UserSession.userID

  // exactly once: second poll is 404
  assert.equal((await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })).status, 404)

  // the minted device is a real client of the starter's user, named by the claimant…
  roster = await s.http('/devices', { token: me.token })
  const minted = roster.json.devices.find((d) => d.device_id === poll.json.device_id)
  assert.equal(minted.kind, 'client')
  assert.equal(minted.name, 'Pixel 9')
  // …and its token works as a full client bearer (client-only surface)
  const asNew = await s.http('/devices', { token: poll.json.token })
  assert.equal(asNew.status, 200)
})

test('starter-device binding: a second client of the same user cannot status/approve/deny the session', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const other = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'tablet' } })

  const start = await s.http('/link/start', { method: 'POST', token: me.token, body: {} })
  await s.http('/link/claim', { method: 'POST', body: { link_code: start.json.link_code, device_name: 'x' } })

  assert.equal((await s.http('/link/status', { method: 'POST', token: other.json.token, body: {} })).status, 404)
  assert.equal((await s.http('/link/approve', { method: 'POST', token: other.json.token, body: { link_code: start.json.link_code } })).status, 404)
  assert.equal((await s.http('/link/deny', { method: 'POST', token: other.json.token, body: { link_code: start.json.link_code } })).status, 404)
  // the true starter still can
  assert.equal((await s.http('/link/approve', { method: 'POST', token: me.token, body: { link_code: start.json.link_code } })).status, 200)
})

test('approve preconditions: 409 before any claim, 404 on a wrong code (intent check)', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const start = await s.http('/link/start', { method: 'POST', token: me.token, body: {} })

  const early = await s.http('/link/approve', { method: 'POST', token: me.token, body: { link_code: start.json.link_code } })
  assert.equal(early.status, 409)
  assert.deepEqual(early.json, { error: 'conflict' })

  const wrong = await s.http('/link/approve', { method: 'POST', token: me.token, body: { link_code: 'ZZZZ-ZZZZ' } })
  assert.equal(wrong.status, 404)
})

test('deny: claimant polls denied exactly once, then 404; second claim of the code is 409', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const start = await s.http('/link/start', { method: 'POST', token: me.token, body: {} })
  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: start.json.link_code, device_name: 'x' } })

  const second = await s.http('/link/claim', { method: 'POST', body: { link_code: start.json.link_code, device_name: 'y' } })
  assert.equal(second.status, 409)
  assert.deepEqual(second.json, { error: 'conflict' })

  const deny = await s.http('/link/deny', { method: 'POST', token: me.token, body: { link_code: start.json.link_code } })
  assert.equal(deny.status, 200)
  assert.deepEqual(deny.json, { status: 'denied' })

  assert.deepEqual((await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })).json, { status: 'denied' })
  assert.equal((await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })).status, 404)
  // denied leaves zero DB residue
  const roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.length, 1)
})

test('a new start replaces the previous session: the old code stops claiming', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const first = await s.http('/link/start', { method: 'POST', token: me.token, body: {} })
  const second = await s.http('/link/start', { method: 'POST', token: me.token, body: {} })
  assert.equal((await s.http('/link/claim', { method: 'POST', body: { link_code: first.json.link_code, device_name: 'x' } })).status, 404)
  assert.equal((await s.http('/link/claim', { method: 'POST', body: { link_code: second.json.link_code, device_name: 'x' } })).status, 200)
})

test('expired session leaves zero DB residue and polls 404', async (t) => {
  const s = await startTestServer({ links: makeLinkStore({ ttlMs: 30, claimExtensionMs: 0 }) })
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const start = await s.http('/link/start', { method: 'POST', token: me.token, body: {} })
  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: start.json.link_code, device_name: 'x' } })
  await s.http('/link/approve', { method: 'POST', token: me.token, body: { link_code: start.json.link_code } })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal((await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })).status, 404)
  const roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.length, 1) // no orphan client row, ever
})

test('gating: starter endpoints need a client bearer (401 unauth, 403 agent)', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await loggedInClient(s)
  const agent = createAgent(s.db, 1, 'existing-agent')

  for (const path of ['/link/start', '/link/status', '/link/approve', '/link/deny']) {
    const body = path === '/link/approve' || path === '/link/deny' ? { link_code: 'XXXX-XXXX' } : {}
    assert.equal((await s.http(path, { method: 'POST', body })).status, 401, path)
    assert.equal((await s.http(path, { method: 'POST', token: agent.token, body })).status, 403, path)
  }
})

test('validation: bad claim/poll/approve/deny bodies are 400', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)

  const longName = 'x'.repeat(65)
  for (const body of [
    {},
    { link_code: 'ABCD-1234' },                             // missing device_name
    { device_name: 'x' },                                   // missing link_code
    { link_code: 7, device_name: 'x' },                     // non-string code
    { link_code: 'ABCD-1234', device_name: 7 },             // non-string name
    { link_code: 'ABCD-1234', device_name: '' },            // empty name
    { link_code: 'ABCD-1234', device_name: '   ' },         // whitespace-only name
    { link_code: 'ABCD-1234', device_name: longName },      // > 64 chars
  ]) {
    // Each malformed body still counts against /link/claim's shared per-IP
    // limiter (same convention as /login — rejecting a bad body happens
    // after the throttle check, on purpose: garbage still costs budget).
    // This loop alone sends 8 requests, more than the default 5/min, so it
    // gets its own fresh server per check — this is purely a validation
    // test and shouldn't also trip the throttle test below exercises.
    const tmp = await startTestServer()
    const r = await tmp.http('/link/claim', { method: 'POST', body })
    await tmp.close()
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.deepEqual(r.json, { error: 'bad_request' })
  }

  for (const body of [{}, { claim_token: 7 }, { claim_token: '' }]) {
    assert.equal((await s.http('/link/poll', { method: 'POST', body })).status, 400, JSON.stringify(body))
  }
  for (const path of ['/link/approve', '/link/deny']) {
    for (const body of [{}, { link_code: 7 }, { link_code: '' }]) {
      assert.equal((await s.http(path, { method: 'POST', token: me.token, body })).status, 400, `${path} ${JSON.stringify(body)}`)
    }
  }

  // anti-enumeration: unknown code and unknown token are plain 404s
  assert.equal((await s.http('/link/claim', { method: 'POST', body: { link_code: 'ZZZZ-ZZZZ', device_name: 'x' } })).status, 404)
  assert.equal((await s.http('/link/poll', { method: 'POST', body: { claim_token: 'f'.repeat(64) } })).status, 404)
  // status with no session at all is 404 too
  assert.equal((await s.http('/link/status', { method: 'POST', token: me.token, body: {} })).status, 404)
})

test('link/claim shares the per-IP limiter; link/poll is unlimited', async (t) => {
  // rateLimiter default: 5/min per IP. All test-client requests share 127.0.0.1.
  const s = await startTestServer()
  t.after(() => s.close())
  // burn the whole budget on claims of unknown codes (no login — that would spend budget)
  for (let i = 0; i < 5; i++) {
    const r = await s.http('/link/claim', { method: 'POST', body: { link_code: 'ZZZZ-ZZZZ', device_name: 'x' } })
    assert.equal(r.status, 404, `claim ${i} should be within budget`)
  }
  const limited = await s.http('/link/claim', { method: 'POST', body: { link_code: 'ZZZZ-ZZZZ', device_name: 'x' } })
  assert.equal(limited.status, 429)
  assert.deepEqual(limited.json, { error: 'rate_limited' })
  // poll is not limited: still 404 (not 429) after the budget is gone
  assert.equal((await s.http('/link/poll', { method: 'POST', body: { claim_token: 'f'.repeat(64) } })).status, 404)
})

test('store cap surfaces as the limiter 429 shape on start', async (t) => {
  const s = await startTestServer({ links: makeLinkStore({ maxPending: 1 }) })
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const other = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'hunter22', device_name: 'tablet' } })
  assert.equal((await s.http('/link/start', { method: 'POST', token: me.token, body: {} })).status, 200)
  const capped = await s.http('/link/start', { method: 'POST', token: other.json.token, body: {} })
  assert.equal(capped.status, 429)
  assert.deepEqual(capped.json, { error: 'rate_limited' })
  // the first starter can still refresh its own session (replacement is cap-exempt)
  assert.equal((await s.http('/link/start', { method: 'POST', token: me.token, body: {} })).status, 200)
})

test('preapprove: mints a code that signs a claimant in with no approve tap', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')

  const pre = await s.http('/link/preapprove', {
    method: 'POST', body: { username: 'dan' }, headers: { 'x-preapprove-key': s.preapproveKey },
  })
  assert.equal(pre.status, 200)
  assert.match(pre.json.link_code, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$/)
  assert.equal(pre.json.expires_in, 600)

  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: pre.json.link_code, device_name: 'First Phone' } })
  assert.equal(claim.status, 200)
  // no /link/approve happens — the very first poll mints the device
  const poll = await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })
  assert.equal(poll.status, 200)
  assert.equal(poll.json.status, 'approved')
  assert.match(poll.json.token, /^[0-9a-f]{64}$/)
  assert.equal(poll.json.username, 'dan')
  // one-shot: second poll 404
  assert.equal((await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })).status, 404)
  // the minted device is a working client bearer
  assert.equal((await s.http('/devices', { token: poll.json.token })).status, 200)
})

test('preapprove guard: any proxy-forwarding header (or unknown user, or bad body) is rejected', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')

  // Loopback without forwarding headers (and with the right key) is the
  // accept path (covered above). Each forwarding header alone must still
  // 404 even with a correct key — external traffic always arrives via the
  // reverse proxy, which adds one of these.
  for (const headers of [
    { 'x-forwarded-for': '203.0.113.9' },
    { 'x-forwarded-proto': 'https' },
    { forwarded: 'for=203.0.113.9' },
    { 'cf-connecting-ip': '203.0.113.9' },
    { 'x-real-ip': '203.0.113.9' },
  ]) {
    const r = await fetch(`${s.base}/link/preapprove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-preapprove-key': s.preapproveKey, ...headers },
      body: JSON.stringify({ username: 'dan' }),
    })
    assert.equal(r.status, 404, JSON.stringify(headers))
    assert.deepEqual(await r.json(), { error: 'not_found' })
  }

  const keyHeaders = { 'x-preapprove-key': s.preapproveKey }
  assert.equal((await s.http('/link/preapprove', { method: 'POST', body: { username: 'nobody' }, headers: keyHeaders })).status, 404)
  for (const body of [{}, { username: 7 }, { username: '' }]) {
    assert.equal((await s.http('/link/preapprove', { method: 'POST', body, headers: keyHeaders })).status, 400, JSON.stringify(body))
  }
})

test('preapprove guard: missing or wrong x-preapprove-key is rejected even from a clean loopback caller', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')

  // No key header at all — a headerless reverse proxy (default nginx
  // `proxy_pass` with no `proxy_set_header` lines) adds none of the
  // forwarding headers either, so this is exactly what that traffic looks
  // like on the wire: loopback socket, zero forwarding headers, no key.
  const missing = await s.http('/link/preapprove', { method: 'POST', body: { username: 'dan' } })
  assert.equal(missing.status, 404)
  assert.deepEqual(missing.json, { error: 'not_found' })

  // Wrong key, same length as the real one (64 hex chars) — still 404.
  const wrongSameLength = await s.http('/link/preapprove', {
    method: 'POST', body: { username: 'dan' }, headers: { 'x-preapprove-key': 'f'.repeat(64) },
  })
  assert.equal(wrongSameLength.status, 404)
  assert.deepEqual(wrongSameLength.json, { error: 'not_found' })

  // Wrong key, different length — the length-mismatch branch of the
  // constant-time compare.
  const wrongLength = await s.http('/link/preapprove', {
    method: 'POST', body: { username: 'dan' }, headers: { 'x-preapprove-key': 'short' },
  })
  assert.equal(wrongLength.status, 404)
  assert.deepEqual(wrongLength.json, { error: 'not_found' })

  // The correct key from a clean loopback caller is the accept path.
  const ok = await s.http('/link/preapprove', {
    method: 'POST', body: { username: 'dan' }, headers: { 'x-preapprove-key': s.preapproveKey },
  })
  assert.equal(ok.status, 200)
})
