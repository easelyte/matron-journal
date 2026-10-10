import fs from 'node:fs'
import path from 'node:path'
import { writeBlobSync } from './media.js'
import { insertBlob, getBlob } from './db.js'
import { isAudioAttachment } from './items.js'
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
// `hours`.
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

// Voice-note audio expiry (fourth retention pass): keep the transcript forever, delete the recording 7 days after a
// SUCCESSFUL transcription — long enough to replay or re-transcribe a
// garbled note, short enough that audio is not what fills the quota.
//
// Scope is item-thread voice notes: `audio/*` entries in
// item_comments.attachments whose `transcript` is a non-empty string. The
// clock is `transcribed_at` (stamped by setAttachmentTranscript /
// finishAttachmentTranscript), falling back to the comment's created_at for
// entries written before the stamp existed. Never touched: audio with no
// transcript, a pending or failed job, anything that is not audio (whatever
// keys it carries), and — like every pass here — a blob another user owns.
// Chat voice notes (file events) are covered when the journal transcribed
// them itself at upload (blob-transcripts.js, cloud transcriber): their
// clock is blobs.transcribed_at — see expireChatVoiceNotes below. One the
// origin bridge transcribed into its own turn has no journal transcript,
// so "after it's been transcribed" cannot be decided for it, and it stays.
//
// A blob several of the owner's comments name (the same note attached
// twice) goes only once every one of those entries is due; then all of
// them are rewritten in the same transaction as the blob-row delete. The
// entry keeps every field — `blob_ref` included, since the apps decode it
// as a required string — and gains `expired: true`; the file is unlinked
// after commit (ENOENT = already gone, the expected steady state on a
// re-run). The item's updated_at is NOT bumped: an expiry is housekeeping,
// not news.
export function runExpireVoiceNotes(db, { days = 7, now = Date.now() }) {
  if (!Number.isInteger(days) || days <= 0) {
    console.warn(`retention: voice-note TTL days=${JSON.stringify(days)} is invalid — voice-note expiry skipped`)
    return { expired: 0, bytesFreed: 0 }
  }
  const cutoff = now - days * 86400000
  // LIKE prefilters only; the parsed checks below are the rule.
  const rows = db.prepare(
    `SELECT id, user_id, created_at, attachments FROM item_comments
     WHERE attachments LIKE '%"mime":"audio/%' AND attachments LIKE '%"transcript":"%' ORDER BY created_at`
  ).all()
  const naming = db.prepare(`SELECT id, created_at, attachments FROM item_comments WHERE user_id = ? AND attachments LIKE ?`)
  const update = db.prepare('UPDATE item_comments SET attachments=? WHERE id=?')
  const deleteBlobRow = db.prepare('DELETE FROM blobs WHERE id=?')

  const isDue = (a, commentCreatedAt) =>
    isAudioAttachment(a) && typeof a.blob_ref === 'string' && a.blob_ref && !a.expired &&
    typeof a.transcript === 'string' && a.transcript.trim() !== '' &&
    (Number.isInteger(a.transcribed_at) ? a.transcribed_at : commentCreatedAt) < cutoff
  const isLive = (a) => isAudioAttachment(a) && !a.expired

  let expired = 0
  let bytesFreed = 0
  const settled = new Set()
  for (const row of rows) {
    let atts
    try { atts = JSON.parse(row.attachments) } catch { continue }
    if (!Array.isArray(atts)) continue
    for (const a of atts) {
      if (!isDue(a, row.created_at) || settled.has(a.blob_ref)) continue
      const blobRef = a.blob_ref
      settled.add(blobRef)
      const blob = getBlob(db, blobRef)
      if (blob && blob.owner_user_id !== row.user_id) continue
      // Every comment of this user naming the blob: all due, or none go.
      const holders = []
      let allDue = true
      for (const h of naming.all(row.user_id, `%"blob_ref":"${blobRef}"%`)) {
        let hatts
        try { hatts = JSON.parse(h.attachments) } catch { allDue = false; break }
        if (!Array.isArray(hatts)) { allDue = false; break }
        const mine = hatts.filter((x) => x.blob_ref === blobRef && isLive(x))
        if (mine.some((x) => !isDue(x, h.created_at))) { allDue = false; break }
        if (mine.length) holders.push({ id: h.id, atts: hatts, mine })
      }
      if (!allDue || !holders.length) continue
      db.transaction(() => {
        for (const h of holders) {
          for (const x of h.mine) x.expired = true
          update.run(JSON.stringify(h.atts), h.id)
          expired += h.mine.length
        }
        if (blob) {
          // The same recording sent in a chat too: its file/image events
          // become tombstones carrying the words, as the chat pass writes
          // them, rather than dangling refs to a deleted blob.
          // The words go along, but only the journal's own transcript of
          // the blob is stamped as such (said.js trusts nothing else): an
          // item attachment's transcript may be an agent's PATCH.
          const own = journalWordsOf(blob)
          tombstoneAttachmentEvents(db, blobRef, own ?? holders[0].mine[0].transcript, { byJournal: !!own })
          deleteBlobRow.run(blobRef)
        }
      })()
      if (blob) {
        try {
          fs.unlinkSync(blob.disk_path)
        } catch (err) {
          if (err.code !== 'ENOENT') console.error(`retention: failed to unlink voice-note blob ${blob.id} at ${blob.disk_path}`, err)
        }
        bytesFreed += blob.size
      }
    }
  }
  const chat = expireChatVoiceNotes(db, { cutoff })
  return { expired: expired + chat.expired, bytesFreed: bytesFreed + chat.bytesFreed }
}

