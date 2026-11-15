// Panic lock: the lock itself (POST /panic) and the routes
// and its signed clear (POST /panic/unlock) (docs/protocol.md "Panic lock"). Apart from src/panic.js, the state and
// its checks, because locking finishes the account's approved work through
// modules that themselves check the lock.
import { sharedTokenMatches, signOutOwnedDevice, rotateClientToken } from './auth.js'
import { requestSourceIp, deviceTarget } from './security-log.js'
import { getConsentEnabled, setConsentEnabled, getTransferConsentEnabled, setTransferConsentEnabled } from './consent.js'
import { readBody } from './http-body.js'
import { sanitizeConsentText } from './peer-text.js'
import { refuseLockedInvites } from './invite-delivery.js'
import { failApprovedSpawns } from './spawns.js'
import { declineApprovedTransfers } from './transfer-consent.js'
import { guardedAccountAction, refuse, activeKeysOfDevice } from './approval-keys.js'
import { parseStatement } from './approvals.js'
import {
  PANIC_TEXT_MAX, ACCOUNT_LOCKED, PANIC_OFF_FRAME, panicLock, isPanicLocked, panicOnFrame, panicAnnounced, sendToAgents,
  closeDeviceSockets, closeFrozenSockets, isFrozenDevice, keyUnlocks, clearPanic,
} from './panic.js'

// The watcher's text as stored: control characters (C0 and, here only, C1),
// bidi and other format characters stripped and whitespace collapsed by
// the peer-text sieve, then at most PANIC_TEXT_MAX characters (whole code
// points); null when nothing is left. The shared sieve is left as it is: it
// mirrors the bridge's copy.
const clip = (s) => {
  if (s == null) return null
  const clean = Array.from(sanitizeConsentText(String(s).replace(/[\u0080-\u009f]/g, ' '), Infinity)).slice(0, PANIC_TEXT_MAX).join('').trim()
  return clean || null
}

// Lock the account (POST /panic): the state changes in one transaction,
// then the frames and the security events. Idempotent: a call while locked
// keeps the lock as it is, signs out any client device that has appeared
// since, turns a switch that was turned back on off again, and sends the
// frame again. A client device with an approval key attached that was
// enrolled at least a day before the lock is frozen, not signed out
// (src/panic.js isFrozenDevice): it can clear the lock with a signed
// statement (handlePanicUnlock below).
// → {alreadyLocked, devicesRevoked, devicesFrozen, bridgesNotified}.
export function lockAccount({ db, hub, securityLog, signInTickets = null, mediaDir = null, pairs = null, links = null }, userId, { source = null, alert = null, now = Date.now() } = {}) {
  let alreadyLocked = false
  let revoked = []
  let frozen = []
  const switched = []
  db.transaction(() => {
    alreadyLocked = isPanicLocked(db, userId)
    if (!alreadyLocked) {
      db.prepare(`INSERT INTO panic_locks(user_id, since, source, alert, cleared_at) VALUES(?,?,?,?,NULL)
        ON CONFLICT(user_id) DO UPDATE SET since=excluded.since, source=excluded.source, alert=excluded.alert, cleared_at=NULL`)
        .run(userId, now, source, alert)
    }
    // Every client device, signed out as a device signing itself out is:
    // its approval keys stay enrolled, detached, for the owner to re-attach
    // after signing in again once the lock is cleared. Agent devices stay,
    // and so does a client device that holds an approval key old enough
    // to count under this lock: frozen.
    const held = panicLock(db, userId)
    const clients = db.prepare("SELECT id FROM devices WHERE user_id=? AND kind='client' ORDER BY id").all(userId).map((r) => r.id)
    frozen = clients.filter((id) => isFrozenDevice(db, userId, id, held))
    revoked = clients.filter((id) => !frozen.includes(id) && signOutOwnedDevice(db, userId, id))
    // Both Coordinator switches off; nothing is remembered, so they stay
    // off after a clear until the owner turns them on again.
    if (getConsentEnabled(db, userId)) { setConsentEnabled(db, userId, false, now); switched.push('spawns') }
    if (getTransferConsentEnabled(db, userId)) { setTransferConsentEnabled(db, userId, false, now); switched.push('transfers') }
  })()
  // Committed: a two-factor sign-in started before the lock cannot finish
  // after it is cleared either.
  signInTickets?.dropUser?.(userId)
  const lock = panicLock(db, userId)
  closeDeviceSockets(hub, userId, revoked, lock)
  if (lock) closeFrozenSockets(hub, userId, frozen, lock)
  // Nothing approved before the lock takes effect, now or after the clear
  // (the asker can ask again): approved invites not delivered are refused,
  // approved spawns not started fail, approved transfers not released are
  // declined. Each pump that meets a locked owner later does the same.
  // Pairs and links approved (or pre-approved) before the lock are dropped
  // too: a box or a claimant that holds back until after the clear gets no
  // device.
  for (const [what, step] of [
    ['pairs', () => pairs?.dropApproved(userId)],
    ['links', () => links?.dropUser(userId)],
    ['invites', () => refuseLockedInvites({ db, hub }, userId)],
    ['spawns', () => failApprovedSpawns(db, hub, userId, ACCOUNT_LOCKED)],
    ['transfers', () => declineApprovedTransfers({ db, hub, mediaDir }, userId)],
  ]) {
    try { step() } catch (err) { console.error(`panic: finishing approved ${what} failed`, err) }
  }
  const bridgesNotified = lock ? sendToAgents(hub, userId, panicOnFrame(lock)) : 0
  if (lock) panicAnnounced(hub).add(userId)
  // `source` is caller text: into the line only as the target, JSON
  // encoded with the rest; `alert` never goes into a line.
  if (!alreadyLocked) securityLog.record(userId, 'panic_locked', { deviceId: null, target: clip(source), decidedBy: 'journal' })
  for (const id of revoked) securityLog.record(userId, 'device_revoked', { deviceId: null, target: deviceTarget(id), decidedBy: 'journal' })
  for (const which of switched) securityLog.record(userId, 'consent_switch_changed', { deviceId: null, target: which, decidedBy: 'journal' })
  return { alreadyLocked, devicesRevoked: revoked.length, devicesFrozen: frozen.length, bridgesNotified }
}

