// In-memory live buffers for tool-output streaming (spec
// docs/superpowers/specs/2026-07-13-tool-output-streaming-design.md §6).
// One capped buffer per (convo, message_ref) while a command runs; chunks
// arrive via the `stream_append` op and NEVER touch the journal. Offsets are
// UTF-8 byte positions — chunks are stored as Buffers so byte math stays
// honest regardless of multi-byte characters; decode happens only in
// content() for sync frames. Nothing here survives a restart on purpose:
// the `stream_resync` control frame recovers the stream from the bridge's
// log file.

export const DEFAULT_MAX_BYTES = 1048576 // 1 MiB per buffer
export const DEFAULT_MAX_BUFFERS = 64
export const DEFAULT_IDLE_MS = 30 * 60 * 1000 // 30 min

const COMMAND_MAX_CHARS = 2000
const TOOL_MAX_CHARS = 40

const keyOf = (convoId, ref) => `${convoId}\x00${ref}`

export function makeToolStreamStore({
  maxBytes = DEFAULT_MAX_BYTES, maxBuffers = DEFAULT_MAX_BUFFERS,
  idleMs = DEFAULT_IDLE_MS, now = Date.now,
} = {}) {
  const buffers = new Map() // key -> entry

  const entryView = (e) => ({
    userId: e.userId, convoId: e.convoId, ref: e.ref, meta: e.meta,
    start: e.start, end: e.end, lastAppendAt: e.lastAppendAt,
  })

  function dropHead(e) {
    while (e.end - e.start > maxBytes) {
      const first = e.chunks[0]
      const excess = e.end - e.start - maxBytes
      if (first.length <= excess) {
        e.chunks.shift()
        e.start += first.length
      } else {
        // The excess cut can land mid-character (a chunk may hold several
        // characters). Walk forward past UTF-8 continuation bytes (10xxxxxx)
        // so the retained content always starts on a character boundary —
        // e.start absorbs the extra bytes dropped (at most 3) to stay honest.
        let cut = excess
        while (cut < first.length && (first[cut] & 0xC0) === 0x80) cut++
        e.chunks[0] = first.subarray(cut)
        e.start += cut
      }
    }
  }

  function evictOldest() {
    let oldest = null
    for (const e of buffers.values()) {
      if (!oldest || e.lastAppendAt < oldest.lastAppendAt) oldest = e
    }
    buffers.delete(keyOf(oldest.convoId, oldest.ref))
    return entryView(oldest)
  }

  return {
    append({ userId, convoId, ref, offset, chunk, meta }) {
      const key = keyOf(convoId, ref)
      let e = buffers.get(key)
      if (!e) {
        if (offset > 0) return { status: 'resync', have: 0 }
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { status: 'need_meta' }
        const evicted = []
        while (buffers.size >= maxBuffers) evicted.push(evictOldest())
        e = {
          userId, convoId, ref,
          meta: {
            tool: String(meta.tool ?? '').slice(0, TOOL_MAX_CHARS),
            command: String(meta.command ?? '').slice(0, COMMAND_MAX_CHARS),
          },
          start: 0, end: 0, chunks: [], lastAppendAt: now(),
        }
        buffers.set(key, e)
        const buf = Buffer.from(chunk, 'utf8')
        e.chunks.push(buf)
        e.end = buf.length
        dropHead(e)
        return { status: 'created', offset: 0, accepted: chunk, evicted }
      }
      if (offset > e.end) return { status: 'resync', have: e.end }
      const buf = Buffer.from(chunk, 'utf8')
      // Trim the already-held prefix (at-least-once retries resend overlap).
      // The cut lands at e.end, which is always a chunk boundary the bridge
      // previously sent — i.e. a character boundary — so decoding stays clean.
      const accepted = buf.subarray(e.end - offset)
      if (accepted.length === 0) return { status: 'duplicate' }
      const acceptedOffset = e.end
      e.chunks.push(accepted)
      e.end += accepted.length
      e.lastAppendAt = now()
      dropHead(e)
      return { status: 'appended', offset: acceptedOffset, accepted: accepted.toString('utf8'), evicted: [] }
    },

    buffersFor(userId, convoId) {
      const out = []
      for (const e of buffers.values()) {
        if (e.convoId !== convoId || e.userId !== userId) continue
        out.push({
          ref: e.ref, meta: e.meta, start: e.start, end: e.end,
          content: Buffer.concat(e.chunks).toString('utf8'),
          headTruncated: e.start > 0,
        })
      }
      return out
    },

    free(convoId, ref) {
      const key = keyOf(convoId, ref)
      const e = buffers.get(key)
      if (!e) return undefined
      buffers.delete(key)
      return entryView(e)
    },

    sweepIdle() {
      const cutoff = now() - idleMs
      const swept = []
      for (const [key, e] of buffers) {
        if (e.lastAppendAt < cutoff) {
          buffers.delete(key)
          swept.push(entryView(e))
        }
      }
      return swept
    },

    size() {
      return buffers.size
    },
  }
}
