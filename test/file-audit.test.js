// Phase-2 T-1.3: the append-only JSONL write audit. The security contract is
// narrow and absolute — one line per attempt, one write() syscall per line,
// never file content, never a field the allowlist does not name, and a failed
// append is a REFUSAL (fail-closed), never a silently-unlogged mutation.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
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

test('appendAudit: a short write is rolled back, not left as a half-line on disk', (t) => {
  const dir = tmpDir()
  appendAudit(dir, { ts: 1, deviceId: 1, op: 'write', path: '/w/a', result: 'ok' })
  const intact = fs.readFileSync(path.join(dir, FILE_AUDIT_BASENAME))

  // A REAL short write: the fragment actually reaches the file, which is the
  // condition that would otherwise corrupt the next record appended after it.
  const realWriteSync = fs.writeSync
  let shortened = false
  t.mock.method(fs, 'writeSync', (fd, buf, ...rest) => {
    if (!shortened && Buffer.isBuffer(buf)) {
      shortened = true
      return realWriteSync(fd, buf.subarray(0, 5), ...rest)
    }
    return realWriteSync(fd, buf, ...rest)
  })
  assert.throws(
    () => appendAudit(dir, { ts: 2, deviceId: 1, op: 'write', path: '/w/b', result: 'attempt' }),
    FileAuditFailed,
  )
  assert.equal(shortened, true)
  t.mock.restoreAll()

  // The fragment is gone and the log is still valid JSONL.
  assert.deepEqual(fs.readFileSync(path.join(dir, FILE_AUDIT_BASENAME)), intact)
  appendAudit(dir, { ts: 3, deviceId: 1, op: 'write', path: '/w/c', result: 'ok' })
  const rows = lines(dir)
  assert.deepEqual(rows.map((r) => r.ts), [1, 3])
})

