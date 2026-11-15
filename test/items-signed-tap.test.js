// Signed taps: a tap on a step-up item (or a step-up follow-up comment)
// counts only with a valid approval-key signature over the item, the button
// and the question as it stands. On any failure nothing is recorded; a
// signed tap's statement and signature are stored and read back unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgent, createUser } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { setDeviceConsentUserOnly } from '../src/db.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { startWithKey, startApprovalServer, signTap, signIn, enrolKeyByPassword, totpCode, forgetApprovalFailures, TEST_PASSWORD } from './approval-helpers.js'

async function world(t, withKey = true) {
  const base = await (withKey ? startWithKey(t) : startApprovalServer(t))
  const box = createAgent(base.s.db, base.alice.id, 'box-a')
  upsertConversation(base.s.db, { id: 'c1', ownerUserId: base.alice.id, title: 'C1', agentDeviceId: box.deviceId })
  const agent = (p, opts = {}) => base.s.http(p, { token: box.token, ...opts })
  const user = (p, opts = {}) => base.s.http(p, { token: base.token, ...opts })
  const file = async (extra = {}) => {
    const r = await agent('/items', { method: 'POST', body: { convo_id: 'c1', kind: 'question', title: 'Wire it?', body: 'Pay the invoice', actions: ['Approve', 'Deny'], ...extra } })
    assert.equal(r.status, 201, JSON.stringify(r.json))
    return r.json.item
  }
  // Each tap on its own: these tests send several invalid approvals from
  // the phone on purpose, and two would sign it out
  // (test/approval-lockdown.test.js).
  const tap = (item, body, headers = {}) => { forgetApprovalFailures(base.s); return user(`/items/${item.id}/comments`, { method: 'POST', body, headers }) }
  const count = () => base.s.db.prepare('SELECT COUNT(*) n FROM item_comments').get().n
  const lastMarker = () => JSON.parse(base.s.db.prepare("SELECT payload FROM events WHERE type='item' ORDER BY seq DESC LIMIT 1").get().payload)
  return { ...base, box, agent, user, file, tap, count, lastMarker }
}
const SUBJECT = { payee: 'Acme', amount: '12.00' }
const invalid = (r, reason) => assert.deepEqual([r.status, r.json], [400, { error: 'approval_invalid', reason }])

test('a signed tap on a step-up item counts; the thread returns its approval unchanged; the marker says signed', async (t) => {
  const w = await world(t)
  const item = await w.file({ step_up: true, subject: SUBJECT })
  const approval = await signTap(w.s, { token: w.token, key: w.key, item, action: 'Approve' })
  const r = await w.tap(item, { action: 'Approve', approval })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  assert.equal(r.json.item.chosen_action, 'Approve')
  assert.deepEqual(r.json.comment.approval, approval)
  const got = await w.user(`/items/${item.num}`)
  const c = got.json.comments.find((x) => x.action === 'Approve')
  assert.equal(c.approval.statement, approval.statement)
  assert.equal(c.approval.signature, approval.signature)
  assert.deepEqual(Object.keys(c.approval).sort(), ['signature', 'statement'])
  // An agent reading the item (a box's verifier) sees the same bytes.
  const seen = await w.agent(`/items/${item.num}`)
  assert.equal(seen.json.comments.find((x) => x.action === 'Approve').approval.statement, approval.statement)
  const m = w.lastMarker()
  assert.equal(m.action, 'commented')
  assert.equal(m.comment.action, 'Approve')
  assert.equal(m.comment.signed, true)
  assert.equal(m.comment.key_id, w.key.keyId)
  assert.equal(m.comment.approval, undefined)
})

test('an unsigned tap on a step-up item is approval_required and records nothing', async (t) => {
  const w = await world(t)
  const item = await w.file({ step_up: true, subject: SUBJECT })
  const before = w.count()
  const r = await w.tap(item, { action: 'Approve' })
  assert.deepEqual([r.status, r.json], [403, { error: 'approval_required' }])
  assert.equal(w.count(), before)
  const got = await w.user(`/items/${item.num}`)
  assert.equal(got.json.item.chosen_action, null)
  assert.equal(got.json.item.awaiting, 'user')
})

