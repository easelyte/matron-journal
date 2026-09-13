// Phase-2 T-1.3: the append-only JSONL write audit. The security contract is
// narrow and absolute — one line per attempt, one write() syscall per line,
// never file content, never a field the allowlist does not name, and a failed
// append is a REFUSAL (fail-closed), never a silently-unlogged mutation.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  FILE_AUDIT_BASENAME, FileAuditFailed, appendAudit, auditPathFor, makeFileAudit,
} from '../src/file-audit.js'

const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'matron-audit-')))
const lines = (dir) => fs.readFileSync(path.join(dir, FILE_AUDIT_BASENAME), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('appendAudit: one JSONL line per attempt, append-only, allowlisted fields only', () => {
  const dir = tmpDir()
  appendAudit(dir, { ts: 1, deviceId: 7, op: 'write', path: '/w/a.txt', bytes: 3, result: 'attempt' })
  appendAudit(dir, { ts: 2, deviceId: 7, op: 'write', path: '/w/a.txt', bytes: 3, result: 'ok' })
  const rows = lines(dir)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { ts: 1, deviceId: 7, op: 'write', path: '/w/a.txt', bytes: 3, result: 'attempt' })
  assert.deepEqual(rows[1], { ts: 2, deviceId: 7, op: 'write', path: '/w/a.txt', bytes: 3, result: 'ok' })
  // A third append must not truncate the first two.
  appendAudit(dir, { ts: 3, deviceId: 7, op: 'delete', path: '/w/a.txt', to: '/w/.matron-trash/x', result: 'ok' })
  assert.equal(lines(dir).length, 3)
})

test('appendAudit: content and unknown fields are dropped, never serialized (R500)', () => {
  const dir = tmpDir()
  appendAudit(dir, {
    ts: 1, deviceId: 7, op: 'write', path: '/w/a.env', result: 'denied', reason: 'sensitive',
    content: 'SECRET=hunter2', body: 'hunter2', token: 'ghp_x', authorization: 'Bearer t',
  })
  const raw = fs.readFileSync(path.join(dir, FILE_AUDIT_BASENAME), 'utf8')
  assert.ok(!raw.includes('hunter2'))
  assert.ok(!raw.includes('ghp_x'))
  assert.ok(!raw.includes('Bearer'))
  assert.deepEqual(lines(dir)[0], {
    ts: 1, deviceId: 7, op: 'write', path: '/w/a.env', result: 'denied', reason: 'sensitive',
  })
})

test('appendAudit: move and delete record both endpoints via `to`', () => {
  const dir = tmpDir()
  appendAudit(dir, { ts: 1, deviceId: 2, op: 'move', path: '/w/a', to: '/w/b', result: 'ok' })
  appendAudit(dir, { ts: 2, deviceId: 2, op: 'delete', path: '/w/b', to: '/w/.matron-trash/2026-b', result: 'ok' })
  const rows = lines(dir)
  assert.equal(rows[0].to, '/w/b')
  assert.equal(rows[1].to, '/w/.matron-trash/2026-b')
})

test('appendAudit: a rejected op/result/shape throws rather than writing a malformed line', () => {
  const dir = tmpDir()
  for (const bad of [
    { ts: 1, deviceId: 1, op: 'chmod', path: '/w/a', result: 'ok' },
    { ts: 1, deviceId: 1, op: 'write', path: '/w/a', result: 'maybe' },
    { ts: 1, deviceId: 1, op: 'write', path: 'relative', result: 'ok' },
    { ts: 1, deviceId: 1, op: 'write', result: 'ok' },
    { ts: 1, deviceId: 1, op: 'write', path: '/w/a', result: 'ok', bytes: -1 },
    { ts: 1, deviceId: 1, op: 'write', path: `/w/${'a'.repeat(9000)}`, result: 'ok' },
  ]) {
    assert.throws(() => appendAudit(dir, bad), FileAuditFailed, JSON.stringify(bad))
  }
  assert.ok(!fs.existsSync(path.join(dir, FILE_AUDIT_BASENAME)))
})

