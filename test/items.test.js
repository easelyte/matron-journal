import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { createItem, getItem, listItems, validateItemFields, resolveRank, RANK_EPSILON, rerankItem, renormaliseRanks, RANK_GAP, createDefaultAwaiting } from '../src/items.js'
import { addComment, closeItem, reopenItem, updateItem, setAttachmentTranscript, listComments } from '../src/items.js'
import { itemMarkerPayload, ITEM_EVENT_TYPE, itemFallbackText } from '../src/items-marker.js'
import { snippetOf } from '../src/journal.js'

test('schema: items, item_comments, item_counters exist with the expected columns', () => {
  const db = openDb(':memory:')
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
  assert.deepEqual(cols('items'), [
    'id', 'user_id', 'num', 'kind', 'state', 'resolution', 'awaiting', 'rank', 'title', 'body',
    'labels', 'links', 'supersedes', 'origin_convo_id', 'origin_device_id', 'created_by',
    'idem_key', 'created_at', 'updated_at', 'closed_at', 'mission_id',
  ])
  assert.deepEqual(cols('item_comments'), [
    'id', 'item_id', 'user_id', 'author', 'device_id', 'kind', 'body', 'attachments', 'meta', 'idem_key', 'created_at',
  ])
  assert.deepEqual(cols('item_counters'), ['user_id', 'next_num'])
  // (user_id, num) is unique
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  const ins = db.prepare(`INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
    VALUES(?,1,1,'task','open',1024,'t','c1',1,'user',0,0)`)
  ins.run('it_a')
  assert.throws(() => ins.run('it_b'), /UNIQUE/)
})

async function seed() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const agent = createAgent(db, dan.id, 'dev-2')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  upsertConversation(db, { id: 'c2', ownerUserId: dan.id, title: 'C2', agentDeviceId: agent.deviceId })
  return { db, dan, pat, agent }
}

const base = (o = {}) => ({
  kind: 'task', title: 'Do the thing', originConvoId: 'c1', originDeviceId: 1, createdBy: 'agent', ...o,
})

test('validateItemFields: trims, caps, dedupes, rejects junk', () => {
  assert.equal(validateItemFields({ title: '  ' }).ok, false)
  assert.equal(validateItemFields({ title: 'x'.repeat(201) }).ok, false)
  assert.equal(validateItemFields({ title: 't', body: 'x'.repeat(32769) }).ok, false)
  assert.equal(validateItemFields({ title: 't', labels: ['a', 'a', 'b'] }).value.labels.join(), 'a,b')
  assert.equal(validateItemFields({ title: 't', labels: 'nope' }).ok, false)
  assert.equal(validateItemFields({ title: 't', links: [{ url: 'https://x' }] }).value.links[0].url, 'https://x')
  assert.equal(validateItemFields({ title: 't', links: [{ url: 'javascript:alert(1)' }] }).ok, false)
  assert.equal(validateItemFields({ title: 't', attachments: [{ blob_ref: 'b', mime: 'image/png', name: 'a.png', size: 3 }] }).value.attachments[0].mime, 'image/png')
  assert.equal(validateItemFields({ title: 't', attachments: [{ mime: 'image/png' }] }).ok, false)
  // partial: title may be absent
  assert.equal(validateItemFields({ body: 'b' }, { partial: true }).ok, true)
})

test('createItem numbers per user, ranks at the bottom, and honours position/after/before', async () => {
  const { db, dan, pat } = await seed()
  const a = createItem(db, base({ userId: dan.id })).item
  const b = createItem(db, base({ userId: dan.id, title: 'B' })).item
  const p = createItem(db, base({ userId: pat.id, originConvoId: 'c1' })).item
  assert.equal(a.num, 1); assert.equal(b.num, 2); assert.equal(p.num, 1)
  assert.equal(a.rank, 1024); assert.equal(b.rank, 2048)
  const top = createItem(db, base({ userId: dan.id, title: 'T', position: 'top' })).item
  assert.equal(top.rank, 0)
  const mid = createItem(db, base({ userId: dan.id, title: 'M', after: a.id, before: b.id })).item
  assert.equal(mid.rank, 1536)
  assert.throws(() => createItem(db, base({ userId: dan.id, after: p.id })), /bad_after_before/)
  assert.equal(a.state, 'open'); assert.equal(a.awaiting, 'agent') // task default
  const q = createItem(db, base({ userId: dan.id, kind: 'question' })).item
  assert.equal(q.awaiting, 'user')
  const d = createItem(db, base({ userId: dan.id, kind: 'decision' })).item
  assert.equal(d.awaiting, null)
})