test('a typed reply on a step-up item is an ordinary comment, never a tap, and stores no approval', async (t) => {
  const w = await world(t)
  const item = await w.file({ step_up: true })
  const approval = await signTap(w.s, { token: w.token, key: w.key, item, action: 'Approve' })
  const r = await w.tap(item, { body: 'Approve', approval })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  assert.equal(r.json.comment.action, null)
  assert.equal(r.json.comment.approval, null)
  assert.equal(r.json.item.chosen_action, null)
  assert.equal(w.lastMarker().comment.signed, undefined)
  // The nonce was not spent: the same signature still makes the tap.
  const ok = await w.tap(item, { action: 'Approve', approval })
  assert.equal(ok.status, 201, JSON.stringify(ok.json))
})

test('a signature for another item, another label or another reply_to is a mismatch', async (t) => {
  const w = await world(t)
  const item = await w.file({ step_up: true })
  const other = await w.file({ step_up: true })
  const before = w.count()
  // Signed for the other item, sent on this one.
  invalid(await w.tap(item, { action: 'Approve', approval: await signTap(w.s, { token: w.token, key: w.key, item: other, action: 'Approve' }) }), 'mismatch')
  // Signed for Deny, sent as Approve.
  invalid(await w.tap(item, { action: 'Approve', approval: await signTap(w.s, { token: w.token, key: w.key, item, action: 'Deny' }) }), 'mismatch')
  // A follow-up question with the same buttons: a signature for the item's
  // own buttons does not answer it, nor the other way round.
  const q = await w.agent(`/items/${item.id}/comments`, { method: 'POST', body: { body: 'Really?', actions: ['Approve', 'Deny'] } })
  assert.equal(q.status, 201)
  const forItem = await signTap(w.s, { token: w.token, key: w.key, item, action: 'Approve' })
  const before2 = w.count()
  invalid(await w.tap(item, { action: 'Approve', reply_to: q.json.comment.id, approval: forItem }), 'mismatch')
  const forComment = await signTap(w.s, { token: w.token, key: w.key, item, comment: q.json.comment, action: 'Approve' })
  invalid(await w.tap(item, { action: 'Approve', approval: forComment }), 'mismatch')
  assert.equal(w.count(), before2)
  assert.equal(before2, before + 1)
  const got = await w.user(`/items/${item.num}`)
  assert.equal(got.json.item.chosen_action, null)
  assert.equal(got.json.comments.find((c) => c.id === q.json.comment.id).chosen_action, null)
  // Each refused statement left its nonce unspent; the right one still works.
  const ok = await w.tap(item, { action: 'Approve', approval: forItem })
  assert.equal(ok.status, 201, JSON.stringify(ok.json))
})

test('an item edited after the user signed is a mismatch: body, title; its subject cannot be changed at all', async (t) => {
  const w = await world(t)
  for (const patch of [{ body: 'Pay the other invoice' }, { title: 'Wire it now?' }]) {
    const item = await w.file({ step_up: true, subject: SUBJECT })
    const approval = await signTap(w.s, { token: w.token, key: w.key, item, action: 'Approve' })
    const p = await w.agent(`/items/${item.id}`, { method: 'PATCH', body: patch })
    assert.equal(p.status, 200, JSON.stringify(p.json))
    const before = w.count()
    invalid(await w.tap(item, { action: 'Approve', approval }), 'mismatch')
    assert.equal(w.count(), before, JSON.stringify(patch))
  }
  // A step-up item's subject is fixed once filed (test/items-step-up.test.js).
  const item = await w.file({ step_up: true, subject: SUBJECT })
  const p = await w.agent(`/items/${item.id}`, { method: 'PATCH', body: { subject: { payee: 'Mallory', amount: '12.00' } } })
  assert.deepEqual([p.status, p.json], [403, { error: 'forbidden' }])
})

