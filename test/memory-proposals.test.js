// Memory proposals (src/memory-proposals.js, src/memory-proposals-http.js):
// which agent writes apply at once, which wait for the user, and what the
// user's answer does.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { sweepMemoryProposals, fencedBlock as fenced, MEMORY_DIRECT_WINDOW_MS, MEMORY_PROPOSAL_EVENT_TYPE } from '../src/memory-proposals-http.js'
import { PROPOSAL_TTL_MS, MAX_PENDING_PER_CONVO, MAX_PENDING_PER_USER, settleProposal } from '../src/memory-proposals.js'

// box-a is an ordinary box (conversations c1, c2), box-b the Coordinator's
// (coord), box-c a user-only box (u1), box-d a protected one (d1).
async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const a = createAgent(s.db, alice.id, 'box-a')
  const b = createAgent(s.db, alice.id, 'box-b')
  const c = createAgent(s.db, alice.id, 'box-c')
  const d = createAgent(s.db, alice.id, 'box-d')
  s.db.prepare('UPDATE devices SET consent_user_only=1 WHERE id=?').run(c.deviceId)
  s.db.prepare('UPDATE devices SET protected=1 WHERE id=?').run(d.deviceId)
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'Release notes', agentDeviceId: a.deviceId })
  upsertConversation(s.db, { id: 'c2', ownerUserId: alice.id, title: 'Other work', agentDeviceId: a.deviceId })
  upsertConversation(s.db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator', agentDeviceId: b.deviceId })
  upsertConversation(s.db, { id: 'u1', ownerUserId: alice.id, title: 'Mail', agentDeviceId: c.deviceId })
  upsertConversation(s.db, { id: 'd1', ownerUserId: alice.id, title: 'Keys', agentDeviceId: d.deviceId })
  setCoordinatorConvoId(s.db, alice.id, 'coord')
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  return { s, alice, a, b, c, d, client: login.json.token }
}

// The user's own words in a conversation, cited as the bridge stamps them.
const said = (s, userId, convoId, { at = null } = {}) => {
  const { seq } = append(s.db, { userId, convoId, sender: 'user:alice', type: 'text', payload: { body: 'please remember that' } })
  if (at != null) s.db.prepare('UPDATE events SET ts=? WHERE convo_id=? AND seq=?').run(at, convoId, seq)
  return [{ kind: 'user_message', ref: `${convoId}:${seq}` }]
}
// The user's tap (or typed reply) on an item the conversation owns.
let itemNum = 9000
const onItem = (s, userId, deviceId, convoId, { tap = true } = {}) => {
  const num = ++itemNum
  const now = Date.now()
  s.db.prepare(`INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
    VALUES(?,?,?,'question','open',?,?,?,?,'agent',?,?)`).run(`it_t${num}`, userId, num, num, 'Remember this?', convoId, deviceId, now, now)
  s.db.prepare(`INSERT INTO item_comments(id,item_id,user_id,author,device_id,kind,body,meta,created_at)
    VALUES(?,?,?,'user',?,'comment',?,?,?)`).run(`ic_t${num}`, `it_t${num}`, userId, deviceId, 'Yes', tap ? JSON.stringify({ action: 'Yes' }) : null, now)
  return [{ kind: tap ? 'item_tap' : 'item_reply', ref: `item:${num}@${new Date(now).toISOString()}` }]
}
const put = (s, token, name, body) => s.http(`/memories/${name}`, { method: 'PUT', token, body: { description: 'Never use opal.', ...body } })
const del = (s, token, name, body = null) => s.http(`/memories/${name}`, { method: 'DELETE', token, body })
const tap = (s, token, itemId, action) => s.http(`/items/${itemId}/comments`, { method: 'POST', token, body: { action } })
const memory = (s, client, name) => s.http(`/memories/${name}`, { token: client })
const events = (s, type) => s.db.prepare('SELECT convo_id, sender, payload FROM events WHERE type=? ORDER BY seq').all(type).map((r) => ({ ...r, payload: JSON.parse(r.payload) }))
const outcomes = (s) => events(s, MEMORY_PROPOSAL_EVENT_TYPE).map((e) => [e.convo_id, e.sender, e.payload.name, e.payload.action, e.payload.outcome])
const proposals = (s) => s.db.prepare('SELECT name, action, state, item_id FROM memory_proposals ORDER BY created_at, rowid').all()

test('an ordinary agent in a turn the user started writes directly: a fresh message, a tap, a reply; delete too', async (t) => {
  const { s, alice, a, client } = await fleet(t)
  const r = await put(s, a.token, 'from-words', { convo_id: 'c1', causes: said(s, alice.id, 'c1') })
  assert.equal(r.status, 201); assert.equal(r.json.memory.created_by, 'agent'); assert.equal(r.json.pending, undefined)
  assert.equal((await put(s, a.token, 'from-tap', { convo_id: 'c1', causes: onItem(s, alice.id, a.deviceId, 'c1') })).status, 201)
  assert.equal((await put(s, a.token, 'from-reply', { convo_id: 'c1', causes: onItem(s, alice.id, a.deviceId, 'c1', { tap: false }) })).status, 201)
  assert.equal((await put(s, a.token, 'from-words', { description: 'Opal is reserved.', convo_id: 'c1', causes: said(s, alice.id, 'c1') })).status, 200)
  const gone = await del(s, a.token, 'from-tap', { convo_id: 'c1', causes: said(s, alice.id, 'c1') })
  assert.equal(gone.status, 200); assert.equal(gone.json.memory.name, 'from-tap')
  assert.equal((await memory(s, client, 'from-tap')).status, 404)
  assert.deepEqual(proposals(s), [])
  // The user's own app is never asked.
  assert.equal((await put(s, client, 'mine', {})).status, 201)
  assert.equal((await del(s, client, 'mine')).status, 200)
  // Causes are an agent's field, and must be a usable list.
  assert.equal((await put(s, client, 'mine', { causes: said(s, alice.id, 'c1') })).status, 400)
  for (const causes of [[{ kind: 'nope' }], 'x', []]) {
    assert.equal((await put(s, a.token, 'bad', { convo_id: 'c1', causes })).status, 400)
    assert.equal((await del(s, a.token, 'from-words', { convo_id: 'c1', causes })).status, 400)
  }
  assert.deepEqual(proposals(s), [])
})

