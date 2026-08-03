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
    append({ userId, convoId, ref, offset, chunk, meta, producer }) {
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
          // Producer identity (the agent WS connection streaming this buffer),
          // opaque here — used only for identity comparison by closeForProducer
          // so a producer-disconnect can cascade-close exactly the buffers it
          // opened. undefined when no producer is threaded (e.g. unit tests of
          // the store alone); closeForProducer treats null/undefined as a no-op.
          producer,
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
      // Re-home to the currently-streaming producer: after a producer drop +
      // client-driven resync a NEW connection can resume the same buffer, so
      // the live writer always owns it (and a cascade-close targets the right
      // one). Only when a producer is threaded — never clobber with undefined.
      if (producer !== undefined) e.producer = producer
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

    // Third teardown trigger (alongside explicit `finalize` and the idle
    // sweep): a producer connection dropped, so every buffer it still owns is
    // stranded — no finalize will ever arrive. Retire exactly THAT producer's
    // open buffers and return their views so the caller can emit the terminal
    // `end` frame to viewers (mirrors sweepIdle's teardown, keyed by producer
    // identity instead of by age). Scoped strictly to the given producer:
    // other producers' buffers are untouched. A null/undefined producer, or
    // one with no open buffers, is a clean no-op (returns []). An already-freed
    // buffer (finalize / sweep) is gone from the map, so it can never
    // double-emit here.
    closeForProducer(producer) {
      if (producer == null) return []
      const closed = []
      for (const [key, e] of buffers) {
        if (e.producer !== producer) continue
        buffers.delete(key)
        closed.push(entryView(e))
      }
      return closed
    },

    size() {
      return buffers.size
    },
  }
}
