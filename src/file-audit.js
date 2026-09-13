// Append-only JSONL audit for the File Explorer write API (spec §5.3, plan
// T-1.3). Every write ATTEMPT lands here — allowed, denied, or errored — and
// for a destructive op the "attempt" line is written (and fsynced) BEFORE the
// first irreversible filesystem call, so there is no such thing as an
// unlogged destructive change outside a process crash.
//
// Two hard contracts:
//
//  1. R500 — the record is built from an ALLOWLIST. File content, request
//     bodies, headers, tokens: none of them have a field here, and an extra
//     key on the caller's object is dropped rather than serialized. The only
//     client-controlled strings that reach disk are paths, which the guard
//     has already denylist-filtered for every op that succeeds.
//
//  2. One line = one write() syscall. O_APPEND's "seek to EOF and write" is
//     atomic PER write(2) on a local filesystem; a line split across two
//     writes can interleave with a concurrent writer's line and corrupt
//     both. So the line is assembled into one Buffer and written once, and a
//     short write is a hard failure rather than a half-record on disk.
//
// Failure posture: throw. The caller maps a throw to 507 and performs NO
// mutation (fail-closed). Silently continuing would be the one outcome this
// module exists to prevent.
import fs from 'node:fs'
import path from 'node:path'

export const FILE_AUDIT_BASENAME = 'file-audit.jsonl'

// Bounds one record so a pathological path cannot write an unbounded line
// (and cannot push a line past the size where a single write() stays sane).
const MAX_PATH_CHARS = 4096
const MAX_REASON_CHARS = 64
const MAX_LINE_BYTES = 16 * 1024

const OPS = new Set(['upload', 'mkdir', 'move', 'write', 'delete'])
// attempt = the write-ahead intent line; ok/denied/error = the outcome.
const RESULTS = new Set(['attempt', 'ok', 'denied', 'error'])

export class FileAuditFailed extends Error {
  constructor(message, cause) {
    super(`file audit failed: ${message}`)
    this.name = 'FileAuditFailed'
    if (cause) this.cause = cause
  }
}

const badRecord = (message) => { throw new FileAuditFailed(message) }

// The allowlist itself. Anything not returned by this function cannot reach
// the log, which is what makes "never logs content" a structural property
// rather than a discipline the call sites have to remember.
function auditRecord(entry) {
  if (entry === null || typeof entry !== 'object') badRecord('record must be an object')
  const { ts, deviceId, op, path: target, to, bytes, result, reason } = entry
  if (!Number.isFinite(ts)) badRecord('ts must be a finite number')
  if (!(Number.isInteger(deviceId) || typeof deviceId === 'string') || deviceId === '') {
    badRecord('deviceId must be an integer or a non-empty string')
  }
  if (!OPS.has(op)) badRecord(`unknown op ${JSON.stringify(op)}`)
  if (!RESULTS.has(result)) badRecord(`unknown result ${JSON.stringify(result)}`)
  if (typeof target !== 'string' || !path.isAbsolute(target) || target.length > MAX_PATH_CHARS) {
    badRecord('path must be an absolute string within the length bound')
  }
  const record = { ts, deviceId, op, path: target }
  if (to !== undefined && to !== null) {
    if (typeof to !== 'string' || !path.isAbsolute(to) || to.length > MAX_PATH_CHARS) {
      badRecord('to must be an absolute string within the length bound')
    }
    record.to = to
  }
  if (bytes !== undefined && bytes !== null) {
    if (!Number.isInteger(bytes) || bytes < 0) badRecord('bytes must be a non-negative integer')
    record.bytes = bytes
  }
  record.result = result
  if (reason !== undefined && reason !== null) {
    if (typeof reason !== 'string' || !reason || reason.length > MAX_REASON_CHARS) {
      badRecord('reason must be a short non-empty string')
    }
    record.reason = reason
  }
  return record
}

// `<dirname(dbPath)>/file-audit.jsonl`, mirroring resolveMediaDir's rule that
// runtime state lives beside the database. An in-memory DB has no data
// directory, so it has no audit path — the server treats that as "writes
// cannot be enabled" rather than scattering a log into the process CWD.
export function auditPathFor(dbPath) {
  if (!dbPath || dbPath === ':memory:') return null
  return path.join(path.dirname(path.resolve(dbPath)), FILE_AUDIT_BASENAME)
}

export function appendAudit(dir, entry) {
  const record = auditRecord(entry)
  // JSON.stringify escapes every control character, so an embedded newline in
  // a path is \n in the serialized form — the line separator below can only
  // ever be the one this function appends.
  const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
  if (line.length > MAX_LINE_BYTES) badRecord('record exceeds the line size bound')
  const target = path.join(dir, FILE_AUDIT_BASENAME)
  let fd
  try {
    // O_APPEND, never O_TRUNC: the log is append-only by construction, so a
    // bug here cannot erase history. 0o600 — it names paths the operator
    // touched, and nothing else on the box needs to read it.
    fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600)
    const written = fs.writeSync(fd, line)
    // A short write cannot be completed with a second write() without risking
    // a concurrent writer's line landing between the halves. Fail instead.
    if (written !== line.length) badRecord(`short write (${written}/${line.length} bytes)`)
    fs.fsyncSync(fd)
  } catch (err) {
    if (err instanceof FileAuditFailed) throw err
    throw new FileAuditFailed(`could not append to ${target}`, err)
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* the line is already durable */ } }
  }
  return record
}

// Binds the audit directory once, at the trusted boundary, so request
// handlers carry a function rather than a path they could be talked into
// changing. A null directory (writes disabled / no data dir) yields null.
export function makeFileAudit(dir) {
  if (!dir) return null
  return (entry) => appendAudit(dir, entry)
}
