// Real-server harness for the File Explorer WRITE API (plan Phase 2,
// T-2.0..T-2.6). Same shape as files-http.test.js: startTestServer + a real
// fixture tree, asserted end-to-end over HTTP. The sweep at the bottom is
// T-2.6 — the cross-endpoint invariants no single endpoint owns.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { FILE_AUDIT_BASENAME } from '../src/file-audit.js'
import { makeIdemStore, sanitizeBasename } from '../src/files-write-http.js'
import { FileLinkDenied } from '../src/file-guard.js'

const TRASH = '.matron-trash'

// read-root/            <- browsable
//   writable/           <- the write-root (strictly inside the read-root)
//   readonly/           <- readable, never writable
function makeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'matron-w-')))
  const writeRoot = path.join(root, 'writable')
  const readOnly = path.join(root, 'readonly')
  fs.mkdirSync(writeRoot)
  fs.mkdirSync(readOnly)
  fs.writeFileSync(path.join(readOnly, 'locked.txt'), 'locked\n')
  fs.writeFileSync(path.join(writeRoot, 'existing.txt'), 'original\n')
  fs.mkdirSync(path.join(writeRoot, 'sub'))
  fs.writeFileSync(path.join(writeRoot, 'sub', 'nested.txt'), 'nested\n')
  const auditDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'matron-w-audit-')))
  return { root, writeRoot, readOnly, auditDir }
}

async function startWrites(f, extra = {}) {
  return startTestServer({
    fileReadRoots: [f.root],
    fileWriteRoots: [f.writeRoot],
    fileEnableWrites: true,
    fileAuditDir: f.auditDir,
    ...extra,
  })
}

async function clientToken(s, name = 'op', pw = 'pw') {
  const user = await createUser(s.db, name, pw)
  const r = await s.http('/login', { method: 'POST', body: { username: name, password: pw, device_name: 'x' } })
  return { token: r.json.token, user }
}

const call = (s, pathAndQuery, { method = 'POST', token, body, raw, headers = {} } = {}) =>
  fetch(s.base + pathAndQuery, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : raw,
  })

const auditLines = (f) => {
  const p = path.join(f.auditDir, FILE_AUDIT_BASENAME)
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

// A stable snapshot of every path under a directory, so "zero fs change" is an
// assertion about the tree rather than about the one file a test remembered.
function treeOf(dir) {
  const out = []
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      const rel = path.join(prefix, entry.name)
      if (entry.isDirectory()) { out.push(`d ${rel}`); walk(full, rel) } else { out.push(`f ${rel} ${fs.readFileSync(full).toString('base64')}`) }
    }
  }
  walk(dir, '')
  return out
}