test('a write with no user behind it becomes a proposal: 202, nothing saved, a question awaiting the user', async (t) => {
  const { s, a, b, client } = await fleet(t)
  const r = await put(s, a.token, 'avoid-opal', { body: '**Why:** reserved.', type: 'project', scope: 'repo:web-app', convo_id: 'c1' })
  assert.equal(r.status, 202)
  assert.equal(r.json.pending, 'owner'); assert.equal(r.json.memory, undefined)
  assert.equal(r.json.proposal.name, 'avoid-opal'); assert.equal(r.json.proposal.action, 'save'); assert.equal(r.json.proposal.state, 'pending')
  assert.ok(r.json.proposal.expires_at > Date.now() + PROPOSAL_TTL_MS - 60000)
  assert.equal((await memory(s, client, 'avoid-opal')).status, 404)
  assert.deepEqual(events(s, 'memory'), [])
  const item = (await s.http(`/items/${r.json.item.id}`, { token: client })).json.item
  assert.equal(item.num, r.json.item.num); assert.equal(item.kind, 'question'); assert.equal(item.state, 'open'); assert.equal(item.awaiting, 'user')
  assert.deepEqual(item.actions, ['Save it', 'Decline']); assert.equal(item.consent, 'memory'); assert.equal(item.origin_convo_id, 'c1')
  assert.match(item.title, /^Save the memory "avoid-opal"\? — proposed by box-a$/)
  for (const line of ['**box-a** proposes to save a memory, from the conversation "Release notes".', '- **Name:** `avoid-opal`', '- **Scope:** repo:web-app', '- **Type:** project']) {
    assert.ok(item.body.split('\n').includes(line), line)
  }
  assert.ok(item.body.includes(fenced('Never use opal.'))); assert.ok(item.body.includes(fenced('**Why:** reserved.')))
  // It is in the user's list, and in no agent's: not the proposer's, not the Coordinator's.
  assert.ok((await s.http('/items', { token: client })).json.items.some((i) => i.id === item.id))
  for (const token of [a.token, b.token]) {
    assert.equal((await s.http(`/items/${item.id}`, { token })).status, 404)
    assert.ok(!(await s.http('/items', { token })).json.items.some((i) => i.id === item.id))
  }
  // The item marker is a client's only; the proposer can still read memories as before.
  const marker = events(s, 'item').at(-1)
  assert.equal(marker.payload.consent, 'memory'); assert.equal(marker.payload.action, 'created'); assert.equal(marker.sender, 'agent:box-a')
  assert.equal((await s.http('/memories', { token: a.token })).status, 200)
})

test('what does not count as the user asking: no causes, a routine, a reminder, a room message, an alert, a carry-on, a spawn outcome, stale or foreign words', async (t) => {
  const { s, alice, a, b, client } = await fleet(t)
  const routine = await s.http('/routines', { method: 'POST', token: client, body: { name: 'daily-sweep', title: 'Sweep', prompt: 'Routine daily-sweep: sweep.', schedule: '0 8 * * *' } })
  assert.equal(routine.status, 201)
  const firedAt = Date.now() - 60000
  s.db.prepare('UPDATE routines SET last_fired_at=? WHERE id=?').run(firedAt, routine.json.routine.id)
  const cases = {
    'no-causes': { token: a.token, convo_id: 'c1' },
    'no-convo': { token: a.token, causes: said(s, alice.id, 'c1') },
    routine: { token: b.token, convo_id: 'coord', causes: [{ kind: 'routine', ref: `routine:daily-sweep@${new Date(firedAt).toISOString()}` }] },
    reminder: { token: a.token, convo_id: 'c1', causes: [{ kind: 'reminder', ref: 'reminder:3' }] },
    room: { token: a.token, convo_id: 'c1', causes: [{ kind: 'room_message', ref: 'room:r1@4' }] },
    alert: { token: a.token, convo_id: 'c1', causes: [{ kind: 'alert' }] },
    'carry-on': { token: a.token, convo_id: 'c1', causes: [{ kind: 'carry_on' }] },
    spawn: { token: a.token, convo_id: 'c1', causes: [{ kind: 'spawn_outcome', ref: 'spawn:sp_1' }] },
    other: { token: a.token, convo_id: 'c1', causes: [{ kind: 'other' }] },
    // Her words, with something else in the same turn.
    mixed: { token: a.token, convo_id: 'c1', causes: [...said(s, alice.id, 'c1'), { kind: 'room_message', ref: 'room:r1@4' }] },
    stale: { token: a.token, convo_id: 'c1', causes: said(s, alice.id, 'c1', { at: Date.now() - MEMORY_DIRECT_WINDOW_MS - 60000 }) },
    elsewhere: { token: a.token, convo_id: 'c1', causes: said(s, alice.id, 'c2') },
    'not-hers': { token: a.token, convo_id: 'c1', causes: (() => { const { seq } = append(s.db, { userId: alice.id, convoId: 'c1', sender: 'agent:box-a', type: 'text', payload: { body: 'remember that' } }); return [{ kind: 'user_message', ref: `c1:${seq}` }] })() },
    unknown: { token: a.token, convo_id: 'c1', causes: [{ kind: 'user_message', ref: 'c1:99999' }] },
  }
  for (const [name, { token, ...body }] of Object.entries(cases)) {
    const r = await put(s, token, name, body)
    assert.equal(r.status, 202, name); assert.equal(r.json.pending, 'owner', name)
    assert.equal((await memory(s, client, name)).status, 404, name)
    // Answered as it goes, so the conversation stays under its cap.
    assert.equal((await tap(s, client, r.json.item.id, 'Decline')).status, 200, name)
  }
  assert.equal(proposals(s).length, Object.keys(cases).length)
  // Just inside the window still counts.
  assert.equal((await put(s, a.token, 'recent', { convo_id: 'c1', causes: said(s, alice.id, 'c1', { at: Date.now() - MEMORY_DIRECT_WINDOW_MS + 60000 }) })).status, 201)
  // A delete follows the same rule, and without a conversation it has no causes to check.
  assert.equal((await del(s, a.token, 'recent')).status, 202)
  assert.equal((await del(s, a.token, 'recent', { convo_id: 'c1', causes: [{ kind: 'reminder' }] })).status, 202)
  assert.equal((await memory(s, client, 'recent')).status, 200)
})

