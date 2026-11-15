// Approval-key routes (src/approval-keys.js, src/approvals.js).
//
// Any token (a box may read the public keys, but verifies against the keys
// pinned on it, never these):
//   GET  /approval-keys                        → {enabled, journal, keys, requests}
//
// Bearer, client devices only:
//   POST /approvals/nonce                      → {nonce, expires_at}
//   POST /approval-keys {public_key, name, password, code}
//        The bootstrap, and the fallback when no enrolled device is left:
//        password and a TOTP code (never a recovery code) enrol the
//        calling device's key. 409 key_exists only once both have passed.
//   POST /approval-keys/requests {public_key, name}            → {id}
//   POST /approval-keys/requests/:id/approve {approval}
//        An enrolled device signs {op:'enrol_key', key_id} for a new
//        device's key.
//   POST /approval-keys/:key_id/revoke {approval} | {password, code}
//        Signed {op:'revoke_key', key_id}, or password and TOTP.
//   POST /approval-keys/attach {approval}
//        After a new sign-in: the key signs {op:'attach_key', key_id} for
//        itself and moves to the calling device, with a notice.
//
// Three wrong passwords or codes within an hour on any password route (the
// two here and POST /devices/:id/revoke, http.js) lock all three for the
// account: 429 {error:'enrolment_locked', retry_at} (ms),
// before the password is checked, for 1 h, then 6 h, then 24 h.
//
// Everything but the revoke needs the journal's public URL (`enabled`);
// a revoke by password works without it, so an account is never stuck
// with keys it cannot use.
import crypto from 'node:crypto'
import { json, readBody, recheckCaller } from './http-body.js'
import { keyIdOf, parseStatement } from './approvals.js'
import {
  ALG, KEY_REQUEST_TTL_MS, DEVICE_FAILURE_WINDOW_MS, ENROL_LOCK_MS, checkApproval, activeKeyFor, issueNonce,
  onSignedOutForFailures, enrolmentLockedUntil, recordEnrolmentFailure,
} from './approval-keys.js'
import { confirmIdentity } from './two-factor-http.js'
import { makeKeyedQueue } from './auth.js'
import { isTwoFactorEnabled, classifyCode } from './two-factor.js'
import { fileNotice } from './sharing-events.js'
import { sanitizePeerText, plainText } from './peer-text.js'
import { restampConsentItems } from './consent-subject.js'
import { securityLogOf, keyTarget } from './security-log.js'
import { emitMarker } from './items-http.js'
import { getItem } from './items.js'

// A key's name is a label in the apps, like a device name (http.js).
const KEY_NAME_MAX = 40

const keyView = (r) => ({
  key_id: r.key_id, public_key: r.public_key, alg: r.alg, name: r.name, device_id: r.device_id,
  enrolled_via: r.enrolled_via, created_at: r.created_at, revoked_at: r.revoked_at,
})

const keyRow = (db, keyId) => db.prepare('SELECT * FROM approval_keys WHERE key_id=?').get(keyId)

// Consent items restamped (src/consent-subject.js restampConsentItems: a
// box protected or renamed, the account's first key added or its last
// removed) reach the user's apps as an `updated` marker. `who` is the
// request's caller, or the user's own name when the journal or the host
// restamps (a client `who` with no device). From the host (matron-admin,
// whose hub is a stub) the marker is written but not sent live.
export function announceRestamped(ctx, who, ids) {
  for (const id of ids) {
    const item = getItem(ctx.db, who.userId, id)
    if (item) emitMarker(ctx, who, { item, action: 'updated', fallback: false })
  }
}
export const asUser = (userId) => ({ userId, kind: 'client', deviceId: null })

// A key added to or removed from the account: a notice in the user's For
// you list, pushed to every device. Once per key and direction.
export function announceKey(ctx, userId, key, { added, how }) {
  const verb = added ? 'added' : 'removed'
  const short = key.key_id.slice(0, 8)
  fileNotice(ctx, {
    userId,
    title: `Approval key ${verb}: ${key.name} ${short}`,
    body: `The approval key **${plainText(key.name)}** (fingerprint \`${short}\`) was ${verb} ${how}.`
      + (added ? ' It can now approve dangerous actions for your account. If this was not you, remove it and change your password.' : ''),
    idemKey: `approval-key:${verb}:${key.key_id}`,
    push: true,
  })
  // Whether the account has a key decides whether a consent item aimed at a
  // protected box says it needs a signature (src/consent-subject.js): its
  // first key added or its last removed changes that. Best-effort; the
  // answer path decides afresh either way.
  try {
    announceRestamped(ctx, asUser(userId), restampConsentItems(ctx.db, userId))
  } catch (err) {
    console.error('approval keys: restamping consent items failed', err)
  }
}

