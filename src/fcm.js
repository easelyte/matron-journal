import fs from 'node:fs'
import crypto from 'node:crypto'

// Firebase Cloud Messaging (HTTP v1) for the Android app: an OAuth2 access
// token minted from a service account (an RS256-signed JWT exchanged at the
// account's token endpoint, node:crypto only), then one POST per message to
// /v1/projects/<id>/messages:send. Same contract as makeApnsClient: send()
// resolves {status, reason} and never rejects, so the push pipeline's
// counters and dead-token pruning work the same way for both.
//
// `fetchImpl`, `apiBase` and the service account's `token_uri` are the test
// seams: the tests point both at an in-process fake server instead of Google.

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const DEFAULT_API_BASE = 'https://fcm.googleapis.com'
// Google issues access tokens for an hour. A token is replaced this long
// before it runs out, so one that expires mid-request is never sent.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
// How long sends fail fast after the token endpoint refused the service
// account, so a broken key costs one request a minute, not one per push.
const AUTH_RETRY_MS = 60 * 1000

const base64url = (buf) => Buffer.from(buf).toString('base64url')

// Reads a service-account JSON key file (the one the Firebase console
// downloads). Throws on a file that is not one: a misconfigured path must
// fail startup, as a bad VAPID key does.
export function readServiceAccount(file) {
  let json
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`MATRON_FCM_SERVICE_ACCOUNT_FILE is not readable JSON (${err.code || err.name})`)
  }
  return parseServiceAccount(json)
}

export function parseServiceAccount(json) {
  if (!json || typeof json !== 'object' || json.type !== 'service_account') throw new Error('FCM service account: not a service_account key file')
  const { client_email: clientEmail, private_key: privateKeyPem, private_key_id: privateKeyId, project_id: projectId, token_uri: tokenUri } = json
  if (typeof clientEmail !== 'string' || !clientEmail) throw new Error('FCM service account: missing client_email')
  if (typeof privateKeyPem !== 'string' || !privateKeyPem) throw new Error('FCM service account: missing private_key')
  let privateKey
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem)
  } catch {
    throw new Error('FCM service account: private_key is not a PEM key')
  }
  if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('FCM service account: private_key must be RSA')
  return {
    clientEmail,
    privateKey,
    privateKeyId: typeof privateKeyId === 'string' ? privateKeyId : null,
    projectId: typeof projectId === 'string' ? projectId : null,
    tokenUri: typeof tokenUri === 'string' && tokenUri ? tokenUri : DEFAULT_TOKEN_URI,
  }
}

// The signed assertion the token endpoint exchanges for an access token
// (RFC 7523, the JWT bearer grant).
export function serviceAccountAssertion(account, nowMs) {
  const iat = Math.floor(nowMs / 1000)
  const header = { alg: 'RS256', typ: 'JWT', ...(account.privateKeyId ? { kid: account.privateKeyId } : {}) }
  const claims = { iss: account.clientEmail, scope: SCOPE, aud: account.tokenUri, iat, exp: iat + 3600 }
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const signature = crypto.sign('sha256', Buffer.from(input), account.privateKey)
  return `${input}.${base64url(signature)}`
}

// The reason an FCM error response gives: the FcmError detail's errorCode
// (UNREGISTERED, SENDER_ID_MISMATCH, QUOTA_EXCEEDED, …), else the
// google.rpc status (NOT_FOUND, INVALID_ARGUMENT, …). Null when the body
// says neither.
export function fcmErrorReason(body) {
  const error = body && typeof body === 'object' ? body.error : null
  if (!error || typeof error !== 'object') return null
  const details = Array.isArray(error.details) ? error.details : []
  for (const d of details) {
    if (d && typeof d.errorCode === 'string' && d.errorCode) return d.errorCode
  }
  return typeof error.status === 'string' && error.status ? error.status : null
}

