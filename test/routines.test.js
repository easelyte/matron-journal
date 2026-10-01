import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser } from '../src/auth.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { upsertConversation } from '../src/journal.js'
import {
  validateRoutineFields, nextRunAt, createRoutine, updateRoutine, deleteRoutine, getRoutine, listRoutines,
  dueRoutines, advanceRoutine, recordOutcome, seedRoutines, STARTER_ROUTINES, ROUTINES_MAX, MIN_GAP_MS,
} from '../src/routines.js'

// Pure DB state for Coordinator routines (spec 2026-10-01 coordinator
// routines): validation, cron-in-zone next fire, the due query the sweep
// runs, advance-before-deliver, and the once-per-user starter seed.

const T0 = Date.parse('2026-10-01T10:30:00Z') // 11:30 BST

async function seed() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  return { db, dan }
}
const fields = (over = {}) => ({ name: 'daily-sweep', title: 'Daily sweep', schedule: '5 7 * * *', prompt: 'Routine daily-sweep: sweep.', ...over })

test('validateRoutineFields: the full shape, defaults, and every refusal', () => {
  const ok = validateRoutineFields(fields())
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.value, { name: 'daily-sweep', title: 'Daily sweep', schedule: '5 7 * * *', trigger: null, prompt: 'Routine daily-sweep: sweep.', tz: 'Europe/London', enabled: true })
  // Partial (PATCH): only the given keys, no defaults filled in.
  const part = validateRoutineFields({ enabled: false, prompt: ' trimmed \n' }, { partial: true })
  assert.deepEqual(part, { ok: true, value: { enabled: false, prompt: 'trimmed' } })
  assert.equal(validateRoutineFields({}, { partial: true }).ok, true)
  const bad = (over, partial = false) => assert.equal(validateRoutineFields(partial ? over : fields(over), { partial }).ok, false, JSON.stringify(over))
  bad({ name: 'Daily Sweep' }); bad({ name: '-x' }); bad({ name: 'a'.repeat(65) }); bad({ name: '' })
  bad({ title: '' }); bad({ title: 'two\nlines' }); bad({ title: 'x'.repeat(201) })
  bad({ prompt: '' }); bad({ prompt: 'x'.repeat(2001) }); bad({ prompt: 42 })
  bad({ schedule: '* * * * *' })          // every minute: under the 15-minute spacing rule
  bad({ schedule: '*/10 * * * *' })       // every 10 minutes: still under it
  bad({ schedule: '0 0 * * * *' })        // six fields (seconds) are not accepted
  bad({ schedule: '99 7 * * *' }); bad({ schedule: 'daily' }); bad({ schedule: '' })
  bad({ schedule: '0 0 30 2 *' })         // never fires (30 Feb): fewer than five future runs
  // Across the spring-forward fold croner reports the skipped hour twice at
  // the same instant; that is not a 0-minute gap (review finding 4).
  assert.equal(validateRoutineFields(fields({ schedule: '0 1,2 * * *' }), { now: Date.parse('2027-03-27T12:00:00Z') }).ok, true)
  bad({ tz: 'Nope/Zone' }); bad({ tz: '' }); bad({ tz: 7 })
  bad({ enabled: 'yes' })
  bad({ name: 'x' }, true)                // name is not editable
  assert.equal(validateRoutineFields(fields({ schedule: '*/15 * * * *' })).ok, true, 'exactly 15 minutes apart is allowed')
  assert.equal(validateRoutineFields(fields({ schedule: '0 */2 * * *' })).ok, true)
  assert.equal(validateRoutineFields(fields({ schedule: '30 18 * * 1-5' })).ok, true)
  // Prompt keeps its line breaks, loses other control characters.
  assert.equal(validateRoutineFields(fields({ prompt: 'a\nb\u0007c' })).value.prompt, 'a\nbc')
})

test('nextRunAt: in the named zone, across the autumn clock change, null for a bad pattern', () => {
  // 07:05 Europe/London is 06:05Z in BST and 07:05Z after the 25 Oct change.
  assert.equal(nextRunAt('5 7 * * *', 'Europe/London', Date.parse('2026-10-24T12:00:00Z')), Date.parse('2026-10-25T07:05:00Z'))
  assert.equal(nextRunAt('5 7 * * *', 'Europe/London', Date.parse('2026-10-23T12:00:00Z')), Date.parse('2026-10-24T06:05:00Z'))
  assert.equal(nextRunAt('0 */2 * * *', 'Europe/London', T0), Date.parse('2026-10-01T11:00:00Z'))
  assert.equal(nextRunAt('30 18 * * 1-5', 'Europe/London', Date.parse('2026-10-02T18:00:00Z')), Date.parse('2026-10-05T17:30:00Z'), 'Friday 19:00 BST → Monday')
  assert.equal(nextRunAt('99 7 * * *', 'Europe/London', T0), null)
  assert.equal(MIN_GAP_MS, 15 * 60000)
})

