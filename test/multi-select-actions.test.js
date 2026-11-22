// Multi-select answers (protocol.md "Multi-select answers"): an agent asks
// with `multi_select: true` alongside `actions`, the user ticks any of the
// labels and sends them together as `selected`, and the answer is one user
// comment that names every label. One-tap questions are unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { pushContent } from '../src/push.js'
import { withdrawComment } from '../src/withdrawn-comments.js'
import { getItem } from '../src/items.js'

async function fleet(t) {
  const wakeCalls = []
  const waker = { enabled: true, wake: (name) => wakeCalls.push(name) }
  const s = await startTestServer({ waker })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-a')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  return { s, alice, agent, client: login.json.token, wakeCalls }
}

const OPTIONS = ['Docs', 'Search', 'Billing']
const mkItem = (s, token, body) => s.http('/items', { method: 'POST', token, body: { kind: 'question', title: 'Which should we close?', convo_id: 'c1', ...body } })
const comment = (s, token, id, body) => s.http(`/items/${id}/comments`, { method: 'POST', token, body })

test('POST /items: multi_select is stored and read back; one-tap items read multi_select false', async (t) => {
  const { s, agent, client } = await fleet(t)
  const r = await mkItem(s, agent.token, { actions: OPTIONS, multi_select: true })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  assert.equal(r.json.item.multi_select, true)
  assert.deepEqual(r.json.item.chosen_actions, [])
  const one = await mkItem(s, agent.token, { actions: ['Go'] })
  assert.equal(one.json.item.multi_select, false)
  assert.deepEqual(one.json.item.chosen_actions, [])
  const got = await s.http(`/items/${r.json.item.id}`, { token: client })
  assert.equal(got.json.item.multi_select, true)
})

test('multi_select validation: needs actions, not with step_up, not on a notice, boolean only', async (t) => {
  const { s, agent } = await fleet(t)
  for (const body of [
    { multi_select: true },
    { multi_select: true, actions: [] },
    { multi_select: 'yes', actions: OPTIONS },
    { multi_select: true, actions: OPTIONS, step_up: true },
    { kind: 'notice', multi_select: true },
  ]) {
    const r = await mkItem(s, agent.token, body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.deepEqual(r.json, { error: 'invalid_actions' })
  }
})

test('multi_select allows up to 12 labels of up to 80 characters; one-tap stays at 4 and 40', async (t) => {
  const { s, agent } = await fleet(t)
  const twelve = Array.from({ length: 12 }, (_, i) => `Close the mission about topic number ${i + 1}`)
  assert.equal((await mkItem(s, agent.token, { actions: twelve, multi_select: true })).status, 201)
  assert.equal((await mkItem(s, agent.token, { actions: [...twelve, 'one more'], multi_select: true })).status, 400)
  assert.equal((await mkItem(s, agent.token, { actions: ['x'.repeat(80)], multi_select: true })).status, 201)
  assert.equal((await mkItem(s, agent.token, { actions: ['x'.repeat(81)], multi_select: true })).status, 400)
  assert.equal((await mkItem(s, agent.token, { actions: twelve.slice(0, 5) })).status, 400)
  assert.equal((await mkItem(s, agent.token, { actions: ['x'.repeat(41)] })).status, 400)
})

test('selected: one comment names every label; the item records them all; awaiting goes to the agent; wake', async (t) => {
  const { s, agent, client, wakeCalls } = await fleet(t)
  const id = (await mkItem(s, agent.token, { actions: OPTIONS, multi_select: true })).json.item.id
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await comment(s, client, id, { selected: [' Docs ', 'Billing'] })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  assert.equal(r.json.comment.body, 'Docs, Billing')
  assert.equal(r.json.comment.action, 'Docs')
  assert.deepEqual(r.json.comment.selected, ['Docs', 'Billing'])
  assert.deepEqual(r.json.comment.meta, { action: 'Docs', selected: ['Docs', 'Billing'] })
  assert.equal(r.json.item.chosen_action, 'Docs')
  assert.deepEqual(r.json.item.chosen_actions, ['Docs', 'Billing'])
  assert.equal(r.json.item.awaiting, 'agent')
  const marker = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'commented')
  assert.equal(marker.payload.multi_select, true)
  assert.deepEqual(marker.payload.chosen_actions, ['Docs', 'Billing'])
  assert.deepEqual(marker.payload.comment.selected, ['Docs', 'Billing'])
  assert.equal(marker.payload.comment.action, 'Docs')
  ws.close()
  assert.deepEqual(wakeCalls, ['box-a'])
  // A note typed alongside is kept as the body.
  const n = await comment(s, client, id, { selected: ['Search'], body: 'Only search for now' })
  assert.equal(n.json.comment.body, 'Only search for now')
  assert.deepEqual(n.json.item.chosen_actions, ['Search'])
})

