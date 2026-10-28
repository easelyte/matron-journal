import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { peopleConvoId } from '../src/people-convo.js'

// Contributors (spec 2026-10-02 matron-to-matron sharing, "Grants":
// contribute): bob, granted alice's mission at `contribute`, writes into it
// — milestones, items, comments, item state, the mission's status — in
// alice's log, under alice's numbering, attributed to him. Replies cross
// both ways as item-reply turns marked as another person's. End to end over
// real HTTP and sockets.
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const post = (body) => ({ method: 'POST', body })
const cards = (w, kind) => w.journal().filter((f) => f.type === 'permission_request' && f.payload.kind === kind)

async function world(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const bob = await createUser(s.db, 'bob', 'pw')
  const aliceBox = createAgent(s.db, alice.id, 'alice-box')
  const bobBox = createAgent(s.db, bob.id, 'bob-box')
  upsertConversation(s.db, { id: 'work', ownerUserId: alice.id, title: 'Garden Club', agentDeviceId: aliceBox.deviceId })
  upsertConversation(s.db, { id: 'bobwork', ownerUserId: bob.id, title: 'Bob', agentDeviceId: bobBox.deviceId })
  const login = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: `${name}-phone` } })).json.token
  const tokens = { alicePhone: await login('alice'), bobPhone: await login('bob'), aliceBox: aliceBox.token, bobBox: bobBox.token }
  const sockets = {}
  for (const k of Object.keys(tokens)) {
    sockets[k] = await makeWsClient(s.base, { token: tokens[k], cursor: null })
    await sockets[k].waitFor((f) => f.op === 'hello_ok')
  }
  t.after(() => { for (const x of Object.values(sockets)) { try { x.close() } catch { /* already closed */ } } })
  const http = (token) => (p, opts = {}) => s.http(p, { token, ...opts })
  return {
    s, alice, bob, ws: sockets, tokens,
    aliceBox: http(tokens.aliceBox), bobBox: http(tokens.bobBox), alicePhone: http(tokens.alicePhone), bobPhone: http(tokens.bobPhone),
  }
}

async function makeContacts(w) {
  const r = await w.alicePhone('/contacts', post({ user: 'bob' }))
  const theirs = (await w.bobPhone('/contacts')).json.contacts[0]
  assert.equal((await w.bobPhone(`/contacts/${theirs.id}/answer`, post({ decision: 'approve' }))).status, 200)
  return r.json.contact.id
}

// alice's mission, shared with bob at `contribute` from her phone.
async function contributing(w) {
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Garden Club launch' }))).json.mission
  const item = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'question', title: 'Which caterer?' }))).json.item
  await makeContacts(w)
  const g = await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'contribute' }))
  assert.equal(g.status, 201)
  assert.equal((await w.bobPhone(`/grants/${g.json.grant.id}/answer`, post({ decision: 'approve' }))).json.grant.level, 'contribute')
  return { m, item, gid: g.json.grant.id }
}

test('a contribute share: two yeses with the share card, worded for writing', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  await makeContacts(w)
  const ask = await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'contribute', convo_id: 'work' }))
  assert.equal(ask.status, 202)
  assert.equal(ask.json.grant.level, 'contribute')
  await settle()
  const card = cards(w.ws.alicePhone, 'mission_share')[0]
  assert.equal(card.payload.level, 'contribute')
  const mirror = (await w.alicePhone('/items?label=consent&state=open')).json.items[0]
  assert.match(mirror.title, /can contribute/)
  assert.equal((await w.aliceBox(`/grants/${ask.json.grant.id}/answer`, post({ decision: 'approve' }))).status, 403)
  await w.alicePhone(`/grants/${ask.json.grant.id}/answer`, post({ decision: 'approve' }))
  await settle()
  assert.equal(cards(w.ws.bobPhone, 'mission_share')[0].payload.level, 'contribute')
  const bobMirror = (await w.bobPhone('/items?label=consent&state=open')).json.items[0]
  assert.match(bobMirror.body, /add milestones/)
  assert.equal((await w.bobBox(`/grants/${ask.json.grant.id}/answer`, post({ decision: 'approve' }))).status, 403)
  await w.bobPhone(`/items/${bobMirror.id}/comments`, post({ action: 'Accept' }))
  const shared = (await w.bobPhone(`/missions/${m.id}`)).json.mission
  assert.deepEqual(shared.grant, { id: ask.json.grant.id, level: 'contribute' })
})

