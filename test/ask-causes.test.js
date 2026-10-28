import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCauses, parseCauses, causesFromFrame, CAUSE_KINDS, CAUSES_MAX, CAUSE_REF_MAX } from '../src/ask-causes.js'

test('normalizeCauses keeps a well-formed list as given', () => {
  assert.deepEqual(normalizeCauses([{ kind: 'user_message', ref: 'c1:12', at: 1 }]), [{ kind: 'user_message', ref: 'c1:12', at: 1 }])
  assert.deepEqual(normalizeCauses([{ kind: 'routine' }]), [{ kind: 'routine' }])
})

test('normalizeCauses: every kind in CAUSE_KINDS is accepted', () => {
  assert.equal(CAUSE_KINDS.length, 11)
  const list = CAUSE_KINDS.slice(0, CAUSES_MAX).map((kind) => ({ kind }))
  assert.deepEqual(normalizeCauses(list), list)
})

test('normalizeCauses: one entry of an unknown kind makes the whole list invalid', () => {
  assert.equal(normalizeCauses([{ kind: 'user_message', ref: 'c1:12' }, { kind: 'telepathy' }]), null)
  assert.equal(normalizeCauses([{ ref: 'c1:12' }]), null)
  assert.equal(normalizeCauses([null]), null)
  assert.equal(normalizeCauses(['user_message']), null)
})

test('normalizeCauses caps the list at 8 entries', () => {
  const eight = Array.from({ length: CAUSES_MAX }, (_, i) => ({ kind: 'room_message', ref: `r:${i}` }))
  assert.equal(normalizeCauses(eight).length, 8)
  assert.equal(normalizeCauses([...eight, { kind: 'room_message' }]), null)
})

test('normalizeCauses: a ref over 200 chars is invalid; a ref is flattened to one line', () => {
  assert.equal(CAUSE_REF_MAX, 200)
  assert.equal(normalizeCauses([{ kind: 'item_reply', ref: 'x'.repeat(201) }]), null)
  assert.deepEqual(normalizeCauses([{ kind: 'item_reply', ref: 'x'.repeat(200) }]), [{ kind: 'item_reply', ref: 'x'.repeat(200) }])
  assert.deepEqual(normalizeCauses([{ kind: 'item_reply', ref: 'it_1\ncomment' }]), [{ kind: 'item_reply', ref: 'it_1 comment' }])
  assert.equal(normalizeCauses([{ kind: 'item_reply', ref: 42 }]), null)
})

test('normalizeCauses: a non-array or an empty list is null', () => {
  for (const raw of [undefined, null, 'user_message', 7, { kind: 'user_message' }, []]) {
    assert.equal(normalizeCauses(raw), null, JSON.stringify(raw))
  }
})

test('normalizeCauses: a non-integer at is dropped, the entry kept', () => {
  assert.deepEqual(normalizeCauses([{ kind: 'reminder', ref: 'r1', at: 1.5 }]), [{ kind: 'reminder', ref: 'r1' }])
  assert.deepEqual(normalizeCauses([{ kind: 'reminder', at: '123' }]), [{ kind: 'reminder' }])
  assert.deepEqual(normalizeCauses([{ kind: 'reminder', at: 0 }]), [{ kind: 'reminder', at: 0 }])
  assert.deepEqual(normalizeCauses([{ kind: 'reminder', at: -1 }]), [{ kind: 'reminder' }])
  assert.deepEqual(normalizeCauses([{ kind: 'reminder', at: 2 ** 60 }]), [{ kind: 'reminder' }])
})

test('causesFromFrame: absent or null is no causes; anything else must normalise', () => {
  assert.deepEqual(causesFromFrame({}), { ok: true, causes: null })
  assert.deepEqual(causesFromFrame({ causes: null }), { ok: true, causes: null })
  assert.deepEqual(causesFromFrame({ causes: [{ kind: 'alert', ref: 'a' }] }), { ok: true, causes: [{ kind: 'alert', ref: 'a' }] })
  for (const causes of [[], 'alert', 0, false, [{ kind: 'telepathy' }]]) {
    assert.deepEqual(causesFromFrame({ causes }), { ok: false }, JSON.stringify(causes))
  }
})

test('parseCauses reads the stored JSON back, null for NULL or junk', () => {
  assert.deepEqual(parseCauses('[{"kind":"alert","ref":"a1","at":5}]'), [{ kind: 'alert', ref: 'a1', at: 5 }])
  assert.equal(parseCauses(null), null)
  assert.equal(parseCauses(''), null)
  assert.equal(parseCauses('not json'), null)
  assert.equal(parseCauses('[]'), null)
  assert.equal(parseCauses('{"kind":"alert"}'), null)
})
