// Guards used by the file viewer reads.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  isSensitivePath, openGuarded, metaGuarded,
  pinAllowedRootsSync, FileLinkDenied, denialToStatus,
  contentTypeFor, mimeForPath, isTextPath, MAX_VIEW_BYTES,
} from '../src/file-guard.js'

// --- isSensitivePath ---------------------------------------------------------
const SENSITIVE = [
  '/w/.env', '/w/.env.local', '/w/prod.env', '/w/secrets.yaml', '/w/secret.json',
  '/w/credentials', '/w/credentials.json', '/w/server.pem', '/w/app.key',
  '/w/id_rsa', '/w/id_ed25519.pub', '/w/.npmrc', '/w/.netrc', '/w/tokens.json',
  '/w/service-account-prod.json', '/w/.htpasswd', '/w/config.json',
  '/home/u/.aws/anything.txt', '/home/u/.ssh/known_hosts', '/home/u/.kube/cfg',
  '/home/u/.docker/x', '/home/u/.gnupg/x',
  '/w/.env/apikey.dat', '/w/.env.production/x.dat', '/w/secrets/db.dat',
  '/w/secret/note.txt', '/w/credentials/token.dat',
  '/w/proj/secrets', '/w/proj/secret', '/w/prod.env/x.dat', '/w/tokens.json/x.dat',
  '/w/app.key/nested/file.txt',
  // credential/config material reachable under a broad /root root
  '/root/.codex/auth.json', '/root/.codex', '/root/auth.json',
  '/root/.config/gh/hosts.yml', '/root/.config', '/root/.claude/settings.json',
  '/root/.claude', '/root/.claude.json', '/root/.git-credentials', '/root/.pgpass',
  '/home/u/.gcloud/x', '/home/u/.azure/y', '/root/.ssh', '/root/.aws',
]
const NOT_SENSITIVE = [
  '/w/index.js', '/w/env.md', '/w/configuration.json', '/w/package.json',
  '/w/README.md', '/w/awsome/notes.txt', '/w/keyboard.js',
  '/w/secretary/notes.txt', '/w/credentialing/doc.md',
]
test('isSensitivePath flags secrets and allows lookalikes', () => {
  for (const p of SENSITIVE) assert.equal(isSensitivePath(p), true, `should flag ${p}`)
  for (const p of NOT_SENSITIVE) assert.equal(isSensitivePath(p), false, `should allow ${p}`)
})

test('denialToStatus is uniform across reason families', () => {
  assert.equal(denialToStatus('sensitive'), 403)
  assert.equal(denialToStatus('outside-scope'), 403)
  assert.equal(denialToStatus('too-large'), 413)
  for (const r of ['not-a-file', 'unreadable', 'symlink', 'relative-path', 'bad-workdir']) {
    assert.equal(denialToStatus(r), 404, r)
  }
  assert.equal(denialToStatus('weird'), 502)
})

test('mime + text classification', () => {
  assert.equal(mimeForPath('/x/a.png'), 'image/png')
  assert.equal(mimeForPath('/x/a.pdf'), 'application/pdf')
  assert.equal(mimeForPath('/x/a.mp4'), 'video/mp4')
  assert.equal(mimeForPath('/x/a.md'), 'text/markdown')
  assert.equal(mimeForPath('/x/a.js'), 'text/plain')
  assert.equal(mimeForPath('/x/a.bin'), 'application/octet-stream')
  assert.equal(isTextPath('/x/a.ts'), true)
  assert.equal(isTextPath('/x/Dockerfile'), true)
  assert.equal(isTextPath('/x/a.png'), false)
  // script-capable text is served as text/plain inline (never executes)
  assert.deepEqual(contentTypeFor('/x/a.html'), { type: 'text/plain; charset=utf-8', inlineSafe: true })
  assert.deepEqual(contentTypeFor('/x/a.svg'), { type: 'text/plain; charset=utf-8', inlineSafe: true })
  assert.deepEqual(contentTypeFor('/x/a.png'), { type: 'image/png', inlineSafe: true })
  assert.deepEqual(contentTypeFor('/x/a.bin'), { type: 'application/octet-stream', inlineSafe: false })
})