test('a user-only box and a protected box always propose, even in a turn the user started', async (t) => {
  const { s, alice, c, d, client } = await fleet(t)
  for (const [dev, convo, name] of [[c, 'u1', 'from-user-only'], [d, 'd1', 'from-protected']]) {
    const r = await put(s, dev.token, name, { convo_id: convo, causes: said(s, alice.id, convo) })
    assert.equal(r.status, 202, name)
    assert.equal((await memory(s, client, name)).status, 404)
    assert.equal((await put(s, dev.token, name, { convo_id: convo, causes: onItem(s, alice.id, dev.deviceId, convo) })).status, 202)
  }
  await put(s, client, 'standing', {})
  assert.equal((await del(s, c.token, 'standing', { convo_id: 'u1', causes: said(s, alice.id, 'u1') })).status, 202)
  // Reads are as before.
  assert.equal((await s.http('/memories/standing', { token: c.token })).status, 200)
  assert.equal((await s.http('/memories', { token: d.token })).json.memories.length, 1)
})

test('the user approves: the memory is saved as proposed, the item closes, the proposer is told', async (t) => {
  const { s, a, client } = await fleet(t)
  const r = await put(s, a.token, 'avoid-opal', { body: 'Reserved.', type: 'project', scope: 'coordinator', convo_id: 'c1' })
  const ok = await tap(s, client, r.json.item.id, 'Save it')
  assert.equal(ok.status, 200); assert.equal(ok.json.proposal.state, 'approved')
  assert.equal(ok.json.item.state, 'closed'); assert.equal(ok.json.item.resolution, 'decided')
  const m = (await memory(s, client, 'avoid-opal')).json.memory
  assert.deepEqual([m.description, m.body, m.type, m.scope, m.origin_convo_id, m.origin_device_id, m.created_by, m.updated_by],
    ['Never use opal.', 'Reserved.', 'project', 'coordinator', 'c1', a.deviceId, 'agent', 'agent'])
  // The memory markers a direct write emits, saying who decided.
  const markers = events(s, 'memory')
  assert.deepEqual(markers.map((e) => e.convo_id), ['c1', 'coord'])
  assert.equal(markers[0].sender, 'user:alice')
  assert.deepEqual(markers[0].payload, { memory_id: m.id, name: 'avoid-opal', type: 'project', scope: 'coordinator', description: 'Never use opal.', action: 'saved', created: true, by: 'user', proposal: { id: r.json.proposal.id, proposed_by: 'agent' } })
  assert.deepEqual(outcomes(s), [['c1', 'journal', 'avoid-opal', 'save', 'approved']])
  assert.deepEqual(events(s, MEMORY_PROPOSAL_EVENT_TYPE)[0].payload.item, { id: r.json.item.id, num: r.json.item.num })
  // Answered once: a second tap finds nothing waiting.
  assert.equal((await tap(s, client, r.json.item.id, 'Decline')).status, 409)
  assert.equal(events(s, 'memory').length, 2)
  // An update shows the current description beside the proposed one, and approval overwrites.
  const u = await put(s, a.token, 'avoid-opal', { description: 'Opal is retired.', convo_id: 'c1' })
  assert.equal(u.status, 202)
  const item = (await s.http(`/items/${u.json.item.id}`, { token: client })).json.item
  assert.match(item.title, /^Change the memory "avoid-opal"\?/)
  assert.ok(item.body.includes(`**Current description:**\n\n${fenced('Never use opal.')}`))
  assert.ok(item.body.includes(`**Proposed description:**\n\n${fenced('Opal is retired.')}`))
  assert.equal((await tap(s, client, u.json.item.id, 'Save it')).status, 200)
  const after = (await memory(s, client, 'avoid-opal')).json.memory
  assert.deepEqual([after.id, after.description, after.body, after.type, after.scope], [m.id, 'Opal is retired.', '', 'project', 'coordinator'])
})

