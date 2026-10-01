import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, upsertDeviceStatus, pinDevicePrivate } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { upsertConversation } from '../src/journal.js'
import { upsertConvoStatus } from '../src/convo-status.js'
import { validateRoutineFields, createRoutine, getRoutine, seedRoutines, listRoutines, STARTER_ROUTINES, TRIGGER_KINDS } from '../src/routines.js'
import { evaluateTrigger, trippedSubjects, trigMessage, describeTrigger, contextWindowOf } from '../src/routines-triggers.js'
import { startTestServer, makeWsClient } from './helpers.js'

// Triggered routines (spec 2026-10-01 coordinator routines, "Triggers"):
// a routine with a trigger instead of a schedule fires when a session's
// context passes a threshold, a session stalls on a usage limit with a far
// reset, or a box's disk drops under a threshold — once per subject per
// crossing, with the specifics in the turn.

const NOW = Date.parse('2026-10-01T10:00:00Z')
const GB = 1024 ** 3

async function seedDb() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const mavis = createAgent(db, dan.id, 'mavis')
  const gene = createAgent(db, dan.id, 'gene')
  const priv = createAgent(db, dan.id, 'priv-box')
  pinDevicePrivate(db, priv.deviceId, true)
  upsertConversation(db, { id: 'coord', ownerUserId: dan.id, title: 'Coordinator', sessionState: 'waiting', agentDeviceId: mavis.deviceId })
  upsertConversation(db, { id: 'g1', ownerUserId: dan.id, title: 'Big [session]', sessionState: 'running', agentDeviceId: gene.deviceId })
  upsertConversation(db, { id: 'g2', ownerUserId: dan.id, title: 'Stalled one', sessionState: 'waiting', agentDeviceId: gene.deviceId })
  upsertConversation(db, { id: 'g3', ownerUserId: dan.id, title: 'Finished', sessionState: 'done', agentDeviceId: gene.deviceId })
  upsertConversation(db, { id: 'p1', ownerUserId: dan.id, title: 'Private big', sessionState: 'running', agentDeviceId: priv.deviceId })
  upsertConversation(db, { id: 'g4', ownerUserId: dan.id, title: 'Small window', sessionState: 'running', agentDeviceId: gene.deviceId })
  upsertConversation(db, { id: 'g5', ownerUserId: dan.id, title: 'Opus on an old bridge', sessionState: 'running', agentDeviceId: gene.deviceId })
  upsertConversation(db, { id: 'g1:sub:h1', ownerUserId: dan.id, title: 'Helper', sessionState: 'running', agentDeviceId: gene.deviceId, parentConvoId: 'g1' })
  setCoordinatorConvoId(db, dan.id, 'coord')
  return { db, dan, mavis, gene, priv }
}

test('validateRoutineFields: a trigger instead of a schedule, exactly one of the two, bounded thresholds', () => {
  const base = { name: 'ctx', title: 'Context', prompt: 'p' }
  const ok = validateRoutineFields({ ...base, trigger: { kind: 'context_over', pct: 40 } })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.value.trigger, { kind: 'context_over', pct: 40 })
  assert.equal(ok.value.schedule, null)
  assert.deepEqual(validateRoutineFields({ ...base, trigger: { kind: 'stalled' } }).value.trigger, { kind: 'stalled', reset_minutes: 120 })
  assert.deepEqual(validateRoutineFields({ ...base, trigger: { kind: 'stalled', reset_minutes: 0 } }).value.trigger, { kind: 'stalled', reset_minutes: 0 })
  assert.deepEqual(validateRoutineFields({ ...base, trigger: { kind: 'disk_under', pct: 20 } }).value.trigger, { kind: 'disk_under', pct: 20 })
  const bad = (over) => assert.equal(validateRoutineFields({ ...base, ...over }).ok, false, JSON.stringify(over))
  bad({})                                                        // neither
  bad({ schedule: '5 7 * * *', trigger: { kind: 'disk_under', pct: 20 } }) // both
  bad({ trigger: { kind: 'volcano' } }); bad({ trigger: 'context_over' }); bad({ trigger: { kind: 'context_over' } })
  bad({ trigger: { kind: 'context_over', pct: 0 } }); bad({ trigger: { kind: 'context_over', pct: 100 } }); bad({ trigger: { kind: 'context_over', pct: '40' } })
  bad({ trigger: { kind: 'disk_under', pct: 20, extra: 1 } }); bad({ trigger: { kind: 'stalled', reset_minutes: 100000 } })
  assert.deepEqual(TRIGGER_KINDS, ['context_over', 'stalled', 'disk_under'])
  // PATCH: a trigger may change; schedule and trigger cannot both be given.
  assert.deepEqual(validateRoutineFields({ trigger: { kind: 'context_over', pct: 50 } }, { partial: true }).value, { trigger: { kind: 'context_over', pct: 50 } })
  assert.equal(validateRoutineFields({ trigger: { kind: 'context_over', pct: 50 }, schedule: '5 7 * * *' }, { partial: true }).ok, false)
})

