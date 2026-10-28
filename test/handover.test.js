import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'
import { createMission, createMilestone } from '../src/missions.js'
import { createItem } from '../src/items.js'
import { peopleConvoId } from '../src/people-convo.js'
import { expireGrantAsks } from '../src/grants.js'
import { OWN_ASK_TTL_MS } from '../src/contacts.js'
import { onGrantAskExpired } from '../src/sharing-events.js'
import { readBlobTranscript } from '../src/blob-transcripts.js'
import { copyBlob } from '../src/handover.js'
import { openDb, insertBlob } from '../src/db.js'

// Hand-over (spec 2026-10-02 matron-to-matron sharing, "Hand-over"): alice
// hands a mission, or a whole project, to her contact bob. Two yeses as for
// a read share; on bob's accept the journal copies the tracker record into
// bob's log under bob's numbering, closes alice's original, and leaves
// alice a read grant on the copy. End to end over real HTTP and sockets.
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const post = (body) => ({ method: 'POST', body })
const cards = (w, kind) => w.journal().filter((f) => f.type === 'permission_request' && f.payload.kind === kind)
const audits = (w) => w.journal().filter((f) => f.type === 'people').map((f) => f.payload.event)
const BRIEF = 'Where it stands: the hall is booked. Next: send the invitations. Gotcha: the caterer needs a week of notice.'

async function world(t) {
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-media-'))
  t.after(() => fs.rmSync(mediaDir, { recursive: true, force: true }))
  const s = await startTestServer({ mediaDir })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const bob = await createUser(s.db, 'bob', 'pw')
  await createUser(s.db, 'carol', 'pw')
  const aliceBox = createAgent(s.db, alice.id, 'alice-box')
  const aliceCoord = createAgent(s.db, alice.id, 'alice-coord')
  const alicePriv = createAgent(s.db, alice.id, 'alice-private')
  pinDevicePrivate(s.db, alicePriv.deviceId, true)
  const bobBox = createAgent(s.db, bob.id, 'bob-box')
  upsertConversation(s.db, { id: 'work', ownerUserId: alice.id, title: 'Garden Club', agentDeviceId: aliceBox.deviceId })
  upsertConversation(s.db, { id: 'side', ownerUserId: alice.id, title: 'Side', agentDeviceId: aliceBox.deviceId })
  upsertConversation(s.db, { id: 'secret', ownerUserId: alice.id, title: 'Secret', agentDeviceId: alicePriv.deviceId })
  upsertConversation(s.db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator', agentDeviceId: aliceCoord.deviceId })
  upsertConversation(s.db, { id: 'bobwork', ownerUserId: bob.id, title: 'Bob', agentDeviceId: bobBox.deviceId })
  const login = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: `${name}-phone` } })).json.token
  const tokens = { alicePhone: await login('alice'), bobPhone: await login('bob'), carolPhone: await login('carol'), aliceBox: aliceBox.token, aliceCoord: aliceCoord.token, bobBox: bobBox.token }
  assert.equal((await s.http('/coordinator', { method: 'PUT', token: tokens.alicePhone, body: { convo_id: 'coord' } })).status, 200)
  const sockets = {}
  for (const k of ['alicePhone', 'bobPhone', 'aliceBox', 'aliceCoord', 'bobBox']) {
    sockets[k] = await makeWsClient(s.base, { token: tokens[k], cursor: null })
    await sockets[k].waitFor((f) => f.op === 'hello_ok')
  }
  t.after(() => { for (const w of Object.values(sockets)) { try { w.close() } catch { /* already closed */ } } })
  const http = (token) => (p, opts = {}) => s.http(p, { token, ...opts })
  const upload = async (token, text, mime) => {
    const r = await fetch(`${s.base}/media`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': mime }, body: Buffer.from(text) })
    assert.equal(r.status, 200)
    return (await r.json()).media_id
  }
  const fetchMedia = async (token, id) => {
    const r = await fetch(`${s.base}/media/${id}`, { headers: { authorization: `Bearer ${token}` } })
    return { status: r.status, text: r.status === 200 ? await r.text() : null }
  }
  return {
    s, alice, bob, ws: sockets, tokens, mediaDir, upload, fetchMedia, privDevice: alicePriv.deviceId,
    aliceBox: http(aliceBox.token), aliceCoord: http(aliceCoord.token), bobBox: http(bobBox.token),
    alicePhone: http(tokens.alicePhone), bobPhone: http(tokens.bobPhone), carolPhone: http(tokens.carolPhone),
  }
}

async function makeContacts(w, a = 'alicePhone', b = 'bobPhone', name = 'bob') {
  const r = await w[a]('/contacts', post({ user: name }))
  assert.equal(r.status, 201)
  const theirs = (await w[b]('/contacts')).json.contacts.find((c) => c.state === 'pending_in')
  assert.equal((await w[b](`/contacts/${theirs.id}/answer`, post({ decision: 'approve' }))).status, 200)
  return { aliceContact: r.json.contact.id, bobContact: theirs.id }
}

// A mission with a bit of everything: a milestone, a private box's
// milestone and item, an open item awaiting the user with a user comment,
// an agent comment and two attachments (one placed inline), and a closed
// item. Returns what the tests check against.
async function richMission(w) {
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Garden Club launch', name: 'Garden Club', body: 'Ship it.' }))).json.mission
  assert.equal((await w.aliceBox(`/missions/${m.id}`, { method: 'PATCH', body: { status: 'Hall booked, invitations next.', convo_id: 'work' } })).status, 200)
  const ms = await w.aliceBox('/milestones', post({ convo_id: 'work', kind: 'progress', title: 'Plan agreed', body: 'Details.' }))
  assert.equal(ms.status, 201)
  const db = w.s.db
  // The private box's share of the work never crosses.
  db.prepare("INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at) VALUES(?,?,?,'joined',1)").run(m.id, 'secret', w.alice.id)
  createMilestone(db, {
    userId: w.alice.id, deviceId: w.privDevice, createdBy: 'agent', convoId: 'secret', kind: 'progress', title: 'Private step', missionRef: m.id,
    appendMarker: (payload) => append(db, { userId: w.alice.id, convoId: 'secret', sender: 'agent:alice-private', type: 'milestone', payload }),
  })
  const privItem = createItem(db, { userId: w.alice.id, kind: 'task', title: 'Private chore', originConvoId: 'secret', originDeviceId: w.privDevice, createdBy: 'agent' }).item
  db.prepare('UPDATE items SET mission_id=? WHERE id=?').run(m.id, privItem.id)

  const keep = await w.upload(w.tokens.aliceBox, 'floor plan bytes', 'image/png')
  const drop = await w.upload(w.tokens.aliceBox, 'receipt bytes', 'application/pdf')
  const open = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'question', title: 'Which caterer?', body: 'Two quotes in.' }))).json.item
  const c1 = await w.aliceBox(`/items/${open.id}/comments`, post({ body: `See the plan ![floor plan](attachment:${keep})`, attachments: [{ blob_ref: keep, mime: 'image/png', name: 'plan.png', size: 16 }] }))
  assert.equal(c1.status, 201)
  assert.equal((await w.aliceBox(`/items/${open.id}/comments`, post({ body: 'And the receipt.', attachments: [{ blob_ref: drop, mime: 'application/pdf', name: 'receipt.pdf', size: 13 }] }))).status, 201)
  assert.equal((await w.alicePhone(`/items/${open.id}/comments`, post({ body: 'The cheaper one, I think.' }))).status, 201)
  // The user's comment handed the item to the agent; the agent asks again.
  assert.equal((await w.aliceBox(`/items/${open.id}`, { method: 'PATCH', body: { awaiting: 'user' } })).status, 200)
  const done = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'task', title: 'Book the hall' }))).json.item
  assert.equal((await w.aliceBox(`/items/${done.id}/close`, post({ resolution: 'done', comment: 'Booked.' }))).status, 200)
  return { mission: m, open, done, privItem, keep, drop, milestone: ms.json.milestone }
}

