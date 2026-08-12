//
// Journal-originated RPC (spec: 2026-08-09 agent-spawned sessions, "the
// journal must learn to await RPC responses"). Today's relay correlates
// nothing — it forwards a request and forwards whatever comes back. This
// broker is the pending-request map that lets the JOURNAL be the caller:
// issue() sends over the same single-consumer hub path the client relay
// uses, parks a resolver keyed by request_id, and resolves exactly once —
// on the bridge's reply, on timeout, or immediately when the target has no
// live socket. Never left hanging: a spawn stuck 'approved' forever is the
// failure mode this timeout exists to close.
//
// from_device_id: 0 marks a request as journal-originated. No device row
// ever has id 0 (SQLite AUTOINCREMENT starts at 1), so a bridge echoing it
// back as to_device_id can never collide with a real client device — and
// ws.js's agent_response handler checks the broker BEFORE the client-target
// lookup anyway.
import { randomUUID } from 'node:crypto'

export function makeRpcBroker() {
  const pending = new Map() // request_id -> { userId, deviceId, settle, timer }
  return {
    issue(hub, userId, deviceId, method, params, { timeoutMs }) {
      const requestId = randomUUID()
      return new Promise((resolve) => {
        const entry = {
          userId, deviceId,
          settle(outcome) {
            clearTimeout(entry.timer)
            pending.delete(requestId)
            resolve(outcome)
          },
          // Ref'd timer (no unref) is deliberate: an unref'd timer whose event loop
          // empties abandons the awaited promise mid-flight, violating settle-exactly-once.
          // Trade-off: ref'd timer holds the process open up to timeoutMs on shutdown,
          // which is acceptable to guarantee the timeout fires and settles the promise.
          timer: setTimeout(() => entry.settle({ ok: false, error: { code: 'timeout' } }), timeoutMs),
        }
        pending.set(requestId, entry)
        try {
          const delivered = hub.sendRpcRequest(userId, deviceId, {
            kind: 'rpc',
            request: { request_id: requestId, from_device_id: 0, method, params },
          })
          if (!delivered) entry.settle({ ok: false, error: { code: 'agent_unreachable' } })
        } catch (err) {
          entry.settle({ ok: false, error: { code: 'send_failed' } })
        }
      })
    },
    // Called from ws.js's agent_response handler. Returns whether this reply
    // belonged to a journal-originated request; false lets the handler fall
    // through to the ordinary client-forward path. Only the device the
    // request was sent to, on the user it was sent for, may settle it —
    // request ids are unguessable UUIDs, but unguessable is not a
    // substitute for checking.
    resolve(requestId, { userId, deviceId, msg }) {
      const entry = pending.get(requestId)
      if (!entry) return false
      if (entry.userId !== userId || entry.deviceId !== deviceId) return false
      entry.settle(msg.ok
        ? { ok: true, result: msg.result ?? null }
        : { ok: false, error: msg.error })
      return true
    },
    pendingCount() { return pending.size },
  }
}
