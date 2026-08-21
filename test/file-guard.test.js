// Ported from the bridge's test/file-link-guard.test.js (vitest) into the
// journal's node:test harness, plus net-new coverage for listDirGuarded and
// metaGuarded. Keeps the security-relevant cases identical so the two guard
// copies (bridge + journal) cannot silently diverge.
import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync, renameSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  isSensitivePath, checkFileLink, validateAndOpen, openGuarded, metaGuarded, listDirGuarded,
  pinAllowedRoots, pinAllowedRootsSync, FileLinkDenied, denialToStatus,
  validateWriteTarget, writeFileAtomic, mkdirGuarded, moveGuarded, trashGuarded,
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

// --- Phase-2 write primitives -----------------------------------------------
const writeDenied = async (fn) => {
  try {
    await fn()
  } catch (err) {
    assert.ok(err instanceof FileLinkDenied, `expected FileLinkDenied, got ${err}`)
    return err.reason
  }
  throw new Error('expected FileLinkDenied')
}

const makeWriteFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fg-write-root-'))
  const out = mkdtempSync(path.join(tmpdir(), 'fg-write-out-'))
  return {
    root,
    out,
    writeRoots: pinAllowedRootsSync([root]),
    cleanup() {
      rmSync(root, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
    },
  }
}

test('validateWriteTarget canonicalizes safe targets and rejects boundary escapes', () => {
  const f = makeWriteFixture()
  try {
    mkdirSync(path.join(f.root, 'existing'))
    assert.equal(
      validateWriteTarget(path.join(f.root, 'existing', '..', 'new.txt'), { writeRoots: f.writeRoots }),
      path.join(f.root, 'new.txt'),
    )
    assert.throws(
      () => validateWriteTarget(path.join(f.out, 'escape.txt'), { writeRoots: f.writeRoots }),
      (err) => err instanceof FileLinkDenied && err.reason === 'outside-scope',
    )
    assert.throws(
      () => validateWriteTarget('relative.txt', { writeRoots: f.writeRoots }),
      (err) => err instanceof FileLinkDenied && err.reason === 'relative-path',
    )
    assert.throws(
      () => validateWriteTarget(path.join(f.root, '.env'), { writeRoots: f.writeRoots }),
      (err) => err instanceof FileLinkDenied && err.reason === 'sensitive',
    )
    for (const target of [
      path.join(f.root, '.matron-trash'),
      path.join(f.root, '.matron-trash', 'saved.txt'),
      path.join(f.root, 'nested', '.matron-trash', 'saved.txt'),
    ]) {
      assert.throws(
        () => validateWriteTarget(target, { writeRoots: f.writeRoots }),
        (err) => err instanceof FileLinkDenied && err.reason === 'trash-protected',
      )
    }
  } finally {
    f.cleanup()
  }
})

test('every write helper rejects outside, sensitive, and symlink-escaped targets without mutation', async () => {
  const f = makeWriteFixture()
  try {
    const source = path.join(f.root, 'source.txt')
    const sensitive = path.join(f.root, '.env')
    writeFileSync(source, 'source')
    writeFileSync(sensitive, 'SECRET=1')
    symlinkSync(f.out, path.join(f.root, 'escape'))
    const cases = [
      () => writeFileAtomic(path.join(f.out, 'x.txt'), Buffer.from('x'), { writeRoots: f.writeRoots, maxBytes: 10 }),
      () => writeFileAtomic(path.join(f.root, '.env'), Buffer.from('x'), { writeRoots: f.writeRoots, maxBytes: 10 }),
      () => writeFileAtomic(path.join(f.root, 'escape', 'x.txt'), Buffer.from('x'), { writeRoots: f.writeRoots, maxBytes: 10 }),
      () => mkdirGuarded(path.join(f.out, 'dir'), { writeRoots: f.writeRoots }),
      () => mkdirGuarded(path.join(f.root, '.env', 'dir'), { writeRoots: f.writeRoots }),
      () => mkdirGuarded(path.join(f.root, 'escape', 'dir'), { writeRoots: f.writeRoots }),
      () => moveGuarded(source, path.join(f.out, 'moved.txt'), { writeRoots: f.writeRoots }),
      () => moveGuarded(source, path.join(f.root, '.env.local'), { writeRoots: f.writeRoots }),
      () => moveGuarded(source, path.join(f.root, 'escape', 'moved.txt'), { writeRoots: f.writeRoots }),
      () => moveGuarded(sensitive, path.join(f.root, 'moved-secret.txt'), { writeRoots: f.writeRoots }),
      () => moveGuarded(path.join(f.root, 'escape', 'target.txt'), path.join(f.root, 'moved.txt'), { writeRoots: f.writeRoots }),
      () => trashGuarded(path.join(f.out, 'x.txt'), { writeRoots: f.writeRoots }),
      () => trashGuarded(sensitive, { writeRoots: f.writeRoots }),
      () => trashGuarded(path.join(f.root, 'escape', 'x.txt'), { writeRoots: f.writeRoots }),
    ]
    for (const run of cases) await writeDenied(run)
    assert.equal(fs.readFileSync(source, 'utf8'), 'source')
    assert.equal(fs.existsSync(path.join(f.out, 'x.txt')), false)
    assert.equal(fs.existsSync(path.join(f.root, '.matron-trash')), false)
  } finally {
    f.cleanup()
  }
})

