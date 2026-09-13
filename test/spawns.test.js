import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import {
  createSpawnRequest, getSpawn, denySpawn, claimApprove,
  markStarted, markFailed, expireSpawns, expireApproved, countPendingAsks, approveSpawn,
  sanitizeSpawnActivity, sanitizeSpawnLimits, sanitizeSpawnDisk,
} from '../src/spawns.js'
import { parkInvite } from '../src/participants.js'
import { upsertConversation, messagesBefore } from '../src/journal.js'

async function seed() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const parent = createAgent(db, dan.id, 'dev-6')
  const target = createAgent(db, dan.id, 'eric')
  return { db, dan, parent, target }
}

function makeRow(db, dan, parent, target, id = 'spawn-1', now = 1000, model = '') {
  createSpawnRequest(db, {
    id, userId: dan.id, fromDeviceId: parent.deviceId, fromConvoId: 'parent-convo',
    targetDeviceId: target.deviceId, workdir: '/home/dan/proj', task: 'do the thing', topic: 'thing', model, now,
  })
}

test('createSpawnRequest lands in awaiting_user with every field', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target)
  const row = getSpawn(db, 'spawn-1')
  assert.equal(row.state, 'awaiting_user')
  assert.equal(row.user_id, dan.id)
  assert.equal(row.from_device_id, parent.deviceId)
  assert.equal(row.from_convo_id, 'parent-convo')
  assert.equal(row.target_device_id, target.deviceId)
  assert.equal(row.workdir, '/home/dan/proj')
  assert.equal(row.task, 'do the thing')
  assert.equal(row.topic, 'thing')
  assert.equal(row.model, '') // no model asked for — stored empty, never null-vs-'' ambiguous
  assert.equal(row.created_at, 1000)
  assert.equal(row.answered_at, null)
  assert.equal(row.resolved_at, null)
})

// The model alias rides the same optional-field discipline as from_name: it
// reaches the target bridge only when the requester actually asked for one,
// so a bridge that predates the field sees exactly the params it always saw.
test('approveSpawn relays a requested model in the start params and omits the key when none was asked for', async () => {
  const { db, dan, parent, target } = await seed()
  const hub = { sendToDevice: () => true, broadcastJournal: () => {} }
  const params = []
  const broker = {
    issue: async (h, userId, deviceId, method, p) => { params.push(p); return { ok: true, result: { convo_id: 'child-1' } } },
  }

  makeRow(db, dan, parent, target, 's-model', 1000, 'opus')
  claimApprove(db, 's-model')
  assert.equal(await approveSpawn({ db, hub, broker, startTimeoutMs: 50, roomId: 'room-model' }, getSpawn(db, 's-model')), 'started')
  assert.equal(params[0].model, 'opus')

  makeRow(db, dan, parent, target, 's-plain')
  claimApprove(db, 's-plain')
  assert.equal(await approveSpawn({ db, hub, broker, startTimeoutMs: 50, roomId: 'room-plain' }, getSpawn(db, 's-plain')), 'started')
  assert.ok(!('model' in params[1]), 'no model asked for — the key must be absent, not empty')
})

// Rows written before the column existed read NULL, not '' — the same
// falsy-omit path has to cover them or an ALTER'd database would relay
// `model: null` to every target bridge.
test('approveSpawn omits model for a pre-migration row whose column is NULL', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target, 's-null')
  db.prepare('UPDATE agent_spawn_requests SET model=NULL WHERE id=?').run('s-null')
  claimApprove(db, 's-null')
  const params = []
  const hub = { sendToDevice: () => true, broadcastJournal: () => {} }
  const broker = {
    issue: async (h, userId, deviceId, method, p) => { params.push(p); return { ok: true, result: { convo_id: 'child-1' } } },
  }
  assert.equal(await approveSpawn({ db, hub, broker, startTimeoutMs: 50, roomId: 'room-null' }, getSpawn(db, 's-null')), 'started')
  assert.ok(!('model' in params[0]))
})

