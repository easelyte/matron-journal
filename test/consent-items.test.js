import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnConsentItemFields, spawnConsentClosing, consentLink, fileSpawnConsentItem, closeSpawnConsentItem, chatConsentItemFields, chatConsentClosing } from '../src/consent-items.js'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'

const card = {
  request_id: 'sp-1', from_name: 'dev-6', from_convo_title: 'parent session',
  target_name: 'eric', workdir: '/home/dan/proj', task: 'fix the flaky test and report back', topic: 'flaky test',
}

test('consentLink names the ask by kind and id', () => {
  assert.equal(consentLink('spawn', 'sp-1'), 'matron://consent/spawn/sp-1')
})

test('spawnConsentItemFields: title names the box and the topic; body carries task, box, workdir and how to answer', () => {
  const f = spawnConsentItemFields(card)
  assert.equal(f.title, 'Approve spawn on eric — flaky test')
  assert.ok(f.body.includes('fix the flaky test and report back'))
  assert.ok(f.body.includes('eric'))
  assert.ok(f.body.includes('/home/dan/proj'))
  assert.ok(f.body.includes('parent session'))
  assert.ok(/Approve/.test(f.body) && /Decline/.test(f.body))
  assert.ok(!f.body.includes('Model'))
  assert.ok(!/chat room/i.test(f.body))
  assert.deepEqual(f.labels, ['consent'])
  assert.deepEqual(f.links, [{ url: 'matron://consent/spawn/sp-1', title: 'Spawn request sp-1' }])
})

test('spawnConsentItemFields: without a topic the title falls back to the task, cut to fit', () => {
  const f = spawnConsentItemFields({ ...card, topic: '', task: 'x'.repeat(500) })
  assert.ok(f.title.startsWith('Approve spawn on eric — xxxx'))
  assert.ok(f.title.length <= 200)
  assert.ok(f.title.endsWith('…'))
})

test('spawnConsentItemFields: model and link show up only when asked for', () => {
  const f = spawnConsentItemFields({ ...card, model: 'opus', link: true })
  assert.ok(f.body.includes('opus'))
  assert.ok(/chat room/i.test(f.body))
})

test('spawnConsentItemFields: a backtick in the workdir cannot break out of its code span', () => {
  const f = spawnConsentItemFields({ ...card, workdir: '/tmp/a`b' })
  assert.ok(!f.body.includes('a`b'))
  assert.ok(f.body.includes('/tmp/a'))
})

test('spawnConsentClosing: approve and decline are decided by the user; expiry and failure are cancelled', () => {
  const started = spawnConsentClosing({ outcome: 'started' }, { targetName: 'eric', link: false })
  assert.equal(started.resolution, 'decided'); assert.equal(started.author, 'user')
  assert.ok(started.comment.includes('Approved') && started.comment.includes('eric'))
  assert.ok(!/chat room/i.test(started.comment))
  const linked = spawnConsentClosing({ outcome: 'started', roomId: 'r1' }, { targetName: 'eric', link: true })
  assert.ok(/chat room/i.test(linked.comment))
  const declined = spawnConsentClosing({ outcome: 'declined' }, { targetName: 'eric' })
  assert.equal(declined.resolution, 'decided'); assert.equal(declined.author, 'user')
  assert.ok(declined.comment.includes('Declined'))
  const expired = spawnConsentClosing({ outcome: 'expired' }, { targetName: 'eric' })
  assert.equal(expired.resolution, 'cancelled'); assert.equal(expired.author, 'agent')
  assert.ok(expired.comment.includes('24 h'))
  const failed = spawnConsentClosing({ outcome: 'failed', errorCode: 'agent_unreachable' }, { targetName: 'eric' })
  assert.equal(failed.resolution, 'cancelled'); assert.equal(failed.author, 'agent')
  assert.ok(failed.comment.includes('Approved') && failed.comment.includes('agent_unreachable'))
})

test('spawnConsentItemFields: the task is fenced, so markdown in it (images, links, emphasis) renders as text', () => {
  const f = spawnConsentItemFields({ ...card, task: '![p](https://x/px.png) **bold** [go](https://phish)' })
  assert.ok(f.body.includes('```\n![p](https://x/px.png) **bold** [go](https://phish)\n```'))
  assert.ok(!f.body.includes('> !['))
})

test('spawnConsentItemFields: markup in device and conversation names is stripped, never rendered', () => {
  const f = spawnConsentItemFields({ ...card, from_name: 'dev*6_[x]', target_name: 'er**ic', from_convo_title: 'ses"sion <b>' })
  assert.ok(f.body.includes('**dev6x** asks'))
  assert.ok(f.body.includes('on **eric**'))
  assert.ok(f.body.includes('"session b"'))
  assert.equal(f.title, 'Approve spawn on eric — flaky test')
})

