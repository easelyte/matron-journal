import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { upsertConversation } from '../src/journal.js'
import { listRoutines, getRoutine, STARTER_ROUTINES, ROUTINES_MAX } from '../src/routines.js'
import { ROUTINE_FROM_NAME, ROUTINE_MAX_INFLIGHT } from '../src/routines-sweep.js'

// /routines (src/routines-http.js) and the fire path (src/routines-sweep.js):
// the Coordinator gate on writes, the marker into the Coordinator
// conversation, delivery as a journal-originated session_control RPC with
// action 'routine', seeding at assignment and boot, the sweep's advance /
// retry / in-flight rules.

const body = (over = {}) => ({ name: 'daily-sweep', title: 'Daily sweep', schedule: '5 7 * * *', prompt: 'Routine daily-sweep: sweep.', ...over })

// mavis owns the Coordinator conversation 'coord'; gene is an ordinary box.
async function fleet(t, { coordinator = true, connect = true, waker = null, seedAtBoot = false, serverOpts = {} } = {}) {
  const s = await startTestServer({ sessionControlTimeoutMs: 2000, routinesSweepIntervalMs: 3600_000, ...(waker ? { waker } : {}), ...serverOpts })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const coordDev = createAgent(s.db, dan.id, 'mavis')
  const gene = createAgent(s.db, dan.id, 'gene')
  upsertConversation(s.db, { id: 'coord', ownerUserId: dan.id, title: 'Coordinator', agentDeviceId: coordDev.deviceId })
  upsertConversation(s.db, { id: 'g1', ownerUserId: dan.id, title: 'G1', agentDeviceId: gene.deviceId })
  if (coordinator) setCoordinatorConvoId(s.db, dan.id, 'coord')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  let coord = null
  if (connect) {
    coord = await makeWsClient(s.base, { token: coordDev.token, cursor: null })
    t.after(() => coord.close())
    await coord.waitFor((f) => f.op === 'hello_ok')
  }
  void seedAtBoot
  return { s, dan, coordDev, gene, client: login.json.token, coord }
}
const markers = (s) => s.db.prepare("SELECT convo_id, sender, payload FROM events WHERE type='routine' ORDER BY seq").all().map((r) => ({ ...r, payload: JSON.parse(r.payload) }))
const settle = async (s) => { const t0 = Date.now(); while (s.broker.pendingCount() > 0 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10)) }
// Answer the next session_control RPC the Coordinator's socket receives.
async function answerRpc(coord, { ok = true, result = { applied: 'now' }, error = null, after = 0 } = {}) {
  const req = await coord.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control' && !f._answered)
  req._answered = true
  coord.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok, ...(ok ? { result } : { error }) })
  return req.request
}

test('GET /routines: any device kind reads the user\'s list; agents of another user see nothing', async (t) => {
  const { s, client, gene, coordDev } = await fleet(t, { connect: false })
  assert.deepEqual((await s.http('/routines', { token: client })).json, { routines: [] })
  const r = await s.http('/routines', { method: 'POST', token: client, body: body() })
  assert.equal(r.status, 201)
  for (const token of [client, gene.token, coordDev.token]) {
    const list = await s.http('/routines', { token })
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.routines.map((x) => x.name), ['daily-sweep'])
    assert.equal('retry_at' in list.json.routines[0], false)
  }
  const pat = await createUser(s.db, 'pat', 'pw')
  const patDev = createAgent(s.db, pat.id, 'pat-box')
  assert.deepEqual((await s.http('/routines', { token: patDev.token })).json, { routines: [] })
  assert.equal((await s.http('/routines/daily-sweep', { token: patDev.token })).status, 404)
  const one = await s.http(`/routines/${r.json.routine.id}`, { token: gene.token })
  assert.equal(one.status, 200); assert.equal(one.json.routine.name, 'daily-sweep')
  assert.equal((await s.http('/routines/daily-sweep', { token: client })).json.routine.id, r.json.routine.id)
})