export function makeFcmClient({
  serviceAccount, projectId, fetchImpl = fetch, apiBase = DEFAULT_API_BASE,
  now = Date.now, requestTimeoutMs = 30000, authRetryMs = AUTH_RETRY_MS,
}) {
  const project = projectId || serviceAccount.projectId
  if (!project) throw new Error('FCM: no project id (set MATRON_FCM_PROJECT_ID or use a key file with project_id)')
  const sendUrl = new URL(`/v1/projects/${encodeURIComponent(project)}/messages:send`, apiBase).toString()

  let cached = null // {token, expiresAt}
  let minting = null // the in-flight mint every concurrent send shares
  let authFailedUntil = 0
  let closed = false

  async function post(url, init) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    timer.unref?.()
    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal })
      // Reading the body can fail on its own (a connection that breaks after
      // the headers): that is a transport failure, caught below. Only a body
      // that arrived whole but is not JSON is tolerated.
      const text = await res.text()
      let body = null
      try { body = JSON.parse(text) } catch { /* non-JSON body */ }
      return { status: res.status, body }
    } catch (err) {
      return { status: 0, body: null, reason: err?.name === 'AbortError' ? 'timeout' : 'transport' }
    } finally {
      clearTimeout(timer)
    }
  }

  // Resolves {token} or {token: null, reason}: 'auth' when the endpoint
  // refused the key (and sends back off), 'transport' or 'timeout' when it
  // could not be reached (and the send's one retry applies).
  async function mint() {
    const r = await post(serviceAccount.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: serviceAccountAssertion(serviceAccount, now()),
      }).toString(),
    })
    const token = r.body?.access_token
    if (r.status !== 200 || typeof token !== 'string' || !token) {
      // A transport failure is the network's, not the key's: no back-off.
      if (r.status !== 0) authFailedUntil = now() + authRetryMs
      const why = r.status === 0 ? r.reason : `status=${r.status}${typeof r.body?.error === 'string' ? ' ' + r.body.error : ''}`
      console.error(`fcm: could not get an access token (${why})`)
      return { token: null, reason: r.status === 0 ? r.reason : 'auth' }
    }
    const lifetimeMs = (Number(r.body.expires_in) > 0 ? Number(r.body.expires_in) : 3600) * 1000
    cached = { token, expiresAt: now() + lifetimeMs - TOKEN_REFRESH_MARGIN_MS }
    return { token }
  }

  // The cached access token, or a fresh one: {token} or {token: null, reason}.
  async function accessToken() {
    if (cached && now() < cached.expiresAt) return { token: cached.token }
    if (now() < authFailedUntil) return { token: null, reason: 'auth' }
    minting ??= mint().finally(() => { minting = null })
    return minting
  }

  // One attempt. `used` is the access token it went with, for send() alone.
  async function sendOnce(message) {
    const { token, reason } = await accessToken()
    if (!token) return { status: 0, reason }
    const r = await post(sendUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ message }),
    })
    if (r.status === 0) return { status: 0, reason: r.reason, used: token }
    if (r.status >= 200 && r.status < 300) return { status: r.status, reason: null, used: token }
    return { status: r.status, reason: fcmErrorReason(r.body), used: token }
  }

  // Resolves {status, reason}; never rejects.
  //
  // `data` is the message's data payload, every value a string (FCM's rule).
  // `priority` 'high' or 'normal'; `ttlSeconds` how long FCM keeps it for an
  // offline device; `collapseKey` optional.
  //
  // Retried once, as APNs is: after a transport failure (the request may
  // never have arrived), and after a 401 with a cached token (the token was
  // revoked or expired early), with a freshly minted one. Never more than
  // one retry.
  async function send({ token, data, priority = 'high', ttlSeconds, collapseKey }) {
    try {
      if (closed) return { status: 0, reason: 'closed' }
      const android = { priority: priority === 'high' ? 'HIGH' : 'NORMAL' }
      if (Number.isInteger(ttlSeconds) && ttlSeconds >= 0) android.ttl = `${ttlSeconds}s`
      if (collapseKey) android.collapse_key = collapseKey
      const message = { token, data, android }
      const strip = ({ status, reason }) => ({ status, reason })
      const result = await sendOnce(message)
      if (result.reason === 'transport') return strip(await sendOnce(message))
      if (result.status === 401) {
        // Only the token this request used: a newer one minted meanwhile stays.
        if (cached?.token === result.used) cached = null
        return strip(await sendOnce(message))
      }
      return strip(result)
    } catch (err) {
      console.error('fcm: send failed unexpectedly', err?.name || 'error')
      return { status: 0, reason: 'internal' }
    }
  }

  function close() { closed = true }

  return { send, close, projectId: project }
}

// The FCM configuration from the environment, or null when it is off.
// MATRON_FCM_SERVICE_ACCOUNT_FILE names the key file; MATRON_FCM_PROJECT_ID
// overrides the project id in it. A key file that is named but unusable
// fails startup.
export function fcmConfigFromEnv(env) {
  const kill = env.MATRON_FCM_DISABLED
  if (kill === '1' || kill === 'true') return null
  if (kill !== undefined && kill !== '' && kill !== '0' && kill !== 'false') throw new Error('MATRON_FCM_DISABLED must be 1, true, 0 or false')
  const file = env.MATRON_FCM_SERVICE_ACCOUNT_FILE
  if (!file) {
    if (env.MATRON_FCM_PROJECT_ID) throw new Error('MATRON_FCM_PROJECT_ID is set but MATRON_FCM_SERVICE_ACCOUNT_FILE is not')
    return null
  }
  return { serviceAccount: readServiceAccount(file), projectId: env.MATRON_FCM_PROJECT_ID || undefined }
}
