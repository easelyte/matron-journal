// Seed a matron-journal with marketing-quality demo conversations (the App
// Review / screenshot account). Agent events go over an agent WS
// (publish/convo_upsert/status); the user's own messages go over a client
// WS (send), so senders and alignment match production exactly. Each append
// is awaited via a listener socket before the next is sent, so cross-socket
// ordering is deterministic.
//
// Env: MATRON_DEMO_WS (default ws://127.0.0.1:9810/ws),
//      MATRON_DEMO_AGENT_TOKEN (mac-studio), MATRON_DEMO_CLIENT_TOKEN.
import WebSocket from 'ws'

const WS_URL = process.env.MATRON_DEMO_WS || 'ws://127.0.0.1:9810/ws'
const AGENT_TOKEN = process.env.MATRON_DEMO_AGENT_TOKEN
const CLIENT_TOKEN = process.env.MATRON_DEMO_CLIENT_TOKEN
if (!AGENT_TOKEN || !CLIENT_TOKEN) {
  console.error('seed: MATRON_DEMO_AGENT_TOKEN and MATRON_DEMO_CLIENT_TOKEN must be set')
  process.exit(1)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.on('error', reject)
    ws.on('open', () => {
      ws.send(JSON.stringify({ op: 'hello', token, cursor: null }))
    })
    ws.on('message', function onMsg(raw) {
      const f = JSON.parse(raw.toString())
      if (f.kind === 'control' && f.op === 'hello_ok') { ws.off('message', onMsg); resolve(ws) }
      if (f.kind === 'control' && f.op === 'error') reject(new Error(raw.toString()))
    })
  })
}

// Listener: resolves a waiter per journal frame, in arrival order.
const waiters = []
function nextAppend() { return new Promise(r => waiters.push(r)) }

const [agent, client, listener] = await Promise.all([
  connect(AGENT_TOKEN), connect(CLIENT_TOKEN), connect(CLIENT_TOKEN),
])
listener.on('message', (raw) => {
  const f = JSON.parse(raw.toString())
  if (f.kind === 'journal') { const w = waiters.shift(); if (w) w(f) }
})

let idem = 0
async function publish(convoId, type, payload) {
  const p = nextAppend()
  agent.send(JSON.stringify({ op: 'publish', convo_id: convoId, type, payload, idem_key: `seed-${idem++}` }))
  return p
}
async function userSend(convoId, body) {
  const p = nextAppend()
  client.send(JSON.stringify({ op: 'send', convo_id: convoId, type: 'text', payload: { body }, local_id: `seed-local-${idem++}` }))
  return p
}
async function upsert(convoId, title, state, parent) {
  const msg = { op: 'convo_upsert', convo_id: convoId, title, session_state: state }
  if (parent) msg.parent_convo_id = parent
  agent.send(JSON.stringify(msg))
  await sleep(120) // upsert may or may not append (convo_meta); don't await a frame
}
async function settle() { await sleep(200); waiters.length = 0 }

function status(convoId, model, tokens, window_, pct) {
  agent.send(JSON.stringify({ op: 'status', convo_id: convoId, status: {
    model, context: { tokens, window: window_, pct },
    limits: [{ label: 'Session', percent: 31 }, { label: 'Week', percent: 62 }],
  } }))
}
async function readAll(convoId) {
  client.send(JSON.stringify({ op: 'read_marker', convo_id: convoId, up_to_seq: null }))
  await sleep(150); waiters.length = 0
}

const ok = (command, snippet) => ({ command, exit_code: 0, snippet, truncated: false })
const fail = (command, snippet) => ({ command, exit_code: 1, snippet, truncated: false })
const richTool = (tool, args, result) => ({
  tool, status: 'ok', args, result, started_at: Date.now() - 4000, ended_at: Date.now(),
})

// ---------------------------------------------------------------- convo E + child
const E = 'demo-refactor-auth'
await upsert(E, 'Refactor auth middleware', 'done')
await settle()
await userSend(E, 'Split the auth middleware into token verification and role checks — it does too much.')
await publish(E, 'text', { body: "Agreed, it's doing four jobs. I'll extract `verifyToken` and `requireRole` and fan out an explorer to find every call site first." })
const EC = `${E}:sub:explore-1`
await upsert(EC, 'Explore: auth call sites', 'done', E)
await settle()
await publish(EC, 'tool_output', { command: 'grep -rn "authMiddleware" src/ --include="*.ts"', exit_code: 0, snippet: 'src/routes/api.ts:14\nsrc/routes/admin.ts:9\nsrc/routes/webhooks.ts:22\nsrc/server.ts:31\n4 call sites, 2 pass role options', truncated: false })
await publish(EC, 'text', { body: 'Four call sites. Only `admin.ts` and `api.ts` use role options — webhooks and server bootstrap take the default. Safe to split with a two-step deprecation.' })
await publish(E, 'diff', {
  file_path: 'src/middleware/auth.ts', display_path: 'src/middleware/auth.ts', tool: 'Edit',
  diff: '@@ -12,9 +12,7 @@\n-export function authMiddleware(opts: AuthOptions) {\n-  // verifies token, checks roles, logs, and rate-limits\n-  return async (req, res, next) => {\n+export const verifyToken = () => tokenGuard\n+export const requireRole = (role: Role) => roleGuard(role)',
  added: 2, removed: 3, truncated: false, new_file: false,
})
await publish(E, 'text', { body: 'Done. `verifyToken` and `requireRole` are separate exports, all four call sites migrated, and the old `authMiddleware` re-exports both with a deprecation notice. 92 tests green.' })
await readAll(E); await readAll(EC)

