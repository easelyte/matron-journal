import { WebSocketServer } from 'ws'
import { authToken } from './auth.js'
import { eventsAfter, append, markRead, upsertConversation, toEventShape } from './journal.js'

const journalFrame = (e) => ({ kind: 'journal', ...toEventShape(e) })

const CLIENT_SEND_TYPES = new Set(['text'])

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
}) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_WS_PAYLOAD_BYTES })
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws._alive === false) { ws.terminate(); continue }
      ws._alive = false
      ws.ping()
    }
  }, pingMs)
  wss.on('close', () => clearInterval(interval))

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
          if (msg.cursor !== undefined && msg.cursor !== null && !Number.isInteger(msg.cursor)) {
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
            for (;;) {
              const batch = eventsAfter(db, who.userId, cursor, 500)
              for (const e of batch) ws.send(JSON.stringify(journalFrame(e)))
              if (batch.length < 500) break
              cursor = batch[batch.length - 1].seq
              // A slow/paused reader must not let the server buffer an unbounded amount
              // of replay data in the socket's outgoing queue — wait for it to drain
              // below the threshold before fetching/sending the next batch.
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
        handleOp({ db, hub, conn, msg, pushPipeline })
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

// Extended by Tasks 7-8 with client and agent operations.
export function handleOp({ db, hub, conn, msg, pushPipeline = noopPushPipeline }) {
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
    hub.broadcastJournal(conn.userId, frame)
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
      case 'viewing':
        conn.viewingConvoId = msg.convo_id ?? null
        break
      case 'ack':
        if (!Number.isInteger(msg.cursor) || msg.cursor < 0) return fail('bad_request')
        db.prepare('UPDATE devices SET cursor=? WHERE id=?').run(msg.cursor, conn.deviceId)
        break
      case 'send': {
        if (conn.kind !== 'client') return fail('forbidden')
        const type = msg.type || 'text'
        if (!CLIENT_SEND_TYPES.has(type)) return fail('forbidden')
        if (typeof msg.payload !== 'object' || msg.payload === null) return fail('bad_request')
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `user:${conn.username}`, type,
          payload: msg.payload,
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
        const convo = upsertConversation(db, {
          id: msg.convo_id, ownerUserId: conn.userId,
          title: msg.title, sessionState: msg.session_state,
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
        // state-only upsert (see upsertConversation's titleChanged logic).
        if (convo.titleChanged) {
          appendAndFan({
            userId: conn.userId, convoId: msg.convo_id,
            sender: `agent:${conn.name}`, type: 'convo_meta',
            payload: { title: convo.title },
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
        hub.sendEphemeral(conn.userId, msg.convo_id, {
          kind: 'ephemeral', convo_id: msg.convo_id, message_ref: msg.message_ref,
          text: msg.text, replace_text: msg.replace_text,
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
          idemKey: `agent:${conn.deviceId}:fin:${msg.message_ref}`,
        })
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