test('the user declines, or closes the question: nothing is saved and the proposer is told', async (t) => {
  const { s, a, client } = await fleet(t)
  const r = await put(s, a.token, 'one', { convo_id: 'c1' })
  assert.equal((await tap(s, client, r.json.item.id, 'Nope')).status, 400)
  const no = await tap(s, client, r.json.item.id, 'Decline')
  assert.equal(no.status, 200); assert.equal(no.json.proposal.state, 'declined'); assert.equal(no.json.item.state, 'closed')
  assert.equal((await memory(s, client, 'one')).status, 404)
  const r2 = await put(s, a.token, 'two', { convo_id: 'c1' })
  assert.equal((await s.http(`/items/${r2.json.item.id}/close`, { method: 'POST', token: client, body: { resolution: 'cancelled' } })).status, 200)
  assert.equal((await memory(s, client, 'two')).status, 404)
  assert.deepEqual(proposals(s).map((p) => p.state), ['declined', 'declined'])
  assert.deepEqual(outcomes(s), [['c1', 'journal', 'one', 'save', 'declined'], ['c1', 'journal', 'two', 'save', 'declined']])
  assert.deepEqual(events(s, 'memory'), [])
  // A closed question stays closed.
  assert.equal((await s.http(`/items/${r2.json.item.id}/reopen`, { method: 'POST', token: client, body: {} })).status, 409)
  assert.equal((await tap(s, client, r2.json.item.id, 'Save it')).status, 409)
})

test('no agent can answer a proposal: not the proposer, not the Coordinator, not a user-only box', async (t) => {
  const { s, a, b, c, client } = await fleet(t)
  const r = await put(s, a.token, 'avoid-opal', { convo_id: 'c1' })
  const mine = await put(s, b.token, 'coordinator-rule', { convo_id: 'coord' })
  for (const token of [a.token, b.token, c.token]) {
    for (const id of [r.json.item.id, mine.json.item.id]) {
      for (const path of [`/items/${id}/comments`, `/items/${id}/close`]) {
        const body = path.endsWith('close') ? { resolution: 'done' } : { action: 'Save it' }
        assert.ok([403, 404].includes((await s.http(path, { method: 'POST', token, body })).status))
      }
      assert.equal((await s.http(`/items/${id}/comments`, { method: 'POST', token, body: { body: 'Save it' } })).status, 404)
      assert.equal((await s.http(`/items/${id}`, { method: 'PATCH', token, body: { title: 'Harmless', actions: ['Save it'] } })).status, 404)
    }
  }
  // No item an agent files can stand in for the question.
  const fake = await s.http('/items', { method: 'POST', token: a.token, body: { kind: 'question', title: 'Save the memory "avoid-opal"?', convo_id: 'c1', actions: ['Save it', 'Decline'] } })
  assert.equal(fake.status, 201)
  assert.equal((await tap(s, client, fake.json.item.id, 'Save it')).status, 201) // an ordinary reply, nothing more
  assert.equal((await memory(s, client, 'avoid-opal')).status, 404)
  assert.equal((await memory(s, client, 'coordinator-rule')).status, 404)
  assert.deepEqual(proposals(s).map((p) => p.state), ['pending', 'pending'])
  assert.equal((await tap(s, client, r.json.item.id, 'Save it')).status, 200)
  assert.equal((await memory(s, client, 'avoid-opal')).status, 200)
})

test('one pending proposal per name: a newer one replaces it, whoever sends it — old item cancelled, new item filed', async (t) => {
  const { s, a, client } = await fleet(t)
  const first = await put(s, a.token, 'avoid-opal', { description: 'First wording.', convo_id: 'c1' })
  // The same session, the same conversation: still a new proposal and a new item.
  const second = await put(s, a.token, 'avoid-opal', { description: 'Second wording.', body: 'More.', convo_id: 'c1' })
  assert.equal(second.status, 202)
  assert.notEqual(second.json.item.id, first.json.item.id); assert.notEqual(second.json.proposal.id, first.json.proposal.id)
  const old = (await s.http(`/items/${first.json.item.id}`, { token: client })).json.item
  assert.equal(old.state, 'closed'); assert.equal(old.resolution, 'cancelled')
  // The older item still shows what it asked about, never the newer wording.
  assert.ok(old.body.includes(fenced('First wording.'))); assert.ok(!old.body.includes('Second wording.'))
  const fresh = (await s.http(`/items/${second.json.item.id}`, { token: client })).json.item
  assert.ok(fresh.body.includes(fenced('Second wording.'))); assert.ok(!fresh.body.includes('First wording.'))
  assert.equal(fresh.state, 'open'); assert.equal(fresh.awaiting, 'user'); assert.deepEqual(fresh.actions, ['Save it', 'Decline'])
  assert.deepEqual(outcomes(s), [['c1', 'journal', 'avoid-opal', 'save', 'replaced']])
  // A tap that was on its way to the older item is a conflict and changes nothing.
  for (const action of ['Save it', 'Decline']) assert.equal((await tap(s, client, first.json.item.id, action)).status, 409)
  assert.equal((await memory(s, client, 'avoid-opal')).status, 404)
  assert.deepEqual(proposals(s).map((p) => p.state), ['replaced', 'pending'])
  assert.deepEqual(events(s, 'memory'), [])
  // Another name is its own question.
  const other = await put(s, a.token, 'avoid-jade', { convo_id: 'c1' })
  assert.notEqual(other.json.item.id, second.json.item.id)
  // From another conversation: the same again, and the older session is told.
  const third = await put(s, a.token, 'avoid-opal', { description: 'Third wording.', convo_id: 'c2' })
  assert.equal((await s.http(`/items/${second.json.item.id}`, { token: client })).json.item.state, 'closed')
  assert.deepEqual(outcomes(s), [['c1', 'journal', 'avoid-opal', 'save', 'replaced'], ['c1', 'journal', 'avoid-opal', 'save', 'replaced']])
  assert.equal((await tap(s, client, second.json.item.id, 'Save it')).status, 409)
  assert.equal((await tap(s, client, third.json.item.id, 'Save it')).status, 200)
  assert.equal((await memory(s, client, 'avoid-opal')).json.memory.description, 'Third wording.')
  assert.deepEqual(proposals(s).map((p) => [p.name, p.state]), [['avoid-opal', 'replaced'], ['avoid-opal', 'replaced'], ['avoid-jade', 'pending'], ['avoid-opal', 'approved']])
})

