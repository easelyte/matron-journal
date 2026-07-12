// Protocol conformance suite (spec §12).
//
// Replays every golden fixture in test/fixtures/conformance/*.json against a
// fresh, real, in-process matron-journal server and asserts the exchange
// matches exactly, modulo the tiny variable convention documented in
// test/fixtures/conformance/README.md ($bind / $ref / $type / $ignore).
//
// This file IS the reference matcher implementation — the Matron Swift test
// harness re-implements `match()`/`resolve()` below (they're intentionally
// short) to replay the same fixtures against the same server.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { startServer } from '../src/server.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'conformance')

// ---------------------------------------------------------------------------
// The matcher. Four rules, applied uniformly to HTTP bodies, HTTP headers,
// and WS frames:
//   {"$bind": "name"}  — matches anything; records the actual value under
//                         `name` in the shared bindings map for later $ref.
//   {"$ref": "name"}   — must deep-equal the value previously bound to `name`.
//   {"$type": "T"}     — matches when the actual value's type is T, one of
//                         integer|number|string|boolean|null|array|object.
//   {"$ignore": true}  — matches anything; not recorded.
// Any plain object must match the actual value's key set EXACTLY (no extra,
// no missing) — every other key is matched recursively. Arrays must match
// length and every element, in order. Everything else is compared with ===.
// ---------------------------------------------------------------------------

function typeMatches(actual, typeStr) {
  switch (typeStr) {
    case 'integer': return typeof actual === 'number' && Number.isInteger(actual)
    case 'number': return typeof actual === 'number'
    case 'string': return typeof actual === 'string'
    case 'boolean': return typeof actual === 'boolean'
    case 'null': return actual === null
    case 'array': return Array.isArray(actual)
    case 'object': return actual !== null && typeof actual === 'object' && !Array.isArray(actual)
    default: throw new Error(`unknown $type: ${typeStr}`)
  }
}

function isVarNode(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x) &&
    ('$bind' in x || '$ref' in x || '$type' in x || '$ignore' in x)
}

// Plain-value deep-equal, used to check a $ref against its bound value (both
// sides here are real captured JSON, never variable nodes).
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a === 'object') {
    const ak = Object.keys(a).sort()
    const bk = Object.keys(b).sort()
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false
    return ak.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

export function match(expected, actual, bindings, at = '$') {
  if (isVarNode(expected)) {
    if ('$ignore' in expected) return { ok: true }
    if ('$bind' in expected) { bindings[expected.$bind] = actual; return { ok: true } }
    if ('$ref' in expected) {
      const name = expected.$ref
      if (!(name in bindings)) return { ok: false, reason: `${at}: $ref '${name}' is unbound` }
      return deepEqual(bindings[name], actual)
        ? { ok: true }
        : { ok: false, reason: `${at}: expected $ref '${name}' = ${JSON.stringify(bindings[name])}, got ${JSON.stringify(actual)}` }
    }
    if ('$type' in expected) {
      return typeMatches(actual, expected.$type)
        ? { ok: true }
        : { ok: false, reason: `${at}: expected $type '${expected.$type}', got ${JSON.stringify(actual)}` }
    }
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return { ok: false, reason: `${at}: expected an array, got ${JSON.stringify(actual)}` }
    if (expected.length !== actual.length) return { ok: false, reason: `${at}: expected array length ${expected.length}, got ${actual.length}` }
    for (let i = 0; i < expected.length; i++) {
      const r = match(expected[i], actual[i], bindings, `${at}[${i}]`)
      if (!r.ok) return r
    }
    return { ok: true }
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return { ok: false, reason: `${at}: expected an object, got ${JSON.stringify(actual)}` }
    }
    const ek = Object.keys(expected).sort()
    const ak = Object.keys(actual).sort()
    if (ek.length !== ak.length || ek.some((k, i) => k !== ak[i])) {
      return { ok: false, reason: `${at}: key set mismatch — expected [${ek}], got [${ak}]` }
    }
    for (const k of ek) {
      const r = match(expected[k], actual[k], bindings, `${at}.${k}`)
      if (!r.ok) return r
    }
    return { ok: true }
  }
  return expected === actual
    ? { ok: true }
    : { ok: false, reason: `${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` }
}

