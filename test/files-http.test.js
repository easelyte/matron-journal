// Real-server harness for the File Explorer read API (spec §5.2 / §8 / §10).
// Mirrors media.test.js: startTestServer + fs.mkdtempSync fixtures, asserting
// the path-jail, sensitive-drop, hidden-toggle, streaming/Range, caps, auth
// gating, and uniform denials end-to-end over HTTP.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'

// Build a canonical read-root with a representative tree + adversarial entries.
function makeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'matron-files-')))
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'matron-files-outside-')))

  fs.writeFileSync(path.join(root, 'README.md'), '# hello\n')
  fs.writeFileSync(path.join(root, 'app.js'), 'console.log(1)\n')
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n')            // sensitive — always dropped
  fs.writeFileSync(path.join(root, '.hidden'), 'dot\n')             // hidden by default (dotfile)
  fs.mkdirSync(path.join(root, 'src'))
  fs.mkdirSync(path.join(root, 'node_modules'))                    // hidden by default
  fs.mkdirSync(path.join(root, '.git'))                            // hidden by default
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {}\n')

  // Non-UTF8 binary, so a string-based path would corrupt it.
  const binBytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81]), crypto.randomBytes(2048)])
  fs.writeFileSync(path.join(root, 'blob.bin'), binBytes)

  // Credential/config material reachable under a broad /root-style root (F2).
  // Each must be dropped from listings (even ?all=1) and 403 on content/meta.
  fs.mkdirSync(path.join(root, '.codex'))
  fs.writeFileSync(path.join(root, '.codex', 'auth.json'), '{"OPENAI_API_KEY":"sk-x"}\n')
  fs.mkdirSync(path.join(root, '.config', 'gh'), { recursive: true })
  fs.writeFileSync(path.join(root, '.config', 'gh', 'hosts.yml'), 'token: ghp_x\n')
  fs.mkdirSync(path.join(root, '.claude'))
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{"k":"v"}\n')
  fs.writeFileSync(path.join(root, 'auth.json'), '{"token":"x"}\n')
  fs.writeFileSync(path.join(root, '.git-credentials'), 'https://x:y@github.com\n')
  fs.writeFileSync(path.join(root, '.pgpass'), 'localhost:5432:db:u:p\n')
  fs.writeFileSync(path.join(root, '.claude.json'), '{"k":"v"}\n')

  // Adversarial symlinks that must never be served / listed.
  fs.writeFileSync(path.join(outside, 'target.txt'), 'ESCAPED SECRET\n')
  fs.symlinkSync(path.join(outside, 'target.txt'), path.join(root, 'escape.txt'))     // symlink-out
  fs.writeFileSync(path.join(outside, 'config.json'), '{"token":"x"}\n')
  fs.symlinkSync(path.join(outside, 'config.json'), path.join(root, 'looksok.txt'))   // symlink-to-secret

  return { root, outside, binBytes }
}

// F2 credential entries: (segment-relative path, secret substring that must
// never appear in any response body).
const F2_SENSITIVE = [
  ['.codex/auth.json', 'sk-x'],
  ['.config/gh/hosts.yml', 'ghp_x'],
  ['.claude/settings.json', '"k":"v"'],
  ['auth.json', '"token":"x"'],
  ['.git-credentials', 'github.com'],
  ['.pgpass', '5432'],
  ['.claude.json', '"k":"v"'],
]

async function clientToken(s, name = 'op', pw = 'pw') {
  await createUser(s.db, name, pw)
  const r = await s.http('/login', { method: 'POST', body: { username: name, password: pw, device_name: 'x' } })
  return r.json.token
}

function authGet(s, pathAndQuery, token, headers = {}) {
  return fetch(s.base + pathAndQuery, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } })
}