test('a tap settles only a proposal still pending and still bound to that item', async (t) => {
  const { s, a, alice, client } = await fleet(t)
  const r = await put(s, a.token, 'avoid-opal', { description: 'First wording.', convo_id: 'c1' })
  // The proposal is no longer this item's: the tap applies nothing.
  s.db.prepare('UPDATE memory_proposals SET item_id=? WHERE id=?').run('it_elsewhere', r.json.proposal.id)
  assert.equal(settleProposal(s.db, { userId: alice.id, id: r.json.proposal.id, itemId: r.json.item.id, state: 'approved' }), null)
  assert.equal((await tap(s, client, r.json.item.id, 'Save it')).status, 409)
  s.db.prepare('UPDATE memory_proposals SET item_id=? WHERE id=?').run(r.json.item.id, r.json.proposal.id)
  // Settled once: the second writer gets nothing.
  assert.equal(settleProposal(s.db, { userId: alice.id, id: r.json.proposal.id, itemId: r.json.item.id, state: 'declined' }).state, 'declined')
  assert.equal(settleProposal(s.db, { userId: alice.id, id: r.json.proposal.id, itemId: r.json.item.id, state: 'approved' }), null)
  assert.equal((await tap(s, client, r.json.item.id, 'Save it')).status, 409)
  assert.equal((await memory(s, client, 'avoid-opal')).status, 404)
})

test('pending proposals are capped per conversation and per user; a replacement is not a new one', async (t) => {
  const { s, a, b, client } = await fleet(t)
  const tooMany = { status: 409, json: { error: 'conflict', blocked_by: 'too_many_asks' } }
  const count = () => s.db.prepare("SELECT COUNT(*) AS n FROM memory_proposals WHERE state='pending'").get().n
  const items = async () => (await s.http('/items', { token: client })).json.items.length
  for (let i = 0; i < MAX_PENDING_PER_CONVO; i++) assert.equal((await put(s, a.token, `rule-${i}`, { convo_id: 'c1' })).status, 202)
  const before = await items()
  assert.deepEqual(await put(s, a.token, 'one-more', { convo_id: 'c1' }), tooMany)
  await put(s, client, 'standing', {})
  assert.deepEqual(await del(s, a.token, 'standing', { convo_id: 'c1' }), tooMany)
  assert.equal(count(), MAX_PENDING_PER_CONVO); assert.equal(await items(), before) // nothing stored, no item filed
  assert.equal((await memory(s, client, 'standing')).status, 200)
  // Replacing one of its own pending proposals adds nothing, so it goes through.
  assert.equal((await put(s, a.token, 'rule-3', { description: 'Reworded.', convo_id: 'c1' })).status, 202)
  assert.equal(count(), MAX_PENDING_PER_CONVO)
  // Another conversation has its own allowance; an answer frees a place.
  assert.equal((await put(s, a.token, 'one-more', { convo_id: 'c2' })).status, 202)
  const open = s.db.prepare("SELECT item_id FROM memory_proposals WHERE state='pending' AND from_convo_id='c1' LIMIT 1").get().item_id
  assert.equal((await tap(s, client, open, 'Decline')).status, 200)
  assert.equal((await put(s, a.token, 'after-an-answer', { convo_id: 'c1' })).status, 202)
  // Writes that name no conversation count against their device.
  for (let i = 0; i < MAX_PENDING_PER_CONVO; i++) assert.equal((await put(s, b.token, `loose-${i}`, {})).status, 202)
  assert.deepEqual(await put(s, b.token, 'loose-more', {}), tooMany)
  // The user's cap, across every conversation.
  const ins = s.db.prepare(`INSERT INTO memory_proposals(id, user_id, name, action, from_device_id, from_convo_id, state, created_at, updated_at, expires_at)
    VALUES(?,?,?,'save',?,?,'pending',?,?,?)`)
  const now = Date.now()
  for (let i = count(); i < MAX_PENDING_PER_USER; i++) ins.run(`mp_fill${i}`, 1, `fill-${i}`, a.deviceId, `other-${i}`, now, now, now + 60000)
  assert.equal(count(), MAX_PENDING_PER_USER)
  assert.deepEqual(await put(s, b.token, 'past-the-user-cap', { convo_id: 'coord' }), tooMany)
  assert.equal((await put(s, b.token, 'fill-49', { convo_id: 'coord' })).status, 202) // replaces a pending one
  assert.equal(count(), MAX_PENDING_PER_USER)
  // The user's own writes are never proposals, so never capped.
  assert.equal((await put(s, client, 'mine', {})).status, 201)
})