// POST /panic and GET /panic with the panic token, ahead of device
// authentication (src/http.js), resolved as the security feed is
// (src/security-log.js): off → 404 as any unknown path; a wrong or missing
// token → 401, charged to the per-address budget /login shares, and 429
// once that is spent; compared in constant time. Unlike the feed, the right
// token is checked first and is never refused for the budget, so bad
// guesses from an address cannot keep its watcher from locking. The token is bound to one account and does
// nothing but lock it and read whether it is locked. → true when it answered.
export async function handlePanic({ db, hub, panic, json, rateLimiter = null, securityLog, signInTickets = null, mediaDir = null, pairs = null, links = null }, req, res, url, { rejectEarly }) {
  if (url.pathname !== '/panic' || (req.method !== 'GET' && req.method !== 'POST')) return false
  if (!panic) { rejectEarly(req, res, 404, { error: 'not_found' }); return true }
  // The token first, so the right one is never starved: only a failure is
  // charged to the address's budget, and only failures meet its 429.
  const given = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1]
  if (!given || !sharedTokenMatches(panic.token, given)) {
    const ip = requestSourceIp(req) || 'unknown'
    if (rateLimiter?.blocked?.(ip)) { rejectEarly(req, res, 429, { error: 'rate_limited' }); return true }
    rateLimiter?.allow(ip)
    rejectEarly(req, res, 401, { error: 'unauthenticated' })
    return true
  }
  const user = db.prepare('SELECT id FROM users WHERE name=?').get(panic.account)
  if (!user) { rejectEarly(req, res, 404, { error: 'not_found' }); return true }
  if (req.method === 'GET') {
    const lock = panicLock(db, user.id)
    json(res, 200, { locked: !!lock, since: lock?.since ?? null, source: lock?.source ?? null, alert: lock?.alert ?? null })
    return true
  }
  // readBody's 400 (not JSON, not an object) and 413 go to http.js's catch.
  const body = await readBody(req)
  const text = (v) => v === undefined || v === null || typeof v === 'string'
  if (!text(body.source) || !text(body.alert)) { json(res, 400, { error: 'bad_request' }); return true }
  const r = lockAccount({ db, hub, securityLog, signInTickets, mediaDir, pairs, links }, user.id, { source: clip(body.source), alert: clip(body.alert) })
  json(res, 200, { ok: true, locked: true, already_locked: r.alreadyLocked, devices_revoked: r.devicesRevoked, devices_frozen: r.devicesFrozen, bridges_notified: r.bridgesNotified })
  return true
}