test('POST / PATCH / DELETE: the client may; an agent only as the Coordinator naming its own conversation; nobody but the user deletes', async (t) => {
  const { s, client, gene, coordDev } = await fleet(t, { connect: false })
  // Agent without convo_id, or naming a conversation it does not own, or the wrong one.
  assert.deepEqual(await s.http('/routines', { method: 'POST', token: coordDev.token, body: body() }), { status: 403, json: { error: 'forbidden', detail: 'not_coordinator' } })
  assert.equal((await s.http('/routines', { method: 'POST', token: gene.token, body: body({ convo_id: 'coord' }) })).status, 404)
  assert.deepEqual(await s.http('/routines', { method: 'POST', token: gene.token, body: body({ convo_id: 'g1' }) }), { status: 403, json: { error: 'forbidden', detail: 'not_coordinator' } })
  assert.equal((await s.http('/routines', { method: 'POST', token: coordDev.token, body: body({ convo_id: '' }) })).status, 400)
  // The Coordinator creates; origin 'agent'.
  const c = await s.http('/routines', { method: 'POST', token: coordDev.token, body: body({ convo_id: 'coord' }) })
  assert.equal(c.status, 201); assert.equal(c.json.routine.origin, 'agent'); assert.equal(c.json.routine.tz, 'Europe/London')
  // Name taken → 409; bad fields → 400.
  assert.deepEqual(await s.http('/routines', { method: 'POST', token: client, body: body() }), { status: 409, json: { error: 'conflict', blocked_by: 'name' } })
  assert.equal((await s.http('/routines', { method: 'POST', token: client, body: body({ name: 'x', schedule: '* * * * *' }) })).status, 400)
  assert.equal((await s.http('/routines', { method: 'POST', token: client, body: body({ name: 'x', tz: 'Mars/Olympus' }) })).status, 400)
  // The client creates with origin 'user'.
  const u = await s.http('/routines', { method: 'POST', token: client, body: body({ name: 'health', schedule: '0 */2 * * *', tz: 'UTC', enabled: false }) })
  assert.equal(u.status, 201); assert.equal(u.json.routine.origin, 'user'); assert.equal(u.json.routine.enabled, false); assert.equal(u.json.routine.next_at, null)
  // PATCH: same gate; empty body 400; unknown 404.
  assert.equal((await s.http('/routines/health', { method: 'PATCH', token: gene.token, body: { enabled: true, convo_id: 'g1' } })).status, 403)
  assert.equal((await s.http('/routines/health', { method: 'PATCH', token: client, body: {} })).status, 400)
  assert.equal((await s.http('/routines/health', { method: 'PATCH', token: client, body: { name: 'renamed' } })).status, 400)
  assert.equal((await s.http('/routines/nope', { method: 'PATCH', token: client, body: { title: 'x' } })).status, 404)
  const p = await s.http('/routines/health', { method: 'PATCH', token: coordDev.token, body: { enabled: true, convo_id: 'coord' } })
  assert.equal(p.status, 200); assert.equal(p.json.routine.enabled, true); assert.ok(p.json.routine.next_at > Date.now())
  assert.equal((await s.http('/routines/health', { method: 'PATCH', token: client, body: { schedule: '*/5 * * * *' } })).status, 400, 'spacing rule on PATCH too')
  // DELETE: agents 403 even as the Coordinator; the client 200 then 404.
  assert.deepEqual(await s.http('/routines/health', { method: 'DELETE', token: coordDev.token, body: { convo_id: 'coord' } }), { status: 403, json: { error: 'forbidden' } })
  assert.deepEqual(await s.http('/routines/health', { method: 'DELETE', token: client }), { status: 200, json: { ok: true } })
  assert.equal((await s.http('/routines/health', { method: 'DELETE', token: client })).status, 404)
  // Markers: saved (by agent), saved (by user), saved (patch), deleted — all into the Coordinator conversation, sender 'journal' for the row's own change.
  const m = markers(s)
  assert.deepEqual(m.map((x) => [x.convo_id, x.payload.name, x.payload.action, x.payload.by]), [
    ['coord', 'daily-sweep', 'saved', 'agent'], ['coord', 'health', 'saved', 'user'], ['coord', 'health', 'saved', 'agent'], ['coord', 'health', 'deleted', 'user'],
  ])
  assert.equal(m[0].sender, 'agent:mavis'); assert.equal(m[1].sender, 'user:dan')
  assert.equal(m[0].payload.routine_id, c.json.routine.id); assert.equal(m[0].payload.created, true); assert.equal(m[2].payload.created, false)
  // The cap: 409 blocked_by cap.
  for (let i = listRoutines(s.db, 1).length; i < ROUTINES_MAX; i++) assert.equal((await s.http('/routines', { method: 'POST', token: client, body: body({ name: `r${i}` }) })).status, 201)
  assert.deepEqual(await s.http('/routines', { method: 'POST', token: client, body: body({ name: 'one-more' }) }), { status: 409, json: { error: 'conflict', blocked_by: 'cap' } })
})

test('no Coordinator set: writes still work for the client, no marker is appended', async (t) => {
  const { s, client } = await fleet(t, { connect: false, coordinator: false })
  assert.equal((await s.http('/routines', { method: 'POST', token: client, body: body() })).status, 201)
  assert.deepEqual(markers(s), [])
})