const trashEntries = (writeRoot) => {
  const dir = path.join(writeRoot, TRASH)
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

const WRITE_ROUTES = (writeRoot) => [
  ['POST', `/files/upload?path=${encodeURIComponent(path.join(writeRoot, 'u.txt'))}`, undefined, 'hello'],
  ['POST', '/files/mkdir', { path: path.join(writeRoot, 'new-dir') }, undefined],
  ['POST', '/files/move', { from: path.join(writeRoot, 'existing.txt'), to: path.join(writeRoot, 'moved.txt') }, undefined],
  ['POST', '/files/write', { path: path.join(writeRoot, 'w.txt'), content: 'x' }, undefined],
  ['DELETE', `/files?path=${encodeURIComponent(path.join(writeRoot, 'existing.txt'))}&confirm=1`, undefined, undefined],
]

// --- T-2.0: the shared wiring ----------------------------------------------

test('T-2.0: every write route is 404 while the kill switch is off', async (t) => {
  const f = makeFixture()
  const s = await startTestServer({ fileReadRoots: [f.root], fileWriteRoots: [f.writeRoot], fileAuditDir: f.auditDir })
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const before = treeOf(f.root)

  for (const [method, route, body, raw] of WRITE_ROUTES(f.writeRoot)) {
    const r = await call(s, route, { method, token, body, raw })
    assert.equal(r.status, 404, `${method} ${route}`)
  }
  assert.deepEqual(treeOf(f.root), before)
  assert.deepEqual(auditLines(f), [])
  // The read half keeps working, and says the tree is not writable.
  const list = await (await call(s, `/files/list?path=${encodeURIComponent(f.writeRoot)}`, { method: 'GET', token })).json()
  assert.equal(list.writable, false)
})

test('T-2.0: writes stay disabled when there is nowhere to keep the audit log', async (t) => {
  const f = makeFixture()
  const warn = t.mock.method(console, 'warn', () => {})
  // dbPath ':memory:' has no data directory, and an unaudited write is not a
  // write this server will serve.
  const s = await startTestServer({
    fileReadRoots: [f.root], fileWriteRoots: [f.writeRoot], fileEnableWrites: true,
  })
  t.after(() => s.close())
  const { token } = await clientToken(s)
  assert.ok(warn.mock.calls.some((c) => new RegExp(FILE_AUDIT_BASENAME).test(c.arguments[0])))
  const r = await call(s, '/files/mkdir', { token, body: { path: path.join(f.writeRoot, 'nope') } })
  assert.equal(r.status, 404)
  assert.equal(fs.existsSync(path.join(f.writeRoot, 'nope')), false)
})

test('T-2.0: an agent device is forbidden from every write route', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { user } = await clientToken(s)
  const { token: agentToken } = createAgent(s.db, user.id, 'agent-1')
  const before = treeOf(f.root)

  for (const [method, route, body, raw] of WRITE_ROUTES(f.writeRoot)) {
    const r = await call(s, route, { method, token: agentToken, body, raw })
    assert.equal(r.status, 403, `${method} ${route}`)
  }
  assert.deepEqual(treeOf(f.root), before)
  assert.deepEqual(auditLines(f), [])
})

test('T-2.0: dry-run validates and audits the intent, changes nothing, and answers dry_run', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f, { fileWritesDryRun: true })
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const before = treeOf(f.root)

  for (const [method, route, body, raw] of WRITE_ROUTES(f.writeRoot)) {
    const r = await call(s, route, { method, token, body, raw })
    assert.equal(r.status, 200, `${method} ${route}`)
    assert.equal((await r.json()).dry_run, true, `${method} ${route}`)
  }
  assert.deepEqual(treeOf(f.root), before, 'dry-run must not touch the filesystem')
  const rows = auditLines(f)
  assert.equal(rows.length, WRITE_ROUTES(f.writeRoot).length * 2)   // intent + outcome
  assert.deepEqual(rows.filter((r) => r.result === 'attempt').map((r) => r.op),
    ['upload', 'mkdir', 'move', 'write', 'delete'])
  // The UI must not offer affordances that would silently no-op.
  const list = await (await call(s, `/files/list?path=${encodeURIComponent(f.writeRoot)}`, { method: 'GET', token })).json()
  assert.equal(list.writable, false)
})

test('T-2.0: a dry-run upload drains its body, so the keep-alive socket survives', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f, { fileWritesDryRun: true })
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  t.after(() => agent.destroy())

  const request = (options, payload) => new Promise((resolve, reject) => {
    const req = http.request({ ...options, agent, headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) } }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, body: data, reusedSocket: req.reusedSocket }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })

  const url = new URL(s.base)
  const target = encodeURIComponent(path.join(f.writeRoot, 'streamed.bin'))
  const first = await request({
    host: url.hostname, port: url.port, method: 'POST', path: `/files/upload?path=${target}`,
  }, 'x'.repeat(64 * 1024))
  assert.equal(first.status, 200)
  assert.equal(JSON.parse(first.body).dry_run, true)

  // The proof: the NEXT request rides the same socket and parses correctly.
  const second = await request({
    host: url.hostname, port: url.port, method: 'GET',
    path: `/files/list?path=${encodeURIComponent(f.writeRoot)}`,
  })
  assert.equal(second.status, 200)
  assert.equal(second.reusedSocket, true, 'the dry-run left the connection reusable')
  assert.ok(Array.isArray(JSON.parse(second.body).entries))
  assert.equal(fs.existsSync(path.join(f.writeRoot, 'streamed.bin')), false)
})