test('createItem: a user-filed task/question awaits the AGENT; an agent-filed one keeps the kind default', async () => {
  const { db, dan } = await seed()
  const mk = (o) => createItem(db, base({ userId: dan.id, ...o })).item
  // Agent-filed: the kind defaults (a question is a question FOR the user).
  assert.equal(mk({ createdBy: 'agent', kind: 'task' }).awaiting, 'agent')
  assert.equal(mk({ createdBy: 'agent', kind: 'question' }).awaiting, 'user')
  assert.equal(mk({ createdBy: 'agent', kind: 'decision' }).awaiting, null)
  // User-filed: the ball is with the agent for both actionable kinds — a
  // user's question is asked OF the agent, not left waiting on themselves.
  assert.equal(mk({ createdBy: 'user', kind: 'task' }).awaiting, 'agent')
  assert.equal(mk({ createdBy: 'user', kind: 'question' }).awaiting, 'agent')
  assert.equal(mk({ createdBy: 'user', kind: 'decision' }).awaiting, null)
  // An explicit value always wins over either default, null included.
  assert.equal(mk({ createdBy: 'user', kind: 'question', awaiting: 'user' }).awaiting, 'user')
  assert.equal(mk({ createdBy: 'agent', kind: 'task', awaiting: null }).awaiting, null)
  assert.equal(createDefaultAwaiting('question', 'user'), 'agent')
  assert.equal(createDefaultAwaiting('question', 'agent'), 'user')
})

test('validateItemFields strips a client-supplied attachment transcript unless allowTranscript', () => {
  const att = [{ blob_ref: 'b1', mime: 'audio/mp4', name: 'v.m4a', size: 3, transcript: 'forged' }]
  const stripped = validateItemFields({ title: 't', attachments: att }).value.attachments[0]
  assert.equal(stripped.transcript, undefined)
  assert.equal(stripped.blob_ref, 'b1') // the rest of the attachment survives
  const kept = validateItemFields({ title: 't', attachments: att }, { allowTranscript: true }).value.attachments[0]
  assert.equal(kept.transcript, 'forged')
  // Still bounded when it IS allowed.
  assert.equal(validateItemFields({ title: 't', attachments: [{ ...att[0], transcript: 'x'.repeat(32769) }] }, { allowTranscript: true }).ok, false)
  // ...and an over-long one is simply dropped, not a 400, when it isn't.
  assert.equal(validateItemFields({ title: 't', attachments: [{ ...att[0], transcript: 'x'.repeat(32769) }] }).ok, true)
})

test('rowToItem / rowToComment do not expose internal columns', async () => {
  const { db, dan } = await seed()
  const t = createItem(db, base({ userId: dan.id, idemKey: 'k1' })).item
  assert.ok(!('idem_key' in t), 'item shape must not carry idem_key')
  assert.equal(db.prepare('SELECT idem_key FROM items WHERE id=?').get(t.id).idem_key, 'k1') // still stored
  const c = addComment(db, { userId: dan.id, itemId: t.id, author: 'user', deviceId: 9, body: 'x', idemKey: 'c1' }).comment
  assert.ok(!('idem_key' in c), 'comment shape must not carry idem_key')
  assert.ok(!('user_id' in c), 'comment shape must not carry user_id')
  assert.equal(db.prepare('SELECT idem_key FROM item_comments WHERE id=?').get(c.id).idem_key, 'c1')
  assert.deepEqual(Object.keys(c).sort(), ['attachments', 'author', 'body', 'created_at', 'device_id', 'id', 'item_id', 'kind', 'meta'])
})

test('createItem idempotency returns the original row', async () => {
  const { db, dan } = await seed()
  const r1 = createItem(db, base({ userId: dan.id, idemKey: 'k1' }))
  const r2 = createItem(db, base({ userId: dan.id, idemKey: 'k1', title: 'changed' }))
  assert.equal(r1.duplicate, false); assert.equal(r2.duplicate, true)
  assert.equal(r2.item.id, r1.item.id); assert.equal(r2.item.title, 'Do the thing')
})