test('a read share is raised to contribute in place', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  await makeContacts(w)
  const read = await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob' }))
  await w.bobPhone(`/grants/${read.json.grant.id}/answer`, post({ decision: 'approve' }))
  const up = await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'contribute' }))
  assert.equal(up.status, 201)
  assert.deepEqual([up.json.grant.id, up.json.grant.level, up.json.grant.pending_level], [read.json.grant.id, 'read', 'contribute'])
  assert.equal((await w.bobBox('/milestones', post({ mission: m.id, kind: 'progress', title: 'x', convo_id: 'bobwork' }))).status, 403, 'still read-only')
  const ok = await w.bobPhone(`/grants/${read.json.grant.id}/answer`, post({ decision: 'approve' }))
  assert.deepEqual([ok.json.grant.level, ok.json.grant.pending_level], ['contribute', null])
  assert.equal((await w.bobBox('/milestones', post({ mission: m.id, kind: 'progress', title: 'x', convo_id: 'bobwork' }))).status, 201)
})

test('a contributor writes into the owner\'s mission, attributed, under the owner\'s numbering', async (t) => {
  const w = await world(t)
  const { m, item } = await contributing(w)
  for (const k of Object.keys(w.ws)) w.ws[k].frames.length = 0

  // A milestone: in alice's log, by bob's agent.
  const ms = await w.bobBox('/milestones', post({ mission: m.id, kind: 'progress', title: 'Menus drafted', body: 'Three options.', convo_id: 'bobwork' }))
  assert.equal(ms.status, 201)
  assert.deepEqual(ms.json.milestone.contributor, { name: 'bob', via: 'agent' })
  const aliceView = (await w.alicePhone(`/missions/${m.id}`)).json
  const mine = aliceView.milestones.find((x) => x.title === 'Menus drafted')
  assert.deepEqual(mine.contributor, { name: 'bob', via: 'agent' })
  assert.equal(mine.convo_id, peopleConvoId(w.s.db, w.alice.id), 'anchored in alice\'s People log, not in a session of hers')
  assert.equal((await w.bobPhone(`/missions/${m.id}`)).json.milestones[0].title, 'Menus drafted')
  // Ordinary milestones carry no contributor key at all.
  await w.aliceBox('/milestones', post({ convo_id: 'work', kind: 'progress', title: 'Own step' }))
  assert.equal('contributor' in (await w.alicePhone(`/missions/${m.id}`)).json.milestones.find((x) => x.title === 'Own step'), false)

  // An item: alice's number, awaiting alice, filed by bob.
  const before = (await w.alicePhone('/items?limit=500')).json.items.reduce((n, i) => Math.max(n, i.num), 0)
  assert.equal((await w.bobBox('/items', post({ mission: m.id, kind: 'question', title: 'Vegetarian option?', convo_id: 'bobwork', attachments: [{ blob_ref: 'x', mime: 'image/png', name: 'x', size: 1 }] }))).status, 400, 'no files cross')
  assert.equal((await w.bobBox('/items', post({ mission: m.id, kind: 'question', title: 'Vegetarian option?', convo_id: 'bobwork', actions: ['Yes', 'No'] }))).status, 400, 'no buttons')
  assert.equal((await w.bobBox('/items', post({ mission: m.id, kind: 'question', title: 'Vegetarian option?', convo_id: 'work' }))).status, 404, 'files from a conversation of its own')
  const filed = await w.bobBox('/items', post({ mission: m.id, kind: 'question', title: 'Vegetarian option?', body: 'Two guests asked.', convo_id: 'bobwork' }))
  assert.equal(filed.status, 201)
  const it = filed.json.item
  assert.equal(it.shared_via, 'grant')
  assert.ok(it.num > before, 'numbered in alice\'s log')
  assert.deepEqual(it.contributor, { name: 'bob', via: 'agent' })
  const aliceItem = (await w.alicePhone(`/items/${it.id}`)).json.item
  assert.equal(aliceItem.awaiting, 'user')
  assert.equal(aliceItem.mission_id, m.id)
  assert.deepEqual(aliceItem.contributor, { name: 'bob', via: 'agent' })
  // bob's conversation is never shown to alice.
  const aliceJson = JSON.stringify([(await w.alicePhone(`/items/${it.id}`)).json, (await w.alicePhone('/items?limit=500')).json, (await w.aliceBox(`/missions/${m.id}`)).json])
  assert.ok(!aliceJson.includes('bobwork'))
  assert.ok(!aliceJson.includes('contributor_convo_id'))

  // A comment on alice's own item reaches alice's agent, as another person's.
  assert.equal((await w.bobBox(`/items/${item.id}/comments`, post({ body: 'The second one is cheaper.', actions: ['Ok'] }))).status, 403, 'no buttons')
  assert.equal((await w.bobPhone(`/items/${item.id}/comments`, post({ action: 'Ok' }))).status, 403, 'no taps on alice\'s buttons')
  const said = await w.bobBox(`/items/${item.id}/comments`, post({ body: 'The second one is cheaper.', convo_id: 'bobwork' }))
  assert.equal(said.status, 201)
  assert.equal(said.json.comment.attribution, "bob's agent")
  assert.deepEqual(said.json.comment.contributor, { name: 'bob', via: 'agent' })
  await settle()
  const turn = w.ws.aliceBox.journal().find((f) => f.type === 'item' && f.payload.item_id === item.id && f.payload.action === 'commented')
  assert.ok(turn, 'alice\'s agent hears it')
  assert.equal(turn.convo_id, 'work')
  assert.equal(turn.sender, 'person:bob')
  assert.deepEqual(turn.payload.person, { name: 'bob', via: 'agent' })
  assert.equal(turn.payload.mission_id, m.id)
  assert.equal(turn.payload.comment.body, 'The second one is cheaper.')
  const thread = (await w.alicePhone(`/items/${item.id}`)).json.comments
  assert.deepEqual(thread.map((c) => [c.author, c.device_id, c.convo_id, c.attribution]), [['agent', 0, null, "bob's agent"]])

  // Item state, but nothing else about the item.
  assert.equal((await w.bobPhone(`/items/${item.id}/close`, post({ resolution: 'answered', comment: 'Settled.' }))).status, 200)
  const closed = (await w.alicePhone(`/items/${item.id}`)).json
  assert.equal(closed.item.state, 'closed')
  assert.equal(closed.comments.at(-1).attribution, 'bob')
  assert.equal((await w.bobPhone(`/items/${item.id}/reopen`, post({}))).status, 200)
  assert.equal((await w.bobPhone(`/items/${item.id}`, { method: 'PATCH', body: { title: 'mine' } })).status, 403)
  assert.equal((await w.bobPhone(`/items/${item.id}`, { method: 'PATCH', body: { mission: null } })).status, 403)
  assert.equal((await w.bobPhone(`/items/${item.id}/rank`, post({ position: 'top' }))).status, 403)

  // The mission's status, but nothing else about the mission.
  const st = await w.bobBox(`/missions/${m.id}`, { method: 'PATCH', body: { status: 'Menus with alice for a pick.' } })
  assert.equal(st.status, 200)
  const after = (await w.alicePhone(`/missions/${m.id}`)).json.mission
  assert.equal(after.status, 'Menus with alice for a pick.')
  assert.equal(after.status_contributor, 'bob')
  upsertConversation(w.s.db, { id: 'plain', ownerUserId: w.alice.id, title: 'Plain', agentDeviceId: null })
  const plain = (await w.alicePhone('/missions', post({ convo_id: 'plain', title: 'Plain' }))).json.mission
  await w.alicePhone(`/missions/${plain.id}`, { method: 'PATCH', body: { status: 'Fine.' } })
  assert.equal('status_contributor' in (await w.alicePhone(`/missions/${plain.id}`)).json.mission, false)
  for (const body of [{ title: 'mine' }, { status: 'x', title: 'mine' }, { body: 'x' }, { name: 'x' }]) {
    assert.equal((await w.bobBox(`/missions/${m.id}`, { method: 'PATCH', body })).status, 403)
  }
  assert.equal((await w.bobPhone(`/missions/${m.id}/close`, post({ summary: 'done' }))).status, 403)
  assert.equal((await w.bobPhone(`/missions/${m.id}/shares`, post({ contact: 'alice' }))).status, 404)
  // A consent mirror on the mission is alice's alone.
  assert.equal((await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: 'Notes.', convo_id: 'work' }))).status, 202)
  const consent = (await w.alicePhone('/items?label=consent&state=open')).json.items[0]
  assert.equal(consent.mission_id, m.id)
  assert.equal((await w.bobPhone(`/items/${consent.id}/comments`, post({ body: 'hi' }))).status, 404)
  assert.equal((await w.bobPhone(`/items/${consent.id}/close`, post({ resolution: 'done' }))).status, 404)
})