test('a signature for a button the item no longer offers is refused', async (t) => {
  const w = await world(t)
  const item = await w.file({ step_up: true })
  const approval = await signTap(w.s, { token: w.token, key: w.key, item, action: 'Approve' })
  const p = await w.agent(`/items/${item.id}`, { method: 'PATCH', body: { actions: ['Deny', 'Later'] } })
  assert.equal(p.status, 200)
  const before = w.count()
  const r = await w.tap(item, { action: 'Approve', approval })
  assert.equal(r.status, 400)
  assert.equal(r.json.error, 'unknown_action')
  assert.equal(w.count(), before)
})

test('the same signed request with the same idempotency key answers the first result; another key is a spent nonce', async (t) => {
  const w = await world(t)
  const item = await w.file({ step_up: true })
  const approval = await signTap(w.s, { token: w.token, key: w.key, item, action: 'Approve' })
  const first = await w.tap(item, { action: 'Approve', approval }, { 'idempotency-key': 'tap-1' })
  assert.equal(first.status, 201, JSON.stringify(first.json))
  const markers = () => w.s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='item'").get().n
  const m0 = markers()
  const again = await w.tap(item, { action: 'Approve', approval }, { 'idempotency-key': 'tap-1' })
  assert.equal(again.status, 200, JSON.stringify(again.json))
  assert.equal(again.json.comment.id, first.json.comment.id)
  assert.deepEqual(again.json.comment.approval, approval)
  assert.equal(markers(), m0)
  const before = w.count()
  invalid(await w.tap(item, { action: 'Approve', approval }, { 'idempotency-key': 'tap-2' }), 'nonce')
  invalid(await w.tap(item, { action: 'Approve', approval }), 'nonce')
  assert.equal(w.count(), before)
})

test('a step-up follow-up comment: its own subject and body are signed', async (t) => {
  const w = await world(t)
  const item = await w.file()
  const q = await w.agent(`/items/${item.id}/comments`, { method: 'POST', body: { body: 'Deploy to production?', actions: ['Deploy', 'Hold'], step_up: true, subject: { op: 'deploy', target: 'production' } } })
  assert.equal(q.status, 201, JSON.stringify(q.json))
  const comment = q.json.comment
  assert.equal(comment.step_up, true)
  const r0 = await w.tap(item, { action: 'Deploy', reply_to: comment.id })
  assert.deepEqual([r0.status, r0.json], [403, { error: 'approval_required' }])
  // The item's subject ({}) is not the comment's.
  const wrong = await signTap(w.s, { token: w.token, key: w.key, item, comment: { ...comment, step_up: false }, action: 'Deploy' })
  invalid(await w.tap(item, { action: 'Deploy', reply_to: comment.id, approval: wrong }), 'mismatch')
  const approval = await signTap(w.s, { token: w.token, key: w.key, item, comment, action: 'Deploy' })
  const r = await w.tap(item, { action: 'Deploy', reply_to: comment.id, approval })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  assert.deepEqual(r.json.comment.approval, approval)
  assert.equal(r.json.comment.reply_to, comment.id)
  const got = await w.user(`/items/${item.num}`)
  assert.equal(got.json.comments.find((c) => c.id === comment.id).chosen_action, 'Deploy')
  // The item's own buttons are not marked: an unsigned tap there is as today.
  const plain = await w.tap(item, { action: 'Deny' })
  assert.equal(plain.status, 201, JSON.stringify(plain.json))
  assert.equal(plain.json.comment.approval, null)
})

test('on a step-up item every button needs a signature, a plain follow-up included (its body, the item subject)', async (t) => {
  const w = await world(t)
  const item = await w.file({ step_up: true, subject: SUBJECT })
  const q = await w.agent(`/items/${item.id}/comments`, { method: 'POST', body: { body: 'Today or tomorrow?', actions: ['Today', 'Tomorrow'] } })
  const comment = q.json.comment
  assert.equal(comment.step_up, false)
  const r0 = await w.tap(item, { action: 'Today', reply_to: comment.id })
  assert.deepEqual([r0.status, r0.json], [403, { error: 'approval_required' }])
  const approval = await signTap(w.s, { token: w.token, key: w.key, item, comment, action: 'Today' })
  assert.deepEqual(JSON.parse(approval.statement).subject, SUBJECT)
  const r = await w.tap(item, { action: 'Today', reply_to: comment.id, approval })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  assert.deepEqual(r.json.comment.approval, approval)
})

