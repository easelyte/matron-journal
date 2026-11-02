// Event-loop stall log. The journal does synchronous SQLite on one thread, so
// any blocking call (an fsync in a WAL checkpoint, a cold read of a large
// table under disk pressure) stalls every request, and a client that waits
// 10 s reports the journal as unreachable. This names the stalls: a timer
// ticks every `tickMs`; when a tick arrives more than `thresholdMs` late it
// logs one line with the wall time lost and the process CPU used across it.
// cpu ~ wall means the thread was busy in JS/SQLite; cpu << wall means it was
// blocked in a syscall (fsync, disk read) or the host descheduled it.
//
// `timed(label, fn)` wraps a synchronous call and logs when it alone took
// longer than `thresholdMs`, so a stall can be matched to the call behind it.
// Both are log-only: no behaviour change. Off with MATRON_STALL_LOG=0.

import { performance } from 'node:perf_hooks'

const defaultNow = () => performance.now()

export const STALL_THRESHOLD_MS = 500
export const STALL_TICK_MS = 100

export function startStallLog({
  thresholdMs = STALL_THRESHOLD_MS,
  tickMs = STALL_TICK_MS,
  log = (line) => console.warn(line),
  now = defaultNow,
  cpu = () => process.cpuUsage(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let last = now()
  let lastCpu = cpu()
  const timer = setIntervalImpl(() => {
    const t = now()
    const c = cpu()
    const lateMs = t - last - tickMs
    if (lateMs >= thresholdMs) {
      const cpuMs = Math.round((c.user - lastCpu.user + c.system - lastCpu.system) / 1000)
      log(`stall: event loop blocked ${Math.round(lateMs)}ms (cpu ${cpuMs}ms, ${cpuMs < lateMs / 2 ? 'mostly blocked in a syscall or descheduled' : 'busy'})`)
    }
    last = t
    lastCpu = c
  }, tickMs)
  if (typeof timer?.unref === 'function') timer.unref()
  return { stop: () => clearIntervalImpl(timer) }
}

export function timed(label, fn, { thresholdMs = STALL_THRESHOLD_MS, log = (line) => console.warn(line), now = defaultNow } = {}) {
  const start = now()
  try {
    return fn()
  } finally {
    const ms = now() - start
    if (ms >= thresholdMs) log(`stall: ${label} took ${Math.round(ms)}ms`)
  }
}
