import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, upsertDeviceStatus, pinDevicePrivate } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { upsertConversation } from '../src/journal.js'
import { upsertConvoStatus } from '../src/convo-status.js'
import { validateRoutineFields, createRoutine, getRoutine, seedRoutines, listRoutines, STARTER_ROUTINES, TRIGGER_KINDS } from '../src/routines.js'
import { evaluateTrigger, trippedSubjects, trigMessage, fireMessage, describeTrigger, allowanceMet, contextWindowOf, isCodexModel, spareBacklog } from '../src/routines-triggers.js'
import { createItem } from '../src/items.js'
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
  const alice = await createUser(db, 'alice', 'pw')
  const maple = createAgent(db, alice.id, 'maple')
  const jade = createAgent(db, alice.id, 'jade')
  const priv = createAgent(db, alice.id, 'priv-box')
  pinDevicePrivate(db, priv.deviceId, true)
  upsertConversation(db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator', sessionState: 'waiting', agentDeviceId: maple.deviceId })
  upsertConversation(db, { id: 'g1', ownerUserId: alice.id, title: 'Big [session]', sessionState: 'running', agentDeviceId: jade.deviceId })
  upsertConversation(db, { id: 'g2', ownerUserId: alice.id, title: 'Stalled one', sessionState: 'waiting', agentDeviceId: jade.deviceId })
  upsertConversation(db, { id: 'g3', ownerUserId: alice.id, title: 'Finished', sessionState: 'done', agentDeviceId: jade.deviceId })
  upsertConversation(db, { id: 'p1', ownerUserId: alice.id, title: 'Private big', sessionState: 'running', agentDeviceId: priv.deviceId })
  upsertConversation(db, { id: 'g4', ownerUserId: alice.id, title: 'Small window', sessionState: 'running', agentDeviceId: jade.deviceId })
  upsertConversation(db, { id: 'g5', ownerUserId: alice.id, title: 'Opus on an old bridge', sessionState: 'running', agentDeviceId: jade.deviceId })
  upsertConversation(db, { id: 'g1:sub:h1', ownerUserId: alice.id, title: 'Helper', sessionState: 'running', agentDeviceId: jade.deviceId, parentConvoId: 'g1' })
  upsertConversation(db, { id: 'g6', ownerUserId: alice.id, title: 'Codex one', sessionState: 'running', agentDeviceId: jade.deviceId })
  setCoordinatorConvoId(db, alice.id, 'coord')
  return { db, alice, maple, jade, priv }
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
  assert.deepEqual(TRIGGER_KINDS, ['context_over', 'stalled', 'disk_under', 'allowance_expiring'])
  // PATCH: a trigger may change; schedule and trigger cannot both be given.
  assert.deepEqual(validateRoutineFields({ trigger: { kind: 'context_over', pct: 50 } }, { partial: true }).value, { trigger: { kind: 'context_over', pct: 50 } })
  assert.equal(validateRoutineFields({ trigger: { kind: 'context_over', pct: 50 }, schedule: '5 7 * * *' }, { partial: true }).ok, false)
})

test('createRoutine with a trigger: no next_at, trigger on the row; a PATCH cannot turn one kind of routine into the other', async () => {
  const { db, alice } = await seedDb()
  const r = createRoutine(db, { userId: alice.id, origin: 'user', fields: validateRoutineFields({ name: 'ctx', title: 'C', prompt: 'p', trigger: { kind: 'context_over', pct: 40 } }).value, now: NOW })
  assert.equal(r.schedule, null); assert.equal(r.next_at, null); assert.deepEqual(r.trigger, { kind: 'context_over', pct: 40 })
  const { updateRoutine } = await import('../src/routines.js')
  assert.throws(() => updateRoutine(db, { userId: alice.id, key: 'ctx', fields: { schedule: '5 7 * * *' }, now: NOW }), /mixed/)
  const u = updateRoutine(db, { userId: alice.id, key: 'ctx', fields: { trigger: { kind: 'context_over', pct: 55 } }, now: NOW })
  assert.deepEqual(u.trigger, { kind: 'context_over', pct: 55 })
  const s = createRoutine(db, { userId: alice.id, origin: 'user', fields: validateRoutineFields({ name: 'sch', title: 'S', prompt: 'p', schedule: '5 7 * * *' }).value, now: NOW })
  assert.equal(s.trigger, null)
  assert.throws(() => updateRoutine(db, { userId: alice.id, key: 'sch', fields: { trigger: { kind: 'disk_under', pct: 20 } }, now: NOW }), /mixed/)
})

