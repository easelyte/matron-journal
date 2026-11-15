// Boots a seeded journal for one conformance fixture, in process. Shared by
// the conformance test, the replay coordinator and tools/conformance-server.js.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../../src/server.js'
import { createUser, createAgent } from '../../src/auth.js'
import { upsertConversation, append } from '../../src/journal.js'

// Test-only preconditions, applied through src/auth.js and src/journal.js
// before any step runs. This is setup, not protocol traffic under test.
export async function applySeed(s, seed = {}) {
  const bindings = {}
  const usersByAs = {}
  const convoOwnerAs = {}
  for (const u of seed.users || []) {
    const rec = await createUser(s.db, u.name, u.password)
    usersByAs[u.as] = rec
    bindings[`${u.as}.user_id`] = rec.id
  }
  for (const a of seed.agents || []) {
    const owner = usersByAs[a.user]
    if (!owner) throw new Error(`seed.agents: unknown user '${a.user}'`)
    const rec = createAgent(s.db, owner.id, a.name)
    bindings[`${a.as}.token`] = rec.token
    bindings[`${a.as}.device_id`] = rec.deviceId
  }
  for (const c of seed.conversations || []) {
    const owner = usersByAs[c.owner]
    if (!owner) throw new Error(`seed.conversations: unknown user '${c.owner}'`)
    convoOwnerAs[c.id] = c.owner
    // `agent` (an `as` name from seed.agents, already bound above) makes that
    // agent the conversation's manager (agent_device_id), needed by any step
    // where an agent caller must pass authorizeAgentWrite against this convo.
    const agentDeviceId = c.agent ? bindings[`${c.agent}.device_id`] : undefined
    if (c.agent && agentDeviceId === undefined) throw new Error(`seed.conversations: unknown agent '${c.agent}'`)
    upsertConversation(s.db, { id: c.id, ownerUserId: owner.id, title: c.title, sessionState: c.sessionState, agentDeviceId })
  }
  for (const e of seed.events || []) {
    const ownerAs = convoOwnerAs[e.convo]
    if (!ownerAs) throw new Error(`seed.events: unknown convo '${e.convo}' (seed conversations first)`)
    append(s.db, {
      userId: usersByAs[ownerAs].id, convoId: e.convo, sender: e.sender,
      type: e.type, payload: e.payload, idemKey: e.idemKey ?? null,
    })
  }
  return bindings
}

// Server overrides: `fixture.server`, then `overrides` (flags or env vars in
// the CLI) on top. `dbPath` is never taken from a fixture.
export const OVERRIDE_KEYS = ['maxReplay', 'mediaMaxBytes', 'tmpDb']

export async function bootFixtureServer(fixture, overrides = {}) {
  // Default to no embedder so a run never loads or downloads a real model.
  const cfg = { embedder: null, backgroundDelayMs: 0, backgroundPace: 0, ...(fixture.server || {}) }
  for (const k of OVERRIDE_KEYS) if (overrides[k] !== undefined) cfg[k] = overrides[k]
  let tmpDir = null
  if (cfg.tmpDb) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-conformance-'))
    cfg.dbPath = path.join(tmpDir, 'test.db')
  } else {
    cfg.dbPath = ':memory:'
  }
  delete cfg.tmpDb
  let s
  let bindings
  try {
    s = await startServer({ port: 0, ...cfg })
    s.base = `http://127.0.0.1:${s.port}`
    bindings = await applySeed(s, fixture.seed)
  } catch (e) {
    if (s) await s.close().catch(() => {})
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    throw e
  }
  const base = s.base
  // Out-of-band operational actions a fixture's admin steps ask for.
  const control = {
    async revokeDevice(deviceId) {
      s.db.prepare('DELETE FROM devices WHERE id=?').run(deviceId)
    },
  }
  return {
    server: s,
    base,
    bindings,
    control,
    async close() {
      await s.close()
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

// A control socket (unix domain) that runs admin steps for an out-of-process
// coordinator or client. One JSON object per line in, one JSON line out:
//   {"op":"admin_revoke_device","device_id":3}  ->  {"ok":true}
export function serveControl(control, socketPath) {
  const srv = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        handle(line).then((out) => sock.write(JSON.stringify(out) + '\n'))
      }
    })
    sock.on('error', () => {})
  })
  async function handle(line) {
    try {
      const msg = JSON.parse(line)
      if (msg.op === 'admin_revoke_device') {
        await control.revokeDevice(msg.device_id)
        return { ok: true }
      }
      return { ok: false, error: `unknown op '${msg.op}'` }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }
  return new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(socketPath, () => resolve(srv))
  })
}

// The coordinator's side of the control socket.
export function connectControl(socketPath) {
  return {
    revokeDevice(deviceId) {
      return new Promise((resolve, reject) => {
        const sock = net.createConnection(socketPath)
        let buf = ''
        let settled = false
        const settle = (fn, v) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          sock.destroy()
          fn(v)
        }
        const timer = setTimeout(() => settle(reject, new Error('control socket did not answer')), 5000)
        sock.on('connect', () => sock.write(JSON.stringify({ op: 'admin_revoke_device', device_id: deviceId }) + '\n'))
        sock.on('data', (d) => {
          buf += d
          if (!buf.includes('\n')) return
          let out
          try { out = JSON.parse(buf.split('\n')[0]) } catch { return settle(reject, new Error('control socket sent a malformed reply')) }
          out.ok ? settle(resolve) : settle(reject, new Error(out.error))
        })
        sock.on('close', () => settle(reject, new Error('control socket closed before answering')))
        sock.on('error', (e) => settle(reject, e))
      })
    },
  }
}
