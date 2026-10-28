import test from 'node:test'
import assert from 'node:assert/strict'
import argon2 from 'argon2'
import { openDb } from '../src/db.js'
import {
  createUser, login, createAgent, authToken, revokeDevice,
  authorize, makeRateLimiter, makeLoginGuard, setPassword, changePassword, makeKeyedQueue,
} from '../src/auth.js'

test('login issues a device token; authToken resolves it', async () => {
  const db = openDb(':memory:')
  await createUser(db, 'alice', 'hunter22')
  assert.equal(await login(db, { username: 'alice', password: 'wrong', deviceName: 'x' }), null)
  const s = await login(db, { username: 'alice', password: 'hunter22', deviceName: 'phone' })
  assert.match(s.token, /^[0-9a-f]{64}$/)
  const who = authToken(db, s.token)
  assert.equal(who.kind, 'client')
  assert.equal(who.userId, s.userId)
  revokeDevice(db, s.deviceId)
  assert.equal(authToken(db, s.token), null)
})

test('agent tokens and authorize owner check', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw1')
  const pat = await createUser(db, 'pat', 'pw2')
  const a = createAgent(db, alice.id, 'box-2')
  assert.equal(authToken(db, a.token).kind, 'agent')
  db.prepare("INSERT INTO conversations(id, owner_user_id, created_at) VALUES('c1',?,0)").run(alice.id)
  assert.equal(authorize(db, alice.id, 'c1'), true)
  assert.equal(authorize(db, pat.id, 'c1'), false)
})

test('rate limiter blocks 6th attempt in window', () => {
  const rl = makeRateLimiter({ max: 5, windowMs: 60000 })
  for (let i = 0; i < 5; i++) assert.equal(rl.allow('1.2.3.4'), true)
  assert.equal(rl.allow('1.2.3.4'), false)
  assert.equal(rl.allow('5.6.7.8'), true)
})

test('createUser throws on duplicate name', async () => {
  const db = openDb(':memory:')
  await createUser(db, 'alice', 'pw')
  await assert.rejects(() => createUser(db, 'alice', 'pw2'), /UNIQUE/)
})

test('setPassword rotates the password and rejects unknown users', async () => {
  const db = openDb(':memory:')
  await createUser(db, 'alice', 'oldpw')
  await setPassword(db, 'alice', 'newpw')
  assert.equal(await login(db, { username: 'alice', password: 'oldpw', deviceName: 'x' }), null)
  assert.notEqual(await login(db, { username: 'alice', password: 'newpw', deviceName: 'x' }), null)
  await assert.rejects(() => setPassword(db, 'nobody', 'pw'), /no such user/)
})

test('login guard locks at threshold, isolates usernames, and doubles the lockout', async () => {
  const g = makeLoginGuard({ threshold: 3, baseMs: 50, capMs: 60000 })
  g.fail('alice')
  g.fail('alice')
  assert.equal(g.check('alice').allowed, true) // 2 fails < threshold
  g.fail('alice') // 3rd consecutive failure -> locked for baseMs
  const locked = g.check('alice')
  assert.equal(locked.allowed, false)
  assert.ok(locked.retryAfterMs > 0 && locked.retryAfterMs <= 50)
  assert.equal(g.check('pat').allowed, true) // other usernames unaffected
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(g.check('alice').allowed, true) // lock expired
  g.fail('alice') // 4th failure -> lockout doubles (baseMs * 2)
  const relocked = g.check('alice')
  assert.equal(relocked.allowed, false)
  assert.ok(relocked.retryAfterMs > 50, `expected doubled lockout, got ${relocked.retryAfterMs}ms`)
})

test('login guard lockout caps at capMs and success resets the count', () => {
  const g = makeLoginGuard({ threshold: 1, baseMs: 10, capMs: 40 })
  for (let i = 0; i < 10; i++) g.fail('alice') // 10 * doubling would be ~5s uncapped
  const locked = g.check('alice')
  assert.equal(locked.allowed, false)
  assert.ok(locked.retryAfterMs <= 40, `lockout ${locked.retryAfterMs}ms exceeds cap`)
  g.ok('alice') // successful login clears failures and any lock
  assert.equal(g.check('alice').allowed, true)
})