test('replies cross both ways as another person\'s turn', async (t) => {
  const w = await world(t)
  const { m } = await contributing(w)
  const it = (await w.bobBox('/items', post({ mission: m.id, kind: 'question', title: 'Vegetarian option?', convo_id: 'bobwork' }))).json.item
  for (const k of Object.keys(w.ws)) w.ws[k].frames.length = 0

  // alice's agent answers bob's question: bob's agent hears it in the
  // conversation that filed it, as alice's.
  assert.equal((await w.aliceBox(`/items/${it.id}/comments`, post({ body: 'Yes, one vegetarian main.' }))).status, 201)
  await settle()
  const turn = w.ws.bobBox.journal().find((f) => f.type === 'item' && f.payload.item_id === it.id && f.payload.action === 'commented')
  assert.ok(turn, 'bob\'s agent hears alice')
  assert.equal(turn.convo_id, 'bobwork')
  assert.equal(turn.sender, 'person:alice')
  assert.deepEqual(turn.payload.person, { name: 'alice', via: 'agent' })
  assert.deepEqual(turn.payload.shared_by, { user_id: w.alice.id, name: 'alice' })
  assert.equal(turn.payload.mission_id, m.id)
  assert.equal(turn.payload.num, it.num)
  assert.equal(turn.payload.comment.body, 'Yes, one vegetarian main.')
  assert.ok(!JSON.stringify(turn).includes('"work"'), 'no conversation of alice\'s')
  assert.equal(w.ws.aliceBox.journal().filter((f) => f.convo_id === 'bobwork').length, 0)

  // alice's own reply from her phone goes the same way, and so does a close.
  await w.alicePhone(`/items/${it.id}/comments`, post({ body: 'And a vegan dessert.' }))
  await w.alicePhone(`/items/${it.id}/close`, post({ resolution: 'answered' }))
  await settle()
  const heard = w.ws.bobBox.journal().filter((f) => f.type === 'item' && f.payload.item_id === it.id && f.convo_id === 'bobwork')
  assert.deepEqual(heard.map((f) => [f.payload.action, f.payload.person.via]), [['commented', 'agent'], ['commented', 'user'], ['closed', 'user']])

  // Once the share ends, nothing more crosses, and bob can no longer write.
  const g = (await w.alicePhone('/grants?direction=out')).json.grants[0]
  await w.alicePhone(`/grants/${g.id}`, { method: 'DELETE' })
  w.ws.bobBox.frames.length = 0
  await w.alicePhone(`/items/${it.id}/reopen`, post({}))
  await w.aliceBox(`/items/${it.id}/comments`, post({ body: 'Anyone?' }))
  await settle()
  assert.equal(w.ws.bobBox.journal().filter((f) => f.payload?.item_id === it.id).length, 0)
  assert.equal((await w.bobBox('/milestones', post({ mission: m.id, kind: 'progress', title: 'late', convo_id: 'bobwork' }))).status, 404)
  assert.equal((await w.bobBox(`/items/${it.id}/comments`, post({ body: 'late' }))).status, 404)
})