test('T-2.0: an audit append failure refuses with 507 and zero filesystem change', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const before = treeOf(f.root)
  // Take the audit directory away after boot: the intent line can no longer be
  // made durable, so the write must not happen at all.
  fs.rmSync(f.auditDir, { recursive: true, force: true })
  const error = t.mock.method(console, 'error', () => {})

  for (const [method, route, body, raw] of WRITE_ROUTES(f.writeRoot)) {
    const r = await call(s, route, { method, token, body, raw })
    assert.equal(r.status, 507, `${method} ${route}`)
    assert.deepEqual(await r.json(), { error: 'denied' })
  }
  assert.deepEqual(treeOf(f.root), before)
  assert.ok(error.mock.calls.length > 0, 'the refusal is loud server-side')
})

test('T-2.0: two concurrent retries of one Idempotency-Key perform one mutation', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const target = path.join(f.writeRoot, 'once.txt')
  const key = crypto.randomUUID()
  const send = () => call(s, '/files/write', {
    token, body: { path: target, content: 'only-once' }, headers: { 'idempotency-key': key },
  })

  const [a, b] = await Promise.all([send(), send()])
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.deepEqual(await a.json(), await b.json())
  assert.equal(fs.readFileSync(target, 'utf8'), 'only-once')
  // One mutation: a second write would have trashed the first version.
  assert.deepEqual(trashEntries(f.writeRoot), [])
  assert.equal(auditLines(f).filter((r) => r.result === 'attempt').length, 1)

  // A replay after completion returns the same answer without re-writing.
  const replay = await send()
  assert.equal(replay.status, 200)
  assert.deepEqual(trashEntries(f.writeRoot), [])
})

test('T-2.0: an Idempotency-Key reused for a DIFFERENT request is rejected, not replayed', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const key = crypto.randomUUID()

  const first = await call(s, '/files/write', {
    token, body: { path: path.join(f.writeRoot, 'a.txt'), content: 'a' }, headers: { 'idempotency-key': key },
  })
  assert.equal(first.status, 200)
  const second = await call(s, '/files/write', {
    token, body: { path: path.join(f.writeRoot, 'b.txt'), content: 'b' }, headers: { 'idempotency-key': key },
  })
  assert.equal(second.status, 409)
  assert.equal(fs.existsSync(path.join(f.writeRoot, 'b.txt')), false)

  // An unusable header is a 400, never silently ignored.
  const bad = await call(s, '/files/write', {
    token, body: { path: path.join(f.writeRoot, 'c.txt'), content: 'c' }, headers: { 'idempotency-key': 'x'.repeat(200) },
  })
  assert.equal(bad.status, 400)
  assert.equal(fs.existsSync(path.join(f.writeRoot, 'c.txt')), false)
})

test('T-2.0: the idempotency store is single-flight, fingerprinted, TTL-bounded and capped', async () => {
  let clock = 1000
  const store = makeIdemStore({ ttlMs: 100, max: 2, now: () => clock })
  let runs = 0
  const slow = () => new Promise((resolve) => setTimeout(() => { runs += 1; resolve('done') }, 10))

  const [a, b] = await Promise.all([store.run('k', 'fp', slow), store.run('k', 'fp', slow)])
  assert.equal(runs, 1)
  assert.equal(a, 'done')
  assert.equal(b, 'done')
  assert.throws(() => store.run('k', 'other-fp', slow), (e) => e instanceof FileLinkDenied && e.reason === 'idem-key-conflict')

  // A failed attempt is forgettable — the caller can genuinely retry.
  await assert.rejects(store.run('fails', 'fp', async () => { throw new Error('boom') }))
  let retried = false
  await store.run('fails', 'fp', async () => { retried = true })
  assert.equal(retried, true)

  clock += 1000                                  // everything expires
  await store.run('k', 'different-fp-now', slow) // the key is reusable again
  assert.equal(runs, 2)

  for (const key of ['c1', 'c2', 'c3', 'c4']) await store.run(key, 'fp', async () => key)
  assert.ok(store.size() <= 2, 'the store stays bounded')
})

// --- T-2.1: upload ---------------------------------------------------------