test('createItem: a racing writer on the same idem_key yields their row, not a constraint error', async () => {
  const { db, dan } = await seed()
  const realPrepare = db.prepare.bind(db)
  let armed = true
  // Stand in for a second connection committing the same key in the window
  // between createItem's dup lookup and its INSERT: the lookup still misses,
  // then the INSERT trips the (user_id, idem_key) unique index.
  db.prepare = (sql) => {
    const st = realPrepare(sql)
    if (!armed || !sql.startsWith('SELECT * FROM items WHERE user_id=? AND idem_key=?')) return st
    armed = false
    return {
      get: (...args) => {
        const miss = st.get(...args)
        realPrepare(`INSERT INTO items(id,user_id,num,kind,state,awaiting,rank,title,origin_convo_id,origin_device_id,created_by,idem_key,created_at,updated_at)
          VALUES('it_race',?,99,'task','open','agent',77,'Theirs','c1',1,'agent','k1',0,0)`).run(dan.id)
        return miss
      },
    }
  }
  let out
  try {
    out = createItem(db, base({ userId: dan.id, idemKey: 'k1', title: 'Mine' }))
  } finally {
    db.prepare = realPrepare
  }
  assert.equal(out.duplicate, true)
  assert.equal(out.item.id, 'it_race'); assert.equal(out.item.title, 'Theirs')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1)
})

test('getItem accepts id, #num, num; other user 404s', async () => {
  const { db, dan, pat } = await seed()
  const a = createItem(db, base({ userId: dan.id })).item
  assert.equal(getItem(db, dan.id, a.id).id, a.id)
  assert.equal(getItem(db, dan.id, '#1').id, a.id)
  assert.equal(getItem(db, dan.id, 1).id, a.id)
  assert.equal(getItem(db, pat.id, a.id), null)
  assert.deepEqual(getItem(db, dan.id, a.id).labels, [])
})

test('listItems filters, sorts, pages, and decorates', async () => {
  const { db, dan } = await seed()
  createItem(db, base({ userId: dan.id, now: 1 }))
  const b = createItem(db, base({ userId: dan.id, kind: 'question', originConvoId: 'c2', now: 2 })).item
  createItem(db, base({ userId: dan.id, kind: 'decision', labels: ['ui'], now: 3 }))
  assert.equal(listItems(db, dan.id, {}).items.length, 3)
  assert.equal(listItems(db, dan.id, { convoId: 'c2' }).items[0].id, b.id)
  assert.equal(listItems(db, dan.id, { kind: 'decision' }).items.length, 1)
  assert.equal(listItems(db, dan.id, { awaiting: 'user' }).items[0].id, b.id)
  assert.equal(listItems(db, dan.id, { label: 'ui' }).items.length, 1)
  assert.equal(listItems(db, dan.id, { since: 2 }).items.length, 2) // updated_at >= since
  const byRank = listItems(db, dan.id, { sort: 'rank' }).items.map((i) => i.num)
  assert.deepEqual(byRank, [1, 2, 3])
  const byUpd = listItems(db, dan.id, { sort: 'updated' }).items.map((i) => i.num)
  assert.deepEqual(byUpd, [3, 2, 1])
  const p1 = listItems(db, dan.id, { limit: 2 })
  assert.equal(p1.items.length, 2); assert.ok(p1.next_cursor)
  const p2 = listItems(db, dan.id, { limit: 2, cursor: p1.next_cursor })
  assert.equal(p2.items.length, 1); assert.equal(p2.next_cursor, null)
  assert.equal(p1.items[0].comment_count, 0)
  assert.equal(p1.items[0].has_image, false)
  assert.equal(listItems(db, dan.id, { state: 'open' }).items.length, 3)
  assert.equal(listItems(db, dan.id, { state: 'closed' }).items.length, 0)
})

test('listItems limit is clamped and coerced (default 100, max 500, min 1)', async () => {
  const { db, dan } = await seed()
  createItem(db, base({ userId: dan.id, title: 'A' }))
  createItem(db, base({ userId: dan.id, title: 'B' }))
  createItem(db, base({ userId: dan.id, title: 'C' }))
  const one = listItems(db, dan.id, { limit: '1' })
  assert.equal(one.items.length, 1)
  assert.ok(one.next_cursor)
  const huge = listItems(db, dan.id, { limit: 100000 })
  assert.equal(huge.items.length, 3)
  assert.equal(huge.next_cursor, null)
})

