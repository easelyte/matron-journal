// Owner gate for the File Explorer (read AND write). Authentication proves a
// device belongs to SOME user; the /files* routes expose the server's own disk,
// so they are additionally authorized to exactly one user — the configured
// owner (MATRON_FILE_OWNER_USER_ID), the same shape as GET /work's owner check.
// Every /files* route is swept for: owner allowed, non-owner client denied,
// admin non-owner denied, unconfigured owner fails closed, and a denied call
// leaving no audit line, no idempotency reservation and no fs change.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { FILE_AUDIT_BASENAME } from '../src/file-audit.js'
import { makeTmpDir } from './tmp-dir.js'

function makeFixture() {
  const root = fs.realpathSync(makeTmpDir('matron-owner-'))
  const writeRoot = path.join(root, 'writable')
  fs.mkdirSync(writeRoot)
  fs.writeFileSync(path.join(root, 'README.md'), '# hello\n')
  fs.writeFileSync(path.join(writeRoot, 'existing.txt'), 'original\n')
  fs.writeFileSync(path.join(writeRoot, 'victim.txt'), 'keep me\n')
  const auditDir = fs.realpathSync(makeTmpDir('matron-owner-audit-'))
  return { root, writeRoot, auditDir }
}

function start(f, extra = {}) {
  return startTestServer({
    fileReadRoots: [f.root],
    fileWriteRoots: [f.writeRoot],
    fileEnableWrites: true,
    fileAuditDir: f.auditDir,
    ...extra,
  })
}

async function login(s, name, { admin = false } = {}) {
  const user = await createUser(s.db, name, 'pw')
  if (admin) s.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(user.id)
  const r = await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: 'x' } })
  assert.equal(r.status, 200)
  return { token: r.json.token, userId: Number(user.id) }
}

const call = (s, pathAndQuery, { method = 'GET', token, body, raw, headers = {} } = {}) =>
  fetch(s.base + pathAndQuery, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : raw,
  })

// One request per /files* route (every method the File Explorer serves).
// Built per fixture so every path is inside its roots.
function routes(f) {
  const w = f.writeRoot
  return [
    ['GET /files/list', `/files/list?path=${encodeURIComponent(f.root)}`, {}],
    ['GET /files/meta', `/files/meta?path=${encodeURIComponent(path.join(f.root, 'README.md'))}`, {}],
    ['GET /files/content', `/files/content?path=${encodeURIComponent(path.join(f.root, 'README.md'))}`, {}],
    ['POST /files/upload', `/files/upload?path=${encodeURIComponent(path.join(w, 'up.txt'))}`, { method: 'POST', raw: 'uploaded\n' }],
    ['POST /files/mkdir', '/files/mkdir', { method: 'POST', body: { path: path.join(w, 'newdir') } }],
    ['POST /files/move', '/files/move', { method: 'POST', body: { from: path.join(w, 'existing.txt'), to: path.join(w, 'moved.txt') } }],
    ['POST /files/write', '/files/write', { method: 'POST', body: { path: path.join(w, 'written.txt'), content: 'hi\n' } }],
    ['DELETE /files', `/files?path=${encodeURIComponent(path.join(w, 'victim.txt'))}&confirm=1`, { method: 'DELETE' }],
  ]
}

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

