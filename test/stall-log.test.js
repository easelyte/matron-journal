import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startStallLog, timed, logSlowRequests } from '../src/stall-log.js'

beforeEach((t) => {
  const previous = process.env.MATRON_STALL_LOG
  delete process.env.MATRON_STALL_LOG
  t.after(() => {
    if (previous === undefined) delete process.env.MATRON_STALL_LOG
    else process.env.MATRON_STALL_LOG = previous
  })
})

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
  const slow = timed('x', () => { clock += 500; return 7 }, { thresholdMs: 500, log: (l) => lines.push(l), now: () => clock })
  assert.equal(slow, 7)
  assert.deepEqual(lines, ['stall: x took 500ms'])
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
  assert.deepEqual(lines, ['slow request: GET /items took 900ms (status 200)'])
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

test('MATRON_STALL_LOG=0 disables the monitor, request wrapper and all maintenance timings', () => {
  process.env.MATRON_STALL_LOG = '0'
  const unexpected = () => assert.fail('disabled diagnostics must not sample, log or schedule')
  const opts = { now: unexpected, cpu: unexpected, log: unexpected,
    setIntervalImpl: unexpected, clearIntervalImpl: unexpected }
  startStallLog(opts).stop()

  let calls = 0
  for (const label of ['wal_checkpoint(PASSIVE)', 'retention run', 'auto-archive sweep', 'tts sweep']) {
    assert.equal(timed(label, () => { calls++; return 7 }, opts), 7)
  }
  assert.equal(calls, 4, 'maintenance still runs when diagnostics are disabled')
  const error = new Error('maintenance failed')
  assert.throws(() => timed('retention run', () => { throw error }, opts), (err) => err === error)

  const handler = () => 42
  assert.equal(logSlowRequests(handler, opts), handler, 'no response listeners are added')
})
