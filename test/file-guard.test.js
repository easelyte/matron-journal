// Ported from the bridge's test/file-link-guard.test.js (vitest) into the
// journal's node:test harness, plus net-new coverage for listDirGuarded and
// metaGuarded. Keeps the security-relevant cases identical so the two guard
// copies (bridge + journal) cannot silently diverge.
import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync, renameSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  isSensitivePath, checkFileLink, validateAndOpen, openGuarded, metaGuarded, listDirGuarded,
  pinAllowedRoots, pinAllowedRootsSync, FileLinkDenied, denialToStatus,
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
  // review F2 — credential/config material reachable under a broad /root root
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

// --- checkFileLink -----------------------------------------------------------
test('checkFileLink denylist + boundary-safe containment', () => {
  assert.deepEqual(checkFileLink('/w/proj/.env', '/w/proj'), { ok: false, reason: 'sensitive' })
  assert.deepEqual(checkFileLink('/w/proj-evil/a.js', '/w/proj'), { ok: false, reason: 'outside-workdir' })
  assert.deepEqual(checkFileLink('/etc/hosts', '/w/proj'), { ok: false, reason: 'outside-workdir' })
  assert.deepEqual(checkFileLink('/w/proj/src/a.js', '/w/proj'), { ok: true })
  assert.deepEqual(checkFileLink('/w/proj', '/w/proj'), { ok: true })
  assert.deepEqual(checkFileLink('/w/proj/src/../../other/a.js', '/w/proj'), { ok: false, reason: 'outside-workdir' })
  assert.deepEqual(checkFileLink('/anywhere/a.js', null), { ok: true })
  assert.deepEqual(checkFileLink('/anywhere/.env', null), { ok: false, reason: 'sensitive' })
  assert.deepEqual(checkFileLink('/home/u/proj/a.js', '/'), { ok: true })
  assert.deepEqual(checkFileLink('/etc/hosts', '/'), { ok: true })
  assert.deepEqual(checkFileLink('/etc/.env', '/'), { ok: false, reason: 'sensitive' })
  assert.deepEqual(checkFileLink('proj/a.js', '/w/proj'), { ok: false, reason: 'relative-path' })
  assert.deepEqual(checkFileLink('./a.js', null), { ok: false, reason: 'relative-path' })
})

