// Durable idempotency for the file WRITE API (loop #644), replacing the
// in-memory Map that files-write-http.js shipped with.
//
// WHY THIS EXISTS. The Phase-2 store kept reservations in process memory,
// bounded at 512 entries with a 120s TTL. Both bounds were survivable; losing
// the whole map on restart was not. A client that retries a request whose
// response it never saw — the exact case Idempotency-Key exists for — would,
// if the restart landed in between, have its retry executed a SECOND time.
// For `write`/`mkdir` that converges (same bytes, same directory). For
// `move`/`delete`/`upload` it does not: a replayed delete can trash a
// replacement, a replayed upload can leave two copies.
//
// THE MODEL. Three states, and the honesty of the third is the whole point:
//
//   done     — the outcome is recorded. Replay it. Survives restart, which is
//              the fix: the common hazard is a lost RESPONSE, not a lost write.
//   pending, this process
//            — work is running right now. Share the promise, exactly as the
//              in-memory store did: two concurrent retries, one mutation.
//   pending, a PREVIOUS process
//            — we reserved it, then died. Whether the filesystem changed is
//              genuinely unknown. We do not guess, and we do not re-run: we
//              ask the filesystem for the one answer it can give soundly
//              ("this provably did NOT happen"), and refuse otherwise.
//
// ORDERING, which is what makes the record trustworthy: the `done` row is
// written by a `.then` registered at reservation time, so it lands BEFORE the
// route's own await resumes and sends the response. A client can never observe
// an outcome the database has not already recorded.
//
// DURABILITY BOUND, stated rather than implied: the row is an ordinary WAL
// commit under the journal's `synchronous=NORMAL`. It survives a process
// restart — the systemd case this was built for, and the one that bit us. It
// is not guaranteed across a host power loss, where the audit line (fsynced)
// can outlive the reservation that produced it. Closing that gap means
// `synchronous=FULL` on this path, which is a database-wide cost paid for a
// strictly rarer failure; noted here so the next reader knows it was weighed.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It never synthesises an outcome it did
// not observe. A recovered row is not handed a reconstructed 200 built from
// the intent — the canonical paths a real execution returns are produced by
// the guard, not by this module, and inventing them would answer a caller with
// a body that no execution ever produced.
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import { FileLinkDenied } from './file-guard.js'
// One TTL, not two: the window a key is replayable for is a property of the
// write API, and a second copy here would drift from the route module's.
import { IDEM_TTL_MS } from './files-write-http.js'

// Identifies THIS server process. A row carrying a different one is a row
// whose executor is gone. Regenerated per process by construction — there is
// no persisted value to go stale.
export const BOOT_ID = crypto.randomUUID()

// Generous compared with the 512-entry in-memory cap it replaces: rows are
// small, the TTL sweep does the real bounding, and the cap exists only so a
// pathological client cannot grow the table without limit.
export const FILE_IDEM_MAX_ROWS = 4096

// How long an ORPHANED reservation (pending, executor gone) is kept. Far
// longer than the replay TTL because the row is evidence, not a cache line:
// while it stands, the key it names can never execute. It is bounded at all
// only so a crash storm cannot fill the table forever — nothing retries a
// week-old request, so the eventual sweep costs nothing real.
export const ORPHAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const stat = async (p) => { try { return await fsp.lstat(p) } catch { return null } }

// Can we prove, from the filesystem alone, that the interrupted operation did
// NOT take effect? Only then is re-running it safe. Every other shape —
// including "it looks like it DID happen" — returns false, because a
// post-state that matches the intent can equally be another actor's work, and
// acting on that guess is how a replayed delete removes a replacement.
//
// Note the asymmetry is deliberate: proving absence of an effect is sound
// (nothing to undo), proving presence is not (we cannot tell our effect from
// someone else's identical one).
export async function provablyNotCommitted(intent) {
  if (!intent || typeof intent !== 'object') return false
  switch (intent.op) {
    // mkdir -p is idempotent in effect — the route itself answers 200 for an
    // existing directory — so re-running it cannot destroy anything.
    case 'mkdir':
      return true
    // The target does not exist, so no earlier attempt landed it. (If it DOES
    // exist we stop: it may be ours, it may be someone else's, and for an
    // overwrite the difference is a file.)
    case 'write':
    case 'upload':
      return (await stat(intent.path)) === null
    // The source is still where it was and the destination is still empty:
    // the rename did not happen.
    case 'move':
      return (await stat(intent.path)) !== null && (await stat(intent.to)) === null
    // Deliberately absent: `delete`. A present target could be the original
    // (not deleted) or a replacement created after ours was trashed, and those
    // two demand opposite actions. The web client sends no Idempotency-Key on
    // DELETE at all and resolves an unknown outcome by making the operator
    // look at the listing — which is the right answer here too.
    default:
      return false
  }
}