test('hand-over: an agent asks, alice approves with an attachment unticked, bob accepts, and the record moves', async (t) => {
  const w = await world(t)
  // bob already has his own numbering going.
  for (let i = 0; i < 3; i++) await w.bobBox('/items', post({ convo_id: 'bobwork', kind: 'task', title: `bob ${i}` }))
  const r = await richMission(w)
  const m = r.mission
  await makeContacts(w)
  // The kept attachment carries upload-time words with their timing (as a
  // video transcribed at upload does); the copy must keep both.
  const SEGMENTS = [{ start_ms: 0, text: 'the hall' }, { start_ms: 1500, text: 'is booked' }]
  w.s.db.prepare("UPDATE blobs SET transcript_status='done', transcript='the hall is booked', transcript_segments=?, transcribed_at=? WHERE id=?")
    .run(JSON.stringify(SEGMENTS), Date.now(), r.keep)

  // The brief is required for a hand-over, and bounded.
  assert.equal((await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', convo_id: 'work' }))).status, 400)
  assert.equal((await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: '   ', convo_id: 'work' }))).status, 400)
  assert.equal((await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: 'x'.repeat(16001), convo_id: 'work' }))).status, 400)
  // Only the owner unticks attachments: an agent cannot pre-select.
  assert.equal((await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, exclude_media: [r.drop], convo_id: 'work' }))).status, 400)
  for (const k of Object.keys(w.ws)) w.ws[k].frames.length = 0

  const ask = await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, convo_id: 'work' }))
  assert.equal(ask.status, 202)
  assert.equal(ask.json.pending, 'owner')
  assert.equal(ask.json.grant.level, 'owner')
  assert.equal(ask.json.grant.state, 'awaiting_owner')
  assert.equal(ask.json.grant.brief, BRIEF)
  const gid = ask.json.grant.id
  await settle()

  // alice's card previews exactly what will cross.
  const card = cards(w.ws.alicePhone, 'mission_handover')[0]
  assert.equal(card.convo_id, 'work')
  assert.equal(card.payload.direction, 'out')
  assert.equal(card.payload.grant_id, gid)
  assert.equal(card.payload.level, 'owner')
  assert.deepEqual(card.payload.owner, { user_id: w.alice.id, name: 'alice' })
  assert.equal(card.payload.grantee.name, 'bob')
  assert.deepEqual(card.payload.subject, { kind: 'mission', id: m.id, num: m.num, title: 'Garden Club launch' })
  assert.equal(card.payload.brief, BRIEF)
  assert.equal(card.payload.from_name, 'alice-box')
  assert.equal(card.payload.from_convo_id, 'work')
  const p = card.payload.preview
  assert.equal(p.missions, 1)
  assert.equal(p.milestones, 1, 'the private box\'s milestone is not counted')
  assert.equal(p.items, 2, 'the private item and the consent mirror are not counted')
  assert.equal(p.comments, 3)
  assert.deepEqual(p.attachments.map((a) => [a.media_id, a.name, a.mime, a.size, a.item_num]).sort(), [
    [r.drop, 'receipt.pdf', 'application/pdf', 13, r.open.num],
    [r.keep, 'plan.png', 'image/png', 16, r.open.num],
  ].sort())
  for (const k of ['aliceBox', 'aliceCoord', 'bobBox', 'bobPhone']) assert.equal(cards(w.ws[k], 'mission_handover').length, 0, `${k} has no card`)
  const mirror = (await w.alicePhone('/items?label=consent&state=open')).json.items.find((i) => i.consent === 'handover')
  assert.ok(mirror)
  assert.deepEqual(mirror.actions, ['Approve', 'Decline'])
  assert.deepEqual(mirror.links.map((l) => l.url), [`matron://consent/handover/${gid}`])
  assert.equal((await w.aliceBox(`/items/${mirror.id}`)).status, 404)
  // bob knows nothing yet.
  assert.equal((await w.bobPhone(`/grants/${gid}`)).status, 404)
  // No agent answers — not the asker, not the Coordinator.
  for (const agent of [w.aliceBox, w.aliceCoord]) assert.equal((await agent(`/grants/${gid}/answer`, post({ decision: 'approve' }))).status, 403)

  // alice approves, unticking the receipt.
  assert.equal((await w.alicePhone(`/grants/${gid}/answer`, post({ decision: 'approve', exclude_media: 'nope' }))).status, 400)
  const ok = await w.alicePhone(`/grants/${gid}/answer`, post({ decision: 'approve', exclude_media: [r.drop] }))
  assert.equal(ok.status, 200)
  assert.equal(ok.json.grant.state, 'pending')
  assert.deepEqual(ok.json.grant.exclude_media, [r.drop])
  await settle()
  assert.equal((await w.alicePhone(`/items/${mirror.id}`)).json.item.state, 'closed')

  // bob's card: in his People conversation, the brief and the counts — no
  // number of alice's, no box, no conversation.
  const bobCard = cards(w.ws.bobPhone, 'mission_handover')[0]
  assert.equal(bobCard.convo_id, peopleConvoId(w.s.db, w.bob.id))
  assert.equal(bobCard.sender, 'journal')
  assert.equal(bobCard.payload.direction, 'in')
  assert.deepEqual(bobCard.payload.subject, { kind: 'mission', title: 'Garden Club launch' })
  assert.equal(bobCard.payload.brief, BRIEF)
  assert.deepEqual(bobCard.payload.preview, { missions: 1, milestones: 1, items: 2, comments: 3, attachments: 1 })
  for (const k of ['from_device_id', 'from_name', 'from_convo_id']) assert.equal(k in bobCard.payload, false)
  assert.equal(cards(w.ws.bobBox, 'mission_handover').length, 0)
  assert.equal((await w.bobBox(`/grants/${gid}/answer`, post({ decision: 'approve' }))).status, 403)
  const inGrant = (await w.bobPhone(`/grants/${gid}`)).json.grant
  assert.equal(inGrant.direction, 'in')
  assert.equal(inGrant.brief, BRIEF)
  assert.equal('exclude_media' in inGrant, false, 'what alice unticked is hers')
  assert.deepEqual(audits(w.ws.alicePhone), ['grant.handover_offered'])
  assert.deepEqual(audits(w.ws.bobPhone), ['grant.handover_received'])

  // bob accepts from his mirror.
  const bobMirror = (await w.bobPhone('/items?label=consent&state=open')).json.items.find((i) => i.consent === 'handover')
  assert.deepEqual(bobMirror.actions, ['Accept', 'Pick a box', 'Decline'], 'bob has a box but no Coordinator (test/handover-session.test.js)')
  const tap = await w.bobPhone(`/items/${bobMirror.id}/comments`, post({ action: 'Accept' }))
  assert.equal(tap.status, 200)
  assert.equal(tap.json.grant.state, 'active')
  const copyId = tap.json.grant.copy_id
  assert.match(copyId, /^ms_/)
  await settle()

  // bob's copy: his own numbering, alice's words.
  const copy = (await w.bobPhone(`/missions/${copyId}`)).json
  assert.equal(copy.mission.title, 'Garden Club launch')
  assert.equal(copy.mission.name, 'Garden Club')
  assert.equal(copy.mission.body, 'Ship it.')
  assert.equal(copy.mission.status, 'Hall booked, invitations next.')
  assert.equal(copy.mission.state, 'open')
  assert.notEqual(copy.mission.num, m.num)
  assert.ok(copy.mission.num > 3, 'numbered after bob\'s own items')
  assert.ok(copy.mission.project_id, 'filed in a project of its own')
  assert.equal((await w.bobBox(`/missions/${copy.mission.num}`)).status, 200, 'bob\'s agents see it as his')
  const titles = [...copy.milestones].sort((a, b) => a.num - b.num).map((x) => [x.kind, x.title, x.body])
  assert.deepEqual(titles, [['progress', 'Handed over by alice', BRIEF], ['progress', 'Plan agreed', 'Details.']])
  assert.equal(copy.milestones.find((x) => x.title === 'Plan agreed').created_at, r.milestone.created_at, 'kept its time')
  for (const x of copy.milestones) assert.ok(!['work', 'secret'].includes(x.convo_id), 'no conversation of alice\'s')

  const items = (await w.bobPhone('/items?state=open&limit=100')).json.items.filter((i) => i.mission_id === copyId)
  assert.deepEqual(items.map((i) => [i.title, i.awaiting]), [['Which caterer?', 'user']])
  const closedCopies = (await w.bobPhone('/items?state=closed&limit=100')).json.items.filter((i) => i.mission_id === copyId)
  assert.deepEqual(closedCopies.map((i) => [i.title, i.resolution]), [['Book the hall', 'done']])
  assert.equal((await w.bobBox(`/items/${items[0].id}/comments`, post({ body: 'Picking this up.' }))).status, 201, 'bob\'s agents work on the copies')
  const thread = (await w.bobPhone(`/items/${items[0].id}`, { headers: { 'x-matron-item-inline': 'attachments' } })).json
  assert.notEqual(items[0].num, r.open.num)
  const words = thread.comments.filter((c) => c.kind === 'comment' && c.attribution)
  assert.deepEqual(words.map((c) => [c.attribution, c.author, c.device_id, c.convo_id]), [
    ["alice's agent", 'agent', 0, null], ["alice's agent", 'agent', 0, null], ['alice', 'agent', 0, null],
  ])
  assert.equal('attribution' in thread.comments.at(-1), false, 'bob\'s own agent wrote the last one')
  // The kept attachment is bob's own blob now, and the inline ref follows it.
  const att = words[0].attachments[0]
  assert.notEqual(att.blob_ref, r.keep)
  assert.equal(words[0].body, `See the plan ![floor plan](attachment:${att.blob_ref})`)
  assert.deepEqual(await w.fetchMedia(w.tokens.bobPhone, att.blob_ref), { status: 200, text: 'floor plan bytes' })
  assert.deepEqual(readBlobTranscript(w.s.db, att.blob_ref), { status: 'done', transcript: 'the hall is booked', segments: SEGMENTS })
  assert.deepEqual(words[1].attachments, [], 'the unticked receipt did not cross')
  assert.equal(words[1].body, 'And the receipt.')
  assert.equal((await w.fetchMedia(w.tokens.bobPhone, r.drop)).status, 404)

  // bob's sessions take it up like any mission of his.
  assert.equal((await w.bobBox(`/milestones`, post({ convo_id: 'bobwork', kind: 'progress', title: 'Picked up', mission: copy.mission.id }))).status, 409, 'a conversation joins it first')
  assert.equal((await w.bobBox(`/missions/${copy.mission.id}/join`, post({ convo_id: 'bobwork' }))).status, 200)

  // alice's original: closed, pointing at the copy; its open items cancelled.
  const orig = (await w.alicePhone(`/missions/${m.id}`)).json
  assert.equal(orig.mission.state, 'closed')
  assert.match(orig.mission.close_summary, /Handed to bob/)
  assert.ok(orig.mission.close_summary.includes(`/u/bob/${copy.mission.num}`))
  const openItem = (await w.alicePhone(`/items/${r.open.id}`)).json
  assert.equal(openItem.item.state, 'closed')
  assert.equal(openItem.item.resolution, 'cancelled')
  assert.equal(openItem.comments.at(-1).body, 'Handed over to bob.')
  assert.equal((await w.alicePhone(`/items/${r.privItem.id}`)).json.item.state, 'closed', 'nothing stays open on a closed mission')
  // Its conversations left it, each told why.
  const links = (await w.alicePhone('/conversations/work/missions')).json.missions.find((x) => x.id === m.id)
  assert.equal(links.active, false)
  const left = w.ws.aliceBox.journal().find((f) => f.type === 'mission' && f.payload.action === 'left' && f.convo_id === 'work')
  assert.deepEqual(left.payload.handed_over, { to: 'bob' })
  const closedMarker = w.ws.alicePhone.journal().find((f) => f.type === 'mission' && f.payload.action === 'closed' && f.payload.mission_id === m.id)
  assert.deepEqual(closedMarker.payload.handed_over, { to: 'bob' })

  // alice keeps a read grant on the copy, which bob may revoke.
  const reverse = (await w.alicePhone('/grants?direction=in')).json.grants
  assert.deepEqual(reverse.map((g) => [g.level, g.state, g.subject_id]), [['read', 'active', copyId]])
  const seen = (await w.alicePhone(`/missions/${copyId}`)).json
  assert.equal(seen.mission.shared_via, 'grant')
  assert.equal(seen.mission.owner.name, 'bob')
  assert.ok(w.ws.alicePhone.frames.some((f) => f.kind === 'shared' && f.event === 'mission_added' && f.mission_id === copyId))
  // The hand-over grant is a record, not a way in: bob cannot read or write
  // alice's closed original through it.
  assert.equal((await w.bobPhone(`/missions/${m.id}`)).status, 404)
  const record = (await w.alicePhone(`/grants/${gid}`)).json.grant
  assert.deepEqual([record.level, record.state, record.copy_id], ['owner', 'active', copyId])
  assert.equal((await w.alicePhone(`/grants/${gid}`, { method: 'DELETE' })).json.blocked_by, 'handed_over')
  assert.deepEqual(audits(w.ws.alicePhone), ['grant.handover_offered', 'grant.handover_accepted'])
  assert.deepEqual(audits(w.ws.bobPhone), ['grant.handover_received', 'grant.handover_accepted'])

  const revoke = await w.bobPhone(`/grants/${reverse[0].id}`, { method: 'DELETE' })
  assert.equal(revoke.status, 200)
  assert.equal((await w.alicePhone(`/missions/${copyId}`)).status, 404)

  // Asking again for a mission already handed over.
  const again = await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF }))
  assert.equal(again.status, 409)
  assert.equal(again.json.blocked_by, 'handed_over')
})

