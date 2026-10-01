import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { alertTokenMatches, ALERT_MAX_INFLIGHT } from '../src/alerts-http.js'
import { formatAlertMessage } from '../src/alerts.js'

// POST /alerts/alertmanager (src/alerts-http.js): Alertmanager's webhook,
// authenticated by a shared secret, delivered to the user's Coordinator as
// a journal-originated session_control RPC with action 'alert'.

const TOKEN = 'a'.repeat(40)
const PAYLOAD = {
  version: '4', status: 'firing', receiver: 'matron', groupLabels: { alertname: 'DiskSpaceLow' },
  commonLabels: { alertname: 'DiskSpaceLow', severity: 'warning' }, commonAnnotations: {},
  alerts: [{ status: 'firing', labels: { alertname: 'DiskSpaceLow', guest: 'mavis', mountpoint: '/' }, annotations: { summary: 'Disk 88% full' }, startsAt: '2026-09-30T10:00:00Z' }],
}

// `coord` = the Coordinator's bridge (box 'mavis', owns 'coord-convo').
async function fleet(t, { alertWebhook = { token: TOKEN, username: 'dan' }, coordinator = true, connect = true, serverOpts = {} } = {}) {
  const s = await startTestServer({ sessionControlTimeoutMs: 2000, alertWebhook, ...serverOpts })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const coordDev = createAgent(s.db, dan.id, 'mavis')
  s.db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, last_seq, unread_count, snippet, created_at, agent_device_id) VALUES('coord-convo', ?, 'coordinator', 'waiting', 0, 0, '', 1, ?)").run(dan.id, coordDev.deviceId)
  if (coordinator) setCoordinatorConvoId(s.db, dan.id, 'coord-convo')
  let coord = null
  if (connect) {
    coord = await makeWsClient(s.base, { token: coordDev.token, cursor: null })
    t.after(() => coord.close())
    await coord.waitFor((f) => f.op === 'hello_ok')
  }
  return { s, dan, coordDev, coord }
}

const post = (s, { token = TOKEN, body = PAYLOAD, raw = null } = {}) => fetch(`${s.base}/alerts/alertmanager`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: raw ?? JSON.stringify(body),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))

test('alertTokenMatches: equal only for the same string, any lengths', () => {
  assert.equal(alertTokenMatches(TOKEN, TOKEN), true)
  assert.equal(alertTokenMatches(TOKEN, TOKEN.slice(1)), false)
  assert.equal(alertTokenMatches(TOKEN, ''), false)
  assert.equal(alertTokenMatches(TOKEN, undefined), false)
})

test('disabled (env unset, short token, unknown user): the path answers exactly like an unknown one', async (t) => {
  for (const alertWebhook of [{ token: null, username: null }, { token: 'short', username: 'dan' }, { token: TOKEN, username: 'nobody' }, { token: TOKEN, username: null }]) {
    const { s, dan } = await fleet(t, { alertWebhook, connect: false })
    const unknown = await fetch(`${s.base}/no/such/route`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{}' })
    const r = await post(s)
    assert.equal(r.status, unknown.status, JSON.stringify(alertWebhook))
    assert.deepEqual(r.json, await unknown.json())
    // With a real device token it is the chain's own 404.
    const dev = createAgent(s.db, dan.id, 'other')
    const authed = await post(s, { token: dev.token })
    assert.equal(authed.status, 404)
    assert.deepEqual(authed.json, { error: 'not_found' })
  }
})

test('401 on a missing or wrong token; wrong tokens spend the per-IP budget, then even the right one is 429', async (t) => {
  const { s } = await fleet(t, { connect: false, coordinator: false })
  assert.equal((await post(s, { token: null })).status, 401)
  const bad = await post(s, { token: 'b'.repeat(40) })
  assert.deepEqual(bad, { status: 401, json: { error: 'unauthenticated' } })
  // The right token does not spend the budget.
  for (let i = 0; i < 6; i++) assert.equal((await post(s)).status, 202)
  for (let i = 0; i < 3; i++) assert.equal((await post(s, { token: 'c'.repeat(40) })).status, 401)
  assert.equal((await post(s, { token: 'c'.repeat(40) })).status, 429)
  assert.equal((await post(s)).status, 429)
})

test('400 on bad JSON, a non-object, or a payload without alerts', async (t) => {
  const { s } = await fleet(t, { connect: false })
  assert.equal((await post(s, { raw: '{nope' })).status, 400)
  assert.equal((await post(s, { raw: '[1]' })).status, 400)
  assert.equal((await post(s, { body: { status: 'firing' } })).status, 400)
  assert.equal((await post(s, { body: { alerts: [] } })).status, 400)
})

test('413 over the 256 KiB cap', async (t) => {
  const { s } = await fleet(t, { connect: false })
  const r = await post(s, { body: { ...PAYLOAD, pad: 'x'.repeat(300 * 1024) } })
  assert.equal(r.status, 413)
  // Bytes, not characters: 100k € is ~98k UTF-16 units but ~293 KiB on the wire.
  const multi = await post(s, { body: { ...PAYLOAD, pad: '€'.repeat(100000) } })
  assert.equal(multi.status, 413)
})

test('202 no_coordinator when none is set or its conversation has no box', async (t) => {
  const { s, dan } = await fleet(t, { connect: false, coordinator: false })
  assert.deepEqual(await post(s), { status: 202, json: { delivered: false, reason: 'no_coordinator' } })
  s.db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, last_seq, unread_count, snippet, created_at) VALUES('boxless', ?, 'x', 'waiting', 0, 0, '', 1)").run(dan.id)
  setCoordinatorConvoId(s.db, dan.id, 'boxless')
  assert.deepEqual(await post(s), { status: 202, json: { delivered: false, reason: 'no_coordinator' } })
})

