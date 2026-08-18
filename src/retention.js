import fs from 'node:fs'
import { writeBlobSync } from './media.js'
import { insertBlob, getBlob } from './db.js'
import { snippetOf, MESSAGE_TYPES } from './journal.js'

const OFFLOAD_TYPE = 'tool_output'

// Returns true for a payload that already has the offloaded shape
// ({type, snippet, blob_ref}) even though its row's `blob_ref` column is
// somehow still NULL. Rows land in that state only via a hand-edited DB or a
// hypothetical bug elsewhere — the `blob_ref IS NULL` scan predicate alone
// can't tell them apart from a genuinely-inline row, so this is a second,
// cheap, in-process guard against ever offloading an already-offloaded
// payload a second time (which would orphan the first blob and rewrite the
// row's payload to point at a fresh one that duplicates it).
function looksAlreadyOffloaded(payload) {
  return !!(payload && typeof payload === 'object' && typeof payload.blob_ref === 'string')
}

// Offloads `tool_output` event payloads older than `days` (by `ts`) that are
// still stored inline (`blob_ref IS NULL`) to blob files under `mediaDir`,
// replacing the row's payload with `{type, snippet, blob_ref}`. Idempotent:
// a row already offloaded (blob_ref set) is excluded by the scan query, and
// `looksAlreadyOffloaded` catches the pathological case above defensively.
//
// Per-row transactionality: the blob file is written to disk *before* the
// DB transaction that inserts its `blobs` row and updates the event row —
// writing to disk can't be folded into the SQLite transaction, so a crash
// between the two leaves an orphan blob file on disk with no DB row
// referencing it. That's acceptable for v1 (disk is cheap, nothing ever
// reads an orphan back) in exchange for the alternative being worse: an
// event row that references a blob_ref no `blobs` row or file backs.
export function runOffload(db, { days = 30, mediaDir }) {
  const cutoff = Date.now() - days * 86400000
  const rows = db.prepare(
    'SELECT user_id, seq, ts, payload FROM events WHERE type=? AND ts<? AND blob_ref IS NULL'
  ).all(OFFLOAD_TYPE, cutoff)

  let offloaded = 0
  const update = db.prepare('UPDATE events SET payload=?, blob_ref=? WHERE user_id=? AND seq=?')

  for (const row of rows) {
    let payload
    try {
      payload = JSON.parse(row.payload)
    } catch {
      payload = null // malformed JSON already in the row — snippetOf tolerates this
    }
    if (looksAlreadyOffloaded(payload)) continue

    // A live-log payload the TTL pass already tombstoned (`expired`), one in
    // the pre-purge shape (`blob_expired`) that the next TTL pass will
    // tombstone, or any other live-log row (`live_log`) — inline or not —
    // whose lifecycle belongs solely to runExpireLogs: re-blobbing any of
    // these would strand the snippet in a permanent blob and, for the
    // inline case, drop the `live_log` key so runExpireLogs can never select
    // the row again, permanently exempting it from the TTL purge.
    if (payload && (payload.expired || payload.blob_expired || payload.live_log)) continue

    const blob = writeBlobSync(mediaDir, Buffer.from(row.payload, 'utf8'))
    const snippet = snippetOf(OFFLOAD_TYPE, payload)
    const newPayload = JSON.stringify({ type: OFFLOAD_TYPE, snippet, blob_ref: blob.id })

    db.transaction(() => {
      insertBlob(db, {
        id: blob.id, ownerUserId: row.user_id, contentType: 'application/json',
        size: blob.size, sha256: blob.sha256, diskPath: blob.diskPath,
      })
      update.run(newPayload, blob.id, row.user_id, row.seq)
    })()
    offloaded += 1
  }
  return { offloaded }
}