test('create / get / list / update / delete, unique names, the cap, and next_at bookkeeping', async () => {
  const { db, dan } = await seed()
  const r = createRoutine(db, { userId: dan.id, origin: 'user', fields: validateRoutineFields(fields()).value, now: T0 })
  assert.match(r.id, /^rt_[0-9a-f]{16}$/)
  assert.equal(r.name, 'daily-sweep'); assert.equal(r.enabled, true); assert.equal(r.origin, 'user')
  assert.equal(r.next_at, Date.parse('2026-10-02T06:05:00Z'))
  assert.equal(r.last_fired_at, null); assert.equal(r.last_outcome, null)
  assert.equal('retry_at' in r, false, 'retry_at is internal')
  assert.deepEqual(getRoutine(db, dan.id, r.id), r)
  assert.deepEqual(getRoutine(db, dan.id, 'daily-sweep'), r)
  assert.equal(getRoutine(db, dan.id + 1, r.id), null)
  assert.equal(getRoutine(db, dan.id, 'nope'), null)
  assert.throws(() => createRoutine(db, { userId: dan.id, origin: 'user', fields: validateRoutineFields(fields()).value, now: T0 }), /conflict/)
  createRoutine(db, { userId: dan.id, origin: 'agent', fields: validateRoutineFields(fields({ name: 'b-check', schedule: '0 */2 * * *' })).value, now: T0 })
  assert.deepEqual(listRoutines(db, dan.id).map((x) => x.name), ['b-check', 'daily-sweep'])
  // Pause clears next_at; resume recomputes from now; a schedule change recomputes; title/prompt do not.
  let u = updateRoutine(db, { userId: dan.id, key: 'daily-sweep', fields: { enabled: false }, now: T0 })
  assert.equal(u.enabled, false); assert.equal(u.next_at, null)
  u = updateRoutine(db, { userId: dan.id, key: r.id, fields: { enabled: true }, now: Date.parse('2026-10-03T12:00:00Z') })
  assert.equal(u.next_at, Date.parse('2026-10-04T06:05:00Z'))
  u = updateRoutine(db, { userId: dan.id, key: r.id, fields: { title: 'Sweep' }, now: Date.parse('2026-10-03T13:00:00Z') })
  assert.equal(u.title, 'Sweep'); assert.equal(u.next_at, Date.parse('2026-10-04T06:05:00Z')); assert.equal(u.updated_at, Date.parse('2026-10-03T13:00:00Z'))
  u = updateRoutine(db, { userId: dan.id, key: r.id, fields: { schedule: '0 9 * * *' }, now: Date.parse('2026-10-03T13:00:00Z') })
  assert.equal(u.next_at, Date.parse('2026-10-04T08:00:00Z'))
  u = updateRoutine(db, { userId: dan.id, key: r.id, fields: { tz: 'UTC' }, now: Date.parse('2026-10-03T13:00:00Z') })
  assert.equal(u.next_at, Date.parse('2026-10-04T09:00:00Z'))
  assert.equal(updateRoutine(db, { userId: dan.id, key: 'nope', fields: { title: 'x' }, now: T0 }), null)
  assert.equal(deleteRoutine(db, dan.id, 'b-check')?.name, 'b-check')
  assert.equal(deleteRoutine(db, dan.id, 'b-check'), null)
  assert.deepEqual(listRoutines(db, dan.id).map((x) => x.name), ['daily-sweep'])
  for (let i = listRoutines(db, dan.id).length; i < ROUTINES_MAX; i++) {
    createRoutine(db, { userId: dan.id, origin: 'user', fields: validateRoutineFields(fields({ name: `r${i}` })).value, now: T0 })
  }
  assert.throws(() => createRoutine(db, { userId: dan.id, origin: 'user', fields: validateRoutineFields(fields({ name: 'one-more' })).value, now: T0 }), /cap/)
})