// NOTE: this test must run BEFORE any other test in this file (= this
// process) performs an unknown-username login — it asserts the dummy hash
// was precomputed at module load, and a lazily-minted hash would already be
// cached by an earlier unknown-username attempt, hiding the regression.
test('dummy hash is precomputed at module load: the first unknown-username login pays no lazy argon2.hash', async (t) => {
  const db = openDb(':memory:')
  const hashSpy = t.mock.method(argon2, 'hash')
  const verifySpy = t.mock.method(argon2, 'verify')
  assert.equal(await login(db, { username: 'first-ever-ghost', password: 'x', deviceName: 'd' }), null)
  assert.equal(verifySpy.mock.callCount(), 1)
  // A lazily-computed dummy hash would make the FIRST unknown-username
  // attempt after boot pay hash+verify (~2x the timing of later ones) — a
  // one-shot user-enumeration oracle. Precomputed at load, so no hash here.
  assert.equal(hashSpy.mock.callCount(), 0,
    'dummy hash must be precomputed at module load, not minted lazily on first use')
})

test('login closes the user-enumeration timing oracle: an unknown username still runs one argon2.verify', async (t) => {
  const db = openDb(':memory:')
  await createUser(db, 'alice', 'hunter22')
  const verifySpy = t.mock.method(argon2, 'verify')

  assert.equal(await login(db, { username: 'alice', password: 'wrong', deviceName: 'x' }), null)
  assert.equal(await login(db, { username: 'ghost', password: 'wrong', deviceName: 'x' }), null)
  // One argon2.verify per attempt — the unknown user is not fast-pathed
  // (previously it returned null before ever hashing, a measurable timing
  // difference an attacker could use to enumerate valid usernames).
  assert.equal(verifySpy.mock.callCount(), 2)

  // A correct password for a known user still authenticates normally.
  assert.notEqual(await login(db, { username: 'alice', password: 'hunter22', deviceName: 'x' }), null)
})

test('rate limiter window actually expires', async () => {
  const rl = makeRateLimiter({ max: 2, windowMs: 50 })
  assert.equal(rl.allow('k'), true)
  assert.equal(rl.allow('k'), true)
  assert.equal(rl.allow('k'), false)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(rl.allow('k'), true)
})

test('changePassword: a check made stale by a concurrent change does not overwrite it', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'hunter22')
  const mac = await login(db, { username: 'alice', password: 'hunter22', deviceName: 'mac' })
  const phone = await login(db, { username: 'alice', password: 'hunter22', deviceName: 'phone' })
  // Both verify the same old hash before either writes.
  const [a, b] = await Promise.all([
    changePassword(db, alice.id, { oldPassword: 'hunter22', newPassword: 'mac-new-pw-1', deviceId: mac.deviceId, signOutOthers: true }),
    changePassword(db, alice.id, { oldPassword: 'hunter22', newPassword: 'phone-new-pw', deviceId: phone.deviceId, signOutOthers: true }),
  ])
  const oks = [a, b].filter((r) => r.ok)
  assert.equal(oks.length, 1, 'exactly one change lands')
  const loser = a.ok ? b : a
  assert.equal(loser.revoked, true, 'the loser was signed out by the winner')
  const winner = a.ok ? 'mac-new-pw-1' : 'phone-new-pw'
  assert.ok(await login(db, { username: 'alice', password: winner, deviceName: 'x' }))
})

test('changePassword: without sign-out, a stale check loses the compare-and-swap', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'hunter22')
  const mac = await login(db, { username: 'alice', password: 'hunter22', deviceName: 'mac' })
  const phone = await login(db, { username: 'alice', password: 'hunter22', deviceName: 'phone' })
  const [a, b] = await Promise.all([
    changePassword(db, alice.id, { oldPassword: 'hunter22', newPassword: 'mac-new-pw-1', deviceId: mac.deviceId }),
    changePassword(db, alice.id, { oldPassword: 'hunter22', newPassword: 'phone-new-pw', deviceId: phone.deviceId }),
  ])
  assert.deepEqual([a.ok, b.ok].sort(), [false, true])
  assert.equal((a.ok ? b : a).revoked, undefined)
})

test('makeKeyedQueue runs one job per key at a time, keys independently, and survives a throwing job', async () => {
  const q = makeKeyedQueue()
  const log = []
  const job = (name, ms) => async () => { log.push(`${name}+`); await new Promise((r) => setTimeout(r, ms)); log.push(`${name}-`); return name }
  const boom = q.run(1, async () => { throw new Error('boom') })
  const r = await Promise.all([q.run(1, job('a', 20)), q.run(1, job('b', 1)), q.run(2, job('c', 1))])
  await assert.rejects(boom, /boom/)
  assert.deepEqual(r, ['a', 'b', 'c'])
  assert.ok(log.indexOf('a-') < log.indexOf('b+'), 'b waits for a')
  assert.ok(log.indexOf('c-') < log.indexOf('a-'), 'key 2 does not wait for key 1')
})
