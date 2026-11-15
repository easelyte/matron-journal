#!/usr/bin/env node
import fs, { realpathSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import { openDb, pinDevicePrivate, unpinDevicePrivate, setDeviceConsentUserOnly, setDeviceProtected } from '../src/db.js'
import { createUser, setPassword, createAgent, revokeDevice, signOutOwnedDevice } from '../src/auth.js'
import { resolveMediaDir } from '../src/media.js'
import { resolvePreapproveKeyPath } from '../src/preapprove-key.js'
import { runOffload, runExpireLogs } from '../src/retention.js'
import { listAwaiting, answerParkedInvite } from '../src/participants.js'
import { closeChatConsentItem } from '../src/consent-items.js'
import { normaliseEmail, setUserEmail } from '../src/password-reset.js'
import { setTransferConsentEnabled, getTransferConsentEnabled } from '../src/consent.js'
import { restampConsentItems } from '../src/consent-subject.js'
import { announceKey, announceRestamped, asUser } from '../src/approval-keys-http.js'
import { activeKeysOfDevice } from '../src/approval-keys.js'
import { resolveFederationConfig, storedFederationKeyInfo } from '../src/federation-identity.js'
import { formatFingerprint } from '../src/federation-envelope.js'
import { makeTokenBox } from '../src/token-box.js'
import { makeSecurityLog, deviceTarget, keyTarget, boxTarget } from '../src/security-log.js'
import { panicLock, clearPanic } from '../src/panic.js'
import { createSource, listSources, getSource, setSourceCaps, rotateSourceKey, setSourceEnabled, DEFAULT_HOURLY_MAX, DEFAULT_DAILY_MAX } from '../src/inbound.js'
import {
  disableTwoFactor, twoFactorState, isTwoFactorRequired, setTwoFactorRequired, isTwoFactorExempt, setTwoFactorExempt,
} from '../src/two-factor.js'

const USAGE = `usage:
  matron-admin user add <name> (--password-stdin | env MATRON_PASSWORD)
  matron-admin user passwd <name> (--password-stdin | env MATRON_PASSWORD)
  matron-admin user admin <name> on|off
  matron-admin user unlisted <name> on|off
  matron-admin user email <name> <address>|--clear
  matron-admin user 2fa-reset <name>
  matron-admin user 2fa-exempt <name> on|off
  matron-admin two-factor status
  matron-admin two-factor require on|off
  matron-admin federation status
  matron-admin federation peers
  matron-admin federation block <host>
  matron-admin federation unblock <host>
  matron-admin agent add <username> <agent-name>
  matron-admin device list <username>
  matron-admin device revoke <device_id>
  matron-admin device private <device_id> on|off|auto
  matron-admin device consent <device_id> user-only|any
  matron-admin device protected <device_id> on|off
  matron-admin approval-key list <username>
  matron-admin approval-key revoke <username> <key_id|--all>
  matron-admin coordinator transfers <username> on|off
  matron-admin panic status <username>
  matron-admin panic clear <username>
  matron-admin link-code <username> --server-url <url> [--port <n>] [--expires <30m|24h>] [--png <path>]
  matron-admin offload [--days N]
  matron-admin expire-logs [--hours N]
  matron-admin inbound add <username> <source-name> [--hourly N] [--daily N]
  matron-admin inbound list <username>
  matron-admin inbound limits <source_id> --hourly N --daily N
  matron-admin inbound rotate <source_id>
  matron-admin inbound disable|enable <source_id>
  matron-admin agent-chat pending <username>
  matron-admin agent-chat approve <username> <room_id> <device_id>
  matron-admin agent-chat deny <username> <room_id> <device_id>
  matron-admin status`

function flag(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}

async function readAllStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// Resolve the password for `user add`/`user passwd` from an OFF-ARGV source,
// so the plaintext never lands in this process's argv (readable by any
// local user via `ps`/`/proc/<pid>/cmdline`). Precedence:
//   1. --password-stdin : read it from stdin (strip one trailing newline so
//      `echo "$pw" | ...` and `printf %s "$pw" | ...` both work)
//   2. MATRON_PASSWORD  : env var (in the process environment, not argv)
// A password on argv (`--password <pw>`) is refused outright, not ignored,
// so an old script fails loudly instead of creating a user with another
// password. Returns null when none is supplied; callers turn that into USAGE.
async function resolvePassword(argv, deps) {
  const env = deps.env ?? process.env
  if (argv.includes('--password')) throw new Error('--password <pw> puts the password on argv and is no longer accepted: use --password-stdin or MATRON_PASSWORD')
  if (argv.includes('--password-stdin')) {
    const read = deps.readStdin ?? readAllStdin
    return (await read()).replace(/\r?\n$/, '')
  }
  const envPw = env.MATRON_PASSWORD
  return envPw != null && envPw !== '' ? envPw : null
}

// Mirrors the apps'/relay's server-URL stance (src/relay.js validateOffer,
// LOCALHOST_HOSTS): https from any host, http only to localhost-ish dev
// hosts, and capped at 200 chars. Not imported from relay.js because it
// isn't exported there — kept in sync by hand instead.
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function isValidServerUrl(serverUrl) {
  if (typeof serverUrl !== 'string' || serverUrl.length > 200) return false
  let u
  try { u = new URL(serverUrl) } catch { return false }
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOCALHOST_HOSTS.has(u.hostname))
}

// --expires durations: Nm/Nh only, 1 minute to 24 hours — mirrors the
// server-side ttl_seconds bounds so a value we accept is never refused.
export function parseExpiresSeconds(text) {
  const m = /^(\d+)([mh])$/.exec(text ?? '')
  if (!m) return null
  const secs = Number(m[1]) * (m[2] === 'm' ? 60 : 3600)
  return secs >= 60 && secs <= 86400 ? secs : null
}

function formatExpiry(expiresInSeconds) {
  const mins = Math.round(expiresInSeconds / 60)
  return mins >= 120 ? `expires in ${Math.round(mins / 60)} hours` : `expires in ${mins} minutes`
}

