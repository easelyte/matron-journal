import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgent, createUser } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { makeWsClient } from './helpers.js'
import { world, post, grantOf, incoming, notices, offer } from './federation-world.js'
import { applySnapshotPage, sendSnapshot, PAGE_BYTES } from '../src/federation-replica.js'

// Read shares across journals (phase 5 stage 7b): what alice's share lets
// bob read on his own journal. On accept her journal sends the mission as a
// grantee on her journal would see it; his keeps a copy and serves it from
// the same routes as any shared mission, until the share ends.

async function shared(t, fill = async () => {}) {
  const w = await world(t)
  await fill(w)
  const g = await offer(w)
  await w.phones.bob(`/grants/${incoming(w.b)[0].id}/answer`, post({ decision: 'approve' }))
  await w.settle()
  assert.equal(grantOf(w.a, g.id).state, 'active')
  return { w, g }
}

const fillBasics = async (w) => {
  await w.aliceBox('/milestones', post({ convo_id: 'work', kind: 'progress', title: 'Beds dug', body: 'Two beds.\nCompost in.' }))
  await w.aliceBox(`/missions/${w.mission.id}`, { method: 'PATCH', body: { status: 'Planting next week', convo_id: 'work' } })
  const q = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'question', title: 'Tomatoes or beans?', body: 'Which first', actions: ['Tomatoes', 'Beans'], labels: ['garden'], links: [{ url: 'https://example.com/seeds', title: 'Seeds' }] }))).json.item
  await w.aliceBox(`/items/${q.id}/comments`, post({ body: 'Leaning tomatoes', convo_id: 'work' }))
  const done = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'task', title: 'Buy compost' }))).json.item
  await w.aliceBox(`/items/${done.id}/close`, post({ resolution: 'done', comment: 'Bought' }))
  w.ids = { q: q.id, done: done.id }
}

test('accepted: bob reads a copy of the mission from his own journal', async (t) => {
  const { w, g } = await shared(t, fillBasics)
  const [fg] = incoming(w.b)

  const list = (await w.phones.bob('/missions?scope=shared')).json.missions
  assert.equal(list.length, 1)
  const m = list[0]
  assert.ok(m.id.startsWith('ms_') && m.id !== w.mission.id, 'the copy has an id of its own')
  assert.deepEqual([m.num, m.title, m.status, m.owner.name, m.owner.address, m.shared_via, m.grant.id, m.grant.level, m.milestones, m.open_items],
    [w.mission.num, 'Garden Club', 'Planting next week', 'alice@a.example', 'alice@a.example', 'grant', fg.id, 'read', 1, 1])
  assert.deepEqual([m.origin_convo_id, m.origin_device_id, m.project_id, m.conversations], ['', 0, null, 0])

  const detail = (await w.phones.bob(`/missions/${m.id}`)).json
  assert.deepEqual(detail.milestones.map((l) => [l.title, l.body, l.mission_id]), [['Beds dug', 'Two beds.\nCompost in.', m.id]])
  assert.deepEqual(detail.items.map((i) => i.title), ['Tomatoes or beans?'], 'the open items, as on one journal')
  assert.deepEqual(detail.conversations, [])

  const items = (await w.phones.bob('/items?scope=shared')).json.items
  assert.deepEqual(items.map((i) => [i.title, i.state, i.mission_id, i.owner.address]).sort(), [
    ['Buy compost', 'closed', m.id, 'alice@a.example'], ['Tomatoes or beans?', 'open', m.id, 'alice@a.example'],
  ])
  const q = items.find((i) => i.title === 'Tomatoes or beans?')
  assert.ok(q.id !== w.ids.q)
  const one = (await w.phones.bob(`/items/${q.id}`)).json
  assert.deepEqual([one.item.labels, one.item.links, one.item.actions, one.item.origin_convo_id], [['garden'], [{ url: 'https://example.com/seeds', title: 'Seeds' }], [], ''])
  assert.deepEqual(one.comments.map((c) => [c.kind, c.body, c.device_id, c.convo_id]), [['comment', 'Leaning tomatoes', 0, null]])
  const closed = (await w.phones.bob(`/items/${items.find((i) => i.state === 'closed').id}`)).json
  assert.deepEqual(closed.comments.map((c) => [c.kind, c.body, c.meta.to.state, c.meta.to.resolution]), [['status', 'Bought', 'closed', 'done']])

  // By address and number, as an agent's mission_get shared_by does.
  const hit = (await w.phones.bob(`/lookup?user=${encodeURIComponent('alice@a.example')}&num=${w.mission.num}`)).json
  assert.deepEqual([hit.kind, hit.id, hit.owner.name], ['mission', m.id, 'alice@a.example'])
  const itemHit = (await w.phones.bob(`/lookup?user=${encodeURIComponent('alice@a.example')}&num=${q.num}`)).json
  assert.deepEqual([itemHit.kind, itemHit.id], ['item', q.id])
  assert.equal((await w.phones.bob(`/lookup?user=${encodeURIComponent('carol@a.example')}&num=${w.mission.num}`)).status, 404)

  // Read-only.
  assert.equal((await w.phones.bob(`/missions/${m.id}`, { method: 'PATCH', body: { status: 'mine now' } })).status, 403)
  assert.equal((await w.phones.bob(`/items/${q.id}/comments`, post({ body: 'hi' }))).status, 403)
  assert.equal((await w.phones.bob(`/items/${q.id}/close`, post({ resolution: 'done' }))).status, 403)
  // Nobody else on bob's journal sees it.
  await createUser(w.b.db, 'carol', 'pw')
  const carol = (await w.b.http('/login', post({ username: 'carol', password: 'pw', device_name: 'carol-phone' }))).json.token
  assert.deepEqual((await w.b.http('/missions?scope=shared', { token: carol })).json.missions, [])
  assert.deepEqual((await w.b.http('/items?scope=shared', { token: carol })).json.items, [])
  assert.equal((await w.b.http(`/missions/${m.id}`, { token: carol })).status, 404)
  assert.equal((await w.b.http(`/items/${q.id}`, { token: carol })).status, 404)
  assert.equal((await w.b.http(`/lookup?user=${encodeURIComponent('alice@a.example')}&num=${w.mission.num}`, { token: carol })).status, 404)
  assert.equal(grantOf(w.a, g.id).state, 'active')
})

