import { WebSocketServer } from 'ws'
import { authToken, authorize } from './auth.js'
import { eventsAfter, append, markRead, upsertConversation, toEventShape } from './journal.js'

const journalFrame = (e) => ({ kind: 'journal', ...toEventShape(e) })

// file/image sends carry a blob_ref pointing at a prior POST /media upload;
// the payload mirrors the agent-publish shape ({blob_ref, name, content_type,
// size}) so renderers treat both directions identically.
const CLIENT_SEND_TYPES = new Set(['text', 'file', 'image'])

// Exactly what an agent may hand-author via `publish`. `session_status` is
// server-generated (only reachable via convo_upsert); `read_marker` and
// `convo_meta` are server-generated too (read_marker via the read_marker op,
// convo_meta via convo_upsert's title-change detection) — none of the three
// may be forged through a bare publish. Unknown/future types arrive via a
// server upgrade to this whitelist, never through a bare agent frame.
const AGENT_PUBLISH_TYPES = new Set([
  'text', 'prompt', 'prompt_reply', 'tool_output', 'diff',
  'permission_request', 'file', 'image', 'edit',
])

// activity op (typing/tool-use indicators, spec §6 ephemeral): the only
// states a bridge may broadcast. Anything else is bad_request.
const ACTIVITY_STATES = new Set(['thinking', 'tool', 'idle'])
const ACTIVITY_DETAIL_MAX_CHARS = 200

// status op (session header data — model, context gauge, rate limits):
// ephemeral like activity, but the last one per convo is cached and replayed
// on viewing so client headers populate on open. The payload is passed
// through opaquely (the bridge owns the shape; see the bridge's
// lib/session-status.js) but size-capped — it's held in server memory, so an
// unbounded status would be an unbounded hold.
const STATUS_MAX_BYTES = 4096
const STATUS_CACHE_MAX = 2048

// Agent RPC (spec 2026-07-15-agent-rpc-design.md): opaque client->agent
// request/response relay, never journaled. Whole-frame byte cap — larger
// payloads belong in POST /media with a blob_ref inside params.
const RPC_MAX_BYTES = 16384
const RPC_ID_MAX_CHARS = 128
const RPC_NAME_MAX_CHARS = 64 // method and error.code
// Cap for a parent_convo_id sent by a bridge — same 128-char id ceiling as
// RPC request ids. Convo ids are conventionally Claude session UUIDs (36
// chars); this is a defensive upper bound, not a format assertion.
const CONVO_ID_MAX_CHARS = 128

// Last status per (user, convo). In-memory only and bounded (oldest-written
// evicted first): a lost entry just means the header stays blank until the
// next turn end repaints it. Exported for direct unit testing.
export function makeStatusCache(max = STATUS_CACHE_MAX) {
  const map = new Map()
  return {
    set(userId, convoId, status) {
      const key = `${userId}:${convoId}`
      if (map.has(key)) map.delete(key)
      map.set(key, status)
      if (map.size > max) map.delete(map.keys().next().value)
    },
    get(userId, convoId) {
      return map.get(`${userId}:${convoId}`)
    },
  }
}

const MAX_WS_PAYLOAD_BYTES = 1048576 // 1 MiB

// Between replay batches, a slow/paused reader must not let the server
// buffer an unbounded amount of backlog in the socket's outgoing queue.
const REPLAY_BACKPRESSURE_BYTES = 4 * 1024 * 1024 // 4 MB

// Efficiency valve (spec §6): a resume gap this large (device offline for
// months, or a fresh install with cursor 0 against a huge journal) isn't
// worth replaying frame-by-frame. Journal rows are never deleted, so this
// is never a data-loss boundary — just a "go get a snapshot instead" nudge.
const DEFAULT_MAX_REPLAY = 50000

const noopPushPipeline = { onAppend() {} }

