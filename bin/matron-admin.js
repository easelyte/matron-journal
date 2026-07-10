#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.js'
import { createUser, setPassword, createAgent } from '../src/auth.js'

const USAGE = `usage:
  matron-admin user add <name> --password <pw>
  matron-admin user passwd <name> --password <pw>
  matron-admin agent add <username> <agent-name>
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
  if (a === 'status') {
    const rows = db.prepare(
      `SELECT u.name,
         (SELECT COUNT(*) FROM devices d WHERE d.user_id=u.id AND d.kind='client') AS devices,
         (SELECT COUNT(*) FROM devices d WHERE d.user_id=u.id AND d.kind='agent') AS agents,
         COALESCE((SELECT seq FROM user_seq s WHERE s.user_id=u.id), 0) AS head_seq
       FROM users u ORDER BY u.name`
    ).all()
    const total = db.prepare('SELECT COUNT(*) n FROM events').get().n
    return rows.map((r) => `${r.name} devices=${r.devices} agents=${r.agents} head_seq=${r.head_seq}`)
      .concat(`total events: ${total}`).join('\n')
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