test('createRoutine with a trigger: no next_at, trigger on the row; a PATCH cannot turn one kind of routine into the other', async () => {
  const { db, dan } = await seedDb()
  const r = createRoutine(db, { userId: dan.id, origin: 'user', fields: validateRoutineFields({ name: 'ctx', title: 'C', prompt: 'p', trigger: { kind: 'context_over', pct: 40 } }).value, now: NOW })
  assert.equal(r.schedule, null); assert.equal(r.next_at, null); assert.deepEqual(r.trigger, { kind: 'context_over', pct: 40 })
  const { updateRoutine } = await import('../src/routines.js')
  assert.throws(() => updateRoutine(db, { userId: dan.id, key: 'ctx', fields: { schedule: '5 7 * * *' }, now: NOW }), /mixed/)
  const u = updateRoutine(db, { userId: dan.id, key: 'ctx', fields: { trigger: { kind: 'context_over', pct: 55 } }, now: NOW })
  assert.deepEqual(u.trigger, { kind: 'context_over', pct: 55 })
  const s = createRoutine(db, { userId: dan.id, origin: 'user', fields: validateRoutineFields({ name: 'sch', title: 'S', prompt: 'p', schedule: '5 7 * * *' }).value, now: NOW })
  assert.equal(s.trigger, null)
  assert.throws(() => updateRoutine(db, { userId: dan.id, key: 'sch', fields: { trigger: { kind: 'disk_under', pct: 20 } }, now: NOW }), /mixed/)
})