// The chat half of runExpireVoiceNotes: an audio blob the journal
// transcribed at upload (transcript_status 'done', transcribed_at before the
// cutoff) that only its owner's file/image events name. Each such event is
// rewritten to the same tombstone the media reaper writes (payload kept,
// blob_ref null, expired:true) plus the transcript, so the words outlive the
// recording on the event too; then the blob row goes and the file is
// unlinked after commit. Never touched: a blob an item comment names (the
// item pass above owns it, by its own clock), one another user's event
// names, one no event names (an orphan is the reaper's), and anything not
// transcribed here.
function expireChatVoiceNotes(db, { cutoff }) {
  const due = db.prepare(
    `SELECT b.id, b.owner_user_id, b.disk_path, b.size, b.transcript FROM blobs b
     WHERE b.transcript_status = 'done' AND b.transcribed_at < ? AND b.content_type LIKE 'audio/%'
       AND EXISTS (SELECT 1 FROM events e WHERE e.blob_ref = b.id)
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.blob_ref = b.id AND (e.user_id != b.owner_user_id OR e.type NOT IN ${ATTACHMENT_TYPES}))
       AND NOT EXISTS (SELECT 1 FROM item_comments ic WHERE ic.attachments LIKE '%"blob_ref":"' || b.id || '"%')
     ORDER BY b.transcribed_at`
  ).all(cutoff)
  const deleteBlobRow = db.prepare('DELETE FROM blobs WHERE id=?')
  let expired = 0
  let bytesFreed = 0
  for (const blob of due) {
    db.transaction(() => {
      expired += tombstoneAttachmentEvents(db, blob.id, blob.transcript, { byJournal: true })
      deleteBlobRow.run(blob.id)
    })()
    try {
      fs.unlinkSync(blob.disk_path)
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`retention: failed to unlink chat voice-note blob ${blob.id} at ${blob.disk_path}`, err)
    }
    bytesFreed += blob.size
  }
  return { expired, bytesFreed }
}

