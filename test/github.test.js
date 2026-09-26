import test from 'node:test'
import assert from 'node:assert/strict'
import { makeGithub, GithubError } from '../src/github.js'

// A fake fetch keyed by "METHOD url" prefix; each handler returns
// { status, json, headers } or throws for a network failure.
function fakeFetch(routes) {
  const calls = []
  const fetchImpl = async (url, opts = {}) => {
    const key = `${opts.method || 'GET'} ${url}`
    calls.push({ key, opts })
    const match = Object.entries(routes).find(([k]) => key.startsWith(k))
    if (!match) throw new Error(`unrouted ${key}`)
    const r = await match[1](opts, url)
    return {
      status: r.status ?? 200, ok: (r.status ?? 200) < 400,
      headers: { get: (h) => (r.headers || {})[h.toLowerCase()] ?? null },
      json: async () => r.json, text: async () => JSON.stringify(r.json),
    }
  }
  return { fetchImpl, calls }
}

test('makeGithub: enabled/webFlow reflect configuration', () => {
  assert.equal(makeGithub({ clientId: '' }).enabled, false)
  const g = makeGithub({ clientId: 'abc' })
  assert.equal(g.enabled, true); assert.equal(g.webFlow, false)
  assert.equal(makeGithub({ clientId: 'abc', clientSecret: 's' }).webFlow, true)
})

test('device flow: start posts client_id + read:org; poll maps GitHub errors to statuses', async () => {
  let pollN = 0
  const { fetchImpl, calls } = fakeFetch({
    'POST https://github.com/login/device/code': async () => ({ json: { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 } }),
    'POST https://github.com/login/oauth/access_token': async () => {
      pollN++
      if (pollN === 1) return { json: { error: 'authorization_pending' } }
      if (pollN === 2) return { json: { error: 'slow_down', interval: 10 } }
      if (pollN === 3) return { json: { error: 'expired_token' } }
      if (pollN === 4) return { json: { error: 'access_denied' } }
      return { json: { access_token: 'tok', scope: 'read:org' } }
    },
  })
  const g = makeGithub({ clientId: 'abc', fetchImpl })
  const start = await g.startDeviceFlow()
  assert.deepEqual(start, { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 })
  const body = new URLSearchParams(calls[0].opts.body)
  assert.equal(body.get('client_id'), 'abc'); assert.equal(body.get('scope'), 'read:org')
  assert.equal(calls[0].opts.headers.accept, 'application/json')
  assert.deepEqual(await g.pollDeviceFlow('dc'), { status: 'pending' })
  assert.deepEqual(await g.pollDeviceFlow('dc'), { status: 'pending', interval: 10 })
  assert.deepEqual(await g.pollDeviceFlow('dc'), { status: 'expired' })
  assert.deepEqual(await g.pollDeviceFlow('dc'), { status: 'denied' })
  assert.deepEqual(await g.pollDeviceFlow('dc'), { status: 'ok', token: 'tok' })
})

test('web flow: authorizeUrl carries client_id, scope and state; exchangeCode posts the secret', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'POST https://github.com/login/oauth/access_token': async () => ({ json: { access_token: 'tok' } }),
  })
  const g = makeGithub({ clientId: 'abc', clientSecret: 'sec', fetchImpl })
  const u = new URL(g.authorizeUrl('st4te'))
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize')
  assert.equal(u.searchParams.get('client_id'), 'abc'); assert.equal(u.searchParams.get('scope'), 'read:org'); assert.equal(u.searchParams.get('state'), 'st4te')
  assert.deepEqual(await g.exchangeCode('c0de'), { token: 'tok' })
  const body = new URLSearchParams(calls[0].opts.body)
  assert.equal(body.get('client_secret'), 'sec'); assert.equal(body.get('code'), 'c0de')
  await assert.rejects(makeGithub({ clientId: 'abc', fetchImpl }).exchangeCode('x'), /web flow not configured/)
})