test('what crosses: the grantee view and nothing else', async (t) => {
  const { w } = await shared(t, async (w) => {
    await fillBasics(w)
    // A private box's item and an owner-only item on the same mission.
    const secret = createAgent(w.a.db, w.users.alice.id, 'secret-box')
    upsertConversation(w.a.db, { id: 'quiet', ownerUserId: w.users.alice.id, title: 'Quiet', agentDeviceId: secret.deviceId })
    await w.a.http('/missions/' + w.mission.id + '/join', { token: secret.token, ...post({ convo_id: 'quiet' }) })
    await w.a.http('/items', { token: secret.token, ...post({ convo_id: 'quiet', kind: 'task', title: 'From the private box' }) })
    await w.a.http('/milestones', { token: secret.token, ...post({ convo_id: 'quiet', kind: 'progress', title: 'Private milestone' }) })
    w.a.db.prepare("UPDATE devices SET private=1 WHERE name='secret-box'").run()
    await w.aliceBox('/items', post({ convo_id: 'work', kind: 'task', title: 'Owner only', private: true }))
  })
  // They are there, on the mission, on alice's journal.
  const onMission = w.a.db.prepare('SELECT title FROM items WHERE mission_id=? UNION ALL SELECT title FROM milestones WHERE mission_id=?').all(w.mission.id, w.mission.id).map((r) => r.title)
  for (const title of ['From the private box', 'Private milestone', 'Owner only']) assert.ok(onMission.includes(title), `${title} is on the mission`)
  const bodies = w.a.db.prepare("SELECT body FROM fed_outbox WHERE op='mission.snapshot'").all().map((r) => JSON.parse(r.body))
  assert.ok(bodies.length >= 1)
  const text = JSON.stringify(bodies)
  for (const never of ['From the private box', 'Private milestone', 'Owner only', 'work', 'quiet', 'alice-box', 'secret-box', w.mission.id]) {
    assert.ok(!text.includes(`"${never}"`), `${never} never crosses`)
  }
  // Every field of every record is one the protocol names.
  const ALLOWED = {
    page: ['grant', 'snap', 'page', 'pages', 'mission', 'milestones', 'items'],
    mission: ['num', 'title', 'name', 'body', 'state', 'status', 'status_by', 'status_updated_at', 'close_summary', 'closed_by', 'created_by', 'created_at', 'updated_at', 'closed_at'],
    milestone: ['ref', 'num', 'kind', 'title', 'body', 'created_by', 'created_at', 'contributor'],
    item: ['ref', 'num', 'kind', 'state', 'resolution', 'awaiting', 'title', 'body', 'created_by', 'created_at', 'updated_at', 'closed_at', 'labels', 'links', 'comment_count', 'last_comment_at', 'contributor', 'comments', 'comments_truncated'],
    comment: ['ref', 'author', 'kind', 'body', 'created_at', 'withdrawn', 'from', 'to', 'contributor'],
    link: ['url', 'title'],
  }
  const only = (o, kind) => { for (const k of Object.keys(o)) assert.ok(ALLOWED[kind].includes(k), `${kind}.${k} is not in the allow list`) }
  for (const b of bodies) {
    only(b, 'page')
    if (b.mission) only(b.mission, 'mission')
    for (const l of b.milestones) only(l, 'milestone')
    for (const i of b.items) { only(i, 'item'); for (const c of i.comments) only(c, 'comment'); for (const l of i.links) only(l, 'link') }
  }
  const titles = (await w.phones.bob('/items?scope=shared')).json.items.map((i) => i.title).sort()
  assert.deepEqual(titles, ['Buy compost', 'Tomatoes or beans?'])
})

