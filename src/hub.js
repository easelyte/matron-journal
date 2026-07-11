export function makeHub({ coalesceMs = 200 } = {}) {
  const byUser = new Map() // userId -> Set<conn>
  return {
    register(conn) {
      if (!byUser.has(conn.userId)) byUser.set(conn.userId, new Set())
      byUser.get(conn.userId).add(conn)
      conn._pending = new Map() // ephemeral coalescing: key -> frame
      conn._flushTimer = null
    },
    unregister(conn) {
      byUser.get(conn.userId)?.delete(conn)
      if (conn._flushTimer) clearTimeout(conn._flushTimer)
    },
    connsOf(userId) {
      return [...(byUser.get(userId) || [])]
    },
    // Global connected-socket count across every user — a /metrics-only
    // aggregate (no per-user scoping concern: it's just a number, not
    // anyone's identity).
    totalConnections() {
      let n = 0
      for (const set of byUser.values()) n += set.size
      return n
    },
    // Per-device "is this device connected AND looking at this convo right
    // now" — the push pipeline's suppression rule. conn.deviceId is already
    // carried on every registered connection (see ws.js hello handling).
    isViewing(userId, deviceId, convoId) {
      for (const c of byUser.get(userId) || []) {
        if (c.deviceId === deviceId && c.viewingConvoId === convoId && c.ws.readyState === 1) return true
      }
      return false
    },
    broadcastJournal(userId, frame) {
      for (const c of byUser.get(userId) || []) {
        if (c.ws.readyState === 1) c.ws.send(JSON.stringify(frame))
      }
    },
    sendEphemeral(userId, convoId, frame) {
      for (const c of byUser.get(userId) || []) {
        if (c.viewingConvoId !== convoId || c.ws.readyState !== 1) continue
        const key = `${frame.convo_id}:${frame.message_ref}`
        c._pending.set(key, frame) // latest wins
        if (!c._flushTimer) {
          c._flushTimer = setTimeout(() => {
            c._flushTimer = null
            for (const f of c._pending.values()) {
              if (c.ws.readyState === 1) c.ws.send(JSON.stringify(f))
            }
            c._pending.clear()
          }, coalesceMs)
        }
      }
    },
  }
}
