import test from 'node:test'
import assert from 'node:assert/strict'
import argon2 from 'argon2'
import { openDb } from '../src/db.js'
import {
  createUser, login, createAgent, authToken, revokeDevice,
  authorize, makeRateLimiter, makeLoginGuard, setPassword,
} from '../src/auth.js'

test('login issues a device token; authToken resolves it', async () => {
  const db = openDb(':memory:')
  await createUser(db, 'dan', 'hunter22')
  assert.equal(await login(db, { username: 'dan', password: 'wrong', deviceName: 'x' }), null)
  const s = await login(db, { username: 'dan', password: 'hunter22', deviceName: 'phone' })
  assert.match(s.token, /^[0-9a-f]{64}$/)
  const who = authToken(db, s.token)
  assert.equal(who.kind, 'client')
  assert.equal(who.userId, s.userId)
  revokeDevice(db, s.deviceId)
  assert.equal(authToken(db, s.token), null)
})

test('agent tokens and authorize owner check', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw1')
  const pat = await createUser(db, 'pat', 'pw2')
  const a = createAgent(db, dan.id, 'dev-2')
  assert.equal(authToken(db, a.token).kind, 'agent')
  db.prepare("INSERT INTO conversations(id, owner_user_id, created_at) VALUES('c1',?,0)").run(dan.id)
  assert.equal(authorize(db, dan.id, 'c1'), true)
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
  await createUser(db, 'dan', 'pw')
  await assert.rejects(() => createUser(db, 'dan', 'pw2'), /UNIQUE/)
})

test('setPassword rotates the password and rejects unknown users', async () => {
  const db = openDb(':memory:')
  await createUser(db, 'dan', 'oldpw')
  await setPassword(db, 'dan', 'newpw')
  assert.equal(await login(db, { username: 'dan', password: 'oldpw', deviceName: 'x' }), null)
  assert.notEqual(await login(db, { username: 'dan', password: 'newpw', deviceName: 'x' }), null)
  await assert.rejects(() => setPassword(db, 'nobody', 'pw'), /no such user/)
})

test('login guard locks at threshold, isolates usernames, and doubles the lockout', async () => {
  const g = makeLoginGuard({ threshold: 3, baseMs: 50, capMs: 60000 })
  g.fail('dan')
  g.fail('dan')
  assert.equal(g.check('dan').allowed, true) // 2 fails < threshold
  g.fail('dan') // 3rd consecutive failure -> locked for baseMs
  const locked = g.check('dan')
  assert.equal(locked.allowed, false)
  assert.ok(locked.retryAfterMs > 0 && locked.retryAfterMs <= 50)
  assert.equal(g.check('pat').allowed, true) // other usernames unaffected
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(g.check('dan').allowed, true) // lock expired
  g.fail('dan') // 4th failure -> lockout doubles (baseMs * 2)
  const relocked = g.check('dan')
  assert.equal(relocked.allowed, false)
  assert.ok(relocked.retryAfterMs > 50, `expected doubled lockout, got ${relocked.retryAfterMs}ms`)
})

test('login guard lockout caps at capMs and success resets the count', () => {
  const g = makeLoginGuard({ threshold: 1, baseMs: 10, capMs: 40 })
  for (let i = 0; i < 10; i++) g.fail('dan') // 10 * doubling would be ~5s uncapped
  const locked = g.check('dan')
  assert.equal(locked.allowed, false)
  assert.ok(locked.retryAfterMs <= 40, `lockout ${locked.retryAfterMs}ms exceeds cap`)
  g.ok('dan') // successful login clears failures and any lock
  assert.equal(g.check('dan').allowed, true)
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
  await createUser(db, 'dan', 'hunter22')
  const verifySpy = t.mock.method(argon2, 'verify')

  assert.equal(await login(db, { username: 'dan', password: 'wrong', deviceName: 'x' }), null)
  assert.equal(await login(db, { username: 'ghost', password: 'wrong', deviceName: 'x' }), null)
  // One argon2.verify per attempt — the unknown user is not fast-pathed
  // (previously it returned null before ever hashing, a measurable timing
  // difference an attacker could use to enumerate valid usernames).
  assert.equal(verifySpy.mock.callCount(), 2)

  // A correct password for a known user still authenticates normally.
  assert.notEqual(await login(db, { username: 'dan', password: 'hunter22', deviceName: 'x' }), null)
})

test('rate limiter window actually expires', async () => {
  const rl = makeRateLimiter({ max: 2, windowMs: 50 })
  assert.equal(rl.allow('k'), true)
  assert.equal(rl.allow('k'), true)
  assert.equal(rl.allow('k'), false)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(rl.allow('k'), true)
})