test('happy path: the Coordinator box receives session_control {convo_id, action:alert, message, from_name}', async (t) => {
  const { s, coord } = await fleet(t)
  assert.deepEqual(await post(s), { status: 202, json: { accepted: true } })
  const req = await coord.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control')
  assert.equal(req.request.from_device_id, 0)
  assert.deepEqual(req.request.params, {
    convo_id: 'coord-convo', action: 'alert', message: formatAlertMessage(PAYLOAD), from_name: 'Alertmanager',
  })
  assert.match(req.request.params.message, /^🔔 Alertmanager: FIRING DiskSpaceLow \[warning\] \(1 alert\)\n- firing mavis \/: Disk 88% full\n/)
  coord.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  // The broker entry settles on the reply.
  const t0 = Date.now()
  while (s.broker.pendingCount() > 0 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10))
  assert.equal(s.broker.pendingCount(), 0)
})

test('an asleep Coordinator box is woken and the alert goes out once it attaches', async (t) => {
  const calls = []
  const waker = { enabled: true, wake: (name) => { calls.push(name); return true } }
  const { s, coordDev } = await fleet(t, { connect: false, serverOpts: { waker, spawnWakeWaitMs: 5000 } })
  assert.deepEqual(await post(s), { status: 202, json: { accepted: true } })
  assert.deepEqual(calls, ['mavis'])
  const coord = await makeWsClient(s.base, { token: coordDev.token, cursor: null })
  t.after(() => coord.close())
  const req = await coord.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'session_control', 4000)
  assert.equal(req.request.params.action, 'alert')
  coord.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'deferred' } })
})

test(`at most ${ALERT_MAX_INFLIGHT} deliveries in flight; the next is 202 busy`, async (t) => {
  const { s, coord } = await fleet(t)
  for (let i = 0; i < ALERT_MAX_INFLIGHT; i++) assert.deepEqual((await post(s)).json, { accepted: true })
  assert.deepEqual(await post(s), { status: 202, json: { delivered: false, reason: 'busy' } })
  // Answer them all; the slots free up.
  const seen = new Set()
  while (seen.size < ALERT_MAX_INFLIGHT) {
    const req = await coord.waitFor((f) => f.kind === 'rpc' && !seen.has(f.request.request_id))
    seen.add(req.request.request_id)
    coord.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  }
  const t0 = Date.now()
  let r = await post(s)
  while (r.json.reason === 'busy' && Date.now() - t0 < 2000) {
    await new Promise((ok) => setTimeout(ok, 20))
    r = await post(s)
  }
  assert.deepEqual(r.json, { accepted: true })
})

test("the Coordinator's own session_control op still cannot send action 'alert'", async (t) => {
  const { s, dan, coord } = await fleet(t)
  const other = createAgent(s.db, dan.id, 'eric')
  s.db.prepare("INSERT INTO conversations(id, owner_user_id, title, session_state, last_seq, unread_count, snippet, created_at, agent_device_id) VALUES('tgt', ?, 'work', 'waiting', 0, 0, '', 1, ?)").run(dan.id, other.deviceId)
  coord.send({ op: 'session_control', request_id: 'x1', from_convo_id: 'coord-convo', target_convo_id: 'tgt', action: 'alert', message: 'forged' })
  const err = await coord.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.ref === 'session_control')
  assert.equal(err.code, 'bad_request')
  assert.equal(err.detail, 'bad action')
})
