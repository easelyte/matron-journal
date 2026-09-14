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
//  3. ONE WRITER owns this sink. The server is a single `node src/server.js`
//     (deploy/matron-journal.service, Type=simple, one ExecStart), so every
//     append is serialized by Node's one thread and the read-check-write
//     sequence below is atomic by construction. That is a CONTRACT, not an
//     accident: a second appending process would race the tail check against
//     another writer's in-flight short write — A validates an intact tail, B
//     leaves a fragment, A's atomic append lands after it and reports success
//     on an intent that is now unparsable, and B's rollback guard correctly
//     refuses to truncate A's bytes but cannot revoke A's gate. Nothing here
//     takes an interprocess lock, so a second writer is not a thing to be
//     careful about — it is unsupported. Adding one means putting
//     fstat -> tail -> write/rollback -> fsync under a real file lock first
//     (Codex R7-F2). Log ROTATION from another process is supported and is
//     handled by the identity check after fsync, below.
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

// A log whose tail could not be repaired after a short write is POISONED: its
// last line may be a fragment, so every later append would concatenate onto it
// and produce unparsable JSON exactly where the evidence matters most. Once
// poisoned, this process refuses to append at all — which, because callers map
// a throw to 507-with-no-mutation, means writes stop rather than proceed
// unauditable. Recovery is an operator action (repair or rotate the file, then
// restart), deliberately not something the server decides for itself.
const poisoned = new Set()

// A log whose last byte is not a newline ends in a fragment — a previous
// process died between its write() and the rollback. Appending onto it would
// weld the next intent record to that fragment and make BOTH unparsable, so the
// tail is checked before this process appends (Codex R3-F5).
//
// The check runs on EVERY append, through the descriptor the line is about to
// land on — never a memo keyed by pathname. A memo is a statement about the
// file that WAS at that name: one rotation, restore or inode reuse later it is
// a statement about nothing, and the append proceeds on a fragment it never
// looked at (Codex R7). The cost of being right is a one-byte pread per audit
// record. The tradeoff taken deliberately: a fragment another writer is
// mid-rollback on now refuses this append instead of being welded onto, which
// is the fail-closed side of a module that exists to refuse.
function assertIntactTail(fd, target, size) {
  if (size === 0) return
  const last = Buffer.alloc(1)
  const read = fs.readSync(fd, last, 0, 1, size - 1)
  if (read !== 1 || last[0] !== 0x0a) {
    poisoned.add(target)
    throw new FileAuditFailed(`${target} ends in a partial line (a previous process died mid-append); repair or rotate it and restart`)
  }
}