test('GET /files/list: dirs-first, sensitive dropped, hidden default-hidden vs ?all=1', async (t) => {
  const { root } = makeFixture()
  const s = await startTestServer({ fileReadRoots: [root] })
  t.after(() => s.close())
  const token = await clientToken(s)

  const r = await authGet(s, `/files/list?path=${encodeURIComponent(root)}`, token)
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.path, root)
  assert.equal(body.root, root)          // the containing read-root
  assert.equal(body.parent, null)        // listing AT a read-root -> top boundary
  assert.equal(body.truncated, false)
  const names = body.entries.map((e) => e.name)

  // sensitive + symlink-escape + symlink-to-secret never appear, in either mode
  for (const forbidden of ['.env', 'escape.txt', 'looksok.txt']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must never be listed`)
  }
  // hidden by default
  for (const hidden of ['.hidden', 'node_modules', '.git']) {
    assert.ok(!names.includes(hidden), `${hidden} should be hidden by default`)
  }
  // visible content present
  for (const shown of ['README.md', 'app.js', 'src', 'blob.bin']) {
    assert.ok(names.includes(shown), `${shown} should be listed`)
  }
  // dirs first
  const firstFileIdx = body.entries.findIndex((e) => e.kind === 'file')
  const lastDirIdx = body.entries.map((e) => e.kind).lastIndexOf('dir')
  assert.ok(lastDirIdx < firstFileIdx, 'all dirs must sort before files')
  // entry shape
  const app = body.entries.find((e) => e.name === 'app.js')
  assert.equal(app.kind, 'file')
  assert.equal(app.mime, 'text/plain')
  assert.equal(typeof app.size, 'number')
  assert.equal(typeof app.mtime, 'number')

  // ?all=1 reveals dev-noise/dotfiles but STILL never the sensitive drop
  const rAll = await authGet(s, `/files/list?path=${encodeURIComponent(root)}&all=1`, token)
  const allNames = (await rAll.json()).entries.map((e) => e.name)
  assert.ok(allNames.includes('.hidden') && allNames.includes('node_modules') && allNames.includes('.git'))
  for (const forbidden of ['.env', 'escape.txt', 'looksok.txt']) {
    assert.ok(!allNames.includes(forbidden), `${forbidden} must never be listed even with all=1`)
  }
})

test('GET /files/list: breadcrumb jail — root exposed, parent never above the read-root (F4)', async (t) => {
  const { root } = makeFixture()
  // nested subtree inside the read-root
  const deep = path.join(root, 'src', 'nested')
  fs.mkdirSync(deep, { recursive: true })
  const s = await startTestServer({ fileReadRoots: [root] })
  t.after(() => s.close())
  const token = await clientToken(s)

  // AT the read-root: root === path, parent null (top boundary)
  const atRoot = await (await authGet(s, `/files/list?path=${encodeURIComponent(root)}`, token)).json()
  assert.equal(atRoot.root, root)
  assert.equal(atRoot.path, root)
  assert.equal(atRoot.parent, null)

  // one level down: parent = the read-root itself, still the jail boundary
  const atSrc = await (await authGet(s, `/files/list?path=${encodeURIComponent(path.join(root, 'src'))}`, token)).json()
  assert.equal(atSrc.root, root)
  assert.equal(atSrc.path, path.join(root, 'src'))
  assert.equal(atSrc.parent, root)

  // deeper: parent stays strictly within root, never escaping above it
  const atDeep = await (await authGet(s, `/files/list?path=${encodeURIComponent(deep)}`, token)).json()
  assert.equal(atDeep.root, root)
  assert.equal(atDeep.path, deep)
  assert.equal(atDeep.parent, path.join(root, 'src'))
  // invariant: parent is always within/at root, never an ancestor above it
  for (const b of [atRoot, atSrc, atDeep]) {
    if (b.parent !== null) {
      assert.ok(b.parent === b.root || b.parent.startsWith(b.root + path.sep), `parent ${b.parent} must be within root ${b.root}`)
    }
  }
})

test('GET /files/list: truncated flag when over the cap', async (t) => {
  const { root } = makeFixture()
  const s = await startTestServer({ fileReadRoots: [root], fileListMax: 3 })
  t.after(() => s.close())
  const token = await clientToken(s)
  const body = await (await authGet(s, `/files/list?path=${encodeURIComponent(root)}&all=1`, token)).json()
  assert.equal(body.entries.length, 3)
  assert.equal(body.truncated, true)
})

test('GET /files/list: outside-root -> 403, missing -> 404, a file path -> 404 (not-a-dir)', async (t) => {
  const { root, outside } = makeFixture()
  const s = await startTestServer({ fileReadRoots: [root] })
  t.after(() => s.close())
  const token = await clientToken(s)

  assert.equal((await authGet(s, `/files/list?path=${encodeURIComponent(outside)}`, token)).status, 403)
  assert.equal((await authGet(s, `/files/list?path=${encodeURIComponent(path.join(root, 'nope'))}`, token)).status, 404)
  assert.equal((await authGet(s, `/files/list?path=${encodeURIComponent(path.join(root, 'app.js'))}`, token)).status, 404)
  assert.equal((await authGet(s, `/files/list?path=relative`, token)).status, 400)
  assert.equal((await authGet(s, `/files/list`, token)).status, 400)
})

test('GET /files/meta: file + dir metadata; sensitive/outside denied', async (t) => {
  const { root, outside } = makeFixture()
  const s = await startTestServer({ fileReadRoots: [root] })
  t.after(() => s.close())
  const token = await clientToken(s)

  const md = await (await authGet(s, `/files/meta?path=${encodeURIComponent(path.join(root, 'README.md'))}`, token)).json()
  assert.equal(md.kind, 'file')
  assert.equal(md.mime, 'text/markdown')
  assert.equal(md.is_text, true)
  assert.equal(md.size, '# hello\n'.length)

  const dir = await (await authGet(s, `/files/meta?path=${encodeURIComponent(path.join(root, 'src'))}`, token)).json()
  assert.equal(dir.kind, 'dir')
  assert.equal(dir.is_text, false)

  const bin = await (await authGet(s, `/files/meta?path=${encodeURIComponent(path.join(root, 'blob.bin'))}`, token)).json()
  assert.equal(bin.mime, 'application/octet-stream')
  assert.equal(bin.is_text, false)

  assert.equal((await authGet(s, `/files/meta?path=${encodeURIComponent(path.join(root, '.env'))}`, token)).status, 403)
  assert.equal((await authGet(s, `/files/meta?path=${encodeURIComponent(path.join(outside, 'target.txt'))}`, token)).status, 403)
})

test('GET /files/content: text inline (text/plain + nosniff + inline), exact bytes', async (t) => {
  const { root } = makeFixture()
  const s = await startTestServer({ fileReadRoots: [root] })
  t.after(() => s.close())
  const token = await clientToken(s)

  const r = await authGet(s, `/files/content?path=${encodeURIComponent(path.join(root, 'app.js'))}`, token)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(r.headers.get('cache-control'), 'private')
  assert.match(r.headers.get('content-disposition'), /^inline;/)
  assert.equal(await r.text(), 'console.log(1)\n')
})

test('GET /files/content: binary streams exact bytes; Range -> 206 slice', async (t) => {
  const { root, binBytes } = makeFixture()
  const s = await startTestServer({ fileReadRoots: [root] })
  t.after(() => s.close())
  const token = await clientToken(s)
  const url = `/files/content?path=${encodeURIComponent(path.join(root, 'blob.bin'))}`

  const full = await authGet(s, url, token)
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-type'), 'application/octet-stream')
  assert.equal(full.headers.get('accept-ranges'), 'bytes')
  // octet-stream is not inline-safe -> forced attachment
  assert.match(full.headers.get('content-disposition'), /^attachment;/)
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(binBytes))

  const ranged = await authGet(s, url, token, { range: 'bytes=2-5' })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('content-range'), `bytes 2-5/${binBytes.length}`)
  assert.equal(ranged.headers.get('content-length'), '4')
  assert.ok(Buffer.from(await ranged.arrayBuffer()).equals(binBytes.subarray(2, 6)))

  const suffix = await authGet(s, url, token, { range: 'bytes=-4' })
  assert.equal(suffix.status, 206)
  assert.ok(Buffer.from(await suffix.arrayBuffer()).equals(binBytes.subarray(binBytes.length - 4)))

  const unsat = await authGet(s, url, token, { range: `bytes=${binBytes.length + 10}-` })
  assert.equal(unsat.status, 416)
})

test('GET /files/content: inline cap (5MB) 413s; same file as attachment (100MB cap) 200s', async (t) => {
  const { root } = makeFixture()
  const big = path.join(root, 'big.log')
  fs.writeFileSync(big, Buffer.alloc(6 * 1024 * 1024, 0x61)) // 6MB > MAX_VIEW_BYTES
  const s = await startTestServer({ fileReadRoots: [root] })
  t.after(() => s.close())
  const token = await clientToken(s)
  const enc = encodeURIComponent(big)

  assert.equal((await authGet(s, `/files/content?path=${enc}`, token)).status, 413)
  const att = await authGet(s, `/files/content?path=${enc}&disposition=attachment`, token)
  assert.equal(att.status, 200)
  assert.equal(att.headers.get('content-length'), String(6 * 1024 * 1024))
})

test('GET /files/content: no isSensitivePath file is ever served, incl. via symlink-escape', async (t) => {
  const { root, outside } = makeFixture()
  const s = await startTestServer({ fileReadRoots: [root] })
  t.after(() => s.close())
  const token = await clientToken(s)

  // sensitive file inside the root -> 403, never its bytes
  const env = await authGet(s, `/files/content?path=${encodeURIComponent(path.join(root, '.env'))}`, token)
  assert.equal(env.status, 403)
  assert.ok(!/SECRET=1/.test(await env.text()))

  // symlink pointing outside the roots -> rejected (symlink -> 404), never the escaped bytes
  const escape = await authGet(s, `/files/content?path=${encodeURIComponent(path.join(root, 'escape.txt'))}`, token)
  assert.equal(escape.status, 404)
  assert.ok(!/ESCAPED SECRET/.test(await escape.text()))

  // symlink to a sensitive target -> rejected, never the token bytes
  const looksok = await authGet(s, `/files/content?path=${encodeURIComponent(path.join(root, 'looksok.txt'))}`, token)
  assert.equal(looksok.status, 404)
  assert.ok(!/token/.test(await looksok.text()))

  // a plain path outside the read-root -> outside-scope 403
  assert.equal((await authGet(s, `/files/content?path=${encodeURIComponent(path.join(outside, 'target.txt'))}`, token)).status, 403)
})

test('File API is client-only (agent -> 403) and requires auth (-> 401)', async (t) => {
  const { root } = makeFixture()
  const s = await startTestServer({ fileReadRoots: [root] })
  t.after(() => s.close())
  const token = await clientToken(s)
  const dan = await createUser(s.db, 'dan', 'pw2')
  const { token: agentToken } = createAgent(s.db, dan.id, 'agent-1')
  const enc = encodeURIComponent(root)
  const fileEnc = encodeURIComponent(path.join(root, 'app.js'))

  for (const url of [`/files/list?path=${enc}`, `/files/meta?path=${fileEnc}`, `/files/content?path=${fileEnc}`]) {
    assert.equal((await authGet(s, url, agentToken)).status, 403, `${url} must be 403 for an agent`)
    assert.equal((await authGet(s, url, null)).status, 401, `${url} must be 401 unauthenticated`)
    assert.equal((await authGet(s, url, token)).status, 200, `${url} must be 200 for a client`)
  }
})

// --- F2: credential/config material is never listed or served ---------------
test('F2: sensitive credential entries are dropped from listings and 403 on meta/content', async (t) => {
  const { root } = makeFixture()
  const s = await startTestServer({ fileReadRoots: [root] })
  t.after(() => s.close())
  const token = await clientToken(s)

  // Listing must never surface any F2 entry, in either display mode.
  for (const mode of ['', '&all=1']) {
    const body = await (await authGet(s, `/files/list?path=${encodeURIComponent(root)}${mode}`, token)).json()
    const names = body.entries.map((e) => e.name)
    for (const forbidden of ['.codex', '.config', '.claude', 'auth.json', '.git-credentials', '.pgpass', '.claude.json']) {
      assert.ok(!names.includes(forbidden), `${forbidden} must never be listed (mode="${mode}")`)
    }
  }
  // Direct meta + content on each must be 403 and never leak the secret bytes.
  for (const [rel, secret] of F2_SENSITIVE) {
    const abs = encodeURIComponent(path.join(root, rel))
    const meta = await authGet(s, `/files/meta?path=${abs}`, token)
    assert.equal(meta.status, 403, `meta ${rel} must be 403`)
    const content = await authGet(s, `/files/content?path=${abs}`, token)
    assert.equal(content.status, 403, `content ${rel} must be 403`)
    assert.ok(!(await content.text()).includes(secret), `content ${rel} must not leak ${secret}`)
  }
})

// --- F3: content streams; a Range reads only the requested slice ------------
test('F3: a large-file Range returns only the slice (streamed, not whole-file buffered)', async (t) => {
  const { root } = makeFixture()
  // 40MB file — over inline cap, well under the 100MB attachment cap.
  const big = path.join(root, 'huge.bin')
  const size = 40 * 1024 * 1024
  const fh = fs.openSync(big, 'w')
  fs.writeSync(fh, Buffer.alloc(size, 0x41))
  // Put a distinctive marker near the end so a correct slice proves seeking.
  fs.writeSync(fh, Buffer.from('MARKER'), 0, 6, size - 6)
  fs.closeSync(fh)

  const s = await startTestServer({ fileReadRoots: [root] })
  t.after(() => s.close())
  const token = await clientToken(s)
  const url = `/files/content?path=${encodeURIComponent(big)}&disposition=attachment`

  const ranged = await authGet(s, url, token, { range: `bytes=${size - 6}-${size - 1}` })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('content-length'), '6')
  assert.equal(ranged.headers.get('content-range'), `bytes ${size - 6}-${size - 1}/${size}`)
  assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), 'MARKER')

  // A full attachment of the same 40MB file streams end-to-end with the right
  // length (proves the stream path handles large payloads, not a 5MB buffer).
  const full = await authGet(s, url, token)
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-length'), String(size))
  const buf = Buffer.from(await full.arrayBuffer())
  assert.equal(buf.length, size)
  assert.equal(buf.subarray(size - 6).toString(), 'MARKER')
})

// --- round-2 F1: an aborted content request must close the validated fd -----
test('round-2 F1: a client abort during /files/content open closes the fd (no leak) and settles', async (t) => {
  const { root } = makeFixture()
  const s = await startTestServer({ fileReadRoots: [root] })
  t.after(() => s.close())
  const token = await clientToken(s)

  // Spy fs/promises.open so we can (a) widen the open window enough to abort
  // mid-open, and (b) observe that the server closes the handle it opened.
  let closeCalled = false
  let resolveClosed
  const closed = new Promise((r) => { resolveClosed = r })
  const origOpen = fsp.open
  t.mock.method(fsp, 'open', async (...args) => {
    const fh = await origOpen.apply(fsp, args)
    const origStat = fh.stat.bind(fh)
    fh.stat = async (...a) => { await new Promise((r) => setTimeout(r, 80)); return origStat(...a) }
    const origClose = fh.close.bind(fh)
    fh.close = (...a) => { if (!closeCalled) { closeCalled = true; resolveClosed() } return origClose(...a) }
    return fh
  })

  const ac = new AbortController()
  const req = fetch(s.base + `/files/content?path=${encodeURIComponent(path.join(root, 'app.js'))}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: ac.signal,
  }).then(() => 'ok', () => 'aborted')
  setTimeout(() => ac.abort(), 15) // abort while the widened open() is still awaiting

  const outcome = await req
  assert.equal(outcome, 'aborted')
  // The handler must have closed the fd it opened, within a bounded wait.
  await Promise.race([
    closed,
    new Promise((_, rej) => setTimeout(() => rej(new Error('validated fd was never closed after the abort (leak)')), 3000)),
  ])
  assert.equal(closeCalled, true)
})

