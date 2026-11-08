import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { world, post, incoming, mirrorOf, notices } from './federation-world.js'
import { enqueue } from '../src/federation-outbox.js'

// Contributors across journals (phase 5 stage 10b), end to end between two
// journals on loopback: alice on a.example shares her mission with bob on
// b.example to contribute to, and bob writes into it from his journal.
async function contributing(t, level = 'contribute') {
  const w = await world(t)
  const r = await w.phones.alice(`/missions/${w.mission.id}/shares`, post({ contact: 'bob@b.example', level }))
  assert.equal(r.status, 201, JSON.stringify(r.json))
  await w.settle()
  const mirror = mirrorOf(w.b, w.users.bob.id)
  assert.equal((await w.phones.bob(`/items/${mirror.id}/comments`, post({ action: 'Accept' }))).status, 200)
  await w.settle()
  const box = createAgent(w.b.db, w.users.bob.id, 'bob-box')
  upsertConversation(w.b.db, { id: 'bobwork', ownerUserId: w.users.bob.id, title: 'Bob work', agentDeviceId: box.deviceId })
  w.bobBox = (path, opts = {}) => w.b.http(path, { token: box.token, ...opts })
  w.copy = (await w.phones.bob('/missions?scope=shared')).json.missions[0]
  w.grant = r.json.grant
  return w
}
const ownerItems = (w) => w.a.db.prepare('SELECT * FROM items WHERE user_id=? AND mission_id=? ORDER BY created_at').all(w.users.alice.id, w.mission.id)
const copyItem = async (w, num) => (await w.phones.bob('/items?scope=shared')).json.items.find((i) => i.num === num)

test('a contributor on another journal writes into the owner\'s mission, attributed, and their copy follows', async (t) => {
  const w = await contributing(t)
  assert.equal(w.copy.grant.level, 'contribute')

  const ml = await w.phones.bob('/milestones', post({ mission: w.copy.id, kind: 'progress', title: 'Seeds ordered' }))
  assert.equal(ml.status, 202, JSON.stringify(ml.json))
  assert.deepEqual([ml.json.queued, ml.json.write.kind], [true, 'milestone'])
  const it = await w.phones.bob('/items', post({ mission: w.copy.id, kind: 'task', title: 'Water the beds', body: 'Twice a week.' }))
  assert.equal(it.status, 202)
  const st = await w.phones.bob(`/missions/${w.copy.id}`, { method: 'PATCH', body: { status: 'Planting under way.' } })
  assert.equal(st.status, 202)
  await w.settle()

  // The owner's side: in alice's numbering, marked as bob's.
  const l = w.a.db.prepare('SELECT * FROM milestones WHERE mission_id=?').get(w.mission.id)
  assert.deepEqual([l.title, l.contributor_name, l.contributor_via, l.created_by, l.device_id], ['Seeds ordered', 'bob@b.example', 'user', 'agent', 0])
  const [item] = ownerItems(w)
  assert.deepEqual([item.title, item.contributor_name, item.contributor_user_id, item.contributor_grant_id], ['Water the beds', 'bob@b.example', null, w.grant.id])
  const m = w.a.db.prepare('SELECT status, status_contributor FROM missions WHERE id=?').get(w.mission.id)
  assert.deepEqual([m.status, m.status_contributor], ['Planting under way.', 'bob@b.example'])

  // bob's copy follows, by the owner's events.
  const copyMission = (await w.phones.bob(`/missions/${w.copy.id}`)).json
  assert.equal(copyMission.mission.status, 'Planting under way.')
  assert.deepEqual(copyMission.milestones.map((x) => [x.title, x.contributor?.name]), [['Seeds ordered', 'bob@b.example']])
  const mine = await copyItem(w, item.num)
  assert.equal(mine.title, 'Water the beds')

  // Comment, close and reopen on the owner's item, through the copy.
  assert.equal((await w.phones.bob(`/items/${mine.id}/comments`, post({ body: 'Done the first round.' }))).status, 202)
  assert.equal((await w.phones.bob(`/items/${mine.id}/close`, post({ resolution: 'done' }))).status, 202)
  await w.settle()
  assert.equal(w.a.db.prepare('SELECT state FROM items WHERE id=?').get(item.id).state, 'closed')
  const comments = w.a.db.prepare("SELECT body, author, json_extract(meta, '$.contributor.name') AS who FROM item_comments WHERE item_id=? AND kind='comment'").all(item.id)
  assert.deepEqual(comments.map((c) => [c.body, c.author, c.who]), [['Done the first round.', 'agent', 'bob@b.example']])
  assert.equal((await w.phones.bob(`/items/${mine.id}/reopen`, post({}))).status, 202)
  await w.settle()
  assert.equal(w.a.db.prepare('SELECT state FROM items WHERE id=?').get(item.id).state, 'open')
  assert.equal((await copyItem(w, item.num)).state, 'open')

  // What the owner's side heard: markers from another person, in her log.
  const marker = w.a.db.prepare("SELECT sender, payload FROM events WHERE user_id=? AND type='item' AND sender LIKE 'person:%' ORDER BY seq DESC LIMIT 1").get(w.users.alice.id)
  assert.equal(marker.sender, 'person:bob@b.example')
  assert.deepEqual(JSON.parse(marker.payload).person, { name: 'bob@b.example', via: 'user' })

  // Never: buttons, files, other fields, a closed mission's writes.
  assert.equal((await w.phones.bob(`/items/${mine.id}/comments`, post({ action: 'Done' }))).status, 403)
  assert.equal((await w.phones.bob(`/items/${mine.id}/comments`, post({ body: 'x', attachments: [{ blob_ref: 'b' }] }))).status, 400)
  assert.equal((await w.phones.bob(`/missions/${w.copy.id}`, { method: 'PATCH', body: { title: 'Mine now' } })).status, 403)
  assert.equal((await w.phones.bob('/items', post({ mission: w.copy.id, kind: 'notice', title: 'x' }))).status, 400)
})