// Rewrites every file/image event naming an expiring voice-note blob to the
// reaper's tombstone (payload kept, blob_ref null, expired:true) plus the
// transcript. Returns how many events it rewrote. Runs inside the caller's
// transaction, before the blob row is deleted. `byJournal` says the words are
// the journal's own transcript of the blob (blobs.transcript): only then is
// the tombstone stamped `transcript_by: 'journal'`, the mark said.js requires
// before it vouches for an expired voice note as the user's words.
function tombstoneAttachmentEvents(db, blobRef, transcript, { byJournal = false } = {}) {
  const refs = db.prepare(`SELECT user_id, seq, payload FROM events WHERE blob_ref = ? AND type IN ${ATTACHMENT_TYPES}`).all(blobRef)
  const updateEvent = db.prepare('UPDATE events SET payload=?, blob_ref=NULL WHERE user_id=? AND seq=?')
  for (const ref of refs) {
    updateEvent.run(JSON.stringify(attachmentTombstone(ref.payload, transcript, byJournal)), ref.user_id, ref.seq)
  }
  return refs.length
}

// The one shape every attachment tombstone takes (voice-note expiry and the
// quota reaper alike): the event's payload kept, blob_ref null,
// expired:true, plus the words when there are any. `transcript_by` is never
// carried over from the payload: it is set here, to 'journal', only when the
// words are the journal's own transcript of the blob.
function attachmentTombstone(rawPayload, transcript, byJournal) {
  let payload
  try { payload = JSON.parse(rawPayload) } catch { payload = null }
  const words = typeof transcript === 'string' && transcript ? transcript : null
  const tombstone = {
    ...(payload && typeof payload === 'object' ? payload : {}),
    blob_ref: null,
    expired: true,
    ...(words ? { transcript: words } : {}),
  }
  delete tombstone.transcript_by
  if (words && byJournal) tombstone.transcript_by = 'journal'
  return tombstone
}

// The journal's own transcript of a blob, or null.
const journalWordsOf = (blob) =>
  blob && blob.transcript_status === 'done' && typeof blob.transcript === 'string' && blob.transcript.trim() ? blob.transcript : null

// Quota-pressure attachment reaper (third retention pass). Does nothing until
// a user's total blob footprint reaches highPct% of the per-user quota, then
// deletes, oldest first, (1) their orphan uploads older than the grace
// period and then (2) their attachment blobs (file/image events only) until
// the footprint is back under lowPct%. Age-based reaping was rejected on
// purpose: the per-chat media browser exists to surface old attachments, so
// media lives forever unless the disk ceiling is actually threatened.
//
// What is never a candidate:
//   - tool_output blobs (offload/live-log lifecycles own those, above) —
//     scoped precisely to tool_output references, NOT "any non-attachment
//     reference": ws.js passes msg.blob_ref through unvalidated on text
//     sends and agent publishes, so a broader exemption would let one stray
//     blob_ref on a text event pin a blob out of the reaper forever;
//   (Item-thread attachments — item_comments.attachments names the blob, no
//   event does — ARE candidates, interleaved with chat attachments by the
//   age of their oldest reference. An
//   entry is tombstoned in place: every field kept, blob_ref included since
//   the apps decode it as a required string, plus expired:true; the item's
//   updated_at is not bumped.)
//   - FRESH orphan blobs — an upload sits orphaned between POST /media and
//     the ws send or item comment that attaches it, so reaping it would
//     corrupt an in-flight attachment. Orphans older than orphanGraceMs (a
//     send that failed after its upload, a retried upload) are garbage no
//     client can reach and go first, with no tombstone to write;
//   - anything, when the un-reapable floor (tool_output blobs + fresh
//     orphans + blobs only non-attachment events name)
//     alone keeps the user at or above the low-water target: reaping can
//     then never reach the target, so the pass must refuse and warn — with
//     the floor broken down so the operator knows what to raise or shorten —
//     rather than grind through every attachment the user owns, including
//     brand-new ones, tick after tick.
//
// Candidates are found through the events.blob_ref COLUMN (idx_events_blob_ref).
// ws.js publishBlobRef sets it for agent attachment publishes and db.js
// openDb backfilled the rows from before it did; without both, every
// agent-posted picture was invisible here and swelled the floor instead.
//
// Each reaped attachment's referencing events are rewritten to a tombstone —
// the original payload with blob_ref nulled and expired:true, so name/size/
// caption survive and clients can render "Expired" instead of a dead
// download. Same per-row transaction + unlink-after-commit stance as
// runExpireLogs (ENOENT is the expected steady state on a re-run after a
// crash between commit and unlink).
//
// NOTE: clients that already synced an event never re-fetch it, so a live
// client learns a blob is gone from the 404 on GET /media, not from the
// tombstone — the tombstone serves fresh syncs and new devices.
const ATTACHMENT_TYPES = "('image','file')"
export const ORPHAN_GRACE_MS = 24 * 3600000
// Blob ids an item comment's attachments array names (items.js
// validateAttachments guarantees blob_ref is a non-empty string there).
const ITEM_REFS_CTE = "item_refs AS (SELECT DISTINCT json_extract(j.value, '$.blob_ref') AS blob_ref FROM item_comments ic, json_each(ic.attachments) j)"