test('claimApprove wins exactly once; denySpawn cannot follow a claim', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target)
  assert.equal(claimApprove(db, 'spawn-1', 2000), true)
  assert.equal(getSpawn(db, 'spawn-1').state, 'approved')
  assert.equal(getSpawn(db, 'spawn-1').answered_at, 2000)
  assert.equal(claimApprove(db, 'spawn-1', 2001), false) // second tap loses
  assert.equal(denySpawn(db, 'spawn-1', 2002), false)    // deny after claim loses too
})

test('denySpawn resolves an awaiting row; approve cannot follow', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target)
  assert.equal(denySpawn(db, 'spawn-1', 2000), true)
  const row = getSpawn(db, 'spawn-1')
  assert.equal(row.state, 'denied')
  assert.equal(row.answered_at, 2000)
  assert.equal(row.resolved_at, 2000)
  assert.equal(claimApprove(db, 'spawn-1', 2001), false)
})

test('markStarted/markFailed only fire from approved, and record the terminal facts', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target)
  assert.equal(markStarted(db, 'spawn-1', { roomId: 'r', childConvoId: 'c', now: 3000 }), false) // not approved yet
  claimApprove(db, 'spawn-1', 2000)
  assert.equal(markStarted(db, 'spawn-1', { roomId: 'room-1', childConvoId: 'child-1', now: 3000 }), true)
  const row = getSpawn(db, 'spawn-1')
  assert.equal(row.state, 'started')
  assert.equal(row.room_id, 'room-1')
  assert.equal(row.child_convo_id, 'child-1')
  assert.equal(row.resolved_at, 3000)
  assert.equal(markFailed(db, 'spawn-1', 3001), false) // already terminal

  makeRow(db, dan, parent, target, 'spawn-2')
  claimApprove(db, 'spawn-2', 2000)
  assert.equal(markFailed(db, 'spawn-2', 3000), true)
  assert.equal(getSpawn(db, 'spawn-2').state, 'failed')
})

test('expireSpawns flips only stale awaiting rows and reports who to tell', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target, 'old', 1000)
  makeRow(db, dan, parent, target, 'fresh', 900000)
  makeRow(db, dan, parent, target, 'claimed', 1000)
  claimApprove(db, 'claimed', 2000)
  const expired = expireSpawns(db, 100000, 500000) // ttl 100s at t=500s: only 'old' is stale
  assert.deepEqual(expired.map((r) => r.id), ['old'])
  assert.equal(expired[0].user_id, dan.id)
  assert.equal(expired[0].from_device_id, parent.deviceId)
  assert.equal(getSpawn(db, 'old').state, 'expired')
  assert.equal(getSpawn(db, 'fresh').state, 'awaiting_user')
  assert.equal(getSpawn(db, 'claimed').state, 'approved') // never expires a claimed row
})

test('an unknown state can never be written (CHECK constraint)', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target)
  assert.throws(() => db.prepare("UPDATE agent_spawn_requests SET state='ended' WHERE id='spawn-1'").run())
})

test('countPendingAsks sums awaiting_user across BOTH tables', async () => {
  const { db, dan, parent, target } = await seed()
  upsertConversation(db, { id: 'room-x', ownerUserId: dan.id, title: 'x', sessionState: 'running', agentDeviceId: parent.deviceId })

  // spawn rows alone
  makeRow(db, dan, parent, target, 's1')
  makeRow(db, dan, parent, target, 's2')
  assert.equal(countPendingAsks(db, parent.deviceId), 2)

  // chat rows alone (fresh device so the count starts at zero)
  parkInvite(db, { convoId: 'room-x', agentDeviceId: target.deviceId, initiatorDeviceId: target.deviceId, justification: 'j' })
  assert.equal(countPendingAsks(db, target.deviceId), 1)

  // the mix: 2 spawn + 1 chat = 3 for parent once it also parks a chat ask
  parkInvite(db, { convoId: 'room-x', agentDeviceId: parent.deviceId, initiatorDeviceId: parent.deviceId, justification: 'j' })
  assert.equal(countPendingAsks(db, parent.deviceId), 3)

  // resolved rows drop out
  denySpawn(db, 's1')
  assert.equal(countPendingAsks(db, parent.deviceId), 2)
})