test('writeFileAtomic cleans its temp file when stream validation fails mid-operation', async () => {
  const f = makeWriteFixture()
  try {
    const target = path.join(f.root, 'invalid-stream.txt')
    async function* invalidStream() {
      yield Buffer.from('partial')
      yield { not: 'bytes' }
    }
    await assert.rejects(
      writeFileAtomic(target, invalidStream(), { writeRoots: f.writeRoots, maxBytes: 100 }),
      /stream chunks must be bytes/,
    )
    assert.equal(fs.existsSync(target), false)
    assert.deepEqual(fs.readdirSync(f.root).filter((name) => name.includes('.matron-tmp-')), [])
  } finally {
    f.cleanup()
  }
})

test('writeFileAtomic detects an ancestor swap before rename and cleans through the pinned parent fd', async () => {
  const f = makeWriteFixture()
  try {
    const parent = path.join(f.root, 'parent')
    const movedParent = path.join(f.root, 'moved-parent')
    const target = path.join(parent, 'target.txt')
    mkdirSync(parent)
    async function* swappingStream() {
      yield Buffer.from('first')
      renameSync(parent, movedParent)
      symlinkSync(f.out, parent)
      yield Buffer.from('second')
    }
    assert.equal(
      await writeDenied(() => writeFileAtomic(target, swappingStream(), { writeRoots: f.writeRoots, maxBytes: 100 })),
      'bad-workdir',
    )
    assert.equal(fs.existsSync(path.join(f.out, 'target.txt')), false)
    assert.deepEqual(fs.readdirSync(movedParent), [])
  } finally {
    f.cleanup()
  }
})

test('writeFileAtomic handles bytes and streams, enforces the cap, and leaves no partial target', async () => {
  const f = makeWriteFixture()
  try {
    const bytesTarget = path.join(f.root, 'bytes.txt')
    const streamTarget = path.join(f.root, 'stream.txt')
    const cappedTarget = path.join(f.root, 'capped.txt')
    writeFileSync(cappedTarget, 'old')
    assert.equal(await writeFileAtomic(bytesTarget, Buffer.from('bytes'), { writeRoots: f.writeRoots, maxBytes: 10 }), bytesTarget)
    assert.equal(
      await writeFileAtomic(streamTarget, fs.createReadStream(bytesTarget), { writeRoots: f.writeRoots, maxBytes: 10 }),
      streamTarget,
    )
    assert.equal(fs.readFileSync(bytesTarget, 'utf8'), 'bytes')
    assert.equal(fs.readFileSync(streamTarget, 'utf8'), 'bytes')
    assert.equal(
      await writeDenied(() => writeFileAtomic(cappedTarget, Buffer.from('too large'), { writeRoots: f.writeRoots, maxBytes: 3 })),
      'too-large',
    )
    assert.equal(fs.readFileSync(cappedTarget, 'utf8'), 'old')
    assert.deepEqual(fs.readdirSync(f.root).filter((name) => name.includes('.matron-tmp-')), [])
  } finally {
    f.cleanup()
  }
})

test('writeFileAtomic fsyncs the temp file before rename and the parent after rename', async (t) => {
  const f = makeWriteFixture()
  try {
    const target = path.join(f.root, 'durable.txt')
    const events = []
    const realFsync = fs.fsyncSync
    const realRename = fs.renameSync
    t.mock.method(fs, 'fsyncSync', (fd) => {
      events.push('fsync')
      return realFsync(fd)
    })
    t.mock.method(fs, 'renameSync', (from, to) => {
      events.push('rename')
      return realRename(from, to)
    })
    await writeFileAtomic(target, Buffer.from('durable'), { writeRoots: f.writeRoots, maxBytes: 20 })
    const renameAt = events.indexOf('rename')
    assert.ok(renameAt > 0, `expected pre-rename fsync: ${events}`)
    assert.ok(events.slice(renameAt + 1).includes('fsync'), `expected post-rename parent fsync: ${events}`)
  } finally {
    f.cleanup()
  }
})