test('evaluateTrigger: context_over, stalled, disk_under — live sessions only, the Coordinator for context_over only (marked as itself), private-owned hidden from an ordinary Coordinator box', async () => {
  const { db, alice, maple, jade, priv } = await seedDb()
  upsertConvoStatus(db, { userId: alice.id, convoId: 'g1', status: { model: 'opus-5-5', context: { tokens: 420000, window: 1000000, pct: 42 } }, reportedAt: NOW })
  // A 200k-window model at 50% trips; an Opus session whose bridge reports 200k is measured against 1M (10%) and does not;
  // a helper inside g1 never counts, however full.
  upsertConvoStatus(db, { userId: alice.id, convoId: 'g4', status: { model: 'haiku-4-5', context: { tokens: 100000, window: 200000, pct: 50 } }, reportedAt: NOW })
  upsertConvoStatus(db, { userId: alice.id, convoId: 'g5', status: { model: 'claude-opus-5-5', context: { tokens: 100000, window: 200000, pct: 50 } }, reportedAt: NOW })
  upsertConvoStatus(db, { userId: alice.id, convoId: 'g1:sub:h1', status: { model: 'opus-5-5', context: { tokens: 900000, window: 1000000, pct: 90 } }, reportedAt: NOW })
  // A Codex session compacts itself: never a subject, however full.
  upsertConvoStatus(db, { userId: alice.id, convoId: 'g6', status: { model: 'gpt-6-astra', context: { tokens: 207000, window: 258000, pct: 80 } }, reportedAt: NOW })
  upsertConvoStatus(db, { userId: alice.id, convoId: 'g2', status: { model: 'fable-5-1', context: { tokens: 1000, window: 1000000, pct: 1 }, stall: { kind: 'usage_limit', model: 'fable-5-1', resets_at: '2026-10-01T15:00:00Z' } }, reportedAt: NOW })
  upsertConvoStatus(db, { userId: alice.id, convoId: 'g3', status: { model: 'x', context: { tokens: 9, window: 10, pct: 90 } }, reportedAt: NOW })
  upsertConvoStatus(db, { userId: alice.id, convoId: 'coord', status: { model: 'x', context: { tokens: 9, window: 10, pct: 90 } }, reportedAt: NOW })
  upsertConvoStatus(db, { userId: alice.id, convoId: 'p1', status: { model: 'x', context: { tokens: 9, window: 10, pct: 90 } }, reportedAt: NOW })
  upsertDeviceStatus(db, { userId: alice.id, deviceId: jade.deviceId, status: { disk: { free_bytes: 15 * GB, total_bytes: 100 * GB } }, reportedAt: NOW })
  upsertDeviceStatus(db, { userId: alice.id, deviceId: maple.deviceId, status: { disk: { free_bytes: 50 * GB, total_bytes: 100 * GB } }, reportedAt: NOW })
  upsertDeviceStatus(db, { userId: alice.id, deviceId: priv.deviceId, status: { disk: { free_bytes: 1 * GB, total_bytes: 100 * GB } }, reportedAt: NOW })
  const ctx = evaluateTrigger(db, alice.id, { kind: 'context_over', pct: 40 }, { now: NOW, coordinatorConvoId: 'coord', excludePrivateOwned: true })
  assert.deepEqual(ctx.map((s) => s.subject), ['convo:coord', 'convo:g1', 'convo:g4'])
  // The Coordinator compacts itself (Alice, 8 Oct 2026), so it is listed, told that the line is itself.
  assert.equal(ctx[0].line, '- [Coordinator](matron://convo/coord) at 90% of its window (0k/0k, x) — this is you: compact yourself with compact_self')
  assert.equal(ctx[1].line, '- [Big session](matron://convo/g1) at 42% of its window (420k/1M, opus-5-5)')
  assert.equal(ctx[2].line, '- [Small window](matron://convo/g4) at 50% of its window (100k/200k, haiku-4-5)')
  // A private Coordinator box sees the private-owned session too; done sessions never count.
  assert.deepEqual(evaluateTrigger(db, alice.id, { kind: 'context_over', pct: 40 }, { now: NOW, coordinatorConvoId: 'coord', excludePrivateOwned: false }).map((s) => s.subject), ['convo:coord', 'convo:g1', 'convo:g4', 'convo:p1'])
  assert.deepEqual(evaluateTrigger(db, alice.id, { kind: 'context_over', pct: 43 }, { now: NOW, coordinatorConvoId: 'coord', excludePrivateOwned: true }).map((s) => s.subject), ['convo:coord', 'convo:g4'])
  // The window floor: 1M for the 1M-class models whatever the bridge reported, the report when it is larger, as reported otherwise.
  assert.equal(contextWindowOf('claude-opus-5-5', 200000), 1000000); assert.equal(contextWindowOf('opus', 200000), 1000000)
  assert.equal(contextWindowOf('fable-5-1', 2000000), 2000000); assert.equal(contextWindowOf('sonnet-5[1m]', 200000), 1000000)
  assert.equal(contextWindowOf('haiku-4-5', 200000), 200000); assert.equal(contextWindowOf('sonnet-5', 200000), 200000); assert.equal(contextWindowOf('x', undefined), 0)
  // Codex model names, as the Codex bridge publishes them; Claude names and nothing else.
  for (const m of ['gpt-6-astra', 'gpt-5.1-codex', 'GPT-5', 'o3', 'o4-mini', 'codex-mini-latest']) assert.equal(isCodexModel(m), true, m)
  for (const m of ['claude-opus-5-5', 'opus', 'fable-5-1', 'haiku-4-5', '', undefined, 'gpto']) assert.equal(isCodexModel(m), false, String(m))
  assert.deepEqual(evaluateTrigger(db, alice.id, { kind: 'context_over', pct: 1 }, { now: NOW, coordinatorConvoId: 'coord', excludePrivateOwned: true }).map((s) => s.subject), ['convo:coord', 'convo:g1', 'convo:g4', 'convo:g5'], 'Codex never, even at 1%')
  // Nor a Codex Coordinator: Codex compacts itself.
  upsertConvoStatus(db, { userId: alice.id, convoId: 'coord', status: { model: 'gpt-6-astra', context: { tokens: 250000, window: 258000, pct: 97 } }, reportedAt: NOW })
  assert.deepEqual(evaluateTrigger(db, alice.id, { kind: 'context_over', pct: 40 }, { now: NOW, coordinatorConvoId: 'coord', excludePrivateOwned: true }).map((s) => s.subject), ['convo:g1', 'convo:g4'])
  // A stalled Coordinator is never a stalled subject: it cannot take the turn the fire would start.
  upsertConvoStatus(db, { userId: alice.id, convoId: 'coord', status: { model: 'fable-5-1', stall: { kind: 'usage_limit' } }, reportedAt: NOW })
  // stalled: reset at least reset_minutes away (5 h here), or no reset time at all.
  const st = evaluateTrigger(db, alice.id, { kind: 'stalled', reset_minutes: 120 }, { now: NOW, coordinatorConvoId: 'coord' })
  assert.deepEqual(st.map((s) => s.subject), ['convo:g2'])
  assert.equal(st[0].line, '- [Stalled one](matron://convo/g2) stalled on fable-5-1, resets 2026-10-01T15:00:00Z (in 5 h)')
  assert.deepEqual(evaluateTrigger(db, alice.id, { kind: 'stalled', reset_minutes: 400 }, { now: NOW, coordinatorConvoId: 'coord' }), [])
  upsertConvoStatus(db, { userId: alice.id, convoId: 'g2', status: { model: 'fable-5-1', stall: { kind: 'usage_limit' } }, reportedAt: NOW })
  assert.equal(evaluateTrigger(db, alice.id, { kind: 'stalled', reset_minutes: 400 }, { now: NOW, coordinatorConvoId: 'coord' })[0].line, '- [Stalled one](matron://convo/g2) stalled on fable-5-1, no reset time')
  // disk_under: agent boxes under the threshold; private boxes hidden from an ordinary Coordinator.
  const disk = evaluateTrigger(db, alice.id, { kind: 'disk_under', pct: 20 }, { now: NOW, excludePrivateOwned: true })
  assert.deepEqual(disk.map((s) => s.subject), [`device:${jade.deviceId}`])
  assert.equal(disk[0].line, '- jade: 15% free (15.0 GB of 100.0 GB)')
  assert.deepEqual(evaluateTrigger(db, alice.id, { kind: 'disk_under', pct: 20 }, { now: NOW, excludePrivateOwned: false }).map((s) => s.subject).sort(), [`device:${jade.deviceId}`, `device:${priv.deviceId}`].sort())
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
  const { db, alice } = await seedDb()
  const r = createRoutine(db, { userId: alice.id, origin: 'seed', fields: validateRoutineFields({ name: 'ctx', title: 'C', prompt: 'p', trigger: { kind: 'context_over', pct: 40 } }).value, now: NOW })
  const at = (pct) => upsertConvoStatus(db, { userId: alice.id, convoId: 'g1', status: { model: 'x', context: { tokens: pct, window: 100, pct } }, reportedAt: NOW })
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
  deleteRoutine(db, alice.id, r.id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM routine_trigger_state').get().n, 0)
})

test('no Coordinator when a trigger trips: the crossing is not consumed — it fires once a Coordinator is set', async (t) => {
  const s = await startTestServer({ sessionControlTimeoutMs: 2000, routinesSweepIntervalMs: 3600_000, routinesTriggerIntervalMs: 3600_000 })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const maple = createAgent(s.db, alice.id, 'maple')
  const jade = createAgent(s.db, alice.id, 'jade')
  upsertConversation(s.db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator', sessionState: 'waiting', agentDeviceId: maple.deviceId })
  upsertConversation(s.db, { id: 'g1', ownerUserId: alice.id, title: 'Big', sessionState: 'running', agentDeviceId: jade.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  const client = login.json.token
  const c = await s.http('/routines', { method: 'POST', token: client, body: { name: 'ctx', title: 'Ctx', prompt: 'p', trigger: { kind: 'context_over', pct: 40 } } })
  assert.equal(c.status, 201)
  upsertConvoStatus(s.db, { userId: alice.id, convoId: 'g1', status: { model: 'x', context: { tokens: 1, window: 2, pct: 61 } }, reportedAt: Date.now() })
  assert.deepEqual(await s.routinesSweep.runTriggers(Date.now()), { fired: 1 })
  const row = getRoutine(s.db, alice.id, 'ctx')
  assert.equal(row.last_outcome, 'no_coordinator')
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM routine_trigger_state').get().n, 0, 'the subject is forgotten, to re-trip')
  // Backed off: nothing for the next 15 minutes even though it still matches.
  assert.deepEqual(await s.routinesSweep.runTriggers(Date.now()), { fired: 0 })
  // A Coordinator appears; after the backoff the crossing fires for real.
  await s.http('/coordinator', { method: 'PUT', token: client, body: { convo_id: 'coord' } })
  const coord = await makeWsClient(s.base, { token: maple.token, cursor: null })
  t.after(() => coord.close())
  await coord.waitFor((f) => f.op === 'hello_ok')
  const later = Date.now() + 16 * 60000
  const sweep = s.routinesSweep.runTriggers(later)
  const req = await coord.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control' && f.request.params.name === 'ctx')
  coord.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  assert.deepEqual(await sweep, { fired: 1 })
  assert.equal(getRoutine(s.db, alice.id, 'ctx').last_outcome, 'applied now')
})

test('validateTrigger: allowance_expiring takes a percent and an optional 6–12 h window', () => {
  const base = { name: 'spare', title: 'Spare', prompt: 'p' }
  const v = (trigger) => validateRoutineFields({ ...base, trigger })
  assert.deepEqual(v({ kind: 'allowance_expiring', pct: 70 }).value.trigger, { kind: 'allowance_expiring', pct: 70, from_hours: 6, to_hours: 12 })
  assert.deepEqual(v({ kind: 'allowance_expiring', pct: 50, from_hours: 0, to_hours: 24 }).value.trigger, { kind: 'allowance_expiring', pct: 50, from_hours: 0, to_hours: 24 })
  for (const bad of [{ kind: 'allowance_expiring' }, { kind: 'allowance_expiring', pct: 100 }, { kind: 'allowance_expiring', pct: 70, from_hours: 12, to_hours: 12 },
    { kind: 'allowance_expiring', pct: 70, to_hours: 169 }, { kind: 'allowance_expiring', pct: 70, from_hours: -1 }, { kind: 'allowance_expiring', pct: 70, reset_minutes: 5 }]) {
    assert.equal(v(bad).ok, false, JSON.stringify(bad))
  }
  assert.equal(describeTrigger({ kind: 'allowance_expiring', pct: 70, from_hours: 6, to_hours: 12 }), 'when a weekly limit resets within 6–12 h and is under 70%')
})

test('validateTrigger: allowance_expiring takes 1–4 tiers of unused percent and hours left', () => {
  const base = { name: 'spare', title: 'Spare', prompt: 'p' }
  const v = (trigger) => validateRoutineFields({ ...base, trigger })
  const tiers = [{ unused_pct: 50, hours_left: 12 }, { unused_pct: 25, hours_left: 2 }]
  assert.deepEqual(v({ kind: 'allowance_expiring', tiers }).value.trigger, { kind: 'allowance_expiring', tiers })
  const t = (x) => ({ kind: 'allowance_expiring', tiers: [x] })
  for (const bad of [{ kind: 'allowance_expiring', tiers: [] }, { kind: 'allowance_expiring', tiers: 'x' }, { kind: 'allowance_expiring', tiers, pct: 70 },
    { kind: 'allowance_expiring', tiers, from_hours: 6 }, { kind: 'allowance_expiring', tiers: Array(5).fill(tiers[0]) },
    t({ unused_pct: 0, hours_left: 2 }), t({ unused_pct: 100, hours_left: 2 }), t({ unused_pct: 50, hours_left: 0 }), t({ unused_pct: 50, hours_left: 169 }),
    t({ unused_pct: 50.5, hours_left: 2 }), t({ unused_pct: 50 }), t({ unused_pct: 50, hours_left: 2, pct: 3 }), t(null), t([50, 2])]) {
    assert.equal(v(bad).ok, false, JSON.stringify(bad))
  }
  assert.equal(describeTrigger({ kind: 'allowance_expiring', tiers }), 'when a weekly limit has 50% unused with 12 h left or 25% unused with 2 h left')
})

test('allowance_expiring tiers: any tier met fires; the legacy band is unchanged', () => {
  const H = 3600000
  const tiers = [{ unused_pct: 50, hours_left: 12 }, { unused_pct: 25, hours_left: 2 }]
  const trig = { kind: 'allowance_expiring', tiers }
  // [percent used, hours to reset, fires?]
  for (const [pct, h, want] of [[40, 11, true], [50, 12, true], [51, 11, false], [40, 13, false], [70, 2, true], [75, 1, true], [76, 1, false], [70, 3, false], [10, 0.1, true]]) {
    assert.equal(allowanceMet(trig, pct, h * H), want, `${pct}% used, ${h} h left`)
  }
  assert.equal(allowanceMet({ kind: 'allowance_expiring', pct: 70, from_hours: 6, to_hours: 12 }, 40, 3 * H), false, 'the legacy band keeps its lower bound')
})

test('allowance_expiring tiers: a window that drops between tiers does not fire again at the later tier', async () => {
  const { db, alice, maple } = await seedDb()
  const H = 3600000
  const reset = Math.round((NOW + 12 * H) / H) * H
  const report = (percent, at) => upsertDeviceStatus(db, { userId: alice.id, deviceId: maple.deviceId, status: { limits: { as_of: at, lines: [{ id: 'week_all', label: 'Week (all models)', percent, resets_at: new Date(reset).toISOString() }] }, account: { email: 'shared@example.com' } }, reportedAt: at })
  createRoutine(db, { userId: alice.id, origin: 'seed', fields: validateRoutineFields({ name: 'spare', title: 'S', prompt: 'p', trigger: { kind: 'allowance_expiring', tiers: [{ unused_pct: 50, hours_left: 12 }, { unused_pct: 25, hours_left: 2 }] } }).value, now: NOW })
  createItem(db, { userId: alice.id, originDeviceId: maple.deviceId, originConvoId: 'coord', createdBy: 'agent', kind: 'task', title: 'Backlog task', labels: ['spare-allowance'] })
  const routine = getRoutine(db, alice.id, 'spare')
  report(40, NOW)
  assert.equal(trippedSubjects(db, routine, { now: NOW, excludePrivateOwned: true }).fresh.length, 1, 'tier 1 fires')
  report(60, NOW + 5 * H)
  assert.equal(trippedSubjects(db, routine, { now: NOW + 5 * H, excludePrivateOwned: true }).matching.length, 0, 'between tiers')
  report(70, NOW + 10.5 * H)
  assert.equal(trippedSubjects(db, routine, { now: NOW + 10.5 * H, excludePrivateOwned: true }).fresh.length, 0, 'tier 2 is the same window')
  // The next window is a new subject once this one has reset.
  report(10, NOW + 14 * H)
  trippedSubjects(db, routine, { now: NOW + 14 * H, excludePrivateOwned: true })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM routine_trigger_state WHERE routine_id=?').get(routine.id).n, 0, 'forgotten after the reset')
})

test('allowance_expiring: grouped by account, fires once per weekly window, only while the backlog has an undispatched task', async () => {
  const { db, alice, maple, jade, priv } = await seedDb()
  const oak = createAgent(db, alice.id, 'oak')
  const lone = createAgent(db, alice.id, 'lone')
  const iso = (ms) => new Date(ms).toISOString()
  const H = 3600000
  const report = (dev, lines, { email = 'shared@example.com', asOf = NOW } = {}) => upsertDeviceStatus(db, { userId: alice.id, deviceId: dev.deviceId, status: { limits: { as_of: asOf, lines }, ...(email ? { account: { email } } : {}) }, reportedAt: asOf })
  const week = (percent, resetAt) => ({ id: 'week_all', label: 'Week (all models)', percent, resets_at: iso(resetAt) })
  // maple and jade share an account; jade's older report reads low, maple's fresh one is the truth for %.
  report(maple, [{ id: 'session', label: 'Session', percent: 90, resets_at: iso(NOW + H) }, week(40, NOW + 9 * H)])
  report(jade, [week(20, NOW + 9 * H)], { asOf: NOW - 6 * H })
  // oak: its own account, too full. lone: no account, reset too far. priv: private box.
  report(oak, [week(85, NOW + 8 * H)], { email: 'other@example.com' })
  report(lone, [week(10, NOW + 30 * H), { id: 'codex:codex:secondary', label: 'Codex · Weekly', percent: 5, resets_at: iso(NOW + 7 * H) }], { email: null })
  report(priv, [week(10, NOW + 7 * H)], { email: 'private@example.com' })
  const trig = { kind: 'allowance_expiring', pct: 70, from_hours: 6, to_hours: 12 }
  const subjects = evaluateTrigger(db, alice.id, trig, { now: NOW, excludePrivateOwned: true })
  assert.deepEqual(subjects.map((s) => s.subject), [
    `allowance:account:shared@example.com@${iso(NOW + 9 * H)}`,
    `allowance:device:${lone.deviceId}:codex:codex:secondary@${iso(NOW + 7 * H)}`,
  ])
  assert.match(subjects[0].line, /Week \(all models\) at 40%, resets .* \(in 9 h\); boxes: jade, maple$/)
  assert.equal(evaluateTrigger(db, alice.id, trig, { now: NOW, excludePrivateOwned: false }).length, 3, 'a private box counts for a private Coordinator')
  // A reset already passed is no evidence.
  assert.equal(evaluateTrigger(db, alice.id, trig, { now: NOW + 10 * H, excludePrivateOwned: true }).length, 0)

  const r = createRoutine(db, { userId: alice.id, origin: 'seed', fields: validateRoutineFields({ name: 'spare', title: 'S', prompt: 'p', trigger: { kind: 'allowance_expiring', pct: 70 } }).value, now: NOW })
  const view = { coordinatorConvoId: 'coord', excludePrivateOwned: true }
  // Empty backlog: matching, but nothing fires and nothing is consumed.
  assert.deepEqual(trippedSubjects(db, r, { now: NOW, ...view }).fresh, [])
  const mk = (title, labels) => createItem(db, { userId: alice.id, originDeviceId: maple.deviceId, originConvoId: 'coord', createdBy: 'agent', kind: 'task', title, labels }).item
  const audit = mk('Flaky-test hunt: storefront suite', ['spare-allowance'])
  mk('Unrelated task', [])
  mk('Already running', ['spare-allowance', 'dispatched'])
  assert.deepEqual(spareBacklog(db, alice.id).map((t) => t.title), ['Flaky-test hunt: storefront suite'])
  const first = trippedSubjects(db, r, { now: NOW + 1, ...view })
  assert.equal(first.fresh.length, 2)
  // Once per window: still matching later in the window, nothing new.
  assert.deepEqual(trippedSubjects(db, r, { now: NOW + H, ...view }).fresh, [])
  // A box on the account reporting the same reset a minute early is the same window.
  report(jade, [week(25, NOW + 9 * H - 60000)], { asOf: NOW + 2 * H })
  assert.deepEqual(trippedSubjects(db, r, { now: NOW + 2 * H, ...view }).fresh, [])
  // The next week's window is a new subject.
  report(maple, [week(30, NOW + (7 * 24 + 9) * H)], { asOf: NOW + 7 * 24 * H })
  report(jade, [week(30, NOW + (7 * 24 + 9) * H)], { asOf: NOW + 7 * 24 * H })
  assert.deepEqual(trippedSubjects(db, r, { now: NOW + 7 * 24 * H, ...view }).fresh.map((s) => s.subject), [`allowance:account:shared@example.com@${iso(NOW + (7 * 24 + 9) * H)}`])

  // The turn names the head of the backlog.
  const msg = fireMessage(db, r, first.fresh)
  assert.match(msg, /^p\n\nTripped by:\n- Week/)
  assert.match(msg, new RegExp(`Next in the spare-allowance backlog:\n- #${audit.num} Flaky-test hunt: storefront suite$`))
  assert.equal(fireMessage(db, { ...r, trigger: { kind: 'disk_under', pct: 20 } }, first.fresh), trigMessage('p', first.fresh))
  assert.ok(fireMessage(db, r, first.fresh, 120).length <= 120)
  // Only part of the backlog fits: the head is kept.
  mk('Second backlog task', ['spare-allowance'])
  const tight = fireMessage(db, r, first.fresh, msg.length + 5)
  assert.match(tight, new RegExp(`Next in the spare-allowance backlog:\\n- #${audit.num} [^\\n]+$`))
  // A task filed from a private box's conversation is invisible to an ordinary Coordinator.
  upsertConversation(db, { id: 'p-task', ownerUserId: alice.id, title: 'Private', sessionState: 'running', agentDeviceId: priv.deviceId })
  createItem(db, { userId: alice.id, originDeviceId: priv.deviceId, originConvoId: 'p-task', createdBy: 'agent', kind: 'task', title: 'Private backlog task', labels: ['spare-allowance'], position: 'top' })
  assert.equal(spareBacklog(db, alice.id, { excludePrivateOwned: true }).some((t) => t.title === 'Private backlog task'), false)
  assert.equal(spareBacklog(db, alice.id).some((t) => t.title === 'Private backlog task'), true)

})

test('seedRoutines: the starter set includes the three trigger routines', async () => {
  const { db, alice } = await seedDb()
  db.prepare('UPDATE user_settings SET routines_seeded_at=NULL WHERE user_id=?').run(alice.id)
  assert.equal(seedRoutines(db, alice.id, NOW), STARTER_ROUTINES.length)
  const byName = Object.fromEntries(listRoutines(db, alice.id).map((r) => [r.name, r]))
  assert.deepEqual(byName['context-over'].trigger, { kind: 'context_over', pct: 40 })
  assert.deepEqual(byName['stalled-session'].trigger, { kind: 'stalled', reset_minutes: 120 })
  assert.deepEqual(byName['disk-low'].trigger, { kind: 'disk_under', pct: 20 })
  assert.deepEqual(byName['spare-allowance'].trigger, { kind: 'allowance_expiring', tiers: [{ unused_pct: 50, hours_left: 12 }, { unused_pct: 25, hours_left: 2 }] })
  assert.deepEqual(byName['spare-allowance'].envelope, { spawns_per_fire: 2, chats: false, boxes: null })
  for (const n of ['context-over', 'stalled-session', 'disk-low', 'spare-allowance']) {
    assert.equal(byName[n].schedule, null); assert.equal(byName[n].next_at, null)
    assert.match(byName[n].prompt, new RegExp(`^Routine ${n}: `))
  }
  void getRoutine
})

test('the trigger sweep fires a tripped routine into the Coordinator with the specifics, once; run includes the current subjects', async (t) => {
  const s = await startTestServer({ sessionControlTimeoutMs: 2000, routinesSweepIntervalMs: 3600_000, routinesTriggerIntervalMs: 3600_000 })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const maple = createAgent(s.db, alice.id, 'maple')
  const jade = createAgent(s.db, alice.id, 'jade')
  upsertConversation(s.db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator', sessionState: 'waiting', agentDeviceId: maple.deviceId })
  upsertConversation(s.db, { id: 'g1', ownerUserId: alice.id, title: 'Big', sessionState: 'running', agentDeviceId: jade.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  const client = login.json.token
  // Choosing the Coordinator seeds the starter set, trigger routines included.
  await s.http('/coordinator', { method: 'PUT', token: client, body: { convo_id: 'coord' } })
  const coord = await makeWsClient(s.base, { token: maple.token, cursor: null })
  t.after(() => coord.close())
  await coord.waitFor((f) => f.op === 'hello_ok')
  // Nothing tripped: no fire.
  assert.deepEqual(await s.routinesSweep.runTriggers(Date.now()), { fired: 0 })
  upsertConvoStatus(s.db, { userId: alice.id, convoId: 'g1', status: { model: 'opus-5-5', context: { tokens: 610000, window: 1000000, pct: 61 } }, reportedAt: Date.now() })
  const sweep = s.routinesSweep.runTriggers(Date.now())
  const req = await coord.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control')
  assert.equal(req.request.params.name, 'context-over')
  assert.equal(req.request.params.message, 'Routine context-over: follow the Session context over the threshold section of your playbook.\n\nTripped by:\n- [Big](matron://convo/g1) at 61% of its window (610k/1M, opus-5-5)')
  coord.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  assert.deepEqual(await sweep, { fired: 1 })
  const row = getRoutine(s.db, alice.id, 'context-over')
  assert.equal(row.last_outcome, 'applied now'); assert.ok(row.last_fired_at > 0); assert.equal(row.next_at, null)
  // Still tripped: no second fire.
  assert.deepEqual(await s.routinesSweep.runTriggers(Date.now()), { fired: 0 })
  // Inside the 15-minute gap: a second session crossing waits for the gap, and the first one clearing (compacted)
  // is forgotten even while the routine rests, so its climbing back counts as a new crossing. One fire then carries both.
  upsertConversation(s.db, { id: 'g2', ownerUserId: alice.id, title: 'Second', sessionState: 'running', agentDeviceId: jade.deviceId })
  upsertConvoStatus(s.db, { userId: alice.id, convoId: 'g2', status: { model: 'opus-5-5', context: { tokens: 500000, window: 1000000, pct: 50 } }, reportedAt: Date.now() })
  upsertConvoStatus(s.db, { userId: alice.id, convoId: 'g1', status: { model: 'opus-5-5', context: { tokens: 40000, window: 1000000, pct: 4 } }, reportedAt: Date.now() })
  assert.deepEqual(await s.routinesSweep.runTriggers(Date.now()), { fired: 0 })
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM routine_trigger_state').get().n, 0, 'the cleared subject is forgotten during the gap; the new one is not recorded yet')
  upsertConvoStatus(s.db, { userId: alice.id, convoId: 'g1', status: { model: 'opus-5-5', context: { tokens: 580000, window: 1000000, pct: 58 } }, reportedAt: Date.now() })
  assert.deepEqual(await s.routinesSweep.runTriggers(Date.now()), { fired: 0 })
  const sweepB = s.routinesSweep.runTriggers(Date.now() + 16 * 60000)
  const reqB = await coord.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control' && String(f.request.params.message).includes('[Second]'))
  assert.equal(reqB.request.params.message, 'Routine context-over: follow the Session context over the threshold section of your playbook.\n\nTripped by:\n- [Big](matron://convo/g1) at 58% of its window (580k/1M, opus-5-5)\n- [Second](matron://convo/g2) at 50% of its window (500k/1M, opus-5-5)')
  coord.send({ op: 'agent_response', request_id: reqB.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  assert.deepEqual(await sweepB, { fired: 1 })
  // A paused trigger routine never fires.
  await s.http('/routines/context-over', { method: 'PATCH', token: client, body: { enabled: false } })
  upsertConvoStatus(s.db, { userId: alice.id, convoId: 'g1', status: { model: 'opus-5-5', context: { tokens: 50000, window: 1000000, pct: 5 } }, reportedAt: Date.now() })
  upsertConvoStatus(s.db, { userId: alice.id, convoId: 'g1', status: { model: 'opus-5-5', context: { tokens: 700000, window: 1000000, pct: 70 } }, reportedAt: Date.now() })
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
