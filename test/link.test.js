import test from 'node:test'
import assert from 'node:assert/strict'
import { makeLinkStore } from '../src/link.js'

test('start returns a well-formed session; status is waiting; poll is unknown until claim', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  assert.match(s.linkCode, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$/)
  assert.equal(s.expiresIn, 120)
  const st = store.status(10)
  assert.equal(st.status, 'waiting')
  assert.ok(st.expiresIn > 0 && st.expiresIn <= 120)
  assert.deepEqual(store.poll('f'.repeat(64)), { status: 'not_found' })
  assert.equal(store.size(), 1)
})

test('claim flips to claimed, records name+ip, issues a 256-bit token; poll is pending', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  const c = store.claim(s.linkCode, { deviceName: 'Pixel 9', requesterIp: '198.51.100.7' })
  assert.equal(c.status, 'claimed')
  assert.match(c.claimToken, /^[0-9a-f]{64}$/)
  assert.ok(c.expiresIn > 0)
  const st = store.status(10)
  assert.deepEqual(st, { status: 'claimed', deviceName: 'Pixel 9', requesterIp: '198.51.100.7', expiresIn: st.expiresIn })
  assert.deepEqual(store.poll(c.claimToken), { status: 'pending' })
})

test('claim normalizes user-typed codes (lowercase, hyphens, spaces)', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  const sloppy = ` ${s.linkCode.toLowerCase().replace('-', ' ')} `
  assert.equal(store.claim(sloppy, { deviceName: 'x' }).status, 'claimed')
})

test('first claim wins: second claim of the same code is conflict and mutates nothing', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  const c1 = store.claim(s.linkCode, { deviceName: 'first', requesterIp: '1.1.1.1' })
  const c2 = store.claim(s.linkCode, { deviceName: 'second', requesterIp: '2.2.2.2' })
  assert.deepEqual(c2, { status: 'conflict' })
  assert.equal(store.status(10).deviceName, 'first')
  assert.deepEqual(store.poll(c1.claimToken), { status: 'pending' })
})

test('approve → poll returns identity exactly once, then not_found (one-shot)', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  const c = store.claim(s.linkCode, { deviceName: 'Pixel 9' })
  assert.equal(store.approve(10, s.linkCode), 'approved')
  assert.deepEqual(store.poll(c.claimToken), { status: 'approved', userId: 7, deviceName: 'Pixel 9' })
  assert.deepEqual(store.poll(c.claimToken), { status: 'not_found' })
  assert.equal(store.size(), 0)
})

test('approve requires the claimed state: waiting is conflict, resolved is not_found-or-conflict', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  assert.equal(store.approve(10, s.linkCode), 'conflict') // nothing claimed yet
  const c = store.claim(s.linkCode, { deviceName: 'x' })
  assert.equal(store.approve(10, s.linkCode), 'approved')
  assert.equal(store.approve(10, s.linkCode), 'conflict') // already resolved
  store.poll(c.claimToken) // consumes the session
  assert.equal(store.approve(10, s.linkCode), 'not_found') // session gone
})

test('approve and deny are bound to the starter device and to the exact active code', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  store.claim(s.linkCode, { deviceName: 'x' })
  assert.equal(store.approve(99, s.linkCode), 'not_found') // other device, same user — no session
  assert.equal(store.approve(10, 'ZZZZ-ZZZZ'), 'not_found') // right device, wrong code
  assert.equal(store.deny(99, s.linkCode), 'not_found')
  assert.equal(store.approve(10, s.linkCode), 'approved')
})

test('deny → poll observes denied exactly once, then not_found', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  const c = store.claim(s.linkCode, { deviceName: 'x' })
  assert.equal(store.deny(10, s.linkCode), 'denied')
  assert.deepEqual(store.poll(c.claimToken), { status: 'denied' })
  assert.deepEqual(store.poll(c.claimToken), { status: 'not_found' })
  assert.equal(store.size(), 0)
})

test('deny works on a waiting session too; an approved session cannot be denied', () => {
  const store = makeLinkStore()
  const s = store.start(10, 7)
  assert.equal(store.deny(10, s.linkCode), 'denied') // waiting → denied
  const s2 = store.start(11, 7)
  const c2 = store.claim(s2.linkCode, { deviceName: 'x' })
  store.approve(11, s2.linkCode)
  assert.equal(store.deny(11, s2.linkCode), 'not_found') // approved is already resolved
  assert.equal(store.poll(c2.claimToken).status, 'approved') // deny attempt mutated nothing
})