// ---------------------------------------------------------------- convo D
const D = 'demo-dep-audit'
await upsert(D, 'Weekly dependency audit', 'done')
await settle()
await userSend(D, 'Anything risky in this week’s dependency updates?')
await publish(D, 'tool_output', ok('npm audit --omit dev', 'found 0 vulnerabilities'))
await publish(D, 'tool_output', ok('npm outdated', 'ws        8.17.0 → 8.18.2  (patch)\nfastify   4.26.1 → 4.28.0  (minor)\nzod       3.23.4 → 3.23.8  (patch)'))
await publish(D, 'text', { body: 'Nothing risky: zero advisories, three routine bumps. The `fastify` minor is the only one touching request parsing — its changelog is additive. Want me to open the update PR?' })
await readAll(D)

// ---------------------------------------------------------------- convo C (running)
const C = 'demo-postgres-migration'
await upsert(C, 'Migrate database to Postgres 16', 'running')
await settle()
await userSend(C, 'Start the Postgres 16 migration on staging — take a snapshot first.')
await publish(C, 'tool_output', ok('pg_dump --snapshot staging_db > pre_migration.sql', 'Snapshot complete: 2.4 GB written in 3m 12s'))
await publish(C, 'text', { body: 'Snapshot taken and verified. Running the version upgrade now — 14 of 31 migrations applied so far, no locks held longer than 200ms.' })
await publish(C, 'tool_output', ok('./migrate.sh --target 16 --step 15', 'migration 15/31: rewriting index concurrently… done (41s)'))
status(C, 'claude-fable-5', 96500, 200000, 48)
await readAll(C)

// ---------------------------------------------------------------- convo B
const B = 'demo-dark-mode'
await upsert(B, 'Dark mode for settings screen', 'done')
await settle()
await userSend(B, 'The settings screen ignores the system appearance — can you add dark mode support?')
await publish(B, 'tool_output', richTool('Read', { file_path: 'Settings/SettingsView.swift' }, '182 lines'))
await publish(B, 'diff', {
  file_path: 'Settings/SettingsView.swift', display_path: 'Settings/SettingsView.swift', tool: 'Edit',
  diff: '@@ -24,7 +24,7 @@\n-        .background(Color.white)\n-        .foregroundColor(.black)\n+        .background(Color(.systemBackground))\n+        .foregroundColor(.primary)',
  added: 2, removed: 2, truncated: false, new_file: false,
})
await publish(B, 'text', { body: 'Fixed — the screen was hard-coding `Color.white`. It now uses semantic system colors, so it follows the appearance setting automatically. Checked both modes in the simulator.' })
await readAll(B)

// ---------------------------------------------------------------- convo A (hero, unread, waiting)
const A = 'demo-flaky-upload'
await upsert(A, 'Fix the flaky upload test', 'waiting')
await settle()
await userSend(A, 'The upload spec keeps failing on CI but passes locally — can you take a look?')
await publish(A, 'text', { body: 'On it — running the suite a few times to reproduce first.' })
await publish(A, 'tool_output', fail('npm test -- uploads', 'FAIL test/upload.spec.ts\n  ● uploads › finishes a multipart upload\n    expected "done", received "pending"\n\nTests: 1 failed, 147 passed'))
await publish(A, 'text', { body: 'Reproduced on the third run — it’s a race. The test asserts right after a fixed 500ms sleep, but the upload worker occasionally takes longer on CI’s slower disks.' })
await publish(A, 'diff', {
  file_path: 'test/upload.spec.ts', display_path: 'test/upload.spec.ts', tool: 'Edit',
  diff: '@@ -41,5 +41,5 @@\n-    await sleep(500)\n-    expect(upload.status).toBe("done")\n+    await waitFor(() =>\n+      expect(upload.status).toBe("done"))',
  added: 2, removed: 2, truncated: false, new_file: false,
})
await publish(A, 'tool_output', ok('npm test -- uploads', 'PASS test/upload.spec.ts\n\nTests: 148 passed, 148 total\nTime:  4.21s'))
await publish(A, 'text', { body: 'Green — 148 passing, ran it five times to be sure. The fix replaces the fixed sleep with a proper `waitFor`, so it waits exactly as long as the worker needs.' })
await publish(A, 'prompt', { question: 'Push the fix and open a PR?', options: ['Open PR', 'Not yet'], allows_free_text: false })
status(A, 'claude-fable-5', 61400, 200000, 31)
// leave A unread (no read marker) so the list shows a badge

await sleep(300)
console.log('seeded')
process.exit(0)