// --- F1/F4/F6: opt-in + fail-safe disabling ---------------------------------
test('F1: with no roots configured, the server starts and /files/* is 404 (feature off)', async (t) => {
  const s = await startTestServer() // no fileReadRoots, env unset
  t.after(() => s.close())
  const token = await clientToken(s)
  // server is fully functional
  assert.equal((await s.http('/snapshot', { token })).status, 200)
  // file routes are simply not there
  for (const url of ['/files/list?path=/tmp', '/files/meta?path=/etc/hosts', '/files/content?path=/etc/hosts']) {
    const r = await authGet(s, url, token)
    assert.equal(r.status, 404, `${url} should 404 when the file API is disabled`)
  }
})

test('F1: startServer fails visible on an unreadable configured read-root', async () => {
  await assert.rejects(
    startTestServer({ fileReadRoots: [path.join(os.tmpdir(), 'matron-does-not-exist-' + crypto.randomBytes(6).toString('hex'))] }),
    (e) => e && e.reason === 'bad-workdir',
  )
})

test('F4: an empty configured root set disables the API (never fails open)', async (t) => {
  const s = await startTestServer({ fileReadRoots: [] })
  t.after(() => s.close())
  const token = await clientToken(s)
  assert.equal((await s.http('/snapshot', { token })).status, 200)
  // Must NOT serve an arbitrary absolute file — the route is off entirely.
  assert.equal((await authGet(s, '/files/content?path=/etc/hosts', token)).status, 404)
  assert.equal((await authGet(s, '/files/list?path=/etc', token)).status, 404)
})

