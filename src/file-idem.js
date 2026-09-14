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
//              genuinely unknown, and nothing we can observe NOW settles it:
//              a present post-state is not evidence about the past, because
//              any other actor could have produced it in between. So we re-run
//              only what is safe to re-run REGARDLESS of whether it already
//              ran, and refuse everything else with `idem-indeterminate`.
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

// Is it safe to re-run this operation, given we cannot know whether the
// original attempt took effect?
//
// The first cut of this module asked the filesystem instead — "is the target
// still absent?" — and read absence as proof that nothing had been committed.
// That inference is unsound, and adversarial review was right to call it a
// blocker. A post-state observed NOW is not evidence about the past: our
// upload may have committed and then been deleted, our move may have been
// moved back. Re-running on that reading resurrects content someone
// deliberately removed, or moves a replacement belonging to later work. The
// asymmetry the old comment claimed — absence provable, presence not — does
// not hold once a third actor can touch the tree, and the write root is the
// operator's live workspace, where one always can.
//
// Nor is there cheap immutable evidence to put in its place. Recording a
// pre-state fingerprint (dev/ino, mtime) at reservation time makes the guess
// stronger but still not sound: rename preserves the inode, so an inverse move
// is indistinguishable from no move at all. Likelihood is not proof.
//
// So the question is no longer "did it happen?" — which we cannot answer — but
// "does it matter whether it happened?", which only an operation that
// converges on re-execution can answer yes to.
export function safeToReRun(intent) {
  // `mkdir -p` is the only one: the route itself answers 200 for a directory
  // that already exists, and creating one destroys nothing. write, upload,
  // move and delete can each destroy or duplicate, so an unknown outcome is
  // refused (507) and left for the operator, who can see the tree.
  return !!intent && typeof intent === 'object' && intent.op === 'mkdir'
}