test('resolveRank renormalises on a too-tight gap and places the new item between', async () => {
  const { db, dan } = await seed()
  const a = createItem(db, base({ userId: dan.id, title: 'A' })).item
  const b = createItem(db, base({ userId: dan.id, title: 'B' })).item
  const c = createItem(db, base({ userId: dan.id, title: 'C' })).item
  // Force a and b's ranks within RANK_EPSILON of each other via a direct
  // UPDATE (mimics ranks drifting together over many small reorders).
  db.prepare('UPDATE items SET rank=? WHERE id=?').run(1000, a.id)
  db.prepare('UPDATE items SET rank=? WHERE id=?').run(1000 + RANK_EPSILON / 2, b.id)
  const mid = createItem(db, base({ userId: dan.id, title: 'Mid', after: a.id, before: b.id })).item
  const open = listItems(db, dan.id, { sort: 'rank' }).items
  const ranks = open.map((i) => i.rank)
  // Order is preserved through the renormalise.
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y))
  // The three items that existed AT renormalise time (a, b, c — mid didn't
  // exist yet, so it's the exception) land on exact multiples of RANK_GAP
  // (1024): renormaliseRanks fired and reset every open item's rank.
  const aRank = open.find((i) => i.id === a.id).rank
  const bRank = open.find((i) => i.id === b.id).rank
  const cRank = open.find((i) => i.id === c.id).rank
  assert.equal(aRank % 1024, 0)
  assert.equal(bRank % 1024, 0)
  assert.equal(cRank % 1024, 0)
  // mid was placed strictly between the renormalised a and b — the whole
  // point of running resolveRank a second time after the renormalise.
  assert.equal(mid.rank, (aRank + bRank) / 2)
  const midIndex = open.findIndex((i) => i.id === mid.id)
  const aIndex = open.findIndex((i) => i.id === a.id)
  const bIndex = open.findIndex((i) => i.id === b.id)
  const cIndex = open.findIndex((i) => i.id === c.id)
  assert.ok(aIndex < midIndex && midIndex < bIndex, 'mid sits between a and b')
  assert.ok(cIndex > bIndex, 'c (untouched) keeps its relative order after b')
})

test('resolveRank rejects inverted or identical after/before instead of looping', async () => {
  const { db, dan } = await seed()
  const a = createItem(db, base({ userId: dan.id, title: 'A' })).item
  const b = createItem(db, base({ userId: dan.id, title: 'B' })).item
  // Identical: after === before.
  assert.throws(() => resolveRank(db, dan.id, { after: a.id, before: a.id }), /bad_after_before/)
  // Inverted: after is b (ranked below a in creation order is wrong here —
  // b was created after a, so b.rank > a.rank; asking to sit "after b,
  // before a" is a structural inversion since before must rank above after).
  const start = Date.now()
  assert.throws(() => resolveRank(db, dan.id, { after: b.id, before: a.id }), /bad_after_before/)
  assert.ok(Date.now() - start < 5000, 'fails fast, no renormalise-and-recurse loop')
})

test('createItem stores supersedes to another of the caller\'s items; an unknown id rejects', async () => {
  const { db, dan, pat } = await seed()
  const original = createItem(db, base({ userId: dan.id, title: 'Original' })).item
  const revised = createItem(db, base({ userId: dan.id, title: 'Revised', supersedes: original.id })).item
  assert.equal(revised.supersedes, original.id)
  assert.throws(() => createItem(db, base({ userId: dan.id, supersedes: 'it_doesnotexist' })), /bad_supersedes/)
  const p = createItem(db, base({ userId: pat.id, originConvoId: 'c1' })).item
  assert.throws(() => createItem(db, base({ userId: dan.id, supersedes: p.id })), /bad_supersedes/)
})

test('listItems excludePrivateOwned hides items whose origin conversation is agent-owned by a private device', async () => {
  const { db, dan } = await seed()
  const privAgent = createAgent(db, dan.id, 'private-box')
  db.prepare('UPDATE devices SET private=1 WHERE id=?').run(privAgent.deviceId)
  upsertConversation(db, { id: 'c3', ownerUserId: dan.id, title: 'Private convo', agentDeviceId: privAgent.deviceId })
  const pub = createItem(db, base({ userId: dan.id, title: 'Public' })).item
  const priv = createItem(db, base({ userId: dan.id, title: 'Private', originConvoId: 'c3' })).item
  const hidden = listItems(db, dan.id, { excludePrivateOwned: true }).items.map((i) => i.id)
  assert.ok(hidden.includes(pub.id))
  assert.ok(!hidden.includes(priv.id))
  const shown = listItems(db, dan.id, { excludePrivateOwned: false }).items.map((i) => i.id)
  assert.ok(shown.includes(pub.id))
  assert.ok(shown.includes(priv.id))
})