test('hand-over refusals', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  const brief = { level: 'owner', brief: BRIEF }
  assert.equal((await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', ...brief }))).json.blocked_by, 'not_contact')
  await makeContacts(w)
  await makeContacts(w, 'alicePhone', 'carolPhone', 'carol')

  // A mission born on a private box never leaves.
  const priv = createMissionOn(w, 'secret', 'Private launch')
  assert.equal((await w.alicePhone(`/missions/${priv.id}/shares`, post({ contact: 'bob', ...brief }))).json.blocked_by, 'private_mission')
  // One hand-over at a time.
  assert.equal((await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', ...brief }))).status, 201)
  assert.equal((await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'carol', ...brief }))).json.blocked_by, 'pending')
  // A closed mission is not handed over.
  const closed = (await w.aliceBox('/missions', post({ convo_id: 'side', title: 'Done' }))).json.mission
  assert.equal((await w.alicePhone(`/missions/${closed.id}/close`, post({ summary: 'done' }))).status, 200)
  assert.equal((await w.alicePhone(`/missions/${closed.id}/shares`, post({ contact: 'bob', ...brief }))).json.blocked_by, 'mission_closed')

  // A project: owner level only, and only with an open mission in it.
  const proj = (await w.alicePhone('/projects', post({ title: 'Empty project' }))).json.project
  assert.equal((await w.alicePhone(`/projects/${proj.id}/shares`, post({ contact: 'bob', level: 'read' }))).json.blocked_by, 'level_unavailable')
  assert.equal((await w.alicePhone(`/projects/${proj.id}/shares`, post({ contact: 'bob', level: 'owner' }))).status, 400, 'a brief is required')
  assert.equal((await w.alicePhone(`/projects/${proj.id}/shares`, post({ contact: 'bob', ...brief }))).json.blocked_by, 'empty_project')
  assert.equal((await w.alicePhone('/projects/999/shares', post({ contact: 'bob', ...brief }))).status, 404)
  // A project and a mission in it are not handed over at once.
  const proj2 = (await w.alicePhone('/projects', post({ title: 'Club' }))).json.project
  upsertConversation(w.s.db, { id: 'news', ownerUserId: w.alice.id, title: 'News', agentDeviceId: null })
  const inProj = (await w.alicePhone('/missions', post({ convo_id: 'news', title: 'Newsletter', project: proj2.id }))).json.mission
  assert.equal((await w.alicePhone(`/missions/${inProj.id}/shares`, post({ contact: 'bob', ...brief }))).status, 201)
  assert.equal((await w.alicePhone(`/projects/${proj2.id}/shares`, post({ contact: 'carol', ...brief }))).json.blocked_by, 'pending')
  // A grantee cannot hand on what it was given.
  assert.equal((await w.bobPhone(`/missions/${m.id}/shares`, post({ contact: 'alice', ...brief }))).status, 404)
})