test('F6: file API disabled (fail closed) when /proc/self/fd is unavailable', async (t) => {
  const { root } = makeFixture()
  // Roots ARE configured, but the fd-identity re-check platform is absent.
  const s = await startTestServer({ fileReadRoots: [root], procSelfFdAvailable: false })
  t.after(() => s.close())
  const token = await clientToken(s)
  assert.equal((await s.http('/snapshot', { token })).status, 200)
  assert.equal((await authGet(s, `/files/list?path=${encodeURIComponent(root)}`, token)).status, 404)
  assert.equal((await authGet(s, `/files/content?path=${encodeURIComponent(path.join(root, 'app.js'))}`, token)).status, 404)
})

// --- Phase 2 T-1.1: server-owned write configuration -----------------------
test('T-1.1: writes are off by default even with a valid pinned write-root', async (t) => {
  const { root } = makeFixture()
  const writeRoot = path.join(root, 'src')
  const s = await startTestServer({ fileReadRoots: [root], fileWriteRoots: [writeRoot] })
  t.after(() => s.close())
  const token = await clientToken(s)

  // T-2.0 registers this route only when the resolved kill switch is on.
  // Until then, and by default, the write surface must remain absent.
  assert.equal((await s.http('/files/mkdir', { method: 'POST', token, body: { path: path.join(writeRoot, 'new') } })).status, 404)
})

