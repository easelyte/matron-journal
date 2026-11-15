// Panic lock (docs/protocol.md "Panic lock"): an external watcher holding a
// panic token bound to one account locks that account with one request.
// The journal signs out every client device of the account (but one that
// holds an approval key, which is frozen instead), turns the
// Coordinator's consent switches off, refuses new sign-ins and device links
// for it, refuses to deliver new work to its boxes, and tells every bridge
// of the account to lock. The token can only lock (and read whether the
// account is locked); the lock is cleared on the journal host
// (`matron-admin panic clear <user>`), or by a frozen device with a
// statement signed by its approval key (POST /panic/unlock).
//
// This module is the state and its checks, imported by every path that
// refuses while locked; the lock itself and the routes are in
// src/panic-lock.js, which the HTTP handler alone imports.
//
// The state is one row per account in `panic_locks`; locked means a row
// with `cleared_at` NULL. Every check reads the database (a primary-key
// lookup), never memory, so the CLI's clear takes effect at once for the
// refusals and a journal restart cannot forget a lock.
import { signOutOwnedDevice, tokenReplaced } from './auth.js'
import { activeKeysOfDevice } from './approval-keys.js'
import { FEED_TOKEN_RE, deviceTarget } from './security-log.js'

export const PANIC_TEXT_MAX = 200
// The same rule as the security feed's token.
export const PANIC_TOKEN_RE = FEED_TOKEN_RE
// The reason every refusal while locked carries.
export const ACCOUNT_LOCKED = 'account_locked'

// The account's open lock, {since, source, alert}, or null.
export function panicLock(db, userId) {
  if (userId == null) return null
  return db.prepare('SELECT since, source, alert FROM panic_locks WHERE user_id=? AND cleared_at IS NULL').get(userId) ?? null
}
export const isPanicLocked = (db, userId) => !!panicLock(db, userId)

// Which approval keys count under a lock: one enrolled (its enrolment, not
// when it was last attached to a device) at least this long before the
// lock began. A key added shortly before a lock may be the intruder's own,
// so it neither keeps its device signed in nor clears the lock.
export const PANIC_UNLOCK_KEY_AGE_MS = 24 * 60 * 60000
export const keyUnlocks = (key, lock) => !!lock && key.revoked_at == null && key.created_at <= lock.since - PANIC_UNLOCK_KEY_AGE_MS
// The device's attached, active keys that count under `lock`.
export const unlockKeysOfDevice = (db, userId, deviceId, lock) => (deviceId == null || !lock ? []
  : activeKeysOfDevice(db, userId, deviceId).filter((k) => keyUnlocks(k, lock)))

// A frozen device: a client device with such a key attached to it. The
// lock does not sign it out; every route and frame refuses it with
// `unlock: true` but the two it needs to clear the lock with a statement
// signed by that key (POST /approvals/nonce, POST /panic/unlock). Read at
// every check, against the lock: a device whose key has gone since is
// signed out as any other.
export const isFrozenDevice = (db, userId, deviceId, lock) => unlockKeysOfDevice(db, userId, deviceId, lock).length > 0

// Whether a lock of the account ended after `at` (ms): it was open at some
// moment since then, whether it began before `at` or after, and is cleared
// now. Whatever a client authenticated at `at` used a token that existed
// at that lock, and no such token outlives it. (After, not at or after: a
// request made with the new token in the millisecond of the clear is not
// refused; one made in that millisecond with an old token finds its device
// gone or its token replaced, below.)
export const lockEndedSince = (db, userId, at) =>
  !!db.prepare('SELECT 1 FROM panic_locks WHERE user_id=? AND cleared_at IS NOT NULL AND cleared_at>?').get(userId, at)

// A client request or socket authenticated at `at` with `token` that must
// not act any more: the device's token has been replaced since (an unlock
// gave it a new one), or a lock of the account has ended since. A device
// that is gone is not this check's: the caller's own does that.
export const clientAuthDead = (db, { userId, deviceId, token, at }) => tokenReplaced(db, deviceId, token) || lockEndedSince(db, userId, at)

// Every account_locked refusal's body (HTTP 423, and the error frames):
// the reason and since when; `unlock: true` to a frozen device.
export const lockedBody = (lock, frozen = false) => ({ error: ACCOUNT_LOCKED, since: lock?.since ?? null, ...(frozen ? { unlock: true } : {}) })
// The control error a client socket of a locked account gets (`extra`: the
// refused frame's ref and request_id).
export const lockedError = (lock, frozen = false, extra = {}) => ({ kind: 'control', op: 'error', code: ACCOUNT_LOCKED, ...extra, since: lock.since, ...(frozen ? { unlock: true } : {}) })

// The refusal of an approval (a consent answer) while locked, in the
// shape the answer paths give a user-only refusal: {ok:false, status,
// body}; null when the account is not locked.
export function lockedApprovalRefusal(db, userId) {
  const lock = panicLock(db, userId)
  return lock ? { ok: false, status: 403, body: { error: 'forbidden', detail: ACCOUNT_LOCKED, since: lock.since } } : null
}

// The frames to the account's bridges, and hello_ok's key.
export const panicOnFrame = (lock) => ({ kind: 'panic', on: true, since: lock.since, source: lock.source ?? null })
export const PANIC_OFF_FRAME = Object.freeze({ kind: 'panic', on: false })
// Spread into hello_ok for an agent: {panic: {...}} while locked, nothing
// otherwise (a bridge reads a missing key as "not locked").
export function panicHelloField(lock) {
  return lock ? { panic: { on: true, since: lock.since, source: lock.source ?? null } } : {}
}