test('T-2.1: a denied upload target lands zero bytes on disk', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const before = treeOf(f.root)
  const payload = 'x'.repeat(4096)

  const cases = [
    [path.join(f.readOnly, 'escaped.bin'), 403],           // readable, not writable
    [path.join(f.writeRoot, '.env'), 403],                  // sensitive
    [path.join(f.writeRoot, TRASH, 'sneak.bin'), 403],      // the trash is not an API target
    [path.join(os.tmpdir(), 'outside.bin'), 403],           // outside every root
  ]
  for (const [target, status] of cases) {
    const r = await call(s, `/files/upload?path=${encodeURIComponent(target)}`, { token, raw: payload })
    assert.equal(r.status, status, target)
  }
  assert.deepEqual(treeOf(f.root), before, 'validation precedes streaming')
  assert.equal(auditLines(f).filter((r) => r.result === 'denied').length, cases.length)
})

test('T-2.1: streams a binary body into the write-root and sanitizes the basename', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x80]), crypto.randomBytes(200 * 1024)])

  const target = path.join(f.writeRoot, 'sub', 'photo.bin')
  const r = await call(s, `/files/upload?path=${encodeURIComponent(target)}`, { token, raw: bytes })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { path: target, bytes: bytes.length })
  assert.ok(fs.readFileSync(target).equals(bytes))

  const row = auditLines(f).find((a) => a.result === 'ok' && a.op === 'upload')
  assert.deepEqual(row, { ts: row.ts, deviceId: row.deviceId, op: 'upload', path: target, bytes: bytes.length, result: 'ok' })

  // The server owns the final component regardless of what the client sent.
  assert.equal(sanitizeBasename('/a/b/../evil'), 'evil')
  assert.equal(sanitizeBasename('/a/b/..'), null)
  assert.equal(sanitizeBasename('/a/b/'), 'b')   // a trailing slash is not a name
  assert.equal(sanitizeBasename('/'), null)
  assert.equal(sanitizeBasename('/a/b/keeps spaces-and.dots'), 'keeps spaces-and.dots')
})

test('T-2.1: an over-cap upload is 413 and leaves nothing behind', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f, { fileWriteMaxBytes: 1024 })
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const target = path.join(f.writeRoot, 'huge.bin')
  const before = treeOf(f.writeRoot)

  const over = await call(s, `/files/upload?path=${encodeURIComponent(target)}`, { token, raw: Buffer.alloc(4096) })
  assert.equal(over.status, 413)
  assert.equal(fs.existsSync(target), false)
  assert.deepEqual(treeOf(f.writeRoot), before, 'no temp file survives the cap')
  assert.ok(auditLines(f).some((a) => a.result === 'denied' && a.reason === 'too-large'))

  const under = await call(s, `/files/upload?path=${encodeURIComponent(target)}`, { token, raw: Buffer.alloc(512) })
  assert.equal(under.status, 200)
  assert.equal(fs.statSync(target).size, 512)
})

test('T-2.4: an oversized JSON write body is 413, not a 500', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const target = path.join(f.writeRoot, 'big.txt')

  const r = await call(s, '/files/write', { token, body: { path: target, content: 'x'.repeat(2 * 1024 * 1024) } })
  assert.equal(r.status, 413)
  assert.equal(fs.existsSync(target), false)
})

test('T-2.1: uploading over an existing file needs an explicit overwrite', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const target = path.join(f.writeRoot, 'existing.txt')

  const blocked = await call(s, `/files/upload?path=${encodeURIComponent(target)}`, { token, raw: 'replacement' })
  assert.equal(blocked.status, 409)
  assert.equal(fs.readFileSync(target, 'utf8'), 'original\n')

  const allowed = await call(s, `/files/upload?path=${encodeURIComponent(target)}&overwrite=1`, { token, raw: 'replacement' })
  assert.equal(allowed.status, 200)
  assert.equal(fs.readFileSync(target, 'utf8'), 'replacement')
  // Recoverable: the previous version is in the trash.
  const trashed = trashEntries(f.writeRoot)
  assert.equal(trashed.length, 1)
  assert.equal(fs.readFileSync(path.join(f.writeRoot, TRASH, trashed[0]), 'utf8'), 'original\n')
})

// --- T-2.2: mkdir ----------------------------------------------------------