test('appendAudit: an unrepairable short write poisons the log and refuses every later append', (t) => {
  const dir = tmpDir()
  const realWriteSync = fs.writeSync
  t.mock.method(fs, 'writeSync', (fd, buf, ...rest) =>
    (Buffer.isBuffer(buf) ? realWriteSync(fd, buf.subarray(0, 4), ...rest) : realWriteSync(fd, buf, ...rest)))
  t.mock.method(fs, 'ftruncateSync', () => { throw Object.assign(new Error('io'), { code: 'EIO' }) })

  assert.throws(
    () => appendAudit(dir, { ts: 1, deviceId: 1, op: 'delete', path: '/w/a', result: 'attempt' }),
    /COULD NOT BE REPAIRED/,
  )
  t.mock.restoreAll()
  // Fail-closed for good: callers map this to 507, so writes stop rather than
  // proceed unauditable.
  assert.throws(
    () => appendAudit(dir, { ts: 2, deviceId: 1, op: 'delete', path: '/w/a', result: 'attempt' }),
    /refusing to append/,
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

test('R3-F4: the short-write rollback refuses to truncate over a concurrent append', (t) => {
  const dir = tmpDir()
  appendAudit(dir, { ts: 1, deviceId: 1, op: 'write', path: '/w/a', result: 'ok' })

  // A competing writer lands a COMPLETE record between our snapshot and our
  // rollback. Truncating back to the snapshot would erase it, so we must not.
  const realWriteSync = fs.writeSync
  t.mock.method(fs, 'writeSync', (fd, buf, ...rest) => {
    if (!Buffer.isBuffer(buf)) return realWriteSync(fd, buf, ...rest)
    const short = realWriteSync(fd, buf.subarray(0, 5), ...rest)
    fs.appendFileSync(path.join(dir, FILE_AUDIT_BASENAME), JSON.stringify({ other: 'process' }) + '\n')
    return short
  })
  assert.throws(
    () => appendAudit(dir, { ts: 2, deviceId: 1, op: 'delete', path: '/w/b', result: 'attempt' }),
    /COULD NOT BE REPAIRED/,
  )
  t.mock.restoreAll()
  const raw = fs.readFileSync(path.join(dir, FILE_AUDIT_BASENAME), 'utf8')
  assert.ok(raw.includes('"other":"process"'), 'the other writer\'s record survives')
  // And the log is fail-closed from here, since its tail is now a fragment.
  assert.throws(() => appendAudit(dir, { ts: 3, deviceId: 1, op: 'write', path: '/w/c', result: 'ok' }), /refusing to append/)
})

test('R3-F5: a log left with a partial tail by a dead process is refused, not appended to', () => {
  const dir = tmpDir()
  const target = path.join(dir, FILE_AUDIT_BASENAME)
  // Exactly what a process killed between write() and rollback leaves behind.
  fs.writeFileSync(target, `${JSON.stringify({ ts: 1, op: 'delete' })}\n{"ts":2,"op":"del`)

  assert.throws(
    () => appendAudit(dir, { ts: 3, deviceId: 1, op: 'delete', path: '/w/a', result: 'attempt' }),
    /partial line/,
  )
  // Nothing was welded onto the fragment.
  assert.ok(fs.readFileSync(target, 'utf8').endsWith('{"ts":2,"op":"del'))
  // A well-formed log is accepted, so the check is about the tail and not about
  // simply refusing every pre-existing file.
  const clean = tmpDir()
  fs.writeFileSync(path.join(clean, FILE_AUDIT_BASENAME), `${JSON.stringify({ ts: 1 })}\n`)
  appendAudit(clean, { ts: 2, deviceId: 1, op: 'write', path: '/w/a', result: 'ok' })
  assert.equal(lines(clean).length, 2)
})

test('R4: the audit sink refuses a symlinked or non-regular log', () => {
  const dir = tmpDir()
  const elsewhere = tmpDir()
  const victim = path.join(elsewhere, 'some-other-state.json')
  fs.writeFileSync(victim, '{"important":true}\n')
  fs.symlinkSync(victim, path.join(dir, FILE_AUDIT_BASENAME))

  assert.throws(
    () => appendAudit(dir, { ts: 1, deviceId: 1, op: 'delete', path: '/w/a', result: 'attempt' }),
    FileAuditFailed,
  )
  assert.equal(fs.readFileSync(victim, 'utf8'), '{"important":true}\n', 'the link target is untouched')

  const asDir = tmpDir()
  fs.mkdirSync(path.join(asDir, FILE_AUDIT_BASENAME))
  assert.throws(
    () => appendAudit(asDir, { ts: 1, deviceId: 1, op: 'delete', path: '/w/a', result: 'attempt' }),
    FileAuditFailed,
  )
})

test('R6: a FIFO audit target fails closed instead of blocking the process', () => {
  const dir = tmpDir()
  const target = path.join(dir, FILE_AUDIT_BASENAME)
  const made = spawnSync('mkfifo', [target])
  if (made.error || made.status !== 0) return    // no mkfifo on this host

  // Opening a reader-less FIFO for writing blocks forever without O_NONBLOCK,
  // and this runs on Node's only thread — so the whole server would wedge
  // rather than answer 507. It must refuse, and refuse promptly.
  const started = Date.now()
  assert.throws(
    () => appendAudit(dir, { ts: 1, deviceId: 1, op: 'delete', path: '/w/a', result: 'attempt' }),
    FileAuditFailed,
  )
  assert.ok(Date.now() - started < 2000, 'the refusal is immediate, not a block')
})

test('R7: the tail check reads the very inode the line lands on, not the pathname', (t) => {
  const dir = tmpDir()
  const target = path.join(dir, FILE_AUDIT_BASENAME)
  // The log on disk ends in a FRAGMENT — a previous process died mid-append.
  const fragment = '{"ts":1,"op":"del'
  fs.writeFileSync(target, fragment)
  // A replacement of EXACTLY the same size whose last byte IS a newline. If the
  // tail is inspected by re-opening the name instead of by reading the open
  // descriptor, this file answers the question — and answers it "intact" — for
  // an inode the append will never touch.
  const rotatedIn = path.join(dir, 'rotated-in.jsonl')
  fs.writeFileSync(rotatedIn, `${'x'.repeat(fragment.length - 1)}\n`)

  // Rotation/restore lands in the window between the two opens: the append
  // descriptor exists and still points at the fragment, while the NAME now
  // resolves to the clean replacement.
  const realOpen = fs.openSync
  let swapped = false
  t.mock.method(fs, 'openSync', (p, ...rest) => {
    const fd = realOpen(p, ...rest)
    if (!swapped && p === target) {
      swapped = true
      fs.renameSync(rotatedIn, target)
    }
    return fd
  })

  assert.throws(
    () => appendAudit(dir, { ts: 2, deviceId: 1, op: 'delete', path: '/w/a', result: 'attempt' }),
    /partial line/,
    'the fragment on the descriptor we are about to append to must refuse the write',
  )
  t.mock.restoreAll()
  assert.ok(swapped, 'the pathname really was replaced mid-call')
  // And nothing was welded onto either inode.
  assert.equal(fs.readFileSync(target, 'utf8'), `${'x'.repeat(fragment.length - 1)}\n`)
})

test('R7-F1: a record that lands in a rotated-away inode refuses the operation', (t) => {
  const dir = tmpDir()
  const target = path.join(dir, FILE_AUDIT_BASENAME)
  // Unlike R7 above, the original log is WELL FORMED — the tail check passes,
  // the line is written and fsynced. The defect is where it ends up.
  fs.writeFileSync(target, `${JSON.stringify({ ts: 1, op: 'write' })}\n`)
  const rotatedIn = path.join(dir, 'rotated-in.jsonl')
  fs.writeFileSync(rotatedIn, '')

  // Rotation lands after the descriptor exists: the append goes to an inode the
  // name no longer resolves to, and close() releases its last link.
  const realOpen = fs.openSync
  let swapped = false
  t.mock.method(fs, 'openSync', (p, ...rest) => {
    const fd = realOpen(p, ...rest)
    if (!swapped && p === target) {
      swapped = true
      fs.renameSync(rotatedIn, target)
    }
    return fd
  })

  assert.throws(
    () => appendAudit(dir, { ts: 2, deviceId: 1, op: 'delete', path: '/w/a', result: 'attempt' }),
    /was replaced while this record was being written/,
    'a write-ahead record the live log never received must not authorize the mutation',
  )
  t.mock.restoreAll()
  assert.ok(swapped, 'the pathname really was rotated mid-call')
  // The live log holds no intent for the refused operation.
  assert.equal(fs.readFileSync(target, 'utf8'), '')
  // And the refusal is NOT sticky: the next append lands on the new file.
  appendAudit(dir, { ts: 3, deviceId: 1, op: 'delete', path: '/w/a', result: 'attempt' })
  assert.deepEqual(lines(dir).map((r) => r.ts), [3])
})

test('R7-F1: an audit log unlinked mid-append refuses the operation', (t) => {
  const dir = tmpDir()
  const target = path.join(dir, FILE_AUDIT_BASENAME)
  fs.writeFileSync(target, `${JSON.stringify({ ts: 1, op: 'write' })}\n`)

  const realOpen = fs.openSync
  let removed = false
  t.mock.method(fs, 'openSync', (p, ...rest) => {
    const fd = realOpen(p, ...rest)
    if (!removed && p === target) {
      removed = true
      fs.unlinkSync(target)
    }
    return fd
  })

  assert.throws(
    () => appendAudit(dir, { ts: 2, deviceId: 1, op: 'delete', path: '/w/a', result: 'attempt' }),
    /was replaced or removed while this record was being written/,
  )
  t.mock.restoreAll()
  assert.ok(removed)
})
