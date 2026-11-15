// step_up and subject on items and comments: the marking an agent puts on a
// question whose tap must be signed with an approval key (the enforcement is
// a later task). An owner with no active key gets an ordinary item.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { validateItemFields, listSharedComments, listGrantedComments, grantedItemsExport } from '../src/items.js'
import { createMission } from '../src/missions.js'
import { startWithKey, startApprovalServer, signIn, signAccount, signTap, signForTest, TEST_JOURNAL } from './approval-helpers.js'

async function world(t, withKey = true) {
  const base = await (withKey ? startWithKey(t) : startApprovalServer(t))
  const box = createAgent(base.s.db, base.alice.id, 'box-a')
  upsertConversation(base.s.db, { id: 'c1', ownerUserId: base.alice.id, title: 'C1', agentDeviceId: box.deviceId })
  const agent = (p, opts = {}) => base.s.http(p, { token: box.token, ...opts })
  const post = (body) => ({ method: 'POST', body })
  return { ...base, box, agent, post }
}
const ask = (extra) => ({ convo_id: 'c1', kind: 'question', title: 'Wire it?', actions: ['Approve', 'Deny'], ...extra })
const SUBJECT = { payee: 'Acme', amount: '12.00' }

test('validateItemFields: step_up is a boolean, subject a flat string map needing step_up', () => {
  assert.equal(validateItemFields({ title: 't', step_up: true, subject: SUBJECT }).ok, true)
  assert.deepEqual(validateItemFields({ title: 't', step_up: true, subject: SUBJECT }).value.subject, SUBJECT)
  assert.equal(validateItemFields({ title: 't', step_up: 'yes' }).ok, false)
  const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, 'v']))
  for (const bad of [many, { a: 1 }, { a: 'x'.repeat(201) }, [], 'x', null]) {
    assert.equal(validateItemFields({ title: 't', step_up: true, subject: bad }).error, 'invalid_subject', JSON.stringify(bad))
  }
  assert.equal(validateItemFields({ title: 't', subject: SUBJECT }).error, 'invalid_subject')
  assert.equal(validateItemFields({ title: 't', step_up: false, subject: SUBJECT }).error, 'invalid_subject')
})

test('an item created with step_up and a subject round-trips', async (t) => {
  const w = await world(t)
  const c = await w.agent('/items', w.post(ask({ step_up: true, subject: SUBJECT })))
  assert.equal(c.status, 201, JSON.stringify(c.json))
  assert.equal(c.json.item.step_up, true)
  assert.equal(c.json.step_up_ignored, undefined)
  const got = await w.s.http(`/items/${c.json.item.num}`, { token: w.token })
  assert.equal(got.json.item.step_up, true)
  assert.deepEqual(got.json.item.subject, SUBJECT)
  const plain = await w.agent('/items', w.post(ask()))
  assert.equal(plain.json.item.step_up, false)
  assert.equal(plain.json.item.subject, null)
})

test('step_up with no subject is allowed; subject without step_up and 13 keys are invalid_subject', async (t) => {
  const w = await world(t)
  const bare = await w.agent('/items', w.post(ask({ step_up: true })))
  assert.equal(bare.status, 201)
  assert.equal(bare.json.item.subject, null)
  const noStep = await w.agent('/items', w.post(ask({ subject: SUBJECT })))
  assert.deepEqual([noStep.status, noStep.json.error], [400, 'invalid_subject'])
  const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, 'v']))
  const r = await w.agent('/items', w.post(ask({ step_up: true, subject: many })))
  assert.deepEqual([r.status, r.json.error], [400, 'invalid_subject'])
})

test('a notice cannot be step-up', async (t) => {
  const w = await world(t)
  const r = await w.agent('/items', w.post({ convo_id: 'c1', kind: 'notice', title: 'FYI', step_up: true }))
  assert.deepEqual([r.status, r.json.error], [400, 'invalid_actions'])
})

test('an owner with no active key gets an ordinary item and step_up_ignored', async (t) => {
  const w = await world(t, false)
  const r = await w.agent('/items', w.post(ask({ step_up: true, subject: SUBJECT })))
  assert.equal(r.status, 201)
  assert.equal(r.json.step_up_ignored, true)
  assert.equal(r.json.item.step_up, false)
  assert.equal(r.json.item.subject, null)
  const row = w.s.db.prepare('SELECT step_up, subject FROM items WHERE id=?').get(r.json.item.id)
  assert.deepEqual({ ...row }, { step_up: 0, subject: null })
  const c = await w.agent(`/items/${r.json.item.id}/comments`, w.post({ body: 'again?', actions: ['Yes'], step_up: true }))
  assert.equal(c.status, 201)
  assert.equal(c.json.step_up_ignored, true)
  assert.equal(c.json.comment.step_up, false)
})