test('one active session per starter: a new start replaces the old one', () => {
  const store = makeLinkStore()
  const s1 = store.start(10, 7)
  const s2 = store.start(10, 7)
  assert.equal(store.size(), 1)
  assert.deepEqual(store.claim(s1.linkCode, { deviceName: 'x' }), { status: 'not_found' })
  assert.equal(store.claim(s2.linkCode, { deviceName: 'x' }).status, 'claimed')
})

test('expiry: claim, poll, status, approve all see an expired session as gone', async () => {
  const store = makeLinkStore({ ttlMs: 20, claimExtensionMs: 0 })
  const s = store.start(10, 7)
  const c = store.claim(s.linkCode, { deviceName: 'x' })
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(store.poll(c.claimToken), { status: 'not_found' })
  assert.equal(store.status(10), null)
  assert.equal(store.approve(10, s.linkCode), 'not_found')
  assert.deepEqual(store.claim(s.linkCode, { deviceName: 'x' }), { status: 'not_found' })
})

test('claim extends the TTL to at least claimExtensionMs from now', async () => {
  // Generous margins so a setTimeout overshoot can't turn this into a flake:
  // the claim lands well inside the 150ms TTL, and the second sleep lands
  // well past the ORIGINAL expiry but far from the 5s extension.
  const store = makeLinkStore({ ttlMs: 150, claimExtensionMs: 5000 })
  const s = store.start(10, 7)
  await new Promise((r) => setTimeout(r, 50))
  const c = store.claim(s.linkCode, { deviceName: 'x' })
  assert.equal(c.status, 'claimed')
  await new Promise((r) => setTimeout(r, 150)) // past the ORIGINAL expiry
  assert.deepEqual(store.poll(c.claimToken), { status: 'pending' }) // still alive: extension applied
  assert.equal(store.approve(10, s.linkCode), 'approved')
})

test('claim never shortens a longer remaining TTL', () => {
  const store = makeLinkStore({ ttlMs: 120000, claimExtensionMs: 60000 })
  const s = store.start(10, 7)
  const c = store.claim(s.linkCode, { deviceName: 'x' })
  // full 120s remained at claim; max(remaining, now+60s) keeps ~120s
  assert.ok(c.expiresIn > 60, `expiresIn ${c.expiresIn} should reflect the untouched 120s TTL`)
})

test('cap: start returns null at maxPending; expired sessions free slots; replacement is exempt', async () => {
  const store = makeLinkStore({ ttlMs: 20, maxPending: 2 })
  assert.ok(store.start(1, 7))
  assert.ok(store.start(2, 7))
  assert.equal(store.start(3, 7), null) // cap hit
  assert.ok(store.start(1, 7)) // same starter replaces its own — never blocked by the cap
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(store.start(3, 7)) // sweep reclaimed the expired slots
})

test('preapproved: claim jumps straight to approved — first poll releases the identity, once', () => {
  const links = makeLinkStore()
  const r = links.startPreapproved(42)
  assert.match(r.linkCode, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$/)
  assert.equal(r.expiresIn, 600) // pairing-store pacing, not the 120 s link TTL

  const c = links.claim(r.linkCode, { deviceName: 'First Phone' })
  assert.equal(c.status, 'claimed') // same shape the claimant flow already handles
  const p = links.poll(c.claimToken)
  assert.deepEqual(p, { status: 'approved', userId: 42, deviceName: 'First Phone' })
  assert.deepEqual(links.poll(c.claimToken), { status: 'not_found' }) // one-shot
})

test('preapproved: first claim wins; a later claim of the used code conflicts', () => {
  const links = makeLinkStore()
  const r = links.startPreapproved(42)
  links.claim(r.linkCode, { deviceName: 'x' })
  assert.deepEqual(links.claim(r.linkCode, { deviceName: 'y' }), { status: 'conflict' })
})

test('preapproved: expires on its own 10-minute clock', async () => {
  const links = makeLinkStore({ preapprovedTtlMs: 30 })
  const r = links.startPreapproved(42)
  await new Promise((res) => setTimeout(res, 60))
  assert.deepEqual(links.claim(r.linkCode, { deviceName: 'x' }), { status: 'not_found' })
})

test('preapproved sessions count toward maxPending and coexist with normal ones', () => {
  const links = makeLinkStore({ maxPending: 2 })
  assert.ok(links.startPreapproved(1))
  assert.ok(links.start(7, 1)) // normal session, starter device 7
  assert.equal(links.startPreapproved(1), null) // capped
  assert.equal(links.size(), 2)
})
