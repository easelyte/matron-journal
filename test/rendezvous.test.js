import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRendezvousStore } from '../src/rendezvous.js'

const BOX = 'q4Jc0FZKpQ2example_opaque_base64url_box_value'

test('create returns a 26-char alphabet rid, 256-bit hex secret, and expiry seconds', () => {
  const store = makeRendezvousStore()
  const r = store.create()
  assert.match(r.rid, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{26}$/)
  assert.match(r.secret, /^[0-9a-f]{64}$/)
  assert.equal(r.expiresIn, 180)
  assert.notEqual(store.create().rid, r.rid)
  assert.equal(store.size(), 2)
})

test('lifecycle: waiting → first box wins → offered survives repeat polls; second box conflicts', () => {
  const store = makeRendezvousStore()
  const { rid, secret } = store.create()
  assert.deepEqual(store.poll(rid, secret), { status: 'waiting' })
  assert.equal(store.offer(rid, BOX), 'offered')
  assert.deepEqual(store.poll(rid, secret), { status: 'offered', box: BOX })
  // NOT one-shot: a dropped poll response must be retryable until TTL
  assert.deepEqual(store.poll(rid, secret), { status: 'offered', box: BOX })
  assert.equal(store.offer(rid, 'a-different-box'), 'conflict')
  // the conflict must not have overwritten the first box
  assert.equal(store.poll(rid, secret).box, BOX)
})

test('unknown rid: offer and poll are not_found', () => {
  const store = makeRendezvousStore()
  assert.equal(store.offer('Z'.repeat(26), BOX), 'not_found')
  assert.deepEqual(store.poll('Z'.repeat(26), 'f'.repeat(64)), { status: 'not_found' })
})

test('wrong secret is forbidden and leaks nothing (waiting and offered look identical)', () => {
  const store = makeRendezvousStore()
  const { rid } = store.create()
  assert.deepEqual(store.poll(rid, 'f'.repeat(64)), { status: 'forbidden' })
  store.offer(rid, BOX)
  assert.deepEqual(store.poll(rid, 'f'.repeat(64)), { status: 'forbidden' })
  assert.deepEqual(store.poll(rid, 'short'), { status: 'forbidden' })
})

test('expiry: entries die at TTL for offer and poll, and sweep() removes them', async () => {
  const store = makeRendezvousStore({ ttlMs: 20 })
  const { rid, secret } = store.create()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(store.offer(rid, BOX), 'not_found')
  assert.deepEqual(store.poll(rid, secret), { status: 'not_found' })
  store.create()
  store.sweep()
  assert.equal(store.size(), 1)
})

test('maxPending caps creation; expiry frees capacity', async () => {
  const store = makeRendezvousStore({ ttlMs: 20, maxPending: 1 })
  assert.ok(store.create())
  assert.equal(store.create(), null)
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(store.create(), 'sweep-on-create frees the expired slot')
})