test('denialToStatus is uniform across reason families', () => {
  assert.equal(denialToStatus('sensitive'), 403)
  assert.equal(denialToStatus('outside-scope'), 403)
  assert.equal(denialToStatus('too-large'), 413)
  for (const r of ['not-a-file', 'not-a-dir', 'unreadable', 'symlink', 'relative-path', 'bad-workdir']) {
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

// --- validateAndOpen / metaGuarded / listDirGuarded fixtures -----------------
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
    await validateAndOpen(p, opts)
  } catch (err) {
    assert.ok(err instanceof FileLinkDenied, `expected FileLinkDenied, got ${err}`)
    return err.reason
  }
  throw new Error('expected FileLinkDenied')
}

test('validateAndOpen returns content + realPath for a normal file in the workdir', async () => {
  const { content, realPath } = await validateAndOpen(path.join(dir, 'ok.txt'), { workdir: dir })
  assert.equal(content.toString('utf-8'), 'hello guard\n')
  assert.equal(path.basename(realPath), 'ok.txt')
})

test('validateAndOpen keeps reading until the approved snapshot is full', async (t) => {
  const filePath = path.join(dir, 'short-reads.txt')
  writeFileSync(filePath, 'abcdef')
  const origOpen = fsp.open
  let readCalls = 0
  t.mock.method(fsp, 'open', async (...args) => {
    const fd = await origOpen.apply(fsp, args)
    const origRead = fd.read.bind(fd)
    mock.method(fd, 'read', (buffer, offset, length, position) => {
      readCalls += 1
      return origRead(buffer, offset, Math.min(length, 2), position)
    })
    return fd
  })
  const { content } = await validateAndOpen(filePath, { workdir: dir })
  assert.equal(content.toString(), 'abcdef')
  assert.equal(readCalls, 3)
})

const withSizeChangingRead = async (filePath, truncateTo, fn) => {
  const origOpen = fsp.open
  const restore = mock.method(fsp, 'open', async (...args) => {
    const fd = await origOpen.apply(fsp, args)
    const origRead = fd.read.bind(fd)
    mock.method(fd, 'read', async (...readArgs) => {
      const result = await origRead(...readArgs)
      await fsp.truncate(filePath, truncateTo)
      return result
    })
    return fd
  })
  try { return await fn() } finally { restore.mock.restore() }
}

test('validateAndOpen strict mode rejects a file whose size changes after reading', async () => {
  const filePath = path.join(dir, 'mutated-strict.txt')
  writeFileSync(filePath, 'abcdef')
  await withSizeChangingRead(filePath, 1, async () => {
    assert.equal(await denied(filePath, { workdir: dir, strictSnapshot: true }), 'unreadable')
  })
})

test('validateAndOpen strict mode rejects a same-size in-place overwrite during read', async () => {
  const filePath = path.join(dir, 'mutated-content-strict.txt')
  writeFileSync(filePath, 'abcdef')
  const origOpen = fsp.open
  const restore = mock.method(fsp, 'open', async (...args) => {
    const fd = await origOpen.apply(fsp, args)
    const origRead = fd.read.bind(fd)
    mock.method(fd, 'read', async (...readArgs) => {
      const result = await origRead(...readArgs)
      writeFileSync(filePath, 'ABCDEF')
      const future = new Date(Date.now() + 10_000)
      await fsp.utimes(filePath, future, future)
      return result
    })
    return fd
  })
  try {
    assert.equal(await denied(filePath, { workdir: dir, strictSnapshot: true }), 'unreadable')
  } finally {
    restore.mock.restore()
  }
})

test('validateAndOpen default mode returns the bounded snapshot for a size-changing file', async () => {
  const filePath = path.join(dir, 'mutated-serve.txt')
  writeFileSync(filePath, 'abcdef')
  const { content } = await withSizeChangingRead(filePath, 1, () =>
    validateAndOpen(filePath, { workdir: dir }),
  )
  assert.equal(content.toString(), 'abcdef')
})

test('validateAndOpen denials: symlink, sensitive, too-large, dir, missing, outside, relative', async () => {
  assert.equal(await denied(path.join(dir, 'sneaky.txt'), { workdir: dir }), 'symlink')
  assert.equal(await denied(path.join(dir, '.env'), { workdir: dir }), 'sensitive')
  assert.equal(await denied(path.join(dir, 'big.txt'), { workdir: dir, maxBytes: 16 }), 'too-large')
  assert.match(await denied(path.join(dir, 'sub'), { workdir: dir }), /not-a-file|unreadable/)
  assert.equal(await denied(path.join(dir, 'nope.txt'), { workdir: dir }), 'unreadable')
  assert.equal(await denied(path.join(outside, 'target.txt'), { workdir: dir }), 'outside-workdir')
  assert.equal(await denied('some/relative.txt', { workdir: dir }), 'relative-path')
})

test('validateAndOpen skips containment for legacy calls without a workdir', async () => {
  const { content } = await validateAndOpen(path.join(outside, 'target.txt'))
  assert.equal(content.toString('utf-8'), 'outside content\n')
})

test('validateAndOpen rejects a file reached through a symlinked ancestor directory', async () => {
  symlinkSync(outside, path.join(dir, 'linkdir'))
  assert.equal(await denied(path.join(dir, 'linkdir', 'target.txt'), { workdir: dir }), 'outside-workdir')
})

test('validateAndOpen allows a legitimate file when the workdir itself is a symlink', async () => {
  const wdLink = path.join(outside, 'wd-link')
  symlinkSync(dir, wdLink)
  const { content } = await validateAndOpen(path.join(dir, 'ok.txt'), { workdir: wdLink })
  assert.equal(content.toString('utf-8'), 'hello guard\n')
})

test('validateAndOpen allows a realPath under one of several allowed roots', async () => {
  const allowedRoots = await pinAllowedRoots([dir, outside])
  const { content, realPath } = await validateAndOpen(path.join(outside, 'target.txt'), { allowedRoots })
  assert.equal(content.toString('utf-8'), 'outside content\n')
  assert.equal(realPath, path.join(outside, 'target.txt'))
})

test('validateAndOpen rejects a realPath outside every allowed root BEFORE reading it', async (t) => {
  const allowedRoots = await pinAllowedRoots([dir])
  const origOpen = fsp.open
  const readSpies = []
  t.mock.method(fsp, 'open', async (...args) => {
    const fd = await origOpen.apply(fsp, args)
    readSpies.push(mock.method(fd, 'read'))
    return fd
  })
  assert.equal(await denied(path.join(outside, 'target.txt'), { allowedRoots }), 'outside-scope')
  assert.equal(readSpies.length, 1)
  assert.equal(readSpies[0].mock.callCount(), 0)
})

test('validateAndOpen gives outside-scope precedence over sensitive and oversized denials', async () => {
  const allowedRoots = await pinAllowedRoots([dir])
  assert.equal(await denied(path.join(outside, 'config.json'), { allowedRoots }), 'outside-scope')
  assert.equal(await denied(path.join(outside, 'target.txt'), { allowedRoots, maxBytes: 1 }), 'outside-scope')
})

test('validateAndOpen canonicalizes symlinked allowed roots', async () => {
  const rootLink = path.join(outside, 'root-link')
  symlinkSync(dir, rootLink)
  const allowedRoots = await pinAllowedRoots([rootLink])
  const { content, realPath } = await validateAndOpen(path.join(dir, 'ok.txt'), { allowedRoots })
  assert.equal(content.toString('utf-8'), 'hello guard\n')
  assert.equal(realPath, path.join(dir, 'ok.txt'))
})

test('pinAllowedRoots rejects a root that does not resolve', async () => {
  await assert.rejects(pinAllowedRoots([path.join(dir, 'missing-root')]), (e) => e.reason === 'bad-workdir')
})

test('pinAllowedRootsSync pins identity for pre-spawn authorization (root swap denied)', async () => {
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

test('validateAndOpen rejects a pinned root replaced before validation', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'fg-root-swap-'))
  const approved = path.join(parent, 'approved')
  const moved = path.join(parent, 'moved')
  mkdirSync(approved)
  writeFileSync(path.join(outside, 'neutral.txt'), 'must not escape\n')
  const allowedRoots = await pinAllowedRoots([approved])
  renameSync(approved, moved)
  symlinkSync(outside, approved)
  try {
    assert.equal(await denied(path.join(approved, 'neutral.txt'), { allowedRoots }), 'bad-workdir')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('validateAndOpen rejects a FIFO without blocking in open or attempting a read', async () => {
  const fifo = path.join(dir, 'agent.fifo')
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0)
  const result = await Promise.race([
    denied(fifo, { workdir: dir }),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 500)),
  ])
  assert.equal(result, 'not-a-file')
})