// A mission whose origin is a conversation on alice's private box.
function createMissionOn(w, convo, title) {
  const { agent_device_id: deviceId } = w.s.db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(convo)
  return createMission(w.s.db, { userId: w.alice.id, deviceId, createdBy: 'agent', convoId: convo, title, attach: false }).mission
}

test('declining: alice declines with a note that reaches the asking agent; bob declines and both are told', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  await makeContacts(w)
  const ask = await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, convo_id: 'work' }))
  const mirror = (await w.alicePhone('/items?label=consent&state=open')).json.items.find((i) => i.consent === 'handover')
  assert.equal((await w.alicePhone(`/items/${mirror.id}/comments`, post({ action: 'Decline' }))).status, 200)
  assert.equal((await w.alicePhone(`/grants/${ask.json.grant.id}`)).json.grant.state, 'declined')
  // The note: an ordinary reply on the closed card, heard by the agent that asked.
  w.ws.aliceBox.frames.length = 0
  w.ws.aliceCoord.frames.length = 0
  const note = await w.alicePhone(`/items/${mirror.id}/comments`, post({ body: 'Not yet: finish the invitations first.' }))
  assert.equal(note.status, 201)
  assert.equal(note.json.item.state, 'closed', 'the card stays answered')
  await settle()
  const heard = w.ws.aliceBox.journal().find((f) => f.type === 'item' && f.payload.action === 'commented' && f.payload.item_id === mirror.id)
  assert.ok(heard, 'the asking agent hears the note')
  assert.equal(heard.payload.consent, undefined)
  assert.equal(heard.payload.comment.body, 'Not yet: finish the invitations first.')
  assert.equal(w.ws.aliceCoord.journal().filter((f) => f.payload?.item_id === mirror.id).length, 0, 'no other agent does')
  assert.equal(cards(w.ws.bobPhone, 'mission_handover').length, 0, 'nothing reached bob')
  assert.equal((await w.bobPhone(`/grants/${ask.json.grant.id}`)).status, 404, 'an ask alice never approved is never bob\'s to see (test/grant-privacy.test.js)')

  // A client's own ask goes straight to bob; bob declines.
  const direct = await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF }))
  assert.equal(direct.status, 201)
  assert.equal(direct.json.pending, 'peer')
  const no = await w.bobPhone(`/grants/${direct.json.grant.id}/answer`, post({ decision: 'decline' }))
  assert.equal(no.json.grant.state, 'declined')
  await settle()
  assert.ok(audits(w.ws.alicePhone).includes('grant.handover_declined'))
  assert.ok(audits(w.ws.bobPhone).includes('grant.handover_declined'))
  assert.equal((await w.alicePhone(`/missions/${m.id}`)).json.mission.state, 'open', 'nothing moved')
})