// O_APPEND + O_NOFOLLOW pin this append to ONE inode, which is what makes the
// tail check above trustworthy — but the pathname is not pinned to it. A
// rotation or restore landing after our open leaves the record durable in an
// inode nothing can reach any more (close() releases the last link), while the
// LIVE log holds no write-ahead entry for the mutation the caller is about to
// make. Durability in an orphan is not evidence, so the name is re-resolved
// after fsync and a mismatch REFUSES the append (Codex R7-F1).
//
// Not poison: rotation is a legitimate operator action, and the next call opens
// the new file and succeeds normally. This attempt simply does not get to
// authorize a mutation it cannot evidence. lstat, not stat, so a replacement
// that is a symlink is a mismatch rather than something to follow.
//
// The check follows the write deliberately. It cannot close the window (a
// rotation one instruction later is always possible without an interprocess
// lock) — what it guarantees is the direction that matters: any rotation this
// misses happened AFTER the intent was durably recorded on the log that was
// live at the time, so no destructive op is ever authorized by a record the
// live log never received.
function assertRecordIsReachable(fd, target, opened) {
  let live
  try {
    live = fs.lstatSync(target)
  } catch (err) {
    throw new FileAuditFailed(`${target} was replaced or removed while this record was being written; the live log holds no write-ahead entry, so the operation is refused`, err)
  }
  if (live.dev !== opened.dev || live.ino !== opened.ino) {
    throw new FileAuditFailed(`${target} was replaced while this record was being written; the record is durable only in the rotated-away file, so the operation is refused`)
  }
}

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
  if (poisoned.has(target)) {
    throw new FileAuditFailed(`${target} has an unrepaired partial line; refusing to append (repair or rotate the file and restart)`)
  }
  let fd
  let created = false
  let sizeBefore = 0
  try {
    // O_APPEND, never O_TRUNC: the log is append-only by construction, so a
    // bug here cannot erase history. 0o600 — it names paths the operator
    // touched, and nothing else on the box needs to read it. O_EXCL first so
    // we learn whether THIS call created the file (see the directory fsync).
    try {
      fd = fs.openSync(
        target,
        fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      )
      created = true
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      // O_NOFOLLOW: `file-audit.jsonl` left as a symlink by a bad rotation or
      // restore would otherwise make the first authenticated write append this
      // server's JSON into whatever the link points at — and fsync it — while
      // the audit gate reported success (Codex R4).
      //
      // O_NONBLOCK: the type check below cannot run until open() returns, and
      // opening a FIFO for writing BLOCKS until a reader appears. On Node's
      // single thread that is not a failed write, it is a wedged server — so
      // refuse to block at all. A no-op on a regular file (Codex R6).
      //
      // O_RDWR rather than O_WRONLY: the tail check has to READ the same inode
      // this descriptor appends to. Re-opening the pathname to read it gave a
      // rotation or restore a window to slip a clean same-sized replacement
      // under the name — the check then passed on the replacement while the
      // line landed on the original's fragment, and the audit gate reported
      // success. One descriptor for fstat, tail, write and fsync is what makes
      // check and act share guard scope (Codex R7).
      fd = fs.openSync(
        target,
        fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        0o600,
      )
    }
    // One fstat on the one descriptor: type and size both describe the inode
    // this call is about to append to, whatever the name resolves to by now.
    const opened = fs.fstatSync(fd)
    if (!opened.isFile()) {
      poisoned.add(target)
      throw new FileAuditFailed(`${target} is not a regular file; refusing to append`)
    }
    // The offset this append must roll back to if it only partly lands.
    sizeBefore = opened.size
    // A file this call created with O_EXCL is empty, and its descriptor is
    // write-only — there is no tail to read and nothing that could have died
    // mid-append on it.
    if (!created) assertIntactTail(fd, target, sizeBefore)
    const written = fs.writeSync(fd, line)
    // A short write (ENOSPC, an I/O fault) cannot be finished with a second
    // write(): under O_APPEND a concurrent writer's line could land between the
    // halves. Worse, leaving the fragment in place would corrupt the NEXT
    // record too, since it would be appended directly onto an unterminated
    // line. So roll the fragment back to the byte offset the file had before
    // this attempt, verify the rollback, and only then report the failure.
    if (written !== line.length) {
      let repaired = false
      try {
        // Truncating a SHARED log is only safe if nothing else appended in the
        // meantime — otherwise the rollback would delete another writer's
        // complete intent record and let its mutation proceed unlogged (Codex
        // R3-F4). If the file is not exactly our fragment past the snapshot,
        // refuse to truncate and poison instead.
        const current = fs.fstatSync(fd).size
        if (current === sizeBefore + written) {
          fs.ftruncateSync(fd, sizeBefore)
          repaired = fs.fstatSync(fd).size === sizeBefore
        }
      } catch { repaired = false }
      if (!repaired) poisoned.add(target)
      badRecord(`short write (${written}/${line.length} bytes)${repaired ? ', partial line rolled back' : '; THE LOG TAIL COULD NOT BE REPAIRED — auditing is now refused'}`)
    }
    fs.fsyncSync(fd)
    // Durable — but durable somewhere the live log can still be read from?
    assertRecordIsReachable(fd, target, opened)
    // fsync on the FILE does not make a brand-new directory ENTRY durable. On
    // the very first write after a deploy (or after the log is rotated away) a
    // power loss could otherwise keep the committed mutation and lose the
    // filename carrying its write-ahead record — precisely the guarantee this
    // module exists to provide. One extra fsync, once per file lifetime.
    if (created) {
      const dirFd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
      try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
    }
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
