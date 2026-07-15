import test from 'node:test'
import assert from 'node:assert/strict'
import { makePairStore, normalizeCode } from '../src/pairing.js'

test('start returns a well-formed pair and claim is pending until approve', () => {
  const store = makePairStore()
  const p = store.start()
  assert.match(p.pairCode, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$/)
  assert.match(p.pollToken, /^[0-9a-f]{64}$/)
  assert.equal(p.expiresIn, 600)
  assert.deepEqual(store.claim(p.pollToken), { status: 'pending' })
  assert.equal(store.size(), 1)
})

test('approve → claim returns identity exactly once, then not_found', () => {
  const store = makePairStore()
  const p = store.start()
  assert.equal(store.approve(p.pairCode, { userId: 7, agentName: 'dev-9' }), 'approved')
  const c = store.claim(p.pollToken)
  assert.deepEqual(c, { status: 'approved', userId: 7, agentName: 'dev-9' })
  assert.deepEqual(store.claim(p.pollToken), { status: 'not_found' })
  assert.equal(store.size(), 0)
})

test('approve normalizes user-typed codes (lowercase, hyphens, spaces)', () => {
  const store = makePairStore()
  const p = store.start()
  const sloppy = ` ${p.pairCode.toLowerCase().replace('-', ' ')} `
  assert.equal(store.approve(sloppy, { userId: 1, agentName: 'a' }), 'approved')
  assert.equal(normalizeCode('ab-cd 12'), 'ABCD12')
})

test('second approve of the same code is conflict; unknown code is not_found', () => {
  const store = makePairStore()
  const p = store.start()
  assert.equal(store.approve(p.pairCode, { userId: 1, agentName: 'a' }), 'approved')
  assert.equal(store.approve(p.pairCode, { userId: 2, agentName: 'b' }), 'conflict')
  // the winning approval is untouched by the losing one
  assert.deepEqual(store.claim(p.pollToken), { status: 'approved', userId: 1, agentName: 'a' })
  assert.equal(store.approve('ZZZZ-ZZZZ', { userId: 1, agentName: 'a' }), 'not_found')
})

test('expiry: approve and claim both see an expired pair as not_found', async () => {
  const store = makePairStore({ ttlMs: 20 })
  const p = store.start()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(store.approve(p.pairCode, { userId: 1, agentName: 'a' }), 'not_found')
  assert.deepEqual(store.claim(p.pollToken), { status: 'not_found' })
})

test('an approved-but-unclaimed pair also expires', async () => {
  const store = makePairStore({ ttlMs: 20 })
  const p = store.start()
  store.approve(p.pairCode, { userId: 1, agentName: 'a' })
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(store.claim(p.pollToken), { status: 'not_found' })
})

test('start records requesterIp; preview returns it with the remaining TTL, without mutating', () => {
  const store = makePairStore()
  const p = store.start({ requesterIp: '198.51.100.7' })
  const v = store.preview(p.pairCode)
  assert.equal(v.requesterIp, '198.51.100.7')
  assert.ok(v.expiresIn > 0 && v.expiresIn <= 600)
  // preview normalizes user-typed codes like approve does
  assert.deepEqual(store.preview(` ${p.pairCode.toLowerCase().replace('-', ' ')} `), v)
  // no mutation: the pair is still pending and approvable
  assert.deepEqual(store.claim(p.pollToken), { status: 'pending' })
  assert.equal(store.approve(p.pairCode, { userId: 1, agentName: 'a' }), 'approved')
})

test('start without args keeps working; preview then reports a null requesterIp', () => {
  const store = makePairStore()
  const p = store.start()
  assert.equal(store.preview(p.pairCode).requesterIp, null)
})

test('preview is null for unknown, expired, and already-approved pairs', async () => {
  const store = makePairStore({ ttlMs: 20 })
  assert.equal(store.preview('ZZZZ-ZZZZ'), null)
  const approved = store.start({ requesterIp: '10.0.0.1' })
  store.approve(approved.pairCode, { userId: 1, agentName: 'a' })
  assert.equal(store.preview(approved.pairCode), null)
  const expired = store.start({ requesterIp: '10.0.0.2' })
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(store.preview(expired.pairCode), null)
})

test('cap: start returns null at maxPending, and expired pairs free slots', async () => {
  const store = makePairStore({ ttlMs: 20, maxPending: 2 })
  assert.ok(store.start())
  assert.ok(store.start())
  assert.equal(store.start(), null)
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(store.start()) // sweep on start() reclaimed the expired slots
})