test('hand-over of a mission already shared read-only: the share upgrades in place on the two yeses', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  await makeContacts(w)
  const read = await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob' }))
  assert.equal((await w.bobPhone(`/grants/${read.json.grant.id}/answer`, post({ decision: 'approve' }))).status, 200)

  const ask = await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, convo_id: 'work' }))
  assert.equal(ask.status, 202)
  assert.equal(ask.json.grant.id, read.json.grant.id, 'the same row')
  assert.equal(ask.json.grant.state, 'active')
  assert.equal(ask.json.grant.level, 'read')
  assert.equal(ask.json.grant.pending_level, 'owner')
  // bob still reads it, and is told nothing of the ask yet.
  assert.equal((await w.bobPhone(`/missions/${m.id}`)).status, 200)
  const bobView = (await w.bobPhone(`/grants/${read.json.grant.id}`)).json.grant
  assert.equal(bobView.pending_level, null)
  assert.equal('brief' in bobView, false)
  assert.equal((await w.bobPhone(`/grants/${read.json.grant.id}/answer`, post({ decision: 'approve' }))).status, 404)

  assert.equal((await w.alicePhone(`/grants/${read.json.grant.id}/answer`, post({ decision: 'approve' }))).json.grant.pending_level, 'owner')
  assert.equal((await w.bobPhone(`/grants/${read.json.grant.id}`)).json.grant.pending_level, 'owner')
  assert.equal((await w.bobPhone(`/missions/${m.id}`)).status, 200, 'still readable while bob decides')
  w.ws.bobPhone.frames.length = 0
  const accepted = await w.bobPhone(`/grants/${read.json.grant.id}/answer`, post({ decision: 'approve', start_session: { device_id: 1 } }))
  assert.equal(accepted.status, 200)
  assert.equal(accepted.json.grant.level, 'owner')
  assert.equal(accepted.json.grant.pending_level, null)
  assert.deepEqual(accepted.json.start_session, { status: 'refused', reason: 'not_your_box' }, 'device 1 is not one of bob\'s; the copy is made all the same')
  const copyId = accepted.json.grant.copy_id
  assert.equal((await w.bobPhone(`/missions/${copyId}`)).json.mission.title, 'Launch')
  assert.equal((await w.bobPhone(`/missions/${m.id}`)).status, 404, 'the closed original is alice\'s')
  await settle()
  assert.ok(w.ws.bobPhone.frames.some((f) => f.kind === 'shared' && f.event === 'mission_removed' && f.mission_id === m.id), 'bob\'s apps drop the original')
  assert.equal((await w.alicePhone(`/missions/${copyId}`)).status, 200)
})

test('hand over and keep contributing: the agent asks for it, the cards say so, and alice can still write to bob\'s copy', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  await makeContacts(w)
  // Only a hand-over keeps a level, and only read or contribute.
  assert.equal((await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', keep_level: 'contribute', convo_id: 'work' }))).status, 400)
  assert.equal((await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, keep_level: 'owner', convo_id: 'work' }))).status, 400)

  const ask = await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, keep_level: 'contribute', convo_id: 'work' }))
  assert.equal(ask.status, 202)
  assert.equal(ask.json.grant.keep_level, 'contribute')
  await settle()
  const out = cards(w.ws.alicePhone, 'mission_handover').at(-1)
  assert.equal(out.payload.keep_level, 'contribute')
  const ownerMirror = (await w.alicePhone('/items?limit=500')).json.items.find((i) => i.consent === 'handover')
  assert.match(ownerMirror.body, /keep contributing to the copy/)

  // alice approves; the card's switch is hers, and her answer stands.
  assert.equal((await w.alicePhone(`/grants/${ask.json.grant.id}/answer`, post({ decision: 'approve', keep_level: 'banana' }))).status, 400)
  assert.equal((await w.alicePhone(`/grants/${ask.json.grant.id}/answer`, post({ decision: 'approve', keep_level: 'contribute' }))).status, 200)
  await settle()
  const inCard = cards(w.ws.bobPhone, 'mission_handover').at(-1)
  assert.equal(inCard.payload.keep_level, 'contribute')
  assert.equal((await w.bobPhone(`/grants/${ask.json.grant.id}`)).json.grant.keep_level, 'contribute')
  const bobMirror = (await w.bobPhone('/items?limit=500')).json.items.find((i) => i.consent === 'handover')
  assert.match(bobMirror.body, /stays on as a contributor/)

  const accepted = await w.bobPhone(`/grants/${ask.json.grant.id}/answer`, post({ decision: 'approve' }))
  assert.equal(accepted.status, 200)
  const copyId = accepted.json.grant.copy_id
  const back = (await w.alicePhone('/grants?direction=in')).json.grants
  assert.deepEqual(back.map((g) => [g.level, g.state, g.subject_id]), [['contribute', 'active', copyId]])
  // alice's agent writes into bob's copy, as a contributor.
  upsertConversation(w.s.db, { id: 'later', ownerUserId: w.alice.id, title: 'Later', agentDeviceId: w.s.db.prepare("SELECT id FROM devices WHERE name='alice-box'").get().id })
  const ms = await w.aliceBox('/milestones', post({ mission: copyId, kind: 'progress', title: 'Caterer confirmed', convo_id: 'later' }))
  assert.equal(ms.status, 201)
  assert.deepEqual(ms.json.milestone.contributor, { name: 'alice', via: 'agent' })
  // bob can step alice down to reading, or end it, like any share of his.
  assert.equal((await w.bobPhone(`/grants/${back[0].id}`, { method: 'DELETE' })).status, 200)
})

test('the owner\'s card overrides the agent: switching keep contributing off hands over read-only', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  await makeContacts(w)
  const ask = await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, keep_level: 'contribute', convo_id: 'work' }))
  assert.equal((await w.alicePhone(`/grants/${ask.json.grant.id}/answer`, post({ decision: 'approve', keep_level: 'read' }))).status, 200)
  assert.equal((await w.bobPhone(`/grants/${ask.json.grant.id}`)).json.grant.keep_level, 'read')
  // The recipient cannot change what they are agreeing to.
  assert.equal((await w.bobPhone(`/grants/${ask.json.grant.id}/answer`, post({ decision: 'approve', keep_level: 'contribute' }))).status, 200)
  const back = (await w.alicePhone('/grants?direction=in')).json.grants
  assert.deepEqual(back.map((g) => g.level), ['read'])
})