test('createItem attachments: synthetic body comment written, item decorated with attachments/has_image', async () => {
  const { db, dan } = await seed()
  const withImage = createItem(db, base({
    userId: dan.id,
    title: 'With image',
    attachments: [{ blob_ref: 'b1', mime: 'image/png', name: 'a.png', size: 3 }],
  })).item
  assert.equal(withImage.attachments.length, 1)
  assert.equal(withImage.attachments[0].blob_ref, 'b1')
  assert.equal(withImage.has_image, true)
  const withoutImage = createItem(db, base({
    userId: dan.id,
    title: 'Without image',
    attachments: [{ blob_ref: 'b2', mime: 'application/pdf', name: 'a.pdf', size: 3 }],
  })).item
  assert.equal(withoutImage.attachments.length, 1)
  assert.equal(withoutImage.has_image, false)
  const noAttachments = createItem(db, base({ userId: dan.id, title: 'None' })).item
  assert.deepEqual(noAttachments.attachments, [])
  assert.equal(noAttachments.has_image, false)
  // getItem sees the same decoration as the create-time return.
  assert.equal(getItem(db, dan.id, withImage.id).has_image, true)
})

test('addComment flips awaiting to agent for user comments and reopens closed items', async () => {
  const { db, dan } = await seed()
  const q = createItem(db, base({ userId: dan.id, kind: 'question' })).item
  const r = addComment(db, { userId: dan.id, itemId: q.id, author: 'user', deviceId: 9, body: 'use A', now: 100 })
  assert.equal(r.item.awaiting, 'agent'); assert.equal(r.comment.kind, 'comment'); assert.equal(r.duplicate, false)
  assert.equal(getItem(db, dan.id, q.id).updated_at, 100)
  const a = addComment(db, { userId: dan.id, itemId: q.id, author: 'agent', deviceId: 1, body: 'ok', now: 200 })
  assert.equal(a.item.awaiting, 'agent') // agent comments never flip by themselves
  assert.equal(getItem(db, dan.id, q.id).updated_at, 200) // agent comments still bump updated_at
  closeItem(db, { userId: dan.id, itemId: q.id, resolution: 'answered', author: 'agent', deviceId: 1, now: 300 })
  const again = addComment(db, { userId: dan.id, itemId: q.id, author: 'user', deviceId: 9, body: 'actually…', now: 400 })
  assert.equal(again.item.state, 'open'); assert.equal(again.item.resolution, null); assert.equal(again.item.awaiting, 'agent')
  assert.equal(getItem(db, dan.id, q.id).updated_at, 400)
  assert.equal(listComments(db, q.id).length, 4) // comment, comment, status(close), comment
  // idempotent
  const k1 = addComment(db, { userId: dan.id, itemId: q.id, author: 'user', deviceId: 9, body: 'x', idemKey: 'c1' })
  const k2 = addComment(db, { userId: dan.id, itemId: q.id, author: 'user', deviceId: 9, body: 'y', idemKey: 'c1' })
  assert.equal(k2.duplicate, true); assert.equal(k2.comment.id, k1.comment.id)
  assert.equal(addComment(db, { userId: 999, itemId: q.id, author: 'user', deviceId: 9, body: 'x' }), null)
})

test('addComment idem_key is scoped per item; reusing it on a different item conflicts', async () => {
  const { db, dan } = await seed()
  const t1 = createItem(db, base({ userId: dan.id, title: 'T1' })).item
  const t2 = createItem(db, base({ userId: dan.id, title: 'T2' })).item
  const first = addComment(db, { userId: dan.id, itemId: t1.id, author: 'user', deviceId: 9, body: 'a', idemKey: 'shared' })
  assert.equal(first.duplicate, false)
  // Same key, same item: idempotent replay returns the original comment.
  const replay = addComment(db, { userId: dan.id, itemId: t1.id, author: 'user', deviceId: 9, body: 'b', idemKey: 'shared' })
  assert.equal(replay.duplicate, true); assert.equal(replay.comment.id, first.comment.id)
  // Same key, different item: must not silently hand back t1's comment
  // under t2 — that would misattribute a reply. Conflict instead.
  assert.throws(
    () => addComment(db, { userId: dan.id, itemId: t2.id, author: 'user', deviceId: 9, body: 'c', idemKey: 'shared' }),
    /idem_key_conflict/
  )
  // t2 got no comment out of the failed attempt.
  assert.equal(listComments(db, t2.id).length, 0)
})