test('a delete is proposed the same way: Delete it / Keep it, the memory shown, gone only on approval', async (t) => {
  const { s, a, client } = await fleet(t)
  await put(s, client, 'avoid-opal', { body: 'Reserved.' })
  const r = await del(s, a.token, 'avoid-opal', { convo_id: 'c1' })
  assert.equal(r.status, 202); assert.equal(r.json.proposal.action, 'delete'); assert.equal(r.json.pending, 'owner')
  assert.equal((await s.http('/memories/avoid-opal', { token: a.token })).status, 200)
  const item = (await s.http(`/items/${r.json.item.id}`, { token: client })).json.item
  assert.deepEqual(item.actions, ['Delete it', 'Keep it']); assert.match(item.title, /^Delete the memory "avoid-opal"\?/)
  assert.ok(item.body.includes(fenced('Never use opal.'))); assert.ok(item.body.includes(fenced('Reserved.')))
  const keep = await tap(s, client, r.json.item.id, 'Keep it')
  assert.equal(keep.status, 200); assert.equal(keep.json.proposal.state, 'declined')
  assert.equal((await memory(s, client, 'avoid-opal')).status, 200)
  const again = await del(s, a.token, 'avoid-opal', { convo_id: 'c1' })
  assert.notEqual(again.json.item.id, r.json.item.id)
  const yes = await tap(s, client, again.json.item.id, 'Delete it')
  assert.equal(yes.status, 200); assert.equal(yes.json.item.resolution, 'decided')
  assert.equal((await memory(s, client, 'avoid-opal')).status, 404)
  const last = events(s, 'memory').at(-1)
  assert.equal(last.payload.action, 'deleted'); assert.equal(last.payload.by, 'user'); assert.equal(last.payload.proposal.proposed_by, 'agent')
  assert.deepEqual(outcomes(s), [['c1', 'journal', 'avoid-opal', 'delete', 'declined'], ['c1', 'journal', 'avoid-opal', 'delete', 'approved']])
  // Nothing to propose deleting: 404 as before.
  assert.equal((await del(s, a.token, 'avoid-opal', { convo_id: 'c1' })).status, 404)
})

const stale = (r) => [r.status, r.json.error, r.json.blocked_by, r.json.proposal?.state, r.json.item?.state, r.json.item?.resolution]
const STALE = [409, 'conflict', 'memory_changed', 'stale', 'closed', 'cancelled']

test('the scope and type a save will have are fixed when it is proposed, shown on the item, and applied as shown', async (t) => {
  const { s, a, client } = await fleet(t)
  await put(s, client, 'release-flow', { scope: 'repo:web-app', type: 'project' })
  // The proposal names neither: it keeps the memory's, as they are now.
  const r = await put(s, a.token, 'release-flow', { description: 'The train merges.', convo_id: 'c1' })
  const row = s.db.prepare('SELECT scope, type, memory_id, base_updated_at FROM memory_proposals WHERE id=?').get(r.json.proposal.id)
  const before = (await memory(s, client, 'release-flow')).json.memory
  assert.deepEqual(row, { scope: 'repo:web-app', type: 'project', memory_id: before.id, base_updated_at: before.updated_at })
  const item = (await s.http(`/items/${r.json.item.id}`, { token: client })).json.item
  assert.ok(item.body.split('\n').includes('- **Scope:** repo:web-app')); assert.ok(item.body.split('\n').includes('- **Type:** project'))
  // The memory's scope moves before the answer: approving would no longer do what the item says.
  await new Promise((done) => setTimeout(done, 5))
  assert.equal((await put(s, client, 'release-flow', { scope: 'global' })).status, 200)
  assert.deepEqual(stale(await tap(s, client, r.json.item.id, 'Save it')), STALE)
  const kept = (await memory(s, client, 'release-flow')).json.memory
  assert.deepEqual([kept.scope, kept.description], ['global', 'Never use opal.'])
  assert.deepEqual(outcomes(s), [['c1', 'journal', 'release-flow', 'save', 'stale']])
  assert.equal((await tap(s, client, r.json.item.id, 'Save it')).status, 409)
  // Asked again against the memory as it now is, it applies exactly what it shows.
  const again = await put(s, a.token, 'release-flow', { description: 'The train merges.', convo_id: 'c1' })
  assert.ok((await s.http(`/items/${again.json.item.id}`, { token: client })).json.item.body.split('\n').includes('- **Scope:** global'))
  assert.equal((await tap(s, client, again.json.item.id, 'Save it')).status, 200)
  const done = (await memory(s, client, 'release-flow')).json.memory
  assert.deepEqual([done.scope, done.type, done.description], ['global', 'project', 'The train merges.'])
  // A new memory with nothing named gets the defaults, stored and shown.
  const fresh = await put(s, a.token, 'brand-new', { convo_id: 'c1' })
  assert.deepEqual(s.db.prepare('SELECT scope, type, memory_id, base_updated_at FROM memory_proposals WHERE id=?').get(fresh.json.proposal.id), { scope: 'global', type: 'feedback', memory_id: null, base_updated_at: null })
  // A proposed scope that differs from the memory's shows both.
  const moved = await put(s, a.token, 'release-flow', { scope: 'coordinator', convo_id: 'c2' })
  assert.ok((await s.http(`/items/${moved.json.item.id}`, { token: client })).json.item.body.split('\n').includes('- **Scope:** coordinator (now global)'))
})