// The success-path twin of fail()'s exactly-once guard: a start reply that
// lands after the orphan sweep already resolved the row must not produce a
// second (contradicting) outcome frame. Deterministic re-creation of the
// race: the stub broker flips the row to failed (as the sweep would) before
// answering ok.
test('late start reply after orphan sweep sends no started frame', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target, 's-race')
  claimApprove(db, 's-race')
  const frames = []
  const hub = {
    sendToDevice: (userId, deviceId, msg) => { frames.push(msg); return true },
    broadcastJournal: () => {},
  }
  const broker = {
    issue: async () => {
      expireApproved(db, 0) // sweep wins the race while the RPC is in flight
      return { ok: true, result: { convo_id: 'child-1' } }
    },
  }
  const out = await approveSpawn({ db, hub, broker, startTimeoutMs: 50 }, getSpawn(db, 's-race'))
  assert.equal(out, 'failed')
  assert.equal(getSpawn(db, 's-race').state, 'failed')
  assert.equal(frames.filter((f) => f.kind === 'spawn' && f.event === 'outcome').length, 0,
    'sweep already told the parent; the late success must stay silent')
})

// The target bridge's error.code is peer-authored and only length-capped on
// the wire (ws.js RPC_NAME_MAX_CHARS=64, any characters) — a malicious or
// buggy target must not be able to inject a forged extra line into the
// failure epitaph this journal writes into a room every participant reads.
test('approveSpawn sanitizes a malicious error_code before writing the failure epitaph into the room', async () => {
  const { db, dan, parent, target } = await seed()
  makeRow(db, dan, parent, target, 's-evil')
  claimApprove(db, 's-evil')
  const hub = { sendToDevice: () => true, broadcastJournal: () => {} }
  const broker = { issue: async () => ({ ok: false, error: { code: 'bad\ncode\x00 with «forged» line' } }) }
  const roomId = 'room-evil'
  const out = await approveSpawn({ db, hub, broker, startTimeoutMs: 50, roomId }, getSpawn(db, 's-evil'))
  assert.equal(out, 'failed')
  const epitaph = messagesBefore(db, dan.id, roomId, {}).find((m) => m.type === 'text' && m.sender === 'journal')
  assert.ok(epitaph, 'epitaph message should exist')
  assert.ok(!epitaph.payload.body.includes('\n'))
  assert.ok(!epitaph.payload.body.includes('\x00'))
  assert.ok(epitaph.payload.body.includes('bad code with «forged» line'))
})

test('sanitizeSpawnActivity accepts a valid block and caps last_hour at 20', () => {
  const raw = {
    live_sessions: 2,
    last_hour: Array.from({ length: 25 }, (_, i) => ({ path: `/w/${i}`, sessions: i + 1 })),
  }
  const out = sanitizeSpawnActivity(raw)
  assert.equal(out.live_sessions, 2)
  assert.equal(out.last_hour.length, 20)
  assert.deepEqual(out.last_hour[0], { path: '/w/0', sessions: 1 })
})

test('sanitizeSpawnActivity rejects malformed blocks whole', () => {
  assert.equal(sanitizeSpawnActivity(null), null)
  assert.equal(sanitizeSpawnActivity({ live_sessions: -1, last_hour: [] }), null)
  assert.equal(sanitizeSpawnActivity({ live_sessions: 1, last_hour: [{ path: '', sessions: 1 }] }), null)
  assert.equal(sanitizeSpawnActivity({ live_sessions: 1, last_hour: [{ path: '/ok', sessions: 0 }] }), null)
  assert.equal(sanitizeSpawnActivity({ live_sessions: 'x', last_hour: [] }), null)
})

test('sanitizeSpawnActivity flattens newlines in paths', () => {
  const out = sanitizeSpawnActivity({ live_sessions: 0, last_hour: [{ path: '/a\nb', sessions: 1 }] })
  assert.ok(!out.last_hour[0].path.includes('\n'))
})