test('T-1.1: ENABLE_WRITES=1 without write-roots fails closed and logs why', async (t) => {
  const { root } = makeFixture()
  const warn = t.mock.method(console, 'warn', () => {})
  const s = await startTestServer({ fileReadRoots: [root], fileEnableWrites: true })
  t.after(() => s.close())
  const token = await clientToken(s)

  assert.ok(warn.mock.calls.some((c) => /MATRON_FILE_WRITE_ROOTS is unset or empty/.test(c.arguments[0])))
  assert.equal((await s.http('/files/mkdir', { method: 'POST', token, body: { path: path.join(root, 'new') } })).status, 404)
})

test('T-1.1: ENABLE_WRITES=1 with an empty write-root list also fails closed', async (t) => {
  const { root } = makeFixture()
  const warn = t.mock.method(console, 'warn', () => {})
  const s = await startTestServer({ fileReadRoots: [root], fileWriteRoots: [], fileEnableWrites: true })
  t.after(() => s.close())
  const token = await clientToken(s)

  assert.ok(warn.mock.calls.some((c) => /MATRON_FILE_WRITE_ROOTS is unset or empty/.test(c.arguments[0])))
  assert.equal((await s.http('/files/mkdir', { method: 'POST', token, body: { path: path.join(root, 'new') } })).status, 404)
})