test('mkdirGuarded creates nested directories and is idempotent', async () => {
  const f = makeWriteFixture()
  try {
    const target = path.join(f.root, 'one', 'two')
    assert.equal(await mkdirGuarded(target, { writeRoots: f.writeRoots }), target)
    assert.equal(await mkdirGuarded(target, { writeRoots: f.writeRoots }), target)
    assert.equal(fs.statSync(target).isDirectory(), true)
  } finally {
    f.cleanup()
  }
})

test('moveGuarded never clobbers an existing destination and validates both sides before mutation', async () => {
  const f = makeWriteFixture()
  try {
    const source = path.join(f.root, 'source.txt')
    const destination = path.join(f.root, 'destination.txt')
    writeFileSync(source, 'source')
    writeFileSync(destination, 'destination')
    assert.equal(await writeDenied(() => moveGuarded(source, destination, { writeRoots: f.writeRoots })), 'dest-exists')
    assert.equal(fs.readFileSync(source, 'utf8'), 'source')
    assert.equal(fs.readFileSync(destination, 'utf8'), 'destination')
    assert.equal(
      await writeDenied(() => moveGuarded(source, path.join(f.root, '.matron-trash', 'x'), { writeRoots: f.writeRoots })),
      'trash-protected',
    )
    assert.equal(fs.readFileSync(source, 'utf8'), 'source')
  } finally {
    f.cleanup()
  }
})

test('moveGuarded atomically renames a file on the same device', async () => {
  const f = makeWriteFixture()
  try {
    const source = path.join(f.root, 'source.txt')
    const destination = path.join(f.root, 'destination.txt')
    writeFileSync(source, 'moved')
    assert.deepEqual(await moveGuarded(source, destination, { writeRoots: f.writeRoots }), {
      from: source,
      to: destination,
    })
    assert.equal(fs.existsSync(source), false)
    assert.equal(fs.readFileSync(destination, 'utf8'), 'moved')
  } finally {
    f.cleanup()
  }
})

test('moveGuarded cross-device file fallback succeeds and rolls back the destination on source-unlink failure', async (t) => {
  const f = makeWriteFixture()
  try {
    const source = path.join(f.root, 'source.txt')
    const destination = path.join(f.root, 'destination.txt')
    writeFileSync(source, 'cross-device')
    const realRename = fs.renameSync
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (from === source && to === destination) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      return realRename(from, to)
    })
    assert.deepEqual(await moveGuarded(source, destination, { writeRoots: f.writeRoots }), { from: source, to: destination })
    assert.equal(fs.existsSync(source), false)
    assert.equal(fs.readFileSync(destination, 'utf8'), 'cross-device')
  } finally {
    f.cleanup()
  }

  const rollback = makeWriteFixture()
  try {
    const source = path.join(rollback.root, 'source.txt')
    const destination = path.join(rollback.root, 'destination.txt')
    writeFileSync(source, 'keep-me')
    const realRename = fs.renameSync
    const renameMock = mock.method(fs, 'renameSync', (from, to) => {
      if (from === source && to === destination) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      return realRename(from, to)
    })
    const realUnlink = fs.unlinkSync
    const unlinkMock = mock.method(fs, 'unlinkSync', (target) => {
      if (target === source) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return realUnlink(target)
    })
    try {
      await assert.rejects(moveGuarded(source, destination, { writeRoots: rollback.writeRoots }), /busy/)
    } finally {
      unlinkMock.mock.restore()
      renameMock.mock.restore()
    }
    assert.equal(fs.readFileSync(source, 'utf8'), 'keep-me')
    assert.equal(fs.existsSync(destination), false)
  } finally {
    rollback.cleanup()
  }
})

test('moveGuarded maps a cross-device directory move to cross-device-dir', async (t) => {
  const f = makeWriteFixture()
  try {
    const source = path.join(f.root, 'source-dir')
    const destination = path.join(f.root, 'destination-dir')
    mkdirSync(source)
    const realRename = fs.renameSync
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (from === source && to === destination) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      return realRename(from, to)
    })
    assert.equal(await writeDenied(() => moveGuarded(source, destination, { writeRoots: f.writeRoots })), 'cross-device-dir')
    assert.equal(fs.statSync(source).isDirectory(), true)
    assert.equal(fs.existsSync(destination), false)
  } finally {
    f.cleanup()
  }
})