test('an old-style tap on an unmarked item is unchanged: no approval, the same marker', async (t) => {
  for (const withKey of [true, false]) {
    const w = await world(t, withKey)
    const item = await w.file()
    const r = await w.tap(item, { action: 'Approve' })
    assert.equal(r.status, 201, JSON.stringify(r.json))
    assert.equal(r.json.item.chosen_action, 'Approve')
    assert.equal(r.json.comment.approval, null)
    const m = w.lastMarker()
    assert.equal(m.comment.action, 'Approve')
    assert.deepEqual(Object.keys(m.comment).sort(), ['action', 'actions', 'attachments', 'body', 'chosen_action', 'created_at', 'id', 'reply_to'])
    assert.equal('signed' in m, false)
  }
})

test('an unmarked item: a valid approval is verified and stored; an invalid one is refused', async (t) => {
  const w = await world(t)
  const item = await w.file()
  const approval = await signTap(w.s, { token: w.token, key: w.key, item, action: 'Deny' })
  const before = w.count()
  invalid(await w.tap(item, { action: 'Approve', approval }), 'mismatch')
  invalid(await w.tap(item, { action: 'Deny', approval: { ...approval, signature: approval.signature.slice(0, -4) + 'AAAA' } }), 'signature')
  invalid(await w.tap(item, { action: 'Deny', approval: { statement: 'nope', signature: 'x' } }), 'bad_statement')
  assert.equal(w.count(), before)
  const r = await w.tap(item, { action: 'Deny', approval })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  assert.deepEqual(r.json.comment.approval, approval)
  assert.equal(w.lastMarker().comment.signed, true)
})

test('a signature from another device of the account is wrong_device', async (t) => {
  const w = await world(t)
  const item = await w.file({ step_up: true })
  const laptop = signIn(w.s, w.alice.id, 'laptop')
  const approval = await signTap(w.s, { token: laptop.token, key: w.key, item, action: 'Approve' })
  const r = await w.s.http(`/items/${item.id}/comments`, { method: 'POST', token: laptop.token, body: { action: 'Approve', approval } })
  invalid(r, 'wrong_device')
})

test('an account with no approval key: an approval field is ignored and nothing is stored', async (t) => {
  const w = await world(t, false)
  const item = await w.file()
  const r = await w.tap(item, { action: 'Approve', approval: { statement: 'anything', signature: 'x' } })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  assert.equal(r.json.comment.approval, null)
  assert.equal(w.s.db.prepare('SELECT approval FROM item_comments WHERE id=?').get(r.json.comment.id).approval, null)
  assert.equal(w.lastMarker().comment.signed, undefined)
})

test('a signed tap whose write fails spends no nonce: the check and the comment are one transaction', async (t) => {
  const w = await world(t)
  const plain = await w.file()
  const item = await w.file({ step_up: true })
  assert.equal((await w.tap(plain, { action: 'Approve' }, { 'idempotency-key': 'k1' })).status, 201)
  const approval = await signTap(w.s, { token: w.token, key: w.key, item, action: 'Approve' })
  // The same idempotency key on another item: the insert fails after the
  // signature checked out.
  const clash = await w.tap(item, { action: 'Approve', approval }, { 'idempotency-key': 'k1' })
  assert.equal(clash.status, 409, JSON.stringify(clash.json))
  const nonce = JSON.parse(approval.statement).nonce
  assert.equal(w.s.db.prepare('SELECT used_at FROM approval_nonces WHERE nonce=?').get(nonce).used_at, null)
  const ok = await w.tap(item, { action: 'Approve', approval }, { 'idempotency-key': 'k2' })
  assert.equal(ok.status, 201, JSON.stringify(ok.json))
  assert.notEqual(w.s.db.prepare('SELECT used_at FROM approval_nonces WHERE nonce=?').get(nonce).used_at, null)
})

