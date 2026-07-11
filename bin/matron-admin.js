#!/usr/bin/env node
import fs, { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.js'
import { createUser, setPassword, createAgent } from '../src/auth.js'
import { resolveMediaDir } from '../src/media.js'
import { runOffload } from '../src/retention.js'

const USAGE = `usage:
  matron-admin user add <name> --password <pw>
  matron-admin user passwd <name> --password <pw>
  matron-admin agent add <username> <agent-name>
  matron-admin offload [--days N]
  matron-admin status`

function flag(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
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
  if (a === 'offload') {
    const daysFlag = flag(argv, '--days')
    const days = daysFlag != null ? Number(daysFlag) : 30
    if (!Number.isInteger(days) || days < 0) throw new Error(USAGE)
    const mediaDir = resolveMediaDir(db.name)
    const r = runOffload(db, { days, mediaDir })
    return `offloaded ${r.offloaded} tool_output payload(s) older than ${days}d`
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