// `db` is required — durability is the entire point, and a store that silently
// degraded to a Map when it was missing would reintroduce the bug it exists to
// fix, invisibly.
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
    // Dropping one destroys the evidence that made its key refusable, so it is
    // never done quietly: past this bound we accept that nothing is still
    // retrying a week-old request, and we say exactly what we let go of.
    const cutoff = now() - ORPHAN_RETENTION_MS
    const dropping = db.prepare("SELECT key, intent FROM file_idem WHERE state='pending' AND created_at<=?").all(cutoff)
    if (!dropping.length) return
    log.error?.(`file writes: dropping ${dropping.length} unresolved idempotency reservation(s) past the `
      + `${Math.round(ORPHAN_RETENTION_MS / 86_400_000)}-day retention bound; their outcome was never `
      + 'determined, and a retry carrying the same key will now execute as if nothing had been reserved: '
      + dropping.map((row) => row.intent || row.key).join(', '))
    db.prepare("DELETE FROM file_idem WHERE state='pending' AND created_at<=?").run(cutoff)
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
    try {
      db.prepare('UPDATE file_idem SET state=?, status=?, body=?, content_hash=?, expires_at=? WHERE key=?')
        .run('done', Number(outcome?.status), JSON.stringify(outcome?.body ?? null),
          outcome?.contentHash ?? null, now() + ttlMs, key)
    } catch (err) {
      // Recording the outcome is the one step that must not throw into a
      // dangling .then — an unhandled rejection here would take the process
      // down mid-write. Leave the row PENDING rather than deleting it: the
      // mutation did happen, so the honest state is "outcome unknown", and the
      // next retry is refused instead of silently repeating it.
      log.error?.(`file writes: could not record the outcome of reservation ${key}; `
        + 'it stays pending, so a retry will be refused rather than re-run', err)
    }
  }
  // A failed attempt is not a result worth replaying — drop the reservation so
  // the caller can genuinely retry. Non-throwing for exactly the reason
  // `settle` is: this runs inside a `.then` whose promise nobody awaits, so a
  // SQLITE_BUSY / SQLITE_FULL / I/O error raised here would surface as an
  // unhandled rejection and take the process down mid-write. If the DELETE
  // fails the row stays PENDING, which reads as "outcome unknown" — the
  // conservative direction, since a retry is then refused rather than repeated.
  const forget = (key) => {
    try {
      db.prepare('DELETE FROM file_idem WHERE key=?').run(key)
    } catch (err) {
      log.error?.(`file writes: could not release reservation ${key} after a failed attempt; `
        + 'it stays pending, so a retry will be refused rather than re-run', err)
    }
  }

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
    // Nothing is evicted to make room. `sweep()` has already dropped every
    // EXPIRED settled row, so whatever is left is a live guarantee: a `done`
    // row inside its replay window IS the promise that a retry of that key
    // will not execute twice, and a `pending` row is either work in flight or
    // the evidence of an unknown outcome. The previous cut reclaimed the
    // oldest settled rows under pressure — which hands a retry a clean slate
    // and lets a move or delete run a second time, and since the table is
    // global, one client could force that against another client's keys.
    // Refusing is the safe failure: 503 is raised BEFORE any filesystem call,
    // so the caller can retry the same key once the window drains and nothing
    // has happened in between.
    if (db.prepare('SELECT COUNT(*) AS n FROM file_idem').get().n >= max) {
      throw new FileLinkDenied('idem-store-full')
    }
    db.prepare(`INSERT INTO file_idem(key, fingerprint, boot_id, state, intent, created_at, expires_at)
                VALUES(?,?,?,'pending',?,?,?)`)
      .run(key, fingerprint, bootId, intent ? JSON.stringify(intent) : null, now(), now() + ttlMs)
  }

  const start = (key, factory) => {
    const promise = Promise.resolve().then(factory)
    inflight.set(key, promise)
    // `.catch` terminates the bookkeeping chain. settle/forget are already
    // non-throwing; this is the backstop that stops a surprise in either from
    // becoming an unhandled rejection on a promise nobody awaits.
    promise.then(
      (outcome) => { inflight.delete(key); settle(key, outcome) },
      () => { inflight.delete(key); forget(key) },
    ).catch(() => {})
    return promise
  }

  // An orphaned reservation, resolved the only sound way: re-run it if and
  // only if the filesystem proves it never took effect. The recovery itself is
  // registered in `inflight` before the first await, so two retries arriving
  // together after a restart cannot both recover the same row.
  const recover = (key, row, factory) => {
    const promise = (async () => {
      const intent = row.intent ? JSON.parse(row.intent) : null
      if (!safeToReRun(intent)) {
        log.error?.('file writes: refusing a retry whose original outcome is unknown '
          + `(reservation ${key} outlived its server process): ${row.intent || 'no recorded intent'}`)
        throw new FileLinkDenied('idem-indeterminate')
      }
      // Re-claim under OUR boot id, by compare-and-swap against the boot id we
      // READ — not unconditionally. Two things to be honest about here.
      //
      // What the CAS buys: if two recoveries race on the same row, only one
      // swap can match, so the loser refuses instead of running a second copy.
      // That is the reachable race — two retries of one key arriving together
      // after a restart — and within a single process `inflight` already
      // covers it, so this is the cross-process half.
      //
      // What it does NOT buy, and no ordering of these statements could: proof
      // that the row's owner is dead. `inflight` is process-local, so a live
      // second process sharing this database looks exactly like a crashed one,
      // and once it has taken ownership a third reader would CAS against the
      // new value and win. Closing that needs a lease with a heartbeat — an
      // owner liveness record, not an owner name. It is not built because the
      // only operation this path can re-run is `mkdir` (see safeToReRun), and
      // a duplicated mkdir converges; everything destructive refuses above,
      // before reaching here. If that narrowing is ever widened, the lease has
      // to land in the same change.
      const taken = db.prepare('UPDATE file_idem SET boot_id=?, created_at=?, expires_at=? WHERE key=? AND boot_id=?')
        .run(bootId, now(), now() + ttlMs, key, row.boot_id)
      if (taken.changes !== 1) throw new FileLinkDenied('idem-indeterminate')
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
    ).catch(() => {})
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