test('T-2.2: mkdir creates nested directories, is idempotent, and refuses outside the write-root', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const target = path.join(f.writeRoot, 'a', 'b', 'c')

  const r = await call(s, '/files/mkdir', { token, body: { path: target } })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { path: target })
  assert.ok(fs.statSync(target).isDirectory())

  const again = await call(s, '/files/mkdir', { token, body: { path: target } })
  assert.equal(again.status, 200, 'an existing directory is the asked-for state')

  for (const [bad, status] of [
    [path.join(f.readOnly, 'nope'), 403],
    [path.join(f.writeRoot, '.ssh'), 403],
    [path.join(f.writeRoot, TRASH, 'nope'), 403],
    ['relative/path', 400],
  ]) {
    const bad_r = await call(s, '/files/mkdir', { token, body: { path: bad } })
    assert.equal(bad_r.status, status, bad)
  }
  // An existing FILE is a conflict, not a silent success.
  const overFile = await call(s, '/files/mkdir', { token, body: { path: path.join(f.writeRoot, 'existing.txt') } })
  assert.equal(overFile.status, 409)
  assert.ok(auditLines(f).some((a) => a.op === 'mkdir' && a.result === 'ok' && a.path === target))
})

// --- T-2.3: move -----------------------------------------------------------

test('T-2.3: move renames inside the write-root and refuses to clobber or escape', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const from = path.join(f.writeRoot, 'existing.txt')
  const to = path.join(f.writeRoot, 'sub', 'renamed.txt')

  const r = await call(s, '/files/move', { token, body: { from, to } })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { from, to })
  assert.equal(fs.existsSync(from), false)
  assert.equal(fs.readFileSync(to, 'utf8'), 'original\n')
  const row = auditLines(f).find((a) => a.op === 'move' && a.result === 'ok')
  assert.equal(row.path, from)
  assert.equal(row.to, to, 'the log answers "where did it go"')

  // dest-exists never clobbers.
  const clobber = await call(s, '/files/move', { token, body: { from: to, to: path.join(f.writeRoot, 'sub', 'nested.txt') } })
  assert.equal(clobber.status, 409)
  assert.equal(fs.readFileSync(path.join(f.writeRoot, 'sub', 'nested.txt'), 'utf8'), 'nested\n')

  for (const [body, status] of [
    [{ from: to, to: path.join(f.readOnly, 'escaped.txt') }, 403],
    [{ from: path.join(f.readOnly, 'locked.txt'), to: path.join(f.writeRoot, 'stolen.txt') }, 403],
    [{ from: to, to: path.join(f.writeRoot, 'secrets.json') }, 403],
    [{ from: to, to: path.join(f.writeRoot, TRASH, 'manual.txt') }, 403],
    [{ from: to }, 400],
  ]) {
    assert.equal((await call(s, '/files/move', { token, body })).status, status, JSON.stringify(body))
  }
  assert.equal(fs.readFileSync(to, 'utf8'), 'original\n')
})

// --- T-2.4: write ----------------------------------------------------------

test('T-2.4: write creates, refuses a bare overwrite, and keeps the prior version recoverable', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const fresh = path.join(f.writeRoot, 'sub', 'notes.md')

  const created = await call(s, '/files/write', { token, body: { path: fresh, content: '# notes\n' } })
  assert.equal(created.status, 200)
  assert.deepEqual(await created.json(), { path: fresh, bytes: 8 })
  assert.equal(fs.readFileSync(fresh, 'utf8'), '# notes\n')

  const blocked = await call(s, '/files/write', { token, body: { path: fresh, content: 'replaced' } })
  assert.equal(blocked.status, 409)
  assert.equal(fs.readFileSync(fresh, 'utf8'), '# notes\n')

  const replaced = await call(s, '/files/write', { token, body: { path: fresh, content: 'replaced', overwrite: true } })
  assert.equal(replaced.status, 200)
  assert.equal(fs.readFileSync(fresh, 'utf8'), 'replaced')
  const trashed = trashEntries(f.writeRoot)
  assert.equal(trashed.length, 1)
  assert.equal(fs.readFileSync(path.join(f.writeRoot, TRASH, trashed[0]), 'utf8'), '# notes\n')

  // R500: the log records the byte COUNT, never the bytes.
  const raw = fs.readFileSync(path.join(f.auditDir, FILE_AUDIT_BASENAME), 'utf8')
  assert.ok(!raw.includes('# notes'))
  assert.ok(!raw.includes('replaced'))
  assert.ok(auditLines(f).some((a) => a.op === 'write' && a.result === 'ok' && a.bytes === 8))

  for (const [body, status] of [
    [{ path: path.join(f.readOnly, 'x.md'), content: 'x' }, 403],
    [{ path: path.join(f.writeRoot, '.env'), content: 'SECRET=1' }, 403],
    [{ path: path.join(f.writeRoot, TRASH, 'x.md'), content: 'x' }, 403],
    [{ path: fresh }, 400],
    [{ path: fresh, content: 'x', overwrite: 'yes' }, 400],
    [{ path: fresh, content: 123 }, 400],
  ]) {
    assert.equal((await call(s, '/files/write', { token, body })).status, status, JSON.stringify(body))
  }
})