test('POST /routines/:key/run: fires now as session_control {action: routine}; outcome and a fired marker land; enabled is irrelevant; next_at untouched', async (t) => {
  const { s, dan, client, coord, coordDev, gene } = await fleet(t)
  const c = await s.http('/routines', { method: 'POST', token: client, body: body({ enabled: false }) })
  const id = c.json.routine.id
  assert.equal((await s.http('/routines/daily-sweep/run', { method: 'POST', token: gene.token, body: { convo_id: 'g1' } })).status, 403)
  assert.equal((await s.http('/routines/nope/run', { method: 'POST', token: client })).status, 404)
  const r = await s.http('/routines/daily-sweep/run', { method: 'POST', token: coordDev.token, body: { convo_id: 'coord' } })
  assert.deepEqual(r, { status: 202, json: { accepted: true } })
  const req = await answerRpc(coord)
  assert.equal(req.from_device_id, 0)
  assert.equal(req.params.convo_id, 'coord'); assert.equal(req.params.action, 'routine')
  assert.equal(req.params.routine_id, id); assert.equal(req.params.name, 'daily-sweep'); assert.equal(req.params.title, 'Daily sweep')
  assert.equal(req.params.message, 'Routine daily-sweep: sweep.'); assert.equal(req.params.tz, 'Europe/London'); assert.equal(req.params.from_name, ROUTINE_FROM_NAME)
  assert.match(req.params.fired_at, /^\d{4}-\d\d-\d\dT/)
  assert.deepEqual(Object.keys(req.params).sort(), ['action', 'convo_id', 'fired_at', 'from_name', 'message', 'name', 'routine_id', 'title', 'tz'])
  await settle(s)
  const after = getRoutine(s.db, dan.id, id)
  assert.equal(after.last_outcome, 'applied now'); assert.ok(after.last_fired_at > 0); assert.equal(after.next_at, null, 'run never schedules a paused routine')
  const fired = markers(s).filter((m) => m.payload.action === 'fired')
  assert.equal(fired.length, 1)
  assert.deepEqual(fired[0].payload, { routine_id: id, name: 'daily-sweep', action: 'fired', outcome: 'applied now', next_at: null })
  assert.equal(fired[0].sender, 'journal')
  // A deferred reply reads as such; a bridge refusal as failed <code>.
  await s.http(`/routines/${id}/run`, { method: 'POST', token: client })
  await answerRpc(coord, { result: { applied: 'deferred' } })
  await settle(s)
  assert.equal(getRoutine(s.db, dan.id, id).last_outcome, 'applied deferred')
  await s.http(`/routines/${id}/run`, { method: 'POST', token: client })
  await answerRpc(coord, { ok: false, error: { code: 'gone' } })
  await settle(s)
  assert.equal(getRoutine(s.db, dan.id, id).last_outcome, 'failed gone')
})

test('run with no Coordinator (or a boxless one): 202 delivered:false no_coordinator, outcome recorded', async (t) => {
  const { s, dan, client } = await fleet(t, { connect: false, coordinator: false })
  const c = await s.http('/routines', { method: 'POST', token: client, body: body() })
  assert.deepEqual(await s.http('/routines/daily-sweep/run', { method: 'POST', token: client }), { status: 202, json: { delivered: false, reason: 'no_coordinator' } })
  assert.equal(getRoutine(s.db, dan.id, c.json.routine.id).last_outcome, 'no_coordinator')
})