test('ending the share removes the copy, and the apps are told', async (t) => {
  const { w } = await shared(t, fillBasics)
  const token = (await w.b.http('/login', post({ username: 'bob', password: 'pw', device_name: 'bob-tablet' }))).json.token
  const ws = await makeWsClient(w.b.base, { token, cursor: null })
  t.after(() => ws.close())
  await ws.waitFor((f) => f.op === 'hello_ok')
  const m = (await w.phones.bob('/missions?scope=shared')).json.missions[0]
  const item = (await w.phones.bob('/items?scope=shared')).json.items[0]
  assert.equal((await w.phones.alice(`/grants/${grantOf(w.a, incoming(w.b)[0].peer_grant_ref).id}`, { method: 'DELETE' })).status, 200)
  await w.settle()
  assert.deepEqual((await w.phones.bob('/missions?scope=shared')).json.missions, [])
  assert.deepEqual((await w.phones.bob('/items?scope=shared')).json.items, [])
  assert.equal((await w.phones.bob(`/missions/${m.id}`)).status, 404)
  assert.equal((await w.phones.bob(`/items/${item.id}`)).status, 404)
  for (const table of ['fed_replica_missions', 'fed_replica_milestones', 'fed_replica_items']) {
    assert.equal(w.b.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} is empty`)
  }
  const frame = await ws.waitFor((f) => f.kind === 'shared' && f.event === 'mission_removed')
  assert.equal(frame.mission_id, m.id)

  // Shared again: the same local id, the contents back.
  await offer(w)
  await w.phones.bob(`/grants/${incoming(w.b)[0].id}/answer`, post({ decision: 'approve' }))
  await w.settle()
  const again = (await w.phones.bob('/missions?scope=shared')).json.missions
  assert.deepEqual(again.map((x) => [x.id, x.milestones]), [[m.id, 1]])
  await ws.waitFor((f) => f.kind === 'shared' && f.event === 'mission_added' && f.mission_id === m.id)
})

test('a big mission crosses in pages, and a later snapshot drops what is gone', async (t) => {
  const big = 'x'.repeat(30000)
  const { w, g } = await shared(t, async (w) => {
    for (let i = 0; i < 40; i++) await w.aliceBox('/items', post({ convo_id: 'work', kind: 'task', title: `Bed ${i}`, body: big }))
  })
  const pages = w.a.db.prepare("SELECT body FROM fed_outbox WHERE op='mission.snapshot'").all().map((r) => JSON.parse(r.body))
  assert.ok(pages.length >= 3, `${pages.length} pages`)
  for (const p of pages) assert.ok(Buffer.byteLength(JSON.stringify(p)) <= PAGE_BYTES + 4096)
  assert.equal((await w.phones.bob('/items?scope=shared&limit=500')).json.items.length, 40)
  assert.equal((await w.phones.bob('/missions?scope=shared')).json.missions[0].open_items, 40)

  // Paged through the merged list.
  const seen = new Set()
  let cursor = null
  do {
    const r = (await w.phones.bob(`/items?scope=shared&limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json
    for (const i of r.items) seen.add(i.id)
    cursor = r.next_cursor
  } while (cursor)
  assert.equal(seen.size, 40)

  // Ten items leave the mission; the next snapshot no longer has them.
  w.a.db.prepare("UPDATE items SET mission_id=NULL WHERE title IN (" + Array.from({ length: 10 }, (_, i) => `'Bed ${i}'`).join(',') + ')').run()
  sendSnapshot(w.a.db, grantOf(w.a, g.id), { from: 'alice@a.example', to: 'bob@b.example', now: Date.now() })
  await w.settle()
  assert.equal((await w.phones.bob('/items?scope=shared&limit=500')).json.items.length, 30)
})