export function runReapMedia(db, { quotaBytes, highPct = 90, lowPct = 70, orphanGraceMs = ORPHAN_GRACE_MS, now = Date.now() }) {
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
  // Item-thread attachments: the blob's oldest comment, via one json_each
  // pass over the owner's comments (item_comments is small: ~10k rows, ms).
  // Entries already tombstoned (expired) name a deleted blob and fall out of
  // the join by themselves.
  const itemCandidates = db.prepare(
    `WITH refs AS (
       SELECT json_extract(j.value, '$.blob_ref') AS blob_ref, MIN(ic.created_at) AS ts
       FROM item_comments ic, json_each(ic.attachments) j
       WHERE ic.user_id = ? AND json_extract(j.value, '$.expired') IS NULL
       GROUP BY 1)
     SELECT b.id AS blobRef, r.ts AS oldestTs, b.size AS size
     FROM blobs b JOIN refs r ON r.blob_ref = b.id
     WHERE b.owner_user_id = ?
       AND NOT EXISTS (SELECT 1 FROM events x WHERE x.blob_ref = b.id AND x.type = 'tool_output')`
  )
  const itemHolders = db.prepare(`SELECT id, attachments FROM item_comments WHERE user_id = ? AND attachments LIKE ?`)
  const updateComment = db.prepare('UPDATE item_comments SET attachments=? WHERE id=?')
  // Orphans past the grace period: no event names the blob in its column
  // and no item comment names it in its attachments. The events probe is
  // the partial idx_events_blob_ref; the item probe materialises the CTE
  // once per over-quota user (item_comments is small: ~10k rows, ms).
  const orphans = db.prepare(
    `WITH ${ITEM_REFS_CTE}
     SELECT b.id AS blobRef, b.size AS size
     FROM blobs b
     WHERE b.owner_user_id = ? AND b.created_at < ?
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.blob_ref = b.id)
       AND NOT EXISTS (SELECT 1 FROM item_refs r WHERE r.blob_ref = b.id)
     ORDER BY b.created_at ASC`
  )
  // Floor breakdown for the refusal warning only (two index probes per blob
  // the user owns; never on the hot path).
  const floorParts = db.prepare(
    `WITH ${ITEM_REFS_CTE}
     SELECT
       COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.blob_ref = b.id AND e.type = 'tool_output') THEN b.size END), 0) AS toolBytes,
       COALESCE(SUM(CASE WHEN b.created_at >= ? AND NOT EXISTS (SELECT 1 FROM events e WHERE e.blob_ref = b.id)
                          AND NOT EXISTS (SELECT 1 FROM item_refs r WHERE r.blob_ref = b.id) THEN b.size END), 0) AS freshBytes
     FROM blobs b WHERE b.owner_user_id = ?`
  )
  const refs = db.prepare(
    `SELECT user_id, seq, payload FROM events WHERE blob_ref = ? AND user_id = ? AND type IN ${ATTACHMENT_TYPES}`
  )
  const updateEvent = db.prepare('UPDATE events SET payload=?, blob_ref=NULL WHERE user_id=? AND seq=?')
  const deleteBlobRow = db.prepare('DELETE FROM blobs WHERE id=?')

  let reaped = 0
  let bytesFreed = 0
  const graceCutoff = now - orphanGraceMs
  for (const user of users) {
    const garbage = orphans.all(user.userId, graceCutoff)
    // One list, oldest reference first, a blob once (a blob both a chat
    // event and an item comment name keeps its older timestamp).
    const byBlob = new Map()
    for (const c of [...candidates.all(user.userId), ...itemCandidates.all(user.userId, user.userId)]) {
      const prev = byBlob.get(c.blobRef)
      if (!prev || c.oldestTs < prev.oldestTs) byBlob.set(c.blobRef, c)
    }
    const cands = [...byBlob.values()].sort((a, b) => a.oldestTs - b.oldestTs)
    const reapable = garbage.reduce((n, c) => n + c.size, 0) + cands.reduce((n, c) => n + c.size, 0)
    if (user.bytes - reapable >= target) {
      const floor = user.bytes - reapable
      const parts = floorParts.get(graceCutoff, user.userId)
      const other = floor - parts.toolBytes - parts.freshBytes
      console.warn(
        `retention: user ${user.userId} holds ${user.bytes} blob bytes but ${floor} are un-reapable ` +
        `(${parts.toolBytes} in tool logs, ` +
        `${parts.freshBytes} in uploads under ${Math.round(orphanGraceMs / 3600000)}h old, ${other} named only by non-attachment events) ` +
        '— media reap skipped; raise the quota or shorten tool-log retention'
      )
      continue
    }
    let used = user.bytes
    for (const orphan of garbage) {
      if (used <= target) break
      const blob = getBlob(db, orphan.blobRef)
      if (!blob) { used -= orphan.size; continue }
      // Re-check under the row delete: an orphan may have been attached
      // between the candidate query and now (the grace period makes this a
      // late attach of a day-old upload, not the normal in-flight window —
      // still, never delete a blob a row now names).
      const attached = db.prepare('SELECT 1 FROM events WHERE blob_ref = ? LIMIT 1').get(blob.id)
      if (attached) continue
      deleteBlobRow.run(blob.id)
      try {
        fs.unlinkSync(blob.disk_path)
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`retention: failed to unlink orphan blob ${blob.id} at ${blob.disk_path}`, err)
      }
      used -= orphan.size
      bytesFreed += orphan.size
      reaped += 1
    }
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
        // A voice note the journal transcribed keeps its words (stamped, so
        // said.js can still vouch for them); everything else is the bare
        // tombstone, with any payload-supplied transcript_by dropped.
        const words = journalWordsOf(blob)
        for (const ref of refs.all(cand.blobRef, user.userId)) {
          let payload
          try { payload = JSON.parse(ref.payload) } catch { payload = null }
          const prior = payload && typeof payload.transcript === 'string' ? payload.transcript : null
          updateEvent.run(JSON.stringify(attachmentTombstone(ref.payload, words ?? prior, !!words)), ref.user_id, ref.seq)
        }
        for (const h of itemHolders.all(user.userId, `%"blob_ref":"${cand.blobRef}"%`)) {
          let atts
          try { atts = JSON.parse(h.attachments) } catch { continue }
          if (!Array.isArray(atts)) continue
          let changed = false
          for (const a of atts) {
            if (a && a.blob_ref === cand.blobRef && !a.expired) { a.expired = true; changed = true }
          }
          if (changed) updateComment.run(JSON.stringify(atts), h.id)
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

// Orphan-blob reaper (fourth retention pass). runReapMedia joins
// through events, so a blob NOTHING references was never a candidate for any
// pass and lived forever: an upload whose ws send never happened, an item
// attachment abandoned mid-compose, the blob half of a crashed offload. Blob
// ids are random (media.js), not content-addressed, so an unreferenced blob
// can never be re-attached by content — only by an id a client or agent
// already holds, which is what the grace window is for: an upload sits
// orphaned between POST /media and the send / item POST that attaches it, so
// only blobs older than `graceMs` are candidates.
//
// "Referenced" is deliberately broad — a false "orphan" deletes user data:
//   - events.blob_ref (attachments, offloaded / live-log tool_output);
//   - any `blob_ref` string anywhere inside an event payload, even with the
//     column NULL: agent publishes that carry blob_ref only in the payload
//     land that way (the live DB holds such file/image rows), and item
//     markers mirror comment attachments under payload.comment.attachments;
//   - item_comments.attachments (item bodies ride on a synthetic body
//     comment, so this covers both).
// References are matched across users on purpose: any reference anywhere
// keeps the blob.
//
// Each reaped blob: re-check the column reference, stage the file aside,
// delete the row in its own transaction (restoring the file if that fails),
// unlink the staged file, and log one evidence line. The
// whole pass is synchronous, so no ws handler can attach a candidate between
// the reference scan and the delete. A disk_path outside `mediaDir` is never
// unlinked and its row is left alone.
//
// Grace default is 7 days (MATRON_ORPHAN_BLOB_GRACE_HOURS, server.js), not
// 24h: the web client's outbox keeps a pending attachment's blob_ref in
// IndexedDB and resends it on reconnect, so an upload whose send failed can
// legitimately be attached days later (a tab closed over a weekend).
export function runReapOrphanBlobs(db, { graceMs, mediaDir, now = Date.now() } = {}) {
  if (!Number.isFinite(graceMs) || graceMs <= 0) {
    console.warn(`retention: orphan-blob graceMs=${JSON.stringify(graceMs)} is invalid — orphan-blob reap skipped`)
    return { reaped: 0, bytesFreed: 0 }
  }
  if (typeof mediaDir !== 'string' || !mediaDir) {
    console.warn('retention: orphan-blob reap has no mediaDir — skipped')
    return { reaped: 0, bytesFreed: 0 }
  }
  recoverStagedOrphans(db, mediaDir)
  const candidates = db.prepare(
    `SELECT b.id, b.size, b.disk_path, b.content_type, b.created_at FROM blobs b
     WHERE b.created_at < ? AND NOT EXISTS (SELECT 1 FROM events e WHERE e.blob_ref = b.id)`
  ).all(now - graceMs)
  if (candidates.length === 0) return { reaped: 0, bytesFreed: 0 }

  const referenced = new Set()
  const collect = (v) => {
    if (Array.isArray(v)) { for (const x of v) collect(x); return }
    if (!v || typeof v !== 'object') return
    for (const [k, x] of Object.entries(v)) {
      if (k === 'blob_ref' && typeof x === 'string') referenced.add(x)
      else collect(x)
    }
  }
  const collectJson = (text) => {
    try { collect(JSON.parse(text)) } catch {
      // Unparseable text can still name a blob: keep whatever string follows
      // a blob_ref key rather than risk deleting a referenced blob.
      for (const m of String(text).matchAll(/"blob_ref"\s*:\s*"([^"]+)"/g)) referenced.add(m[1])
    }
  }
  for (const row of db.prepare(`SELECT payload FROM events WHERE instr(payload, '"blob_ref"') > 0`).iterate()) collectJson(row.payload)
  for (const row of db.prepare(`SELECT attachments FROM item_comments WHERE instr(attachments, '"blob_ref"') > 0`).iterate()) collectJson(row.attachments)

  const root = path.resolve(mediaDir) + path.sep
  const stillOrphan = db.prepare('SELECT NOT EXISTS (SELECT 1 FROM events WHERE blob_ref = ?) AS orphan')
  const deleteBlobRow = db.prepare('DELETE FROM blobs WHERE id=?')
  let reaped = 0
  let bytesFreed = 0
  for (const cand of candidates) {
    if (referenced.has(cand.id)) continue
    if (!path.resolve(cand.disk_path).startsWith(root)) {
      console.warn(`retention: orphan blob ${cand.id} lives outside the media dir (${cand.disk_path}) — left alone`)
      continue
    }
    if (!stillOrphan.get(cand.id).orphan) continue
    // Stage, delete, then unlink. The file is renamed aside (same directory,
    // atomic) before the row delete so a failed delete can put it back — the
    // id then still serves exactly as before and the next pass retries. A
    // non-ENOENT rename failure keeps row and file for retry and counts
    // nothing. A crash (or unlink failure) anywhere after staging leaves a
    // `.reaping` file that recoverStagedOrphans resolves at the top of the
    // next pass, by whether the row survived.
    const staged = `${cand.disk_path}.reaping`
    let hasStaged = true
    try {
      fs.renameSync(cand.disk_path, staged)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`retention: failed to stage orphan blob ${cand.id} at ${cand.disk_path} — kept for retry`, err)
        continue
      }
      // Already gone — or staged by a pass that crashed before its delete.
      hasStaged = fs.existsSync(staged)
    }
    try {
      db.transaction(() => { deleteBlobRow.run(cand.id) })()
    } catch (err) {
      if (hasStaged) {
        try { fs.renameSync(staged, cand.disk_path) } catch (e) {
          console.error(`retention: orphan blob ${cand.id} row delete failed AND restoring ${staged} failed`, e)
        }
      }
      console.error(`retention: failed to delete orphan blob row ${cand.id} — file restored, kept for retry`, err)
      continue
    }
    if (hasStaged) {
      try {
        fs.unlinkSync(staged)
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`retention: orphan blob ${cand.id} row deleted but ${staged} could not be unlinked`, err)
      }
    }
    // Decision evidence: which blob went, how big, how old.
    console.log(`retention: reaped orphan blob ${cand.id} (${cand.content_type}, ${cand.size} bytes, ${Math.round((now - cand.created_at) / 3600000)}h old)`)
    reaped += 1
    bytesFreed += cand.size
  }
  return { reaped, bytesFreed }
}