// The inverse direction: fixture -> outbound wire value. Only $ref is legal
// here (there is nothing to "bind" or "type-check" about a value the fixture
// itself is choosing to send).
function resolve(template, bindings) {
  if (template !== null && typeof template === 'object' && !Array.isArray(template) && '$ref' in template) {
    const name = template.$ref
    if (!(name in bindings)) throw new Error(`$ref '${name}' is unbound`)
    return bindings[name]
  }
  if (Array.isArray(template)) return template.map((v) => resolve(v, bindings))
  if (template !== null && typeof template === 'object') {
    const out = {}
    for (const k of Object.keys(template)) out[k] = resolve(template[k], bindings)
    return out
  }
  return template
}

// A separate, tiny, string-only templating mechanism for URL paths and
// header values (where a `{"$ref": ...}` object can't be embedded inline in
// a JSON string): `${name}` is replaced with String(bindings[name]).
function resolveString(s, bindings) {
  return s.replace(/\$\{([^}]+)\}/g, (_, name) => {
    if (!(name in bindings)) throw new Error(`'\${${name}}' is unbound`)
    return String(bindings[name])
  })
}

// ---------------------------------------------------------------------------
// Seeding — direct DB/helper setup for fixture preconditions. Not part of the
// wire protocol under test (mirrors how the existing unit tests seed via
// createUser/createAgent/upsertConversation/append directly).
// ---------------------------------------------------------------------------

