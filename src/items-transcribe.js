// Journal-side transcription of item voice notes. A user's comment with an
// audio attachment is stored `transcript_status:'pending'` (items-http.js),
// queued here, run through whisper one at a time, and written back; when the
// last pending attachment on a comment settles, `onSettled` fires so
// items-http.js can emit the quiet `updated` marker that refreshes the apps
// and releases the agent's held turn (see items-marker.js).
//
// One job at a time: whisper saturates the cores it is given, and a journal
// host is sized for a Node process, not for N concurrent model loads.
import { finishAttachmentTranscript, listPendingTranscripts } from './items.js'

// Admission: a job is minutes of CPU that any authenticated client can ask
// for, so the backlog is bounded — per user, so one account cannot starve the
// rest, and overall. A comment refused here is simply stored WITHOUT a
// pending status, which is the "journal has no whisper" shape: the origin
// bridge transcribes it, as it did before this module existed.
const DEFAULT_MAX_QUEUED = 50
const DEFAULT_MAX_QUEUED_PER_USER = 10

export function makeItemTranscription({
  db, transcriber, onSettled, log = console,
  maxQueued = DEFAULT_MAX_QUEUED, maxQueuedPerUser = DEFAULT_MAX_QUEUED_PER_USER, retryDelayMs = 500, closeTimeoutMs = 5000,
}) {
  if (!transcriber) {
    return { enabled: false, admit: () => false, enqueue() {}, recover: () => 0, idle: () => Promise.resolve(), close: () => Promise.resolve() }
  }

  let tail = Promise.resolve()
  let closed = false
  let queued = 0
  const perUser = new Map()
  const abort = new AbortController()

  const stillPending = (commentId, blobRef) => listPendingTranscripts(db).some((j) => j.commentId === commentId && j.blobRef === blobRef)

  // A transient write failure must not strand the attachment `pending` (the
  // bridge is holding a turn on it): one retry, and boot recovery behind that.
  async function writeBack(args) {
    try { return finishAttachmentTranscript(db, args) } catch (err) {
      log.error(`items-transcribe: write-back for ${args.commentId}/${args.blobRef} failed, retrying`, err)
      await new Promise((r) => setTimeout(r, retryDelayMs))
      if (closed) return null
      return finishAttachmentTranscript(db, args)
    }
  }

  async function runOne({ commentId, userId, blobRef }) {
    if (closed) return
    let transcript = null
    try {
      // Still ours to do? A boot re-queue can duplicate a job, and a bridge
      // may have PATCHed its own words in meanwhile (which settles the status
      // and announces itself) — either way a whisper run would be CPU spent
      // on a result nobody keeps.
      if (!stillPending(commentId, blobRef)) return
      // Owner-scoped: an attachment names a blob by id alone, and a comment
      // must never pull words out of another user's audio.
      const blob = db.prepare('SELECT disk_path FROM blobs WHERE id=? AND owner_user_id=?').get(blobRef, userId)
      if (!blob) throw new Error('blob not found for this user')
      transcript = await transcriber.transcribeFile(blob.disk_path, { signal: abort.signal })
    } catch (err) {
      // Shutting down: leave it pending — the next boot's recover() redoes it.
      if (closed) return
      log.error(`items-transcribe: ${commentId}/${blobRef} failed: ${err?.message ?? err}`)
    }
    if (closed) return
    let out
    try {
      out = await writeBack({ commentId, blobRef, transcript })
    } catch (err) {
      log.error(`items-transcribe: write-back for ${commentId}/${blobRef} failed twice — left pending for boot recovery`, err)
      return
    }
    if (!out || !out.changed || !out.settled || !out.item) return
    try { onSettled(out) } catch (err) { log.error('items-transcribe: onSettled failed', err) }
  }

  function enqueue(job) {
    queued += 1
    perUser.set(job.userId, (perUser.get(job.userId) || 0) + 1)
    tail = tail.then(() => runOne(job)).finally(() => {
      queued -= 1
      const n = (perUser.get(job.userId) || 1) - 1
      if (n > 0) perUser.set(job.userId, n); else perUser.delete(job.userId)
    })
    return tail
  }

  return {
    enabled: true,
    // May `count` more jobs be queued for this user? Asked BEFORE the comment
    // is stored, because the answer decides whether it is stored pending.
    admit(userId, count) {
      if (closed || count < 1) return false
      return queued + count <= maxQueued && (perUser.get(userId) || 0) + count <= maxQueuedPerUser
    },
    enqueue,
    // Re-queue what a previous process left pending. Not subject to admit():
    // these were admitted once, and a bridge is holding a turn on each.
    recover() {
      const jobs = listPendingTranscripts(db)
      for (const j of jobs) enqueue(j)
      if (jobs.length) log.log(`items-transcribe: re-queued ${jobs.length} pending transcript(s)`)
      return jobs.length
    },
    idle: () => tail,
    // Kill the running ffmpeg/whisper child and wait for the queue to drain
    // (every remaining job returns at its first `closed` check), so shutdown
    // neither waits out a 2-minute whisper run nor closes the DB under one.
    // Bounded: a transcriber that ignores the signal must not hang shutdown.
    close() {
      closed = true
      abort.abort()
      let timer
      // NOT unref'd: while a stuck job is all that is left, this timer is what
      // keeps the loop alive long enough for shutdown to finish at all.
      const giveUp = new Promise((r) => { timer = setTimeout(r, closeTimeoutMs) })
      return Promise.race([tail.catch(() => {}), giveUp]).finally(() => clearTimeout(timer))
    },
  }
}
