// HTTP surface of GitHub account linking (spec 2026-09-23 tracker
// web/teams, "Flows"). Client devices only: an agent (the bridge) never
// links its user's identity. Every route but the callback sits behind
// Bearer auth; the callback is authenticated by the single-use `state` the
// journal minted for the flow row, so the browser's session is ignored.
import { randomBytes } from 'node:crypto'
import { json, readBody, readRawBody } from './http-body.js'
import { badRequest, notFound, conflict } from './http-who.js'
import { GithubError } from './github.js'
import {
  githubAccountView, saveGithubIdentity, updateGithubIdentity, markGithubStale, deleteGithubAccount,
  createLinkFlow, takeLinkFlow, LINK_FLOW_TTL_MS,
  githubIdentityBoundElsewhere, createLinkConfirm, takeLinkConfirm,
} from './github-accounts.js'
import { PLAIN_BOX, tokenHash } from './token-box.js'

const FLOWS = ['device', 'web']
const notConfigured = (res) => { json(res, 404, { error: 'not_configured' }); return true }
const upstream = (res) => { json(res, 502, { error: 'upstream' }); return true }
const forbidden = (res) => { json(res, 403, { error: 'forbidden' }); return true }

// Turns a fresh token into a stored link. Shared by the poll and the
// callback so the two flows cannot drift.
export async function finishLink(db, github, { userId, token, now = Date.now(), box = PLAIN_BOX }) {
  const identity = await github.fetchIdentity(token)
  return saveGithubIdentity(db, { userId, host: github.host, identity, token, now, box })
}

// Re-reads memberships with the stored token. 'stale' = GitHub refused the
// token (fail closed: the predicate ignores stale rows); 'unchanged' =
// GitHub was unreachable or answered junk, previous list kept, and also the
// outcome when the refresh's own row is gone (unlinked) or has moved on to
// a different token (re-linked) by the time GitHub answers — the update is
// scoped to that exact token so a stale write can never resurrect or
// clobber the row that replaced it (final review, revoke/re-link race).
export async function refreshGithubAccount(db, github, userId, now = Date.now(), { box = PLAIN_BOX } = {}) {
  const row = db.prepare('SELECT token, token_hash FROM github_accounts WHERE user_id=?').get(userId)
  if (!row) return null
  let token
  try {
    token = box.open(row.token)
  } catch (err) {
    // Sealed under a key this process does not have (or a corrupted row):
    // say so and keep everything — never stale, never a crash.
    return { view: githubAccountView(db, userId), outcome: 'unchanged', error: { code: err.message } }
  }
  const hash = row.token_hash ?? tokenHash(token)
  try {
    const identity = await github.fetchIdentity(token)
    const view = updateGithubIdentity(db, { userId, tokenHash: hash, identity, now })
    if (!view) return { view: githubAccountView(db, userId), outcome: 'unchanged' }
    return { view, outcome: 'ok' }
  } catch (err) {
    if (err instanceof GithubError && err.code === 'unauthorized') {
      markGithubStale(db, userId, { tokenHash: hash, now })
      return { view: githubAccountView(db, userId), outcome: 'stale' }
    }
    if (err instanceof GithubError) return { view: githubAccountView(db, userId), outcome: 'unchanged', error: err }
    throw err
  }
}