test('an owner reply on an item a remote contributor filed reaches the conversation that filed it', async (t) => {
  const w = await contributing(t)
  const it = await w.bobBox('/items', post({ mission: w.copy.id, kind: 'question', title: 'Which compost?', convo_id: 'bobwork' }))
  assert.equal(it.status, 202, JSON.stringify(it.json))
  assert.equal((await w.bobBox('/items', post({ mission: w.copy.id, kind: 'question', title: 'No convo' }))).status, 400, 'an agent names its conversation')
  await w.settle()
  const [item] = ownerItems(w)
  assert.equal(w.a.db.prepare('SELECT contributor_convo_id FROM items WHERE id=?').get(item.id).contributor_convo_id, null, 'the filing conversation stays on bob\'s journal')
  assert.equal(w.b.db.prepare('SELECT convo_id FROM fed_contrib_items WHERE ref=?').get(item.id).convo_id, 'bobwork')

  assert.equal((await w.phones.alice(`/items/${item.id}/comments`, post({ body: 'The peat-free one.' }))).status, 201)
  await w.settle()
  const ev = w.b.db.prepare("SELECT sender, payload FROM events WHERE user_id=? AND convo_id='bobwork' AND type='item' ORDER BY seq DESC LIMIT 1").get(w.users.bob.id)
  assert.ok(ev, 'bob\'s filing conversation heard the reply')
  assert.equal(ev.sender, 'person:alice@a.example')
  const p = JSON.parse(ev.payload)
  assert.equal(p.action, 'commented')
  assert.equal(p.comment.body, 'The peat-free one.')
  assert.deepEqual(p.shared_by, { user_id: 0, name: 'alice@a.example' })
  assert.equal(p.item_id, (await copyItem(w, item.num)).id, 'it names bob\'s copy of the item')
})

test('a read share takes no writes; raised to contribute, it does', async (t) => {
  const w = await contributing(t, 'read')
  assert.equal((await w.phones.bob('/milestones', post({ mission: w.copy.id, kind: 'progress', title: 'x' }))).status, 403)
  assert.equal((await w.phones.alice(`/missions/${w.mission.id}/shares`, post({ contact: 'bob@b.example', level: 'contribute' }))).status, 201)
  await w.settle()
  const raise = mirrorOf(w.b, w.users.bob.id)
  assert.equal((await w.phones.bob(`/items/${raise.id}/comments`, post({ action: 'Accept' }))).status, 200)
  await w.settle()
  assert.equal((await w.phones.bob('/milestones', post({ mission: w.copy.id, kind: 'progress', title: 'Now I can' }))).status, 202)
  await w.settle()
  assert.equal(w.a.db.prepare('SELECT title FROM milestones WHERE mission_id=?').get(w.mission.id).title, 'Now I can')
})

test('the owner\'s journal checks again: a write it refuses gives the contributor a notice', async (t) => {
  const w = await contributing(t)
  // alice closes the mission before bob's write gets there.
  w.a.db.prepare("UPDATE missions SET state='closed' WHERE id=?").run(w.mission.id)
  assert.equal((await w.phones.bob('/milestones', post({ mission: w.copy.id, kind: 'progress', title: 'Too late' }))).status, 202)
  await w.settle()
  assert.equal(w.a.db.prepare('SELECT COUNT(*) AS n FROM milestones WHERE mission_id=?').get(w.mission.id).n, 0)
  const n = notices(w.b, w.users.bob.id).at(-1)
  assert.equal(n.title, 'Couldn\'t add your milestone to mission "Garden Club"')
  assert.match(n.body, /has closed the mission/)
})

test('a write queued while the share allowed it is not sent once it no longer does', async (t) => {
  const w = await contributing(t)
  const [fg] = incoming(w.b)
  // Held back (the peer looks down), then the share drops to read-only.
  w.b.db.prepare("UPDATE fed_grants_in SET level='read' WHERE id=?").run(fg.id)
  enqueue(w.b.db, {
    userId: w.users.bob.id, from: 'bob@b.example', to: 'alice@a.example', op: 'mission.write', subject: `grant:${fg.peer_grant_ref}`,
    body: { grant: fg.peer_grant_ref, kind: 'milestone', via: 'user', fields: { kind: 'progress', title: 'Held', body: '' } }, meta: { kind: 'milestone', convo_id: null },
  })
  await w.settle()
  assert.equal(w.a.db.prepare('SELECT COUNT(*) AS n FROM milestones WHERE mission_id=?').get(w.mission.id).n, 0)
  assert.equal(w.b.db.prepare("SELECT state FROM fed_outbox WHERE op='mission.write'").get().state, 'cancelled')
})

test('the owner\'s journal refuses a write for a share that is read-only there', async (t) => {
  const w = await contributing(t)
  // The two journals disagree (a raise that never got back): alice's says read.
  w.a.db.prepare("UPDATE grants SET level='read' WHERE id=?").run(w.grant.id)
  assert.equal((await w.phones.bob('/milestones', post({ mission: w.copy.id, kind: 'progress', title: 'Nope' }))).status, 202)
  await w.settle()
  assert.equal(w.a.db.prepare('SELECT COUNT(*) AS n FROM milestones WHERE mission_id=?').get(w.mission.id).n, 0)
  assert.match(notices(w.b, w.users.bob.id).at(-1).body, /read-only now/)
})