test('a create refused inside its transaction answers 404 or 409, never 500', async (t) => {
  const w = await world(t)
  const { m } = await contributing(w)
  // The share ends, or the mission closes, after the route's own check and
  // before the write's transaction (contribute.js stillContributesTo): the
  // transaction wrapper is the one place that runs between the two.
  const db = w.s.db
  const orig = db.transaction.bind(db)
  const once = (before) => { db.transaction = (fn) => { db.transaction = orig; return orig(() => { before(); return fn() }) } }
  const closeMission = () => db.prepare("UPDATE missions SET state='closed' WHERE id=?").run(m.id)
  const reopen = () => db.prepare("UPDATE missions SET state='open' WHERE id=?").run(m.id)
  once(closeMission)
  assert.equal((await w.bobBox('/milestones', post({ mission: m.id, kind: 'progress', title: 'late', convo_id: 'bobwork' }))).json.blocked_by, 'closed')
  reopen()
  once(closeMission)
  assert.equal((await w.bobBox('/items', post({ mission: m.id, kind: 'task', title: 'late', convo_id: 'bobwork' }))).status, 409)
  reopen()
  const g = (await w.alicePhone('/grants?direction=out')).json.grants[0]
  const revoke = () => db.prepare("UPDATE grants SET state='revoked' WHERE id=?").run(g.id)
  once(revoke)
  assert.equal((await w.bobBox('/milestones', post({ mission: m.id, kind: 'progress', title: 'late', convo_id: 'bobwork' }))).status, 404)
  db.prepare("UPDATE grants SET state='active' WHERE id=?").run(g.id)
  once(revoke)
  assert.equal((await w.bobBox('/items', post({ mission: m.id, kind: 'task', title: 'late', convo_id: 'bobwork' }))).status, 404)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM milestones WHERE mission_id=?').get(m.id).n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items WHERE mission_id=? AND contributor_user_id IS NOT NULL').get(m.id).n, 0)
})