// Polls ws.bufferedAmount until it drains below thresholdBytes, or the
// socket stops being open (no point waiting on a dead connection — the
// replay loop's next send would be a no-op anyway). Exported standalone so
// the polling logic itself is unit-testable without a real socket.
export async function waitForDrain(ws, thresholdBytes, pollMs = 20) {
  while (ws.readyState === 1 && ws.bufferedAmount > thresholdBytes) {
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

export function attachWs({
  server, db, hub, pingMs = 20000, pushPipeline = noopPushPipeline,
  replayBackpressureBytes = REPLAY_BACKPRESSURE_BYTES, maxReplay = DEFAULT_MAX_REPLAY,
  revocationSweepMs = 60000, toolStreams, rpcMaxBytes = RPC_MAX_BYTES,
}) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_WS_PAYLOAD_BYTES })
  const statusCache = makeStatusCache()
  // Prepared once, reused for the per-frame revocation recheck below — one
  // cheap SELECT per inbound frame, not a fresh db.prepare() call each time.
  const deviceExistsStmt = db.prepare('SELECT 1 FROM devices WHERE id=?')
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws._alive === false) { ws.terminate(); continue }
      ws._alive = false
      ws.ping()
    }
  }, pingMs)
  // Revocation sweep — the backstop for SILENT listeners. The per-frame
  // recheck (below) only fires on a connection's own next inbound frame, so
  // a revoked device that just listens would otherwise keep receiving live
  // journal broadcasts forever. Every registered connection's device id is
  // compared against the devices table in one query; gone → same error
  // frame + 4001 close as the per-frame path. Enforcement is therefore
  // next-frame or ≤ one sweep interval (60s default), whichever comes
  // first. unref'd — never keeps the process alive on its own.
  const sweep = setInterval(() => {
    // Tool-stream idle sweep piggybacks on this timer: a bridge that died
    // mid-command never finalizes, so its buffer must expire and any viewer
    // must learn the stream is dead. Runs before the early-return below —
    // buffers expire even when no connection is registered.
    for (const ev of toolStreams.sweepIdle()) notifyStale(hub, ev)
    const conns = hub.allConns()
    if (conns.length === 0) return
    const ids = [...new Set(conns.map((c) => c.deviceId))]
    const existing = new Set(
      db.prepare(`SELECT id FROM devices WHERE id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids).map((r) => r.id)
    )
    for (const c of conns) {
      if (existing.has(c.deviceId)) continue
      if (c.ws.readyState !== 1) continue // already closing; its 'close' handler unregisters it
      c.ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'revoked' }))
      c.ws.close(4001)
    }
  }, revocationSweepMs)
  sweep.unref()
  wss.on('close', () => { clearInterval(interval); clearInterval(sweep) })

  wss.on('connection', (ws) => {
    ws._alive = true
    ws.on('pong', () => { ws._alive = true })
    // Without a listener, a protocol-level error (e.g. a frame over
    // maxPayload, a bad opcode, invalid UTF-8) makes 'ws' emit 'error' on
    // this socket; an unhandled 'error' event is a Node EventEmitter throw,
    // which would otherwise crash the process. Fails-closed: terminate just
    // this connection instead (the WS library has typically already started
    // tearing the socket down by the time this fires).
    ws.on('error', () => { ws.terminate() })
    let conn = null

    ws.on('message', async (data) => {
      let msg = null
      try { msg = JSON.parse(data) } catch { /* handled below */ }
      if (!msg || typeof msg !== 'object') {
        // Malformed or non-object frame (e.g. literal `null`, a bare number, or invalid
        // JSON). Pre-auth this is fatal — close the unauthenticated socket rather than
        // leaving it open forever. Post-auth we just ignore it and keep the connection.
        if (!conn) ws.close()
        return
      }
      try {
        if (!conn) {
          if (msg.op !== 'hello') { ws.close(); return }
          const who = msg.token && authToken(db, msg.token)
          if (!who) {
            ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'auth' }))
            ws.close()
            return
          }
          // Same shape as ack's own cursor validation below (`!Number.isInteger(msg.cursor)
          // || msg.cursor < 0`) — a negative cursor is exactly as invalid here as a
          // non-integer one; without this, a negative `msg.cursor` sails through as a
          // "valid" replay start point (headSeq - negativeCursor is even LARGER than the
          // real gap, so it'd either wrongly trip snapshot_required or, for a small
          // negative value, attempt an eventsAfter() scan with a bogus lower bound).
          if (msg.cursor !== undefined && msg.cursor !== null && (!Number.isInteger(msg.cursor) || msg.cursor < 0)) {
            ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'bad_request', ref: 'hello' }))
            ws.close()
            return
          }
          // conn is assigned here, before replay/registration complete below. If another
          // message arrives while the replay loop is yielded (see setImmediate below),
          // it will be dispatched to handleOp before hub.register(conn) runs. That's safe
          // for every op handled today: any journal append it triggers gets a seq greater
          // than the in-flight cursor, so it's picked up by a later replay batch rather
          // than lost. Revisit this assumption if a future op has other side effects.
          conn = { ws, ...who, viewingConvoId: null }
          conn.username = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId).name
          const head = db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(who.userId)
          const headSeq = head ? head.seq : 0
          ws.send(JSON.stringify({ kind: 'control', op: 'hello_ok', seq: headSeq }))
          if (msg.cursor != null) {
            // snapshot_required valve (spec §6): a gap this large is not worth
            // replaying — tell the client to wipe, GET /snapshot, and reconnect
            // with the fresh cursor instead. Close 4009 right after; the socket
            // is never registered (no live traffic for this abandoned attempt).
            if (headSeq - msg.cursor > maxReplay) {
              ws.send(JSON.stringify({ kind: 'control', op: 'snapshot_required' }))
              ws.close(4009)
              return
            }
            let cursor = msg.cursor
            // Agent connections replay only their own conversations' frames —
            // the same ownership scoping hub.broadcastJournal applies to live
            // traffic (NULL owner = legacy broadcast). Cached per convo for
            // the duration of this replay; ownership changing mid-replay is
            // indistinguishable from it changing right after and is harmless.
            const ownerCache = who.kind === 'agent' ? new Map() : null
            const replaysTo = (convoId) => {
              let owner = ownerCache.get(convoId)
              if (owner === undefined) {
                owner = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(convoId)?.agent_device_id ?? null
                ownerCache.set(convoId, owner)
              }
              return owner == null || owner === who.deviceId
            }
            for (;;) {
              const batch = eventsAfter(db, who.userId, cursor, 500)
              for (const e of batch) {
                if (ownerCache && !replaysTo(e.convo_id)) continue
                ws.send(JSON.stringify(journalFrame(e)))
              }
              if (batch.length < 500) break
              cursor = batch[batch.length - 1].seq
              // A slow/paused reader must not let the server buffer an unbounded amount
              // of replay data in the socket's outgoing queue — wait for it to drain
              // below the threshold before fetching/sending the next batch.
              //
              // VERIFIED: a reader that never drains at all (not just slow — fully
              // stalled, e.g. the client process stopped reading the socket) is still
              // bounded, by the ping/pong heartbeat above. `wss.clients` is populated by
              // the `ws` library at handshake time (websocket-server.js), before our
              // 'connection' handler even runs — so this socket is already a member of
              // the heartbeat sweep despite not yet being `hub.register()`ed. If no pong
              // arrives within two ping intervals (worst case ~2×pingMs), the sweep calls
              // `ws.terminate()`, which sets `readyState = CLOSING` *synchronously*
              // (websocket.js) regardless of whatever is stuck in the OS socket buffer —
              // so `waitForDrain`'s `ws.readyState === 1` check fails on its very next
              // poll, this loop's `conn.closed` check (a few lines down) returns shortly
              // after, and the replay never has to be resumed. No separate bounded-stall
              // timer or test needed here — it would just be re-testing the heartbeat.
              await waitForDrain(ws, replayBackpressureBytes)
              // Yield between batches only — a large backlog must not block the event
              // loop (and starve other connections' pings) while replaying.
              await new Promise((r) => setImmediate(r))
              // The socket may have closed while we were awaiting above; its 'close'
              // handler already ran (unregister was a pre-registration no-op), so
              // finishing the replay and registering would insert a permanently-dead
              // conn into the hub that nothing ever prunes. Bail out instead.
              if (conn.closed) return
            }
          }
          // INVARIANT (live-event gap): no yield between the final eventsAfter call (the
          // batch that broke the loop above, batch.length < 500) and hub.register(conn).
          // That synchronous tail is what guarantees no live event can slip through the
          // gap between the end of replay and live registration.
          // INVARIANT (no dead registrations): a closed socket must never remain
          // registered — 'close' can fire during the replay awaits, before registration,
          // making its hub.unregister a no-op; the conn.closed re-check here (and inside
          // the loop above) closes that window. Both checks are synchronous with
          // register, so 'close' cannot interleave between check and register.
          if (conn.closed) return
          hub.register(conn)
          conn.registered = true
          return
        }
        // Spec §8 close-on-next-frame: revocation is just deleting the
        // devices row (matron-admin device revoke); this is the socket-side
        // half — every frame AFTER hello re-checks that row still exists
        // (hello itself already does the equivalent check via authToken's
        // token-hash lookup, so this must only run post-hello or a revoked
        // token's hello would get checked twice for no benefit).
        if (!deviceExistsStmt.get(conn.deviceId)) {
          conn.ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'revoked' }))
          conn.ws.close(4001)
          return
        }
        // frameBytes = the inbound frame's size as received on the wire —
        // the RPC ops cap THAT (spec: whole inbound frame <= 16 KiB), not a
        // reserialization, which JSON.parse's whitespace-stripping would
        // shrink. `data` is a Buffer here (ws delivers text frames as
        // Buffers), so .length is the byte count.
        handleOp({ db, hub, conn, msg, pushPipeline, toolStreams, statusCache, rpcMaxBytes, frameBytes: data.length })
      } catch (err) {
        // Process-crash backstop: handleOp already has its own try/catch for authz
        // errors, so anything reaching here is unexpected. Never let it take the
        // process down. Exceptions before registration (e.g. during replay) close the
        // socket (clients resume from their cursor by design); after registration they
        // send an error-frame and keep the connection.
        if (!conn || !conn.registered) {
          ws.close()
        } else {
          ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'internal', ref: msg && msg.op }))
        }
      }
    })

    ws.on('close', () => {
      if (!conn) return
      // Mark first, then unregister: if this fires mid-replay (before
      // registration), unregister is a no-op and the flag is what stops the
      // replay path from registering a dead conn afterwards.
      conn.closed = true
      hub.unregister(conn)
    })
  })
  return wss
}