// --- T-2.5: delete ---------------------------------------------------------

test('T-2.5: delete moves into the trash, demands confirm, and guards non-empty directories', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const doomed = path.join(f.writeRoot, 'existing.txt')

  const unconfirmed = await call(s, `/files?path=${encodeURIComponent(doomed)}`, { method: 'DELETE', token })
  assert.equal(unconfirmed.status, 409)
  assert.ok(fs.existsSync(doomed))

  const r = await call(s, `/files?path=${encodeURIComponent(doomed)}&confirm=1`, { method: 'DELETE', token })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.path, doomed)
  assert.equal(body.already_missing, false)
  assert.ok(body.trashed.startsWith(path.join(f.writeRoot, TRASH) + path.sep))
  assert.equal(fs.existsSync(doomed), false)
  assert.equal(fs.readFileSync(body.trashed, 'utf8'), 'original\n', 'recoverable, never unlinked')
  const row = auditLines(f).find((a) => a.op === 'delete' && a.result === 'ok')
  assert.equal(row.to, body.trashed)

  // Idempotent: deleting what is already gone is the asked-for state, and the
  // response does NOT invent a trash path.
  const missing = await call(s, `/files?path=${encodeURIComponent(doomed)}&confirm=1`, { method: 'DELETE', token })
  assert.equal(missing.status, 200)
  assert.deepEqual(await missing.json(), { path: doomed, trashed: null, already_missing: true })

  // A non-empty directory needs recursive=1.
  const sub = path.join(f.writeRoot, 'sub')
  const guarded = await call(s, `/files?path=${encodeURIComponent(sub)}&confirm=1`, { method: 'DELETE', token })
  assert.equal(guarded.status, 409)
  assert.ok(fs.existsSync(sub))
  const recursive = await call(s, `/files?path=${encodeURIComponent(sub)}&confirm=1&recursive=1`, { method: 'DELETE', token })
  assert.equal(recursive.status, 200)
  assert.equal(fs.existsSync(sub), false)
  assert.equal(fs.readFileSync(path.join((await recursive.json()).trashed ?? '', 'nested.txt'), 'utf8'), 'nested\n')
})

test('T-2.5: the trash itself is not deletable, and it stays out of ordinary listings', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)

  // Put something in the trash first.
  await call(s, `/files?path=${encodeURIComponent(path.join(f.writeRoot, 'existing.txt'))}&confirm=1`, { method: 'DELETE', token })
  const trashDir = path.join(f.writeRoot, TRASH)
  assert.ok(fs.existsSync(trashDir))

  for (const target of [trashDir, path.join(trashDir, trashEntries(f.writeRoot)[0])]) {
    const r = await call(s, `/files?path=${encodeURIComponent(target)}&confirm=1&recursive=1`, { method: 'DELETE', token })
    assert.equal(r.status, 403, target)
  }
  assert.equal(trashEntries(f.writeRoot).length, 1, 'recoverability survives')

  // Deleting the write-root itself would take the trash with it.
  const rootDelete = await call(s, `/files?path=${encodeURIComponent(f.writeRoot)}&confirm=1&recursive=1`, { method: 'DELETE', token })
  assert.equal(rootDelete.status, 403)
  assert.ok(fs.existsSync(f.writeRoot))

  const listed = await (await call(s, `/files/list?path=${encodeURIComponent(f.writeRoot)}`, { method: 'GET', token })).json()
  assert.ok(!listed.entries.some((e) => e.name === TRASH))
})

