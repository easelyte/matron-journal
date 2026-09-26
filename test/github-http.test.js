import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { GithubError } from '../src/github.js'
import { openDb } from '../src/db.js'
import { saveGithubIdentity, deleteGithubAccount, githubAccountView } from '../src/github-accounts.js'
import { refreshGithubAccount } from '../src/github-http.js'

// A scripted stand-in for makeGithub(): poll/identity/exchange answers are
// queues of thunks; an empty queue answers the default.
function fakeGithub({ enabled = true, webFlow = false } = {}) {
  const q = { poll: [], identity: [], exchange: [], start: [] }
  const next = (k, fallback) => (q[k].length ? q[k].shift() : fallback)()
  return {
    q, enabled, webFlow, host: 'github.com',
    startDeviceFlow: async () => next('start', () => ({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 })),
    pollDeviceFlow: async () => next('poll', () => ({ status: 'pending' })),
    authorizeUrl: (state) => `https://github.com/login/oauth/authorize?client_id=abc&scope=read%3Aorg&state=${state}`,
    exchangeCode: async () => next('exchange', () => ({ token: 'tok' })),
    fetchIdentity: async () => next('identity', () => ({ github_id: 42, login: 'DanBarker', scopes: ['github.com/matronhq'] })),
  }
}

async function fleet(t, github) {
  const s = await startTestServer({ github })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, dan.id, 'dev-2')
  const danTok = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })).json.token
  const patTok = (await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'pw', device_name: 'mac' } })).json.token
  return { s, dan, pat, agent, danTok, patTok }
}

test('device flow end to end: start, poll pending, poll linked; /me shows the link', async (t) => {
  const gh = fakeGithub()
  const { s, danTok, agent } = await fleet(t, gh)
  const me0 = await s.http('/me', { token: danTok })
  assert.equal(me0.status, 200); assert.equal(me0.json.github, null); assert.deepEqual(me0.json.github_linking, { enabled: true, web_flow: false })
  assert.equal((await s.http('/github/link', { method: 'POST', token: agent.token, body: { flow: 'device' } })).status, 403, 'agents do not link accounts')
  const start = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  assert.equal(start.status, 200)
  assert.match(start.json.flow_id, /^gl_/); assert.equal(start.json.user_code, 'ABCD-1234'); assert.equal(start.json.interval, 5)
  assert.equal((await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'web' } })).status, 400, 'web flow needs a secret')
  const p1 = await s.http(`/github/link/${start.json.flow_id}/poll`, { method: 'POST', token: danTok })
  assert.deepEqual(p1.json, { status: 'pending' })
  gh.q.poll.push(() => ({ status: 'ok', token: 'tok' }))
  const p2 = await s.http(`/github/link/${start.json.flow_id}/poll`, { method: 'POST', token: danTok })
  assert.equal(p2.status, 200); assert.equal(p2.json.status, 'linked'); assert.equal(p2.json.github.login, 'DanBarker')
  assert.deepEqual(p2.json.github.orgs, ['github.com/matronhq'])
  assert.equal((await s.http(`/github/link/${start.json.flow_id}/poll`, { method: 'POST', token: danTok })).status, 404, 'flow is single use')
  const me = await s.http('/me', { token: danTok })
  assert.equal(me.json.github.login, 'DanBarker'); assert.equal(me.json.github.state, 'ok')
  assert.equal(JSON.stringify(me.json).includes('tok'), false, 'token never leaves the journal')
})

test('device flow: denied and expired end the flow; another user cannot poll it', async (t) => {
  const gh = fakeGithub()
  const { s, danTok, patTok } = await fleet(t, gh)
  const a = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  assert.equal((await s.http(`/github/link/${a.json.flow_id}/poll`, { method: 'POST', token: patTok })).status, 404)
  gh.q.poll.push(() => ({ status: 'denied' }))
  assert.deepEqual((await s.http(`/github/link/${a.json.flow_id}/poll`, { method: 'POST', token: danTok })).json, { status: 'denied' })
  assert.equal((await s.http(`/github/link/${a.json.flow_id}/poll`, { method: 'POST', token: danTok })).status, 404)
  const b = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  gh.q.poll.push(() => ({ status: 'expired' }))
  assert.deepEqual((await s.http(`/github/link/${b.json.flow_id}/poll`, { method: 'POST', token: danTok })).json, { status: 'expired' })
})

