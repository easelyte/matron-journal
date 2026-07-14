import fs from 'node:fs'
import { writeBlobSync } from './media.js'
import { insertBlob, getBlob } from './db.js'
import { snippetOf } from './journal.js'

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

    // A live-log payload the TTL pass already tombstoned (`expired`), or one
    // in the pre-purge shape (`blob_expired`) that the next TTL pass will
    // tombstone: re-blobbing either would undo the purge for zero value.
    if (payload && (payload.expired || payload.blob_expired)) continue

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
  const convoLastSeq = db.prepare('SELECT last_seq FROM conversations WHERE id=?')
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
      // this event is still the convo's latest, rewrite the preview from the
      // tombstone ($ <command>). A newer message owns the preview otherwise.
      const convo = convoLastSeq.get(row.convo_id)
      if (convo && convo.last_seq === row.seq) {
        updateConvoSnippet.run(snippetOf('tool_output', tombstone), row.convo_id)
      }
    })()
    if (blob) { try { fs.unlinkSync(blob.disk_path) } catch { /* already gone */ } }
    expired += 1
  }
  return { expired }
}