test('PATCH raises step_up with a subject; a signed step_up:false clears the subject', async (t) => {
  const w = await world(t)
  const id = (await w.agent('/items', w.post(ask()))).json.item.id
  const patch = (body) => w.agent(`/items/${id}`, { method: 'PATCH', body })
  assert.equal((await patch({ subject: SUBJECT })).json.error, 'invalid_subject') // not step-up yet
  const on = await patch({ step_up: true, subject: SUBJECT })
  assert.deepEqual([on.json.item.step_up, on.json.item.subject], [true, SUBJECT])
  const approval = await signAccount(w.s, { token: w.token, key: w.key, subject: { op: 'item_step_up', item: id, on: 'false' } })
  const off = await w.s.http(`/items/${id}`, { method: 'PATCH', token: w.token, body: { step_up: false, approval } })
  assert.deepEqual([off.status, off.json.item.step_up, off.json.item.subject], [200, false, null])
})

test('a comment with actions and step_up round-trips; step_up needs actions', async (t) => {
  const w = await world(t)
  const id = (await w.agent('/items', w.post(ask()))).json.item.id
  const c = await w.agent(`/items/${id}/comments`, w.post({ body: 'Really?', actions: ['Yes', 'No'], step_up: true, subject: SUBJECT }))
  assert.equal(c.status, 201, JSON.stringify(c.json))
  assert.equal(c.json.comment.step_up, true)
  assert.deepEqual(c.json.comment.subject, SUBJECT)
  assert.equal(c.json.comment.approval, null)
  const list = await w.s.http(`/items/${id}`, { token: w.token })
  const mine = list.json.comments.find((x) => x.id === c.json.comment.id)
  assert.equal(mine?.step_up, true)
  const bad = await w.agent(`/items/${id}/comments`, w.post({ body: 'no buttons', step_up: true }))
  assert.deepEqual([bad.status, bad.json.error], [400, 'invalid_actions'])
  const noStep = await w.agent(`/items/${id}/comments`, w.post({ body: 'x', actions: ['A'], subject: SUBJECT }))
  assert.equal(noStep.json.error, 'invalid_subject')
})

test('shared and granted reads show no step_up, subject or approval: the marking is the owner\'s, as on the federated wire', async (t) => {
  const w = await world(t)
  const { db } = w.s
  const item = (await w.agent('/items', w.post(ask({ step_up: true, subject: SUBJECT })))).json.item
  const c = (await w.agent(`/items/${item.id}/comments`, w.post({ body: 'Really?', actions: ['Yes'], step_up: true, subject: SUBJECT }))).json.comment
  db.prepare('UPDATE item_comments SET approval=? WHERE id=?').run(JSON.stringify({ statement: 's', signature: 'g' }), c.id)
  const owner = (await w.s.http(`/items/${item.id}`, { token: w.token })).json
  const own = owner.comments.find((x) => x.id === c.id)
  assert.deepEqual(own.approval, { statement: 's', signature: 'g' }, 'the owner sees it')
  assert.deepEqual([own.step_up, own.subject], [true, SUBJECT])
  assert.deepEqual([owner.item.step_up, owner.item.subject], [true, SUBJECT])
  for (const list of [listSharedComments(db, item.id), listGrantedComments(db, item.id)]) {
    const seen = list.find((x) => x.id === c.id)
    assert.ok(seen)
    assert.deepEqual([seen.approval, seen.step_up, seen.subject], [null, false, null])
  }
  // The item itself, as a grant shows it (and a copy on another journal is
  // built from).
  const { mission } = createMission(db, { userId: w.alice.id, deviceId: w.box.deviceId, createdBy: 'agent', convoId: 'c1', title: 'M', attach: false })
  db.prepare('UPDATE items SET mission_id=? WHERE id=?').run(mission.id, item.id)
  const [exported] = grantedItemsExport(db, mission.id, { only: item.id })
  assert.deepEqual([exported.item.step_up, exported.item.subject], [false, null])
  const comment = exported.comments.find((x) => x.id === c.id)
  assert.deepEqual([comment.step_up, comment.subject, comment.approval], [false, null, null])
})

// Lowering the mark (step_up:false) or changing the subject of a step-up
// item on an account with an approval key: a client needs a signed
// {op:'item_step_up'}, an agent must be the box that filed the item.
const lower = { op: 'item_step_up', on: 'false' }