// --- T-2.6: the cross-endpoint sweep ---------------------------------------

test('T-2.6: `writable` is true only inside a write-root, and never in the trash', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)
  await call(s, `/files?path=${encodeURIComponent(path.join(f.writeRoot, 'existing.txt'))}&confirm=1`, { method: 'DELETE', token })

  const writableOf = async (dir) =>
    (await (await call(s, `/files/list?path=${encodeURIComponent(dir)}&all=1`, { method: 'GET', token })).json()).writable

  assert.equal(await writableOf(f.writeRoot), true)
  assert.equal(await writableOf(path.join(f.writeRoot, 'sub')), true)
  assert.equal(await writableOf(f.readOnly), false)
  assert.equal(await writableOf(f.root), false)
  assert.equal(await writableOf(path.join(f.writeRoot, TRASH)), false)
})

test('T-2.6: no write route answers 502 — every denial comes from denialToStatus', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const outside = path.join(os.tmpdir(), 'nowhere.txt')
  const attempts = [
    ['POST', `/files/upload?path=${encodeURIComponent(outside)}`, undefined, 'x', 403],
    ['POST', '/files/mkdir', { path: outside }, undefined, 403],
    ['POST', '/files/move', { from: path.join(f.writeRoot, 'existing.txt'), to: outside }, undefined, 403],
    ['POST', '/files/write', { path: outside, content: 'x' }, undefined, 403],
    ['DELETE', `/files?path=${encodeURIComponent(outside)}&confirm=1`, undefined, undefined, 403],
    ['POST', '/files/write', { path: path.join(f.writeRoot, 'existing.txt'), content: 'x' }, undefined, 409],
    ['DELETE', `/files?path=${encodeURIComponent(path.join(f.writeRoot, 'sub'))}`, undefined, undefined, 409],
    ['POST', '/files/mkdir', { path: path.join(f.writeRoot, 'missing-parent-is-fine') }, undefined, 200],
  ]
  for (const [method, route, body, raw, status] of attempts) {
    const r = await call(s, route, { method, token, body, raw })
    assert.equal(r.status, status, `${method} ${route}`)
    assert.notEqual(r.status, 502)
  }
})

test('T-2.6: every attempt is audited, and no destructive 2xx exists without one', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)

  await call(s, '/files/mkdir', { token, body: { path: path.join(f.writeRoot, 'd') } })
  await call(s, '/files/write', { token, body: { path: path.join(f.writeRoot, 'd', 'x.txt'), content: 'hi' } })
  await call(s, '/files/move', { token, body: { from: path.join(f.writeRoot, 'd', 'x.txt'), to: path.join(f.writeRoot, 'd', 'y.txt') } })
  await call(s, `/files?path=${encodeURIComponent(path.join(f.writeRoot, 'd', 'y.txt'))}&confirm=1`, { method: 'DELETE', token })
  await call(s, '/files/write', { token, body: { path: path.join(f.readOnly, 'nope.txt'), content: 'x' } })

  const rows = auditLines(f)
  const attempts = rows.filter((r) => r.result === 'attempt')
  assert.deepEqual(attempts.map((r) => r.op), ['mkdir', 'write', 'move', 'delete', 'write'])
  // Every attempt is answered exactly once, and every one carries a device.
  assert.equal(rows.filter((r) => r.result !== 'attempt').length, attempts.length)
  assert.ok(rows.every((r) => Number.isInteger(r.deviceId) || typeof r.deviceId === 'string'))
  assert.equal(rows.filter((r) => r.result === 'denied').length, 1)
  // The intent for a destructive op is recorded BEFORE its outcome.
  const deleteIntent = rows.findIndex((r) => r.op === 'delete' && r.result === 'attempt')
  const deleteOutcome = rows.findIndex((r) => r.op === 'delete' && r.result === 'ok')
  assert.ok(deleteIntent >= 0 && deleteIntent < deleteOutcome)
})