// Crash recovery for runReapOrphanBlobs' staging step. A `<id>.reaping` file
// in a shard directory is a pass interrupted between stage and unlink:
//   - its blobs row still exists → the delete never committed: put the file
//     back so the id serves again (a still-orphaned blob is simply re-staged
//     by the pass that follows);
//   - no row → the delete committed: finish the unlink.
// One readdir per shard (at most 256 two-hex directories), so it is cheap to
// run at the top of every pass rather than only at boot.
function recoverStagedOrphans(db, mediaDir) {
  let shards
  try { shards = fs.readdirSync(mediaDir, { withFileTypes: true }) } catch (err) {
    if (err.code !== 'ENOENT') console.error(`retention: cannot list media dir ${mediaDir} for staged orphans`, err)
    return
  }
  const rowOf = db.prepare('SELECT disk_path FROM blobs WHERE id=?')
  for (const shard of shards) {
    if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue
    const dir = path.join(mediaDir, shard.name)
    let names
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.reaping')) continue
      const staged = path.join(dir, name)
      const row = rowOf.get(name.slice(0, -'.reaping'.length))
      try {
        if (row) fs.renameSync(staged, row.disk_path)
        else fs.unlinkSync(staged)
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`retention: could not recover staged orphan ${staged}`, err)
      }
    }
  }
}
