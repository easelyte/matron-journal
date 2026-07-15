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
  let regCounter = 0
  return {
    register(conn) {
      if (!byUser.has(conn.userId)) byUser.set(conn.userId, new Set())
      byUser.get(conn.userId).add(conn)
      // Monotonic registration stamp — sendRpcRequest's "most recently
      // registered live socket" rule needs an order that survives Set
      // deletion/re-insertion (insertion order alone doesn't).
      conn._regSeq = ++regCounter
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
        // One pending slot per (convo, message_ref, frame family): activity,
        // status, and text/tool-stream overlays are distinct families that
        // must not clobber each other inside one coalesce window — the
        // bridge fires status AND idle-activity back-to-back at turn end.
        const family = frame.activity ? 'activity' : frame.status ? 'status' : 'stream'
        const key = `${frame.convo_id}:${frame.message_ref}:${family}`
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
    // Agent-RPC request delivery (spec 2026-07-15-agent-rpc-design.md):
    // exactly ONE socket — the most recently registered live connection of
    // the target device. A device normally has one socket, but reconnect
    // overlap can briefly leave two, and multicasting a request there would
    // double-execute non-idempotent methods (`start` spawning two
    // sessions). Direct send — RPC frames must never enter the ephemeral
    // coalescer (latest-wins would drop them). Returns whether a socket
    // took the frame, so the caller can answer `agent_unreachable`.
    sendRpcRequest(userId, deviceId, frame) {
      let newest = null
      for (const c of byUser.get(userId) || []) {
        if (c.deviceId !== deviceId || c.ws.readyState !== 1) continue
        if (!newest || c._regSeq > newest._regSeq) newest = c
      }
      if (!newest) return false
      newest.ws.send(JSON.stringify(frame))
      return true
    },
    // Agent-RPC response delivery: multicast to every live socket of the
    // target device — responses carry no side effects and clients dedupe by
    // request_id, while single-consumer here would lose the response for a
    // mid-reconnect client. Fire-and-forget: a fully disconnected client
    // just misses it (stateless relay — the app re-asks).
    sendRpcResponse(userId, deviceId, frame) {
      for (const c of byUser.get(userId) || []) {
        if (c.deviceId === deviceId && c.ws.readyState === 1) c.ws.send(JSON.stringify(frame))
      }
    },
  }
}