test('peer text is kept to what the protocol allows', async (t) => {
  const { w } = await shared(t)
  const r = incoming(w.b)[0]
  const page = (extra) => ({ grant: r.peer_grant_ref, snap: 'sn_test', page: 0, pages: 1, mission: { num: 5, title: 'Garden\u0007 Club\nnow', state: 'weird', body: 'line one\nline two\u0000' }, milestones: [], items: [], ...extra })
  const out = applySnapshotPage(w.b.db, r, page({
    items: [{ ref: 'it_x', num: 9, kind: 'nope', state: 'open', title: '**bold**\r\ntitle', body: 'b', labels: ['a', 7, 'b'.repeat(100)], links: [{ url: 'javascript:alert(1)' }, { url: 'https://example.com' }], comments: [{ ref: 'ic_1', author: 'root', kind: 'comment', body: 'hi' }] }],
  }), Date.now())
  assert.equal(out.done, 'changed')
  const m = w.b.db.prepare('SELECT * FROM fed_replica_missions').get()
  assert.deepEqual([m.title, m.state, m.body], ['Garden Club now', 'open', 'line one\nline two'])
  const i = w.b.db.prepare('SELECT * FROM fed_replica_items').get()
  assert.deepEqual([i.title, i.kind, JSON.parse(i.labels), JSON.parse(i.links)], ['**bold** title', 'task', ['a', 'b'.repeat(40)], [{ url: 'https://example.com' }]])
  assert.equal(JSON.parse(i.comments)[0].author, 'agent')
  for (const bad of [{ snap: 'nope' }, { page: 1 }, { pages: 0 }, { mission: 'x' }, { mission: null, pages: 2 }, { mission: null, milestones: [{ ref: 'ml_1', num: 1, kind: 'progress', title: 't' }] }, { items: [{ ref: 'gr_1', num: 1 }] }, { milestones: [{ ref: 'ml_1', num: 0 }] }]) {
    assert.throws(() => applySnapshotPage(w.b.db, r, page(bad), Date.now()), /malformed/, JSON.stringify(bad))
  }
})

test('a snapshot for a share that ended over there is refused, and the owner is not told', async (t) => {
  const { w, g } = await shared(t, fillBasics)
  // bob's journal ends it, but alice's has not heard yet.
  w.b.db.prepare("UPDATE fed_grants_in SET state='revoked', revoked_by='grantee'").run()
  sendSnapshot(w.a.db, grantOf(w.a, g.id), { from: 'alice@a.example', to: 'bob@b.example', now: Date.now() })
  await w.settle()
  assert.equal(w.a.db.prepare("SELECT COUNT(*) AS n FROM fed_outbox WHERE op='mission.snapshot' AND last_error='not_active'").get().n >= 1, true)
  assert.deepEqual(notices(w.a, w.users.alice.id).filter((n) => n.title.startsWith("Couldn't send")), [])
})

test('a snapshot with a page missing is given up on, and the copy stays whole', async (t) => {
  const { w } = await shared(t, fillBasics)
  const r = incoming(w.b)[0]
  const before = (await w.phones.bob('/items?scope=shared')).json.items.map((i) => i.title).sort()
  const mission = { num: w.mission.num, title: 'Garden Club', state: 'open', created_at: 1, updated_at: 2 }
  const page = (n, items) => ({ grant: r.peer_grant_ref, snap: 'sn_gap', page: n, pages: 3, ...(n === 0 ? { mission } : {}), milestones: [], items })
  const item = (ref, title) => ({ ref, num: 90, kind: 'task', state: 'open', title, body: '', created_at: 1, updated_at: 2, comments: [] })
  assert.equal(applySnapshotPage(w.b.db, r, page(0, [item('it_a', 'On page 0')]), Date.now()).done, null)
  // Page 1 never arrives; page 2, the last, does.
  assert.equal(applySnapshotPage(w.b.db, r, page(2, [item('it_c', 'On page 2')]), Date.now()).done, null)
  const after = (await w.phones.bob('/items?scope=shared')).json.items.map((i) => i.title)
  for (const title of before) assert.ok(after.includes(title), `${title} is still there`)
  assert.ok(!after.includes('On page 0') && !after.includes('On page 2'))
  assert.equal(w.b.db.prepare('SELECT COUNT(*) AS n FROM fed_replica_pages').get().n, 0)
  const before0 = w.b.db.prepare('SELECT title, updated_at FROM fed_replica_missions').get()
  assert.notEqual(before0.updated_at, 2, 'the abandoned page 0 did not touch the mission')
})