test('spawnConsentClosing: an outcome this build does not know closes neutrally, never as an approval', () => {
  const c = spawnConsentClosing({ outcome: 'weird' }, { targetName: 'eric' })
  assert.equal(c.resolution, 'cancelled'); assert.equal(c.author, 'agent')
  assert.ok(!c.comment.includes('Approved'))
  assert.ok(c.comment.includes('weird'))
})

test('closeSpawnConsentItem never throws: a lookup that fails is a false, not an exception past the outcome frame', () => {
  const broken = { prepare() { throw new Error('database connection is not open') } }
  assert.equal(closeSpawnConsentItem({ db: broken, hub: null }, 'sp-1', { outcome: 'declined' }), false)
})

test('fileSpawnConsentItem against a spawn row that is gone files nothing: create and link are one transaction', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const agent = createAgent(db, dan.id, 'dev-6')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: agent.deviceId })
  const hub = { broadcast() {}, sendToDevice() {}, connsOf() { return [] } }
  const item = fileSpawnConsentItem({ db, hub }, { userId: dan.id, fromDeviceId: agent.deviceId, fromName: 'dev-6', fromConvoId: 'c1', spawnId: 'no-such-row', card })
  assert.equal(item, null)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 0)
})

test('spawnConsentItemFields: a task containing a backtick fence stays verbatim — the fence around it just grows', () => {
  const task = 'run ``` then ```` and report'
  const f = spawnConsentItemFields({ ...card, task })
  assert.ok(f.body.includes(`\`\`\`\`\`\n${task}\n\`\`\`\`\``))
  assert.ok(!f.body.includes(`\n\`\`\`\n${task}`))
})

const chatCard = {
  kind: 'agent_chat', request: 'invite', room_id: 'room-1', from_device_id: 7, from_name: 'dev-a', target_device_id: 12,
  topic: 'ci logs', justification: 'need the failing job output', from_convo_id: 'c-a', from_convo_title: 'A:xy fixing ci',
  to_name: 'dev-b', to_convo_id: 'c-b', to_convo_title: 'B:qq reviewing',
}

test('chatConsentItemFields (invite): title names both sides and the topic; body has both sessions, the justification fenced, and how to answer', () => {
  const f = chatConsentItemFields(chatCard)
  assert.equal(f.title, 'dev-a asks to chat with dev-b — ci logs')
  assert.ok(f.body.includes('```\nneed the failing job output\n```'))
  assert.ok(f.body.includes('A:xy fixing ci') && f.body.includes('B:qq reviewing'))
  assert.ok(/Approve/.test(f.body) && /Decline/.test(f.body))
  assert.deepEqual(f.labels, ['consent'])
  assert.deepEqual(f.links, [{ url: 'matron://consent/chat/room-1/12', title: 'Agent chat request' }])
})

test('chatConsentItemFields (join): title says join, names the owner; blank session titles are left out, not rendered empty', () => {
  const f = chatConsentItemFields({ ...chatCard, request: 'join', topic: '', from_convo_id: '', from_convo_title: '', to_convo_id: '', to_convo_title: '', target_device_id: 7 })
  assert.equal(f.title, "dev-a asks to join dev-b's room")
  assert.ok(!f.body.includes('""'))
  assert.deepEqual(f.links, [{ url: 'matron://consent/chat/room-1/7', title: 'Agent chat request' }])
})

test('chatConsentClosing: approve and deny are decided by the user; expiry and a dissolved room are cancelled', () => {
  assert.deepEqual(chatConsentClosing('approved'), { resolution: 'decided', author: 'user', comment: 'Approved — the invitation is on its way.' })
  assert.deepEqual(chatConsentClosing('denied'), { resolution: 'decided', author: 'user', comment: 'Declined.' })
  assert.deepEqual(chatConsentClosing('expired'), { resolution: 'cancelled', author: 'agent', comment: 'Expired — no answer within 24 h.' })
  assert.deepEqual(chatConsentClosing('left'), { resolution: 'cancelled', author: 'agent', comment: 'The room was closed before you answered.' })
  assert.equal(chatConsentClosing('weird').resolution, 'cancelled')
})

test('spawnConsentItemFields: a spawn onto a mission says "joins mission #N" with its title; without one the line is absent', () => {
  const plain = spawnConsentItemFields(card)
  assert.ok(!/joins mission/i.test(plain.body), 'no mission line without mission_num')
  const withMission = spawnConsentItemFields({ ...card, mission_num: 42, mission_title: 'Ship the *panel*' })
  // Title passed through plain(): markdown/control characters stripped, same as every other peer string here.
  assert.ok(withMission.body.includes('- **Joins mission #42** — Ship the panel'), withMission.body)
  const untitled = spawnConsentItemFields({ ...card, mission_num: 42 })
  assert.ok(untitled.body.includes('- **Joins mission #42**\n'), 'no dangling dash when the title is absent')
})