test('conflict: the same GitHub identity cannot be linked to two users (review focus 3)', async (t) => {
  const gh = fakeGithub()
  const { s, danTok, patTok } = await fleet(t, gh)
  const a = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  gh.q.poll.push(() => ({ status: 'ok', token: 't1' }))
  assert.equal((await s.http(`/github/link/${a.json.flow_id}/poll`, { method: 'POST', token: danTok })).json.status, 'linked')
  const b = await s.http('/github/link', { method: 'POST', token: patTok, body: { flow: 'device' } })
  gh.q.poll.push(() => ({ status: 'ok', token: 't2' }))
  const r = await s.http(`/github/link/${b.json.flow_id}/poll`, { method: 'POST', token: patTok })
  assert.equal(r.status, 409); assert.equal(r.json.error, 'conflict')
  assert.equal((await s.http('/me', { token: danTok })).json.github.login, 'DanBarker', 'first link untouched')
  assert.equal((await s.http('/me', { token: patTok })).json.github, null)
})

const nonceOf = (html) => html.match(/name="nonce" value="([0-9a-f]+)"/)[1]
const confirm = (s, body) => fetch(`${s.base}/github/callback/confirm`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(),
})

test('web flow: the callback shows a confirm page naming the GitHub login and the journal user; only Link saves; state and nonce are single-use (review focus 4)', async (t) => {
  const gh = fakeGithub({ webFlow: true })
  const { s, danTok } = await fleet(t, gh)
  const start = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'web' } })
  assert.equal(start.status, 200)
  const state = new URL(start.json.url).searchParams.get('state')
  assert.match(state, /^[0-9a-f]{32}$/)
  // No Bearer on the callback: it is the browser coming back from GitHub.
  const cb = await fetch(`${s.base}/github/callback?code=c0de&state=${state}`, { redirect: 'manual' })
  assert.equal(cb.status, 200)
  assert.match(cb.headers.get('content-type'), /^text\/html/)
  assert.equal(cb.headers.get('cache-control'), 'no-store')
  const html = await cb.text()
  assert.match(html, /DanBarker/); assert.match(html, /\bdan\b/)
  assert.equal((await s.http('/me', { token: danTok })).json.github, null, 'nothing is linked until the person on the page says so')
  const replay = await fetch(`${s.base}/github/callback?code=c0de&state=${state}`, { redirect: 'manual' })
  assert.equal(replay.status, 302); assert.equal(replay.headers.get('location'), '/app/account?link_error=expired')
  const nonce = nonceOf(html)
  const linked = await confirm(s, { nonce, decision: 'link' })
  assert.equal(linked.status, 302); assert.equal(linked.headers.get('location'), '/app/account?linked=1')
  assert.equal((await s.http('/me', { token: danTok })).json.github.login, 'DanBarker')
  assert.equal((await confirm(s, { nonce, decision: 'link' })).headers.get('location'), '/app/account?link_error=expired', 'a nonce is single-use')
  assert.equal((await confirm(s, { decision: 'link' })).headers.get('location'), '/app/account?link_error=bad_request')
  assert.equal((await confirm(s, { nonce: 'ff'.repeat(16), decision: 'link' })).headers.get('location'), '/app/account?link_error=expired')
  const junk = await fetch(`${s.base}/github/callback?code=c0de&state=nope`, { redirect: 'manual' })
  assert.equal(junk.headers.get('location'), '/app/account?link_error=expired')
  const start2 = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'web' } })
  const state2 = new URL(start2.json.url).searchParams.get('state')
  const missing = await fetch(`${s.base}/github/callback?state=${state2}`, { redirect: 'manual' })
  assert.equal(missing.headers.get('location'), '/app/account?link_error=bad_request')
  const again = await fetch(`${s.base}/github/callback?code=c0de&state=${state2}`, { redirect: 'manual' })
  assert.equal(again.headers.get('location'), '/app/account?link_error=expired', 'a code-less callback still consumed the state')
})