test('fetchIdentity: reads /user and paginates org memberships into lower-cased scopes', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'GET https://api.github.com/user/memberships/orgs?state=active&per_page=100&page=2': async () => ({ json: [{ state: 'active', organization: { login: 'Yearbooks' } }] }),
    'GET https://api.github.com/user/memberships/orgs': async () => ({ json: [{ state: 'active', organization: { login: 'MatronHQ' } }, { state: 'pending', organization: { login: 'Nope' } }], headers: { link: '<https://api.github.com/user/memberships/orgs?state=active&per_page=100&page=2>; rel="next"' } }),
    'GET https://api.github.com/user': async () => ({ json: { id: 42, login: 'DanBarker' } }),
  })
  const g = makeGithub({ clientId: 'abc', fetchImpl })
  const id = await g.fetchIdentity('tok')
  assert.deepEqual(id, { github_id: 42, login: 'DanBarker', scopes: ['github.com/matronhq', 'github.com/yearbooks'] })
  assert.ok(calls.every((c) => c.opts.headers.authorization === 'Bearer tok'))
})

test('fetchIdentity: 401/403 is unauthorized, a network failure is unreachable, junk is bad_response', async () => {
  const g401 = makeGithub({ clientId: 'abc', fetchImpl: fakeFetch({ 'GET https://api.github.com/user': async () => ({ status: 401, json: { message: 'Bad credentials' } }) }).fetchImpl })
  await assert.rejects(g401.fetchIdentity('t'), (e) => e instanceof GithubError && e.code === 'unauthorized')
  const gNet = makeGithub({ clientId: 'abc', fetchImpl: async () => { throw new Error('ECONNRESET') } })
  await assert.rejects(gNet.fetchIdentity('t'), (e) => e instanceof GithubError && e.code === 'unreachable')
  const gJunk = makeGithub({ clientId: 'abc', fetchImpl: fakeFetch({ 'GET https://api.github.com/user': async () => ({ json: { nope: true } }) }).fetchImpl })
  await assert.rejects(gJunk.fetchIdentity('t'), (e) => e instanceof GithubError && e.code === 'bad_response')
})

test('GHES host: login and api URLs follow the configured host', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'POST https://ghe.example.com/login/device/code': async () => ({ json: { device_code: 'd', user_code: 'u', verification_uri: 'v', interval: 5, expires_in: 9 } }),
    'GET https://ghe.example.com/api/v3/user/memberships/orgs': async () => ({ json: [] }),
    'GET https://ghe.example.com/api/v3/user': async () => ({ json: { id: 1, login: 'x' } }),
  })
  const g = makeGithub({ clientId: 'abc', host: 'ghe.example.com', fetchImpl })
  await g.startDeviceFlow()
  assert.deepEqual((await g.fetchIdentity('t')).scopes, [])
  assert.ok(calls.some((c) => c.key.startsWith('GET https://ghe.example.com/api/v3/user')))
})

test('every request carries a bounded abort signal; a hung GitHub maps to unreachable', async () => {
  let seen = null
  const hung = (url, opts) => new Promise((_resolve, reject) => {
    seen = opts.signal
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason))
  })
  const gh = makeGithub({ clientId: 'abc', fetchImpl: hung, timeoutMs: 25 })
  // AbortSignal.timeout's timer is unref'd; a live server always has other
  // handles, but this test needs one so the loop stays open for the abort.
  const keepAlive = setTimeout(() => {}, 2000)
  const t0 = Date.now()
  try {
    await assert.rejects(gh.fetchIdentity('tok'), (err) => err instanceof GithubError && err.code === 'unreachable')
  } finally { clearTimeout(keepAlive) }
  assert.ok(seen instanceof AbortSignal, 'the fetch was given a signal')
  assert.ok(Date.now() - t0 < 2000, 'aborted by the timeout, not by anything slower')
})