test('a declined upgrade leaves the read share as it was', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  await makeContacts(w)
  const read = await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob' }))
  await w.bobPhone(`/grants/${read.json.grant.id}/answer`, post({ decision: 'approve' }))
  await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF }))
  const no = await w.bobPhone(`/grants/${read.json.grant.id}/answer`, post({ decision: 'decline' }))
  assert.equal(no.status, 200)
  assert.deepEqual([no.json.grant.state, no.json.grant.level, no.json.grant.pending_level], ['active', 'read', null])
  assert.equal((await w.bobPhone(`/missions/${m.id}`)).status, 200)
  assert.equal((await w.alicePhone(`/missions/${m.id}`)).json.mission.state, 'open')
})

test('project hand-over: every open mission moves into a new project of bob\'s; the original project closes', async (t) => {
  const w = await world(t)
  const proj = (await w.alicePhone('/projects', post({ title: 'Garden Club', body: 'Everything for the club.' }))).json.project
  const a = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch', project: proj.id }))).json.mission
  const b = (await w.aliceBox('/missions', post({ convo_id: 'side', title: 'Newsletter', project: proj.id }))).json.mission
  await w.aliceBox('/milestones', post({ convo_id: 'side', kind: 'progress', title: 'First issue drafted' }))
  upsertConversation(w.s.db, { id: 'old', ownerUserId: w.alice.id, title: 'Old', agentDeviceId: null })
  const old = (await w.alicePhone('/missions', post({ convo_id: 'old', title: 'Old season', project: proj.id }))).json.mission
  assert.equal((await w.alicePhone(`/missions/${old.id}/close`, post({ summary: 'over' }))).status, 200)
  await makeContacts(w)

  const ask = await w.aliceBox(`/projects/${proj.num}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, convo_id: 'work' }))
  assert.equal(ask.status, 202)
  assert.equal(ask.json.grant.subject_kind, 'project')
  assert.deepEqual(ask.json.grant.project, { id: proj.id, num: proj.num, title: 'Garden Club' })
  await settle()
  const card = cards(w.ws.alicePhone, 'mission_handover')[0]
  assert.deepEqual(card.payload.subject, { kind: 'project', id: proj.id, num: proj.num, title: 'Garden Club' })
  assert.equal(card.payload.preview.missions, 2, 'open missions only')
  assert.equal(card.payload.preview.milestones, 1)
  assert.equal((await w.alicePhone(`/projects/${proj.id}/shares`)).json.grants.length, 1)
  assert.equal((await w.alicePhone(`/grants/${ask.json.grant.id}/answer`, post({ decision: 'approve' }))).status, 200)
  await settle()
  assert.deepEqual(cards(w.ws.bobPhone, 'mission_handover')[0].payload.subject, { kind: 'project', title: 'Garden Club' })
  const acc = await w.bobPhone(`/grants/${ask.json.grant.id}/answer`, post({ decision: 'approve' }))
  assert.equal(acc.status, 200)
  const newProj = acc.json.grant.copy_id
  assert.match(newProj, /^pj_/)

  const bobProject = (await w.bobPhone(`/projects/${newProj}`)).json.project
  assert.equal(bobProject.title, 'Garden Club')
  assert.equal(bobProject.body, 'Everything for the club.')
  const bobMissions = (await w.bobPhone('/missions?state=open')).json.missions.filter((x) => x.project_id === newProj)
  assert.deepEqual(bobMissions.map((x) => x.title).sort(), ['Launch', 'Newsletter'])
  assert.equal((await w.alicePhone(`/projects/${proj.id}`)).json.project.state, 'closed')
  for (const x of [a, b]) assert.equal((await w.alicePhone(`/missions/${x.id}`)).json.mission.state, 'closed')
  assert.equal((await w.alicePhone(`/missions/${old.id}`)).json.mission.close_summary, 'over', 'a closed mission stays as it was')
  const reverse = (await w.alicePhone('/grants?direction=in')).json.grants
  assert.deepEqual(reverse.map((g) => g.subject_id).sort(), bobMissions.map((x) => x.id).sort())
})

test('after a hand-over, removing the contact ends the read-back grant and leaves the record', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  const { aliceContact } = await makeContacts(w)
  const g = (await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF }))).json.grant
  const copyId = (await w.bobPhone(`/grants/${g.id}/answer`, post({ decision: 'approve' }))).json.grant.copy_id
  assert.equal((await w.alicePhone(`/contacts/${aliceContact}`, { method: 'DELETE' })).status, 200)
  assert.equal((await w.alicePhone(`/missions/${copyId}`)).status, 404)
  const record = (await w.alicePhone(`/grants/${g.id}`)).json.grant
  assert.deepEqual([record.level, record.state, record.copy_id], ['owner', 'active', copyId])
  assert.equal((await w.bobPhone(`/missions/${copyId}`)).json.mission.state, 'open', 'the copy is bob\'s to keep')
})

test('an agent\'s raise that nobody approves expires and leaves the read share alone', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  await makeContacts(w)
  const read = await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob' }))
  await w.bobPhone(`/grants/${read.json.grant.id}/answer`, post({ decision: 'approve' }))
  await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, convo_id: 'work' }))
  const gone = expireGrantAsks(w.s.db, Date.now() + OWN_ASK_TTL_MS + 1000)
  assert.equal(gone.length, 1)
  for (const r of gone) onGrantAskExpired({ db: w.s.db, hub: w.s.hub }, r)
  const g = (await w.alicePhone(`/grants/${read.json.grant.id}`)).json.grant
  assert.deepEqual([g.state, g.level, g.pending_level], ['active', 'read', null])
  assert.equal('brief' in (await w.bobPhone(`/grants/${read.json.grant.id}`)).json.grant, false)
  const mirror = (await w.alicePhone('/items?label=consent&state=closed')).json.items.find((i) => i.consent === 'handover')
  assert.equal(mirror.resolution, 'cancelled')
  assert.equal((await w.bobPhone(`/missions/${m.id}`)).status, 200)
})

test('an accept that fails part-way changes nothing and leaves no copied file behind', async (t) => {
  const w = await world(t)
  const r = await richMission(w)
  await makeContacts(w)
  const g = (await w.alicePhone(`/missions/${r.mission.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF }))).json.grant
  const files = () => fs.readdirSync(w.mediaDir, { recursive: true }).filter((f) => fs.statSync(path.join(w.mediaDir, f)).isFile()).length
  const before = files()
  // The last write of the accept fails: the grant's own update.
  w.s.db.exec(`CREATE TRIGGER no_handover BEFORE UPDATE OF copy_subject_id ON grants WHEN NEW.copy_subject_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'not today'); END`)
  const quiet = t.mock.method(console, 'error', () => {})
  const res = await w.bobPhone(`/grants/${g.id}/answer`, post({ decision: 'approve' }))
  assert.equal(res.status, 500)
  quiet.mock.restore()
  assert.equal(files(), before, 'the copied blob file was removed')
  assert.equal((await w.alicePhone(`/missions/${r.mission.id}`)).json.mission.state, 'open')
  assert.equal((await w.bobPhone(`/grants/${g.id}`)).json.grant.state, 'pending')
  assert.deepEqual((await w.bobPhone('/missions')).json.missions, [])
  w.s.db.exec('DROP TRIGGER no_handover')
  assert.equal((await w.bobPhone(`/grants/${g.id}/answer`, post({ decision: 'approve' }))).status, 200, 'and it can be accepted after')
})