// Purges tool output attached to live-streamed tool_output events older than
// `hours` (spec: docs/superpowers/specs/2026-07-14-tool-output-purge-design.md).
// The full-log blob is deleted AND the payload is rewritten to a tombstone —
// command, exit code, and flags survive forever; the snippet does not. Only
// payloads marked live_log:true are touched; offload-created blobs and legacy
// viewer-era rows never carry that flag. json_extract keeps the 6-hourly scan
// from re-parsing every historical row: already-tombstoned rows (`expired`)
// and non-live-log rows are excluded in SQL (all payloads are server-written
// JSON, so json_valid guards nothing real but keeps a hand-edited row from
// erroring the whole query). Blob-row delete, payload rewrite, and the convo
// preview scrub share one transaction per row; file unlink happens after
// commit — a crash between the two leaves an orphan file (same stance as
// runOffload's write-before-commit, in the opposite direction).
export function runExpireLogs(db, { hours = 24, mediaDir }) {
  const cutoff = Date.now() - hours * 3600000
  const rows = db.prepare(
    "SELECT user_id, seq, convo_id, payload, blob_ref FROM events WHERE type='tool_output' AND ts<? " +
    "AND json_valid(payload) AND json_extract(payload,'$.live_log') AND json_extract(payload,'$.expired') IS NULL"
  ).all(cutoff)

  let expired = 0
  const update = db.prepare('UPDATE events SET payload=?, blob_ref=NULL WHERE user_id=? AND seq=?')
  const deleteBlobRow = db.prepare('DELETE FROM blobs WHERE id=?')
  // `conversations.last_seq` is bumped by EVERY event append (read_marker,
  // session_status, ...), not just the ones that own the preview — only
  // MESSAGE_TYPES events ever write `snippet` (see append() in journal.js).
  // So "is this row the convo's latest event" (last_seq) is the wrong
  // ownership test; "is this row the convo's latest MESSAGE_TYPES event" is
  // the right one. A read_marker/session_status landing after a purged
  // tool_output — routine within the 24h TTL — must not suppress the scrub.
  const latestMessageSeq = db.prepare(
    `SELECT seq FROM events WHERE convo_id=? AND type IN (${MESSAGE_TYPES.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT 1`
  )
  const updateConvoSnippet = db.prepare('UPDATE conversations SET snippet=? WHERE id=?')

  for (const row of rows) {
    let payload
    try { payload = JSON.parse(row.payload) } catch { payload = null }
    if (!payload || payload.live_log !== true) continue // defense in depth; SQL already filters
    const blob = row.blob_ref ? getBlob(db, row.blob_ref) : null
    const tombstone = {
      message_ref: payload.message_ref,
      command: payload.command,
      exit_code: payload.exit_code,
      denied: payload.denied,
      truncated: payload.truncated,
      live_log: true,
      expired: true,
      blob_ref: null,
    }
    db.transaction(() => {
      if (row.blob_ref) deleteBlobRow.run(row.blob_ref)
      update.run(JSON.stringify(tombstone), row.user_id, row.seq)
      // Purged output must not linger in the conversation-list preview: if
      // this event is still the convo's latest MESSAGE_TYPES event, rewrite
      // the preview from the tombstone ($ <command>). A newer message-type
      // event owns the preview otherwise.
      const latest = latestMessageSeq.get(row.convo_id, ...MESSAGE_TYPES)
      if (latest && latest.seq === row.seq) {
        updateConvoSnippet.run(snippetOf('tool_output', tombstone), row.convo_id)
      }
    })()
    if (blob) {
      try {
        fs.unlinkSync(blob.disk_path)
      } catch (err) {
        // ENOENT ("already gone") is the expected steady state — the DB row
        // is the source of truth and is already committed as purged. Any
        // other error (EACCES/EIO/...) means the bytes are still on disk
        // while the DB claims purged, which is worth surfacing loudly.
        if (err.code !== 'ENOENT') console.error(`retention: failed to unlink blob ${blob.id} at ${blob.disk_path}`, err)
      }
    }
    expired += 1
  }
  return { expired }
}

// Quota-pressure attachment reaper (third retention pass). Does nothing until
// a user's total blob footprint reaches highPct% of the per-user quota, then
// deletes their oldest attachment blobs (file/image events only) until the
// footprint is back under lowPct%. Age-based reaping was rejected on purpose:
// the per-chat media browser exists to surface old attachments, so media
// lives forever unless the disk ceiling is actually threatened.
//
// What is never a candidate:
//   - tool_output blobs (offload/live-log lifecycles own those, above) —
//     scoped precisely to tool_output references, NOT "any non-attachment
//     reference": ws.js passes msg.blob_ref through unvalidated on text
//     sends and agent publishes, so a broader exemption would let one stray
//     blob_ref on a text event pin a blob out of the reaper forever;
//   - orphan blobs with no referencing event — an upload sits orphaned
//     between POST /media and the ws send that attaches it, so reaping
//     orphans would corrupt an in-flight attachment (structurally excluded
//     by the events-join);
//   - anything, when the un-reapable floor (tool_output blobs + orphans,
//     which nothing ever deletes) alone keeps the user at or above the
//     low-water target: reaping can then never reach the target, so the
//     pass must refuse and warn rather than grind through every attachment
//     the user owns — including brand-new ones — tick after tick.
//
// Each reaped blob's referencing events are rewritten to a tombstone — the
// original payload with blob_ref nulled and expired:true, so name/size/
// caption survive and clients can render "Expired" instead of a dead
// download. Same per-row transaction + unlink-after-commit stance as
// runExpireLogs (ENOENT is the expected steady state on a re-run after a
// crash between commit and unlink).
//
// NOTE: clients that already synced an event never re-fetch it, so a live
// client learns a blob is gone from the 404 on GET /media, not from the
// tombstone — the tombstone serves fresh syncs and new devices.
const ATTACHMENT_TYPES = "('image','file')"

