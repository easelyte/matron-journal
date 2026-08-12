#!/usr/bin/env node
import fs, { realpathSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import { openDb, pinDevicePrivate, unpinDevicePrivate } from '../src/db.js'
import { createUser, setPassword, createAgent, revokeDevice } from '../src/auth.js'
import { resolveMediaDir } from '../src/media.js'
import { resolvePreapproveKeyPath } from '../src/preapprove-key.js'
import { runOffload, runExpireLogs } from '../src/retention.js'
import { listAwaiting, answerParkedInvite } from '../src/participants.js'

const USAGE = `usage:
  matron-admin user add <name> (--password <pw> | --password-stdin | env MATRON_PASSWORD)
  matron-admin user passwd <name> (--password <pw> | --password-stdin | env MATRON_PASSWORD)
  matron-admin agent add <username> <agent-name>
  matron-admin device list <username>
  matron-admin device revoke <device_id>
  matron-admin device private <device_id> on|off|auto
  matron-admin link-code <username> --server-url <url> [--port <n>] [--expires <30m|24h>] [--png <path>]
  matron-admin offload [--days N]
  matron-admin expire-logs [--hours N]
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

// Resolve the password for `user add`/`user passwd` from an OFF-ARGV source
// when asked, so the plaintext never lands in this process's argv (readable
// by any local user via `ps`/`/proc/<pid>/cmdline`). Precedence:
//   1. --password-stdin : read it from stdin (strip one trailing newline so
//      `echo "$pw" | ...` and `printf %s "$pw" | ...` both work)
//   2. --password <pw>  : legacy, on argv — kept for back-compat
//   3. MATRON_PASSWORD  : env var (in the process environment, not argv)
// Returns null when none is supplied; callers turn that into USAGE.
async function resolvePassword(argv, deps) {
  const env = deps.env ?? process.env
  if (argv.includes('--password-stdin')) {
    const read = deps.readStdin ?? readAllStdin
    return (await read()).replace(/\r?\n$/, '')
  }
  const flagged = flag(argv, '--password')
  if (flagged != null) return flagged
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

export async function runAdmin(db, argv, deps = {}) {
  const renderPng = deps.renderPng ?? ((uri) => QRCode.toBuffer(uri, { type: 'png', scale: 8 }))
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
    return `password updated for ${name}`
  }
  if (a === 'agent' && b === 'add') {
    const [, , username, agentName] = argv
    if (!username || !agentName) throw new Error(USAGE)
    const user = db.prepare('SELECT id FROM users WHERE name=?').get(username)
    if (!user) throw new Error(`no such user: ${username}`)
    const { token } = createAgent(db, user.id, agentName)
    return `agent ${agentName} token: ${token}\n(store in the bridge credentials file; it is not shown again)`
  }
  if (a === 'device' && b === 'list') {
    const username = argv[2]
    if (!username) throw new Error(USAGE)
    const user = db.prepare('SELECT id FROM users WHERE name=?').get(username)
    if (!user) throw new Error(`no such user: ${username}`)
    const devices = db.prepare('SELECT id, kind, name, cursor, last_seen_at, private, private_pinned FROM devices WHERE user_id=? ORDER BY id').all(user.id)
    if (devices.length === 0) return `no devices for ${username}`
    return devices.map((d) =>
      `${d.id} kind=${d.kind} name=${d.name} cursor=${d.cursor} last_seen_at=${d.last_seen_at ?? 'never'}` +
      ` private=${d.private ? 'yes' : 'no'}${d.private_pinned ? ' (pinned)' : ''}`
    ).join('\n')
  }
  // Spec §8: "Revocation: delete the device/agent row; its socket is closed
  // on next frame." This just deletes the row — WS enforcement (the
  // per-frame device recheck) and HTTP (token-hash lookup per request) both
  // key off that row existing, so deleting it is the entire revocation.
  if (a === 'device' && b === 'revoke') {
    const deviceId = Number(argv[2])
    if (!Number.isInteger(deviceId)) throw new Error(USAGE)
    const existing = db.prepare('SELECT id FROM devices WHERE id=?').get(deviceId)
    if (!existing) throw new Error(`no such device: ${deviceId}`)
    revokeDevice(db, deviceId)
    return `device ${deviceId} revoked`
  }
  // Visibility flag override (spec: agent visibility & privacy). on/off PIN
  // the flag — the bridge's per-hello MATRON_AGENT_PRIVATE assertion is
  // ignored until `auto` releases it. This is what makes admin authoritative:
  // a deploy that forgot the env var cannot unmark a pinned machine.
  if (a === 'device' && b === 'private') {
    const deviceId = Number(argv[2])
    const mode = argv[3]
    if (!Number.isInteger(deviceId) || !['on', 'off', 'auto'].includes(mode)) throw new Error(USAGE)
    const existing = db.prepare('SELECT id FROM devices WHERE id=?').get(deviceId)
    if (!existing) throw new Error(`no such device: ${deviceId}`)
    if (mode === 'auto') {
      unpinDevicePrivate(db, deviceId)
      return `device ${deviceId} privacy unpinned — the flag now follows the bridge's hello assertion (MATRON_AGENT_PRIVATE) from its next connect`
    }
    pinDevicePrivate(db, deviceId, mode === 'on')
    return `device ${deviceId} pinned private=${mode} — the bridge's hello assertion is ignored until 'auto' releases it`
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