test('withdrawing a project hand-over names the project, and a link to a vanished conversation does not block an accept', async (t) => {
  const w = await world(t)
  const proj = (await w.alicePhone('/projects', post({ title: 'Garden Club' }))).json.project
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch', project: proj.id }))).json.mission
  await makeContacts(w)
  const g = (await w.alicePhone(`/projects/${proj.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF }))).json.grant
  w.ws.bobPhone.frames.length = 0
  assert.equal((await w.alicePhone(`/grants/${g.id}`, { method: 'DELETE' })).status, 200)
  await settle()
  const lines = [...w.ws.alicePhone.journal(), ...w.ws.bobPhone.journal()].filter((f) => f.type === 'people' && f.payload.event === 'grant.revoked').map((f) => f.payload.summary)
  assert.equal(lines.length, 2)
  for (const line of lines) assert.match(line, /project/)
  for (const line of lines) assert.doesNotMatch(line, /undefined|null/)
  assert.equal(w.ws.bobPhone.frames.filter((f) => f.kind === 'shared' && f.event === 'mission_removed').length, 0)

  // A link whose conversation row is gone.
  w.s.db.prepare("INSERT INTO mission_conversations(mission_id, convo_id, user_id, how, joined_at) VALUES(?, 'gone', ?, 'joined', 1)").run(m.id, w.alice.id)
  const again = (await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF }))).json.grant
  assert.equal((await w.bobPhone(`/grants/${again.id}/answer`, post({ decision: 'approve' }))).status, 200)
  assert.equal(w.s.db.prepare("SELECT ended_at FROM mission_conversations WHERE convo_id='gone'").get().ended_at != null, true)
})

test('the owner approves a set; if what would cross changes before the accept, the hand-over ends', async (t) => {
  const w = await world(t)
  const proj = (await w.alicePhone('/projects', post({ title: 'Garden Club' }))).json.project
  await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch', project: proj.id }))
  await makeContacts(w)
  const ask = (await w.aliceBox(`/projects/${proj.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, convo_id: 'work' }))).json.grant
  assert.equal((await w.alicePhone(`/grants/${ask.id}/answer`, post({ decision: 'approve' }))).status, 200)
  // A mission joins the project after alice approved what crosses.
  upsertConversation(w.s.db, { id: 'late', ownerUserId: w.alice.id, title: 'Late', agentDeviceId: null })
  const late = await w.alicePhone('/missions', post({ convo_id: 'late', title: 'Late mission', project: proj.id }))
  assert.equal(late.status, 201)
  const r = await w.bobPhone(`/grants/${ask.id}/answer`, post({ decision: 'approve' }))
  assert.equal(r.status, 409)
  assert.equal(r.json.blocked_by, 'handover_changed')
  assert.equal((await w.alicePhone(`/grants/${ask.id}`)).json.grant.state, 'expired')
  const bobMirror = (await w.bobPhone('/items?label=consent&state=closed')).json.items.find((i) => i.consent === 'handover')
  assert.equal(bobMirror.resolution, 'cancelled')
  assert.match((await w.bobPhone(`/items/${bobMirror.id}`)).json.comments.at(-1).body, /changed/)
  const aliceMirror = (await w.alicePhone('/items?label=consent&state=closed')).json.items.find((i) => i.consent === 'handover')
  assert.match((await w.alicePhone(`/items/${aliceMirror.id}`)).json.comments.at(-1).body, /changed/)
  assert.equal((await w.alicePhone(`/projects/${proj.id}`)).json.project.state, 'open', 'nothing moved')
  assert.deepEqual((await w.bobPhone('/missions')).json.missions, [])
})

test('a new attachment after the approval ends the hand-over too', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  const item = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'task', title: 'Plan' }))).json.item
  await makeContacts(w)
  const g = (await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF }))).json.grant
  const blob = await w.upload(w.tokens.aliceBox, 'late file', 'text/plain')
  await w.aliceBox(`/items/${item.id}/comments`, post({ body: 'one more', attachments: [{ blob_ref: blob, mime: 'text/plain', name: 'late.txt', size: 9 }] }))
  const r = await w.bobPhone(`/grants/${g.id}/answer`, post({ decision: 'approve' }))
  assert.equal(r.json.blocked_by, 'handover_changed')
  assert.equal((await w.alicePhone(`/missions/${m.id}`)).json.mission.state, 'open')
})

test('approving re-checks the subject: a mission closed meanwhile ends the ask and the card says why', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  await makeContacts(w)
  const ask = (await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, convo_id: 'work' }))).json.grant
  assert.equal((await w.alicePhone(`/missions/${m.id}/close`, post({ summary: 'done another way' }))).status, 200)
  const r = await w.alicePhone(`/grants/${ask.id}/answer`, post({ decision: 'approve' }))
  assert.equal(r.status, 409)
  assert.equal(r.json.blocked_by, 'mission_closed')
  assert.equal((await w.alicePhone(`/grants/${ask.id}`)).json.grant.state, 'expired')
  const mirror = (await w.alicePhone('/items?label=consent&state=closed')).json.items.find((i) => i.consent === 'handover')
  assert.match((await w.alicePhone(`/items/${mirror.id}`)).json.comments.at(-1).body, /closed/)
  await settle()
  assert.equal(cards(w.ws.bobPhone, 'mission_handover').length, 0, 'nothing reached bob')
})

