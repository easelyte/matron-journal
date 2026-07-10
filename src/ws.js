import { WebSocketServer } from 'ws'
import { authToken } from './auth.js'
import { eventsAfter } from './journal.js'

const journalFrame = (e) => ({
  kind: 'journal', seq: e.seq, convo_id: e.convo_id, ts: e.ts,
  sender: e.sender, type: e.type, payload: e.payload,
})

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
  if (msg.op === 'viewing') {
    conn.viewingConvoId = msg.convo_id ?? null
  }
}

export { journalFrame }