test('an approval applies only while the memory is as it was when the question was filed', async (t) => {
  const { s, a, client } = await fleet(t)
  const tick = () => new Promise((done) => setTimeout(done, 5))
  // An update whose target was deleted meanwhile.
  await put(s, client, 'one', {})
  const upd = await put(s, a.token, 'one', { description: 'Reworded.', convo_id: 'c1' })
  await del(s, client, 'one')
  assert.deepEqual(stale(await tap(s, client, upd.json.item.id, 'Save it')), STALE)
  assert.equal((await memory(s, client, 'one')).status, 404)
  // A create where a memory of that name appeared meanwhile.
  const create = await put(s, a.token, 'two', { description: 'From the agent.', convo_id: 'c1' })
  await put(s, client, 'two', { description: 'From the user.' })
  assert.deepEqual(stale(await tap(s, client, create.json.item.id, 'Save it')), STALE)
  assert.equal((await memory(s, client, 'two')).json.memory.description, 'From the user.')
  // A delete whose target changed, and one whose target went and came back.
  await put(s, client, 'three', {})
  const d1 = await del(s, a.token, 'three', { convo_id: 'c1' })
  await tick(); await put(s, client, 'three', { description: 'Changed since.' })
  assert.deepEqual(stale(await tap(s, client, d1.json.item.id, 'Delete it')), STALE)
  assert.equal((await memory(s, client, 'three')).json.memory.description, 'Changed since.')
  const d2 = await del(s, a.token, 'three', { convo_id: 'c1' })
  await del(s, client, 'three'); await put(s, client, 'three', {})
  assert.deepEqual(stale(await tap(s, client, d2.json.item.id, 'Delete it')), STALE)
  assert.equal((await memory(s, client, 'three')).status, 200)
  // A delete whose target is simply gone.
  await put(s, client, 'four', {})
  const d3 = await del(s, a.token, 'four', { convo_id: 'c1' })
  await del(s, client, 'four')
  assert.deepEqual(stale(await tap(s, client, d3.json.item.id, 'Delete it')), STALE)
  // The item says why, in the journal's voice; the proposer hears `stale` each time.
  const thread = (await s.http(`/items/${d3.json.item.id}`, { token: client })).json.comments
  assert.match(thread.at(-1).body, /^Not applied: the memory changed after this was asked/); assert.equal(thread.at(-1).author, 'agent')
  assert.deepEqual(outcomes(s).map((o) => o[4]), ['stale', 'stale', 'stale', 'stale', 'stale'])
  assert.equal(events(s, 'memory').filter((e) => e.payload.proposal).length, 0)
  // Declining a proposal whose memory changed is still just a decline.
  await put(s, client, 'five', {})
  const d4 = await del(s, a.token, 'five', { convo_id: 'c1' })
  await del(s, client, 'five')
  const no = await tap(s, client, d4.json.item.id, 'Keep it')
  assert.equal(no.status, 200); assert.equal(no.json.proposal.state, 'declined')
})

test('settling and closing are one write; expiry is all-or-nothing; what is still owed is made good by the next sweep', async (t) => {
  const { s, a, client } = await fleet(t)
  const ctx = { db: s.db, hub: s.hub, pushPipeline: null }
  const itemState = async (id) => (await s.http(`/items/${id}`, { token: client })).json.item.state
  const told = () => s.db.prepare('SELECT name, state, told_at IS NOT NULL AS told FROM memory_proposals ORDER BY created_at, rowid').all().map((r) => [r.name, r.state, r.told])
  // A close that fails takes the settlement back with it: the question stays answerable.
  const r = await put(s, a.token, 'one', { convo_id: 'c1' })
  s.db.exec("CREATE TRIGGER no_close BEFORE UPDATE OF state ON items WHEN NEW.state='closed' BEGIN SELECT RAISE(ABORT, 'no close'); END")
  assert.equal((await tap(s, client, r.json.item.id, 'Save it')).status, 500)
  assert.deepEqual(told(), [['one', 'pending', 0]]); assert.equal((await memory(s, client, 'one')).status, 404)
  // The same for expiry: two run out, the close fails, neither is marked.
  const r2 = await put(s, a.token, 'two', { convo_id: 'c1' })
  s.db.prepare('UPDATE memory_proposals SET expires_at=?').run(Date.now() - 1000)
  assert.throws(() => sweepMemoryProposals(ctx), /no close/)
  assert.deepEqual(told(), [['one', 'pending', 0], ['two', 'pending', 0]])
  s.db.exec('DROP TRIGGER no_close')
  sweepMemoryProposals(ctx)
  assert.deepEqual(told(), [['one', 'expired', 1], ['two', 'expired', 1]])
  assert.equal(await itemState(r.json.item.id), 'closed'); assert.equal(await itemState(r2.json.item.id), 'closed')
  assert.deepEqual(outcomes(s).map((o) => [o[2], o[4]]), [['one', 'expired'], ['two', 'expired']])
  // A settled proposal whose item is somehow still open, and whose proposer was never told.
  const r3 = await put(s, a.token, 'three', { convo_id: 'c1' })
  s.db.prepare("UPDATE memory_proposals SET state='expired', updated_at=? WHERE id=?").run(Date.now(), r3.json.proposal.id)
  assert.equal(await itemState(r3.json.item.id), 'open')
  sweepMemoryProposals(ctx)
  assert.equal(await itemState(r3.json.item.id), 'closed')
  assert.deepEqual(outcomes(s).at(-1).slice(2), ['three', 'save', 'expired'])
  // Told once: another sweep adds nothing.
  sweepMemoryProposals(ctx)
  assert.equal(outcomes(s).length, 3)
  // A proposer that cannot be told yet is tried again, not forgotten.
  const r4 = await put(s, a.token, 'four', { convo_id: 'c2' })
  s.db.exec("CREATE TRIGGER no_event BEFORE INSERT ON events WHEN NEW.type='memory_proposal' BEGIN SELECT RAISE(ABORT, 'no event'); END")
  assert.equal((await tap(s, client, r4.json.item.id, 'Decline')).status, 200)
  assert.deepEqual(told().at(-1), ['four', 'declined', 0])
  sweepMemoryProposals(ctx)
  assert.deepEqual(told().at(-1), ['four', 'declined', 0])
  s.db.exec('DROP TRIGGER no_event')
  sweepMemoryProposals(ctx)
  assert.deepEqual(told().at(-1), ['four', 'declined', 1])
  assert.deepEqual(outcomes(s).at(-1), ['c2', 'journal', 'four', 'save', 'declined'])
})