test('sanitizeSpawnLimits accepts a valid block, caps lines at 12, drops malformed whole', () => {
  const line = { id: 'session', label: 'Session', percent: 39, resets: 'Aug 11, 1:00am (UTC)', resets_at: '2026-08-11T01:00:00.000Z' }
  const out = sanitizeSpawnLimits({ as_of: 123, lines: Array.from({ length: 15 }, () => ({ ...line })) })
  assert.equal(out.as_of, 123)
  assert.equal(out.lines.length, 12)
  assert.deepEqual(out.lines[0], line)
  assert.equal(sanitizeSpawnLimits({ as_of: 0, lines: [line] }), null)
  assert.equal(sanitizeSpawnLimits({ as_of: 1, lines: [{ ...line, percent: 'x' }] }), null)
  assert.equal(sanitizeSpawnLimits({ as_of: 1, lines: 'nope' }), null)
})

test('sanitizeSpawnLimits rejects an as_of beyond JS Date range (8.64e15ms) that would throw downstream', () => {
  const line = { id: 'session', label: 'Session', percent: 5 }
  assert.equal(sanitizeSpawnLimits({ as_of: 1e16, lines: [line] }), null)
  // The exact boundary is still accepted.
  assert.equal(sanitizeSpawnLimits({ as_of: 8640000000000000, lines: [line] }).as_of, 8640000000000000)
  // One past the boundary is rejected.
  assert.equal(sanitizeSpawnLimits({ as_of: 8640000000000001, lines: [line] }), null)
})

test('sanitizeSpawnLimits omits absent resets fields rather than nulling', () => {
  const out = sanitizeSpawnLimits({ as_of: 1, lines: [{ id: 'session', label: 'Session', percent: 5 }] })
  assert.ok(!('resets' in out.lines[0]) && !('resets_at' in out.lines[0]))
})

test('sanitizeSpawnLimits flattens control characters in resets_at like every other peer string', () => {
  const out = sanitizeSpawnLimits({
    as_of: 1,
    lines: [{ id: 'session', label: 'Session', percent: 5, resets_at: '2026-08-11T01\n:00:00.000Z' }],
  })
  assert.ok(!out.lines[0].resets_at.includes('\n'))
})

test('sanitizeSpawnDisk accepts sane byte counts, free == total included', () => {
  assert.deepEqual(sanitizeSpawnDisk({ free_bytes: 1024, total_bytes: 4096 }), { free_bytes: 1024, total_bytes: 4096 })
  assert.deepEqual(sanitizeSpawnDisk({ free_bytes: 4096, total_bytes: 4096 }), { free_bytes: 4096, total_bytes: 4096 })
  assert.deepEqual(sanitizeSpawnDisk({ free_bytes: 0, total_bytes: 4096 }), { free_bytes: 0, total_bytes: 4096 })
  // Extra fields do not survive — the return is rebuilt, not passed through.
  assert.deepEqual(sanitizeSpawnDisk({ free_bytes: 1, total_bytes: 2, mount: '/etc\npasswd' }), { free_bytes: 1, total_bytes: 2 })
})

test('sanitizeSpawnDisk rejects malformed blocks whole', () => {
  assert.equal(sanitizeSpawnDisk(null), null)
  assert.equal(sanitizeSpawnDisk('41G free'), null)
  assert.equal(sanitizeSpawnDisk([]), null)
  assert.equal(sanitizeSpawnDisk({ free_bytes: -1, total_bytes: 4096 }), null)
  assert.equal(sanitizeSpawnDisk({ free_bytes: 1, total_bytes: 0 }), null)
  assert.equal(sanitizeSpawnDisk({ free_bytes: 9, total_bytes: 4 }), null)             // free > total
  assert.equal(sanitizeSpawnDisk({ free_bytes: 1.5, total_bytes: 4096 }), null)        // fractional bytes
  assert.equal(sanitizeSpawnDisk({ free_bytes: '1024', total_bytes: 4096 }), null)     // stringly numbers
  assert.equal(sanitizeSpawnDisk({ free_bytes: 2 ** 60, total_bytes: 2 ** 61 }), null) // isInteger-true, isSafeInteger-false
})