test('selected is refused: unknown label, repeats, empty, with action, on a one-tap question, from an agent', async (t) => {
  const { s, agent, client } = await fleet(t)
  const multi = (await mkItem(s, agent.token, { actions: OPTIONS, multi_select: true })).json.item.id
  const single = (await mkItem(s, agent.token, { actions: ['Go', 'Wait'] })).json.item.id
  for (const [id, body] of [
    [multi, { selected: ['Docs', 'Nope'] }],
    [multi, { selected: ['Docs', 'Docs'] }],
    [multi, { selected: [] }],
    [multi, { selected: 'Docs' }],
    [multi, { selected: ['Docs'], action: 'Docs' }],
    [single, { selected: ['Go'] }],
  ]) {
    const r = await comment(s, client, id, body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.deepEqual(r.json, { error: 'unknown_action' })
  }
  assert.equal((await comment(s, agent.token, multi, { selected: ['Docs'] })).status, 403)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM item_comments WHERE kind='comment'").get().n, 0)
})

test('an old client tapping one label on a multi-select question answers with that label alone', async (t) => {
  const { s, agent, client } = await fleet(t)
  const id = (await mkItem(s, agent.token, { actions: OPTIONS, multi_select: true })).json.item.id
  const r = await comment(s, client, id, { action: 'Search' })
  assert.equal(r.status, 201)
  assert.deepEqual(r.json.comment.selected, ['Search'])
  assert.deepEqual(r.json.item.chosen_actions, ['Search'])
})

test('a one-tap answer is unchanged: no selected, chosen_actions is the one label', async (t) => {
  const { s, agent, client } = await fleet(t)
  const id = (await mkItem(s, agent.token, { actions: ['Go', 'Wait'] })).json.item.id
  const r = await comment(s, client, id, { action: 'Go' })
  assert.deepEqual(r.json.comment.meta, { action: 'Go' })
  assert.equal(r.json.comment.selected, null)
  assert.deepEqual(r.json.item.chosen_actions, ['Go'])
  const m = JSON.parse(s.db.prepare("SELECT payload FROM events WHERE type='item' ORDER BY seq DESC LIMIT 1").get().payload)
  assert.equal('multi_select' in m, false)
  assert.equal('selected' in m.comment, false)
})

test('comment questions: multi_select on a follow-up, answered with selected + reply_to', async (t) => {
  const { s, alice, agent, client } = await fleet(t)
  const id = (await mkItem(s, agent.token, {})).json.item.id
  const q = await comment(s, agent.token, id, { body: 'Which of these can go?', actions: OPTIONS, multi_select: true })
  assert.equal(q.status, 201, JSON.stringify(q.json))
  assert.equal(q.json.comment.multi_select, true)
  assert.equal(q.json.item.awaiting, 'user')
  // Without buttons multi_select means nothing and is refused.
  assert.equal((await comment(s, agent.token, id, { body: 'x', multi_select: true })).status, 400)
  const r = await comment(s, client, id, { selected: ['Search', 'Billing'], reply_to: q.json.comment.id })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  assert.equal(r.json.comment.reply_to, q.json.comment.id)
  assert.deepEqual(r.json.comment.selected, ['Search', 'Billing'])
  const got = await s.http(`/items/${id}`, { token: client })
  const asked = got.json.comments.find((c) => c.id === q.json.comment.id)
  assert.deepEqual(asked.chosen_actions, ['Search', 'Billing'])
  assert.equal(asked.chosen_action, 'Search')
  // The item's own answer is left alone.
  assert.deepEqual(getItem(s.db, alice.id, id).chosen_actions, [])
})

test('PATCH: actions without multi_select asks a one-tap question; switching mode clears the answer', async (t) => {
  const { s, agent, client } = await fleet(t)
  const id = (await mkItem(s, agent.token, { actions: OPTIONS, multi_select: true })).json.item.id
  await comment(s, client, id, { selected: ['Docs', 'Search'] })
  const same = await s.http(`/items/${id}`, { method: 'PATCH', token: agent.token, body: { actions: OPTIONS, multi_select: true } })
  assert.deepEqual(same.json.item.chosen_actions, ['Docs', 'Search'])
  const single = await s.http(`/items/${id}`, { method: 'PATCH', token: agent.token, body: { actions: OPTIONS.slice(0, 2) } })
  assert.equal(single.json.item.multi_select, false)
  assert.deepEqual(single.json.item.chosen_actions, [])
  assert.equal(single.json.item.chosen_action, null)
  // multi_select alone describes no list.
  assert.equal((await s.http(`/items/${id}`, { method: 'PATCH', token: agent.token, body: { multi_select: true } })).status, 400)
})

test('a notification for a multi-select question offers no buttons', () => {
  const event = { convo_id: 'c1', seq: 1, type: 'item', payload: { action: 'created', item_id: 'it_1', num: 3, kind: 'question', title: 'Q', actions: OPTIONS, chosen_action: null, multi_select: true } }
  assert.deepEqual(pushContent(event, { title: 'C1' }, { kind: 'item' }).item.actions, [])
  const asked = { ...event, payload: { ...event.payload, multi_select: undefined, actions: [], action: 'commented', comment: { id: 'ic_1', body: 'Which?', actions: OPTIONS, multi_select: true } } }
  assert.deepEqual(pushContent(asked, { title: 'C1' }, { kind: 'item' }).item.actions, [])
  const single = { ...event, payload: { ...event.payload, multi_select: undefined, actions: ['Go'] } }
  assert.deepEqual(pushContent(single, { title: 'C1' }, { kind: 'item' }).item.actions, ['Go'])
})

test('withdrawing a multi-select answer puts the previous answer back', async (t) => {
  const { s, alice, agent, client } = await fleet(t)
  const id = (await mkItem(s, agent.token, { actions: OPTIONS, multi_select: true })).json.item.id
  await comment(s, client, id, { selected: ['Docs', 'Search'] })
  const second = (await comment(s, client, id, { selected: ['Billing'] })).json.comment
  assert.deepEqual(getItem(s.db, alice.id, id).chosen_actions, ['Billing'])
  withdrawComment(s.db, { userId: alice.id, itemId: id, commentId: second.id })
  const after = getItem(s.db, alice.id, id)
  assert.equal(after.chosen_action, 'Docs')
  assert.deepEqual(after.chosen_actions, ['Docs', 'Search'])
})

test('a withdrawn multi-select answer shows none of its labels', async (t) => {
  const { s, alice, agent, client } = await fleet(t)
  const id = (await mkItem(s, agent.token, { actions: OPTIONS, multi_select: true })).json.item.id
  const answer = (await comment(s, client, id, { selected: ['Docs', 'Search'] })).json.comment
  withdrawComment(s.db, { userId: alice.id, itemId: id, commentId: answer.id })
  const seen = (await s.http(`/items/${id}`, { token: agent.token })).json.comments.find((c) => c.id === answer.id)
  assert.equal(seen.selected, null)
  assert.equal(seen.meta?.selected, undefined)
  const markers = s.db.prepare("SELECT payload FROM events WHERE type='item'").all().map((r) => JSON.parse(r.payload))
  assert.ok(markers.every((m) => m.comment?.id !== answer.id || !('selected' in m.comment)))
})

test('step_up and multi_select never meet: PATCH either way, or a follow-up on a step-up item', async (t) => {
  const { s, agent } = await fleet(t)
  const multi = (await mkItem(s, agent.token, { actions: OPTIONS, multi_select: true })).json.item.id
  const r = await s.http(`/items/${multi}`, { method: 'PATCH', token: agent.token, body: { step_up: true } })
  // Without an approval key step_up is ignored; with one it would be refused.
  assert.ok(r.status === 400 || r.json.step_up_ignored === true, JSON.stringify(r.json))
  s.db.prepare('UPDATE items SET step_up=1 WHERE id=?').run(multi)
  const p = await s.http(`/items/${multi}`, { method: 'PATCH', token: agent.token, body: { title: 'Renamed' } })
  assert.equal(p.status, 400)
  assert.deepEqual(p.json, { error: 'invalid_actions' })
  const q = await comment(s, agent.token, multi, { body: 'Which?', actions: OPTIONS, multi_select: true })
  assert.equal(q.status, 400)
})

test('a notice PATCH that resends its own Seen button is still a no-op', async (t) => {
  const { s, agent } = await fleet(t)
  const n = (await mkItem(s, agent.token, { kind: 'notice', title: 'FYI' })).json.item
  const r = await s.http(`/items/${n.id}`, { method: 'PATCH', token: agent.token, body: { actions: ['Seen'] } })
  assert.equal(r.status, 200)
  assert.equal(r.json.item.updated_at, n.updated_at)
})