test('appendAudit: a line never contains an embedded newline (one line = one record)', () => {
  const dir = tmpDir()
  appendAudit(dir, { ts: 1, deviceId: 1, op: 'mkdir', path: '/w/a\nb/c', result: 'ok' })
  const raw = fs.readFileSync(path.join(dir, FILE_AUDIT_BASENAME), 'utf8')
  assert.equal(raw.split('\n').filter(Boolean).length, 1)
  assert.equal(JSON.parse(raw).path, '/w/a\nb/c')
})

test('appendAudit: an unwritable audit directory throws FileAuditFailed (fail-closed)', () => {
  const dir = path.join(tmpDir(), 'does', 'not', 'exist')
  assert.throws(
    () => appendAudit(dir, { ts: 1, deviceId: 1, op: 'write', path: '/w/a', result: 'attempt' }),
    FileAuditFailed,
  )
})

test('appendAudit: each record is written in a SINGLE write() syscall', (t) => {
  const dir = tmpDir()
  const writes = []
  const realWriteSync = fs.writeSync
  t.mock.method(fs, 'writeSync', (fd, buf, ...rest) => {
    writes.push(Buffer.isBuffer(buf) ? buf.length : String(buf).length)
    return realWriteSync(fd, buf, ...rest)
  })
  appendAudit(dir, { ts: 1, deviceId: 1, op: 'upload', path: '/w/a', bytes: 12, result: 'ok' })
  assert.equal(writes.length, 1)
  const raw = fs.readFileSync(path.join(dir, FILE_AUDIT_BASENAME))
  assert.equal(writes[0], raw.length)
  assert.equal(raw[raw.length - 1], 0x0a)
})

test('appendAudit: a short write is a failure, not a half-line on disk', (t) => {
  const dir = tmpDir()
  t.mock.method(fs, 'writeSync', () => 3)
  assert.throws(
    () => appendAudit(dir, { ts: 1, deviceId: 1, op: 'write', path: '/w/a', result: 'attempt' }),
    FileAuditFailed,
  )
})

test('concurrent appends interleave without corrupting a line', async () => {
  const dir = tmpDir()
  const many = 200
  await Promise.all(Array.from({ length: many }, (_, i) => (async () => {
    appendAudit(dir, { ts: i, deviceId: i, op: 'mkdir', path: `/w/dir-${i}`, result: 'ok' })
  })()))
  const rows = lines(dir)
  assert.equal(rows.length, many)
  assert.deepEqual(new Set(rows.map((r) => r.ts)).size, many)
})

test('auditPathFor / makeFileAudit: the log sits beside the DB, and the maker binds the dir', () => {
  const dir = tmpDir()
  assert.equal(auditPathFor(path.join(dir, 'matron.db')), path.join(dir, FILE_AUDIT_BASENAME))
  assert.equal(auditPathFor(':memory:'), null)
  const audit = makeFileAudit(dir)
  audit({ ts: 5, deviceId: 1, op: 'move', path: '/w/a', to: '/w/b', result: 'ok' })
  assert.equal(lines(dir)[0].ts, 5)
  assert.equal(makeFileAudit(null), null)
})

test('appendAudit: creating the log fsyncs its parent directory, not just the file (F7)', (t) => {
  const dir = tmpDir()
  const synced = []
  const realFsync = fs.fsyncSync
  const realOpen = fs.openSync
  const dirFds = new Set()
  t.mock.method(fs, 'openSync', (target, flags, mode) => {
    const fd = realOpen(target, flags, mode)
    if (target === dir) dirFds.add(fd)
    return fd
  })
  t.mock.method(fs, 'fsyncSync', (fd) => {
    synced.push(dirFds.has(fd) ? 'dir' : 'file')
    return realFsync(fd)
  })

  appendAudit(dir, { ts: 1, deviceId: 1, op: 'write', path: '/w/a', result: 'attempt' })
  assert.deepEqual(synced, ['file', 'dir'], 'the new directory entry is made durable too')

  // Only once per file lifetime — subsequent appends do not re-fsync the dir.
  synced.length = 0
  appendAudit(dir, { ts: 2, deviceId: 1, op: 'write', path: '/w/a', result: 'ok' })
  assert.deepEqual(synced, ['file'])
})