test('the owner\'s signed tap on a contributor\'s item reaches the contributor without signed or key_id', async (t) => {
  const w = await world(t)
  const bob = await createUser(w.s.db, 'bob', 'pw')
  const bobBox = createAgent(w.s.db, bob.id, 'box-b')
  upsertConversation(w.s.db, { id: 'bobwork', ownerUserId: bob.id, title: 'Bob', agentDeviceId: bobBox.deviceId })
  const bobPhone = signIn(w.s, bob.id, 'bob-phone')
  const as = (token) => (p, body) => w.s.http(p, { method: 'POST', token, body })
  const m = (await as(w.box.token)('/missions', { convo_id: 'c1', title: 'Launch' })).json.mission
  await as(w.token)('/contacts', { user: 'bob' })
  const theirs = (await w.s.http('/contacts', { token: bobPhone.token })).json.contacts[0]
  assert.equal((await as(bobPhone.token)(`/contacts/${theirs.id}/answer`, { decision: 'approve' })).status, 200)
  const g = await as(w.token)(`/missions/${m.id}/shares`, { contact: 'bob', level: 'contribute' })
  assert.equal(g.status, 201, JSON.stringify(g.json))
  assert.equal((await as(bobPhone.token)(`/grants/${g.json.grant.id}/answer`, { decision: 'approve' })).status, 200)
  const it = (await as(bobBox.token)('/items', { mission: m.id, kind: 'question', title: 'Order the food?', convo_id: 'bobwork' })).json.item
  const q = await as(w.box.token)(`/items/${it.id}/comments`, { body: 'Shall I order?', actions: ['Order'], step_up: true })
  assert.equal(q.status, 201, JSON.stringify(q.json))
  const item = (await w.user(`/items/${it.id}`)).json.item
  const approval = await signTap(w.s, { token: w.token, key: w.key, item, comment: q.json.comment, action: 'Order' })
  const r = await w.tap(item, { action: 'Order', reply_to: q.json.comment.id, approval })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  assert.equal(w.lastMarker().comment?.signed, undefined, 'the last marker is the one in bob\'s conversation')
  const toBob = JSON.parse(w.s.db.prepare("SELECT payload FROM events WHERE type='item' AND convo_id='bobwork' ORDER BY seq DESC LIMIT 1").get().payload)
  assert.equal(toBob.comment.action, 'Order')
  assert.equal('signed' in toBob.comment, false)
  assert.equal('key_id' in toBob.comment, false)
  assert.ok(!JSON.stringify(toBob).includes(w.key.keyId))
  // alice's own marker does say signed.
  const mine = JSON.parse(w.s.db.prepare("SELECT payload FROM events WHERE type='item' AND convo_id=? AND user_id=? ORDER BY seq DESC LIMIT 1").get(item.origin_convo_id, w.alice.id).payload)
  assert.equal(mine.comment.signed, true)
})

test('a signature for follow-up A sent on follow-up B is a mismatch', async (t) => {
  const w = await world(t)
  const item = await w.file({ step_up: true })
  const ask = (body) => w.agent(`/items/${item.id}/comments`, { method: 'POST', body: { body, actions: ['Yes', 'No'] } })
  const a = (await ask('Restart the database?')).json.comment
  const b = (await ask('Restart the cache?')).json.comment
  const forA = await signTap(w.s, { token: w.token, key: w.key, item, comment: a, action: 'Yes' })
  const before = w.count()
  invalid(await w.tap(item, { action: 'Yes', reply_to: b.id, approval: forA }), 'mismatch')
  assert.equal(w.count(), before)
  assert.equal((await w.tap(item, { action: 'Yes', reply_to: a.id, approval: forA })).status, 201)
})