test('web flow: Cancel links nothing and drops the parked token; a conflict is refused before any page; the page escapes GitHub-supplied text; an expired nonce links nothing', async (t) => {
  const gh = fakeGithub({ webFlow: true })
  const { s, pat, danTok } = await fleet(t, gh)
  // Each start from its own address: /github/link shares /login's 5-per-minute per-IP limiter.
  let ip = 0
  const startWeb = async () => {
    const r = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'web' }, headers: { 'cf-connecting-ip': `10.9.0.${++ip}` } })
    assert.equal(r.status, 200)
    return new URL(r.json.url).searchParams.get('state')
  }
  const parked = () => s.db.prepare('SELECT COUNT(*) AS n FROM github_link_confirms').get().n
  gh.q.identity.push(() => ({ github_id: 7, login: '<b>evil</b>', scopes: [] }))
  const cb = await fetch(`${s.base}/github/callback?code=c0de&state=${await startWeb()}`, { redirect: 'manual' })
  const html = await cb.text()
  assert.ok(!html.includes('<b>evil</b>')); assert.ok(html.includes('&lt;b&gt;evil&lt;/b&gt;'))
  assert.equal(parked(), 1)
  const cancel = await confirm(s, { nonce: nonceOf(html), decision: 'cancel' })
  assert.equal(cancel.status, 302); assert.equal(cancel.headers.get('location'), '/app/account?link_error=denied')
  assert.equal((await s.http('/me', { token: danTok })).json.github, null)
  assert.equal(parked(), 0, 'cancel drops the parked token')
  // The identity is already bound to another journal user: refused at the callback, no page, nothing parked.
  saveGithubIdentity(s.db, { userId: pat.id, host: 'github.com', identity: { github_id: 42, login: 'DanBarker', scopes: [] }, token: 'tp', now: 1 })
  const conflict = await fetch(`${s.base}/github/callback?code=c0de&state=${await startWeb()}`, { redirect: 'manual' })
  assert.equal(conflict.status, 302); assert.equal(conflict.headers.get('location'), '/app/account?link_error=conflict')
  assert.equal(parked(), 0)
  deleteGithubAccount(s.db, pat.id)
  // An expired confirm row answers expired and links nothing.
  const cb2 = await fetch(`${s.base}/github/callback?code=c0de&state=${await startWeb()}`, { redirect: 'manual' })
  const nonce2 = nonceOf(await cb2.text())
  s.db.prepare('UPDATE github_link_confirms SET expires_at = 1').run()
  assert.equal((await confirm(s, { nonce: nonce2, decision: 'link' })).headers.get('location'), '/app/account?link_error=expired')
  assert.equal((await s.http('/me', { token: danTok })).json.github, null)
  assert.equal(parked(), 0, 'expired rows are swept')
  // Upstream failure on the exchange still redirects, nothing parked.
  gh.q.exchange.push(() => { throw new GithubError('upstream', 'boom') })
  const up = await fetch(`${s.base}/github/callback?code=c0de&state=${await startWeb()}`, { redirect: 'manual' })
  assert.equal(up.headers.get('location'), '/app/account?link_error=upstream')
  assert.equal(parked(), 0)
})

test('refresh: ok updates orgs; unauthorized marks stale; unreachable leaves everything; unlink deletes', async (t) => {
  const gh = fakeGithub()
  const { s, danTok } = await fleet(t, gh)
  const a = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  gh.q.poll.push(() => ({ status: 'ok', token: 't1' }))
  await s.http(`/github/link/${a.json.flow_id}/poll`, { method: 'POST', token: danTok })
  gh.q.identity.push(() => ({ github_id: 42, login: 'DanBarker', scopes: ['github.com/matronhq', 'github.com/yearbooks'] }))
  const r1 = await s.http('/github/refresh', { method: 'POST', token: danTok })
  assert.equal(r1.status, 200); assert.deepEqual(r1.json.github.orgs, ['github.com/matronhq', 'github.com/yearbooks'])
  gh.q.identity.push(() => { throw new GithubError('unauthorized') })
  const r2 = await s.http('/github/refresh', { method: 'POST', token: danTok })
  assert.equal(r2.status, 200); assert.equal(r2.json.github.state, 'stale')
  gh.q.identity.push(() => { throw new GithubError('unreachable') })
  const r3 = await s.http('/github/refresh', { method: 'POST', token: danTok })
  assert.equal(r3.status, 502); assert.equal(r3.json.error, 'upstream')
  assert.equal((await s.http('/me', { token: danTok })).json.github.state, 'stale', 'unreachable changed nothing')
  assert.equal((await s.http('/github/link', { method: 'DELETE', token: danTok })).status, 200)
  assert.equal((await s.http('/me', { token: danTok })).json.github, null)
  assert.equal((await s.http('/github/link', { method: 'DELETE', token: danTok })).status, 404)
  assert.equal((await s.http('/github/refresh', { method: 'POST', token: danTok })).status, 404, 'nothing to refresh')
})

