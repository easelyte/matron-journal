import test from 'node:test'
import assert from 'node:assert/strict'
import { getSpawn } from '../src/spawns.js'
import { getParticipant } from '../src/participants.js'
import { offerConsentActions, CONSENT_ACTIONS } from '../src/consent-items.js'
import { fleet, parkSpawn, parkInviteAsk, answer, settle } from './consent-fleet.js'

// A spawn or chat consent item carries Approve / Decline, and a tap on one
// answers the ask exactly as the card does: the same answer path, the same
// checks and the same record. A tap on an ask no longer waiting is 409 with a
// message an app can show as it is.

const isItemMarker = (f) => f.kind === 'journal' && f.type === 'item'
const reread = (s, id) => s.db.prepare('SELECT * FROM items WHERE id=?').get(id)
const thread = (s, itemId) => s.db.prepare('SELECT kind, body, author, device_id FROM item_comments WHERE item_id=? ORDER BY rowid').all(itemId)
const spawnItem = (f, spawnId) => reread(f.s, getSpawn(f.s.db, spawnId).item_id)
const chatItem = (f, room, deviceId) => reread(f.s, getParticipant(f.s.db, room, deviceId).item_id)
const tap = (f, itemId, action, token = f.clientToken) => f.s.http(`/items/${itemId}/comments`, { method: 'POST', token, body: { action } })
const clientDeviceId = (f) => f.s.db.prepare("SELECT id FROM devices WHERE kind='client'").get().id
const parkJoinAsk = async (f) => {
  f.target.send({ op: 'agent_join', room_id: 'room', justification: 'let me help with this bug' })
  await f.target.waitFor((x) => x.kind === 'invite' && x.event === 'delivered' && x.room_id === 'room')
}

test('a spawn consent item is filed with Approve and Decline, and its body says it can be answered here', async (t) => {
  const f = await fleet(t)
  const item = spawnItem(f, await parkSpawn(f))
  assert.deepEqual(JSON.parse(item.actions), ['Approve', 'Decline'])
  assert.match(item.body, /\*\*To answer:\*\* tap \*\*Approve\*\* or \*\*Decline\*\* here, or on the spawn card in the conversation "Asker"\./)
  const listed = (await f.s.http('/items?awaiting=user', { token: f.clientToken })).json.items.find((i) => i.id === item.id)
  assert.deepEqual(listed.actions, ['Approve', 'Decline'])
})

test("tapping Approve on a spawn item claims the row and starts the session, exactly as the card's Approve; a second tap says it was already answered", async (t) => {
  const f = await fleet(t)
  const spawnId = await parkSpawn(f)
  const item = spawnItem(f, spawnId)
  const startRpc = f.target.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'start')
  const r = await tap(f, item.id, 'Approve')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.item.state, 'closed')
  assert.equal(r.json.item.resolution, 'decided')
  const req = await startRpc
  const row = getSpawn(f.s.db, spawnId)
  assert.equal(row.state, 'approved')
  // A user's answer, not the Coordinator's: no stamp, no consent_decision record.
  assert.equal(row.answered_by, null)
  assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM consent_decisions').get().n, 0)
  const closing = thread(f.s, item.id).at(-1)
  assert.equal(closing.kind, 'status'); assert.equal(closing.author, 'user'); assert.equal(closing.device_id, clientDeviceId(f))
  assert.match(closing.body, /^Approved\. Starting the session on opal;/)
  const marker = await f.client.waitFor((x) => isItemMarker(x) && x.payload.action === 'closed' && x.payload.item_id === item.id)
  assert.equal(marker.payload.consent, 'spawn')

  const again = await tap(f, item.id, 'Approve')
  assert.equal(again.status, 409)
  assert.deepEqual(again.json, { error: 'conflict', reason: 'already_answered', message: 'Already answered: this request was approved.' })
  // The card's own Approve agrees: the ask was answered once.
  assert.equal((await f.s.http('/agent-spawn/answer', { method: 'POST', token: f.clientToken, body: { request_id: spawnId, decision: 'approve' } })).status, 409)

  f.target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child' } })
  const out = await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome')
  assert.equal(out.outcome, 'started')
  await settle()
  for (const agent of [f.asker, f.target, f.coord]) assert.equal(agent.frames.some(isItemMarker), false, 'no agent hears of the item')
})

test('tapping Decline on a spawn item declines the ask and tells the asker, as the card does', async (t) => {
  const f = await fleet(t)
  const spawnId = await parkSpawn(f)
  const item = spawnItem(f, spawnId)
  assert.equal((await tap(f, item.id, 'Decline')).status, 200)
  const out = await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome')
  assert.equal(out.outcome, 'declined')
  assert.equal(getSpawn(f.s.db, spawnId).state, 'denied')
  const after = reread(f.s, item.id)
  assert.equal(after.state, 'closed'); assert.equal(after.resolution, 'decided')
  assert.equal(thread(f.s, item.id).at(-1).body, 'Declined.')
  const again = await tap(f, item.id, 'Approve')
  assert.equal(again.status, 409)
  assert.equal(again.json.message, 'Already answered: this request was declined.')
})

