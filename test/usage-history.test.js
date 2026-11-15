import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { openDb, pinDevicePrivate } from '../src/db.js'
import { recordBoxUsage, recordSessionUsage, readUsageHistory, SAMPLE_RETENTION_MS } from '../src/usage-history.js'

// Usage history: every reading of a weekly meter is filed under its account
// and weekly window, so a finished week keeps the last reading before its
// reset (unused = 100 − that) after device_status has moved on.

const H = 3600000
const D = 24 * H
const W = 7 * D
// A Monday 12:00 UTC reset.
const R0 = Date.UTC(2026, 0, 5, 12)
const iso = (ms) => new Date(ms).toISOString()
const week = (percent, resetAt, id = 'week_all', label = 'Week (all models)') =>
  ({ id, label, percent, ...(resetAt ? { resets_at: iso(resetAt) } : {}) })
const session = { id: 'session', label: 'Session', percent: 50, resets_at: iso(R0) }

async function setup() {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const a = createAgent(db, alice.id, 'box-a')
  const b = createAgent(db, alice.id, 'box-b')
  // Paired long before any reading in these tests.
  db.prepare('UPDATE devices SET created_at=1').run()
  const report = (dev, at, lines, email = 'alice@example.com') => recordBoxUsage(db, {
    userId: alice.id, deviceId: dev.deviceId, now: at,
    status: { limits: { as_of: at, lines }, ...(email ? { account: { email } } : {}) },
  })
  return { db, alice, a, b, report }
}

test('a finished week keeps its last reading; the week in progress is separate', async () => {
  const { db, alice, a, report } = await setup()
  report(a, R0 - 6 * D, [session, week(10, R0)])
  report(a, R0 - 2 * D, [week(55, R0)])
  report(a, R0 - 1 * H, [week(72, R0)])
  report(a, R0 + 1 * D, [week(8, R0 + W)])
  const out = readUsageHistory(db, alice.id, { now: R0 + 2 * D })
  assert.equal(out.accounts.length, 1)
  const acct = out.accounts[0]
  assert.equal(acct.key, 'claude:login:alice@example.com')
  assert.equal(acct.agent, 'claude')
  assert.equal(acct.email, 'alice@example.com')
  assert.deepEqual(acct.boxes, ['box-a'])
  // Weekly meters only: the session line is not history.
  assert.deepEqual(acct.meters.map((m) => m.id), ['week_all'])
  const m = acct.meters[0]
  assert.equal(m.primary, true)
  assert.deepEqual(m.windows, [{ resets_at: iso(R0), percent: 72, unused: 28, peak: 72, first_at: R0 - 6 * D, last_at: R0 - 1 * H }])
  assert.deepEqual(m.current, { resets_at: iso(R0 + W), percent: 8, unused: 92, as_of: R0 + 1 * D })
  assert.equal(m.average_unused, 28)
})

test('boxes on one login are one account; a stale box cannot lower the figure', async () => {
  const { db, alice, a, b, report } = await setup()
  // box-b prints the reset a minute early, as /usage text rounds.
  report(a, R0 - 3 * D, [week(40, R0)])
  report(b, R0 - 2 * D, [week(63, R0 - 60000)])
  // box-a reconnects with the reading it cached before box-b's.
  recordBoxUsage(db, {
    userId: alice.id, deviceId: a.deviceId, now: R0 - 1 * D,
    status: { limits: { as_of: R0 - 3 * D, lines: [week(40, R0)] }, account: { email: 'Alice@Example.com' } },
  })
  const out = readUsageHistory(db, alice.id, { now: R0 + H })
  assert.equal(out.accounts.length, 1)
  assert.deepEqual(out.accounts[0].boxes, ['box-a', 'box-b'])
  const [w] = out.accounts[0].meters[0].windows
  assert.equal(out.accounts[0].meters[0].windows.length, 1)
  assert.equal(w.percent, 63)
  assert.equal(w.unused, 37)
  assert.equal(w.last_at, R0 - 2 * D)
})

test('a box with no login is its own account, and model meters sit beside the main one', async () => {
  const { db, alice, a, b, report } = await setup()
  report(a, R0 - D, [week(30, R0), week(90, R0, 'week_fable', 'Week (Fable)')], null)
  report(b, R0 - D, [week(20, R0)], null)
  const out = readUsageHistory(db, alice.id, { now: R0 + H })
  assert.deepEqual(out.accounts.map((x) => x.key), [`claude:device:${a.deviceId}:1`, `claude:device:${b.deviceId}:1`])
  assert.equal('email' in out.accounts[0], false)
  assert.deepEqual(out.accounts[0].meters.map((m) => [m.id, m.primary, m.windows[0].unused]), [['week_all', true, 70], ['week_fable', false, 10]])
})