const auditText = (f) => {
  const p = path.join(f.auditDir, FILE_AUDIT_BASENAME)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

const idemRows = (s) => s.db.prepare('SELECT COUNT(*) AS n FROM file_idem').get().n

async function assertDeniedEverywhere(s, f, token, status, error, label) {
  const beforeTree = treeOf(f.root)
  const beforeAudit = auditText(f)
  const beforeIdem = idemRows(s)
  for (const [name, url, opts] of routes(f)) {
    const r = await call(s, url, { ...opts, token, headers: { 'idempotency-key': `k-${name}` } })
    assert.equal(r.status, status, `${label}: ${name} must answer ${status}`)
    assert.deepEqual(await r.json(), { error }, `${label}: ${name} body`)
  }
  assert.deepEqual(treeOf(f.root), beforeTree, `${label}: no fs change`)
  assert.equal(auditText(f), beforeAudit, `${label}: no audit line`)
  assert.equal(idemRows(s), beforeIdem, `${label}: no idempotency reservation`)
}

test('owner client device is allowed on every /files route', async () => {
  const f = makeFixture()
  const s = await start(f)
  try {
    const owner = await login(s, 'op')
    assert.equal(owner.userId, 1)
    for (const [name, url, opts] of routes(f)) {
      const r = await call(s, url, { ...opts, token: owner.token })
      assert.ok(r.status >= 200 && r.status < 300, `owner: ${name} answered ${r.status}`)
      await r.arrayBuffer()
    }
    assert.equal(fs.readFileSync(path.join(f.writeRoot, 'up.txt'), 'utf8'), 'uploaded\n')
    assert.ok(fs.statSync(path.join(f.writeRoot, 'newdir')).isDirectory())
    assert.ok(fs.existsSync(path.join(f.writeRoot, 'moved.txt')))
    assert.equal(fs.readFileSync(path.join(f.writeRoot, 'written.txt'), 'utf8'), 'hi\n')
    assert.equal(fs.existsSync(path.join(f.writeRoot, 'victim.txt')), false)
  } finally { await s.close() }
})

test('a non-owner client device is denied 403 on every /files route, with no side effects', async () => {
  const f = makeFixture()
  const s = await start(f)
  try {
    await login(s, 'op')
    const other = await login(s, 'second')
    assert.notEqual(other.userId, 1)
    await assertDeniedEverywhere(s, f, other.token, 403, 'forbidden', 'non-owner')
  } finally { await s.close() }
})

test('an ADMIN non-owner is still denied 403 on every /files route', async () => {
  const f = makeFixture()
  const s = await start(f)
  try {
    await login(s, 'op')
    const admin = await login(s, 'boss', { admin: true })
    assert.equal(s.db.prepare('SELECT is_admin FROM users WHERE id=?').get(admin.userId).is_admin, 1)
    await assertDeniedEverywhere(s, f, admin.token, 403, 'forbidden', 'admin non-owner')
  } finally { await s.close() }
})

test('the owner\'s own agent device is still denied (client devices only)', async () => {
  const f = makeFixture()
  const s = await start(f)
  try {
    await login(s, 'op')
    const agent = createAgent(s.db, 1, 'bot')
    await assertDeniedEverywhere(s, f, agent.token, 403, 'forbidden', 'owner agent')
  } finally { await s.close() }
})

test('owner unconfigured fails closed: every /files route answers 500, even for user 1', async () => {
  const f = makeFixture()
  const s = await start(f, { fileOwnerUserId: null })
  const errors = []
  const origError = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  try {
    const first = await login(s, 'op')
    await assertDeniedEverywhere(s, f, first.token, 500, 'internal', 'unconfigured')
    assert.ok(errors.some((l) => l.includes('MATRON_FILE_OWNER_USER_ID')), 'the refusal is logged')
  } finally { console.error = origError; await s.close() }
})

test('owner id comes from MATRON_FILE_OWNER_USER_ID; a malformed value fails closed', async () => {
  const f = makeFixture()
  const prev = process.env.MATRON_FILE_OWNER_USER_ID
  const origError = console.error
  console.error = () => {}
  try {
    process.env.MATRON_FILE_OWNER_USER_ID = '2'
    const s = await start(f, { fileOwnerUserId: undefined })
    try {
      const first = await login(s, 'op')
      const second = await login(s, 'second')
      const url = `/files/list?path=${encodeURIComponent(f.root)}`
      assert.equal((await call(s, url, { token: first.token })).status, 403)
      assert.equal((await call(s, url, { token: second.token })).status, 200)
    } finally { await s.close() }

    for (const bad of ['', '0', '-1', '1.5', 'abc', '1e3']) {
      process.env.MATRON_FILE_OWNER_USER_ID = bad
      const s2 = await start(f, { fileOwnerUserId: undefined })
      try {
        const first = await login(s2, 'op')
        const r = await call(s2, `/files/list?path=${encodeURIComponent(f.root)}`, { token: first.token })
        assert.equal(r.status, 500, `MATRON_FILE_OWNER_USER_ID=${JSON.stringify(bad)} must fail closed`)
      } finally { await s2.close() }
    }
  } finally {
    console.error = origError
    if (prev === undefined) delete process.env.MATRON_FILE_OWNER_USER_ID
    else process.env.MATRON_FILE_OWNER_USER_ID = prev
  }
})

test('feature off keeps the 404 fall-through even with no owner configured', async () => {
  const s = await startTestServer({ fileOwnerUserId: null })
  try {
    const first = await login(s, 'op')
    const r = await call(s, '/files/list?path=/', { token: first.token })
    assert.equal(r.status, 404)
  } finally { await s.close() }
})

test('unauthenticated /files still answers 401 before the owner gate', async () => {
  const f = makeFixture()
  const s = await start(f)
  try {
    const r = await call(s, `/files/list?path=${encodeURIComponent(f.root)}`)
    assert.equal(r.status, 401)
  } finally { await s.close() }
})

test('static hosting never answers for the /files namespace (no pre-auth bypass)', async () => {
  const f = makeFixture()
  const web = fs.realpathSync(makeTmpDir('matron-owner-web-'))
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html>')
  fs.mkdirSync(path.join(web, 'files'))
  fs.writeFileSync(path.join(web, 'files', 'list'), 'STATIC SHADOW')
  fs.writeFileSync(path.join(web, 'files', 'meta.txt'), 'STATIC SHADOW')
  const s = await start(f, { webDir: web })
  try {
    // Unauthenticated: the API's 401, never the static file.
    let r = await call(s, '/files/list')
    assert.equal(r.status, 401)
    assert.ok(!(await r.text()).includes('STATIC SHADOW'))
    r = await call(s, '/files/meta.txt')
    assert.equal(r.status, 401)
    assert.ok(!(await r.text()).includes('STATIC SHADOW'))
    // A non-owner is still refused by the owner gate.
    await login(s, 'op')
    const other = await login(s, 'second')
    r = await call(s, '/files/list', { token: other.token })
    assert.equal(r.status, 403)
    assert.ok(!(await r.text()).includes('STATIC SHADOW'))
    // Static hosting itself still works outside the namespace.
    r = await call(s, '/app/')
    assert.equal(r.status, 200)
    await r.arrayBuffer()
  } finally { await s.close() }
})
