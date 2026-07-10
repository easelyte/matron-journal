import { WebSocketServer } from 'ws'
import { authToken } from './auth.js'
import { eventsAfter, append, markRead, upsertConversation } from './journal.js'

const journalFrame = (e) => ({
  kind: 'journal', seq: e.seq, convo_id: e.convo_id, ts: e.ts,
  sender: e.sender, type: e.type, payload: e.payload,
})

const CLIENT_SEND_TYPES = new Set(['text'])

export function attachWs({ server, db, hub, pingMs = 20000 }) {
  const wss = new WebSocketServer({ server, path: '/ws' })
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
          // conn is assigned here, before replay/registration complete below. If another
          // message arrives while the replay loop is yielded (see setImmediate below),
          // it will be dispatched to handleOp before hub.register(conn) runs. That's safe
          // for every op handled today: any journal append it triggers gets a seq greater
          // than the in-flight cursor, so it's picked up by a later replay batch rather
          // than lost. Revisit this assumption if a future op has other side effects.
          conn = { ws, ...who, viewingConvoId: null }
          conn.username = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId).name
          const head = db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(who.userId)
          ws.send(JSON.stringify({ kind: 'control', op: 'hello_ok', seq: head ? head.seq : 0 }))
          if (msg.cursor != null) {
            let cursor = msg.cursor
            for (;;) {
              const batch = eventsAfter(db, who.userId, cursor, 500)
              for (const e of batch) ws.send(JSON.stringify(journalFrame(e)))
              if (batch.length < 500) break
              cursor = batch[batch.length - 1].seq
              // Yield between batches only — a large backlog must not block the event
              // loop (and starve other connections' pings) while replaying.
              await new Promise((r) => setImmediate(r))
            }
          }
          // INVARIANT: no yield between the final eventsAfter call (the batch that broke
          // the loop above, batch.length < 500) and hub.register(conn). That synchronous
          // tail is what guarantees no live event can slip through the gap between the
          // end of replay and live registration.
          hub.register(conn)
          conn.registered = true
          return
        }
        handleOp({ db, hub, conn, msg })
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

    ws.on('close', () => { if (conn) hub.unregister(conn) })
  })
  return wss
}

// Extended by Tasks 7-8 with client and agent operations.
export function handleOp({ db, hub, conn, msg }) {
  const fail = (code) =>
    conn.ws.send(JSON.stringify({ kind: 'control', op: 'error', code, ref: msg.op }))
  const appendAndFan = (args) => {
    const r = append(db, args)
    if (!r.duplicate) {
      hub.broadcastJournal(conn.userId, journalFrame({
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
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `user:${conn.username}`, type: 'prompt_reply',
          payload: { target_seq: msg.target_seq, choice: msg.choice ?? null, text: msg.text ?? null },
        })
        break
      }
      case 'read_marker': {
        if (conn.kind !== 'client') return fail('forbidden')
        const r = markRead(db, conn.userId, msg.convo_id, msg.up_to_seq)
        hub.broadcastJournal(conn.userId, journalFrame({
          seq: r.seq, convo_id: msg.convo_id, ts: r.ts,
          sender: `user:${conn.userId}`, type: 'read_marker',
          payload: { convo_id: msg.convo_id, up_to_seq: msg.up_to_seq },
        }))
        break
      }
      case 'convo_upsert': {
        if (conn.kind !== 'agent') return fail('forbidden')
        upsertConversation(db, {
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
        break
      }
      case 'publish': {
        if (conn.kind !== 'agent') return fail('forbidden')
        if (typeof msg.type !== 'string' || !msg.type || typeof msg.payload !== 'object' || msg.payload === null) return fail('bad_request')
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
        if (typeof msg.payload !== 'object' || msg.payload === null) return fail('bad_request')
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `agent:${conn.name}`, type: msg.type || 'text', payload: msg.payload,
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