test('a keyless second client cannot switch step_up off and then tap unsigned', async (t) => {
  const w = await world(t)
  const item = (await w.agent('/items', w.post(ask({ step_up: true, subject: SUBJECT })))).json.item
  const laptop = signIn(w.s, w.alice.id, 'laptop')
  const patch = (body) => w.s.http(`/items/${item.id}`, { method: 'PATCH', token: laptop.token, body })
  const off = await patch({ step_up: false })
  assert.deepEqual([off.status, off.json], [403, { error: 'approval_required' }])
  const row = w.s.db.prepare('SELECT step_up, subject FROM items WHERE id=?').get(item.id)
  assert.deepEqual({ ...row }, { step_up: 1, subject: JSON.stringify(SUBJECT) })
  // Along with an ordinary field, nothing is written either.
  const both = await patch({ title: 'Changed', step_up: false })
  assert.equal(both.status, 403)
  assert.equal(w.s.db.prepare('SELECT title FROM items WHERE id=?').get(item.id).title, 'Wire it?')
  const tap = await w.s.http(`/items/${item.id}/comments`, { method: 'POST', token: laptop.token, body: { action: 'Approve' } })
  assert.deepEqual([tap.status, tap.json.error], [403, 'approval_required'])
  // A client never changes a step-up item's subject, signed or not.
  const sub = await patch({ subject: { payee: 'Mallory' } })
  assert.deepEqual([sub.status, sub.json.error], [400, 'invalid_subject'])
  const again = await patch({ step_up: true, subject: { payee: 'Mallory' } })
  assert.deepEqual([again.status, again.json.error], [400, 'invalid_subject'])
  // Raising, or re-sending the mark with no subject, stays open.
  const same = await patch({ step_up: true })
  assert.equal(same.status, 200)
  assert.equal(same.json.item.step_up, true)
})

test('a client lowers step_up with a signed item_step_up; the subject then changes with a fresh raise', async (t) => {
  const w = await world(t)
  const item = (await w.agent('/items', w.post(ask({ step_up: true, subject: SUBJECT })))).json.item
  const patch = (body) => w.s.http(`/items/${item.id}`, { method: 'PATCH', token: w.token, body })
  const wrong = await signAccount(w.s, { token: w.token, key: w.key, subject: { ...lower, item: 'it_other' } })
  const bad = await patch({ step_up: false, approval: wrong })
  assert.deepEqual([bad.status, bad.json], [400, { error: 'approval_invalid', reason: 'mismatch' }])
  // A statement for another item is a mismatch; one for this item lowers it.
  const approval = await signAccount(w.s, { token: w.token, key: w.key, subject: { ...lower, item: item.id } })
  const off = await patch({ step_up: false, approval })
  assert.equal(off.status, 200, JSON.stringify(off.json))
  assert.deepEqual([off.json.item.step_up, off.json.item.subject], [false, null])
  const replay = await patch({ step_up: false, approval })
  assert.equal(replay.status, 200, 'not step-up any more: an ordinary patch')
  const on = await patch({ step_up: true, subject: { payee: 'Other' } })
  assert.equal(on.status, 200)
  assert.deepEqual(on.json.item.subject, { payee: 'Other' })
  // The unsigned tap is still refused on the re-raised item.
  const tap = await w.s.http(`/items/${item.id}/comments`, { method: 'POST', token: w.token, body: { action: 'Approve' } })
  assert.equal(tap.status, 403)
  const signed = await signTap(w.s, { token: w.token, key: w.key, item: on.json.item, action: 'Approve' })
  const ok = await w.s.http(`/items/${item.id}/comments`, { method: 'POST', token: w.token, body: { action: 'Approve', approval: signed } })
  assert.equal(ok.status, 201, JSON.stringify(ok.json))
})