test('a read grantee still writes nothing', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  const item = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'task', title: 'Book the hall' }))).json.item
  await makeContacts(w)
  const g = await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob' }))
  await w.bobPhone(`/grants/${g.json.grant.id}/answer`, post({ decision: 'approve' }))
  assert.equal((await w.bobBox('/milestones', post({ mission: m.id, kind: 'progress', title: 'x', convo_id: 'bobwork' }))).status, 403)
  assert.equal((await w.bobBox('/items', post({ mission: m.id, kind: 'task', title: 'x', convo_id: 'bobwork' }))).status, 403)
  assert.equal((await w.bobBox(`/items/${item.id}/comments`, post({ body: 'x' }))).status, 403)
  assert.equal((await w.bobBox(`/items/${item.id}/close`, post({ resolution: 'done' }))).status, 403)
  assert.equal((await w.bobBox(`/missions/${m.id}`, { method: 'PATCH', body: { status: 'x' } })).status, 403)
  // A mission that is not shared at all is not found.
  upsertConversation(w.s.db, { id: 'other', ownerUserId: w.alice.id, title: 'Other', agentDeviceId: null })
  const other = (await w.alicePhone('/missions', post({ convo_id: 'other', title: 'Other' }))).json.mission
  assert.equal((await w.bobBox('/milestones', post({ mission: other.id, kind: 'progress', title: 'x', convo_id: 'bobwork' }))).status, 404)
})

test('handing over a mission keeps naming its contributor', async (t) => {
  const w = await world(t)
  const { m, item } = await contributing(w)
  await w.bobBox(`/items/${item.id}/comments`, post({ body: 'The second one.', convo_id: 'bobwork' }))
  await w.bobBox('/items', post({ mission: m.id, kind: 'task', title: 'Print menus', convo_id: 'bobwork' }))
  await w.bobBox('/milestones', post({ mission: m.id, kind: 'progress', title: 'Menus drafted', convo_id: 'bobwork' }))
  await w.bobBox(`/missions/${m.id}`, { method: 'PATCH', body: { status: 'Menus out.' } })
  // alice hands the mission to bob himself: the share is raised in place.
  const g = (await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: 'All yours.' }))).json.grant
  const copyId = (await w.bobPhone(`/grants/${g.id}/answer`, post({ decision: 'approve' }))).json.grant.copy_id
  const copy = (await w.bobPhone(`/missions/${copyId}`)).json
  assert.deepEqual(copy.milestones.find((x) => x.title === 'Menus drafted').contributor, { name: 'bob', via: 'agent' })
  assert.equal(copy.mission.status_contributor, 'bob')
  const items = (await w.bobPhone('/items?limit=500')).json.items.filter((i) => i.mission_id === copyId)
  assert.deepEqual(items.find((i) => i.title === 'Print menus').contributor, { name: 'bob', via: 'agent' })
  const thread = (await w.bobPhone(`/items/${items.find((i) => i.title === 'Which caterer?').id}`)).json.comments
  assert.equal(thread[0].attribution, "bob's agent")
})

