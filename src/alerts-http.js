// Prometheus Alertmanager webhook -> a turn in the user's Coordinator
// session (the agent session that looks after all their dev boxes), so a
// disk alert reaches the one agent able to act on it without the user
// forwarding an email.
//
//   POST /alerts/alertmanager   Authorization: Bearer <MATRON_ALERT_WEBHOOK_TOKEN>
//
// Mounted in http.js AHEAD of the device Bearer auth: Alertmanager holds a
// shared secret, not a device token. Configuration (server.js):
//   MATRON_ALERT_WEBHOOK_TOKEN  the shared secret; unset or < 32 chars = off
//   MATRON_ALERT_WEBHOOK_USER   username whose Coordinator gets the alerts;
//                               unset or unknown = off
// Off means the handler declines the request and it falls through to the
// rest of the chain, so the path is indistinguishable from any unknown one.
//
// Delivery is the journal-originated `session_control` RPC the Coordinator's
// own session_control op uses (src/ws.js), with action 'alert' and
// from_name 'Alertmanager', to the Coordinator's OWN box:
//   {convo_id: <Coordinator convo>, action: 'alert', message, from_name: 'Alertmanager'}
// 'alert' is deliberately NOT in SESSION_CONTROL_ACTIONS: only this route
// can build it, so no agent can forge an alert through its session_control op.
//
// Responses (enabled): 401 for a missing or wrong token, 429 once an IP has
// spent the shared unauthenticated budget (http.js's /login limiter) on
// wrong tokens; 400
// for a body that is not JSON or not an Alertmanager v4 payload; 413 over
// 256 KiB; otherwise always 202 — Alertmanager retries only on 5xx, and a
// user with no Coordinator, or a journal already busy delivering, is not
// something a retry storm fixes. The 202 body says which:
// {accepted:true}, {delivered:false, reason:'no_coordinator'|'busy'}.
// The outcome of an accepted delivery is logged (one line), never returned.
import crypto from 'node:crypto'
import { json, readBody } from './http-body.js'
import { coordinatorDevice } from './consent.js'
import { wakeIfOffline } from './wake.js'
import { sanitizePeerText } from './peer-text.js'
import { isAlertmanagerPayload, formatAlertMessage, alertName } from './alerts.js'

export const ALERT_PATH = '/alerts/alertmanager'
export const ALERT_TOKEN_MIN = 32
export const ALERT_BODY_MAX = 256 * 1024
export const ALERT_MAX_INFLIGHT = 4
export const ALERT_FROM_NAME = 'Alertmanager'

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest()

// Both sides hashed first: equal-length buffers for timingSafeEqual, and no
// early return that would leak the configured token's length.
export function alertTokenMatches(expected, given) {
  return crypto.timingSafeEqual(digest(expected), digest(given ?? ''))
}

// The route is on only with a long-enough token AND a username; the user
// row itself is looked up per request (a user created after boot works, a
// deleted one turns the route off).
export function alertWebhookEnabled({ token, username }) {
  return typeof token === 'string' && token.length >= ALERT_TOKEN_MIN && typeof username === 'string' && !!username
}

// Boot-time sanity line (server.js): a token with no usable user is almost
// certainly a half-finished deploy, and the route answering 404 would
// otherwise be silent about why. Never logs the token.
export function warnAlertWebhookConfig(db, { token, username }) {
  if (!token) return
  if (token.length < ALERT_TOKEN_MIN) {
    console.warn(`alerts: MATRON_ALERT_WEBHOOK_TOKEN is shorter than ${ALERT_TOKEN_MIN} chars; ${ALERT_PATH} is disabled`)
    return
  }
  if (!username) { console.warn(`alerts: MATRON_ALERT_WEBHOOK_USER is unset; ${ALERT_PATH} is disabled`); return }
  if (!db.prepare('SELECT 1 FROM users WHERE name=?').get(username)) {
    console.warn(`alerts: MATRON_ALERT_WEBHOOK_USER ${JSON.stringify(username)} is not a user; ${ALERT_PATH} is disabled until it exists`)
  }
}