// `db` makes it durable; without one this is an in-memory store with the same
// semantics (what the unit tests and any embedding without a database use).
export function makeDurableIdemStore({
  db, ttlMs = IDEM_TTL_MS, max = FILE_IDEM_MAX_ROWS, now = Date.now, log = console,
  // Injectable so a test can be a genuine SECOND process rather than a
  // reconstructed store that shares this one's identity. The server never
  // passes it: there is exactly one boot id per process, by construction.
  bootId = BOOT_ID,
} = {}) {
  // Live promises for work running in THIS process. The database row says a
  // reservation exists; this map is the only thing that can say it is still
  // being executed here, which is what separates "share the flight" from
  // "recover an orphan".
  const inflight = new Map()

  const sweep = () => {
    db.prepare('DELETE FROM file_idem WHERE state=? AND expires_at<=?').run('done', now())
    // Orphans outlive the replay TTL by design (see ORPHAN_RETENTION_MS); this
    // is the far outer bound that keeps a crash storm from wedging the table.
    db.prepare("DELETE FROM file_idem WHERE state='pending' AND created_at<=?").run(now() - ORPHAN_RETENTION_MS)
  }

  // Orphans are not swept at startup: a row that outlived its process is
  // EVIDENCE, and deleting it would turn a retry into a silent re-execution.
  // It is reported once, then left to expire or to be resolved by a retry.
  const orphans = db.prepare("SELECT key, intent FROM file_idem WHERE state='pending' AND boot_id<>?").all(bootId)
  if (orphans.length) {
    log.warn?.(`file writes: ${orphans.length} idempotency reservation(s) outlived their server process; `
      + 'their outcome is unknown and a retry carrying the same key will be refused rather than re-run: '
      + orphans.map((row) => row.intent || row.key).join(', '))
  }

  const settle = (key, outcome) => {
    db.prepare('UPDATE file_idem SET state=?, status=?, body=?, content_hash=?, expires_at=? WHERE key=?')
      .run('done', outcome.status, JSON.stringify(outcome.body ?? null),
        outcome.contentHash ?? null, now() + ttlMs, key)
  }
  // A failed attempt is not a result worth replaying — drop the reservation so
  // the caller can genuinely retry. Unchanged from the in-memory store.
  const forget = (key) => db.prepare('DELETE FROM file_idem WHERE key=?').run(key)

  const decode = (row) => ({
    status: row.status,
    body: row.body === null ? undefined : JSON.parse(row.body),
    ...(row.content_hash === null ? {} : { contentHash: row.content_hash }),
  })

  // Write-ahead, in the same spirit as the audit intent line: the reservation
  // is durable BEFORE the first irreversible filesystem call, so a crash
  // between the two leaves evidence rather than a clean slate.
  const claim = (key, fingerprint, intent) => {
    sweep()
    const total = db.prepare('SELECT COUNT(*) AS n FROM file_idem').get().n
    if (total >= max) throw new FileLinkDenied('idem-store-full')
    db.prepare(`INSERT INTO file_idem(key, fingerprint, boot_id, state, intent, created_at, expires_at)
                VALUES(?,?,?,'pending',?,?,?)`)
      .run(key, fingerprint, bootId, intent ? JSON.stringify(intent) : null, now(), now() + ttlMs)
  }

  const start = (key, factory) => {
    const promise = Promise.resolve().then(factory)
    inflight.set(key, promise)
    promise.then(
      (outcome) => { inflight.delete(key); settle(key, outcome) },
      () => { inflight.delete(key); forget(key) },
    )
    return promise
  }

  // An orphaned reservation, resolved the only sound way: re-run it if and
  // only if the filesystem proves it never took effect. The recovery itself is
  // registered in `inflight` before the first await, so two retries arriving
  // together after a restart cannot both recover the same row.
  const recover = (key, row, factory) => {
    const promise = (async () => {
      const intent = row.intent ? JSON.parse(row.intent) : null
      if (!(await provablyNotCommitted(intent))) {
        log.error?.('file writes: refusing a retry whose original outcome is unknown '
          + `(reservation ${key} outlived its server process): ${row.intent || 'no recorded intent'}`)
        throw new FileLinkDenied('idem-indeterminate')
      }
      // Re-claim under OUR boot id, so a second crash is recorded against this
      // process rather than silently inheriting the old row's evidence.
      db.prepare('UPDATE file_idem SET boot_id=?, created_at=?, expires_at=? WHERE key=?')
        .run(bootId, now(), now() + ttlMs, key)
      return factory()
    })()
    inflight.set(key, promise)
    promise.then(
      (outcome) => { inflight.delete(key); settle(key, outcome) },
      // A refusal must NOT clear the row: the outcome is still unknown, and a
      // cleared row would let the very next retry execute as if nothing had
      // ever been reserved.
      (err) => {
        inflight.delete(key)
        if (!(err instanceof FileLinkDenied && err.reason === 'idem-indeterminate')) forget(key)
      },
    )
    return promise
  }

  return {
    size: () => db.prepare('SELECT COUNT(*) AS n FROM file_idem').get().n,

    // Same contract as the in-memory store it replaces: reserve `key`, or
    // report that it is already reserved. `replay` tells the caller it is
    // looking at someone else's execution — the hook uploads use to verify the
    // bytes really are the same bytes.
    reserve(key, fingerprint, factory, intent) {
      sweep()
      const row = db.prepare('SELECT * FROM file_idem WHERE key=?').get(key)
      if (row) {
        // A reused key carrying a different request is served a conflict, never
        // someone else's result.
        if (row.fingerprint !== fingerprint) throw new FileLinkDenied('idem-key-conflict')
        if (row.state === 'done') return { promise: Promise.resolve(decode(row)), replay: true }
        const live = inflight.get(key)
        if (live) return { promise: live, replay: true }
        // NOT a replay. Recovery either re-runs the work with THIS caller's
        // request (an upload streams its own body into it) or refuses — there
        // is no recorded outcome to hand back. Claiming `replay` here would
        // make settleUpload drain the body for a hash comparison against a
        // result that does not exist, starving the re-execution of its bytes.
        return { promise: recover(key, row, factory), replay: false }
      }
      claim(key, fingerprint, intent)
      return { promise: start(key, factory), replay: false }
    },

    run(key, fingerprint, factory, intent) {
      return this.reserve(key, fingerprint, factory, intent).promise
    },
  }
}