test('a mission whose box turns private is no longer written to', async (t) => {
  const w = await world(t)
  const { m } = await contributing(w)
  w.s.db.prepare("UPDATE devices SET private=1, private_pinned=1 WHERE name='alice-box'").run()
  assert.equal((await w.bobBox('/milestones', post({ mission: m.id, kind: 'progress', title: 'x', convo_id: 'bobwork' }))).status, 404)
  assert.equal((await w.bobBox('/items', post({ mission: m.id, kind: 'task', title: 'x', convo_id: 'bobwork' }))).status, 404)
  assert.equal((await w.bobBox(`/missions/${m.id}`, { method: 'PATCH', body: { status: 'x' } })).status, 404)
})

test('a closed mission takes no more writes from a contributor', async (t) => {
  const w = await world(t)
  const { m, item } = await contributing(w)
  assert.equal((await w.alicePhone(`/missions/${m.id}/close`, post({ summary: 'done' }))).status, 200)
  for (const [p, body] of [[`/items/${item.id}/comments`, { body: 'x' }], [`/items/${item.id}/close`, { resolution: 'done' }], ['/milestones', { mission: m.id, kind: 'progress', title: 'x' }]]) {
    const r = await w.bobPhone(p, post(body))
    assert.equal(r.status, 409, p)
    assert.equal(r.json.blocked_by, 'closed')
  }
})

test('a contributor who can also see the mission through the org rule still contributes', async (t) => {
  const w = await world(t)
  const { m, item } = await contributing(w)
  // Both are verified members of one org, and the conversation names a repo in it.
  const db = w.s.db
  for (const u of [w.alice, w.bob]) {
    db.prepare("INSERT INTO github_accounts(user_id, github_id, login, token, state, linked_at) VALUES(?, ?, ?, 'x', 'ok', 0)").run(u.id, u.id, `gh-${u.name}`)
    db.prepare("INSERT INTO github_orgs(user_id, scope) VALUES(?, 'github.com/example')").run(u.id)
  }
  db.prepare("UPDATE conversations SET repo='github.com/example/app', repo_scope='github.com/example' WHERE id='work'").run()
  assert.equal((await w.bobPhone(`/items/${item.id}`)).json.item.shared_via, undefined, 'read under the org rule')
  assert.equal((await w.bobBox(`/items/${item.id}/comments`, post({ body: 'Still mine to say.', convo_id: 'bobwork' }))).status, 201)
  assert.equal((await w.bobBox(`/missions/${m.id}`, { method: 'PATCH', body: { status: 'Going.' } })).status, 200)
})

// A POST whose body arrives in two halves, with `between` run after the
// route has seen the headers and before the body is complete.
function slowRequest(base, token, path, method, body, between) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body))
    const req = http.request(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.write(data.subarray(0, 5))
    setTimeout(async () => { try { await between() } catch (err) { reject(err) } req.end(data.subarray(5)) }, 150)
  })
}