test('evaluateTrigger: context_over, stalled, disk_under — live sessions only, never the Coordinator, private-owned hidden from an ordinary Coordinator box', async () => {
  const { db, dan, mavis, gene, priv } = await seedDb()
  upsertConvoStatus(db, { userId: dan.id, convoId: 'g1', status: { model: 'opus-5-5', context: { tokens: 420000, window: 1000000, pct: 42 } }, reportedAt: NOW })
  // A 200k-window model at 50% trips; an Opus session whose bridge reports 200k is measured against 1M (10%) and does not;
  // a helper inside g1 never counts, however full (item 5894).
  upsertConvoStatus(db, { userId: dan.id, convoId: 'g4', status: { model: 'haiku-4-5', context: { tokens: 100000, window: 200000, pct: 50 } }, reportedAt: NOW })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'g5', status: { model: 'claude-opus-5-5', context: { tokens: 100000, window: 200000, pct: 50 } }, reportedAt: NOW })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'g1:sub:h1', status: { model: 'opus-5-5', context: { tokens: 900000, window: 1000000, pct: 90 } }, reportedAt: NOW })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'g2', status: { model: 'fable-5-1', context: { tokens: 1000, window: 1000000, pct: 1 }, stall: { kind: 'usage_limit', model: 'fable-5-1', resets_at: '2026-10-01T15:00:00Z' } }, reportedAt: NOW })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'g3', status: { model: 'x', context: { tokens: 9, window: 10, pct: 90 } }, reportedAt: NOW })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'coord', status: { model: 'x', context: { tokens: 9, window: 10, pct: 90 } }, reportedAt: NOW })
  upsertConvoStatus(db, { userId: dan.id, convoId: 'p1', status: { model: 'x', context: { tokens: 9, window: 10, pct: 90 } }, reportedAt: NOW })
  upsertDeviceStatus(db, { userId: dan.id, deviceId: gene.deviceId, status: { disk: { free_bytes: 15 * GB, total_bytes: 100 * GB } }, reportedAt: NOW })
  upsertDeviceStatus(db, { userId: dan.id, deviceId: mavis.deviceId, status: { disk: { free_bytes: 50 * GB, total_bytes: 100 * GB } }, reportedAt: NOW })
  upsertDeviceStatus(db, { userId: dan.id, deviceId: priv.deviceId, status: { disk: { free_bytes: 1 * GB, total_bytes: 100 * GB } }, reportedAt: NOW })
  const ctx = evaluateTrigger(db, dan.id, { kind: 'context_over', pct: 40 }, { now: NOW, coordinatorConvoId: 'coord', excludePrivateOwned: true })
  assert.deepEqual(ctx.map((s) => s.subject), ['convo:g1', 'convo:g4'])
  assert.equal(ctx[0].line, '- [Big session](matron://convo/g1) at 42% of its window (420k/1M, opus-5-5)')
  assert.equal(ctx[1].line, '- [Small window](matron://convo/g4) at 50% of its window (100k/200k, haiku-4-5)')
  // A private Coordinator box sees the private-owned session too; done sessions never count.
  assert.deepEqual(evaluateTrigger(db, dan.id, { kind: 'context_over', pct: 40 }, { now: NOW, coordinatorConvoId: 'coord', excludePrivateOwned: false }).map((s) => s.subject), ['convo:g1', 'convo:g4', 'convo:p1'])
  assert.deepEqual(evaluateTrigger(db, dan.id, { kind: 'context_over', pct: 43 }, { now: NOW, coordinatorConvoId: 'coord', excludePrivateOwned: true }).map((s) => s.subject), ['convo:g4'])
  // The window floor: 1M for the 1M-class models whatever the bridge reported, the report when it is larger, as reported otherwise.
  assert.equal(contextWindowOf('claude-opus-5-5', 200000), 1000000); assert.equal(contextWindowOf('opus', 200000), 1000000)
  assert.equal(contextWindowOf('fable-5-1', 2000000), 2000000); assert.equal(contextWindowOf('sonnet-5[1m]', 200000), 1000000)
  assert.equal(contextWindowOf('haiku-4-5', 200000), 200000); assert.equal(contextWindowOf('sonnet-5', 200000), 200000); assert.equal(contextWindowOf('x', undefined), 0)
  // stalled: reset at least reset_minutes away (5 h here), or no reset time at all.
  const st = evaluateTrigger(db, dan.id, { kind: 'stalled', reset_minutes: 120 }, { now: NOW, coordinatorConvoId: 'coord' })
  assert.deepEqual(st.map((s) => s.subject), ['convo:g2'])
  assert.equal(st[0].line, '- [Stalled one](matron://convo/g2) stalled on fable-5-1, resets 2026-10-01T15:00:00Z (in 5 h)')
  assert.deepEqual(evaluateTrigger(db, dan.id, { kind: 'stalled', reset_minutes: 400 }, { now: NOW, coordinatorConvoId: 'coord' }), [])
  upsertConvoStatus(db, { userId: dan.id, convoId: 'g2', status: { model: 'fable-5-1', stall: { kind: 'usage_limit' } }, reportedAt: NOW })
  assert.equal(evaluateTrigger(db, dan.id, { kind: 'stalled', reset_minutes: 400 }, { now: NOW, coordinatorConvoId: 'coord' })[0].line, '- [Stalled one](matron://convo/g2) stalled on fable-5-1, no reset time')
  // disk_under: agent boxes under the threshold; private boxes hidden from an ordinary Coordinator.
  const disk = evaluateTrigger(db, dan.id, { kind: 'disk_under', pct: 20 }, { now: NOW, excludePrivateOwned: true })
  assert.deepEqual(disk.map((s) => s.subject), [`device:${gene.deviceId}`])
  assert.equal(disk[0].line, '- gene: 15% free (15.0 GB of 100.0 GB)')
  assert.deepEqual(evaluateTrigger(db, dan.id, { kind: 'disk_under', pct: 20 }, { now: NOW, excludePrivateOwned: false }).map((s) => s.subject).sort(), [`device:${gene.deviceId}`, `device:${priv.deviceId}`].sort())
  // Words for the apps and the tools.
  assert.equal(describeTrigger({ kind: 'context_over', pct: 40 }), 'when a session passes 40% of its context window')
  assert.equal(describeTrigger({ kind: 'stalled', reset_minutes: 120 }), 'when a session stalls on a usage limit with no reset within 2 h')
  assert.equal(describeTrigger({ kind: 'stalled', reset_minutes: 0 }), 'when a session stalls on a usage limit')
  assert.equal(describeTrigger({ kind: 'disk_under', pct: 20 }), 'when a box drops under 20% free disk')
  assert.equal(trigMessage('Routine x: do it.', [{ line: '- a' }, { line: '- b' }]), 'Routine x: do it.\n\nTripped by:\n- a\n- b')
  // Under the message cap: lines that do not fit fold into "+N more"; a prompt that fills the cap goes alone.
  const many = Array.from({ length: 60 }, (_, i) => ({ line: `- [session ${i}](matron://convo/${'x'.repeat(36)}) at 99% of its window (opus-5-5)` }))
  const capped = trigMessage('Routine x: do it.', many)
  assert.ok(capped.length <= 2000)
  assert.match(capped, /\n\+\d+ more$/)
  assert.ok(capped.split('\n').length > 5)
  const full = 'p'.repeat(2000)
  assert.equal(trigMessage(full, many), full)
  assert.equal(trigMessage('p'.repeat(1990), many), 'p'.repeat(1990))
})

