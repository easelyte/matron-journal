import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { upsertConvoStatus } from '../src/convo-status.js'
import { dueStalledBoxes, startStallWakeSweep, STALL_WAKE_MAX_AGE_MS } from '../src/stall-wake.js'

// Once a minute the journal wakes the box of any stalled session whose
// usage-limit reset time has passed, so that bridge's automatic carry-on
// can run even though the box idle-stopped while stalled.

function seed() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(name, password_hash, created_at) VALUES('dan','x',0)").run()
  const dan = { id: db.prepare("SELECT id FROM users WHERE name='dan'").get().id }
  const a = createAgent(db, dan.id, 'gene')
  const b = createAgent(db, dan.id, 'eric')
  const c = createAgent(db, dan.id, 'Weird Name')
  for (const [id, dev] of [['s1', a], ['s2', a], ['s3', b], ['s4', b], ['s5', c]]) {
    upsertConversation(db, { id, ownerUserId: dan.id, title: id, sessionState: 'waiting', agentDeviceId: dev.deviceId })
  }
  return { db, dan, a, b, c }
}

test('dueStalledBoxes: past reset times only, deduped per box, bad timestamps ignored', () => {
  const { db, dan, a, b, c } = seed()
  const NOW = Date.parse('2026-09-29T15:00:00Z')
  upsertConvoStatus(db, { userId: dan.id, convoId: 's1', status: { model: 'x', stall: { kind: 'usage_limit', resets_at: '2026-09-29T14:00:00Z' } }, reportedAt: 1 })
  upsertConvoStatus(db, { userId: dan.id, convoId: 's2', status: { model: 'x', stall: { kind: 'usage_limit', resets_at: '2026-09-29T14:30:00Z' } }, reportedAt: 1 })
  upsertConvoStatus(db, { userId: dan.id, convoId: 's3', status: { model: 'x', stall: { kind: 'usage_limit', resets_at: '2026-09-29T16:00:00Z' } }, reportedAt: 1 })
  upsertConvoStatus(db, { userId: dan.id, convoId: 's4', status: { model: 'x', stall: { kind: 'usage_limit' } }, reportedAt: 1 })
  upsertConvoStatus(db, { userId: dan.id, convoId: 's5', status: { model: 'x', stall: { kind: 'usage_limit', resets_at: 'soon' } }, reportedAt: 1 })
  assert.deepEqual(dueStalledBoxes(db, NOW), [{ user_id: dan.id, device_id: a.deviceId }])
  assert.deepEqual(dueStalledBoxes(db, Date.parse('2026-09-29T16:00:00Z')).map((r) => r.device_id).sort(), [a.deviceId, b.deviceId].sort())
  assert.deepEqual(dueStalledBoxes(db, Date.parse('2026-09-29T13:00:00Z')), [])
  // A reset older than the age cap is spent: the bridge is not coming back for it.
  assert.deepEqual(dueStalledBoxes(db, NOW + STALL_WAKE_MAX_AGE_MS + 60_000).map((r) => r.device_id), [b.deviceId], 'gene\'s 14:00/14:30 resets aged out; eric\'s 16:00 one still due')
  // A cleared stall (status without stall) is no longer due.
  upsertConvoStatus(db, { userId: dan.id, convoId: 's1', status: { model: 'x' }, reportedAt: 2 })
  upsertConvoStatus(db, { userId: dan.id, convoId: 's2', status: { model: 'x' }, reportedAt: 2 })
  assert.deepEqual(dueStalledBoxes(db, NOW), [])
  void c
})

test('startStallWakeSweep: wakes only offline, wakeable boxes that are due; no-op without a waker', () => {
  const { db, dan, a, b } = seed()
  const NOW = Date.parse('2026-09-29T15:00:00Z')
  upsertConvoStatus(db, { userId: dan.id, convoId: 's1', status: { model: 'x', stall: { kind: 'usage_limit', resets_at: '2026-09-29T14:00:00Z' } }, reportedAt: 1 })
  upsertConvoStatus(db, { userId: dan.id, convoId: 's3', status: { model: 'x', stall: { kind: 'usage_limit', resets_at: '2026-09-29T14:00:00Z' } }, reportedAt: 1 })
  const calls = []
  const waker = { enabled: true, wake: (name) => { calls.push(name); return true } }
  // eric is online: a live socket for its device id.
  const hub = { connsOf: () => [{ deviceId: b.deviceId, ws: { readyState: 1 } }] }
  const sweep = startStallWakeSweep({ db, hub, waker, intervalMs: 3600_000 })
  try {
    assert.equal(sweep.run(NOW), 1)
    assert.deepEqual(calls, ['gene'])
  } finally { sweep.stop() }
  const none = startStallWakeSweep({ db, hub, waker: null })
  assert.equal(none.run(NOW), 0)
  none.stop()
  void a
})

test('startStallWakeSweep: one box\'s failing wake does not cost the others theirs', () => {
  const { db, dan, a, b } = seed()
  const NOW = Date.parse('2026-09-29T15:00:00Z')
  upsertConvoStatus(db, { userId: dan.id, convoId: 's1', status: { model: 'x', stall: { kind: 'usage_limit', resets_at: '2026-09-29T14:00:00Z' } }, reportedAt: 1 })
  upsertConvoStatus(db, { userId: dan.id, convoId: 's3', status: { model: 'x', stall: { kind: 'usage_limit', resets_at: '2026-09-29T14:00:00Z' } }, reportedAt: 1 })
  const calls = []
  const waker = { enabled: true, wake: (name) => { calls.push(name); if (name === 'gene') throw new Error('ssh down'); return true } }
  const hub = { connsOf: () => [] }
  const logged = []
  const sweep = startStallWakeSweep({ db, hub, waker, intervalMs: 3600_000, log: { error: (m) => logged.push(m), warn: () => {} } })
  try {
    assert.equal(sweep.run(NOW), 1)
    assert.deepEqual(calls.sort(), ['eric', 'gene'])
    assert.equal(logged.length, 1)
  } finally { sweep.stop() }
  void a; void b
})
