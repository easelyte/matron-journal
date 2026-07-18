#!/usr/bin/env node
import fs, { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import qrcode from 'qrcode-terminal'
import { openDb } from '../src/db.js'
import { createUser, setPassword, createAgent, revokeDevice } from '../src/auth.js'
import { resolveMediaDir } from '../src/media.js'
import { resolvePreapproveKeyPath } from '../src/preapprove-key.js'
import { runOffload, runExpireLogs } from '../src/retention.js'

const USAGE = `usage:
  matron-admin user add <name> --password <pw>
  matron-admin user passwd <name> --password <pw>
  matron-admin agent add <username> <agent-name>
  matron-admin device list <username>
  matron-admin device revoke <device_id>
  matron-admin link-code <username> --server-url <url> [--port <n>]
  matron-admin offload [--days N]
  matron-admin expire-logs [--hours N]
  matron-admin status`

function flag(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
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

export async function runAdmin(db, argv) {
  const [a, b] = argv
  if (a === 'user' && b === 'add') {
    const name = argv[2]
    const pw = flag(argv, '--password')
    if (!name || !pw) throw new Error(USAGE)
    const u = await createUser(db, name, pw)
    return `user ${name} created (id ${u.id})`
  }
  if (a === 'user' && b === 'passwd') {
    const name = argv[2]
    const pw = flag(argv, '--password')
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
    const devices = db.prepare('SELECT id, kind, name, cursor, last_seen_at FROM devices WHERE user_id=? ORDER BY id').all(user.id)
    if (devices.length === 0) return `no devices for ${username}`
    return devices.map((d) => `${d.id} kind=${d.kind} name=${d.name} cursor=${d.cursor} last_seen_at=${d.last_seen_at ?? 'never'}`).join('\n')
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
  if (a === 'link-code') {
    const username = argv[1]
    const serverUrl = flag(argv, '--server-url')
    if (!username || !serverUrl) throw new Error(USAGE)
    if (!isValidServerUrl(serverUrl)) {
      throw new Error(`${USAGE}\n\ninvalid --server-url: must be https://, or http:// to localhost only, max 200 chars (got ${JSON.stringify(serverUrl)})`)
    }
    const port = Number(flag(argv, '--port') ?? process.env.MATRON_PORT ?? 9810)
    if (!Number.isInteger(port) || port <= 0) throw new Error(`${USAGE}\n\n--port must be a positive integer`)
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
        body: JSON.stringify({ username }),
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
    const { link_code, expires_in } = await r.json()
    const uri = `matron://link?v=1&server=${encodeURIComponent(serverUrl)}&code=${link_code}`
    const qr = await new Promise((resolve) => qrcode.generate(uri, { small: true }, resolve))
    return [
      qr,
      `Scan with the Matron app to sign in as ${username}.`,
      'Or enter it manually on the sign-in screen:',
      `  server: ${serverUrl}`,
      `  code:   ${link_code}`,
      `(${uri})`,
      // expires_in may be absent from an older/nonstandard journal response;
      // print the code either way rather than "expires in NaN minutes".
      Number.isFinite(expires_in) ? `The code expires in ${Math.round(expires_in / 60)} minutes and works once.` : 'The code works once.',
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