test('trippedSubjects: fires once per subject per crossing; cleared subjects re-fire when they cross again', async () => {
  const { db, dan } = await seedDb()
  const r = createRoutine(db, { userId: dan.id, origin: 'seed', fields: validateRoutineFields({ name: 'ctx', title: 'C', prompt: 'p', trigger: { kind: 'context_over', pct: 40 } }).value, now: NOW })
  const at = (pct) => upsertConvoStatus(db, { userId: dan.id, convoId: 'g1', status: { model: 'x', context: { tokens: pct, window: 100, pct } }, reportedAt: NOW })
  at(42)
  const first = trippedSubjects(db, r, { now: NOW, coordinatorConvoId: 'coord' })
  assert.deepEqual(first.fresh.map((s) => s.subject), ['convo:g1'])
  // Recorded as tripped: the next evaluation finds nothing new.
  assert.deepEqual(trippedSubjects(db, r, { now: NOW + 1, coordinatorConvoId: 'coord' }).fresh, [])
  // Falls back under: the record clears; crossing again fires again.
  at(10)
  assert.deepEqual(trippedSubjects(db, r, { now: NOW + 2, coordinatorConvoId: 'coord' }).fresh, [])
  at(45)
  assert.deepEqual(trippedSubjects(db, r, { now: NOW + 3, coordinatorConvoId: 'coord' }).fresh.map((s) => s.subject), ['convo:g1'])
  // Resting (inside its gap, record: false): cleared subjects are still forgotten; fresh ones are reported, not recorded.
  at(10); assert.deepEqual(trippedSubjects(db, r, { now: NOW + 4, coordinatorConvoId: 'coord', record: false }).fresh, [])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM routine_trigger_state WHERE routine_id=?').get(r.id).n, 0)
  at(42); assert.deepEqual(trippedSubjects(db, r, { now: NOW + 4, coordinatorConvoId: 'coord', record: false }).fresh.map((s) => s.subject), ['convo:g1'])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM routine_trigger_state WHERE routine_id=?').get(r.id).n, 0)
  // Paused between the sweep's listing and the evaluation: nothing is recorded or fired.
  at(10); trippedSubjects(db, r, { now: NOW + 4, coordinatorConvoId: 'coord' }); at(80)
  db.prepare('UPDATE routines SET enabled=0 WHERE id=?').run(r.id)
  assert.deepEqual(trippedSubjects(db, r, { now: NOW + 5, coordinatorConvoId: 'coord' }), { fresh: [], matching: [] })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM routine_trigger_state WHERE routine_id=?').get(r.id).n, 0)
  db.prepare('UPDATE routines SET enabled=1 WHERE id=?').run(r.id)
  // Deleting the routine removes its state (cascade).
  const { deleteRoutine } = await import('../src/routines.js')
  deleteRoutine(db, dan.id, r.id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM routine_trigger_state').get().n, 0)
})

test('no Coordinator when a trigger trips: the crossing is not consumed — it fires once a Coordinator is set', async (t) => {
  const s = await startTestServer({ sessionControlTimeoutMs: 2000, routinesSweepIntervalMs: 3600_000, routinesTriggerIntervalMs: 3600_000 })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const mavis = createAgent(s.db, dan.id, 'mavis')
  const gene = createAgent(s.db, dan.id, 'gene')
  upsertConversation(s.db, { id: 'coord', ownerUserId: dan.id, title: 'Coordinator', sessionState: 'waiting', agentDeviceId: mavis.deviceId })
  upsertConversation(s.db, { id: 'g1', ownerUserId: dan.id, title: 'Big', sessionState: 'running', agentDeviceId: gene.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const client = login.json.token
  const c = await s.http('/routines', { method: 'POST', token: client, body: { name: 'ctx', title: 'Ctx', prompt: 'p', trigger: { kind: 'context_over', pct: 40 } } })
  assert.equal(c.status, 201)
  upsertConvoStatus(s.db, { userId: dan.id, convoId: 'g1', status: { model: 'x', context: { tokens: 1, window: 2, pct: 61 } }, reportedAt: Date.now() })
  assert.deepEqual(await s.routinesSweep.runTriggers(Date.now()), { fired: 1 })
  const row = getRoutine(s.db, dan.id, 'ctx')
  assert.equal(row.last_outcome, 'no_coordinator')
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM routine_trigger_state').get().n, 0, 'the subject is forgotten, to re-trip')
  // Backed off: nothing for the next 15 minutes even though it still matches.
  assert.deepEqual(await s.routinesSweep.runTriggers(Date.now()), { fired: 0 })
  // A Coordinator appears; after the backoff the crossing fires for real.
  await s.http('/coordinator', { method: 'PUT', token: client, body: { convo_id: 'coord' } })
  const coord = await makeWsClient(s.base, { token: mavis.token, cursor: null })
  t.after(() => coord.close())
  await coord.waitFor((f) => f.op === 'hello_ok')
  const later = Date.now() + 16 * 60000
  const sweep = s.routinesSweep.runTriggers(later)
  const req = await coord.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control' && f.request.params.name === 'ctx')
  coord.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  assert.deepEqual(await sweep, { fired: 1 })
  assert.equal(getRoutine(s.db, dan.id, 'ctx').last_outcome, 'applied now')
})

test('seedRoutines: the starter set includes the three trigger routines', async () => {
  const { db, dan } = await seedDb()
  db.prepare('UPDATE user_settings SET routines_seeded_at=NULL WHERE user_id=?').run(dan.id)
  assert.equal(seedRoutines(db, dan.id, NOW), STARTER_ROUTINES.length)
  const byName = Object.fromEntries(listRoutines(db, dan.id).map((r) => [r.name, r]))
  assert.deepEqual(byName['context-over'].trigger, { kind: 'context_over', pct: 40 })
  assert.deepEqual(byName['stalled-session'].trigger, { kind: 'stalled', reset_minutes: 120 })
  assert.deepEqual(byName['disk-low'].trigger, { kind: 'disk_under', pct: 20 })
  for (const n of ['context-over', 'stalled-session', 'disk-low']) {
    assert.equal(byName[n].schedule, null); assert.equal(byName[n].next_at, null)
    assert.match(byName[n].prompt, new RegExp(`^Routine ${n}: `))
  }
  void getRoutine
})

test('the trigger sweep fires a tripped routine into the Coordinator with the specifics, once; run includes the current subjects', async (t) => {
  const s = await startTestServer({ sessionControlTimeoutMs: 2000, routinesSweepIntervalMs: 3600_000, routinesTriggerIntervalMs: 3600_000 })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const mavis = createAgent(s.db, dan.id, 'mavis')
  const gene = createAgent(s.db, dan.id, 'gene')
  upsertConversation(s.db, { id: 'coord', ownerUserId: dan.id, title: 'Coordinator', sessionState: 'waiting', agentDeviceId: mavis.deviceId })
  upsertConversation(s.db, { id: 'g1', ownerUserId: dan.id, title: 'Big', sessionState: 'running', agentDeviceId: gene.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const client = login.json.token
  // Choosing the Coordinator seeds the starter set, trigger routines included.
  await s.http('/coordinator', { method: 'PUT', token: client, body: { convo_id: 'coord' } })
  const coord = await makeWsClient(s.base, { token: mavis.token, cursor: null })
  t.after(() => coord.close())
  await coord.waitFor((f) => f.op === 'hello_ok')
  // Nothing tripped: no fire.
  assert.deepEqual(await s.routinesSweep.runTriggers(Date.now()), { fired: 0 })
  upsertConvoStatus(s.db, { userId: dan.id, convoId: 'g1', status: { model: 'opus-5-5', context: { tokens: 610000, window: 1000000, pct: 61 } }, reportedAt: Date.now() })
  const sweep = s.routinesSweep.runTriggers(Date.now())
  const req = await coord.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control')
  assert.equal(req.request.params.name, 'context-over')
  assert.equal(req.request.params.message, 'Routine context-over: follow the Session context over the threshold section of your playbook.\n\nTripped by:\n- [Big](matron://convo/g1) at 61% of its window (610k/1M, opus-5-5)')
  coord.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  assert.deepEqual(await sweep, { fired: 1 })
  const row = getRoutine(s.db, dan.id, 'context-over')
  assert.equal(row.last_outcome, 'applied now'); assert.ok(row.last_fired_at > 0); assert.equal(row.next_at, null)
  // Still tripped: no second fire.
  assert.deepEqual(await s.routinesSweep.runTriggers(Date.now()), { fired: 0 })
  // Inside the 15-minute gap: a second session crossing waits for the gap, and the first one clearing (compacted)
  // is forgotten even while the routine rests, so its climbing back counts as a new crossing. One fire then carries both.
  upsertConversation(s.db, { id: 'g2', ownerUserId: dan.id, title: 'Second', sessionState: 'running', agentDeviceId: gene.deviceId })
  upsertConvoStatus(s.db, { userId: dan.id, convoId: 'g2', status: { model: 'opus-5-5', context: { tokens: 500000, window: 1000000, pct: 50 } }, reportedAt: Date.now() })
  upsertConvoStatus(s.db, { userId: dan.id, convoId: 'g1', status: { model: 'opus-5-5', context: { tokens: 40000, window: 1000000, pct: 4 } }, reportedAt: Date.now() })
  assert.deepEqual(await s.routinesSweep.runTriggers(Date.now()), { fired: 0 })
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM routine_trigger_state').get().n, 0, 'the cleared subject is forgotten during the gap; the new one is not recorded yet')
  upsertConvoStatus(s.db, { userId: dan.id, convoId: 'g1', status: { model: 'opus-5-5', context: { tokens: 580000, window: 1000000, pct: 58 } }, reportedAt: Date.now() })
  assert.deepEqual(await s.routinesSweep.runTriggers(Date.now()), { fired: 0 })
  const sweepB = s.routinesSweep.runTriggers(Date.now() + 16 * 60000)
  const reqB = await coord.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control' && String(f.request.params.message).includes('[Second]'))
  assert.equal(reqB.request.params.message, 'Routine context-over: follow the Session context over the threshold section of your playbook.\n\nTripped by:\n- [Big](matron://convo/g1) at 58% of its window (580k/1M, opus-5-5)\n- [Second](matron://convo/g2) at 50% of its window (500k/1M, opus-5-5)')
  coord.send({ op: 'agent_response', request_id: reqB.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  assert.deepEqual(await sweepB, { fired: 1 })
  // A paused trigger routine never fires.
  await s.http('/routines/context-over', { method: 'PATCH', token: client, body: { enabled: false } })
  upsertConvoStatus(s.db, { userId: dan.id, convoId: 'g1', status: { model: 'opus-5-5', context: { tokens: 50000, window: 1000000, pct: 5 } }, reportedAt: Date.now() })
  upsertConvoStatus(s.db, { userId: dan.id, convoId: 'g1', status: { model: 'opus-5-5', context: { tokens: 700000, window: 1000000, pct: 70 } }, reportedAt: Date.now() })
  assert.deepEqual(await s.routinesSweep.runTriggers(Date.now()), { fired: 0 })
  // run: fires now with whatever is tripped at that moment, state untouched.
  const r = await s.http('/routines/context-over/run', { method: 'POST', token: client })
  assert.equal(r.status, 202)
  const req2 = await coord.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control' && String(f.request.params.message).includes('at 70%'))
  assert.match(req2.request.params.message, /Tripped by:\n- \[Big\]\(matron:\/\/convo\/g1\) at 70% of its window/)
  coord.send({ op: 'agent_response', request_id: req2.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  // The wire shape carries trigger and a null schedule.
  const list = await s.http('/routines', { token: client })
  const ctx = list.json.routines.find((x) => x.name === 'context-over')
  assert.deepEqual(ctx.trigger, { kind: 'context_over', pct: 40 }); assert.equal(ctx.schedule, null)
  // POST with a trigger from the client; PATCH the threshold.
  const c = await s.http('/routines', { method: 'POST', token: client, body: { name: 'ctx2', title: 'Ctx 2', prompt: 'p', trigger: { kind: 'context_over', pct: 70 } } })
  assert.equal(c.status, 201); assert.deepEqual(c.json.routine.trigger, { kind: 'context_over', pct: 70 })
  const p = await s.http('/routines/ctx2', { method: 'PATCH', token: client, body: { trigger: { kind: 'context_over', pct: 75 } } })
  assert.equal(p.status, 200); assert.deepEqual(p.json.routine.trigger, { kind: 'context_over', pct: 75 })
  assert.equal((await s.http('/routines/ctx2', { method: 'PATCH', token: client, body: { schedule: '5 7 * * *' } })).status, 400, 'a triggered routine cannot be given a schedule')
})