let dir, outside
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fg-work-'))
  outside = mkdtempSync(path.join(tmpdir(), 'fg-outside-'))
  writeFileSync(path.join(dir, 'ok.txt'), 'hello guard\n')
  writeFileSync(path.join(dir, '.env'), 'SECRET=1\n')
  writeFileSync(path.join(outside, 'target.txt'), 'outside content\n')
  symlinkSync(path.join(outside, 'target.txt'), path.join(dir, 'sneaky.txt'))
  writeFileSync(path.join(outside, 'config.json'), '{"token":"x"}\n')
  symlinkSync(path.join(outside, 'config.json'), path.join(dir, 'innocent.txt'))
  writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(64))
  mkdirSync(path.join(dir, 'sub'))
})
after(() => {
  for (const d of [dir, outside]) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

const denied = async (p, opts) => {
  try {
    const opened = await openGuarded(p, opts)
    await opened.fd.close()
  } catch (err) {
    assert.ok(err instanceof FileLinkDenied, `expected FileLinkDenied, got ${err}`)
    return err.reason
  }
  throw new Error('expected FileLinkDenied')
}

test('pinAllowedRootsSync pins identity for read authorization (root swap denied)', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'fg-sync-root-swap-'))
  const approved = path.join(parent, 'approved')
  const moved = path.join(parent, 'moved')
  mkdirSync(approved)
  const allowedRoots = pinAllowedRootsSync([approved])
  renameSync(approved, moved)
  symlinkSync(outside, approved)
  try {
    assert.equal(await denied(path.join(approved, 'target.txt'), { allowedRoots }), 'bad-workdir')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('MAX_VIEW_BYTES is the 5MB default cap', () => {
  assert.equal(MAX_VIEW_BYTES, 5 * 1024 * 1024)
})

// --- openGuarded (streaming validate) -----------------------------
test('openGuarded returns an OPEN fd + size + realPath without reading bytes', async () => {
  const roots = pinAllowedRootsSync([dir])
  const { fd, size, realPath } = await openGuarded(path.join(dir, 'ok.txt'), { allowedRoots: roots })
  try {
    assert.equal(size, 'hello guard\n'.length)
    assert.equal(realPath, path.join(dir, 'ok.txt'))
    // fd is live: a stream from it yields the exact bytes.
    const chunks = []
    for await (const c of fd.createReadStream({ start: 0, end: size - 1, autoClose: false })) chunks.push(c)
    assert.equal(Buffer.concat(chunks).toString('utf-8'), 'hello guard\n')
  } finally {
    await fd.close().catch(() => {})
  }
})

test('openGuarded rejects unsafe paths and never leak an fd', async () => {
  const roots = pinAllowedRootsSync([dir])
  const openDenied = async (p, opts = { allowedRoots: roots }) => {
    try { const r = await openGuarded(p, opts); await r.fd.close().catch(() => {}) } catch (e) {
      assert.ok(e instanceof FileLinkDenied); return e.reason
    }
    throw new Error('expected FileLinkDenied')
  }
  assert.equal(await openDenied(path.join(dir, '.env')), 'sensitive')
  assert.equal(await openDenied(path.join(dir, 'sneaky.txt')), 'symlink')          // symlink-out
  assert.equal(await openDenied(path.join(outside, 'target.txt')), 'outside-scope')
  assert.equal(await openDenied(path.join(dir, 'sub')), 'not-a-file')              // a directory
  assert.equal(await openDenied(path.join(dir, 'nope.txt')), 'unreadable')
  assert.equal(await openDenied('relative.txt'), 'relative-path')
})

// --- empty pinned root set must FAIL CLOSED ----------------------
test('a zero-root pinned set is refused (outside-scope) by every file-API guard', async () => {
  const empty = pinAllowedRootsSync([])
  const guardDenied = async (fn) => {
    try { await fn() } catch (e) { assert.ok(e instanceof FileLinkDenied); return e.reason }
    throw new Error('expected FileLinkDenied')
  }
  assert.equal(await guardDenied(() => openGuarded(path.join(dir, 'ok.txt'), { allowedRoots: empty })), 'outside-scope')
  assert.equal(await guardDenied(() => metaGuarded(path.join(dir, 'ok.txt'), { allowedRoots: empty })), 'outside-scope')
})

// --- metaGuarded -------------------------------------------------------------
test('metaGuarded returns file metadata without reading bytes', async () => {
  const roots = pinAllowedRootsSync([dir])
  const m = await metaGuarded(path.join(dir, 'ok.txt'), { allowedRoots: roots })
  assert.equal(m.kind, 'file')
  assert.equal(m.size, 'hello guard\n'.length)
  assert.equal(m.mime, 'text/plain')
  assert.equal(m.is_text, true)
  assert.equal(typeof m.mtime, 'number')
})

test('metaGuarded reports directories', async () => {
  const roots = pinAllowedRootsSync([dir])
  const m = await metaGuarded(path.join(dir, 'sub'), { allowedRoots: roots })
  assert.equal(m.kind, 'dir')
  assert.equal(m.size, null)
  assert.equal(m.is_text, false)
})

test('metaGuarded denials mirror the guard (sensitive, outside-scope, symlink)', async () => {
  const roots = pinAllowedRootsSync([dir])
  const metaDenied = async (p) => {
    try { await metaGuarded(p, { allowedRoots: roots }) } catch (e) {
      assert.ok(e instanceof FileLinkDenied); return e.reason
    }
    throw new Error('expected FileLinkDenied')
  }
  assert.equal(await metaDenied(path.join(dir, '.env')), 'sensitive')
  assert.equal(await metaDenied(path.join(outside, 'target.txt')), 'outside-scope')
  assert.equal(await metaDenied(path.join(dir, 'sneaky.txt')), 'symlink')
})