test('a share revoked while a contributor\'s write is still arriving stops that write', async (t) => {
  const w = await world(t)
  const { m, item, gid } = await contributing(w)
  const revoke = async () => assert.equal((await w.alicePhone(`/grants/${gid}`, { method: 'DELETE' })).status, 200)
  const r = await slowRequest(w.s.base, w.tokens.bobBox, `/items/${item.id}/comments`, 'POST', { body: 'late words', convo_id: 'bobwork' }, revoke)
  assert.equal(r.status, 404)
  assert.equal((await w.alicePhone(`/items/${item.id}`)).json.comments.length, 0, 'nothing was written')
  // The same for the mission's status, after a fresh share.
  const again = (await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'contribute' }))).json.grant
  await w.bobPhone(`/grants/${again.id}/answer`, post({ decision: 'approve' }))
  const r2 = await slowRequest(w.s.base, w.tokens.bobBox, `/missions/${m.id}`, 'PATCH', { status: 'late status' },
    async () => assert.equal((await w.alicePhone(`/grants/${again.id}`, { method: 'DELETE' })).status, 200))
  assert.equal(r2.status, 404)
  assert.equal((await w.alicePhone(`/missions/${m.id}`)).json.mission.status, null)
})

test('a contributor\'s close withdraws a pending item hand-over, and a stray inline ref is refused', async (t) => {
  const w = await world(t)
  const { item } = await contributing(w)
  const other = createAgent(w.s.db, w.alice.id, 'alice-box-2')
  upsertConversation(w.s.db, { id: 'side', ownerUserId: w.alice.id, title: 'Side', agentDeviceId: other.deviceId })
  const offer = await w.aliceBox(`/items/${item.id}/handover`, post({ to_convo_id: 'side', as_convo_id: 'work' }))
  assert.equal(offer.status, 201)
  assert.equal((await w.bobPhone(`/items/${item.id}/close`, post({ resolution: 'answered' }))).status, 200)
  assert.equal((await w.alicePhone(`/items/${item.id}`)).json.item.handover, null, 'the offer went with the close')
  const bad = await w.bobBox(`/items/${item.id}/comments`, post({ body: 'see ![x](attachment:abc123)', convo_id: 'bobwork' }))
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error, 'invalid_attachment_ref')
})

test('a contributor\'s item takes attachments: [] as "none"', async (t) => {
  const w = await world(t)
  const { m } = await contributing(w)
  assert.equal((await w.bobBox('/items', post({ mission: m.id, kind: 'task', title: 'x', convo_id: 'bobwork', attachments: [] }))).status, 201)
  assert.equal((await w.bobBox('/items', post({ mission: m.id, kind: 'task', title: 'x', convo_id: 'bobwork', body: 'see ![x](attachment:abc123)' }))).status, 400)
})

test('a contributor\'s reply shows the owner\'s item as queued for its session', async (t) => {
  const w = await world(t)
  const { item } = await contributing(w)
  w.s.db.prepare("UPDATE conversations SET session_state='done' WHERE id='work'").run()
  assert.equal((await w.bobBox(`/items/${item.id}/comments`, post({ body: 'Second one.', convo_id: 'bobwork' }))).status, 201)
  assert.equal((await w.alicePhone(`/items/${item.id}`)).json.item.working?.state, 'queued')
})

test('a mission closed while a contributor\'s status is arriving is a 409, not a 500', async (t) => {
  const w = await world(t)
  const { m } = await contributing(w)
  const r = await slowRequest(w.s.base, w.tokens.bobBox, `/missions/${m.id}`, 'PATCH', { status: 'late' },
    async () => assert.equal((await w.alicePhone(`/missions/${m.id}/close`, post({ summary: 'done' }))).status, 200))
  assert.equal(r.status, 409)
  assert.equal(r.json.blocked_by, 'closed')
})

test('accepting a raise to contribute says the mission changed, not that it was added', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  await makeContacts(w)
  const read = (await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob' }))).json.grant
  await w.bobPhone(`/grants/${read.id}/answer`, post({ decision: 'approve' }))
  await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'contribute' }))
  await settle()
  w.ws.bobPhone.frames.length = 0
  await w.bobPhone(`/grants/${read.id}/answer`, post({ decision: 'approve' }))
  await settle()
  const shared = w.ws.bobPhone.frames.filter((f) => f.kind === 'shared')
  assert.deepEqual(shared.map((f) => [f.event, f.what]), [['mission_changed', 'grant']])
  assert.equal(shared[0].mission_id, m.id)
  assert.equal(shared[0].grant_id, read.id)
})