test('T-1.1: write-root, enable, and dry-run env config accepts colon-separated nested roots', async (t) => {
  const { root } = makeFixture()
  const envNames = ['MATRON_FILE_WRITE_ROOTS', 'MATRON_FILE_ENABLE_WRITES', 'MATRON_FILE_WRITES_DRYRUN']
  const previous = new Map(envNames.map((name) => [name, process.env[name]]))
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  process.env.MATRON_FILE_WRITE_ROOTS = `${path.join(root, 'src')}:${path.join(root, 'node_modules')}`
  process.env.MATRON_FILE_ENABLE_WRITES = '1'
  process.env.MATRON_FILE_WRITES_DRYRUN = '1'

  // Successful boot proves both env roots were split, pinned, and accepted as
  // subsets. T-2.0 will consume the enabled/dry-run values already wired below.
  const s = await startTestServer({ fileReadRoots: [root] })
  t.after(() => s.close())
  const token = await clientToken(s)
  assert.equal((await s.http('/files/mkdir', { method: 'POST', token, body: { path: path.join(root, 'src', 'new') } })).status, 404)
})

test('T-1.1: a write-root outside all read-roots fails visibly at boot', async () => {
  const { root, outside } = makeFixture()
  await assert.rejects(
    startTestServer({ fileReadRoots: [root], fileWriteRoots: [outside] }),
    /every configured write-root must be contained in a configured read-root/,
  )
})

test('T-1.1: an unreadable configured write-root fails visibly while pinning', async () => {
  const { root } = makeFixture()
  await assert.rejects(
    startTestServer({
      fileReadRoots: [root],
      fileWriteRoots: [path.join(root, 'missing-' + crypto.randomBytes(6).toString('hex'))],
    }),
    (e) => e && e.reason === 'bad-workdir',
  )
})

test('T-1.1: pinned write roots, enable state, and dry-run state are threaded into the HTTP handler', () => {
  // startServer's concrete handler factory is intentionally not injectable.
  // Pin its security-sensitive wiring at the non-testable entry-point boundary
  // (universal principle P71), while the tests above exercise boot + HTTP.
  const serverSource = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const httpSource = fs.readFileSync(new URL('../src/http.js', import.meta.url), 'utf8')
  assert.match(serverSource, /fileWriteRoots: resolvedFileWriteRoots/)
  assert.match(serverSource, /fileEnableWrites: resolvedFileEnableWrites/)
  assert.match(serverSource, /fileWritesDryRun: resolvedFileWritesDryRun/)
  assert.match(httpSource, /fileWriteRoots, fileEnableWrites = false, fileWritesDryRun = false/)
})