// Which accounts this journal process has told its bridges are locked (the
// POST, or an agent's hello while locked). The periodic sweep (src/ws.js)
// sends the clear frame to an account on this list whose lock is gone, then
// drops it. One per hub, so one per server. After a restart the list is
// empty: a bridge reconnecting after a clear gets no key, which is the clear.
const announcedByHub = new WeakMap()
export function panicAnnounced(hub) {
  let s = announcedByHub.get(hub)
  if (!s) { s = new Set(); announcedByHub.set(hub, s) }
  return s
}

// Whether a socket has been told the account is locked (the frame, or
// hello_ok's key), so the clear goes to each such socket once and to no
// other. Kept on the connection.
export const markPanicTold = (conn, on) => { conn.panicTold = on }

// Send `frame` to every open socket of the account's agent devices (for
// the clear, only those told it was locked). → how many it went to.
export function sendToAgents(hub, userId, frame) {
  let n = 0
  const text = JSON.stringify(frame)
  for (const c of hub.connsOf(userId)) {
    if (c.kind !== 'agent' || c.ws.readyState !== 1) continue
    if (!frame.on && !c.panicTold) continue
    try { c.ws.send(text); n += 1; markPanicTold(c, frame.on) } catch { /* a socket closing under us */ }
  }
  return n
}

// What a client socket of a locked account is told just before it closes.
export const clientPanicFrame = (lock) => ({ kind: 'panic', on: true, since: lock.since })

// Close a signed-out client device's open sockets the way a revoked
// device's are (src/ws.js's revocation sweep: the `revoked` error frame,
// then 4001), each told first that the account is locked.
export function closeDeviceSockets(hub, userId, deviceIds, lock) {
  const ids = new Set(deviceIds)
  for (const c of hub.connsOf(userId)) {
    if (!ids.has(c.deviceId) || c.ws.readyState !== 1) continue
    closeLockedSocket(c.ws, lock)
  }
}
export function closeLockedSocket(ws, lock) {
  try {
    if (lock) ws.send(JSON.stringify(clientPanicFrame(lock)))
    ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'revoked' }))
    ws.close(4001)
  } catch { /* already closing */ }
}

// A frozen device's sockets at the lock: told the account is locked and
// that it can unlock it, then an ordinary close. The device stays.
export function closeFrozenSocket(ws, lock) {
  try {
    ws.send(JSON.stringify({ ...clientPanicFrame(lock), unlock: true }))
    ws.send(JSON.stringify(lockedError(lock, true)))
    ws.close()
  } catch { /* already closing */ }
}
export function closeFrozenSockets(hub, userId, deviceIds, lock) {
  const ids = new Set(deviceIds)
  for (const c of hub.connsOf(userId)) {
    if (c.kind === 'client' && ids.has(c.deviceId) && c.ws.readyState === 1) closeFrozenSocket(c.ws, lock)
  }
}

// A client device of a locked account met at a check (a request, a hello,
// a frame): frozen → true, and it is left as it is; otherwise it is signed
// out (below) → false.
export function refuseLockedClient(ctx, userId, deviceId, lock) {
  if (isFrozenDevice(ctx.db, userId, deviceId, lock)) return true
  signOutLockedClient(ctx, userId, deviceId, lock)
  return false
}

// Sign out one client device of a locked account that still had a working
// token (a race, or a device made by a path the lock missed): the row goes
// as a self sign-out's does (approval keys detached, not revoked), its
// other open sockets close as above, and the security log has it.
export function signOutLockedClient({ db, hub, securityLog }, userId, deviceId, lock) {
  if (!signOutOwnedDevice(db, userId, deviceId)) return false
  if (hub) closeDeviceSockets(hub, userId, [deviceId], lock)
  securityLog?.record(userId, 'device_revoked', { deviceId: null, target: deviceTarget(deviceId), decidedBy: 'journal' })
  return true
}

// Clear the account's lock (matron-admin panic clear, POST /panic/unlock).
// Nothing else is restored. → true when there was a lock to clear.
export function clearPanic(db, userId, now = Date.now()) {
  return db.prepare('UPDATE panic_locks SET cleared_at=? WHERE user_id=? AND cleared_at IS NULL').run(now, userId).changes > 0
}

// The periodic check (src/ws.js's sweep): for each account this process
// told it was locked whose lock is gone now, the clear frame to each of its
// connected bridge sockets that was told it was locked, once.
export function announcePanicClears(db, hub) {
  const announced = panicAnnounced(hub)
  for (const userId of [...announced]) {
    if (isPanicLocked(db, userId)) continue
    announced.delete(userId)
    sendToAgents(hub, userId, PANIC_OFF_FRAME)
  }
}

// MATRON_PANIC_TOKEN / MATRON_PANIC_ACCOUNT: both set and the token well
// formed, or the routes are off (and a malformed token or a missing half
// says so once, never printing the token). → {token, account} or null.
export function resolvePanic({ token, account } = {}, { warn = console.warn } = {}) {
  if (!token && !account) return null
  if (!token || !account) {
    warn('panic: MATRON_PANIC_TOKEN and MATRON_PANIC_ACCOUNT must both be set; /panic is off')
    return null
  }
  if (!PANIC_TOKEN_RE.test(token)) {
    warn('panic: MATRON_PANIC_TOKEN must be 32 to 128 characters of A-Z a-z 0-9 _ -; /panic is off')
    return null
  }
  return { token, account }
}