test('an untouched week (0% with no reset time) counts once the weekly rhythm is known', async () => {
  const { db, alice, a, report } = await setup()
  // No earlier window: there is nothing to place the reading in.
  assert.equal(report(a, R0 - 8 * D, [week(0, null)]), 0)
  report(a, R0 - D, [week(35, R0)])
  report(a, R0 + 2 * D, [week(0, null)])
  // Two weeks on, still untouched.
  report(a, R0 + W + D, [week(0, null)])
  // A zero placed by inference never replaces what the window already holds.
  report(a, R0 + W + D + H, [week(9, R0 + 2 * W)])
  assert.equal(report(a, R0 + W + D + 2 * H, [week(0, null)]), 0)
  // A non-zero reading with no reset time is never guessed at.
  assert.equal(report(a, R0 + W + 2 * D, [week(5, null)]), 0)
  const out = readUsageHistory(db, alice.id, { now: R0 + W + 3 * D })
  const m = out.accounts[0].meters[0]
  assert.deepEqual(m.windows.map((w) => [w.resets_at, w.unused]), [[iso(R0 + W), 100], [iso(R0), 65]])
  assert.equal(m.current.resets_at, iso(R0 + 2 * W))
  assert.equal(m.current.percent, 9)
  assert.equal(m.average_unused, 83)
})

test('a late old-week reading leaves the new week\'s hourly sample alone', async () => {
  const { db, alice, a, b, report } = await setup()
  // Two readings in one hour, either side of a reset twenty minutes in:
  // the new week's first, then the old week's arriving late.
  const m = 60000
  const R2 = R0
  report(a, R2 + 30 * m, [week(3, R2 + W + 20 * m)])
  report(b, R2 + 5 * m, [week(90, R2 + 20 * m)])
  assert.deepEqual(db.prepare('SELECT percent, reset_at FROM usage_samples WHERE user_id=? AND hour=?').all(alice.id, R2),
    [{ percent: 3, reset_at: R2 + W }])
})

test('readings that say nothing about a week are dropped', async () => {
  const { db, alice, a, report } = await setup()
  // Taken after its own reset: last week's text.
  assert.equal(report(a, R0 + H, [week(80, R0)]), 0)
  // A reset further out than any weekly window.
  assert.equal(report(a, R0, [week(80, R0 + 20 * D)]), 0)
  // A reading cached long ago.
  assert.equal(recordBoxUsage(db, {
    userId: alice.id, deviceId: a.deviceId, now: R0 + 30 * D,
    status: { limits: { as_of: R0 - D, lines: [week(80, R0)] } },
  }), 0)
  assert.deepEqual(readUsageHistory(db, alice.id, { now: R0 + 2 * H }).accounts, [])
})

test('weeks bounds how far back the read goes', async () => {
  const { db, alice, a, report } = await setup()
  for (let i = 0; i < 6; i++) report(a, R0 + i * W - H, [week(10 * i, R0 + i * W)])
  const now = R0 + 5 * W + H
  assert.equal(readUsageHistory(db, alice.id, { now }).accounts[0].meters[0].windows.length, 6)
  const two = readUsageHistory(db, alice.id, { now, weeks: 2 })
  assert.deepEqual(two.accounts[0].meters[0].windows.map((w) => w.percent), [50, 40])
})

test('hourly samples keep the highest reading and are pruned by age', async () => {
  const { db, alice, a, report } = await setup()
  const t = R0 - 3 * D
  report(a, t + 60000, [week(20, R0)])
  report(a, t + 30 * 60000, [week(26, R0)])
  report(a, t + H + 1, [week(27, R0)])
  const rows = db.prepare('SELECT hour, percent FROM usage_samples WHERE user_id=? ORDER BY hour').all(alice.id)
  assert.deepEqual(rows, [{ hour: t, percent: 26 }, { hour: t + H, percent: 27 }])
  const later = R0 + SAMPLE_RETENTION_MS
  report(a, later, [week(1, later + D)])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_samples WHERE user_id=?').get(alice.id).n, 1)
  // Windows are kept.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_windows WHERE user_id=?').get(alice.id).n, 2)
})

test("Codex's weekly meter comes from a session's status and is filed under the box", async () => {
  const { db, alice, a } = await setup()
  const lines = [
    { id: 'codex:codex:primary', label: 'Codex · 5-hour', percent: 70, resets_at: iso(R0 - 2 * D) },
    { id: 'codex:codex:secondary', label: 'Codex · Weekly', percent: 12, resets_at: iso(R0) },
  ]
  recordSessionUsage(db, { userId: alice.id, deviceId: a.deviceId, now: R0 - 3 * D, status: { limits: { as_of: R0 - 3 * D, lines } } })
  // A Claude session's status is not a second source for Claude's meters.
  assert.equal(recordSessionUsage(db, { userId: alice.id, deviceId: a.deviceId, now: R0 - 3 * D, status: { limits: { as_of: R0 - 3 * D, lines: [week(50, R0)] } } }), 0)
  const out = readUsageHistory(db, alice.id, { now: R0 + H })
  assert.equal(out.accounts.length, 1)
  assert.equal(out.accounts[0].key, `codex:device:${a.deviceId}:1`)
  assert.equal(out.accounts[0].agent, 'codex')
  assert.deepEqual(out.accounts[0].meters.map((m) => [m.id, m.windows[0].unused]), [['codex:codex:secondary', 88]])
})