test('trashGuarded enforces the recursive guard and protects the trash tree', async () => {
  const f = makeWriteFixture()
  try {
    const nonempty = path.join(f.root, 'nonempty')
    mkdirSync(nonempty)
    writeFileSync(path.join(nonempty, 'child.txt'), 'child')
    assert.equal(await writeDenied(() => trashGuarded(nonempty, { writeRoots: f.writeRoots, recursive: false })), 'dir-not-empty')
    assert.equal(fs.existsSync(nonempty), true)
    assert.equal(fs.existsSync(path.join(f.root, '.matron-trash')), false)

    const result = await trashGuarded(nonempty, { writeRoots: f.writeRoots, recursive: true })
    assert.equal(result.path, nonempty)
    assert.equal(result.already_missing, false)
    assert.equal(fs.existsSync(nonempty), false)
    assert.equal(fs.statSync(result.trashed).isDirectory(), true)
    assert.equal(fs.readFileSync(path.join(result.trashed, 'child.txt'), 'utf8'), 'child')
    assert.equal(
      await writeDenied(() => trashGuarded(result.trashed, { writeRoots: f.writeRoots, recursive: true })),
      'trash-protected',
    )
    assert.equal(
      await writeDenied(() => moveGuarded(result.trashed, path.join(f.root, 'restored'), { writeRoots: f.writeRoots })),
      'trash-protected',
    )
  } finally {
    f.cleanup()
  }
})

test('trashGuarded handles cross-device files and maps cross-device directories to trash-write-failed', async (t) => {
  const f = makeWriteFixture()
  try {
    const sourceFile = path.join(f.root, 'source.txt')
    const sourceDir = path.join(f.root, 'source-dir')
    writeFileSync(sourceFile, 'recoverable')
    mkdirSync(sourceDir)
    const realRename = fs.renameSync
    t.mock.method(fs, 'renameSync', (from, to) => {
      if ((from === sourceFile || from === sourceDir) && to.includes(`${path.sep}.matron-trash${path.sep}`)) {
        throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      }
      return realRename(from, to)
    })
    const fileResult = await trashGuarded(sourceFile, { writeRoots: f.writeRoots })
    assert.equal(fs.existsSync(sourceFile), false)
    assert.equal(fs.readFileSync(fileResult.trashed, 'utf8'), 'recoverable')
    assert.equal(
      await writeDenied(() => trashGuarded(sourceDir, { writeRoots: f.writeRoots, recursive: true })),
      'trash-write-failed',
    )
    assert.equal(fs.statSync(sourceDir).isDirectory(), true)
    assert.deepEqual(fs.readdirSync(path.join(f.root, '.matron-trash')).sort(), [path.basename(fileResult.trashed)])
  } finally {
    f.cleanup()
  }
})

test('trashGuarded rejects a replaced trash directory before moving the source', async () => {
  const f = makeWriteFixture()
  try {
    const source = path.join(f.root, 'source.txt')
    writeFileSync(source, 'source')
    symlinkSync(f.out, path.join(f.root, '.matron-trash'))
    assert.equal(await writeDenied(() => trashGuarded(source, { writeRoots: f.writeRoots })), 'trash-write-failed')
    assert.equal(fs.readFileSync(source, 'utf8'), 'source')
    assert.deepEqual(fs.readdirSync(f.out), [])
  } finally {
    f.cleanup()
  }
})

test('two same-basename deletes both survive and delete-missing is idempotent', async () => {
  const f = makeWriteFixture()
  try {
    mkdirSync(path.join(f.root, 'a'))
    mkdirSync(path.join(f.root, 'b'))
    const first = path.join(f.root, 'a', 'same.txt')
    const second = path.join(f.root, 'b', 'same.txt')
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')
    const [one, two] = await Promise.all([
      trashGuarded(first, { writeRoots: f.writeRoots }),
      trashGuarded(second, { writeRoots: f.writeRoots }),
    ])
    assert.notEqual(one.trashed, two.trashed)
    assert.deepEqual(
      new Set([fs.readFileSync(one.trashed, 'utf8'), fs.readFileSync(two.trashed, 'utf8')]),
      new Set(['first', 'second']),
    )
    assert.deepEqual(await trashGuarded(first, { writeRoots: f.writeRoots }), {
      path: first,
      trashed: null,
      already_missing: true,
    })
  } finally {
    f.cleanup()
  }
})