test('closeItem / reopenItem write status comments and enforce state', async () => {
  const { db, dan } = await seed()
  const t = createItem(db, base({ userId: dan.id })).item
  const c = closeItem(db, { userId: dan.id, itemId: t.id, resolution: 'done', author: 'agent', deviceId: 1, comment: 'shipped', now: 100 })
  assert.equal(c.item.state, 'closed'); assert.equal(c.item.resolution, 'done'); assert.equal(c.item.awaiting, null)
  assert.ok(c.item.closed_at)
  assert.equal(c.comment.kind, 'status'); assert.equal(c.comment.body, 'shipped')
  // task's default awaiting at creation is 'agent' (defaultAwaiting('task')).
  assert.deepEqual(c.comment.meta.from, { state: 'open', resolution: null, awaiting: 'agent' })
  assert.deepEqual(c.comment.meta.to, { state: 'closed', resolution: 'done', awaiting: null })
  assert.equal(getItem(db, dan.id, t.id).updated_at, 100)
  assert.equal(closeItem(db, { userId: dan.id, itemId: t.id, resolution: 'done', author: 'agent', deviceId: 1 }), null)
  const r = reopenItem(db, { userId: dan.id, itemId: t.id, author: 'user', deviceId: 9, now: 200 })
  assert.equal(r.item.state, 'open'); assert.equal(r.item.awaiting, 'agent'); assert.equal(r.item.closed_at, null)
  assert.equal(getItem(db, dan.id, t.id).updated_at, 200)
  assert.equal(reopenItem(db, { userId: dan.id, itemId: t.id, author: 'user', deviceId: 9 }), null)
  const d = createItem(db, base({ userId: dan.id, kind: 'decision' })).item
  closeItem(db, { userId: dan.id, itemId: d.id, resolution: 'reversed', author: 'user', deviceId: 9 })
  assert.equal(reopenItem(db, { userId: dan.id, itemId: d.id, author: 'agent', deviceId: 1 }).item.awaiting, null)
})

test('listComments orders same-millisecond rows by insertion order (rowid), not by random id', async () => {
  const { db, dan } = await seed()
  const t = createItem(db, base({ userId: dan.id })).item
  // A comment immediately followed by a close, both stamped with the same
  // `now` — created_at alone can't disambiguate the order.
  const cm = addComment(db, { userId: dan.id, itemId: t.id, author: 'user', deviceId: 9, body: 'first', now: 50 }).comment
  const cl = closeItem(db, { userId: dan.id, itemId: t.id, resolution: 'done', author: 'agent', deviceId: 1, now: 50 }).comment
  const ids = listComments(db, t.id).map((c) => c.id)
  assert.deepEqual(ids, [cm.id, cl.id])
})

test('updateItem patches fields and awaiting; bumps updated_at', async () => {
  const { db, dan } = await seed()
  const t = createItem(db, base({ userId: dan.id, now: 5 })).item
  const u = updateItem(db, { userId: dan.id, itemId: t.id, fields: { title: 'New', labels: ['x'], awaiting: 'user' }, now: 6 })
  assert.equal(u.title, 'New'); assert.deepEqual(u.labels, ['x']); assert.equal(u.awaiting, 'user'); assert.equal(u.updated_at, 6)
  assert.equal(updateItem(db, { userId: dan.id, itemId: t.id, fields: { awaiting: null } }).awaiting, null)
  assert.equal(updateItem(db, { userId: 999, itemId: t.id, fields: { title: 'x' } }), null)
})

// Final review minor: PATCH /items/:id {title, mission} used to be two
// statements in two transactions (updateItem + a since-deleted
// setItemMission), so a half-applied patch was possible and the row was
// stamped TWICE. `missionId` now rides along with the fields: one UPDATE,
// one `updated_at` — pinned with an explicit `now` no second write could
// share.
test('updateItem: missionId rides along with the fields — one write, one updated_at; undefined leaves it alone, null detaches', async () => {
  const { db, dan } = await seed()
  db.prepare(`INSERT INTO missions(id,user_id,num,state,title,body,origin_convo_id,origin_device_id,created_by,created_at,updated_at)
    VALUES('ms_a',?,900,'open','A','','c1',1,'agent',0,0)`).run(dan.id)
  const t = createItem(db, base({ userId: dan.id, now: 5 })).item
  assert.equal(t.mission_id, null)
  const moved = updateItem(db, { userId: dan.id, itemId: t.id, fields: { title: 'New' }, missionId: 'ms_a', now: 7 })
  assert.equal(moved.title, 'New'); assert.equal(moved.mission_id, 'ms_a'); assert.equal(moved.mission_num, 900)
  assert.equal(moved.updated_at, 7)
  assert.equal(db.prepare('SELECT updated_at FROM items WHERE id=?').get(t.id).updated_at, 7)
  // Absent `missionId` must not silently detach.
  const retitled = updateItem(db, { userId: dan.id, itemId: t.id, fields: { title: 'Again' }, now: 8 })
  assert.equal(retitled.mission_id, 'ms_a')
  // A mission-only patch (no fields) still bumps the stamp exactly once.
  const detached = updateItem(db, { userId: dan.id, itemId: t.id, fields: {}, missionId: null, now: 9 })
  assert.equal(detached.mission_id, null); assert.equal(detached.mission_num, null); assert.equal(detached.title, 'Again')
  assert.equal(detached.updated_at, 9)
})