test('an item tap after the card was answered, or after the Coordinator answered, is 409 "already answered"', async (t) => {
  const f = await fleet(t)
  const viaCard = await parkSpawn(f, { rid: 'q1' })
  assert.equal((await f.s.http('/agent-spawn/answer', { method: 'POST', token: f.clientToken, body: { request_id: viaCard, decision: 'deny' } })).status, 200)
  const cardItem = spawnItem(f, viaCard)
  assert.equal(cardItem.state, 'closed')
  const r1 = await tap(f, cardItem.id, 'Approve')
  assert.equal(r1.status, 409); assert.equal(r1.json.message, 'Already answered: this request was declined.')

  await parkInviteAsk(f)
  assert.equal((await answer(f, f.coordDev.token, { kind: 'chat', id: `room/${f.targetDev.deviceId}`, decision: 'approve', reason: 'follows the box rules' })).status, 200)
  const r2 = await tap(f, chatItem(f, 'room', f.targetDev.deviceId).id, 'Decline')
  assert.equal(r2.status, 409); assert.equal(r2.json.message, 'Already answered: this request was approved.')
})

test('a chat invite item carries the buttons; tapping Approve sends the invitation, and the closing marker settles the card on every app', async (t) => {
  const f = await fleet(t)
  await parkInviteAsk(f)
  const item = chatItem(f, 'room', f.targetDev.deviceId)
  assert.deepEqual(JSON.parse(item.actions), ['Approve', 'Decline'])
  assert.match(item.body, /tap \*\*Approve\*\* or \*\*Decline\*\* here, or on the chat request card/)
  const invite = f.target.waitFor((x) => x.kind === 'invite' && x.event === 'request' && x.room_id === 'room')
  const r = await tap(f, item.id, 'Approve')
  assert.equal(r.status, 200)
  assert.equal(r.json.delivered, true)
  await invite
  assert.equal(getParticipant(f.s.db, 'room', f.targetDev.deviceId).state, 'invited')
  const marker = await f.client.waitFor((x) => isItemMarker(x) && x.payload.action === 'closed' && x.payload.item_id === item.id)
  assert.equal(marker.payload.consent_ask, `room/${f.targetDev.deviceId}`)
  assert.equal(marker.payload.consent_outcome, 'approved')
  assert.equal(marker.payload.decided_by, undefined)
  const closing = thread(f.s, item.id).at(-1)
  assert.equal(closing.author, 'user'); assert.equal(closing.device_id, clientDeviceId(f))
})

test('tapping Decline on a join item refuses the joiner exactly as the card does: a peer refusal, never "denied"', async (t) => {
  const f = await fleet(t)
  await parkJoinAsk(f)
  const item = chatItem(f, 'room', f.targetDev.deviceId)
  assert.deepEqual(JSON.parse(item.actions), ['Approve', 'Decline'])
  const refused = f.target.waitFor((x) => x.kind === 'invite' && x.event === 'answer' && x.room_id === 'room')
  assert.equal((await tap(f, item.id, 'Decline')).status, 200)
  const frame = await refused
  assert.equal(frame.accept, false); assert.equal(frame.reason, 'refused')
  assert.equal(getParticipant(f.s.db, 'room', f.targetDev.deviceId).state, 'denied')
  assert.equal(reread(f.s, item.id).state, 'closed')
})

test('only the user taps: an agent is refused, and an unknown label on a waiting ask is 400 and answers nothing', async (t) => {
  const f = await fleet(t)
  const spawnId = await parkSpawn(f)
  const item = spawnItem(f, spawnId)
  // A consent item is invisible to every agent: a tap from one finds nothing.
  assert.equal((await tap(f, item.id, 'Approve', f.coordDev.token)).status, 404)
  assert.equal(getSpawn(f.s.db, spawnId).state, 'awaiting_user')
  const bad = await tap(f, item.id, 'Maybe')
  assert.equal(bad.status, 400); assert.equal(bad.json.error, 'unknown_action')
  assert.equal(getSpawn(f.s.db, spawnId).state, 'awaiting_user')
  assert.equal(reread(f.s, item.id).state, 'open')
})

test('items filed before the buttons existed get them while their ask waits; settled ones are left alone', async (t) => {
  const f = await fleet(t)
  const waiting = await parkSpawn(f, { rid: 'q1' })
  const answered = await parkSpawn(f, { rid: 'q2' })
  await parkInviteAsk(f)
  const ids = [spawnItem(f, waiting).id, spawnItem(f, answered).id, chatItem(f, 'room', f.targetDev.deviceId).id]
  for (const id of ids) f.s.db.prepare("UPDATE items SET actions='[]', updated_at=1 WHERE id=?").run(id)
  assert.equal((await f.s.http('/agent-spawn/answer', { method: 'POST', token: f.clientToken, body: { request_id: answered, decision: 'deny' } })).status, 200)
  assert.equal(offerConsentActions(f.s.db), 2)
  assert.deepEqual(JSON.parse(reread(f.s, ids[0]).actions), [...CONSENT_ACTIONS])
  assert.ok(reread(f.s, ids[0]).updated_at > 1)
  assert.deepEqual(JSON.parse(reread(f.s, ids[1]).actions), [])
  assert.deepEqual(JSON.parse(reread(f.s, ids[2]).actions), [...CONSENT_ACTIONS])
  assert.equal(offerConsentActions(f.s.db), 0)
  // And the backfilled button answers the ask.
  assert.equal((await tap(f, ids[0], 'Decline')).status, 200)
  assert.equal(getSpawn(f.s.db, waiting).state, 'denied')
})