test('a removed box\'s history is kept under no box\'s name, apart from a new box\'s', async () => {
  const { db, alice, b, report } = await setup()
  report(b, R0 - D, [week(30, R0)], null)
  recordSessionUsage(db, { userId: alice.id, deviceId: b.deviceId, now: R0 - D, status: { limits: { as_of: R0 - D, lines: [{ id: 'codex:codex:secondary', label: 'Codex · Weekly', percent: 5, resets_at: iso(R0) }] } } })
  // A removed box's id is never handed out again, so the next box starts
  // its own history.
  db.prepare('DELETE FROM devices WHERE id=?').run(b.deviceId)
  const c = createAgent(db, alice.id, 'box-c')
  assert.notEqual(c.deviceId, b.deviceId)
  db.prepare('UPDATE devices SET created_at=? WHERE id=?').run(R0 - 12 * H, c.deviceId)
  report(c, R0 - H, [week(80, R0)], null)
  const out = readUsageHistory(db, alice.id, { now: R0 + H })
  const claude = out.accounts.filter((x) => x.agent === 'claude')
  assert.deepEqual(claude.map((x) => [x.boxes, x.meters[0].windows[0].percent]), [[[], 30], [['box-c'], 80]])
  // The removed box's Codex history is kept, under no box's name.
  assert.deepEqual(out.accounts.filter((x) => x.agent === 'codex').map((x) => x.boxes), [[]])
})

test('Codex readings prune old samples too', async () => {
  const { db, alice, a, report } = await setup()
  report(a, R0 - D, [week(30, R0)])
  const later = R0 + SAMPLE_RETENTION_MS + 2 * D
  recordSessionUsage(db, { userId: alice.id, deviceId: a.deviceId, now: later, status: { limits: { as_of: later, lines: [{ id: 'codex:codex:secondary', label: 'Codex · Weekly', percent: 5, resets_at: iso(later + D) }] } } })
  assert.deepEqual(db.prepare('SELECT line_id FROM usage_samples WHERE user_id=?').all(alice.id), [{ line_id: 'codex:codex:secondary' }])
})

test('GET /usage/history serves clients and agents, hiding what only a private box reported', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const bob = await createUser(s.db, 'bob', 'pw')
  const open = createAgent(s.db, alice.id, 'box-a')
  const hidden = createAgent(s.db, alice.id, 'box-b')
  const bobBox = createAgent(s.db, bob.id, 'box-c')
  pinDevicePrivate(s.db, hidden.deviceId, true)
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  const now = Date.now()
  const reset = Math.round(now / H) * H + 2 * D
  const send = async (dev, email, percent) => {
    const ws = await makeWsClient(s.base, { token: dev.token, cursor: null })
    await ws.waitFor((f) => f.op === 'hello_ok')
    ws.send({ op: 'box_status', limits: { as_of: now, lines: [week(percent, reset)] }, account: { email } })
    ws.send({ op: 'activity', convo_id: 'none', state: 'nope' })
    await ws.waitFor((f) => f.op === 'error')
    ws.close()
  }
  await send(open, 'alice@example.com', 40)
  await send(hidden, 'private@example.com', 60)
  await send(bobBox, 'bob@example.com', 99)
  const mine = await s.http('/usage/history', { token: login.json.token })
  assert.equal(mine.status, 200)
  assert.equal(mine.json.weeks, 12)
  assert.deepEqual(mine.json.accounts.map((a) => [a.email, a.meters[0].current.percent]), [['alice@example.com', 40], ['private@example.com', 60]])
  const asAgent = await s.http('/usage/history?weeks=4', { token: open.token })
  assert.equal(asAgent.json.weeks, 4)
  assert.deepEqual(asAgent.json.accounts.map((a) => a.email), ['alice@example.com'])
  const asPrivate = await s.http('/usage/history', { token: hidden.token })
  assert.equal(asPrivate.json.accounts.length, 2)
  for (const bad of ['0', '105', 'x', '1.5']) assert.equal((await s.http(`/usage/history?weeks=${bad}`, { token: login.json.token })).status, 400)
  assert.equal((await s.http('/usage/history')).status, 401)
})