// "asked 3m ago" / "asked 2h ago" / "asked 5d ago" for `agent-chat pending` —
// coarse on purpose, this is an operator glance, not an audit timestamp.
function formatAge(createdAt, now = Date.now()) {
  const mins = Math.floor(Math.max(0, now - createdAt) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function requireUser(db, username) {
  const user = db.prepare('SELECT id FROM users WHERE name=?').get(username)
  if (!user) throw new Error(`no such user: ${username}`)
  return user
}

// The ownership check every agent-chat answer must pass before touching a
// row: this CLI takes a username precisely so a parked ask cannot be
// approved/denied against the wrong user's room just because the operator
// (or a scripting mistake) named the wrong room/device id. Joins
// conversations for owner_user_id, the check itself, in one query.
function loadAwaitingRow(db, roomId, deviceId) {
  return db.prepare(`
    SELECT ca.convo_id, ca.agent_device_id, ca.initiator_device_id, ca.state,
           c.owner_user_id
    FROM convo_agents ca JOIN conversations c ON c.id = ca.convo_id
    WHERE ca.convo_id=? AND ca.agent_device_id=?
  `).get(roomId, deviceId)
}

// The notices this CLI files: it has no connection to the running server,
// so nothing is broadcast or pushed; the apps see the item on their next
// fetch, as for the tracker writes below.
const NO_HUB = { broadcastJournal() {}, sendToClients() {} }
const cliCtx = (db) => ({ db, hub: NO_HUB, pushPipeline: null })
const keyRowOf = (db, keyId) => db.prepare('SELECT * FROM approval_keys WHERE key_id=?').get(keyId)
const BY_ADMIN = 'by the journal administrator'

export async function runAdmin(db, argv, deps = {}) {
  const renderPng = deps.renderPng ?? ((uri) => QRCode.toBuffer(uri, { type: 'png', scale: 8 }))
  // Security events (src/security-log.js) for what the host does to an
  // account: in the database (the journal's feed serves them) and in
  // MATRON_SECURITY_LOG when set, never on this command's own output.
  // No device and no address: decided by the host's administrator.
  const securityLog = deps.securityLog ?? makeSecurityLog({ db, out: () => {} })
  const adminEvent = (userId, event, target = null) => securityLog.record(userId, event, { deviceId: null, sourceIp: null, target, decidedBy: 'admin_cli' })
  const [a, b] = argv
  if (a === 'user' && b === 'add') {
    const name = argv[2]
    const pw = await resolvePassword(argv, deps)
    if (!name || !pw) throw new Error(USAGE)
    const u = await createUser(db, name, pw)
    return `user ${name} created (id ${u.id})`
  }
  if (a === 'user' && b === 'passwd') {
    const name = argv[2]
    const pw = await resolvePassword(argv, deps)
    if (!name || !pw) throw new Error(USAGE)
    await setPassword(db, name, pw)
    const changed = db.prepare('SELECT id FROM users WHERE name=?').get(name)
    if (changed) adminEvent(changed.id, 'password_changed')
    return `password updated for ${name}`
  }
  if (a === 'user' && b === 'admin') {
    const name = argv[2]
    const value = argv[3]
    if (!name || (value !== 'on' && value !== 'off')) throw new Error(USAGE)
    const r = db.prepare('UPDATE users SET is_admin=? WHERE name=?').run(value === 'on' ? 1 : 0, name)
    if (r.changes === 0) throw new Error(`no such user: ${name}`)
    return value === 'on' ? `${name} is now a journal admin` : `${name} is no longer a journal admin`
  }
  if (a === 'user' && b === 'unlisted') {
    const name = argv[2]
    const value = argv[3]
    if (!name || (value !== 'on' && value !== 'off')) throw new Error(USAGE)
    const r = db.prepare('UPDATE users SET unlisted=? WHERE name=?').run(value === 'on' ? 1 : 0, name)
    if (r.changes === 0) throw new Error(`no such user: ${name}`)
    return value === 'on'
      ? `${name} is now unlisted: left out of the add-contact user list, and cannot send or be sent a contact request`
      : `${name} is listed again in the add-contact user list`
  }
  // The address a forgot-password link goes to (src/password-reset.js).
  if (a === 'user' && b === 'email') {
    const name = argv[2]
    const value = argv[3]
    if (!name || !value) throw new Error(USAGE)
    const email = value === '--clear' ? null : normaliseEmail(value)
    if (value !== '--clear' && !email) throw new Error(`not an email address: ${value}`)
    const u = db.prepare('SELECT id FROM users WHERE name=?').get(name)
    if (!u) throw new Error(`no such user: ${name}`)
    if (setUserEmail(db, u.id, email).conflict) throw new Error(`another account already has ${email}`)
    return email ? `${name}'s email is now ${email}` : `${name} has no email address now`
  }
  // The lockout escape hatch: a user who has lost their authenticator app
  // and their recovery codes signs in with the password alone again, and
  // can set two-factor up afresh (or is made to, when it is required).
  if (a === 'user' && b === '2fa-reset') {
    const name = argv[2]
    if (!name) throw new Error(USAGE)
    const user = requireUser(db, name)
    // The exemption is the operator's choice about the requirement, not
    // part of the factor, so a reset leaves it as it was.
    const exemptNote = isTwoFactorExempt(db, user.id) ? ' (still exempt from the requirement)' : ''
    if (!disableTwoFactor(db, user.id)) return `${name} did not have two-factor on${exemptNote}`
    adminEvent(user.id, 'two_factor_changed', 'reset')
    return `two-factor turned off for ${name}; they sign in with their password and can set it up again${exemptNote}`
  }
  // An account (a review or demo login, say) that keeps signing in with its
  // password while two-factor is required for everyone else. It waives the
  // requirement only: a user who has set two-factor up is still asked for
  // their code. Shell only, like the other operator switches.
  if (a === 'user' && b === '2fa-exempt') {
    const name = argv[2]
    const value = argv[3]
    if (!name || (value !== 'on' && value !== 'off')) throw new Error(USAGE)
    const user = requireUser(db, name)
    const changed = setTwoFactorExempt(db, user.id, value === 'on')
    if (value === 'off') {
      return changed
        ? `${name} is no longer exempt: when two-factor is required they set it up at their next password sign-in`
        : `${name} was not exempt`
    }
    if (!changed) return `${name} is already exempt from the two-factor requirement`
    return twoFactorState(db, user.id).enabled
      ? `${name} is exempt from the two-factor requirement, but has two-factor on, so they are still asked for their code (turn it off with \`user 2fa-reset ${name}\`)`
      : `${name} is exempt from the two-factor requirement: they sign in with their password alone, even while it is required`
  }
  if (a === 'two-factor' && b === 'status') {
    const users = db.prepare('SELECT id, name, two_factor_exempt FROM users ORDER BY name').all()
    let on = 0
    const exempt = []
    const lines = users.map((u) => {
      const s = twoFactorState(db, u.id)
      if (s.enabled) on += 1
      if (u.two_factor_exempt) exempt.push(u.name)
      const state = s.enabled ? `on (${s.recoveryCodesLeft} recovery codes left)` : 'off'
      return `${u.name}\t${state}${u.two_factor_exempt ? ', exempt' : ''}`
    })
    const keyNote = process.env.MATRON_TOKEN_KEY ? '' : ' (MATRON_TOKEN_KEY is not set in this shell; the server needs it for two-factor)'
    return [
      `required for everyone: ${isTwoFactorRequired(db) ? 'yes' : 'no'}${exempt.length ? ` (journal-wide switch; exempt users are not held to it)` : ''}${keyNote}`,
      `users: ${users.length} (on: ${on}, off: ${users.length - on}), exempt: ${exempt.length}`,
      `exempt: ${exempt.length ? exempt.join(', ') : 'none'}`,
      ...lines,
    ].join('\n')
  }
  if (a === 'federation' && b === 'status') {
    const env = deps.env ?? process.env
    const config = resolveFederationConfig({ federation: env.MATRON_FEDERATION, publicUrl: env.MATRON_PUBLIC_URL })
    const box = makeTokenBox(env.MATRON_TOKEN_KEY || null)
    const key = storedFederationKeyInfo(db, box)
    const switchLine = config.enabled
      ? `on in this shell, as ${config.host} (${config.baseUrl})`
      : ({ off: 'off in this shell (MATRON_FEDERATION is not on)', bad_switch: 'off in this shell: MATRON_FEDERATION must be on or off', no_public_url: 'off in this shell: MATRON_FEDERATION is on but MATRON_PUBLIC_URL is not an https URL' })[config.reason]
    const keyLine = !key ? 'key: none yet (made the first time the server starts with federation on)'
      : !key.readable ? `key: stored, but it does not open under ${env.MATRON_TOKEN_KEY ? 'this' : 'a missing'} MATRON_TOKEN_KEY`
      : `key: ${key.pub}\nfingerprint: ${formatFingerprint(key.fingerprint)}${key.createdAt ? `\nmade: ${new Date(key.createdAt).toISOString()}` : ''}`
    return [`federation: ${switchLine}`, keyLine].join('\n')
  }
  if (a === 'federation' && b === 'peers') {
    const rows = db.prepare(`SELECT p.*,
        (SELECT COUNT(*) FROM contacts c WHERE c.peer_journal = p.host AND c.state = 'active') AS contacts,
        (SELECT COUNT(*) FROM fed_outbox o WHERE o.peer_host = p.host AND o.state = 'queued') AS queued,
        (SELECT COUNT(*) FROM fed_outbox o WHERE o.peer_host = p.host AND o.state = 'dead') AS dead
      FROM fed_peers p ORDER BY p.host`).all()
    if (!rows.length) return 'no other journals known'
    const when = (t) => (t ? new Date(t).toISOString() : 'never')
    return rows.map((r) => [
      r.host, r.state, `contacts: ${r.contacts}`, `queued: ${r.queued}, dead: ${r.dead}`, `last ok: ${when(r.last_ok_at)}`,
      ...(r.last_error ? [`last error: ${r.last_error}`] : []),
    ].join('\t')).join('\n')
  }
  // A blocked journal is refused both ways at once, with no restart: its
  // envelopes get 403 peer_refused, its invite links are refused, and what
  // is queued for it goes dead at the outbox's next pass, a few seconds
  // later (its users are told, and can resend after an unblock). A host never seen is blocked ahead of time; it has no key yet.
  if (a === 'federation' && (b === 'block' || b === 'unblock')) {
    const host = String(argv[2] ?? '').trim().toLowerCase()
    if (!/^[a-z0-9.-]+(:[0-9]{1,5})?$/.test(host) || !host.includes('.')) throw new Error(USAGE)
    const row = db.prepare('SELECT state, key_pub FROM fed_peers WHERE host=?').get(host)
    if (b === 'block') {
      if (row?.state === 'blocked') return `${host} is already blocked`
      if (row) db.prepare("UPDATE fed_peers SET state='blocked', last_error='blocked' WHERE host=?").run(host)
      else db.prepare("INSERT INTO fed_peers(host, base_url, key_pub, state, first_seen, last_error) VALUES(?,?,'','blocked',?,'blocked')").run(host, `https://${host}`, Date.now())
      const queued = db.prepare("SELECT COUNT(*) AS n FROM fed_outbox WHERE peer_host=? AND state='queued'").get(host).n
      return `${host} is blocked: nothing goes to it or comes from it${queued ? `; ${queued} queued ${queued === 1 ? 'op goes' : 'ops go'} dead at the next outbox pass, and their users are told` : ''}`
    }
    if (row?.state !== 'blocked') return `${host} is not blocked`
    if (!row.key_pub) {
      db.prepare('DELETE FROM fed_peers WHERE host=?').run(host)
      return `${host} is no longer blocked (it was never in touch, so it is forgotten)`
    }
    db.prepare("UPDATE fed_peers SET state='active', last_error=NULL WHERE host=?").run(host)
    return `${host} is no longer blocked: its contacts work again with the key they pinned, and dead ops for it can be resent`
  }
  if (a === 'two-factor' && b === 'require') {
    const value = argv[2]
    if (value !== 'on' && value !== 'off') throw new Error(USAGE)
    setTwoFactorRequired(db, value === 'on')
    if (value === 'off') return 'two-factor is optional again'
    const exempt = db.prepare('SELECT COUNT(*) AS n FROM users WHERE two_factor_exempt=1').get().n
    const exemptNote = exempt ? `; ${exempt} exempt ${exempt === 1 ? 'user is' : 'users are'} not (see \`two-factor status\`)` : ''
    return `two-factor is now required: users without it set it up at their next password sign-in (existing sessions stay signed in)${exemptNote}`
  }
  if (a === 'agent' && b === 'add') {
    const [, , username, agentName] = argv
    if (!username || !agentName) throw new Error(USAGE)
    const user = db.prepare('SELECT id FROM users WHERE name=?').get(username)
    if (!user) throw new Error(`no such user: ${username}`)
    const { token, deviceId } = createAgent(db, user.id, agentName)
    adminEvent(user.id, 'bridge_paired', deviceTarget(deviceId))
    return `agent ${agentName} token: ${token}\n(store in the bridge credentials file; it is not shown again)`
  }
  // Inbound sources (src/inbound.js): an outside tool's write-only key and
  // the conversation its reports land in.
  if (a === 'inbound') {
    const num = (name, dflt) => { const v = flag(argv, name); return v == null ? dflt : Number(v) }
    if (b === 'add') {
      const [, , username, sourceName] = argv
      if (!username || !sourceName) throw new Error(USAGE)
      const user = requireUser(db, username)
      const { source, key } = createSource(db, user.id, sourceName, { hourlyMax: num('--hourly', DEFAULT_HOURLY_MAX), dailyMax: num('--daily', DEFAULT_DAILY_MAX) })
      return `source ${source.id} "${source.name}" for ${username}: at most ${source.hourly_max} reports an hour, ${source.daily_max} a day\nkey: ${key}\n(give it to the tool that posts; it can only post reports, and it is not shown again)`
    }
    if (b === 'list') {
      if (!argv[2]) throw new Error(USAGE)
      const rows = listSources(db, requireUser(db, argv[2]).id)
      if (rows.length === 0) return `no inbound sources for ${argv[2]}`
      return rows.map((r) => `${r.id} name=${JSON.stringify(r.name)} ${r.enabled ? 'enabled' : 'disabled'} hourly=${r.hourly_max} daily=${r.daily_max} last_post_at=${r.last_post_at ?? 'never'}`).join('\n')
    }
    const id = argv[2]
    if (!id || !getSource(db, id)) throw new Error(id ? `no such source: ${id}` : USAGE)
    if (b === 'limits') {
      setSourceCaps(db, id, { hourlyMax: num('--hourly', NaN), dailyMax: num('--daily', NaN) })
      const r = getSource(db, id)
      return `source ${id}: at most ${r.hourly_max} reports an hour, ${r.daily_max} a day`
    }
    if (b === 'rotate') return `source ${id} new key: ${rotateSourceKey(db, id)}\n(the old key no longer works; this one is not shown again)`
    if (b === 'disable' || b === 'enable') {
      setSourceEnabled(db, id, b === 'enable')
      return `source ${id} is ${b}d`
    }
    throw new Error(USAGE)
  }
  if (a === 'device' && b === 'list') {
    const username = argv[2]
    if (!username) throw new Error(USAGE)
    const user = db.prepare('SELECT id FROM users WHERE name=?').get(username)
    if (!user) throw new Error(`no such user: ${username}`)
    const devices = db.prepare('SELECT id, kind, name, cursor, last_seen_at, private, private_pinned, consent_user_only, protected FROM devices WHERE user_id=? ORDER BY id').all(user.id)
    if (devices.length === 0) return `no devices for ${username}`
    return devices.map((d) =>
      `${d.id} kind=${d.kind} name=${d.name} cursor=${d.cursor} last_seen_at=${d.last_seen_at ?? 'never'}` +
      ` private=${d.private ? 'yes' : 'no'}${d.private_pinned ? ' (pinned)' : ''}` +
      (d.consent_user_only ? ' consent=user-only' : '') +
      (d.protected ? ' protected' : '')
    ).join('\n')
  }
  // Spec §8: "Revocation: delete the device/agent row; its socket is closed
  // on next frame." This just deletes the row — WS enforcement (the
  // per-frame device recheck) and HTTP (token-hash lookup per request) both
  // key off that row existing, so deleting it is the entire revocation.
  if (a === 'device' && b === 'revoke') {
    const deviceId = Number(argv[2])
    if (!Number.isInteger(deviceId)) throw new Error(USAGE)
    const existing = db.prepare('SELECT id, user_id FROM devices WHERE id=?').get(deviceId)
    if (!existing) throw new Error(`no such device: ${deviceId}`)
    // Its approval keys go with it (auth.js revokeDevice): each one's
    // removal is announced, as from the device list in the apps.
    const keys = activeKeysOfDevice(db, existing.user_id, deviceId)
    revokeDevice(db, deviceId)
    adminEvent(existing.user_id, 'device_revoked', deviceTarget(deviceId))
    for (const key of keys) {
      adminEvent(existing.user_id, 'approval_key_revoked', keyTarget(key.key_id))
      announceKey(cliCtx(db), existing.user_id, keyRowOf(db, key.key_id), { added: false, how: BY_ADMIN })
    }
    return `device ${deviceId} revoked`
  }
  // Approval keys from the host. A key outlives its device's sign-in
  // (detached by a reset, a password change, a lockdown or a sign-out), and
  // once the authenticator is lost too nothing in the apps can remove it:
  // this can. Each removal files the usual notice; the CLI cannot push.
  if (a === 'approval-key' && b === 'list') {
    if (!argv[2]) throw new Error(USAGE)
    const user = requireUser(db, argv[2])
    const keys = db.prepare('SELECT * FROM approval_keys WHERE user_id=? ORDER BY id').all(user.id)
    if (keys.length === 0) return `no approval keys for ${argv[2]}`
    const iso = (ms) => new Date(ms).toISOString()
    return keys.map((k) => `${k.key_id} name=${k.name} device=${k.device_id ?? 'none'} via=${k.enrolled_via} created=${iso(k.created_at)} `
      + (k.revoked_at == null ? 'active' : `revoked=${iso(k.revoked_at)}`)).join('\n')
  }
  if (a === 'approval-key' && b === 'revoke') {
    const [, , username, which] = argv
    if (!username || !which) throw new Error(USAGE)
    const user = requireUser(db, username)
    const all = which === '--all'
    const keys = all
      ? db.prepare('SELECT * FROM approval_keys WHERE user_id=? AND revoked_at IS NULL ORDER BY id').all(user.id)
      : db.prepare('SELECT * FROM approval_keys WHERE user_id=? AND key_id=? AND revoked_at IS NULL').all(user.id, which)
    if (keys.length === 0) {
      if (all) return `no active approval keys for ${username}`
      throw new Error(`no active approval key ${which} for ${username}`)
    }
    const now = Date.now()
    db.transaction(() => {
      for (const k of keys) db.prepare('UPDATE approval_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now, k.id)
    })()
    for (const k of keys) {
      adminEvent(user.id, 'approval_key_revoked', keyTarget(k.key_id))
      announceKey(cliCtx(db), user.id, keyRowOf(db, k.key_id), { added: false, how: BY_ADMIN })
    }
    return all
      ? `revoked ${keys.length} approval key${keys.length === 1 ? '' : 's'} for ${username}`
      : `revoked approval key ${keys[0].key_id.slice(0, 8)} (${keys[0].name}) for ${username}`
  }
  // Visibility flag override (spec: agent visibility & privacy). on/off PIN
  // the flag — the bridge's per-hello MATRON_AGENT_PRIVATE assertion is
  // ignored until `auto` releases it. This is what makes admin authoritative:
  // a deploy that forgot the env var cannot unmark a pinned machine. The pin
  // also sets whether the bridge may raise the flag after `auto` (on: yes,
  // off: no) — an ordinary device can never make itself private.
  if (a === 'device' && b === 'private') {
    const deviceId = Number(argv[2])
    const mode = argv[3]
    if (!Number.isInteger(deviceId) || !['on', 'off', 'auto'].includes(mode)) throw new Error(USAGE)
    const existing = db.prepare('SELECT id FROM devices WHERE id=?').get(deviceId)
    if (!existing) throw new Error(`no such device: ${deviceId}`)
    if (mode === 'auto') {
      unpinDevicePrivate(db, deviceId)
      return `device ${deviceId} privacy unpinned — the flag now follows the bridge's hello assertion (MATRON_AGENT_PRIVATE) from its next connect; a device last pinned off may lower but not raise it`
    }
    pinDevicePrivate(db, deviceId, mode === 'on')
    return `device ${deviceId} pinned private=${mode} — the bridge's hello assertion is ignored until 'auto' releases it`
  }
  // Who may approve this box's asks (spec: docs/protocol.md "Consent
  // approval"). user-only: the user's tap alone, the Coordinator's approval
  // is refused; any: the default, the Coordinator may approve too.
  if (a === 'device' && b === 'consent') {
    const deviceId = Number(argv[2])
    const mode = argv[3]
    if (!Number.isInteger(deviceId) || !['user-only', 'any'].includes(mode)) throw new Error(USAGE)
    const existing = db.prepare('SELECT id FROM devices WHERE id=?').get(deviceId)
    if (!existing) throw new Error(`no such device: ${deviceId}`)
    setDeviceConsentUserOnly(db, deviceId, mode === 'user-only')
    return mode === 'user-only'
      ? `device ${deviceId} consent=user-only — only the user's tap approves its asks; the Coordinator may still decline`
      : `device ${deviceId} consent=any — the Coordinator may approve its asks again`
  }
  // A protected box (src/consent-subject.js; also POST /devices/:id/protected
  // from the user's own app, which needs a signature once the account has an
  // approval key — this is host-level access and does not): its consent
  // asks are the user's alone and, with a key, need a signed approval; the
  // Coordinator's session control cannot reach it. The user-only flag is
  // left as it is. Open consent items aimed at it are restamped here, their
  // updated_at moved and an `updated` marker written; the apps see it on
  // their next read (the CLI cannot send anything live).
  if (a === 'device' && b === 'protected') {
    const deviceId = Number(argv[2])
    const mode = argv[3]
    if (!Number.isInteger(deviceId) || !['on', 'off'].includes(mode)) throw new Error(USAGE)
    const existing = db.prepare('SELECT id, user_id FROM devices WHERE id=?').get(deviceId)
    if (!existing) throw new Error(`no such device: ${deviceId}`)
    // "Did it change" is read inside the write transaction (the write lock
    // is taken first), so a concurrent server change cannot skew it.
    const { changed, restamped } = db.transaction(() => {
      const was = !!db.prepare('SELECT protected FROM devices WHERE id=?').get(deviceId)?.protected
      setDeviceProtected(db, deviceId, mode === 'on')
      return { changed: was !== (mode === 'on'), restamped: restampConsentItems(db, existing.user_id) }
    }).immediate()
    announceRestamped(cliCtx(db), asUser(existing.user_id), restamped)
    if (changed) adminEvent(existing.user_id, 'device_protection_changed', `${deviceTarget(deviceId)}:${mode}`)
    return mode === 'on'
      ? `device ${deviceId} protected — its consent asks are the user's alone, signed once the account has an approval key`
      : `device ${deviceId} not protected`
  }
  // The user's switch "Let the Coordinator approve file transfers" (also
  // PUT /coordinator transfer_consent from the user's own app): while on,
  // the Coordinator may approve a transfer it had another session send.
  // Flagged files, user-only boxes and its own sends stay the user's.
  if (a === 'coordinator' && b === 'transfers') {
    const username = argv[2]
    const mode = argv[3]
    if (!username || !['on', 'off'].includes(mode)) throw new Error(USAGE)
    const user = db.prepare('SELECT id FROM users WHERE name=?').get(username)
    if (!user) throw new Error(`no such user: ${username}`)
    const changed = db.transaction(() => {
      const was = getTransferConsentEnabled(db, user.id)
      setTransferConsentEnabled(db, user.id, mode === 'on')
      return was !== (mode === 'on')
    }).immediate()
    if (changed) adminEvent(user.id, 'consent_switch_changed', 'transfers')
    return mode === 'on'
      ? `${username}: the Coordinator may approve file transfers, including ones it had another session send (flagged files and user-only boxes stay the user's)`
      : `${username}: file transfers the Coordinator had another session send are the user's to approve again`
  }
  // The panic lock (src/panic.js): an external watcher locks an account
  // with its panic token; only the host clears it. This writes the
  // database; the running journal reads the lock there on every check, so
  // sign-in works again at once, and its periodic sweep tells the
  // account's connected bridges within a minute. Nothing else is restored:
  // the client devices stay signed out (those the lock left frozen are
  // signed out by the clear) and the Coordinator's consent
  // switches stay off until the owner turns them on again.
  if (a === 'panic' && (b === 'status' || b === 'clear')) {
    const username = argv[2]
    if (!username || argv.length !== 3) throw new Error(USAGE)
    const user = requireUser(db, username)
    const lock = panicLock(db, user.id)
    if (b === 'status') {
      if (!lock) return `${username}: not locked`
      return `${username}: locked since ${new Date(lock.since).toISOString()} (source: ${JSON.stringify(lock.source)}, alert: ${JSON.stringify(lock.alert)})`
    }
    if (!lock) return `${username}: not locked; nothing to clear`
    // With the clear, every client device still signed in (the frozen
    // ones: those that held an approval key at the lock) is signed out, so
    // no client token that existed at the lock outlives it. Their approval
    // keys stay enrolled, detached, as after any sign-out.
    const signedOut = db.transaction(() => {
      if (!clearPanic(db, user.id)) return null
      return db.prepare("SELECT id FROM devices WHERE user_id=? AND kind='client' ORDER BY id").all(user.id)
        .map((d) => d.id).filter((id) => signOutOwnedDevice(db, user.id, id))
    })()
    if (!signedOut) return `${username}: not locked; nothing to clear`
    adminEvent(user.id, 'panic_cleared')
    for (const id of signedOut) adminEvent(user.id, 'device_revoked', deviceTarget(id))
    return [
      `${username}: panic lock cleared — sign-in works again now; the running journal tells the account's connected bridges within a minute.`,
      `${signedOut.length} client device${signedOut.length === 1 ? '' : 's'} signed out (approval keys stay enrolled, to re-attach after signing in).`,
      'nothing else is restored: client devices sign in again, and the Coordinator\'s consent switches stay off until the owner turns them on.',
    ].join('\n')
  }
  if (a === 'link-code') {
    const username = argv[1]
    const serverUrl = flag(argv, '--server-url')
    if (!username || !serverUrl) throw new Error(USAGE)
    if (!isValidServerUrl(serverUrl)) {
      throw new Error(`${USAGE}\n\ninvalid --server-url: must be https://, or http:// to localhost only, max 200 chars (got ${JSON.stringify(serverUrl)})`)
    }
    const port = Number(flag(argv, '--port') ?? process.env.MATRON_PORT ?? 9810)
    if (!Number.isInteger(port) || port <= 0) throw new Error(`${USAGE}\n\n--port must be a positive integer`)
    const expiresFlag = flag(argv, '--expires')
    let ttlSeconds = null
    if (expiresFlag != null) {
      ttlSeconds = parseExpiresSeconds(expiresFlag)
      if (ttlSeconds == null) {
        throw new Error(`${USAGE}\n\n--expires must be minutes or hours between 1m and 24h, like 30m or 24h (got ${JSON.stringify(expiresFlag)})`)
      }
    }
    const wantsPng = argv.includes('--png')
    const pngPath = flag(argv, '--png')
    if (wantsPng && !pngPath) throw new Error(`${USAGE}\n\n--png needs a file path`)
    let pngFd = null
    if (wantsPng) {
      // Open (and 0600) the file BEFORE minting: an unwritable path must
      // never orphan a live pre-approved code on the server.
      try {
        pngFd = fs.openSync(pngPath, 'w', 0o600)
        fs.fchmodSync(pngFd, 0o600) // openSync's mode only applies to newly created files
      } catch (e) {
        throw new Error(`cannot write --png file at ${pngPath} (${e.code || e.message})`)
      }
    }
    // Opening for write truncated whatever was at pngPath — if anything
    // fails from here on, don't leak the fd or leave that empty file
    // around looking like a usable QR.
    const cleanupPng = () => {
      if (pngFd == null) return
      try { fs.closeSync(pngFd) } catch {}
      try { fs.unlinkSync(pngPath) } catch {}
      pngFd = null
    }
    // Finding 1 hardening (Bugbot, PR #29): /link/preapprove now also
    // requires the auto-minted key that lives next to the journal's DB
    // file (src/preapprove-key.js) — the same file the running server
    // read/created at boot. `db.name` is the actual path this CLI process
    // opened (openDb(process.env.MATRON_DB || './matron.db') at the
    // entrypoint below, or whatever a caller/test passed in), so deriving
    // the key path from it — rather than re-reading MATRON_DB — stays
    // correct even when `db` was opened against a non-default path. Only
    // the server ever mints this file; the CLI is read-only here and must
    // fail loudly (not silently mint a fresh, non-matching key) if it
    // can't read it.
    const keyPath = resolvePreapproveKeyPath(db.name)
    let link_code, expires_in
    try {
      let key
      try {
        key = fs.readFileSync(keyPath, 'utf8').trim()
      } catch (e) {
        throw new Error(
          `cannot read the pre-approve key at ${keyPath} (${e.code || e.message}) — ` +
          'this command must run on the journal host, as the journal service user (or root)'
        )
      }
      // The pre-approved session lives in the RUNNING server's memory — the
      // admin CLI is a separate process, so this must be an HTTP call, and
      // /link/preapprove only answers loopback callers with no proxy headers
      // and the correct x-preapprove-key.
      let r
      try {
        r = await fetch(`http://127.0.0.1:${port}/link/preapprove`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-preapprove-key': key },
          body: JSON.stringify(ttlSeconds != null ? { username, ttl_seconds: ttlSeconds } : { username }),
        })
      } catch {
        throw new Error(`journal not reachable on 127.0.0.1:${port} — is it running? (set --port or MATRON_PORT)`)
      }
      // A guard failure and an unknown username are indistinguishable on the
      // wire (both a plain 404) — say so rather than claim confidently that
      // the user doesn't exist (Bugbot finding 2, PR #29). With the key
      // above in place a guard-404 for a genuinely local caller should be
      // rare, but the message stays honest either way.
      if (r.status === 404) {
        throw new Error(
          `no such user "${username}" — or the journal refused the request as non-local ` +
          '(run this on the journal host itself)'
        )
      }
      if (!r.ok) throw new Error(`journal refused the request (HTTP ${r.status})`)
      ;({ link_code, expires_in } = await r.json())
    } catch (e) {
      cleanupPng()
      throw e
    }
    const uri = `matron://link?v=1&server=${encodeURIComponent(serverUrl)}&code=${link_code}`
    // expires_in may be absent from an older/nonstandard journal response;
    // print the code either way rather than "expires in NaN minutes".
    const expiryLine = Number.isFinite(expires_in) ? `The code ${formatExpiry(expires_in)} and works once.` : 'The code works once.'
    if (pngFd != null) {
      try {
        fs.writeSync(pngFd, await renderPng(uri))
        fs.closeSync(pngFd)
      } catch (e) {
        // The mint already happened — the code is live and single-use, so
        // it must reach the operator even though the PNG never will.
        cleanupPng()
        return [
          `Could not write the QR PNG to ${pngPath} (${e.code || e.message}) — printing the code instead.`,
          `It signs a device in as ${username} with no approval step — treat it like a password.`,
          expiryLine,
          '',
          'Manual entry (sign-in screen):',
          `  server: ${serverUrl}`,
          `  code:   ${link_code}`,
        ].join('\n')
      }
      const host = os.hostname()
      return [
        `Wrote sign-in QR to ${pngPath} (mode 0600).`,
        `Scanning it signs a phone in as ${username} with no approval step — treat it like a password.`,
        expiryLine,
        '',
        'Copy it off this box, then delete it:',
        `  scp ${host}:${pngPath} .`,
        `  ssh ${host} rm ${pngPath}`,
        '',
        'Manual entry fallback (sign-in screen):',
        `  server: ${serverUrl}`,
        `  code:   ${link_code}`,
      ].join('\n')
    }
    const qr = await new Promise((resolve) => qrcode.generate(uri, { small: true }, resolve))
    return [
      qr,
      `Scan with the Matron app to sign in as ${username}.`,
      'Or enter it manually on the sign-in screen:',
      `  server: ${serverUrl}`,
      `  code:   ${link_code}`,
      `(${uri})`,
      expiryLine,
    ].join('\n')
  }
  if (a === 'offload') {
    const daysFlag = flag(argv, '--days')
    const days = daysFlag != null ? Number(daysFlag) : 30
    // Matches the env-var semantics elsewhere (MATRON_RETENTION_DAYS /
    // MATRON_MAX_REPLAY / MATRON_MEDIA_MAX_BYTES): a non-integer or <=0
    // value is a misconfiguration, not "process everything now". `--days 0`
    // (or negative/garbage) would otherwise compute a cutoff of now (or the
    // future), offloading every tool_output row including brand-new ones —
    // refuse outright instead of silently doing that on a one-shot CLI run.
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error(`${USAGE}\n\n--days must be a positive integer (got ${JSON.stringify(daysFlag)})`)
    }
    const mediaDir = resolveMediaDir(db.name)
    const r = runOffload(db, { days, mediaDir })
    return `offloaded ${r.offloaded} tool_output payload(s) older than ${days}d`
  }
  if (a === 'expire-logs') {
    const hoursFlag = flag(argv, '--hours')
    const hours = hoursFlag != null ? Number(hoursFlag) : 24
    // Same validation stance as offload's --days above: a non-integer or
    // <=0 --hours would compute a cutoff of now (or the future), expiring
    // even brand-new live-log blobs — refuse outright instead.
    if (!Number.isInteger(hours) || hours <= 0) {
      throw new Error(`${USAGE}\n\n--hours must be a positive integer (got ${JSON.stringify(hoursFlag)})`)
    }
    const mediaDir = resolveMediaDir(db.name)
    const r = runExpireLogs(db, { hours, mediaDir })
    return `purged ${r.expired} live_log payload(s) older than ${hours}h`
  }
  // v1 approval surface for agent-chat consent (spec: 2026-08-07 agent chat
  // consent) — until the apps grow the permission_request card UI, an
  // operator drives approve/deny from here. This CLI writes the DB
  // directly and has no connection to the running server's hub, which
  // shapes both the approve and deny paths below: approve cannot deliver
  // the invite itself (the journal server's sweep-tick pump — or that
  // agent's next hello — does it, within one sweep interval), and deny
  // cannot push an answer frame to the requester at all (its waiter simply
  // times out to pending; the row's state tells the story on any later
  // attempt). Both facts are said in the command's own output so the
  // operator isn't left wondering why nothing happened immediately.
  if (a === 'agent-chat' && b === 'pending') {
    const username = argv[2]
    if (!username) throw new Error(USAGE)
    const user = requireUser(db, username)
    const rows = listAwaiting(db, user.id)
    if (rows.length === 0) return `no agent-chat requests awaiting approval for ${username}`
    return rows.map((r) => {
      const dev = db.prepare('SELECT name FROM devices WHERE id=?').get(r.agent_device_id)
      return `room ${r.convo_id} ("${r.title}")  device ${r.agent_device_id} (${dev?.name ?? '?'})` +
        `  topic: ${r.topic || '(none)'}  justification: ${r.justification}  asked ${formatAge(r.created_at)}`
    }).join('\n')
  }
  if (a === 'agent-chat' && b === 'approve') {
    const [, , username, roomId, deviceIdRaw] = argv
    // `--always-allow` was the standing-consent grant. It is gone, and the
    // flag is rejected rather than silently ignored: an operator who typed
    // it and got a silent success would believe they'd granted standing
    // consent that no longer exists — every agent-chat request now parks
    // and asks the user, with no fast path (mirrors the `always_allow`
    // rejection on POST /agent-chat/answer).
    if (argv.includes('--always-allow')) {
      throw new Error(`${USAGE}\n\n--always-allow no longer exists — every agent-chat request now asks the user`)
    }
    if (!username || !roomId || !deviceIdRaw) throw new Error(USAGE)
    const deviceId = Number(deviceIdRaw)
    if (!Number.isInteger(deviceId)) throw new Error(USAGE)
    const user = requireUser(db, username)
    const row = loadAwaitingRow(db, roomId, deviceId)
    // Unknown row and a row belonging to another user's room are treated
    // identically — this check must never be skipped just because the CLI
    // is a trusted operator surface; taking a username is precisely what
    // makes the check meaningful.
    if (!row || row.owner_user_id !== user.id) {
      throw new Error(`no agent-chat request for ${username} in room ${roomId} for device ${deviceId}`)
    }
    if (!answerParkedInvite(db, { convoId: roomId, agentDeviceId: deviceId, approve: true })) {
      throw new Error(`room ${roomId} device ${deviceId} is not awaiting approval (already answered, or never parked)`)
    }
    adminEvent(user.id, 'chat_approved', boxTarget(db, deviceId))
    // No hub here: the tracker mirror is closed in the table; live clients
    // see it at their next /items (spec: 2026-09-22 consent-items).
    closeChatConsentItem({ db, hub: null }, roomId, deviceId, { outcome: 'approved' })
    return [
      `approved: room ${roomId} device ${deviceId} is now invited (asked by device ${row.initiator_device_id}).`,
      "this CLI cannot reach the running server's hub — the invite is delivered by the journal's sweep-tick pump, within one sweep interval, or sooner if that agent connects/hellos in the meantime.",
    ].join('\n')
  }
  if (a === 'agent-chat' && b === 'deny') {
    const [, , username, roomId, deviceIdRaw] = argv
    if (!username || !roomId || !deviceIdRaw) throw new Error(USAGE)
    const deviceId = Number(deviceIdRaw)
    if (!Number.isInteger(deviceId)) throw new Error(USAGE)
    const user = requireUser(db, username)
    const row = loadAwaitingRow(db, roomId, deviceId)
    if (!row || row.owner_user_id !== user.id) {
      throw new Error(`no agent-chat request for ${username} in room ${roomId} for device ${deviceId}`)
    }
    if (!answerParkedInvite(db, { convoId: roomId, agentDeviceId: deviceId, approve: false })) {
      throw new Error(`room ${roomId} device ${deviceId} is not awaiting approval (already answered, or never parked)`)
    }
    closeChatConsentItem({ db, hub: null }, roomId, deviceId, { outcome: 'denied' })
    return [
      `denied: room ${roomId} device ${deviceId} is now denied.`,
      `this CLI cannot push an answer frame to device ${row.initiator_device_id} — it has no connection to the running server's hub — so that agent's wait simply times out to pending; its next attempt will read as declined, same as a peer refusal.`,
    ].join('\n')
  }
  if (a === 'status') {
    // DB-derived stats only (this reads the SQLite file directly, no
    // running server involved) — connected-socket count and APNs counters
    // live in server-process memory and are only available via the running
    // server's GET /metrics, not here.
    const rows = db.prepare(
      `SELECT u.id, u.name,
         (SELECT COUNT(*) FROM devices d WHERE d.user_id=u.id AND d.kind='client') AS devices,
         (SELECT COUNT(*) FROM devices d WHERE d.user_id=u.id AND d.kind='agent') AS agents,
         COALESCE((SELECT seq FROM user_seq s WHERE s.user_id=u.id), 0) AS head_seq
       FROM users u ORDER BY u.name`
    ).all()
    const lines = []
    for (const r of rows) {
      lines.push(`${r.name} devices=${r.devices} agents=${r.agents} head_seq=${r.head_seq}`)
      const devices = db.prepare('SELECT id, kind, cursor, last_seen_at FROM devices WHERE user_id=? ORDER BY id').all(r.id)
      for (const d of devices) {
        lines.push(`  device ${d.id} kind=${d.kind} cursor=${d.cursor} lag=${r.head_seq - d.cursor} last_seen_at=${d.last_seen_at ?? 'never'}`)
      }
    }
    const total = db.prepare('SELECT COUNT(*) n FROM events').get().n
    lines.push(`total events: ${total}`)
    let dbSize = 'n/a'
    try {
      if (db.name && db.name !== ':memory:') dbSize = fs.statSync(db.name).size
    } catch { /* file missing/unreadable — report n/a rather than crash the CLI */ }
    lines.push(`db file size: ${dbSize}`)
    return lines.join('\n')
  }
  throw new Error(USAGE)
}

let isMain = false
try {
  isMain = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
} catch { /* argv[1] missing or unresolvable: not the entrypoint */ }
if (isMain) {
  const db = openDb(process.env.MATRON_DB || './matron.db')
  runAdmin(db, process.argv.slice(2))
    .then((out) => { console.log(out); db.close() })
    .catch((e) => { console.error(e.message); db.close(); process.exit(1) })
}