async function applySeed(s, seed = {}) {
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
    upsertConversation(s.db, { id: c.id, ownerUserId: owner.id, title: c.title, sessionState: c.sessionState })
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

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

async function openConn(s, conns, name) {
  const ws = new WebSocket(s.base.replace(/^http/, 'ws') + '/ws')
  const rec = { ws, frames: [], nextIdx: 0, closed: false, closeCode: undefined }
  ws.on('message', (d) => { rec.frames.push(JSON.parse(d)) })
  ws.on('close', (code) => { rec.closed = true; rec.closeCode = code })
  conns[name] = rec
  await new Promise((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
}

async function doHttp(s, step, bindings) {
  const method = step.method || 'GET'
  const urlPath = resolveString(step.path, bindings)
  const headers = {}
  if (step.token !== undefined) headers.authorization = `Bearer ${resolve(step.token, bindings)}`
  for (const [k, v] of Object.entries(step.headers || {})) headers[k] = resolveString(String(v), bindings)
  let body
  if (step.body_base64 !== undefined) {
    body = Buffer.from(step.body_base64, 'base64')
    if (step.content_type && !headers['content-type']) headers['content-type'] = step.content_type
  } else if (step.body !== undefined) {
    body = JSON.stringify(resolve(step.body, bindings))
    headers['content-type'] = headers['content-type'] || 'application/json'
  }
  const res = await fetch(s.base + urlPath, { method, headers, body })
  const ct = res.headers.get('content-type') || ''
  let json = null
  let buf = null
  if (ct.includes('application/json')) {
    try { json = await res.json() } catch { json = null }
  } else {
    buf = Buffer.from(await res.arrayBuffer())
  }
  const exp = step.expect || {}
  if (exp.status !== undefined) assert.equal(res.status, exp.status, `expected status ${exp.status}, got ${res.status}`)
  if (exp.headers) {
    for (const [k, v] of Object.entries(exp.headers)) {
      const r = match(v, res.headers.get(k), bindings, `headers.${k}`)
      assert.ok(r.ok, r.reason)
    }
  }
  if (exp.body !== undefined) {
    const r = match(exp.body, json, bindings, 'body')
    assert.ok(r.ok, `${r.reason}\nfull actual body: ${JSON.stringify(json)}`)
  }
  if (exp.body_base64 !== undefined) {
    const expectedBuf = Buffer.from(exp.body_base64, 'base64')
    assert.ok(buf && buf.equals(expectedBuf), 'binary response body did not match expect.body_base64')
  }
}

async function expectFrame(conn, step, bindings, timeoutMs = 2000) {
  if (!conn) throw new Error('ws_expect: no such connection (ws_open/ws_send it first)')
  const t0 = Date.now()
  while (conn.nextIdx >= conn.frames.length) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`timed out waiting for a frame (received so far: ${JSON.stringify(conn.frames.slice(conn.nextIdx))})`)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  const actual = conn.frames[conn.nextIdx]
  conn.nextIdx++
  const r = match(step.frame, actual, bindings, 'frame')
  assert.ok(r.ok, `${r.reason}\nfull actual frame: ${JSON.stringify(actual)}`)
}

async function expectNoFrame(conn, step) {
  if (!conn) throw new Error('ws_expect_none: no such connection')
  await new Promise((r) => setTimeout(r, step.ms || 200))
  assert.equal(
    conn.nextIdx, conn.frames.length,
    `expected no new frame, but got: ${JSON.stringify(conn.frames.slice(conn.nextIdx))}`
  )
}

async function expectClose(conn, step, timeoutMs = 2000) {
  if (!conn) throw new Error('ws_expect_close: no such connection')
  const t0 = Date.now()
  while (!conn.closed) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for the connection to close')
    await new Promise((r) => setTimeout(r, 10))
  }
  if (step.code !== undefined) assert.equal(conn.closeCode, step.code, `expected close code ${step.code}, got ${conn.closeCode}`)
}

async function runSteps(s, steps, bindings) {
  const conns = {}
  for (const [i, step] of steps.entries()) {
    try {
      switch (step.kind) {
        case 'http':
          await doHttp(s, step, bindings)
          break
        case 'ws_open':
          await openConn(s, conns, step.conn)
          break
        case 'ws_send': {
          const conn = conns[step.conn]
          if (!conn) throw new Error(`no open connection named '${step.conn}'`)
          conn.ws.send(JSON.stringify(resolve(step.frame, bindings)))
          break
        }
        case 'ws_expect':
          await expectFrame(conns[step.conn], step, bindings)
          break
        case 'ws_expect_none':
          await expectNoFrame(conns[step.conn], step)
          break
        case 'ws_expect_close':
          await expectClose(conns[step.conn], step)
          break
        case 'wait':
          await new Promise((r) => setTimeout(r, step.ms))
          break
        case 'admin_revoke_device': {
          // Out-of-band operational action (what `matron-admin device
          // revoke` does), not a wire message — see the README.
          const deviceId = resolve(step.device_id, bindings)
          s.db.prepare('DELETE FROM devices WHERE id=?').run(deviceId)
          break
        }
        default:
          throw new Error(`unknown step kind '${step.kind}'`)
      }
    } catch (e) {
      e.message = `step[${i}] (${step.kind}): ${e.message}`
      throw e
    }
  }
  for (const conn of Object.values(conns)) {
    try { conn.ws.close() } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// Fixture discovery + execution
// ---------------------------------------------------------------------------

const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json')).sort()

test('at least one conformance fixture is present', () => {
  assert.ok(files.length > 0, `no *.json fixtures found in ${FIXTURES_DIR}`)
})

for (const file of files) {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'))
  test(`conformance: ${fixture.name} (${file})`, async (t) => {
    const serverCfg = { ...(fixture.server || {}) }
    let tmpDir = null
    if (serverCfg.tmpDb) {
      delete serverCfg.tmpDb
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-conformance-'))
      serverCfg.dbPath = path.join(tmpDir, 'test.db')
    } else {
      serverCfg.dbPath = ':memory:'
    }
    const s = await startServer({ port: 0, ...serverCfg })
    t.after(async () => {
      await s.close()
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    })
    s.base = `http://127.0.0.1:${s.port}`
    const bindings = await applySeed(s, fixture.seed)
    await runSteps(s, fixture.steps, bindings)
  })
}
