import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import {
  createUser, login, createAgent, authToken, revokeDevice,
  authorize, makeRateLimiter,
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