test('the sweep: fires what is due, advances before delivering, wakes an asleep box, retries an unreachable one once, bounds in-flight deliveries', async (t) => {
  const calls = []
  const waker = { enabled: true, wake: (name) => { calls.push(name); return true } }
  const { s, dan, client, coordDev } = await fleet(t, { connect: false, waker, serverOpts: { spawnWakeWaitMs: 300 } })
  const a = (await s.http('/routines', { method: 'POST', token: client, body: body() })).json.routine
  const b = (await s.http('/routines', { method: 'POST', token: client, body: body({ name: 'health', schedule: '0 */2 * * *' }) })).json.routine
  // Park `b` ten days out so the real clock cannot make it due mid-test; it is set due by hand below.
  s.db.prepare('UPDATE routines SET next_at=? WHERE id=?').run(Date.now() + 10 * 86400000, b.id)
  // Nothing due at the dawn of time (every next_at is in the future).
  assert.deepEqual(await s.routinesSweep.run(1), { fired: 0, missed: 0 })
  // Make `a` due now (its row, not the clock): the box is offline → wake, wait, then unreachable → retry armed.
  const now = Date.now()
  s.db.prepare('UPDATE routines SET next_at=? WHERE id=?').run(now - 1000, a.id)
  const first = await s.routinesSweep.run(now)
  assert.deepEqual(first, { fired: 1, missed: 0 })
  assert.deepEqual(calls, ['mavis'])
  await settle(s)
  const afterA = s.db.prepare('SELECT * FROM routines WHERE id=?').get(a.id)
  assert.equal(afterA.last_outcome, 'failed agent_unreachable')
  assert.equal(afterA.last_fired_at, now)
  assert.ok(afterA.next_at > now, 'advanced past now before delivery')
  assert.ok(afterA.retry_at >= now + 15 * 60000 && afterA.retry_at < now + 15 * 60000 + 5000, 'one retry, 15 min after the failure')
  // The retry: the box is up now and answers.
  const coord = await makeWsClient(s.base, { token: coordDev.token, cursor: null })
  t.after(() => coord.close())
  await coord.waitFor((f) => f.op === 'hello_ok')
  const retryAt = afterA.retry_at
  const second = s.routinesSweep.run(retryAt)
  const req = await answerRpc(coord)
  assert.equal(req.params.name, 'daily-sweep')
  assert.deepEqual(await second, { fired: 1, missed: 0 })
  await settle(s)
  const afterRetry = s.db.prepare('SELECT * FROM routines WHERE id=?').get(a.id)
  assert.equal(afterRetry.last_outcome, 'applied now'); assert.equal(afterRetry.retry_at, null)
  assert.equal(afterRetry.last_fired_at, now, 'a retry is the same fire')
  // Stale: `b` 7 hours late is missed, not delivered.
  s.db.prepare('UPDATE routines SET next_at=? WHERE id=?').run(now - 7 * 3600000, b.id)
  assert.deepEqual(await s.routinesSweep.run(now), { fired: 0, missed: 1 })
  assert.equal(getRoutine(s.db, dan.id, b.id).last_outcome, 'missed')
  assert.equal(markers(s).filter((m) => m.payload.action === 'fired').length, 2, 'retry and first attempt each reported; a miss is not a fire')
  // In-flight bound: more due routines than ROUTINE_MAX_INFLIGHT → the rest wait, still due next sweep.
  const extra = []
  for (let i = 0; i < ROUTINE_MAX_INFLIGHT + 2; i++) extra.push((await s.http('/routines', { method: 'POST', token: client, body: body({ name: `x${i}` }) })).json.routine)
  for (const r of extra) s.db.prepare('UPDATE routines SET next_at=? WHERE id=?').run(now - 1000, r.id)
  const bounded = s.routinesSweep.run(now)
  // Answer the first ROUTINE_MAX_INFLIGHT RPCs, then the rest arrive on the next sweep.
  for (let i = 0; i < ROUTINE_MAX_INFLIGHT; i++) await answerRpc(coord)
  assert.deepEqual(await bounded, { fired: ROUTINE_MAX_INFLIGHT, missed: 0 })
  await settle(s)
  const left = s.db.prepare('SELECT COUNT(*) n FROM routines WHERE next_at<=?').get(now).n
  assert.equal(left, 2)
  const rest = s.routinesSweep.run(now)
  for (let i = 0; i < 2; i++) await answerRpc(coord)
  assert.deepEqual(await rest, { fired: 2, missed: 0 })
})

test('seeding: PUT /coordinator seeds the starter set once; boot seeds users who already have a Coordinator; never twice', async (t) => {
  const { s, dan, client } = await fleet(t, { connect: false, coordinator: false })
  assert.deepEqual(listRoutines(s.db, dan.id), [])
  const r = await s.http('/coordinator', { method: 'PUT', token: client, body: { convo_id: 'coord' } })
  assert.equal(r.status, 200)
  assert.deepEqual(listRoutines(s.db, dan.id).map((x) => x.name).sort(), STARTER_ROUTINES.map((x) => x.name).sort())
  assert.equal(markers(s).length, 0, 'seeding is silent: no per-routine markers')
  // Clearing and re-assigning does not re-seed; nor does deleting them all.
  await s.http('/coordinator', { method: 'PUT', token: client, body: { convo_id: null } })
  await s.http('/routines/daily-sweep', { method: 'DELETE', token: client })
  await s.http('/coordinator', { method: 'PUT', token: client, body: { convo_id: 'coord' } })
  assert.equal(listRoutines(s.db, dan.id).length, STARTER_ROUTINES.length - 1)
  // Boot: a second server over a DB where the Coordinator is set but routines were never seeded.
  const file = `/tmp/routines-boot-${process.pid}-${Date.now()}.db`
  const s1 = await startTestServer({ dbPath: file, routinesSweepIntervalMs: 3600_000 })
  const pat = await createUser(s1.db, 'pat', 'pw')
  upsertConversation(s1.db, { id: 'pc', ownerUserId: pat.id, title: 'PC' })
  setCoordinatorConvoId(s1.db, pat.id, 'pc')
  s1.db.prepare('UPDATE user_settings SET routines_seeded_at=NULL WHERE user_id=?').run(pat.id)
  assert.deepEqual(listRoutines(s1.db, pat.id), [])
  await s1.close()
  const s2 = await startTestServer({ dbPath: file, routinesSweepIntervalMs: 3600_000 })
  t.after(() => s2.close())
  assert.equal(listRoutines(s2.db, pat.id).length, STARTER_ROUTINES.length)
})