test('a signed lowering refused for a mismatch leaves the item step-up and its nonce unspent; the right statement over that nonce then works', async (t) => {
  const w = await world(t)
  const item = (await w.agent('/items', w.post(ask({ step_up: true, subject: SUBJECT })))).json.item
  const n = (await w.s.http('/approvals/nonce', { method: 'POST', token: w.token })).json.nonce
  const sign = (subject) => signForTest(w.key.privateKeyPem, {
    v: 1, type: 'account', journal: TEST_JOURNAL, user: 'alice', key_id: w.key.keyId, nonce: n, signed_at: Date.now(), subject,
  })
  const patch = (approval) => w.s.http(`/items/${item.id}`, { method: 'PATCH', token: w.token, body: { title: 'Retitled', step_up: false, approval } })
  const bad = await patch(sign({ ...lower, item: 'it_other' }))
  assert.deepEqual([bad.status, bad.json], [400, { error: 'approval_invalid', reason: 'mismatch' }])
  const row = w.s.db.prepare('SELECT step_up, title FROM items WHERE id=?').get(item.id)
  assert.deepEqual({ ...row }, { step_up: 1, title: 'Wire it?' })
  assert.equal(w.s.db.prepare('SELECT used_at FROM approval_nonces WHERE nonce=?').get(n).used_at, null)
  const ok = await patch(sign({ ...lower, item: item.id }))
  assert.equal(ok.status, 200, JSON.stringify(ok.json))
  assert.deepEqual([ok.json.item.step_up, ok.json.item.title], [false, 'Retitled'])
  assert.ok(w.s.db.prepare('SELECT used_at FROM approval_nonces WHERE nonce=?').get(n).used_at > 0)
})

test('no agent lowers a step-up item or changes its subject, the box that filed it included', async (t) => {
  const w = await world(t)
  const other = createAgent(w.s.db, w.alice.id, 'box-b')
  const item = (await w.agent('/items', w.post(ask({ step_up: true, subject: SUBJECT })))).json.item
  for (const token of [w.box.token, other.token]) {
    const patch = (body) => w.s.http(`/items/${item.id}`, { method: 'PATCH', token, body })
    for (const body of [{ step_up: false }, { subject: { payee: 'Mallory' } }, { step_up: true, subject: { payee: 'Mallory' } }, { title: 'X', step_up: false }]) {
      const r = await patch(body)
      assert.deepEqual([r.status, r.json], [403, { error: 'forbidden' }], JSON.stringify(body))
    }
    assert.equal((await patch({ title: 'Retitled' })).status, 200, 'other fields stay open')
    assert.equal((await patch({ step_up: true })).status, 200, 'raising stays open')
  }
  const row = w.s.db.prepare('SELECT step_up, subject, title FROM items WHERE id=?').get(item.id)
  assert.deepEqual({ ...row }, { step_up: 1, subject: JSON.stringify(SUBJECT), title: 'Retitled' })
})

test('the mark is read in the write: a patch whose body arrives after an agent raised the item cannot lower it unsigned', async (t) => {
  const w = await world(t)
  const item = (await w.agent('/items', w.post(ask()))).json.item
  const laptop = signIn(w.s, w.alice.id, 'laptop')
  const body = JSON.stringify({ step_up: false, title: 'Lowered' })
  const r = await new Promise((resolve, reject) => {
    const req = http.request(`${w.s.base}/items/${item.id}`, {
      method: 'PATCH', agent: false,
      headers: { authorization: `Bearer ${laptop.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }))
    })
    req.on('error', reject)
    req.write(body.slice(0, 5))
    setTimeout(async () => {
      // The agent raises the item while the patch's body is still arriving.
      const up = await w.agent(`/items/${item.id}`, { method: 'PATCH', body: { step_up: true, subject: SUBJECT } })
      assert.equal(up.status, 200)
      req.end(body.slice(5))
    }, 50)
  })
  assert.deepEqual([r.status, r.json], [403, { error: 'approval_required' }])
  const row = w.s.db.prepare('SELECT step_up, title FROM items WHERE id=?').get(item.id)
  assert.deepEqual({ ...row }, { step_up: 1, title: 'Wire it?' })
})

test('a keyless owner: PATCH step_up:true is step_up_ignored, and step_up:false is an ordinary patch', async (t) => {
  const w = await world(t, false)
  const id = (await w.agent('/items', w.post(ask()))).json.item.id
  const on = await w.s.http(`/items/${id}`, { method: 'PATCH', token: w.token, body: { step_up: true, subject: SUBJECT } })
  assert.equal(on.status, 200)
  assert.equal(on.json.step_up_ignored, true)
  assert.deepEqual([on.json.item.step_up, on.json.item.subject], [false, null])
  const other = createAgent(w.s.db, w.alice.id, 'box-b')
  const off = await w.s.http(`/items/${id}`, { method: 'PATCH', token: other.token, body: { step_up: false } })
  assert.equal(off.status, 200)
  const second = signIn(w.s, w.alice.id, 'laptop')
  const off2 = await w.s.http(`/items/${id}`, { method: 'PATCH', token: second.token, body: { step_up: false } })
  assert.equal(off2.status, 200)
})