test('dueRoutines / advanceRoutine / recordOutcome: due on next_at or retry_at, advance before delivery, missed when stale, one retry', async () => {
  const { db, dan } = await seed()
  const a = createRoutine(db, { userId: dan.id, origin: 'seed', fields: validateRoutineFields(fields()).value, now: T0 })
  const b = createRoutine(db, { userId: dan.id, origin: 'seed', fields: validateRoutineFields(fields({ name: 'b', schedule: '0 */2 * * *' })).value, now: T0 })
  const paused = createRoutine(db, { userId: dan.id, origin: 'seed', fields: validateRoutineFields(fields({ name: 'paused', enabled: false })).value, now: T0 })
  assert.deepEqual(dueRoutines(db, T0), [])
  const at = Date.parse('2026-10-01T11:00:00Z')
  assert.deepEqual(dueRoutines(db, at).map((r) => r.name), ['b'])
  // Advance: last_fired_at stamped, next_at moved on, before anything is delivered.
  const adv = advanceRoutine(db, b.id, at)
  assert.equal(adv.missed, false)
  assert.equal(adv.routine.last_fired_at, at)
  assert.equal(adv.routine.next_at, Date.parse('2026-10-01T13:00:00Z'))
  assert.deepEqual(dueRoutines(db, at), [])
  // Outcomes: a retryable failure sets retry_at once; its own failure does not.
  recordOutcome(db, b.id, { outcome: 'failed agent_unreachable', retryable: true, now: at })
  assert.equal(getRoutine(db, dan.id, b.id).last_outcome, 'failed agent_unreachable')
  assert.deepEqual(dueRoutines(db, at + 14 * 60000).map((r) => r.name), [])
  assert.deepEqual(dueRoutines(db, at + 15 * 60000).map((r) => r.name), ['b'])
  const retry = advanceRoutine(db, b.id, at + 15 * 60000)
  assert.equal(retry.missed, false)
  assert.equal(retry.retry, true, 'a retry fire is marked so its failure is final')
  assert.equal(retry.routine.next_at, Date.parse('2026-10-01T13:00:00Z'), 'a retry does not move the schedule')
  recordOutcome(db, b.id, { outcome: 'failed timeout', retryable: true, now: at + 16 * 60000, retry: true })
  assert.deepEqual(dueRoutines(db, at + 40 * 60000), [], 'the retry failed: nothing until the next scheduled time')
  recordOutcome(db, b.id, { outcome: 'applied now', retryable: false, now: at })
  assert.equal(getRoutine(db, dan.id, b.id).last_outcome, 'applied now')
  // Stale: more than 6 h late is marked missed and advanced, not fired.
  const late = Date.parse('2026-10-02T13:00:00Z')
  assert.deepEqual(dueRoutines(db, late).map((r) => r.name).sort(), ['b', 'daily-sweep'])
  const miss = advanceRoutine(db, a.id, late)
  assert.equal(miss.missed, true)
  assert.equal(getRoutine(db, dan.id, a.id).last_outcome, 'missed')
  assert.equal(getRoutine(db, dan.id, a.id).last_fired_at, null, 'a missed fire is not a fire')
  assert.equal(getRoutine(db, dan.id, a.id).next_at, Date.parse('2026-10-03T06:05:00Z'))
  // A paused routine is never due, and recordOutcome never re-arms it.
  recordOutcome(db, paused.id, { outcome: 'applied now', retryable: true, now: late })
  assert.deepEqual(dueRoutines(db, late + 3600000).map((r) => r.name), ['b'])
  // Paused between dueRoutines and advanceRoutine: not fired (review finding 2).
  db.prepare('UPDATE routines SET enabled=0 WHERE id=?').run(b.id)
  assert.equal(advanceRoutine(db, b.id, late + 3600000), null)
  db.prepare('UPDATE routines SET enabled=1 WHERE id=?').run(b.id)
  // A stale retry (the journal was down for hours) is missed, not delivered,
  // and a past next_at is moved on with it (review finding 1).
  db.prepare('UPDATE routines SET retry_at=?, next_at=? WHERE id=?').run(late - 8 * 3600000, late - 7 * 3600000, b.id)
  const staleRetry = advanceRoutine(db, b.id, late)
  assert.equal(staleRetry.missed, true)
  assert.equal(staleRetry.retry, true)
  assert.ok(staleRetry.routine.next_at > late)
  assert.equal(getRoutine(db, dan.id, b.id).last_outcome, 'missed')
  // A fresh retry whose next_at has meanwhile passed advances next_at too.
  db.prepare('UPDATE routines SET retry_at=?, next_at=? WHERE id=?').run(late - 60000, late - 30000, b.id)
  const fresh = advanceRoutine(db, b.id, late)
  assert.equal(fresh.missed, false); assert.equal(fresh.retry, true); assert.ok(fresh.routine.next_at > late)
})

test('seedRoutines: the starter set once per user, at Coordinator assignment or boot, never after the user emptied the list', async () => {
  const { db, dan } = await seed()
  const pat = await createUser(db, 'pat', 'pw')
  upsertConversation(db, { id: 'coord', ownerUserId: dan.id, title: 'Coordinator' })
  assert.equal(seedRoutines(db, dan.id, T0), STARTER_ROUTINES.length)
  assert.deepEqual(listRoutines(db, dan.id).map((r) => [r.name, r.schedule, r.tz, r.origin]), [...STARTER_ROUTINES].sort((x, y) => x.name.localeCompare(y.name)).map((r) => [r.name, r.schedule ?? null, 'Europe/London', 'seed']))
  for (const r of listRoutines(db, dan.id)) {
    assert.equal(validateRoutineFields(r).ok, true, r.name)
    if (r.schedule) assert.ok(r.next_at > T0); else assert.equal(r.next_at, null)
    assert.match(r.prompt, new RegExp(`^Routine ${r.name}: `))
  }
  assert.equal(seedRoutines(db, dan.id, T0), 0, 'already seeded')
  for (const r of listRoutines(db, dan.id)) deleteRoutine(db, dan.id, r.id)
  assert.equal(seedRoutines(db, dan.id, T0), 0, 'the user emptied the list: never re-seeded')
  assert.equal(seedRoutines(db, pat.id, T0), STARTER_ROUTINES.length)
  // setCoordinatorConvoId itself does not seed (the HTTP layer and boot do).
  setCoordinatorConvoId(db, dan.id, 'coord')
  assert.deepEqual(listRoutines(db, dan.id), [])
})