test('a mission or project with a hand-over in flight cannot be refiled', async (t) => {
  const w = await world(t)
  const projA = (await w.alicePhone('/projects', post({ title: 'A' }))).json.project
  const projB = (await w.alicePhone('/projects', post({ title: 'B' }))).json.project
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch', project: projA.id }))).json.mission
  upsertConversation(w.s.db, { id: 'loose', ownerUserId: w.alice.id, title: 'Loose', agentDeviceId: null })
  const loose = (await w.alicePhone('/missions', post({ convo_id: 'loose', title: 'Loose' }))).json.mission
  await makeContacts(w)
  const g = (await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF }))).json.grant
  const out = await w.alicePhone(`/missions/${m.id}`, { method: 'PATCH', body: { project: projB.id } })
  assert.equal(out.status, 409)
  assert.equal(out.json.blocked_by, 'handover_pending')
  await w.bobPhone(`/grants/${g.id}/answer`, post({ decision: 'decline' }))
  assert.equal((await w.alicePhone(`/missions/${m.id}`, { method: 'PATCH', body: { project: projB.id } })).status, 200, 'once it ended')
  // A project being handed over takes no missions in or out.
  await w.alicePhone(`/projects/${projB.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF }))
  assert.equal((await w.alicePhone(`/missions/${loose.id}`, { method: 'PATCH', body: { project: projB.id } })).json.blocked_by, 'handover_pending')
  assert.equal((await w.alicePhone(`/missions/${m.id}`, { method: 'PATCH', body: { project: projA.id } })).json.blocked_by, 'handover_pending')
  assert.equal((await w.alicePhone(`/missions/${m.id}`, { method: 'PATCH', body: { title: 'Renamed' } })).status, 200, 'other edits are fine')
})

test('handing over ends the original\'s other open asks and closes their cards', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  await makeContacts(w)
  await makeContacts(w, 'alicePhone', 'carolPhone', 'carol')
  // A read share offered to carol, still with her; and alice's agent's
  // second ask, still with alice.
  const toCarol = (await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'carol' }))).json.grant
  const g = (await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF }))).json.grant
  assert.equal((await w.bobPhone(`/grants/${g.id}/answer`, post({ decision: 'approve' }))).status, 200)
  assert.equal((await w.alicePhone(`/grants/${toCarol.id}`)).json.grant.state, 'expired')
  const carolMirror = (await w.carolPhone('/items?label=consent&state=closed')).json.items.find((i) => i.consent === 'share')
  assert.equal(carolMirror.resolution, 'cancelled')
  assert.match((await w.carolPhone(`/items/${carolMirror.id}`)).json.comments.at(-1).body, /handed over/)
  assert.equal((await w.carolPhone('/items?label=consent&state=open')).json.items.length, 0)
})

test('an ask that ends before the owner approves never leaves its brief for the recipient', async (t) => {
  const w = await world(t)
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Launch' }))).json.mission
  const { aliceContact } = await makeContacts(w)
  // Refused at the approval: the mission was closed meanwhile.
  const ask = (await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, convo_id: 'work' }))).json.grant
  await w.alicePhone(`/missions/${m.id}/close`, post({ summary: 'done' }))
  assert.equal((await w.alicePhone(`/grants/${ask.id}/answer`, post({ decision: 'approve' }))).status, 409)
  assert.equal((await w.bobPhone(`/grants/${ask.id}`)).status, 404, 'never sent, so never bob\'s to see')
  // Ended by removing the contact while it waited for alice.
  const m2 = (await w.aliceBox('/missions', post({ convo_id: 'side', title: 'Second' }))).json.mission
  const ask2 = (await w.aliceBox(`/missions/${m2.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, convo_id: 'side' }))).json.grant
  assert.equal((await w.alicePhone(`/contacts/${aliceContact}`, { method: 'DELETE' })).status, 200)
  assert.equal((await w.bobPhone(`/grants/${ask2.id}`)).status, 404)
  const row = w.s.db.prepare('SELECT brief, exclude_media, approved FROM grants WHERE id=?').get(ask2.id)
  assert.deepEqual(row, { brief: null, exclude_media: null, approved: null })
})

test('copyBlob: a pending transcript does not cross (no job runs for the copy); every other status does', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-ho-blob-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const db = openDb(':memory:')
  t.after(() => db.close())
  const alice = await createUser(db, 'alice', 'pw')
  const bob = await createUser(db, 'bob', 'pw')
  const SEG = JSON.stringify([{ start_ms: 0, text: 'hi' }])
  const rows = {
    pending: { transcript_status: 'pending', transcript: null, transcript_segments: null, transcribed_at: null },
    done: { transcript_status: 'done', transcript: 'hi', transcript_segments: SEG, transcribed_at: 5 },
    failed: { transcript_status: 'failed', transcript: null, transcript_segments: null, transcribed_at: null },
    none: { transcript_status: null, transcript: null, transcript_segments: null, transcribed_at: null },
  }
  const files = []
  const copies = {}
  for (const [k, cols] of Object.entries(rows)) {
    const src = path.join(dir, 'ab', `src-${k}`)
    fs.mkdirSync(path.dirname(src), { recursive: true })
    fs.writeFileSync(src, `bytes ${k}`)
    insertBlob(db, { id: `src-${k}`, ownerUserId: alice.id, contentType: 'video/mp4', size: 7, sha256: 'x', diskPath: src })
    db.prepare('UPDATE blobs SET transcript_status=?, transcript=?, transcript_segments=?, transcribed_at=?, transcript_asked_at=? WHERE id=?')
      .run(cols.transcript_status, cols.transcript, cols.transcript_segments, cols.transcribed_at, cols.transcript_status ? 1 : null, `src-${k}`)
    copies[k] = copyBlob(db, db.prepare('SELECT * FROM blobs WHERE id=?').get(`src-${k}`), bob.id, files)
    assert.ok(copies[k], k)
  }
  assert.deepEqual(readBlobTranscript(db, copies.pending), { status: 'none' }, 'a bridge can ask for it again')
  const pendingCopy = db.prepare('SELECT transcript, transcript_status, transcript_segments, transcribed_at, transcript_asked_at FROM blobs WHERE id=?').get(copies.pending)
  assert.deepEqual({ ...pendingCopy }, { transcript: null, transcript_status: null, transcript_segments: null, transcribed_at: null, transcript_asked_at: null })
  assert.deepEqual(readBlobTranscript(db, copies.done), { status: 'done', transcript: 'hi', segments: [{ start_ms: 0, text: 'hi' }] })
  assert.equal(db.prepare('SELECT transcribed_at FROM blobs WHERE id=?').get(copies.done).transcribed_at, 5)
  assert.deepEqual(readBlobTranscript(db, copies.failed), { status: 'failed' })
  assert.deepEqual(readBlobTranscript(db, copies.none), { status: 'none' })
  assert.equal(files.length, 4)
})
