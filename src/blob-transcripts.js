// Voice notes transcribed at upload. When the journal has a cloud transcriber
// (cloud-transcribe.js), every audio blob a user's app uploads is sent off
// the moment POST /media stores it — and so is every video, for its audio
// track, with the words' timing kept (blobs.transcript_segments, JSON
// [{start_ms, text}]) for the bridge to line up against the video's frames.
// The words land on the blob row (blobs.transcript, blobs.transcript_status),
// and the bridge that later gets the chat message asks
// GET /media/:id/transcript for them instead of fetching the audio and
// running its own whisper. A 30-second note is
// usually done before the app has even sent the message that names it.
// When the cloud call fails (an error, not an answer with no words in it)
// and whisper is configured too, the note falls back to whisper on this
// host, one note at a time across the whole backlog.
//
// Off without a cloud transcriber: a whisper-only journal keeps transcribing
// item voice notes alone (items-transcribe.js), since doing every chat note
// too would put minutes of CPU per note on the journal host.
//
// Status on the row: NULL = never asked (the bridge does it, as before),
// 'pending', 'done', 'failed'. A NULL or 'failed' row can be asked again
// (retry(), from POST /media/:id/transcript); a 'done' one never re-runs.
// 'done' stamps transcribed_at, from which retention.js expires the audio
// (7 days by default), keeping the words; a video's file is never expired
// that way (retention.js takes audio/* only).
// Owner-scoped throughout: a job only ever reads the audio of the user who
// uploaded it.

// Bounded backlog, per user and overall, so a burst of uploads cannot queue
// an unbounded bill. A blob refused here stays NULL: its bridge asks again
// (retry), and transcribes it locally only if it can.
const DEFAULT_MAX_QUEUED = 100
const DEFAULT_MAX_QUEUED_PER_USER = 20
// A row left 'pending' by a process that died: re-run it at boot if it was
// asked for recently (transcript_asked_at, else created_at: a retried old
// note counts from the retry), give up on it otherwise (its bridge has long
// since fallen back; a failed row can be asked again).
const DEFAULT_RECOVER_MAX_AGE_MS = 60 * 60 * 1000

export function isAudioType(contentType) {
  return typeof contentType === 'string' && contentType.toLowerCase().startsWith('audio/')
}

export function isVideoType(contentType) {
  return typeof contentType === 'string' && contentType.toLowerCase().startsWith('video/')
}

// What an upload-time job can take: a voice note, or a video's audio track.
export function isTranscribableType(contentType) {
  return isAudioType(contentType) || isVideoType(contentType)
}

// The column's contract, enforced where it is written: [{start_ms: a
// non-negative integer, text: a non-empty trimmed string}], in the order the
// transcriber gave. Anything else a transcriber returns is coerced or dropped.
export function normalizeSegments(segments) {
  if (!Array.isArray(segments)) return []
  const out = []
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue
    const text = String(seg.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    out.push({ start_ms: Math.max(0, Math.round(Number(seg.start_ms) || 0)), text })
  }
  return out
}

// The `?wait=N` of GET and POST /media/:id/transcript, in seconds: a
// number from 0 to 30, anything else 0.
export const MAX_TRANSCRIPT_WAIT_S = 30
export function transcriptWaitS(value) {
  return Math.min(MAX_TRANSCRIPT_WAIT_S, Math.max(0, Number(value) || 0))
}

// {status: 'none'|'pending'|'failed'} or {status: 'done', transcript,
// segments?} — segments only for a row that has them (a video).
export function readBlobTranscript(db, blobId) {
  const row = db.prepare('SELECT transcript, transcript_status, transcript_segments FROM blobs WHERE id=?').get(blobId)
  if (!row || !row.transcript_status) return { status: 'none' }
  if (row.transcript_status !== 'done') return { status: row.transcript_status }
  const out = { status: 'done', transcript: row.transcript }
  if (row.transcript_segments != null) {
    try { out.segments = JSON.parse(row.transcript_segments) } catch { /* unreadable: the words still stand */ }
  }
  return out
}

// What retry() can answer before any queue is consulted: 'not_found' (no
// such blob of this owner's), 'not_transcribable' (neither audio nor
// video), 'done' / 'pending' (already so: nothing re-runs, no second job),
// or null with the row, which is NULL or 'failed' and may be asked again.
function retryPrecheck(db, blobId, userId) {
  const row = db.prepare('SELECT content_type, transcript_status FROM blobs WHERE id=? AND owner_user_id=?').get(blobId, userId)
  if (!row) return { answer: 'not_found' }
  if (!isTranscribableType(row.content_type)) return { answer: 'not_transcribable' }
  if (row.transcript_status === 'done' || row.transcript_status === 'pending') return { answer: row.transcript_status, row }
  return { answer: null, row }
}