test('a tap signed with a since-revoked key is revoked_key', async (t) => {
  const w = await world(t)
  const item = await w.file({ step_up: true })
  const approval = await signTap(w.s, { token: w.token, key: w.key, item, action: 'Approve' })
  // Another key stays live, so the account still has one.
  const laptop = signIn(w.s, w.alice.id, 'laptop')
  await enrolKeyByPassword(w.s, { token: laptop.token, userId: w.alice.id, secret: w.secret, name: 'laptop' })
  const rv = await w.s.http(`/approval-keys/${w.key.keyId}/revoke`, { method: 'POST', token: w.token, body: { password: TEST_PASSWORD, code: totpCode(w.s, w.alice.id, w.secret) } })
  assert.equal(rv.status, 200, JSON.stringify(rv.json))
  const before = w.count()
  invalid(await w.tap(item, { action: 'Approve', approval }), 'revoked_key')
  assert.equal(w.count(), before)
})

// The digest covers the item's title and body only; the label is checked
// against the item's current actions. So a signature for a label the item
// still offers stands when the other buttons change around it.
test('label kept, other actions changed: the signed tap still counts', async (t) => {
  const w = await world(t)
  const item = await w.file({ step_up: true })
  const approval = await signTap(w.s, { token: w.token, key: w.key, item, action: 'Approve' })
  assert.equal((await w.agent(`/items/${item.id}`, { method: 'PATCH', body: { actions: ['Approve', 'Later'] } })).status, 200)
  const r = await w.tap(item, { action: 'Approve', approval })
  assert.equal(r.status, 201, JSON.stringify(r.json))
})

// The journal's own "Hand this item over?" question: a Coordinator's offer
// of an item on a user-only box waits for the user's tap.
async function handoverAsk(w, itemExtra) {
  setDeviceConsentUserOnly(w.s.db, w.box.deviceId, true)
  const boxB = createAgent(w.s.db, w.alice.id, 'box-b')
  const coord = createAgent(w.s.db, w.alice.id, 'box-k')
  upsertConversation(w.s.db, { id: 'b1', ownerUserId: w.alice.id, title: 'Beta', agentDeviceId: boxB.deviceId })
  upsertConversation(w.s.db, { id: 'k1', ownerUserId: w.alice.id, title: 'Coordinator', agentDeviceId: coord.deviceId })
  setCoordinatorConvoId(w.s.db, w.alice.id, 'k1')
  const item = await w.file(itemExtra)
  const off = await w.s.http(`/items/${item.num}/handover`, { method: 'POST', token: coord.token, body: { to_convo_id: 'b1', as_convo_id: 'k1' } })
  assert.equal(off.json.handover?.state, 'awaiting_user', JSON.stringify(off.json))
  const thread = await w.user(`/items/${item.num}`)
  const q = thread.json.comments.find((c) => c.meta?.role === 'handover_approval')
  assert.ok(q)
  const state = () => w.s.db.prepare('SELECT state FROM item_handovers WHERE item_id=? ORDER BY rowid DESC LIMIT 1').get(item.id)?.state
  return { item: thread.json.item, q, state }
}

test('the handover question on a step-up item needs a signature; unsigned settles nothing', async (t) => {
  const w = await world(t)
  const { item, q, state } = await handoverAsk(w, { step_up: true, subject: SUBJECT })
  const before = w.count()
  const r0 = await w.tap(item, { action: 'Hand over', reply_to: q.id })
  assert.deepEqual([r0.status, r0.json], [403, { error: 'approval_required' }])
  invalid(await w.tap(item, { action: 'Keep it here', reply_to: q.id, approval: await signTap(w.s, { token: w.token, key: w.key, item, comment: q, action: 'Hand over' }) }), 'mismatch')
  assert.equal(w.count(), before)
  assert.equal(state(), 'awaiting_user')
  const approval = await signTap(w.s, { token: w.token, key: w.key, item, comment: q, action: 'Hand over' })
  assert.deepEqual(JSON.parse(approval.statement).subject, SUBJECT)
  const r = await w.tap(item, { action: 'Hand over', reply_to: q.id, approval })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  assert.deepEqual(r.json.comment.approval, approval)
  assert.equal(state(), 'offered')
})

test('the handover question on an unmarked item is tapped as before', async (t) => {
  const w = await world(t)
  const { item, q, state } = await handoverAsk(w)
  const r = await w.tap(item, { action: 'Hand over', reply_to: q.id })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  assert.equal(r.json.comment.approval, null)
  assert.equal(state(), 'offered')
})