// A key moved to the calling device (POST /approval-keys/attach): a notice
// like the enrolment's, pushed, once per key and device.
function announceAttach(ctx, who, key) {
  const short = key.key_id.slice(0, 8)
  const device = ctx.db.prepare('SELECT name FROM devices WHERE id=?').get(who.deviceId)?.name ?? 'a device'
  fileNotice(ctx, {
    userId: who.userId,
    title: `Approval key attached: ${key.name} ${short}`,
    body: `The approval key **${plainText(key.name)}** (fingerprint \`${short}\`) was attached to **${plainText(device)}**, signed by the key itself.`
      + ' It now approves dangerous actions from that device. If this was not you, remove it and change your password.',
    idemKey: `approval-key:attached:${key.key_id}:${who.deviceId}`,
    push: true,
  })
}

const BY_PASSWORD = 'with your password and a two-factor code'

const shortTime = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
const minutes = (ms) => Math.round(ms / 60000)

// What each counted reason means, for the notice.
const REASON_WORDS = {
  signature: 'a signature that does not verify',
  bad_statement: 'a malformed statement',
  unknown_key: 'a key this account does not have',
  wrong_device: 'a key that belongs to another of your devices',
}

// Lockdown after failures (src/approval-keys.js recordApprovalFailure): once
// a device is signed out for invalid approvals, a notice naming it and what
// it sent, pushed to every device the user has left. Its keys were not
// removed: they stay enrolled, attached to no device, until the app signs in
// again and re-attaches them. Installed once per journal (server.js).
export function installApprovalLockdown(ctx) {
  onSignedOutForFailures(ctx.db, (userId, { device, keys, reasons }) => {
    const name = plainText(device.name)
    const what = [...new Set(reasons)].map((r) => REASON_WORDS[r] ?? r).join(' and ')
    const keyLine = keys.length
      ? ` Its approval key${keys.length > 1 ? 's' : ''} (${keys.map((k) => `\`${k.key_id.slice(0, 8)}\``).join(', ')}) ${keys.length > 1 ? 'stay' : 'stays'} enrolled but attached to no device: to use ${keys.length > 1 ? 'them' : 'it'} again, sign in on that device and re-attach ${keys.length > 1 ? 'them' : 'it'}. If you no longer trust the device, remove ${keys.length > 1 ? 'them' : 'it'} instead.`
      : ''
    fileNotice(ctx, {
      userId,
      title: `Signed out ${device.name}: invalid approval signatures`,
      body: `**${name}** sent ${reasons.length} invalid approvals within ${minutes(DEVICE_FAILURE_WINDOW_MS)} minutes (${what}), so it was signed out.${keyLine}`
        + ' A genuine app never sends these: if this was not you, change your password. Your other devices are not affected.',
      idemKey: `approval-lockdown:device:${device.id}:${Date.now()}`,
      push: true,
    })
  })
}

// The password-and-code path is locked for the account (three wrong
// passwords or codes within an hour): 429 with when it opens again, sent
// before anything is checked.
function enrolmentLocked(ctx, res, who, now) {
  const until = enrolmentLockedUntil(ctx.db, who.userId, now)
  if (until == null) return false
  res.setHeader('Retry-After', Math.max(1, Math.ceil((until - now) / 1000)))
  json(res, 429, { error: 'enrolment_locked', retry_at: until })
  return true
}

// A wrong password (401) or code (403) from confirmIdentity counts towards
// that lock; the third within the hour sets it, with a notice and a push.
function countEnrolmentFailure(ctx, res, who, now) {
  const outcome = res.statusCode === 401 ? 'bad_password' : res.statusCode === 403 ? 'bad_code' : null
  if (!outcome) return
  const lock = recordEnrolmentFailure(ctx.db, who, outcome, now)
  if (!lock) return
  const hours = ENROL_LOCK_MS[Math.min(lock.level, ENROL_LOCK_MS.length) - 1] / 3600000
  securityLogOf(ctx).record(who.userId, 'enrolment_locked', { deviceId: who.deviceId, deviceName: who.name, target: `${hours}h`, decidedBy: 'journal' }, { evenIfRolledBack: true })
  fileNotice(ctx, {
    userId: who.userId,
    title: `Approval key enrolment locked until ${shortTime(lock.until)}`,
    body: `Three wrong passwords or two-factor codes were sent within an hour to add or remove an approval key ${BY_PASSWORD}, so that way is locked for ${hours} hour${hours === 1 ? '' : 's'}: until ${shortTime(lock.until)}.`
      + ' Removing a key with your password and a code is locked too. Adding a key approved on a device that already has one still works.'
      + ' If this was not you, change your password.',
    idemKey: `approval-lockdown:enrol:${who.userId}:${lock.until}`,
    push: true,
  })
}

// {publicKey, keyId} for a well-formed key (stored in canonical base64url),
// or null with a 400 sent.
function readPublicKey(res, raw) {
  let keyId
  try { keyId = keyIdOf(raw) } catch { json(res, 400, { error: 'bad_public_key' }); return null }
  return { publicKey: Buffer.from(raw, 'base64url').toString('base64url'), keyId }
}

function readName(res, raw) {
  const name = typeof raw === 'string' ? sanitizePeerText(raw, KEY_NAME_MAX + 1) : ''
  if (!name || name.length > KEY_NAME_MAX) { json(res, 400, { error: 'bad_request' }); return null }
  return name
}

// The password-and-TOTP path (bootstrap enrolment, revoke, and revoking
// another device, http.js POST /devices/:id/revoke). Two-factor must
// be on and the code a TOTP code: a recovery code does not count, and is
// refused before it could be spent. Wrong passwords and codes count against
// the username's lockout (two-factor-http.js confirmIdentity).
//
// Three wrong passwords or codes within an hour lock this path for the
// account (enrolment and revoke alike: both lead back to an account the
// password alone controls), refused with 429 before anything is checked.
// A recovery code is refused before the password is checked, so it guesses
// nothing and does not count; nor does a malformed request.
//
// One attempt at a time per account (ctx.passwordChecks, the queue POST
// /password uses): the lock check, the password and code, and the failure
// count run start to finish before the next attempt's lock check, so
// requests sent together cannot each get a guess while the first ones are
// still being hashed.
const ownQueue = makeKeyedQueue()
export function confirmPasswordAndTotp(ctx, res, who, { password, code }) {
  return (ctx.passwordChecks ?? ownQueue).run(who.userId, async () => {
    if (enrolmentLocked(ctx, res, who, Date.now())) return false
    if (!isTwoFactorEnabled(ctx.db, who.userId)) { json(res, 409, { error: 'two_factor_required' }); return false }
    if (classifyCode(code)?.kind === 'recovery') { json(res, 400, { error: 'totp_required' }); return false }
    if (await confirmIdentity(ctx, res, who, { password, code, needCode: true })) return true
    countEnrolmentFailure(ctx, res, who, Date.now())
    return false
  })
}

// The calling device still signed in (its row not deleted), checked after an
// await on the password path.
export const callerSignedIn = (db, who) => !!db.prepare('SELECT 1 FROM devices WHERE id=? AND user_id=?').get(who.deviceId, who.userId)

const keyExists = (res) => { json(res, 409, { error: 'key_exists' }); return true }
const disabled = (res) => { json(res, 409, { error: 'approval_keys_disabled' }); return true }
const notFound = (res) => { json(res, 404, { error: 'not_found' }); return true }
const send = (res, r) => { json(res, r.status, r.body); return true }

const liveRequest = (db, userId, id, now) => db.prepare('SELECT * FROM approval_key_requests WHERE id=? AND user_id=? AND created_at > ?')
  .get(id, userId, now - KEY_REQUEST_TTL_MS)

export async function handleApprovalKeysRoute(ctx, req, res, url, who) {
  const { db, journalHost } = ctx
  // A key change that has committed (the security log), by the caller.
  const record = (event, keyId) => securityLogOf(ctx).record(who.userId, event, { deviceId: who.deviceId, deviceName: who.name, target: keyTarget(keyId), decidedBy: 'user' })
  const path = url.pathname
  if (path !== '/approval-keys' && !path.startsWith('/approval-keys/') && path !== '/approvals/nonce') return false
  const enabled = !!journalHost

  if (path === '/approval-keys' && req.method === 'GET') {
    const keys = db.prepare('SELECT * FROM approval_keys WHERE user_id=? ORDER BY id').all(who.userId).map(keyView)
    const requests = db.prepare('SELECT id, public_key, name, created_at FROM approval_key_requests WHERE user_id=? AND created_at > ? ORDER BY created_at, id')
      .all(who.userId, Date.now() - KEY_REQUEST_TTL_MS)
      .map((r) => ({ id: r.id, key_id: keyIdOf(r.public_key), name: r.name, created_at: r.created_at }))
    // `journal`: the host every statement must name (null while approval
    // keys are off), so an app need not derive it from the URL it uses.
    json(res, 200, { enabled, journal: journalHost || null, keys, requests })
    return true
  }

  if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }
  if (req.method !== 'POST') return notFound(res)

  if (path === '/approvals/nonce') {
    if (!enabled) return disabled(res)
    json(res, 200, issueNonce(db, who))
    return true
  }

  if (path === '/approval-keys') {
    const { public_key, name, password, code } = await readBody(req)
    if (!enabled) return disabled(res)
    const pk = readPublicKey(res, public_key)
    if (!pk) return true
    const keyName = readName(res, name)
    if (!keyName) return true
    if (!(await confirmPasswordAndTotp(ctx, res, who, { password, code }))) return true
    // Signed out, or the account locked, while the password was checked.
    recheckCaller(req)
    // Whether the key is enrolled (to this account or any other: key ids
    // are unique across the journal) is told only to a caller who has just
    // passed the password and code.
    if (keyRow(db, pk.keyId)) return keyExists(res)
    // The password check awaited: the calling device may have been signed
    // out meanwhile (its row deleted, its id free to be handed out again),
    // and a key must not be attached to an id that is gone.
    let row
    try {
      const added = db.prepare(`INSERT INTO approval_keys(user_id, key_id, public_key, alg, name, device_id, enrolled_via, enrolled_by, created_at)
        SELECT ?,?,?,?,?,?,'password',NULL,? WHERE EXISTS (SELECT 1 FROM devices WHERE id=? AND user_id=?)`)
        .run(who.userId, pk.keyId, pk.publicKey, ALG, keyName, who.deviceId, Date.now(), who.deviceId, who.userId).changes
      if (!added) { json(res, 401, { error: 'unauthenticated' }); return true }
      row = keyRow(db, pk.keyId)
    } catch (err) {
      // Enrolled meanwhile, while the password was being checked.
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return keyExists(res)
      throw err
    }
    record('approval_key_enrolled', row.key_id)
    announceKey(ctx, who.userId, row, { added: true, how: BY_PASSWORD })
    json(res, 200, { key: keyView(row) })
    return true
  }

  if (path === '/approval-keys/requests') {
    const { public_key, name } = await readBody(req)
    if (!enabled) return disabled(res)
    const pk = readPublicKey(res, public_key)
    if (!pk) return true
    const keyName = readName(res, name)
    if (!keyName) return true
    // The same answer whichever account has the key.
    if (keyRow(db, pk.keyId)) return keyExists(res)
    const now = Date.now()
    const id = `kr_${crypto.randomBytes(12).toString('hex')}`
    db.transaction(() => {
      db.prepare('DELETE FROM approval_key_requests WHERE created_at <= ?').run(now - KEY_REQUEST_TTL_MS)
      db.prepare('INSERT INTO approval_key_requests(id, user_id, device_id, public_key, name, created_at) VALUES(?,?,?,?,?,?)')
        .run(id, who.userId, who.deviceId, pk.publicKey, keyName, now)
    })()
    json(res, 200, { id })
    return true
  }

  const approve = path.match(/^\/approval-keys\/requests\/([^/]+)\/approve$/)
  if (approve) {
    const { approval } = await readBody(req)
    if (!enabled) return disabled(res)
    // One transaction: the request, the signature check (which spends the
    // nonce) and the new key stand or fall together.
    let out
    try {
      out = db.transaction(() => {
        const now = Date.now()
        const rq = liveRequest(db, who.userId, approve[1], now)
        if (!rq) return { ok: false, status: 404, body: { error: 'not_found' } }
        const keyId = keyIdOf(rq.public_key)
        if (keyRow(db, keyId)) return { ok: false, status: 409, body: { error: 'key_exists' } }
        const r = checkApproval({ db, journalHost, now }, who, approval, { type: 'account', subject: { op: 'enrol_key', key_id: keyId } })
        if (!r.ok) return r
        db.prepare(`INSERT INTO approval_keys(user_id, key_id, public_key, alg, name, device_id, enrolled_via, enrolled_by, created_at)
          VALUES(?,?,?,?,?,?,'device',?,?)`).run(who.userId, keyId, rq.public_key, ALG, rq.name, rq.device_id, r.keyId, now)
        db.prepare('DELETE FROM approval_key_requests WHERE id=?').run(rq.id)
        return { ok: true, row: keyRow(db, keyId), signer: r.keyId }
      })()
    } catch (err) {
      // The unique key_id refused the insert (enrolled meanwhile), as on
      // the password path: rolled back, the nonce with it.
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return keyExists(res)
      throw err
    }
    if (!out.ok) return send(res, out)
    record('approval_key_enrolled', out.row.key_id)
    announceKey(ctx, who.userId, out.row, { added: true, how: `approved with the key \`${out.signer.slice(0, 8)}\`` })
    json(res, 200, { key: keyView(out.row) })
    return true
  }

  if (path === '/approval-keys/attach') {
    const { approval } = await readBody(req)
    if (!enabled) return disabled(res)
    // The key being attached is the one that signed: the subject must name
    // the signer. Whose device it was on does not matter here (anyDevice),
    // only that the caller holds the key.
    const signer = parseStatement(approval?.statement)?.key_id
    const out = db.transaction(() => {
      const r = checkApproval({ db, journalHost }, who, approval, { type: 'account', subject: { op: 'attach_key', key_id: signer } }, { anyDevice: true })
      if (!r.ok) return r
      db.prepare('UPDATE approval_keys SET device_id=? WHERE key_id=? AND revoked_at IS NULL').run(who.deviceId, r.keyId)
      return { ok: true, row: keyRow(db, r.keyId) }
    })()
    if (!out.ok) return send(res, out)
    record('approval_key_attached', out.row.key_id)
    announceAttach(ctx, who, out.row)
    json(res, 200, { key: keyView(out.row) })
    return true
  }

  const revoke = path.match(/^\/approval-keys\/([0-9a-f]{64})\/revoke$/)
  if (revoke) {
    const keyId = revoke[1]
    const { approval, password, code } = await readBody(req)
    if (!activeKeyFor(db, who.userId, keyId)) return notFound(res)
    const revokeNow = () => db.prepare('UPDATE approval_keys SET revoked_at=? WHERE user_id=? AND key_id=? AND revoked_at IS NULL')
      .run(Date.now(), who.userId, keyId).changes > 0
    let how
    if (approval !== undefined) {
      // The check and the revoke in one transaction: an account whose last
      // key this is goes back to "no key" only once the revoke commits.
      const out = db.transaction(() => {
        const r = checkApproval({ db, journalHost }, who, approval, { type: 'account', subject: { op: 'revoke_key', key_id: keyId } })
        if (!r.ok) return r
        return revokeNow() ? { ok: true, signer: r.keyId } : { ok: false, status: 404, body: { error: 'not_found' } }
      })()
      if (!out.ok) return send(res, out)
      how = `with a signature from the key \`${out.signer.slice(0, 8)}\``
    } else if (password !== undefined || code !== undefined) {
      if (!(await confirmPasswordAndTotp(ctx, res, who, { password, code }))) return true
      // As on enrolment: a caller signed out while the password was being
      // checked changes nothing (no await between this and the revoke);
      // nor does one whose account was locked meanwhile.
      recheckCaller(req)
      if (!callerSignedIn(db, who)) { json(res, 401, { error: 'unauthenticated' }); return true }
      if (!revokeNow()) return notFound(res)
      how = BY_PASSWORD
    } else {
      json(res, 403, { error: 'approval_required' })
      return true
    }
    const row = keyRow(db, keyId)
    record('approval_key_revoked', keyId)
    announceKey(ctx, who.userId, row, { added: false, how })
    json(res, 200, { key: keyView(row) })
    return true
  }

  return notFound(res)
}