test('MAX_VIEW_BYTES is the 5MB default cap', () => {
  assert.equal(MAX_VIEW_BYTES, 5 * 1024 * 1024)
})

// --- openGuarded (streaming validate, review F3) -----------------------------
test('openGuarded returns an OPEN fd + size + realPath without reading bytes', async () => {
  const roots = await pinAllowedRoots([dir])
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

test('openGuarded denials mirror validateAndOpen and never leak an fd', async () => {
  const roots = await pinAllowedRoots([dir])
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

// --- empty pinned root set must FAIL CLOSED (review F4) ----------------------
test('a zero-root pinned set is refused (outside-scope) by every file-API guard', async () => {
  const empty = pinAllowedRootsSync([])
  const guardDenied = async (fn) => {
    try { await fn() } catch (e) { assert.ok(e instanceof FileLinkDenied); return e.reason }
    throw new Error('expected FileLinkDenied')
  }
  assert.equal(await guardDenied(() => openGuarded(path.join(dir, 'ok.txt'), { allowedRoots: empty })), 'outside-scope')
  assert.equal(await guardDenied(() => validateAndOpen(path.join(dir, 'ok.txt'), { allowedRoots: empty })), 'outside-scope')
  assert.equal(await guardDenied(() => metaGuarded(path.join(dir, 'ok.txt'), { allowedRoots: empty })), 'outside-scope')
  assert.equal(await guardDenied(async () => listDirGuarded(dir, { allowedRoots: empty })), 'outside-scope')
})

// --- metaGuarded -------------------------------------------------------------
test('metaGuarded returns file metadata without reading bytes', async () => {
  const roots = await pinAllowedRoots([dir])
  const m = await metaGuarded(path.join(dir, 'ok.txt'), { allowedRoots: roots })
  assert.equal(m.kind, 'file')
  assert.equal(m.size, 'hello guard\n'.length)
  assert.equal(m.mime, 'text/plain')
  assert.equal(m.is_text, true)
  assert.equal(typeof m.mtime, 'number')
})

test('metaGuarded reports directories', async () => {
  const roots = await pinAllowedRoots([dir])
  const m = await metaGuarded(path.join(dir, 'sub'), { allowedRoots: roots })
  assert.equal(m.kind, 'dir')
  assert.equal(m.size, null)
  assert.equal(m.is_text, false)
})

test('metaGuarded denials mirror the guard (sensitive, outside-scope, symlink)', async () => {
  const roots = await pinAllowedRoots([dir])
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

// --- listDirGuarded ----------------------------------------------------------
test('listDirGuarded lists entries, filters sensitive + symlink-escape, drops symlink-to-secret', async () => {
  const roots = await pinAllowedRoots([dir])
  const { entries, realDir } = listDirGuarded(dir, { allowedRoots: roots })
  const names = entries.map((e) => e.name)
  assert.equal(realDir, dir)
  assert.ok(names.includes('ok.txt'), 'ok.txt should be listed')
  assert.ok(names.includes('sub'), 'sub dir should be listed')
  // sensitive by name — dropped regardless of ?all
  assert.ok(!names.includes('.env'), '.env must be dropped')
  // symlink whose realpath escapes the roots — dropped
  assert.ok(!names.includes('sneaky.txt'), 'symlink-out entry must be dropped')
  // symlink to a sensitive target (config.json) — dropped
  assert.ok(!names.includes('innocent.txt'), 'symlink-to-secret entry must be dropped')
  const okEntry = entries.find((e) => e.name === 'ok.txt')
  assert.equal(okEntry.kind, 'file')
  assert.equal(okEntry.size, 'hello guard\n'.length)
  assert.equal(okEntry.mime, 'text/plain')
  const subEntry = entries.find((e) => e.name === 'sub')
  assert.equal(subEntry.kind, 'dir')
  assert.equal(subEntry.size, null)
})

test('listDirGuarded sets the truncated flag when the cap is hit', async () => {
  const capDir = mkdtempSync(path.join(tmpdir(), 'fg-cap-'))
  for (let i = 0; i < 5; i++) writeFileSync(path.join(capDir, `f${i}.txt`), 'x')
  const roots = await pinAllowedRoots([capDir])
  try {
    const { entries, truncated } = listDirGuarded(capDir, { allowedRoots: roots, maxEntries: 3 })
    assert.equal(entries.length, 3)
    assert.equal(truncated, true)
    const full = listDirGuarded(capDir, { allowedRoots: roots, maxEntries: 100 })
    assert.equal(full.truncated, false)
    assert.equal(full.entries.length, 5)
  } finally {
    rmSync(capDir, { recursive: true, force: true })
  }
})

test('listDirGuarded denials: outside-scope, not-a-dir, sensitive dir, relative', async () => {
  const roots = await pinAllowedRoots([dir])
  const listDenied = (p, opts = { allowedRoots: roots }) => {
    try { listDirGuarded(p, opts) } catch (e) {
      assert.ok(e instanceof FileLinkDenied); return e.reason
    }
    throw new Error('expected FileLinkDenied')
  }
  assert.equal(listDenied(outside), 'outside-scope')
  assert.equal(listDenied(path.join(dir, 'ok.txt')), 'not-a-dir')
  assert.equal(listDenied('relative/dir'), 'relative-path')
  // a sensitively-named directory inside scope is refused wholesale
  const secretDir = path.join(dir, 'secrets')
  mkdirSync(secretDir, { recursive: true })
  try {
    assert.equal(listDenied(secretDir), 'sensitive')
  } finally {
    rmSync(secretDir, { recursive: true, force: true })
  }
})
