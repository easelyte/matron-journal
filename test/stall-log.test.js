import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startStallLog, timed, logSlowRequests } from '../src/stall-log.js'

function fakeTimers() {
  let tick = null
  return {
    setIntervalImpl: (fn) => { tick = fn; return { unref() {} } },
    clearIntervalImpl: () => { tick = null },
    fire: () => tick && tick(),
    active: () => tick !== null,
  }
}

test('logs a stall with wall time and cpu, labelled blocked when cpu is low', () => {
  const lines = []
  const t = fakeTimers()
  let clock = 0
  let cpuUs = 0
  const h = startStallLog({
    thresholdMs: 500, tickMs: 100, log: (l) => lines.push(l),
    now: () => clock, cpu: () => ({ user: cpuUs, system: 0 }),
    setIntervalImpl: t.setIntervalImpl, clearIntervalImpl: t.clearIntervalImpl,
  })
  clock = 100; cpuUs = 1000; t.fire()
  assert.deepEqual(lines, [], 'an on-time tick logs nothing')
  clock = 12100; cpuUs = 5000; t.fire() // arrives 11.9 s late, 4 ms of cpu
  assert.equal(lines.length, 1)
  assert.match(lines[0], /blocked 11900ms \(cpu 4ms, mostly blocked in a syscall or descheduled\)/)
  clock = 13100; cpuUs = 5000 + 900_000; t.fire() // 900 ms late and busy
  assert.match(lines[1], /blocked 900ms \(cpu 900ms, busy\)/)
  h.stop()
  assert.equal(t.active(), false)
})

test('timed logs only calls at or over the threshold and returns the result', () => {
  const lines = []
  let clock = 0
  const slow = timed('x', () => { clock += 700; return 7 }, { thresholdMs: 500, log: (l) => lines.push(l), now: () => clock })
  assert.equal(slow, 7)
  assert.deepEqual(lines, ['stall: x took 700ms'])
  timed('y', () => { clock += 10 }, { thresholdMs: 500, log: (l) => lines.push(l), now: () => clock })
  assert.equal(lines.length, 1)
})

test('timed logs and rethrows when the call throws', () => {
  const lines = []
  let clock = 0
  assert.throws(() => timed('z', () => { clock += 800; throw new Error('boom') }, { thresholdMs: 500, log: (l) => lines.push(l), now: () => clock }), /boom/)
  assert.deepEqual(lines, ['stall: z took 800ms'])
})

test('logSlowRequests logs a slow request once, by path without the query', () => {
  const lines = []
  let clock = 0
  const handlers = {}
  const res = { statusCode: 200, once: (e, f) => { handlers[e] = f } }
  const wrapped = logSlowRequests((req, r) => { clock += 900; r.statusCode = 200 }, { thresholdMs: 500, log: (l) => lines.push(l), now: () => clock })
  wrapped({ method: 'GET', url: '/items?token=secret' }, res)
  handlers.finish(); handlers.close()
  assert.deepEqual(lines, ['stall: request GET /items took 900ms (status 200)'])
})

test('logSlowRequests stays quiet for a fast request', () => {
  const lines = []
  let clock = 0
  const handlers = {}
  const res = { statusCode: 200, once: (e, f) => { handlers[e] = f } }
  logSlowRequests((req, r) => { clock += 5 }, { thresholdMs: 500, log: (l) => lines.push(l), now: () => clock })({ method: 'GET', url: '/x' }, res)
  handlers.finish()
  assert.deepEqual(lines, [])
})