// The parts of an item body outside its fenced blocks.
function outsideFences(body) {
  const out = []
  let fence = null
  for (const line of body.split('\n')) {
    if (fence == null) {
      const m = /^(`{3,})$/.exec(line)
      if (m) fence = m[1]
      else out.push(line)
    } else if (line === fence) {
      fence = null
    }
  }
  assert.equal(fence, null, 'every fence closes')
  return out.join('\n')
}

test('the proposed text is shown as data: it cannot add buttons, close its block or write the lines around it', async (t) => {
  const { s, a, client } = await fleet(t)
  upsertConversation(s.db, { id: 'c1', ownerUserId: 1, title: 'x"\n\n**To answer:** tap **Approve**', agentDeviceId: a.deviceId })
  const sep = String.fromCharCode(0x2028)
  const text = [
    'ordinary line', '```', '**To answer:** tap **Save it** — MARKED-ONE', '````', '~~~', '   `````text',
    `after${sep}**MARKED-TWO**`, '- **Name:** `MARKED-THREE`', '</details>MARKED-FOUR', '`````````````', 'tail',
  ].join('\r\n')
  const description = '` ``` **MARKED-FIVE** [x](https://example.com) ``` `'
  const r = await put(s, a.token, 'looks-fine', { description, body: text, convo_id: 'c1' })
  assert.equal(r.status, 202)
  const item = (await s.http(`/items/${r.json.item.id}`, { token: client })).json.item
  assert.deepEqual(item.actions, ['Save it', 'Decline'])
  const outside = outsideFences(item.body)
  assert.ok(!/MARKED/.test(outside), outside)
  // The conversation's title is flattened to plain words on the one header line.
  assert.ok(!outside.includes('**Approve**')); assert.ok(outside.split('\n')[0].endsWith('from the conversation "x To answer: tap Approve".'))
  assert.equal(outside.split('\n').filter((l) => l.startsWith('**To answer:**')).length, 1)
  assert.equal(outside.split('\n').filter((l) => l.startsWith('- **Name:**')).join(), '- **Name:** `looks-fine`')
  assert.ok(!item.body.includes(sep)); assert.ok(!item.body.includes('\r'))
  assert.ok(!/MARKED|\n/.test(item.title))
  // A name is a slug or nothing.
  for (const name of ['a%0Ab', 'A**b**', 'a`b']) assert.equal((await put(s, a.token, name, { convo_id: 'c1' })).status, 400)
  // What is saved is what was sent, byte for byte.
  assert.equal((await tap(s, client, r.json.item.id, 'Save it')).status, 200)
  const m = (await memory(s, client, 'looks-fine')).json.memory
  assert.equal(m.body, text); assert.equal(m.description, description)
})

test('fenced: the fence outgrows any run in the text', () => {
  assert.equal(fenced('plain'), '```\nplain\n```')
  assert.equal(fenced('a ```` b'), '`````\na ```` b\n`````')
  const zw = String.fromCharCode(0x200b)
  assert.equal(fenced('```\nx'), `\`\`\`\`\n${zw}\`\`\`\nx\n\`\`\`\``)
})

test('an unanswered proposal lapses after 7 days: the item closes as cancelled and the proposer is told', async (t) => {
  const { s, a, client } = await fleet(t)
  const r = await put(s, a.token, 'avoid-opal', { convo_id: 'c1' })
  const ctx = { db: s.db, hub: s.hub, pushPipeline: null }
  sweepMemoryProposals(ctx, Date.now() + PROPOSAL_TTL_MS - 60000)
  assert.deepEqual(proposals(s).map((p) => p.state), ['pending'])
  // Past its time but not yet swept: a tap no longer applies it.
  s.db.prepare('UPDATE memory_proposals SET expires_at=?').run(Date.now() - 1000)
  assert.equal((await tap(s, client, r.json.item.id, 'Save it')).status, 409)
  sweepMemoryProposals(ctx)
  assert.deepEqual(proposals(s).map((p) => p.state), ['expired'])
  const item = (await s.http(`/items/${r.json.item.id}`, { token: client })).json.item
  assert.equal(item.state, 'closed'); assert.equal(item.resolution, 'cancelled')
  assert.equal((await memory(s, client, 'avoid-opal')).status, 404)
  assert.deepEqual(outcomes(s), [['c1', 'journal', 'avoid-opal', 'save', 'expired']])
  assert.equal((await tap(s, client, r.json.item.id, 'Save it')).status, 409)
  // Settled rows are dropped after a while.
  sweepMemoryProposals(ctx, Date.now() + 40 * 24 * 60 * 60 * 1000)
  assert.deepEqual(proposals(s), [])
  // The name is free again.
  assert.equal((await put(s, a.token, 'avoid-opal', { convo_id: 'c1' })).status, 202)
})

test('a proposal with no conversation lives on the Coordinator conversation; the cap still answers 409', async (t) => {
  const { s, a, client, alice } = await fleet(t)
  const r = await put(s, a.token, 'loose', {})
  assert.equal(r.status, 202)
  assert.equal((await s.http(`/items/${r.json.item.id}`, { token: client })).json.item.origin_convo_id, 'coord')
  assert.equal((await tap(s, client, r.json.item.id, 'Save it')).status, 200)
  assert.equal((await memory(s, client, 'loose')).json.memory.origin_convo_id, null)
  assert.deepEqual(outcomes(s), []) // no conversation to tell
  const ins = s.db.prepare(`INSERT INTO memories(id, user_id, name, type, description, created_by, updated_by, created_at, updated_at) VALUES(?,?,?,'feedback','x','user','user',1,1)`)
  for (let i = 0; i < 199; i++) ins.run(`me_fill${i}`, alice.id, `fill-${i}`)
  assert.equal((await put(s, a.token, 'one-too-many', { convo_id: 'c1' })).status, 409)
  assert.equal((await put(s, a.token, 'fill-1', { convo_id: 'c1' })).status, 202) // an update is never refused
})