test('setAttachmentTranscript writes into exactly one attachment', async () => {
  const { db, dan } = await seed()
  const t = createItem(db, base({ userId: dan.id })).item
  const c = addComment(db, { userId: dan.id, itemId: t.id, author: 'user', deviceId: 9, body: '',
    attachments: [{ blob_ref: 'b1', mime: 'audio/mp4', name: 'v.m4a', size: 10 }, { blob_ref: 'b2', mime: 'image/png', name: 'p.png', size: 1 }] }).comment
  const out = setAttachmentTranscript(db, { userId: dan.id, itemId: t.id, commentId: c.id, blobRef: 'b1', transcript: 'hello', now: 500 })
  assert.equal(out.attachments[0].transcript, 'hello'); assert.equal(out.attachments[1].transcript, undefined)
  assert.equal(getItem(db, dan.id, t.id).updated_at, 500)
  assert.equal(setAttachmentTranscript(db, { userId: dan.id, itemId: t.id, commentId: c.id, blobRef: 'nope', transcript: 'x' }), null)
})

test('rerankItem: midpoints, top, bottom, self-neighbour rejected, closed neighbour rejected', async () => {
  const { db, dan, pat } = await seed()
  const [a, b, c] = ['A', 'B', 'C'].map((t) => createItem(db, base({ userId: dan.id, title: t })).item)
  assert.equal(rerankItem(db, { userId: dan.id, itemId: c.id, after: a.id, before: b.id }).rank, (a.rank + b.rank) / 2)
  assert.equal(rerankItem(db, { userId: dan.id, itemId: c.id, position: 'top' }).rank, a.rank - RANK_GAP)
  assert.equal(rerankItem(db, { userId: dan.id, itemId: c.id, position: 'bottom' }).rank, b.rank + RANK_GAP)
  // "before b" alone lands between its predecessor (a) and b
  assert.equal(rerankItem(db, { userId: dan.id, itemId: c.id, before: b.id }).rank, (a.rank + b.rank) / 2)
  // "after b" alone with nothing after b → b + 1024
  assert.equal(rerankItem(db, { userId: dan.id, itemId: c.id, after: b.id }).rank, b.rank + RANK_GAP)
  // updated_at is bumped with explicit now
  const moved = rerankItem(db, { userId: dan.id, itemId: c.id, after: a.id, before: b.id, now: 900 })
  assert.equal(moved.updated_at, 900)
  assert.equal(getItem(db, dan.id, c.id).updated_at, 900)
  assert.throws(() => rerankItem(db, { userId: dan.id, itemId: c.id, after: c.id }), /bad_after_before/)
  closeItem(db, { userId: dan.id, itemId: a.id, resolution: 'done', author: 'agent', deviceId: 1 })
  assert.throws(() => rerankItem(db, { userId: dan.id, itemId: c.id, after: a.id }), /bad_after_before/)
  // foreign neighbour (another user's open item) is rejected
  const foreign = createItem(db, base({ userId: pat.id, title: 'Foreign' })).item
  assert.throws(() => rerankItem(db, { userId: dan.id, itemId: c.id, after: foreign.id }), /bad_after_before/)
  assert.equal(rerankItem(db, { userId: 999, itemId: c.id, position: 'top' }), null)
})

test('rerankItem renormalises when the gap is exhausted', async () => {
  const { db, dan } = await seed()
  const a = createItem(db, base({ userId: dan.id, title: 'A' })).item
  const b = createItem(db, base({ userId: dan.id, title: 'B' })).item
  const c = createItem(db, base({ userId: dan.id, title: 'C' })).item
  db.prepare('UPDATE items SET rank=? WHERE id=?').run(1, a.id)
  db.prepare('UPDATE items SET rank=? WHERE id=?').run(1 + 1e-7, b.id)
  const moved = rerankItem(db, { userId: dan.id, itemId: c.id, after: a.id, before: b.id })
  const ranks = db.prepare("SELECT id, rank FROM items WHERE user_id=? AND state='open' ORDER BY rank").all(dan.id)
  assert.deepEqual(ranks.map((r) => r.id), [a.id, moved.id, b.id])
  assert.ok(ranks.every((r, i) => i === 0 || ranks[i].rank - ranks[i - 1].rank >= 1))
})

