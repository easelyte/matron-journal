const byteLen = (s) => Buffer.byteLength(s, 'utf8')

// Coalescing rule for one pending slot. Legacy ephemerals (text overlays,
// activity) keep latest-wins — every frame carries full replacement state.
// Tool-stream appends are DELTAS, so latest-wins would drop output: a
// pending append (or sync) absorbs a contiguous next append by
// concatenation instead. Anything else — end frames, a fresh sync, a
// non-contiguous append (defensive; the store fans out contiguously) —
// replaces the slot.
export function mergeEphemeral(prev, frame) {
  if (!prev) return frame
  const p = prev.tool_stream
  const f = frame.tool_stream
  if (p && f && f.event === 'append') {
    if (p.event === 'append' && p.offset + byteLen(p.chunk) === f.offset) {
      return { ...prev, tool_stream: { ...p, chunk: p.chunk + f.chunk } }
    }
    if (p.event === 'sync' && p.offset + byteLen(p.content) === f.offset) {
      return { ...prev, tool_stream: { ...p, content: p.content + f.chunk } }
    }
  }
  return frame
}

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
    // Every registered connection, across all users — the revocation
    // sweep's input (see ws.js): it needs each conn's deviceId to compare
    // against the devices table in one query.
    allConns() {
      const out = []
      for (const set of byUser.values()) for (const c of set) out.push(c)
      return out
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
    // agentDeviceId scopes delivery to agent connections: client devices
    // always receive every frame, but an agent device only receives frames
    // for conversations it owns (multi-bridge fleets: a bridge getting
    // another bridge's user input treats it as an unknown convo and bounces
    // it into the chat). null means "owner unknown" — legacy rows and
    // convo-less frames keep the old broadcast-to-everyone behavior.
    broadcastJournal(userId, frame, agentDeviceId = null) {
      for (const c of byUser.get(userId) || []) {
        if (c.kind === 'agent' && agentDeviceId != null && c.deviceId !== agentDeviceId) continue
        if (c.ws.readyState === 1) c.ws.send(JSON.stringify(frame))
      }
    },
    sendEphemeral(userId, convoId, frame) {
      for (const c of byUser.get(userId) || []) {
        if (c.viewingConvoId !== convoId || c.ws.readyState !== 1) continue
        const key = `${frame.convo_id}:${frame.message_ref}`
        c._pending.set(key, mergeEphemeral(c._pending.get(key), frame))
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
