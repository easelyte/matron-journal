// The federation outbox (docs/protocol.md "Federation": the outbox), built
// to the delivery rules. Every op this journal sends another journal is
// queued here first and delivered by a worker:
//
//   - The op's id is fixed when it is queued. Every attempt keeps the id and
//     body, takes a fresh ts and is signed again.
//   - FIFO per (peer, subject): an entry is not sent while an earlier one on
//     its subject is queued or dead. Other subjects never wait.
//   - Backoff 30 s, doubling to 1 h, with jitter. 408, 429, 5xx, network
//     errors, and every answer the peer did not sign (a proxy's error page
//     is not the peer's word) are retried. Any other 4xx, signed by the
//     peer, is permanent and the entry goes dead at once. A signed
//     `401 stale` carries the peer's clock: the skew is logged and the op
//     retried at once with a fresh ts; skew that survives three attempts is
//     permanent and the error names the clock.
//   - An entry not acknowledged within 7 days goes dead. Dead entries are
//     never dropped silently: the user gets one notice per peer, and they
//     block later entries on their subject until resent (same ids, so a
//     peer that did apply one answers from its receipt) or discarded. A
//     resend is allowed only while the peer is sure to still hold that
//     receipt: RESEND_WINDOW_MS from when the op was queued, so that its
//     last possible attempt still falls inside the receipt's 30 days.
//   - Before each attempt the sender checks its own records again (an op's
//     `stillAllowed`); an op whose grant or contact has ended here is
//     cancelled rather than sent.
//   - Urgent ops (revocations, contact removal and block) go ahead of
//     everything queued for that peer, and do not wait behind earlier ops
//     on their own subject; they can also cancel what is queued there.
//
//   - Peers are served side by side: each peer with something due gets its
//     own chain of attempts, in order, and up to PEER_CHAINS chains run at
//     once. A peer that answers slowly holds up only its own entries.
//   - fed_peers.failing_since is when deliveries to a peer started failing:
//     set by the first attempt that fails in a retryable way (network error,
//     timeout, an answer the peer did not sign, 5xx, 408, 429) and kept
//     through later failures and expiry; cleared by any answer the peer
//     signed that is not one of those (an acknowledgement, a refusal, a
//     stale clock), since the peer is then plainly reachable. A contact's
//     unreachable_since (src/contacts.js).
//   - Sent and cancelled entries are deleted PRUNE_AFTER_MS after they
//     ended (pruneOutbox), so their bodies (snapshot pages, invite tokens)
//     are not kept for good.
//
// Later stages register their ops with optional hooks:
//   {stillAllowed(db, entry) -> true | false | '<error>',
//    refresh(db, entry) -> body | undefined,
//    onAcked(db, entry, result) -> after() | undefined,
//    onDead(db, entry, {status, error}) -> 'discard' | undefined}
// stillAllowed false cancels the entry quietly; a string ends it dead with
// that error, so its onDead can tell the user. refresh, run after
// stillAllowed, answers the body the op would have if it were queued now.
// One that differs from the queued body replaces it under a new op id (a
// peer that saw the old id would refuse the new body as id_reused), in the
// entry's own place in the queue: what was true when it was queued, a
// comment since withdrawn say, does not cross. onAcked runs in the
// transaction that marks the entry sent, and only if this attempt is what
// marked it: a throw rolls both back and the entry is retried (the peer
// answers the retry from its receipt). The function it may return runs
// after the commit, for side effects that reach users. `entry.meta` is
// the op's local context (enqueue's `meta`), never sent.
// An onDead that answers 'discard' has told its user itself (an invite that
// can no longer be used, say): the entry is ended as cancelled, so it does
// not block its subject, and no undelivered notice is filed for it.

import { canonicalize } from './federation-jcs.js'
import { importPublicKey, isAddress, MAX_ENVELOPE_BYTES, newOpId, signEnvelope } from './federation-envelope.js'
import { createItem } from './items.js'
import { appendAndBroadcast } from './journal.js'
import { itemMarkerPayload, ITEM_EVENT_TYPE } from './items-marker.js'
import { ensurePeopleConvo } from './people-convo.js'
import { peopleConvo } from './sharing-events.js'
import { RECEIPT_TTL_MS } from './federation-inbound.js'
import { journalListed } from './federation-identity.js'

