import { spawn } from 'node:child_process'

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
// A box name is an incus instance name; the forced command on the far end
// re-validates against live incus state, this is just the cheap local half.
const BOX_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

export function makeWaker({
  cmd = process.env.MATRON_WAKE_CMD,
  debounceMs = DEFAULT_DEBOUNCE_MS,
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
      if (typeof box !== 'string' || !BOX_NAME_RE.test(box)) return false
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
            // Clear the debounce so the next message retries immediately
            // instead of eating the window on a failed attempt.
            if (lastFired.get(box) === now) lastFired.delete(box)
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