// POST /panic/unlock (a device token, client devices only; there whether
// or not the panic token is configured): a frozen device clears the lock
// with an account statement over {op:'clear_panic', since:<the lock's
// since>} signed by an approval key attached to it that counts under the
// lock (enrolled a day before it, src/panic.js). A signature by such a key
// is always needed: a body with no approval, a device that is not frozen,
// or a statement signed by a younger key on the same device, is 403
// approval_required, whatever keys the account has. The clear, the
// sign-out of every other client device of the account (their approval
// keys detached, not revoked) and a new token for the calling device are
// one transaction with the check, so every client token that existed at
// the lock is dead; then the sockets close as a revoked device's do and
// the account's bridges get the clear frame at once. The consent switches
// stay off.
// → true when it answered.
export async function handlePanicUnlock({ db, hub, json, securityLog, journalHost = null }, req, res, url, who) {
  if (url.pathname !== '/panic/unlock' || req.method !== 'POST') return false
  if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }
  const body = await readBody(req)
  const lock = panicLock(db, who.userId)
  if (!lock) { json(res, 409, { error: 'not_locked' }); return true }
  const r = guardedAccountAction({ db, journalHost }, who, body, { op: 'clear_panic', since: String(lock.since) }, {
    check: () => {
      // The lock the statement names, still there.
      if (panicLock(db, who.userId)?.since !== lock.since) refuse(409, { error: 'not_locked' })
      // Never unsigned: the guard alone lets an account with no key through.
      if (body.approval == null || !isFrozenDevice(db, who.userId, who.deviceId, lock)) refuse(403, { error: 'approval_required' })
      // Nor signed by a key on this device that does not count under the
      // lock, beside one that does. Any other key the statement names (not
      // this device's, revoked, unknown) is the guard's to refuse.
      const signer = typeof body.approval?.statement === 'string' ? parseStatement(body.approval.statement)?.key_id : null
      const signing = signer ? activeKeysOfDevice(db, who.userId, who.deviceId).find((k) => k.key_id === signer) : null
      if (signing && !keyUnlocks(signing, lock)) refuse(403, { error: 'approval_required' })
    },
    write: () => {
      if (!clearPanic(db, who.userId)) refuse(409, { error: 'not_locked' })
      const revoked = db.prepare("SELECT id FROM devices WHERE user_id=? AND kind='client' AND id<>? ORDER BY id").all(who.userId, who.deviceId)
        .map((d) => d.id).filter((id) => signOutOwnedDevice(db, who.userId, id))
      // The token this device had at the lock dies with the others'.
      const token = rotateClientToken(db, who.userId, who.deviceId)
      if (!token) refuse(401, { error: 'unauthenticated' })
      return { revoked, token }
    },
  })
  if (!r.ok) { json(res, r.status, r.body); return true }
  const { revoked, token } = r.value
  // The calling device's too: opened with the token it no longer has.
  closeDeviceSockets(hub, who.userId, [...revoked, who.deviceId], null)
  // The bridges now, not at the next sweep, which then has nothing to send.
  panicAnnounced(hub).delete(who.userId)
  sendToAgents(hub, who.userId, PANIC_OFF_FRAME)
  securityLog.record(who.userId, 'panic_cleared', { deviceId: who.deviceId, deviceName: who.name, decidedBy: 'user' })
  for (const id of revoked) securityLog.record(who.userId, 'device_revoked', { deviceId: null, target: deviceTarget(id), decidedBy: 'journal' })
  json(res, 200, { ok: true, locked: false, devices_revoked: revoked.length, token })
  return true
}