export const OUTBOX_MAX_AGE_MS = 7 * 24 * 3600 * 1000
export const BACKOFF_BASE_MS = 30_000
export const BACKOFF_CAP_MS = 3600_000
export const MAX_SKEW_ATTEMPTS = 3
export const PEER_LIVE_CAP = 10_000
export const PEER_BYTES_CAP = 50 * 1024 * 1024
export const PEER_CHAINS = 8
export const PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000
// An op may be applied at the peer as late as its last attempt, and the
// peer keeps that receipt RECEIPT_TTL_MS from when it applied it. So a
// resend (which may run for another 7 days) is safe only while queued +
// RESEND_WINDOW_MS + 7 days stays inside queued + 30 days.
export const RESEND_WINDOW_MS = RECEIPT_TTL_MS - OUTBOX_MAX_AGE_MS

const JOURNAL = 'journal'
const HOOK_FAILED = Symbol('hook_failed')
const fail = (code) => { throw new Error(code) }
const hostOf = (address) => address.slice(address.indexOf('@') + 1)
// An error is often the peer's own word, from its signed answer: in a
// notice it keeps only what an error code is made of.
const codeText = (e) => String(e ?? '').replace(/[^A-Za-z0-9_:. -]/g, '').slice(0, 80) || 'an error'

// The delay before attempt `attempts + 1`: 30 s × 2^(attempts − 1), capped at
// 1 h, then jittered into [50 %, 100 %] so a journal coming back up is not
// hit by every peer's retries in the same second.
export function backoffMs(attempts, random = Math.random) {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))
  return Math.round(base * (0.5 + random() / 2))
}