test('refreshGithubAccount: a concurrent unlink is never resurrected once GitHub answers', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity: { github_id: 1, login: 'dan', scopes: ['github.com/matronhq'] }, token: 't1', now: 1 })
  let resolveIdentity
  const github = { host: 'github.com', fetchIdentity: () => new Promise((resolve) => { resolveIdentity = resolve }) }
  const p = refreshGithubAccount(db, github, dan.id, 5)
  assert.equal(deleteGithubAccount(db, dan.id), true, 'unlink lands while the refresh is in flight')
  resolveIdentity({ github_id: 1, login: 'dan', scopes: ['github.com/matronhq', 'github.com/yearbooks'] })
  const r = await p
  assert.equal(r.outcome, 'unchanged')
  assert.equal(githubAccountView(db, dan.id), null, 'unlink was not undone')
  assert.deepEqual(db.prepare('SELECT * FROM github_orgs WHERE user_id=?').all(dan.id), [], 'no orgs resurrected for the deleted account')
  db.close()
})

test('refreshGithubAccount: a concurrent re-link is never clobbered by the old token going unauthorized', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity: { github_id: 1, login: 'dan', scopes: ['github.com/matronhq'] }, token: 't1', now: 1 })
  let rejectIdentity
  const github = { host: 'github.com', fetchIdentity: () => new Promise((_resolve, reject) => { rejectIdentity = reject }) }
  const p = refreshGithubAccount(db, github, dan.id, 5)
  // A brand new link (new token, new GitHub identity) lands while the old
  // token's refresh is still in flight.
  saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity: { github_id: 2, login: 'dan2', scopes: ['github.com/yearbooks'] }, token: 't2', now: 10 })
  rejectIdentity(new GithubError('unauthorized'))
  const r = await p
  assert.equal(r.outcome, 'stale', 'reports the OLD token it was refreshing')
  const view = githubAccountView(db, dan.id)
  assert.equal(view.state, 'ok', 'the new link is untouched by the old token\'s unauthorized')
  assert.equal(view.login, 'dan2')
  db.close()
})

test('not configured: every linking route is 404 not_configured; /me says so', async (t) => {
  const { s, danTok } = await fleet(t, fakeGithub({ enabled: false }))
  assert.deepEqual((await s.http('/me', { token: danTok })).json.github_linking, { enabled: false, web_flow: false })
  const r = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  assert.equal(r.status, 404); assert.equal(r.json.error, 'not_configured')
})

test('device flow start caps the row TTL and the returned expires_in at LINK_FLOW_TTL_MS (10 min)', async (t) => {
  const gh = fakeGithub()
  const { s, danTok } = await fleet(t, gh)
  // GitHub's default expires_in (900s = 15min) exceeds the spec's 10-minute
  // link-flow limit, so both the stored row and the value handed back to
  // the client must be capped at 600s/600000ms.
  const start = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  assert.equal(start.json.expires_in, 600)
  const row = s.db.prepare('SELECT expires_at, created_at FROM github_link_flows WHERE id=?').get(start.json.flow_id)
  assert.equal(row.expires_at - row.created_at, 600000)

  // A shorter GitHub-provided expires_in is left untouched.
  gh.q.start.push(() => ({ device_code: 'dc2', user_code: 'WXYZ-5678', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 300 }))
  const start2 = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  assert.equal(start2.json.expires_in, 300)
  const row2 = s.db.prepare('SELECT expires_at, created_at FROM github_link_flows WHERE id=?').get(start2.json.flow_id)
  assert.equal(row2.expires_at - row2.created_at, 300000)
})