// One handler per journal process (built once in makeHttpHandler), so the
// in-flight bound below is process-wide. Each delivery can park a wake
// waiter (minutes) and a broker entry; four is ample for Alertmanager's
// grouped, rate-limited sends and caps what a token holder can pile up.
export function makeAlertsHandler({ db, hub, broker, waker = null, rateLimiter = null, token = null, username = null, wakeWaitMs = 0, timeoutMs = 30000 }) {
  let inflight = 0
  const enabled = alertWebhookEnabled({ token, username })
  const handler = async (req, res, url, { rejectEarly }) => {
    if (url.pathname !== ALERT_PATH || req.method !== 'POST' || !enabled) return false
    const user = db.prepare('SELECT id FROM users WHERE name=?').get(username)
    if (!user) return false
    // Behind the cloudflared tunnel, cf-connecting-ip is the caller (same
    // rule as /login). Only a wrong token is charged to the shared budget —
    // Alertmanager's own sends never spend the /login allowance of its IP —
    // but once the budget is spent every request is refused, the right
    // token included, so the 429s give a guesser nothing to tell apart.
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'
    if (rateLimiter?.blocked?.(ip)) { rejectEarly(req, res, 429, { error: 'rate_limited' }); return true }
    const given = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1]
    if (!given || !alertTokenMatches(token, given)) {
      rateLimiter?.allow(ip)
      rejectEarly(req, res, 401, { error: 'unauthenticated' })
      return true
    }
    // readBody's 400 (not JSON / not an object) and 413 (over the cap)
    // propagate to http.js's outer catch like every other route's.
    const body = await readBody(req, { maxBytes: ALERT_BODY_MAX })
    if (!isAlertmanagerPayload(body)) { json(res, 400, { error: 'bad_request' }); return true }
    const coord = coordinatorDevice(db, user.id)
    const label = `${sanitizePeerText(body.status, 10) || '?'} ${alertName(body)} (${body.alerts.length})`
    if (!coord) {
      console.log(`alerts: ${label} not delivered: no Coordinator (or it has no box) for ${username}`)
      json(res, 202, { delivered: false, reason: 'no_coordinator' })
      return true
    }
    if (inflight >= ALERT_MAX_INFLIGHT) {
      console.log(`alerts: ${label} not delivered: ${ALERT_MAX_INFLIGHT} deliveries already in flight`)
      json(res, 202, { delivered: false, reason: 'busy' })
      return true
    }
    const params = { convo_id: coord.convoId, action: 'alert', message: formatAlertMessage(body), from_name: ALERT_FROM_NAME }
    inflight += 1
    json(res, 202, { accepted: true })
    // Off the request cycle, like the session_control op: wake the box if it
    // is asleep and wait for it to attach (the spawn path's window), then
    // issue. The broker's own timeout means this always settles.
    void (async () => {
      let outcome
      try {
        const waking = wakeIfOffline({ db, hub, waker }, user.id, coord.deviceId)
        if (waking && wakeWaitMs > 0) await hub.waitForDevice(user.id, coord.deviceId, wakeWaitMs)
        const r = await broker.issue(hub, user.id, coord.deviceId, 'session_control', params, { timeoutMs })
        // The reply is the bridge's text: sieved before it reaches the log.
        outcome = r.ok ? `applied ${sanitizePeerText(r.result?.applied, 20) || '?'}` : `failed ${sanitizePeerText(r.error?.code, 40) || 'unknown'}`
        if (waking) outcome += ' (after wake)'
      } catch (err) {
        outcome = `failed internal (${err?.message || err})`
      } finally {
        inflight -= 1
      }
      console.log(`alerts: ${label} -> Coordinator ${coord.convoId} on device ${coord.deviceId}: ${outcome}`)
    })()
    return true
  }
  handler.inflight = () => inflight
  return handler
}
