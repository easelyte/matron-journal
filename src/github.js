// GitHub OAuth + org-membership client (spec 2026-09-23 tracker web/teams,
// "GitHub account linking"). Two flows over ONE OAuth App: the device flow
// (client id only — works for any self-hosted journal) and the web flow
// (needs the client secret an installation's own app has). The only API
// question ever asked is "who is this token, and which orgs is it an active
// member of" — with the user's own read:org token, so private org
// memberships are visible without any org-level install.
//
// `fetchImpl` is the test seam. Nothing here logs a token or a code.

// Matron's published OAuth App client id. Empty until the app is registered
// (tracker task #2797); an empty id means "linking not configured" unless
// MATRON_GITHUB_CLIENT_ID overrides it.
export const DEFAULT_GITHUB_CLIENT_ID = ''
export const GITHUB_SCOPE = 'read:org'

export class GithubError extends Error {
  constructor(code, message) { super(message || code); this.code = code }
}

const form = (obj) => new URLSearchParams(obj).toString()

// Every GitHub request is bounded (timeoutMs): a connection GitHub accepts
// but never answers would otherwise hang the poll, the callback, and —
// worst — the daily refresh, which walks accounts one after another and is
// what shrinks memberships and marks refused tokens stale. An abort maps
// to 'unreachable' so every caller keeps its existing handling.
export function makeGithub({ clientId, clientSecret = null, host = 'github.com', fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const enabled = typeof clientId === 'string' && clientId.length > 0
  const webFlow = enabled && typeof clientSecret === 'string' && clientSecret.length > 0
  const loginBase = `https://${host}`
  const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`

  async function call(method, url, { body = null, token = null } = {}) {
    const headers = { accept: 'application/json', 'user-agent': 'matron-journal' }
    if (body != null) headers['content-type'] = 'application/x-www-form-urlencoded'
    if (token) headers.authorization = `Bearer ${token}`
    let res
    try {
      res = await fetchImpl(url, { method, headers, body: body == null ? undefined : body, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      throw new GithubError('unreachable', `github ${method} ${new URL(url).pathname}: ${err.message}`)
    }
    if (res.status === 401 || res.status === 403) throw new GithubError('unauthorized')
    if (res.status >= 500) throw new GithubError('unreachable', `github answered ${res.status}`)
    let json = null
    try { json = await res.json() } catch { throw new GithubError('bad_response') }
    return { status: res.status, json, headers: res.headers }
  }

  async function startDeviceFlow() {
    if (!enabled) throw new GithubError('bad_response', 'github linking not configured')
    const { json } = await call('POST', `${loginBase}/login/device/code`, { body: form({ client_id: clientId, scope: GITHUB_SCOPE }) })
    const { device_code, user_code, verification_uri, interval, expires_in } = json || {}
    if (typeof device_code !== 'string' || typeof user_code !== 'string' || typeof verification_uri !== 'string') throw new GithubError('bad_response')
    return { device_code, user_code, verification_uri, interval: Number(interval) || 5, expires_in: Number(expires_in) || 900 }
  }

  // Maps GitHub's device-flow poll answers onto the journal's own statuses.
  async function pollDeviceFlow(deviceCode) {
    const { json } = await call('POST', `${loginBase}/login/oauth/access_token`, {
      body: form({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    })
    if (json && typeof json.access_token === 'string') return { status: 'ok', token: json.access_token }
    switch (json && json.error) {
      case 'authorization_pending': return { status: 'pending' }
      case 'slow_down': return { status: 'pending', interval: Number(json.interval) || 10 }
      case 'expired_token': return { status: 'expired' }
      case 'access_denied': return { status: 'denied' }
      default: throw new GithubError('bad_response', `device poll: ${json && json.error}`)
    }
  }

  function authorizeUrl(state) {
    if (!webFlow) throw new GithubError('bad_response', 'web flow not configured')
    const u = new URL(`${loginBase}/login/oauth/authorize`)
    u.searchParams.set('client_id', clientId)
    u.searchParams.set('scope', GITHUB_SCOPE)
    u.searchParams.set('state', state)
    return u.toString()
  }

  async function exchangeCode(code) {
    if (!webFlow) throw new GithubError('bad_response', 'web flow not configured')
    const { json } = await call('POST', `${loginBase}/login/oauth/access_token`, {
      body: form({ client_id: clientId, client_secret: clientSecret, code }),
    })
    if (!json || typeof json.access_token !== 'string') throw new GithubError('bad_response', `code exchange: ${json && json.error}`)
    return { token: json.access_token }
  }

  // Follows RFC 5988 `Link: <url>; rel="next"` pagination.
  const nextLink = (headers) => {
    const link = headers && headers.get('link')
    if (!link) return null
    const m = /<([^>]+)>;\s*rel="next"/.exec(link)
    return m ? m[1] : null
  }

  async function fetchIdentity(token) {
    const user = await call('GET', `${apiBase}/user`, { token })
    if (!user.json || !Number.isInteger(user.json.id) || typeof user.json.login !== 'string') throw new GithubError('bad_response', 'user shape')
    const scopes = new Set()
    let url = `${apiBase}/user/memberships/orgs?state=active&per_page=100`
    for (let page = 0; url && page < 20; page++) {
      const r = await call('GET', url, { token })
      if (!Array.isArray(r.json)) throw new GithubError('bad_response', 'memberships shape')
      for (const m of r.json) {
        const login = m && m.organization && m.organization.login
        if (m.state === 'active' && typeof login === 'string' && login) scopes.add(`${host}/${login.toLowerCase()}`)
      }
      url = nextLink(r.headers)
    }
    return { github_id: user.json.id, login: user.json.login, scopes: [...scopes].sort() }
  }

  return { enabled, webFlow, host, startDeviceFlow, pollDeviceFlow, authorizeUrl, exchangeCode, fetchIdentity }
}