export async function handleGithubRoute(ctx, req, res, url, who) {
  const { db, github, rateLimiter, tokenBox = PLAIN_BOX } = ctx
  const path = url.pathname
  if (path !== '/github/link' && path !== '/github/refresh' && !path.startsWith('/github/link/')) return false
  if (who.kind !== 'client') return forbidden(res)
  if (!github || !github.enabled) return notConfigured(res)

  if (path === '/github/link' && req.method === 'POST') {
    // Same per-IP limiter /login uses: a link start is a GitHub round trip.
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'
    if (rateLimiter && !rateLimiter.allow(ip)) { json(res, 429, { error: 'rate_limited' }); return true }
    const body = await readBody(req)
    if (!FLOWS.includes(body.flow)) return badRequest(res)
    if (body.flow === 'web') {
      if (!github.webFlow) return badRequest(res)
      const state = randomBytes(16).toString('hex')
      createLinkFlow(db, { userId: who.userId, deviceId: who.deviceId, flow: 'web', state })
      json(res, 200, { url: github.authorizeUrl(state) })
      return true
    }
    let start
    try { start = await github.startDeviceFlow() } catch (err) { if (err instanceof GithubError) return upstream(res); throw err }
    // GitHub's expires_in has no upper bound; the spec caps every link flow
    // at LINK_FLOW_TTL_MS (10 min), so the row and the value we hand back
    // to the client must agree, or the client would keep polling a row that
    // has already been swept.
    const ttlMs = Math.min(start.expires_in * 1000, LINK_FLOW_TTL_MS)
    const flow = createLinkFlow(db, { userId: who.userId, deviceId: who.deviceId, flow: 'device', deviceCode: start.device_code, ttlMs })
    json(res, 200, { flow_id: flow.id, user_code: start.user_code, verification_uri: start.verification_uri, interval: start.interval, expires_in: Math.floor(ttlMs / 1000) })
    return true
  }

  const m = path.match(/^\/github\/link\/([^/]+)\/poll$/)
  if (m && req.method === 'POST') {
    // Peek without consuming: a pending poll must leave the row in place.
    const row = db.prepare("SELECT * FROM github_link_flows WHERE id=? AND flow='device' AND user_id=? AND expires_at > ?").get(m[1], who.userId, Date.now())
    if (!row) return notFound(res)
    let poll
    try { poll = await github.pollDeviceFlow(row.device_code) } catch (err) { if (err instanceof GithubError) return upstream(res); throw err }
    if (poll.status === 'pending') { json(res, 200, poll.interval ? { status: 'pending', interval: poll.interval } : { status: 'pending' }); return true }
    // Every other answer ends the flow, so consume the row now.
    takeLinkFlow(db, { id: row.id })
    if (poll.status !== 'ok') { json(res, 200, { status: poll.status }); return true }
    try {
      const view = await finishLink(db, github, { userId: who.userId, token: poll.token, box: tokenBox })
      json(res, 200, { status: 'linked', github: view })
    } catch (err) {
      if (err.message === 'github_conflict') return conflict(res)
      if (err instanceof GithubError) return upstream(res)
      throw err
    }
    return true
  }

  if (path === '/github/link' && req.method === 'DELETE') {
    if (!deleteGithubAccount(db, who.userId)) return notFound(res)
    json(res, 200, { ok: true })
    return true
  }

  if (path === '/github/refresh' && req.method === 'POST') {
    const r = await refreshGithubAccount(db, github, who.userId, Date.now(), { box: tokenBox })
    if (!r) return notFound(res)
    if (r.outcome === 'unchanged') return upstream(res)
    json(res, 200, { github: r.view })
    return true
  }
  return false
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// The one HTML page the journal serves. The person who just authorized on
// GitHub may not be the journal user who started the flow — an authorize
// URL can be handed to anyone — so before anything is saved they are told
// which journal account the identity would bind to, and only their click
// on Link completes it. GitHub's own pages cannot show this: they name the
// OAuth App, never the journal user.
function confirmPage({ login, userName, nonce }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link GitHub account</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}
button{font:inherit;padding:.5rem 1.25rem;margin-right:.5rem;border-radius:6px;cursor:pointer}
.link{background:#1f6feb;color:#fff;border:0}.cancel{background:none;border:1px solid #999}</style></head>
<body><h1>Link GitHub account</h1>
<p>You signed in to GitHub as <strong>@${escapeHtml(login)}</strong>.</p>
<p>This will link that GitHub account to the Matron journal user <strong>${escapeHtml(userName)}</strong>.
If that is not your journal account, cancel.</p>
<form method="post" action="/github/callback/confirm"><input type="hidden" name="nonce" value="${nonce}">
<button class="link" name="decision" value="link">Link</button>
<button class="cancel" name="decision" value="cancel">Cancel</button></form></body></html>
`
}

// Parses the confirm page's form POST (JSON is accepted too, for
// non-browser clients). Returns a plain object of string fields.
async function readFormOrJson(req) {
  const raw = await readRawBody(req)
  if (!raw) return {}
  if (/application\/json/.test(req.headers['content-type'] || '')) {
    let v
    try { v = JSON.parse(raw) } catch { return {} }
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  }
  return Object.fromEntries(new URLSearchParams(raw))
}

// GET /github/callback?code&state — the browser returning from GitHub's
// authorize page. No Bearer: the flow row's `state` is the credential, and
// it binds the resulting link to the row's user. The state is consumed
// BEFORE the code is checked, so a malformed callback still burns the
// state and a replay cannot complete it later. On success nothing is saved
// yet: the token and identity are parked on a confirm row and the person
// sees the confirm page. POST /github/callback/confirm {nonce, decision}
// finishes it: 'link' saves, anything else discards. Every failure
// redirects into the web app's account page so a user never sees raw JSON.
export async function handleGithubCallback(ctx, req, res, url) {
  const { db, github, tokenBox = PLAIN_BOX } = ctx
  const redirect = (to) => { res.writeHead(302, { location: to }); res.end(); return true }
  if (url.pathname === '/github/callback/confirm' && req.method === 'POST') {
    const body = await readFormOrJson(req)
    if (typeof body.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(body.nonce)) return redirect('/app/account?link_error=bad_request')
    let parked
    try {
      parked = takeLinkConfirm(db, { nonce: body.nonce, box: tokenBox })
    } catch {
      return redirect('/app/account?link_error=expired')
    }
    if (!parked) return redirect('/app/account?link_error=expired')
    if (body.decision !== 'link') return redirect('/app/account?link_error=denied')
    if (!github || !github.enabled) return redirect('/app/account?link_error=not_configured')
    try {
      saveGithubIdentity(db, { userId: parked.user_id, host: github.host, identity: parked.identity, token: parked.token, box: tokenBox })
    } catch (err) {
      if (err.message === 'github_conflict') return redirect('/app/account?link_error=conflict')
      throw err
    }
    return redirect('/app/account?linked=1')
  }
  if (url.pathname !== '/github/callback' || req.method !== 'GET') return false
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!github || !github.enabled || !github.webFlow) return redirect('/app/account?link_error=not_configured')
  if (typeof state !== 'string' || !state) return redirect('/app/account?link_error=bad_request')
  const row = takeLinkFlow(db, { state })
  if (!row) return redirect('/app/account?link_error=expired')
  if (typeof code !== 'string' || !code) return redirect('/app/account?link_error=bad_request')
  let token, identity
  try {
    ;({ token } = await github.exchangeCode(code))
    identity = await github.fetchIdentity(token)
  } catch (err) {
    if (err instanceof GithubError) return redirect('/app/account?link_error=upstream')
    throw err
  }
  if (githubIdentityBoundElsewhere(db, { host: github.host, githubId: identity.github_id, userId: row.user_id })) return redirect('/app/account?link_error=conflict')
  const user = db.prepare('SELECT name FROM users WHERE id=?').get(row.user_id)
  if (!user) return redirect('/app/account?link_error=expired')
  const { nonce } = createLinkConfirm(db, { userId: row.user_id, token, identity, box: tokenBox })
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  })
  res.end(confirmPage({ login: identity.login, userName: user.name, nonce }))
  return true
}