export function makeBlobTranscripts({
  db, transcriber, log = console, now = Date.now,
  maxQueued = DEFAULT_MAX_QUEUED, maxQueuedPerUser = DEFAULT_MAX_QUEUED_PER_USER,
  recoverMaxAgeMs = DEFAULT_RECOVER_MAX_AGE_MS, closeTimeoutMs = 5000,
}) {
  const enabled = transcriber?.kind === 'cloud'
  if (!enabled) {
    return {
      enabled: false,
      start: () => false,
      // Nothing here can transcribe: 'unsupported' = answer the row as it stands.
      retry: (blobId, userId) => retryPrecheck(db, blobId, userId).answer ?? 'unsupported',
      lookup: (blobId) => readBlobTranscript(db, blobId),
      wait: async (blobId) => readBlobTranscript(db, blobId),
      inFlight: () => null,
      recover: () => 0,
      close: () => Promise.resolve(),
    }
  }

  const limit = Math.max(1, transcriber.concurrency ?? 1)
  const abort = new AbortController()
  let closed = false
  let running = 0
  const queue = []
  // blobId -> promise of the settled {status, transcript?}; present from
  // start() until the row is written.
  const jobs = new Map()
  const perUser = new Map()

  // start() takes only a row never asked; retry() a 'failed' one too, and a
  // 'pending' one with no job behind it (defensive: hand-over copies cross
  // a pending row as never asked). Both stamp transcript_asked_at, which recover()
  // judges a leftover by.
  const setPendingFresh = db.prepare("UPDATE blobs SET transcript_status='pending', transcript=NULL, transcript_asked_at=? WHERE id=? AND owner_user_id=? AND transcript_status IS NULL")
  const setPending = db.prepare("UPDATE blobs SET transcript_status='pending', transcript=NULL, transcript_asked_at=? WHERE id=? AND owner_user_id=? AND (transcript_status IS NULL OR transcript_status='failed' OR (transcript_status='pending' AND ?))")
  const setDone = db.prepare("UPDATE blobs SET transcript_status='done', transcript=?, transcript_segments=?, transcribed_at=? WHERE id=? AND transcript_status='pending'")
  const setFailed = db.prepare("UPDATE blobs SET transcript_status='failed', transcript=NULL, transcript_segments=NULL WHERE id=? AND transcript_status='pending'")
  // A video needs the timed variant; a transcriber without one leaves
  // videos to the bridge.
  const canSegments = typeof transcriber.transcribeFileSegments === 'function'

  function pump() {
    while (!closed && running < limit && queue.length) {
      const job = queue.shift()
      running += 1
      runJob(job).finally(() => {
        running -= 1
        const n = (perUser.get(job.userId) || 1) - 1
        if (n > 0) perUser.set(job.userId, n); else perUser.delete(job.userId)
        job.settle(readBlobTranscript(db, job.blobId))
        jobs.delete(job.blobId)
        pump()
      })
    }
  }

  async function runJob({ blobId, userId }) {
    if (closed) return
    let text = null
    let segments = null
    try {
      const blob = db.prepare('SELECT disk_path, content_type FROM blobs WHERE id=? AND owner_user_id=?').get(blobId, userId)
      if (!blob) return // reaped while queued: nothing to write
      const opts = { signal: abort.signal, userId }
      if (isVideoType(blob.content_type) && canSegments) {
        // A video with no audio stream throws here (ffmpeg refuses), and is
        // recorded 'failed' like a silent note.
        const out = await transcriber.transcribeFileSegments(blob.disk_path, opts)
        text = out?.text
        segments = normalizeSegments(out?.segments)
      } else {
        text = await transcriber.transcribeFile(blob.disk_path, opts)
      }
    } catch (err) {
      // Shutting down: leave it pending for the next boot's recover().
      if (closed) return
      log.error(`blob-transcripts: ${blobId} failed: ${err?.message ?? err}`)
    }
    if (closed) return
    try {
      if (text && String(text).trim()) setDone.run(String(text).trim(), segments ? JSON.stringify(segments) : null, now(), blobId)
      else setFailed.run(blobId)
    } catch (err) {
      log.error(`blob-transcripts: write-back for ${blobId} failed`, err)
    }
  }

  function enqueue(blobId, userId) {
    let settle
    const promise = new Promise((r) => { settle = r })
    jobs.set(blobId, promise)
    perUser.set(userId, (perUser.get(userId) || 0) + 1)
    queue.push({ blobId, userId, settle })
    pump()
  }

  function queuedCount() { return queue.length + running }
  const full = (userId) => queuedCount() >= maxQueued || (perUser.get(userId) || 0) >= maxQueuedPerUser

  return {
    enabled: true,
    // Called by POST /media right after the row is stored. True when the
    // blob is now pending; false when it is neither audio nor a video this
    // transcriber can time, the backlog is full, or the journal is closing
    // (the bridge then transcribes it as before).
    start(blobId, userId, contentType) {
      if (closed || !isTranscribableType(contentType)) return false
      if (isVideoType(contentType) && !canSegments) return false
      if (full(userId)) return false
      if (setPendingFresh.run(now(), blobId, userId).changes !== 1) return false
      enqueue(blobId, userId)
      return true
    },
    // POST /media/:id/transcript: ask again for a note that was never
    // transcribed here (the backlog was full at upload) or whose job failed.
    // 'queued' = now pending; 'busy' = the backlog (or a closing journal)
    // refused it and the row is untouched; 'done' / 'pending' = already so,
    // nothing re-run and no second job; 'unsupported' = this journal cannot
    // take it (a video without timed segments), the row as it stands is the
    // answer; 'not_transcribable' = not audio or video; 'not_found' = no
    // such blob of this owner's. Same type checks and caps as start().
    retry(blobId, userId) {
      const { answer, row } = retryPrecheck(db, blobId, userId)
      // A 'pending' row with no job behind it would otherwise wait for the
      // next boot: it is taken like a failed one. Nothing writes such a row
      // today (recover() runs before the first request, and a hand-over
      // copy crosses a pending row as never asked), so this is a guard for
      // the next writer that does.
      const orphan = answer === 'pending' && !jobs.has(blobId)
      if (answer && !orphan) return answer
      if (isVideoType(row.content_type) && !canSegments) return 'unsupported'
      if (closed || full(userId)) return 'busy'
      // Same tick as the precheck, so only a row reaped under us misses.
      if (setPending.run(now(), blobId, userId, orphan ? 1 : 0).changes !== 1) return 'not_found'
      enqueue(blobId, userId)
      return 'queued'
    },
    lookup: (blobId) => readBlobTranscript(db, blobId),
    // The row's state once its job settles, or as it stands after `ms`.
    // `signal` lets a disconnecting HTTP caller stop waiting.
    async wait(blobId, ms, signal) {
      const job = jobs.get(blobId)
      if (!job || ms <= 0) return readBlobTranscript(db, blobId)
      let timer
      let onAbort
      try {
        await Promise.race([
          job,
          new Promise((r) => { timer = setTimeout(r, ms) }),
          new Promise((r) => { onAbort = r; signal?.addEventListener('abort', r, { once: true }) }),
        ])
      } finally {
        clearTimeout(timer)
        if (onAbort) signal?.removeEventListener('abort', onAbort)
      }
      return readBlobTranscript(db, blobId)
    },
    // The running job's promise for this blob, for items-transcribe.js to
    // await instead of paying for the same audio twice.
    inFlight: (blobId) => jobs.get(blobId) ?? null,
    // Called once at boot, before the first request. A row is judged by when
    // it was last asked for, so a retried old note survives a restart; the
    // caps hold as for any new job (over them, or asked too long ago:
    // 'failed', which can be asked again).
    recover() {
      const rows = db.prepare("SELECT id, owner_user_id, COALESCE(transcript_asked_at, created_at) AS asked_at FROM blobs WHERE transcript_status='pending' ORDER BY asked_at").all()
      let requeued = 0
      for (const r of rows) {
        if (now() - r.asked_at > recoverMaxAgeMs || full(r.owner_user_id)) { setFailed.run(r.id); continue }
        enqueue(r.id, r.owner_user_id)
        requeued += 1
      }
      if (rows.length) log.log(`blob-transcripts: ${requeued} pending transcript(s) re-queued, ${rows.length - requeued} failed (asked for too long ago, or over the backlog)`)
      return requeued
    },
    // Abort the in-flight requests and wait (bounded) for the jobs to return,
    // so shutdown never closes the DB under a write-back.
    close() {
      closed = true
      abort.abort()
      // Jobs that never started stay pending for the next boot; settle their
      // waiters now so nothing is left hanging on them.
      for (const job of queue.splice(0)) { job.settle(readBlobTranscript(db, job.blobId)); jobs.delete(job.blobId) }
      let timer
      const giveUp = new Promise((r) => { timer = setTimeout(r, closeTimeoutMs) })
      return Promise.race([Promise.allSettled([...jobs.values()]), giveUp]).finally(() => clearTimeout(timer))
    },
  }
}