// A buffer freed WITHOUT a durable completion event (idle sweep, count-cap
// eviction) — tell anyone watching so the client doesn't render a live
// terminal forever. Normal completion needs no ephemeral: the finalized
// tool_output journal frame retires the overlay by message_ref.
export function notifyStale(hub, entry) {
  hub.sendEphemeral(entry.userId, entry.convoId, {
    kind: 'ephemeral', convo_id: entry.convoId, message_ref: entry.ref,
    tool_stream: { event: 'end', reason: 'stale' },
  })
}

// Extended by Tasks 7-8 with client and agent operations.
export function handleOp({ db, hub, conn, msg, pushPipeline = noopPushPipeline, toolStreams, statusCache = makeStatusCache(), rpcMaxBytes = RPC_MAX_BYTES, frameBytes = 0 }) {
  const fail = (code, detail) =>
    conn.ws.send(JSON.stringify({ kind: 'control', op: 'error', code, ref: msg.op, ...(detail ? { detail } : {}) }))
  // Single choke point: every journal event becomes a WS frame AND (fire and
  // forget) a candidate push, right here — nowhere else calls
  // hub.broadcastJournal for a freshly-appended event. The push pipeline runs
  // strictly after the append+broadcast have succeeded, so a failure inside
  // it is a server-side delivery concern only — swallow and log rather than
  // letting it bubble up and surface as a spurious {op:'error'} frame for an
  // op that, from the client's perspective, already succeeded.
  const fanOut = (frame) => {
    // Delivery scoping (see hub.broadcastJournal): agent connections only
    // receive frames for conversations they own. Looked up per frame — the
    // convo row is already hot from append()'s own authorization read.
    const owner = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(frame.convo_id)
    hub.broadcastJournal(conn.userId, frame, owner ? owner.agent_device_id : null)
    try {
      pushPipeline.onAppend(conn.userId, frame, conn.deviceId)
    } catch (err) {
      console.error('push pipeline onAppend failed (append/broadcast already succeeded)', err)
    }
  }
  const appendAndFan = (args) => {
    const r = append(db, args)
    if (!r.duplicate) {
      fanOut(journalFrame({
        seq: r.seq, convo_id: args.convoId, ts: r.ts,
        sender: args.sender, type: args.type, payload: args.payload,
      }))
    }
    return r
  }
  try {
    switch (msg.op) {
      case 'viewing': {
        conn.viewingConvoId = msg.convo_id ?? null
        // Catch-up for live tool-output streams: whoever just started viewing
        // gets full scrollback-so-far, one sync frame per active buffer, sent
        // directly (not via hub coalescing) and synchronously — no append can
        // interleave before these because handleOp runs in one event-loop
        // turn. Scoped to the conn's own user; buffersFor enforces it too.
        if (conn.viewingConvoId && conn.kind === 'client') {
          for (const b of toolStreams.buffersFor(conn.userId, conn.viewingConvoId)) {
            conn.ws.send(JSON.stringify({
              kind: 'ephemeral', convo_id: conn.viewingConvoId, message_ref: b.ref,
              tool_stream: {
                event: 'sync', meta: b.meta, offset: b.start,
                content: b.content, head_truncated: b.headTruncated,
              },
            }))
          }
          // Header catch-up: replay the last cached status (same direct-send
          // reasoning as the tool-stream syncs above) so the header populates
          // on open instead of waiting for the next turn end.
          const cachedStatus = statusCache.get(conn.userId, conn.viewingConvoId)
          if (cachedStatus) {
            conn.ws.send(JSON.stringify({
              kind: 'ephemeral', convo_id: conn.viewingConvoId, status: cachedStatus,
            }))
          }
        }
        break
      }
      case 'ack':
        if (!Number.isInteger(msg.cursor) || msg.cursor < 0) return fail('bad_request')
        db.prepare('UPDATE devices SET cursor=? WHERE id=?').run(msg.cursor, conn.deviceId)
        break
      case 'send': {
        if (conn.kind !== 'client') return fail('forbidden')
        const type = msg.type || 'text'
        if (!CLIENT_SEND_TYPES.has(type)) return fail('forbidden')
        if (typeof msg.payload !== 'object' || msg.payload === null) return fail('bad_request')
        // Media sends are useless without a blob to fetch — reject early
        // instead of appending a row no consumer can resolve.
        if (type !== 'text' && (typeof msg.blob_ref !== 'string' || msg.blob_ref.length === 0)) {
          return fail('bad_request', 'media send requires blob_ref')
        }
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `user:${conn.username}`, type,
          payload: msg.payload,
          blobRef: msg.blob_ref ?? null,
          idemKey: msg.local_id ? `client:${conn.deviceId}:${msg.local_id}` : null,
        })
        break
      }
      case 'prompt_reply': {
        if (conn.kind !== 'client') return fail('forbidden')
        if (!Number.isInteger(msg.target_seq)) return fail('bad_request')
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `user:${conn.username}`, type: 'prompt_reply',
          payload: { target_seq: msg.target_seq, choice: msg.choice ?? null, text: msg.text ?? null },
        })
        break
      }
      case 'agent_request': {
        if (conn.kind !== 'client') return fail('forbidden')
        const rid = msg.request_id
        // request_id is echoed on every correlated frame, so it validates
        // first — errors after this point can carry it.
        if (typeof rid !== 'string' || rid.length === 0 || rid.length > RPC_ID_MAX_CHARS) return fail('bad_request', 'bad request_id')
        const failRpc = (code, detail) => conn.ws.send(JSON.stringify(
          { kind: 'control', op: 'error', code, ref: msg.op, request_id: rid, ...(detail ? { detail } : {}) }))
        // Ops are dispatched during this connection's own hello replay,
        // BEFORE hub.register (see the hello handler's comment: "revisit
        // this assumption if a future op has other side effects" — this is
        // that op). A request accepted mid-replay would forward fine, but
        // the response's hub scan couldn't see this unregistered socket and
        // the reply would silently vanish — inviting a timeout-retry of a
        // non-idempotent `start`. Reject instead: nothing forwarded, so a
        // verbatim re-send after replay is always safe.
        if (!conn.registered) return failRpc('not_ready')
        if (typeof msg.method !== 'string' || msg.method.length === 0 || msg.method.length > RPC_NAME_MAX_CHARS) return failRpc('bad_request', 'bad method')
        if (!Number.isInteger(msg.agent_device_id)) return failRpc('bad_request', 'bad agent_device_id')
        // Wire-byte cap (spec: whole inbound frame <= 16 KiB as received) —
        // measured on the raw payload, not a reserialization that
        // JSON.parse's whitespace-stripping would shrink.
        if (frameBytes > rpcMaxBytes) return failRpc('bad_request', 'frame too large')
        // Serializability guard (status-op precedent): a deeply nested
        // params/result would overflow JSON.stringify's call stack at
        // delivery — surface it as a correlated bad_request here instead of
        // an uncorrelated internal error there.
        try { JSON.stringify(msg) } catch { return failRpc('bad_request', 'unserializable frame') }
        // Unknown id, another user's device, and a client-kind device are
        // indistinguishable — anti-enumeration, same stance as the HTTP 404s.
        const target = db.prepare('SELECT user_id, kind FROM devices WHERE id=?').get(msg.agent_device_id)
        if (!target || target.user_id !== conn.userId || target.kind !== 'agent') return failRpc('not_found')
        // Single-consumer delivery (see hub.sendRpcRequest): false means no
        // live socket — no queueing, the client hears it immediately.
        const delivered = hub.sendRpcRequest(conn.userId, msg.agent_device_id, {
          kind: 'rpc',
          request: { request_id: rid, from_device_id: conn.deviceId, method: msg.method, params: msg.params ?? null },
        })
        if (!delivered) return failRpc('agent_unreachable')
        break
      }
      case 'agent_response': {
        if (conn.kind !== 'agent') return fail('forbidden')
        const rid = msg.request_id
        if (typeof rid !== 'string' || rid.length === 0 || rid.length > RPC_ID_MAX_CHARS) return fail('bad_request', 'bad request_id')
        const failRpc = (code, detail) => conn.ws.send(JSON.stringify(
          { kind: 'control', op: 'error', code, ref: msg.op, request_id: rid, ...(detail ? { detail } : {}) }))
        if (typeof msg.ok !== 'boolean') return failRpc('bad_request', 'bad ok')
        if (!Number.isInteger(msg.to_device_id)) return failRpc('bad_request', 'bad to_device_id')
        // The only payload shape rule the server enforces: a failure must
        // carry a machine-usable code. Everything else is bridge-owned.
        if (!msg.ok && (typeof msg.error !== 'object' || msg.error === null
            || typeof msg.error.code !== 'string' || msg.error.code.length === 0
            || msg.error.code.length > RPC_NAME_MAX_CHARS)) {
          return failRpc('bad_request', 'error.code required when ok is false')
        }
        // Wire-byte cap (spec: whole inbound frame <= 16 KiB as received) —
        // measured on the raw payload, not a reserialization that
        // JSON.parse's whitespace-stripping would shrink.
        if (frameBytes > rpcMaxBytes) return failRpc('bad_request', 'frame too large')
        // Serializability guard (status-op precedent): a deeply nested
        // params/result would overflow JSON.stringify's call stack at
        // delivery — surface it as a correlated bad_request here instead of
        // an uncorrelated internal error there.
        try { JSON.stringify(msg) } catch { return failRpc('bad_request', 'unserializable frame') }
        const target = db.prepare('SELECT user_id, kind FROM devices WHERE id=?').get(msg.to_device_id)
        if (!target || target.user_id !== conn.userId || target.kind !== 'client') return failRpc('not_found')
        // Multicast (see hub.sendRpcResponse); a fully disconnected client
        // just misses it — stateless relay, the app re-asks.
        hub.sendRpcResponse(conn.userId, msg.to_device_id, {
          kind: 'rpc',
          response: {
            request_id: rid, agent_device_id: conn.deviceId, ok: msg.ok,
            ...(msg.ok
              ? { result: msg.result ?? null }
              : { error: { code: msg.error.code, ...(typeof msg.error.detail === 'string' ? { detail: msg.error.detail } : {}) } }),
          },
        })
        break
      }
      case 'read_marker': {
        // null means "resolve server-side to the conversation head" (see
        // markRead); anything else must be a genuine non-negative seq.
        if (msg.up_to_seq != null && (!Number.isInteger(msg.up_to_seq) || msg.up_to_seq < 0)) {
          return fail('bad_request')
        }
        // Both kinds may advance the read marker: a client marking read for
        // itself, or an agent (bridge) marking read on behalf of its user —
        // e.g. after mirroring the user's own message into the journal, so
        // that mirrored round-trip doesn't inflate the unread badge. Sender
        // follows each connection's normal identity convention.
        const sender = conn.kind === 'agent' ? `agent:${conn.name}` : `user:${conn.username}`
        const r = markRead(db, conn.userId, msg.convo_id, msg.up_to_seq, sender)
        fanOut(journalFrame({
          seq: r.seq, convo_id: msg.convo_id, ts: r.ts,
          sender, type: 'read_marker',
          payload: { convo_id: msg.convo_id, up_to_seq: r.upToSeq },
        }))
        break
      }
      case 'convo_upsert': {
        if (conn.kind !== 'agent') return fail('forbidden')
        // parent_convo_id is optional; when present it must be a non-empty
        // string within the id length cap (a parent row need not exist yet —
        // ordering between a child's upsert and its parent's is not guaranteed,
        // so a dangling reference is stored as-is). Only agent connections
        // reach here, but validate defensively like every other agent input.
        if (msg.parent_convo_id != null && (
          typeof msg.parent_convo_id !== 'string'
          || msg.parent_convo_id.length === 0
          || msg.parent_convo_id.length > CONVO_ID_MAX_CHARS
        )) {
          return fail('bad_request', 'bad parent_convo_id')
        }
        const convo = upsertConversation(db, {
          id: msg.convo_id, ownerUserId: conn.userId,
          title: msg.title, sessionState: msg.session_state,
          agentDeviceId: conn.deviceId,
          parentConvoId: msg.parent_convo_id ?? null,
        })
        if (msg.session_state) {
          appendAndFan({
            userId: conn.userId, convoId: msg.convo_id,
            sender: `agent:${conn.name}`, type: 'session_status',
            payload: { state: msg.session_state },
          })
        }
        // Other devices learn renames live instead of only via /snapshot.
        // No event when the title is unchanged, absent, or this was a
        // state-only upsert (see upsertConversation's metaChanged logic).
        if (convo.metaChanged) {
          appendAndFan({
            userId: conn.userId, convoId: msg.convo_id,
            sender: `agent:${conn.name}`, type: 'convo_meta',
            payload: { title: convo.title, parent_convo_id: convo.parent_convo_id ?? null },
          })
        }
        break
      }
      case 'publish': {
        if (conn.kind !== 'agent') return fail('forbidden')
        if (typeof msg.type !== 'string' || !AGENT_PUBLISH_TYPES.has(msg.type) || typeof msg.payload !== 'object' || msg.payload === null) return fail('bad_request')
        // finalize composes `fin:<ref>` idem keys internally — a raw publish
        // must not be able to collide with (or forge) one of those.
        if (typeof msg.idem_key === 'string' && msg.idem_key.startsWith('fin:')) {
          return fail('bad_request', 'idem_key prefix fin: is reserved')
        }
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `agent:${conn.name}`, type: msg.type, payload: msg.payload,
          blobRef: msg.blob_ref ?? null,
          idemKey: msg.idem_key ? `agent:${conn.deviceId}:${msg.idem_key}` : null,
        })
        break
      }
      case 'stream': {
        if (conn.kind !== 'agent') return fail('forbidden')
        // TODO(grants): add an ownership check (authorize(), as `activity` does) when grants/sharing lands — inert today only because sendEphemeral is scoped to the agent's own user.
        hub.sendEphemeral(conn.userId, msg.convo_id, {
          kind: 'ephemeral', convo_id: msg.convo_id, message_ref: msg.message_ref,
          text: msg.text, replace_text: msg.replace_text,
        })
        break
      }
      case 'stream_append': {
        if (conn.kind !== 'agent') return fail('forbidden')
        if (!authorize(db, conn.userId, msg.convo_id)) return fail('forbidden')
        if (typeof msg.message_ref !== 'string' || !msg.message_ref) return fail('bad_request')
        if (typeof msg.chunk !== 'string' || !Number.isInteger(msg.offset) || msg.offset < 0) return fail('bad_request')
        const r = toolStreams.append({
          userId: conn.userId, convoId: msg.convo_id, ref: msg.message_ref,
          offset: msg.offset, chunk: msg.chunk, meta: msg.meta,
        })
        if (r.status === 'need_meta') return fail('bad_request', 'meta required on buffer-creating frame')
        if (r.status === 'resync') {
          conn.ws.send(JSON.stringify({
            kind: 'control', op: 'stream_resync',
            convo_id: msg.convo_id, message_ref: msg.message_ref, have: r.have,
          }))
          break
        }
        if (r.status === 'duplicate') break
        for (const ev of r.evicted) notifyStale(hub, ev)
        hub.sendEphemeral(conn.userId, msg.convo_id, {
          kind: 'ephemeral', convo_id: msg.convo_id, message_ref: msg.message_ref,
          tool_stream: { event: 'append', offset: r.offset, chunk: r.accepted },
        })
        break
      }
      case 'activity': {
        // Same ownership stance as every other agent write path (append/
        // markRead/upsertConversation): missing or not-owned fails closed as
        // forbidden. Unlike those, this never touches the journal — it's
        // purely a hub.sendEphemeral fan-out, same delivery path as stream
        // (viewing-scoped, coalesced, never throws on a dead/slow socket).
        if (conn.kind !== 'agent') return fail('forbidden')
        if (!ACTIVITY_STATES.has(msg.state)) return fail('bad_request')
        if (!authorize(db, conn.userId, msg.convo_id)) return fail('forbidden')
        const detail = typeof msg.detail === 'string' ? msg.detail.slice(0, ACTIVITY_DETAIL_MAX_CHARS) : undefined
        hub.sendEphemeral(conn.userId, msg.convo_id, {
          kind: 'ephemeral', convo_id: msg.convo_id,
          activity: { state: msg.state, detail },
        })
        break
      }
      case 'status': {
        // Same ownership stance and delivery path as `activity`, with one
        // difference: the last status per convo is cached (bounded, memory
        // only) and replayed on `viewing`, so a client opening a convo gets
        // a populated header immediately instead of waiting for the next
        // turn end. The payload is opaque to the server — validated only as
        // a size-capped object, so the bridge can evolve the shape without
        // a server deploy.
        if (conn.kind !== 'agent') return fail('forbidden')
        if (typeof msg.status !== 'object' || msg.status === null) return fail('bad_request')
        if (!authorize(db, conn.userId, msg.convo_id)) return fail('forbidden')
        let encoded
        try { encoded = JSON.stringify(msg.status) } catch { return fail('bad_request') }
        if (Buffer.byteLength(encoded, 'utf8') > STATUS_MAX_BYTES) return fail('bad_request', 'status too large')
        statusCache.set(conn.userId, msg.convo_id, msg.status)
        hub.sendEphemeral(conn.userId, msg.convo_id, {
          kind: 'ephemeral', convo_id: msg.convo_id, status: msg.status,
        })
        break
      }
      case 'finalize': {
        if (conn.kind !== 'agent') return fail('forbidden')
        // finalize's type is raw agent input just like publish's — without
        // the same whitelist it would be a bypass route for forging
        // server-generated types (session_status/read_marker/convo_meta).
        const type = msg.type || 'text'
        if (!AGENT_PUBLISH_TYPES.has(type)) return fail('bad_request')
        if (typeof msg.payload !== 'object' || msg.payload === null) return fail('bad_request')
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `agent:${conn.name}`, type, payload: msg.payload,
          blobRef: msg.blob_ref ?? null,
          idemKey: `agent:${conn.deviceId}:fin:${msg.message_ref}`,
        })
        // Normal end-of-stream for a live tool-output overlay: the durable
        // event above retires the client's view (same message_ref in its
        // payload), so the buffer can go — no 'end' ephemeral needed. A no-op
        // for every finalize that never streamed.
        toolStreams.free(msg.convo_id, msg.message_ref)
        break
      }
      default:
        break
    }
  } catch (e) {
    if (/not authorized/.test(e.message)) return fail('forbidden')
    throw e
  }
}

export { journalFrame }
