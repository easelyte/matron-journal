import { spawn } from 'node:child_process'
import { joinedAgentIds } from './participants.js'

// Wake-on-message for idle-stopped agent boxes (yearbook shared-2 design,
// 2026-08-17). The infra host winds down dev VMs idle for 90 minutes; the
// bridge inside a stopped VM cannot reconnect on its own, so the journal —
// the one component that always sees the traffic — fires the wake. The
// command is an operator-provided argv prefix (MATRON_WAKE_CMD), typically
// an ssh invocation whose key is bound to a forced command on the incus
// host; the target box name is appended as the single trailing argument.
// The journal never decides HOW to wake, only WHEN.
//
// Fire-and-forget by design: the caller's op (send / agent_request /
// spawn_request) has already been answered from journal state, and the
// bridge's own resume machinery (bridge PR #220) drains whatever queued
// while the box booted. Nothing here blocks or throws into the ws path.

const DEFAULT_DEBOUNCE_MS = 60000
// After a wake command fails, how long before the next message may retry.
// Exit 2 is the wake command's own verdict that the box cannot be woken
// (unknown box, refused by every host), so it keeps the full debounce
// window: retrying a refusal on every message is a storm, not a retry
// (dev-j on 2026-09-09: 179 refused wakes in 2.5 h, one per message). Any
// other failure (ssh could not connect, killed) is treated as transient.
const DEFAULT_FAIL_BACKOFF_MS = 10000
const REFUSED_EXIT_CODE = 2
// A box name is an incus instance name; the forced command on the far end
// re-validates against live incus state, this is just the cheap local half.
const BOX_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

// The local half of "can this device be woken at all": device names are
// free text (a client may be called "Dan MacBook"), the wake command only
// takes an incus instance name. wakeIfOffline and the roster/spawn_targets
// `wakeable` flag share this so a listing never promises a wake the
// command would refuse.
export function isWakeableBoxName(name) {
  return typeof name === 'string' && BOX_NAME_RE.test(name)
}

export function makeWaker({
  cmd = process.env.MATRON_WAKE_CMD,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  failBackoffMs = DEFAULT_FAIL_BACKOFF_MS,
  log = console,
} = {}) {
  const argv = (cmd || '').trim().split(/\s+/).filter(Boolean)
  const lastFired = new Map() // box -> ts of last spawn

  return {
    enabled: argv.length > 0,
    // Returns true when a wake was fired OR suppressed by the debounce (the
    // box is already being woken); false when disabled or the name is unusable.
    wake(box) {
      if (!argv.length) return false
      if (!isWakeableBoxName(box)) return false
      const now = Date.now()
      if (now - (lastFired.get(box) || 0) < debounceMs) return true
      lastFired.set(box, now)
      log.log(`wake: firing for ${box}`)
      try {
        const child = spawn(argv[0], [...argv.slice(1), box], {
          stdio: ['ignore', 'ignore', 'pipe'],
        })
        let stderr = ''
        child.stderr.on('data', (d) => { stderr += d })
        child.on('error', (err) => log.error(`wake: ${box}: spawn failed`, err))
        child.on('close', (code) => {
          if (code !== 0) {
            // Re-arm the debounce from the moment of failure: a transient
            // failure may retry after failBackoffMs, never on the very next
            // message. A refusal (exit 2) gets the full window: nothing
            // changes between two messages that would make the box wakeable.
            if (lastFired.get(box) === now) {
              const failedAt = Date.now()
              const wait = code === REFUSED_EXIT_CODE ? debounceMs : Math.min(failBackoffMs, debounceMs)
              lastFired.set(box, failedAt - (debounceMs - wait))
            }
            log.error(`wake: ${box}: exit ${code}${stderr ? `: ${stderr.trim()}` : ''}`)
          }
        })
      } catch (err) {
        log.error(`wake: ${box}: spawn threw`, err)
      }
      return true
    },
  }
}

// Shared by ws.js (send / prompt_reply / agent_request / spawn_request /
// agent_invite / agent_join), http.js (spawn approval, invite approval) and
// items-http.js (user-authored item markers): traffic for an agent device
// with no live socket asks the infra layer to start its box. Same-user
// scoping mirrors the anti-enumeration stance of every call site.
//
// Returns true when the box is now being woken (a wake command was fired,
// or one is already in flight under the waker's debounce) — the signal
// spawn_request and approveSpawn use to decide whether waiting for the box
// can ever pay off. False when it is already online, when no waker is
// configured, or when the device is not a wakeable agent box (not an agent,
// or a name the wake command would refuse — isWakeableBoxName).
export function wakeIfOffline({ db, hub, waker }, userId, agentDeviceId) {
  if (!waker || !waker.enabled || !Number.isInteger(agentDeviceId)) return false
  const online = hub.connsOf(userId).some((c) => c.deviceId === agentDeviceId && c.ws.readyState === 1)
  if (online) return false
  const dev = db.prepare('SELECT name, kind FROM devices WHERE id=? AND user_id=?').get(agentDeviceId, userId)
  if (!dev || dev.kind !== 'agent' || !isWakeableBoxName(dev.name)) return false
  return waker.wake(dev.name) === true
}

// Every agent device a message into this conversation is FOR: the managing
// agent, plus — when the conversation is an agent-chat room — each joined
// participant (state 'joined' is exactly the set with delivery rights, see
// participants.js). Until 2026-09-21 only the owner was woken, so a room
// message for a guest whose box had idle-stopped sat unread until something
// unrelated started that box. `exceptDeviceId` is the writer: an agent
// posting into a room is awake by definition, and waking it would spend the
// debounce window on a no-op.
export function wakeConvoAgent({ db, hub, waker }, userId, convoId, { exceptDeviceId = null } = {}) {
  if (!waker || !waker.enabled) return
  const row = db.prepare('SELECT agent_device_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, userId)
  if (!row) return
  const targets = new Set(joinedAgentIds(db, convoId))
  if (row.agent_device_id != null) targets.add(row.agent_device_id)
  for (const id of targets) {
    if (id !== exceptDeviceId) wakeIfOffline({ db, hub, waker }, userId, id)
  }
}