// Queues one op. `subject` orders it ('mission:ms_…', 'contact:ct_…'); an op
// with none is its own subject. `urgent` sends it ahead of everything else
// for the peer; with `cancelSubject` it also cancels what is still queued
// or dead on its subject (a revocation that must not wait behind events the
// peer is no longer allowed to see). Returns the op id. Errors:
// 'bad_address', 'not_canonical', 'too_large', 'outbox_full'.
export function enqueue(db, { userId = null, from, to, op, body, subject = null, urgent = false, cancelSubject = false, meta = null, now = Date.now() }) {
  if (!isAddress(from) || !isAddress(to)) fail('bad_address')
  const text = canonicalize(body)
  if (Buffer.byteLength(text) > MAX_ENVELOPE_BYTES - 4096) fail('too_large')
  const id = newOpId(now)
  const peer = hostOf(to)
  return db.transaction(() => {
    const live = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS bytes FROM fed_outbox WHERE peer_host=? AND state IN ('queued','dead')").get(peer)
    if (!urgent && (live.n >= PEER_LIVE_CAP || live.bytes + Buffer.byteLength(text) > PEER_BYTES_CAP)) fail('outbox_full')
    const subj = subject ?? `op:${id}`
    if (cancelSubject) {
      db.prepare("UPDATE fed_outbox SET state='cancelled', ended_at=?, last_error='superseded' WHERE peer_host=? AND subject=? AND state IN ('queued','dead')")
        .run(now, peer, subj)
    }
    db.prepare(`INSERT INTO fed_outbox(id, user_id, peer_host, from_addr, to_addr, subject, op, body, urgent, next_at, expires_at, created_at, meta)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, peer, from, to, subj, op, text, urgent ? 1 : 0, now, now + OUTBOX_MAX_AGE_MS, now, meta == null ? null : JSON.stringify(meta))
    return id
  })()
}

// Cancels what is queued (not dead) on one subject for one peer: the sender's
// own record of a grant or contact ended.
export function cancelSubject(db, { peerHost, subject, now = Date.now(), reason = 'cancelled' }) {
  return db.prepare("UPDATE fed_outbox SET state='cancelled', ended_at=?, last_error=? WHERE peer_host=? AND subject=? AND state='queued'")
    .run(now, reason, peerHost, subject).changes
}

const VIEW = (r) => ({
  id: r.id, peer: r.peer_host, op: r.op, subject: r.subject, state: r.state, attempts: r.attempts,
  last_status: r.last_status, last_error: r.last_error, created_at: r.created_at, ended_at: r.ended_at,
})

export function listOutbox(db, userId, { state = 'dead' } = {}) {
  return db.prepare('SELECT * FROM fed_outbox WHERE user_id=? AND state=? ORDER BY seq').all(userId, state).map(VIEW)
}

// Resend: the user's dead entries for one peer go back in the queue under
// the same ids, with a fresh 7 days.
// Only ops queued within RESEND_WINDOW_MS go back: an older one might be
// applied a second time by a peer that has pruned its receipt, so it stays
// dead (`too_old` counts them) and can only be discarded. Entries waiting
// behind the resent ones on their subjects, never attempted, get a fresh 7
// days too (they were blocked, not undeliverable). → {resent, too_old}
export function resendDead(db, userId, peerHost, now = Date.now()) {
  return db.transaction(() => {
    const subjects = db.prepare(`SELECT DISTINCT subject FROM fed_outbox WHERE user_id=? AND peer_host=? AND state='dead' AND created_at>=?`)
      .all(userId, peerHost, now - RESEND_WINDOW_MS).map((r) => r.subject)
    const resent = db.prepare(`UPDATE fed_outbox SET state='queued', attempts=0, skew_attempts=0, next_at=?, expires_at=?, notified=0,
      last_error=NULL, last_status=NULL, ended_at=NULL WHERE user_id=? AND peer_host=? AND state='dead' AND created_at>=?`)
      .run(now, now + OUTBOX_MAX_AGE_MS, userId, peerHost, now - RESEND_WINDOW_MS).changes
    const tooOld = db.prepare("SELECT COUNT(*) AS n FROM fed_outbox WHERE user_id=? AND peer_host=? AND state='dead'").get(userId, peerHost).n
    // Only the ops queued behind a resent one on its subject, which FIFO
    // kept from ever being attempted: no peer can hold a receipt for them,
    // so a full fresh 7 days is safe.
    const extend = db.prepare(`UPDATE fed_outbox SET expires_at=MAX(expires_at, ?)
      WHERE user_id=? AND peer_host=? AND subject=? AND state='queued' AND attempts=0 AND urgent=0`)
    for (const subject of subjects) extend.run(now + OUTBOX_MAX_AGE_MS, userId, peerHost, subject)
    return { resent, too_old: tooOld }
  })()
}

// Deletes the entries that were sent or cancelled more than PRUNE_AFTER_MS
// ago. Dead entries stay: they are the user's to resend or discard.
// → the number deleted.
export function pruneOutbox(db, now = Date.now()) {
  return db.prepare("DELETE FROM fed_outbox WHERE state IN ('sent','cancelled') AND ended_at < ?").run(now - PRUNE_AFTER_MS).changes
}

export function discardDead(db, userId, peerHost, now = Date.now()) {
  return db.prepare("UPDATE fed_outbox SET state='cancelled', ended_at=?, last_error='discarded' WHERE user_id=? AND peer_host=? AND state='dead'")
    .run(now, userId, peerHost).changes
}

// The worker. `client` is a federation client (src/federation-client.js);
// `ops` the op hooks; `hub` reaches the user's clients with the notice.
// `beforePass`, when given, runs at the start of every pass, to queue what
// other processes asked for in the database (federation-grants.js
// resnapshot). Its errors are logged, never thrown.
// `batch` caps the attempts one peer's chain makes in a pass; `peers` how
// many chains run at once.
export function makeOutbox({ db, hub = null, federation, client, ops = {}, beforePass = null, now = Date.now, random = Math.random, log = console, batch = 50, peers = PEER_CHAINS }) {
  const HEAD = `o.state='queued' AND o.next_at<=?
      AND (o.urgent=1 OR NOT EXISTS (SELECT 1 FROM fed_outbox p WHERE p.peer_host=o.peer_host AND p.subject=o.subject
                        AND p.state IN ('queued','dead') AND p.seq<o.seq))`
  // The peers with something due, the one whose oldest due entry is oldest
  // first; and one peer's due entries, in order.
  const duePeers = db.prepare(`SELECT o.peer_host FROM fed_outbox o WHERE ${HEAD} GROUP BY o.peer_host ORDER BY MIN(o.seq)`)
  const dueFor = db.prepare(`SELECT o.* FROM fed_outbox o WHERE o.peer_host=? AND ${HEAD} ORDER BY o.urgent DESC, o.seq LIMIT ?`)
  const rebody = db.prepare("UPDATE fed_outbox SET id=?, body=? WHERE seq=? AND state='queued'")
  const peerOf = db.prepare('SELECT host, base_url, key_pub, state FROM fed_peers WHERE host=?')
  // Every write after the await is guarded on state='queued': a cancellation
  // that landed while the request was in flight stands.
  const markSent = db.prepare("UPDATE fed_outbox SET state='sent', attempts=attempts+1, last_status=?, last_error=NULL, acked_at=?, ended_at=? WHERE seq=? AND state='queued'")
  const markRetry = db.prepare("UPDATE fed_outbox SET attempts=attempts+1, next_at=?, last_status=?, last_error=? WHERE seq=? AND state='queued'")
  const markSkew = db.prepare("UPDATE fed_outbox SET attempts=attempts+1, skew_attempts=skew_attempts+1, next_at=?, last_status=401, last_error=? WHERE seq=? AND state='queued'")
  const markDead = db.prepare("UPDATE fed_outbox SET state='dead', attempts=attempts+?, last_status=?, last_error=?, ended_at=? WHERE seq=? AND state='queued'")
  const markCancelled = db.prepare("UPDATE fed_outbox SET state='cancelled', last_error=?, ended_at=? WHERE seq=? AND state='queued'")
  const current = db.prepare('SELECT * FROM fed_outbox WHERE seq=?')
  const peerFailing = db.prepare('UPDATE fed_peers SET failing_since=COALESCE(failing_since, ?) WHERE host=?')
  const peerAnswered = db.prepare('UPDATE fed_peers SET failing_since=NULL WHERE host=? AND failing_since IS NOT NULL')
  const keys = new Map()
  const keyFor = (pub) => { if (!keys.has(pub)) keys.set(pub, importPublicKey(pub)); return keys.get(pub) }
  const hook = (entry, name, ...args) => {
    const fn = Object.hasOwn(ops, entry.op) ? ops[entry.op]?.[name] : undefined
    if (!fn) return undefined
    try { return fn(db, entry, ...args) } catch (err) { log.error(`federation: ${entry.op} ${name} hook failed`, err); return HOOK_FAILED }
  }

  function notifyDead(entry) {
    if (entry.user_id == null) return
    const markNotified = db.prepare('UPDATE fed_outbox SET notified=1 WHERE seq=?')
    if (db.prepare("SELECT 1 FROM fed_outbox WHERE user_id=? AND peer_host=? AND state='dead' AND notified=1").get(entry.user_id, entry.peer_host)) {
      markNotified.run(entry.seq)
      return
    }
    try {
      // peopleConvo announces the conversation to connected clients the
      // first time it exists; without a hub (tests) just make sure of it.
      const convoId = hub ? peopleConvo({ db, hub }, entry.user_id) : ensurePeopleConvo(db, entry.user_id).id
      const count = db.prepare("SELECT COUNT(*) AS n FROM fed_outbox WHERE user_id=? AND peer_host=? AND state='dead'").get(entry.user_id, entry.peer_host).n
      const reason = entry.last_error === 'expired'
        ? `could not be reached for 7 days`
        : `refused ${count === 1 ? 'an update' : 'updates'} (${codeText(entry.last_error)})`
      const { item, duplicate } = createItem(db, {
        userId: entry.user_id, kind: 'notice', title: `Couldn't deliver to ${entry.peer_host}`,
        body: `The journal at ${entry.peer_host} ${reason}. ${count} ${count === 1 ? 'update was' : 'updates were'} not delivered, and later updates on the same thing wait behind ${count === 1 ? 'it' : 'them'}. Resend or discard them from the contact in the app.`,
        awaiting: 'user', originConvoId: convoId, originDeviceId: 0, createdBy: 'agent', idemKey: `fed-dead:${entry.peer_host}:${entry.seq}:${entry.ended_at}`,
      })
      if (!duplicate && hub) {
        appendAndBroadcast(db, hub, { userId: entry.user_id, convoId, sender: JOURNAL, type: ITEM_EVENT_TYPE, payload: itemMarkerPayload({ item, action: 'created', by: 'agent' }) })
      }
      // Only once the notice exists: a failure leaves the next dead entry
      // for this peer to try again.
      markNotified.run(entry.seq)
    } catch (err) {
      log.error('federation: undelivered notice failed (the entries stay dead and listed)', err)
    }
  }

  function dead(entry, { status = null, error, at, counted = 1 }) {
    if (!markDead.run(counted, status, error, at, entry.seq).changes) return
    if (hook(entry, 'onDead', { status, error }) === 'discard') {
      db.prepare("UPDATE fed_outbox SET state='cancelled' WHERE seq=? AND state='dead'").run(entry.seq)
      return
    }
    notifyDead({ ...entry, last_error: error, ended_at: at })
  }

  async function attempt(selected) {
    // The pass selected it before earlier attempts awaited; read it again so
    // a cancellation (or a resend) made meanwhile is what counts.
    const row = current.get(selected.seq)
    if (!row || row.state !== 'queued') return
    const entry = { ...row, meta: row.meta ? JSON.parse(row.meta) : null }
    const at = now()
    if (at >= entry.expires_at) return dead(entry, { error: 'expired', at, counted: 0 })
    if (!journalListed(federation, entry.peer_host)) return dead(entry, { error: 'journal_not_allowed', at, counted: 0 })
    const allowed = hook(entry, 'stillAllowed')
    if (allowed === false) { markCancelled.run('no_longer_allowed', at, entry.seq); return }
    if (typeof allowed === 'string') return dead(entry, { error: allowed, at, counted: 0 })
    if (allowed === HOOK_FAILED) { markRetry.run(at + backoffMs(entry.attempts + 1, random), null, 'check_failed', entry.seq); return }
    const fresh = hook(entry, 'refresh')
    if (fresh === HOOK_FAILED) { markRetry.run(at + backoffMs(entry.attempts + 1, random), null, 'check_failed', entry.seq); return }
    if (fresh != null) {
      let text
      try { text = canonicalize(fresh) } catch (err) { return dead(entry, { error: `unsendable: ${err.message}`, at, counted: 0 }) }
      if (text !== entry.body) {
        if (Buffer.byteLength(text) > MAX_ENVELOPE_BYTES - 4096) return dead(entry, { error: 'unsendable: too_large', at, counted: 0 })
        const id = newOpId(at)
        if (!rebody.run(id, text, entry.seq).changes) return
        entry.id = id
        entry.body = text
      }
    }
    const peer = peerOf.get(entry.peer_host)
    if (!peer || peer.state !== 'active') return dead(entry, { error: peer ? `peer_${peer.state}` : 'unknown_journal', at, counted: 0 })
    let envelope
    try {
      envelope = signEnvelope({ from: entry.from_addr, to: entry.to_addr, op: entry.op, id: entry.id, body: JSON.parse(entry.body), ts: at }, federation.key.privateKey)
    } catch (err) {
      return dead(entry, { error: `unsendable: ${err.message}`, at, counted: 0 })
    }
    let r
    try {
      r = await client.postEnvelope(peer.base_url, envelope, keyFor(peer.key_pub))
    } catch (err) {
      if (err.message === 'destination_refused') return dead(entry, { error: `destination_refused: ${err.why}`, at })
      markRetry.run(at + backoffMs(entry.attempts + 1, random), null, `${err.message}${err.why ? `: ${err.why}` : ''}`, entry.seq)
      peerFailing.run(at, entry.peer_host)
      return
    }
    const s = r.status
    const error = r.body?.error ?? null
    if (s >= 200 && s < 300 && r.signed) {
      let after
      try {
        after = db.transaction(() => {
          // Cancelled while the request was in flight: the answer changes
          // nothing here.
          if (!markSent.run(s, at, at, entry.seq).changes) return null
          db.prepare('UPDATE fed_peers SET last_ok_at=?, last_error=NULL, failing_since=NULL WHERE host=?').run(at, entry.peer_host)
          const fn = Object.hasOwn(ops, entry.op) ? ops[entry.op]?.onAcked : undefined
          return fn ? fn(db, entry, r.body?.result ?? {}) : null
        })()
      } catch (err) {
        log.error(`federation: ${entry.op} onAcked hook failed (retried)`, err)
        markRetry.run(at + backoffMs(entry.attempts + 1, random), s, 'ack_failed', entry.seq)
        return
      }
      if (typeof after === 'function') {
        try { after() } catch (err) { log.error(`federation: ${entry.op} after-ack failed (the op stands)`, err) }
      }
      return
    }
    if (s === 401 && error === 'stale' && r.signed) {
      peerAnswered.run(entry.peer_host)
      const skew = Number(r.body.clock) - at
      log.error(`federation: ${entry.peer_host} says our clock is off by ${skew} ms`)
      if (entry.skew_attempts + 1 >= MAX_SKEW_ATTEMPTS) return dead(entry, { status: s, error: `clock_skew: ${skew} ms`, at })
      markSkew.run(at, `stale: ${skew} ms`, entry.seq)
      return
    }
    // Retried: anything the peer did not sign, anything not a 4xx (an
    // unsigned 2xx, a 3xx, a 5xx), and 408 / 429. Only a 4xx in the peer's
    // own signed word is permanent.
    const retryable = !r.signed || s < 400 || s >= 500 || s === 408 || s === 429
    if (retryable) {
      markRetry.run(at + backoffMs(entry.attempts + 1, random), s, error ?? (r.signed ? null : 'unsigned answer'), entry.seq)
      peerFailing.run(at, entry.peer_host)
      return
    }
    peerAnswered.run(entry.peer_host)
    dead(entry, { status: s, error: error ?? `status ${s}`, at })
  }

  // One chain per peer: its due entries, one after another. A chain still
  // running is left to finish; a peer with nothing running gets a new one,
  // up to `peers` at once.
  const chains = new Map()
  function chain(host) {
    const run = (async () => {
      for (const entry of dueFor.all(host, now(), batch)) {
        if (stopped) return
        await attempt(entry)
      }
    })()
    // Removed from the promise's own settlement, never from inside the
    // async body: a chain with nothing due finishes before it is set below.
    const settled = run.catch((err) => log.error(`federation: outbox chain for ${host} failed`, err))
      .finally(() => { if (chains.get(host) === settled) chains.delete(host) })
    chains.set(host, settled)
  }

  let stopped = false
  // A pass: a chain for each peer with something due and none running.
  // Resolves when every chain running now has finished. After stop() no
  // pass starts (a resend arriving during shutdown waits for the next start).
  function tick() {
    if (stopped) return Promise.resolve()
    try { beforePass?.() } catch (err) { log.error('federation: before pass failed', err) }
    for (const { peer_host: host } of duePeers.all(now())) {
      if (chains.size >= peers) break
      if (!chains.has(host)) chain(host)
    }
    return Promise.all([...chains.values()]).then(() => {})
  }

  let timer = null
  return {
    tick,
    // A pass now rather than at the next interval: the user is waiting on
    // the op just queued (an invite's acceptance). Never throws.
    kick() { tick().catch((err) => log.error('federation: outbox pass failed', err)) },
    start(intervalMs = 5000) {
      if (timer) return
      timer = setInterval(() => { tick().catch((err) => log.error('federation: outbox pass failed', err)) }, intervalMs)
      timer.unref()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      await Promise.all([...chains.values()])
    },
  }
}