// --- Codex round-1 findings F2/F3/F6 ---------------------------------------

test('F2: a write-root that overlaps server-owned state is refused at boot', async () => {
  const f = makeFixture()
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'matron-w-data-')))
  const dbPath = path.join(dataDir, 'matron.db')

  // The data directory itself — holds the DB, the preapprove key and the audit.
  await assert.rejects(
    startTestServer({ dbPath, fileReadRoots: [dataDir], fileWriteRoots: [dataDir], fileEnableWrites: true }),
    /overlaps server-owned state/,
  )
  // A root INSIDE the media tree is just as bad.
  const mediaDir = path.join(dataDir, 'media')
  fs.mkdirSync(path.join(mediaDir, 'ab'), { recursive: true })
  await assert.rejects(
    startTestServer({
      dbPath, mediaDir, fileReadRoots: [dataDir], fileWriteRoots: [path.join(mediaDir, 'ab')], fileEnableWrites: true,
    }),
    /overlaps server-owned state/,
  )
  // And an explicitly configured audit directory is protected the same way.
  await assert.rejects(
    startTestServer({
      dbPath: path.join(f.root, 'elsewhere.db'), mediaDir: path.join(f.root, 'media-elsewhere'),
      fileReadRoots: [f.root], fileWriteRoots: [f.writeRoot], fileEnableWrites: true,
      fileAuditDir: path.join(f.writeRoot, 'sub'),
    }),
    /overlaps server-owned state/,
  )
})

test('F3: an idempotent upload replay carrying DIFFERENT bytes is rejected, not replayed', async (t) => {
  const f = makeFixture()
  const s = await startWrites(f)
  t.after(() => s.close())
  const { token } = await clientToken(s)
  const target = path.join(f.writeRoot, 'payload.bin')
  const key = crypto.randomUUID()
  const send = (raw) => call(s, `/files/upload?path=${encodeURIComponent(target)}`, {
    token, raw, headers: { 'idempotency-key': key },
  })

  // Same length, different content — Content-Length alone could not tell these
  // apart, and the first body must not be reported as the second's result.
  const first = await send(Buffer.from('AAAAAAAA'))
  assert.equal(first.status, 200)
  assert.equal(fs.readFileSync(target, 'utf8'), 'AAAAAAAA')

  const impostor = await send(Buffer.from('BBBBBBBB'))
  assert.equal(impostor.status, 409)
  assert.equal(fs.readFileSync(target, 'utf8'), 'AAAAAAAA')

  // A genuine retry of the SAME bytes still replays cleanly, and writes once.
  const retry = await send(Buffer.from('AAAAAAAA'))
  assert.equal(retry.status, 200)
  assert.deepEqual(await retry.json(), { path: target, bytes: 8 })
  assert.deepEqual(trashEntries(f.writeRoot), [], 'the replay did not re-write the file')
  assert.equal(auditLines(f).filter((a) => a.op === 'upload' && a.result === 'attempt').length, 1)
})

test('F6: an in-flight reservation is never swept or evicted out from under itself', async () => {
  let clock = 0
  const store = makeIdemStore({ ttlMs: 10, max: 2, now: () => clock })
  let release
  const slow = () => new Promise((resolve) => { release = resolve })

  const pending = store.reserve('slow', 'fp', slow)
  assert.equal(pending.replay, false)
  await new Promise((resolve) => setTimeout(resolve, 0))   // let the factory start
  clock += 10_000                                  // far past the TTL

  // The reservation is still live, so a retry joins it rather than starting a
  // second concurrent mutation.
  assert.equal(store.reserve('slow', 'fp', slow).replay, true)

  // Capacity pressure must not reclaim it either.
  store.reserve('other', 'fp', async () => 'done')
  assert.throws(
    () => store.reserve('third', 'fp', async () => 'nope'),
    (e) => e instanceof FileLinkDenied && e.reason === 'idem-store-full',
  )

  release('done')
  await pending.promise
  // Settled entries ARE reclaimable, and the TTL runs from settlement.
  clock += 10_000
  assert.equal(store.reserve('slow', 'fp', async () => 'fresh').replay, false)
})