test('GET /me reports is_admin', async (t) => {
  const { s, dan, danTok, agent } = await fleet(t, fakeGithub())
  assert.equal((await s.http('/me', { token: danTok })).json.user.is_admin, false)
  s.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(dan.id)
  assert.deepEqual((await s.http('/me', { token: danTok })).json.user, { id: dan.id, name: 'dan', is_admin: true })
  assert.equal((await s.http('/me', { token: agent.token })).json.user.is_admin, true, '/me describes the user, not the device')
})

test('with MATRON_TOKEN_KEY: link, refresh and unlink work; the plaintext token is nowhere in the database files; a restart without the key logs and leaves the link alone (review focus 5)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-token-key-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'j.db')
  const secret = 'gho_' + 'f00dcafe'.repeat(5)
  const gh = fakeGithub()
  gh.q.poll.push(() => ({ status: 'ok', token: secret }))
  const s = await startTestServer({ dbPath, github: gh, tokenKey: 'ab'.repeat(32) })
  const dan = await createUser(s.db, 'dan', 'pw')
  const danTok = (await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })).json.token
  const start = await s.http('/github/link', { method: 'POST', token: danTok, body: { flow: 'device' } })
  const linked = await s.http(`/github/link/${start.json.flow_id}/poll`, { method: 'POST', token: danTok })
  assert.equal(linked.json.status, 'linked')
  const row = s.db.prepare('SELECT token, token_hash FROM github_accounts WHERE user_id=?').get(dan.id)
  assert.ok(row.token.startsWith('enc1:')); assert.ok(row.token_hash)
  gh.q.identity.push(() => ({ github_id: 42, login: 'DanBarker', scopes: ['github.com/matronhq', 'github.com/second'] }))
  const refreshed = await s.http('/github/refresh', { method: 'POST', token: danTok })
  assert.equal(refreshed.status, 200); assert.deepEqual(refreshed.json.github.orgs, ['github.com/matronhq', 'github.com/second'])
  await s.close()
  const bytes = Buffer.concat(['', '-wal', '-shm'].map((sfx) => { try { return fs.readFileSync(dbPath + sfx) } catch { return Buffer.alloc(0) } }))
  assert.ok(!bytes.includes(secret), 'the plaintext token must not be on disk')

  // Restart without the key: the sealed row is unreadable, not stale.
  const logs = []
  const s2 = await startTestServer({ dbPath, github: gh, tokenKey: '', githubRefreshIntervalMs: 3600000 })
  const origLog = console.log; console.log = (...a) => { logs.push(a.join(' ')); origLog(...a) }
  t.after(() => { console.log = origLog })
  const danTok2 = (await s2.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac2' } })).json.token
  const r = await s2.http('/github/refresh', { method: 'POST', token: danTok2 })
  assert.equal(r.status, 502)
  assert.equal((await s2.http('/me', { token: danTok2 })).json.github.state, 'ok')
  const { runGithubRefresh } = await import('../src/github-refresh.js')
  const out = await runGithubRefresh(s2.db, gh, { log: (l) => logs.push(l) })
  assert.deepEqual(out, { refreshed: 0, stale: 0, unchanged: 1 })
  assert.ok(logs.some((l) => /token_sealed/.test(l)), 'the operator is told the key is missing')
  assert.deepEqual((await s2.http('/github/link', { method: 'DELETE', token: danTok2 })).json, { ok: true })

  // Unlinking an unreadable row must not leave the account stuck: a fresh
  // link (this process has no key, so the new token is stored plain) works
  // exactly as it would for a user who was never linked.
  gh.q.poll.push(() => ({ status: 'ok', token: 'gho_replacement' }))
  const relinkStart = await s2.http('/github/link', { method: 'POST', token: danTok2, body: { flow: 'device' } })
  assert.equal(relinkStart.status, 200)
  const relinkPoll = await s2.http(`/github/link/${relinkStart.json.flow_id}/poll`, { method: 'POST', token: danTok2 })
  assert.equal(relinkPoll.status, 200); assert.equal(relinkPoll.json.status, 'linked')
  const me2 = await s2.http('/me', { token: danTok2 })
  assert.equal(me2.json.github.login, 'DanBarker'); assert.equal(me2.json.github.state, 'ok')
  await s2.close()
})