export function runReapMedia(db, { quotaBytes, highPct = 90, lowPct = 70 }) {
  // This pass deletes user data; a nonsense quota must disable it loudly,
  // never run it. (quotaBytes=0 would make high=target=0: every user with
  // any blob selected, and `used <= target` unreachable.)
  if (!Number.isInteger(quotaBytes) || quotaBytes <= 0) {
    console.warn(`retention: media reap quotaBytes=${JSON.stringify(quotaBytes)} is invalid — media reap skipped`)
    return { reaped: 0, bytesFreed: 0 }
  }
  const high = Math.floor(quotaBytes * highPct / 100)
  const target = Math.floor(quotaBytes * lowPct / 100)
  const users = db.prepare(
    'SELECT owner_user_id AS userId, SUM(size) AS bytes FROM blobs GROUP BY owner_user_id HAVING bytes >= ?'
  ).all(high)

  // Driven from the small side (this user's blobs via idx_blobs_owner, each
  // probing events via idx_events_blob_ref) — the events-first join was a
  // full events scan with a second full scan per row for the guard, run
  // synchronously inside the listen callback. e.user_id = owner keeps a
  // (practically unguessable) cross-user blob_ref from influencing reap
  // order for a blob its owner never attached.
  const candidates = db.prepare(
    `SELECT b.id AS blobRef, MIN(e.ts) AS oldestTs, b.size AS size
     FROM blobs b JOIN events e ON e.blob_ref = b.id AND e.user_id = b.owner_user_id
     WHERE b.owner_user_id = ? AND e.type IN ${ATTACHMENT_TYPES}
       AND NOT EXISTS (SELECT 1 FROM events x WHERE x.blob_ref = b.id AND x.type = 'tool_output')
     GROUP BY b.id
     ORDER BY oldestTs ASC`
  )
  const refs = db.prepare(
    `SELECT user_id, seq, payload FROM events WHERE blob_ref = ? AND user_id = ? AND type IN ${ATTACHMENT_TYPES}`
  )
  const updateEvent = db.prepare('UPDATE events SET payload=?, blob_ref=NULL WHERE user_id=? AND seq=?')
  const deleteBlobRow = db.prepare('DELETE FROM blobs WHERE id=?')

  let reaped = 0
  let bytesFreed = 0
  for (const user of users) {
    const cands = candidates.all(user.userId)
    const reapable = cands.reduce((n, c) => n + c.size, 0)
    if (user.bytes - reapable >= target) {
      console.warn(
        `retention: user ${user.userId} holds ${user.bytes} blob bytes but ${user.bytes - reapable} are un-reapable ` +
        '(tool logs / in-flight uploads) — media reap skipped; raise the quota or shorten tool-log retention'
      )
      continue
    }
    let used = user.bytes
    for (const cand of cands) {
      if (used <= target) break
      const blob = getBlob(db, cand.blobRef)
      if (!blob) {
        // Row vanished since the candidate query — its bytes are already
        // free, so account for them or the loop over-reaps by that amount.
        used -= cand.size
        continue
      }
      db.transaction(() => {
        for (const ref of refs.all(cand.blobRef, user.userId)) {
          let payload
          try { payload = JSON.parse(ref.payload) } catch { payload = null }
          const tombstone = {
            ...(payload && typeof payload === 'object' ? payload : {}),
            blob_ref: null,
            expired: true,
          }
          updateEvent.run(JSON.stringify(tombstone), ref.user_id, ref.seq)
        }
        deleteBlobRow.run(cand.blobRef)
      })()
      try {
        fs.unlinkSync(blob.disk_path)
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`retention: failed to unlink reaped blob ${blob.id} at ${blob.disk_path}`, err)
      }
      used -= cand.size
      bytesFreed += cand.size
      reaped += 1
    }
  }
  return { reaped, bytesFreed }
}