test('renormaliseRanks preserves order and spaces by RANK_GAP', async () => {
  const { db, dan } = await seed()
  const ids = ['x', 'y', 'z'].map((t) => createItem(db, base({ userId: dan.id, title: t })).item.id)
  db.prepare('UPDATE items SET rank=0.5 WHERE id=?').run(ids[2])
  renormaliseRanks(db, dan.id)
  const rows = db.prepare("SELECT id, rank FROM items WHERE user_id=? ORDER BY rank").all(dan.id)
  assert.deepEqual(rows.map((r) => r.id), [ids[2], ids[0], ids[1]])
  assert.deepEqual(rows.map((r) => r.rank), [1024, 2048, 3072])
})

test('itemMarkerPayload carries the spec fields and trims the comment', async () => {
  const { db, dan } = await seed()
  const q = createItem(db, base({ userId: dan.id, kind: 'question', title: 'Which auth?' })).item
  const r = addComment(db, { userId: dan.id, itemId: q.id, author: 'user', deviceId: 9, body: 'use A',
    attachments: [{ blob_ref: 'b', mime: 'audio/mp4', name: 'v.m4a', size: 1 }] })
  const p = itemMarkerPayload({ item: r.item, action: 'commented', by: 'user', comment: r.comment })
  assert.equal(ITEM_EVENT_TYPE, 'item')
  assert.deepEqual(Object.keys(p).sort(), ['action', 'awaiting', 'by', 'comment', 'item_id', 'kind', 'num', 'resolution', 'title'])
  assert.equal(p.comment.body, 'use A'); assert.equal(p.comment.attachments[0].transcript, null)
  const created = itemMarkerPayload({ item: q, action: 'created', by: 'agent' })
  assert.equal(created.comment, undefined); assert.equal(created.awaiting, 'user')
})

test('snippetOf renders item markers', () => {
  assert.equal(snippetOf('item', { kind: 'question', num: 12, title: 'Which auth library?' }), '❓ #12 Which auth library?')
  assert.equal(snippetOf('item', { kind: 'task', num: 3, title: 'T' }), '☐ #3 T')
  assert.equal(snippetOf('item', { kind: 'decision', num: 4, title: 'D' }), '⚖ #4 D')
})

test('itemFallbackText: the six shapes', () => {
  const base = { item_id: 'it_1', num: 12, kind: 'question', title: 'Which auth library?', by: 'agent', awaiting: 'user', resolution: null }
  assert.equal(itemFallbackText({ ...base, action: 'created' }, { actor: 'dev-2', body: 'we have two' }), '📌 Needs you — question #12: Which auth library?\nwe have two')
  assert.equal(itemFallbackText({ ...base, action: 'created', by: 'user', awaiting: 'agent' }, { actor: 'dan' }), '📌 New question #12: Which auth library?')
  assert.equal(itemFallbackText({ ...base, action: 'commented', comment: { id: 'ic', body: 'A or B?', attachments: [] } }, { actor: 'dev-2' }), '📌 Needs you — question #12 "Which auth library?" — dev-2 asked:\nA or B?')
  assert.equal(itemFallbackText({ ...base, action: 'commented', by: 'user', awaiting: 'agent', comment: { id: 'ic', body: 'B', attachments: [{ name: 'note.m4a', mime: 'audio/mp4' }] } }, { actor: 'dan' }), '📌 Question #12 "Which auth library?" — dan commented:\nB\n[voice note note.m4a]')
  assert.equal(itemFallbackText({ ...base, action: 'closed', resolution: 'answered', awaiting: null }, { actor: 'dan' }), '✅ Question #12 "Which auth library?" closed as answered')
  assert.equal(itemFallbackText({ ...base, action: 'reopened', by: 'user', awaiting: 'agent' }, { actor: 'dan' }), '↩️ Question #12 "Which auth library?" reopened by dan')
  assert.equal(itemFallbackText({ ...base, action: 'reordered' }, { actor: 'dan' }), null)
  const long = 'x'.repeat(130)
  assert.ok(itemFallbackText({ ...base, action: 'created', title: long, by: 'user', awaiting: 'agent' }, { actor: 'dan' }).startsWith('📌 New question #12: ' + 'x'.repeat(120) + '…'))
})
