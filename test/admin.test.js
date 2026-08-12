import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { openDb, insertBlob } from '../src/db.js'
import { authToken, createUser, createAgent, login, authorizeAgentWrite } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { resolveMediaDir, writeBlobSync } from '../src/media.js'
import { runAdmin, parseExpiresSeconds } from '../bin/matron-admin.js'
import { startTestServer } from './helpers.js'
import { parkInvite, answerParkedInvite, answerInvite, getParticipant } from '../src/participants.js'

test('admin CLI: user add, agent add, status', async () => {
  const db = openDb(':memory:')
  const out1 = await runAdmin(db, ['user', 'add', 'dan', '--password', 'pw123'])
  assert.match(out1, /user dan created/)
  await assert.rejects(runAdmin(db, ['user', 'add', 'dan', '--password', 'pw123']), /UNIQUE/)

  const out2 = await runAdmin(db, ['agent', 'add', 'dan', 'dev-2'])
  const token = out2.match(/token: ([0-9a-f]{64})/)[1]
  assert.equal(authToken(db, token).kind, 'agent')

  const out3 = await runAdmin(db, ['user', 'passwd', 'dan', '--password', 'newpw'])
  assert.match(out3, /password updated/)

  const status = await runAdmin(db, ['status'])
  assert.match(status, /dan devices=0 agents=1 head_seq=0/)

  await assert.rejects(runAdmin(db, ['bogus']), /usage/i)
})

test('admin CLI: user add/passwd take the password off argv (--password-stdin, MATRON_PASSWORD)', async () => {
  const db = openDb(':memory:')

  // --password-stdin: the password arrives on stdin, never in argv
  const addOut = await runAdmin(db, ['user', 'add', 'ann', '--password-stdin'],
    { readStdin: async () => 'stdin-secret\n' })
  assert.match(addOut, /user ann created/)
  // the exact value logs in; the single trailing newline (from `echo`) was
  // stripped, so it is NOT part of the stored password
  assert.ok(await login(db, { username: 'ann', password: 'stdin-secret', deviceName: 'm' }))
  assert.equal(await login(db, { username: 'ann', password: 'stdin-secret\n', deviceName: 'm2' }), null)

  // MATRON_PASSWORD env fallback (deps.env keeps it out of the real process env)
  const bobOut = await runAdmin(db, ['user', 'add', 'bob'], { env: { MATRON_PASSWORD: 'env-secret' } })
  assert.match(bobOut, /user bob created/)
  assert.ok(await login(db, { username: 'bob', password: 'env-secret', deviceName: 'm' }))

  // user passwd via stdin rotates the password
  const pwOut = await runAdmin(db, ['user', 'passwd', 'ann', '--password-stdin'],
    { readStdin: async () => 'rotated\n' })
  assert.match(pwOut, /password updated for ann/)
  assert.ok(await login(db, { username: 'ann', password: 'rotated', deviceName: 'm3' }))

  // precedence: --password-stdin wins over a --password flag on argv
  const carolOut = await runAdmin(db, ['user', 'add', 'carol', '--password', 'FROM-ARGV', '--password-stdin'],
    { readStdin: async () => 'FROM-STDIN' })
  assert.match(carolOut, /user carol created/)
  assert.ok(await login(db, { username: 'carol', password: 'FROM-STDIN', deviceName: 'm' }))
  assert.equal(await login(db, { username: 'carol', password: 'FROM-ARGV', deviceName: 'm2' }), null)

  // no password source at all → usage (unchanged behavior)
  await assert.rejects(runAdmin(db, ['user', 'add', 'nopw']), /usage/i)
  await assert.rejects(runAdmin(db, ['user', 'passwd', 'ann']), /usage/i)

  db.close()
})

test('admin CLI: offload runs runOffload with --days (default 30), second run no-ops, bad --days rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-admin-offload-'))
  const dbPath = path.join(dir, 'cli.db')
  const db = openDb(dbPath)
  const dan = await createUser(db, 'dan', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id })
  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload: { snippet: 'old output' } })
  db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - 40 * 86400000, dan.id, r.seq)

  const out = await runAdmin(db, ['offload', '--days', '30'])
  assert.match(out, /offloaded 1 tool_output payload/)
  const row = db.prepare('SELECT blob_ref FROM events WHERE user_id=? AND seq=?').get(dan.id, r.seq)
  assert.ok(row.blob_ref)

  const out2 = await runAdmin(db, ['offload', '--days', '30'])
  assert.match(out2, /offloaded 0 tool_output payload/)

  await assert.rejects(runAdmin(db, ['offload', '--days', 'abc']), /usage/i)

  // no --days at all defaults to 30
  const out3 = await runAdmin(db, ['offload'])
  assert.match(out3, /older than 30d/)

  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('admin CLI: offload --days 0 (or negative) refuses instead of offloading everything (cutoff would be now/future)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-admin-offload-zero-'))
  const dbPath = path.join(dir, 'cli.db')
  const db = openDb(dbPath)
  const dan = await createUser(db, 'dan', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id })
  // A brand-new row — `--days 0` computes cutoff=now, so a buggy
  // pass-through would offload even this.
  append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload: { snippet: 'brand new' } })

  await assert.rejects(runAdmin(db, ['offload', '--days', '0']), /positive integer/i)
  await assert.rejects(runAdmin(db, ['offload', '--days', '-5']), /positive integer/i)
  await assert.rejects(runAdmin(db, ['offload', '--days', 'garbage']), /positive integer/i)

  assert.equal(db.prepare('SELECT COUNT(*) n FROM events WHERE blob_ref IS NOT NULL').get().n, 0, 'nothing should have been offloaded by a refused --days value')

  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('admin CLI: expire-logs deletes old live_log blobs and reports the count', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-admin-expire-logs-'))
  const dbPath = path.join(dir, 'cli.db')
  const db = openDb(dbPath)
  const dan = await createUser(db, 'dan', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id })
  const mediaDir = resolveMediaDir(dbPath) // matches what the CLI resolves internally from db.name
  const blob = writeBlobSync(mediaDir, Buffer.from('log', 'utf8'))
  insertBlob(db, { id: blob.id, ownerUserId: dan.id, contentType: 'text/plain', size: blob.size, sha256: blob.sha256, diskPath: blob.diskPath })
  const r0 = append(db, {
    userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'tool_output',
    payload: { snippet: 't', blob_ref: blob.id, live_log: true }, blobRef: blob.id,
  })
  db.prepare('UPDATE events SET ts=? WHERE user_id=? AND seq=?').run(Date.now() - 48 * 3600000, dan.id, r0.seq)

  const out = await runAdmin(db, ['expire-logs', '--hours', '24'])
  assert.match(out, /purged 1 live_log payload\(s\) older than 24h/)

  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('admin CLI: expire-logs rejects a non-positive --hours', async () => {
  const db = openDb(':memory:')
  await assert.rejects(runAdmin(db, ['expire-logs', '--hours', '0']), /positive integer/i)
  await assert.rejects(runAdmin(db, ['expire-logs', '--hours', '-5']), /positive integer/i)
  await assert.rejects(runAdmin(db, ['expire-logs', '--hours', 'garbage']), /positive integer/i)
  db.close()
})

test('admin CLI: status prints per-device kind/cursor/lag/last_seen_at and db file size (DB-derived only, no socket/APNs counters)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-admin-status-'))
  const dbPath = path.join(dir, 'cli.db')
  const db = openDb(dbPath)
  const dan = await createUser(db, 'dan', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id })
  append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })
  const login = await import('../src/auth.js').then((m) => m.login(db, { username: 'dan', password: 'pw', deviceName: 'mac' }))
  db.prepare('UPDATE devices SET cursor=? WHERE id=?').run(0, login.deviceId)

  const status = await runAdmin(db, ['status'])
  assert.match(status, /dan devices=1 agents=0 head_seq=1/)
  assert.match(status, new RegExp(`device ${login.deviceId} kind=client cursor=0 lag=1 last_seen_at=`))
  assert.match(status, /total events: 1/)
  assert.match(status, /db file size: \d+/)

  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('admin CLI: device list and device revoke', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const s = await login(db, { username: 'dan', password: 'pw', deviceName: 'mac' })
  const { token: agentToken, deviceId: agentDeviceId } = createAgent(db, dan.id, 'bridge')

  await assert.rejects(runAdmin(db, ['device', 'list', 'ghost']), /no such user: ghost/)

  const listOut = await runAdmin(db, ['device', 'list', 'dan'])
  assert.match(listOut, new RegExp(`${s.deviceId} kind=client name=mac cursor=0 last_seen_at=`))
  assert.match(listOut, new RegExp(`${agentDeviceId} kind=agent name=bridge cursor=0 last_seen_at=`))

  await assert.rejects(runAdmin(db, ['device', 'revoke', '999999']), /no such device: 999999/)
  await assert.rejects(runAdmin(db, ['device', 'revoke', 'not-a-number']), /usage/i)

  const revokeOut = await runAdmin(db, ['device', 'revoke', String(agentDeviceId)])
  assert.match(revokeOut, new RegExp(`device ${agentDeviceId} revoked`))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM devices WHERE id=?').get(agentDeviceId).n, 0)
  assert.equal(authToken(db, agentToken), null)

  const listAfter = await runAdmin(db, ['device', 'list', 'dan'])
  assert.ok(!listAfter.includes(`${agentDeviceId} kind=agent`))
  assert.match(listAfter, new RegExp(`${s.deviceId} kind=client`)) // the un-revoked device is untouched

  const noUser = await createUser(db, 'lonely', 'pw')
  const noneOut = await runAdmin(db, ['device', 'list', 'lonely'])
  assert.match(noneOut, /no devices/i)

  db.close()
})

// The CLI revoke used to be a bare DELETE on devices while the HTTP route
// cleaned up convo_agents alongside it, so the same command by a different
// door left the membership row standing — and `devices.id` is a plain INTEGER
// PRIMARY KEY, so the next agent created lands on exactly the revoked id and
// inherited its room. "Retire an agent, register its replacement" is the
// ordinary sequence that hits this.
test('admin CLI: device revoke clears room membership, so a reused id inherits nothing', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const owner = createAgent(db, dan.id, 'owner-agent')
  const doomed = createAgent(db, dan.id, 'doomed-agent')
  upsertConversation(db, { id: 'room1', ownerUserId: dan.id, title: 'Ops Room', agentDeviceId: owner.deviceId })
  parkInvite(db, { convoId: 'room1', agentDeviceId: doomed.deviceId, initiatorDeviceId: owner.deviceId })
  answerParkedInvite(db, { convoId: 'room1', agentDeviceId: doomed.deviceId, approve: true })
  answerInvite(db, { convoId: 'room1', agentDeviceId: doomed.deviceId, accept: true })
  assert.equal(authorizeAgentWrite(db, dan.id, doomed.deviceId, 'room1'), true, 'precondition: it could write')

  await runAdmin(db, ['device', 'revoke', String(doomed.deviceId)])
  assert.equal(getParticipant(db, 'room1', doomed.deviceId), null, 'the membership row goes with the device')

  const fresh = createAgent(db, dan.id, 'replacement-agent')
  assert.equal(fresh.deviceId, doomed.deviceId, 'precondition: SQLite reused the id')
  assert.equal(authorizeAgentWrite(db, dan.id, fresh.deviceId, 'room1'), false, 'the replacement starts from nothing')

  db.close()
})

test('admin CLI: agent-chat pending/approve prints room+topic and the sweep-delivery note', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const owner = createAgent(db, dan.id, 'owner-agent') // room owner, and the invite's initiator
  const target = createAgent(db, dan.id, 'target-agent') // the invited device
  upsertConversation(db, { id: 'room1', ownerUserId: dan.id, title: 'Ops Room', agentDeviceId: owner.deviceId })
  parkInvite(db, {
    convoId: 'room1', agentDeviceId: target.deviceId, initiatorDeviceId: owner.deviceId,
    justification: 'need a hand', topic: 'deploy',
  })

  const pendingOut = await runAdmin(db, ['agent-chat', 'pending', 'dan'])
  assert.match(pendingOut, /room1/)
  assert.match(pendingOut, /topic: deploy/)
  assert.match(pendingOut, /need a hand/)
  assert.match(pendingOut, new RegExp(`device ${target.deviceId} \\(target-agent\\)`))

  const approveOut = await runAdmin(db, ['agent-chat', 'approve', 'dan', 'room1', String(target.deviceId)])
  assert.match(approveOut, /invited/)
  // Both facts the CLI cannot make happen itself must be said, per the brief.
  assert.match(approveOut, /sweep/i)
  assert.match(approveOut, /hub/i)

  const row = getParticipant(db, 'room1', target.deviceId)
  assert.equal(row.state, 'invited')
  assert.equal(row.delivered_at, null) // delivery is the pump's job, not this command's

  db.close()
})

test('admin CLI: agent-chat approve rejects --always-allow rather than silently approving (the flag no longer exists)', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const owner = createAgent(db, dan.id, 'owner-agent')
  const target = createAgent(db, dan.id, 'target-agent')
  upsertConversation(db, { id: 'room1', ownerUserId: dan.id, title: 'Ops Room', agentDeviceId: owner.deviceId })
  parkInvite(db, {
    convoId: 'room1', agentDeviceId: target.deviceId, initiatorDeviceId: owner.deviceId,
    justification: 'need a hand', topic: 'deploy',
  })

  await assert.rejects(
    runAdmin(db, ['agent-chat', 'approve', 'dan', 'room1', String(target.deviceId), '--always-allow']),
    /--always-allow/
  )

  // rejected outright — not silently approved, and not left in some
  // half-applied state.
  const row = getParticipant(db, 'room1', target.deviceId)
  assert.equal(row.state, 'awaiting_user')

  db.close()
})

test('admin CLI: agent-chat deny flips to denied and says the requester cannot be told directly', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const owner = createAgent(db, dan.id, 'owner-agent')
  const target = createAgent(db, dan.id, 'target-agent')
  upsertConversation(db, { id: 'room1', ownerUserId: dan.id, title: 'Ops Room', agentDeviceId: owner.deviceId })
  parkInvite(db, {
    convoId: 'room1', agentDeviceId: target.deviceId, initiatorDeviceId: owner.deviceId,
    justification: 'need a hand', topic: 'deploy',
  })

  const denyOut = await runAdmin(db, ['agent-chat', 'deny', 'dan', 'room1', String(target.deviceId)])
  assert.match(denyOut, /denied/)
  assert.match(denyOut, /times out to pending/)

  const row = getParticipant(db, 'room1', target.deviceId)
  assert.equal(row.state, 'denied')

  db.close()
})

test('admin CLI: agent-chat approve/deny reject a row that belongs to another user\'s room', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const eve = await createUser(db, 'eve', 'pw')
  const owner = createAgent(db, dan.id, 'owner-agent')
  const target = createAgent(db, dan.id, 'target-agent')
  upsertConversation(db, { id: 'room1', ownerUserId: dan.id, title: 'Ops Room', agentDeviceId: owner.deviceId })
  parkInvite(db, {
    convoId: 'room1', agentDeviceId: target.deviceId, initiatorDeviceId: owner.deviceId,
    justification: 'need a hand', topic: 'deploy',
  })

  await assert.rejects(runAdmin(db, ['agent-chat', 'approve', 'eve', 'room1', String(target.deviceId)]), /no agent-chat request/)
  await assert.rejects(runAdmin(db, ['agent-chat', 'deny', 'eve', 'room1', String(target.deviceId)]), /no agent-chat request/)
  // untouched by the rejected attempts
  assert.equal(getParticipant(db, 'room1', target.deviceId).state, 'awaiting_user')

  db.close()
})

test('admin CLI: the agent-chat allowances subcommand is gone', async () => {
  const db = openDb(':memory:')
  await createUser(db, 'dan', 'pw')
  await assert.rejects(runAdmin(db, ['agent-chat', 'allowances', 'dan']))
})

test('admin CLI: agent-chat pending/approve/deny with an unknown username exits non-zero', async () => {
  const db = openDb(':memory:')
  await assert.rejects(runAdmin(db, ['agent-chat', 'pending', 'ghost']), /no such user: ghost/)
  await assert.rejects(runAdmin(db, ['agent-chat', 'approve', 'ghost', 'room1', '2']), /no such user: ghost/)
  await assert.rejects(runAdmin(db, ['agent-chat', 'deny', 'ghost', 'room1', '2']), /no such user: ghost/)
  db.close()
})

test('admin CLI: agent-chat pending says so when nothing is awaiting', async () => {
  const db = openDb(':memory:')
  await createUser(db, 'dan', 'pw')
  const out = await runAdmin(db, ['agent-chat', 'pending', 'dan'])
  assert.match(out, /no agent-chat requests awaiting approval/)
  db.close()
})

test('link-code: prints a QR + manual fallback whose code signs a claimant in with no tap', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')

  const out = await runAdmin(s.db, ['link-code', 'dan', '--server-url', 'https://chat.example.com', '--port', String(s.port)])
  const code = out.match(/code:\s+([0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4})/)?.[1]
  assert.ok(code, `expected a dashed code in output:\n${out}`)
  assert.match(out, /server:\s+https:\/\/chat\.example\.com/)
  assert.ok(out.includes(`matron://link?v=1&server=${encodeURIComponent('https://chat.example.com')}&code=${code}`))
  assert.match(out, /▄|█/) // an ANSI QR actually rendered

  // the printed code really is pre-approved: claim → first poll mints the device
  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: code, device_name: 'First Phone' } })
  assert.equal(claim.status, 200)
  const poll = await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })
  assert.equal(poll.json.status, 'approved')
  assert.equal(poll.json.username, 'dan')
})

test('link-code: unknown user and unreachable journal produce actionable errors', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await assert.rejects(
    () => runAdmin(s.db, ['link-code', 'nobody', '--server-url', 'https://x.example.com', '--port', String(s.port)]),
    /no such user/
  )
  await assert.rejects(
    () => runAdmin(s.db, ['link-code', 'dan', '--server-url', 'https://x.example.com', '--port', '1']),
    /not reachable/
  )
  await assert.rejects(
    () => runAdmin(s.db, ['link-code', 'dan', '--server-url', 'not a url', '--port', String(s.port)]),
    /--server-url/
  )
  await assert.rejects(() => runAdmin(s.db, ['link-code']), /usage/)
})

test('link-code: 404 message is honest about covering both "unknown user" and "guard refused" (indistinguishable on the wire)', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')
  await assert.rejects(
    () => runAdmin(s.db, ['link-code', 'nobody', '--server-url', 'https://x.example.com', '--port', String(s.port)]),
    (e) => {
      assert.match(e.message, /no such user "nobody"/)
      assert.match(e.message, /refused the request as non-local/)
      assert.match(e.message, /journal host itself/)
      return true
    }
  )
})

test('link-code: reads the preapprove key file next to the DB and sends it as x-preapprove-key', async (t) => {
  // Stand-in journal that just records the header it received, rather than
  // exercising the real guard — isolates "did the CLI read the right file
  // and send the right header" from the server-side guard logic (already
  // covered by test/link-http.test.js).
  let seenKey
  const fake = http.createServer((req, res) => {
    seenKey = req.headers['x-preapprove-key']
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ link_code: 'ABCD-EFGH', expires_in: 600 }))
  })
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
  t.after(() => fake.close())

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-admin-preapprove-'))
  const dbPath = path.join(dir, 'cli.db')
  const db = openDb(dbPath)
  const keyPath = path.join(dir, 'preapprove.key')
  fs.writeFileSync(keyPath, 'a'.repeat(64), { mode: 0o600 })

  const out = await runAdmin(db, ['link-code', 'dan', '--server-url', 'https://chat.example.com', '--port', String(fake.address().port)])
  assert.match(out, /code:\s+ABCD-EFGH/)
  assert.equal(seenKey, 'a'.repeat(64))

  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('link-code: an unreadable preapprove key file (missing, or wrong permissions) fails with a friendly, actionable error', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-admin-preapprove-unreadable-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'cli.db')
  const db = openDb(dbPath)
  const keyPath = path.join(dir, 'preapprove.key')

  // Missing entirely (ENOENT) — no server has ever booted against this DB.
  await assert.rejects(
    () => runAdmin(db, ['link-code', 'dan', '--server-url', 'https://chat.example.com', '--port', '9810']),
    (e) => {
      assert.match(e.message, /cannot read the pre-approve key/)
      assert.ok(e.message.includes(keyPath), `expected the path ${keyPath} to be named in:\n${e.message}`)
      assert.match(e.message, /journal host/)
      return true
    }
  )

  // Present but unreadable (EACCES) — wrong owner/permissions, e.g. the CLI
  // running as a different user than the journal service. Deliberately no
  // permission restore before cleanup: unlink is governed by the parent
  // directory's write permission, not the file's own mode, so rmSync above
  // (in the first-registered t.after) can still remove it.
  fs.writeFileSync(keyPath, 'a'.repeat(64), { mode: 0o000 })
  if (process.getuid && process.getuid() === 0) {
    // root ignores file permissions — nothing meaningful to assert here.
  } else {
    await assert.rejects(
      () => runAdmin(db, ['link-code', 'dan', '--server-url', 'https://chat.example.com', '--port', '9810']),
      /cannot read the pre-approve key/
    )
  }

  db.close()
})

test('link-code: --port abc (non-integer) hits the --port guard', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')
  await assert.rejects(
    () => runAdmin(s.db, ['link-code', 'dan', '--server-url', 'https://x.example.com', '--port', 'abc']),
    /--port/
  )
})

test('link-code: --server-url validation matches the apps\' stance (https any host, http localhost-only, max 200 chars)', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')

  // http to localhost-ish hosts is accepted and proceeds to the HTTP call
  const outLocalhost = await runAdmin(s.db, ['link-code', 'dan', '--server-url', 'http://localhost:9810', '--port', String(s.port)])
  assert.match(outLocalhost, /server:\s+http:\/\/localhost:9810/)

  const outLoopback = await runAdmin(s.db, ['link-code', 'dan', '--server-url', 'http://127.0.0.1:9810', '--port', String(s.port)])
  assert.match(outLoopback, /server:\s+http:\/\/127\.0\.0\.1:9810/)

  // http to a non-loopback host is rejected
  await assert.rejects(
    () => runAdmin(s.db, ['link-code', 'dan', '--server-url', 'http://evil.example.com', '--port', String(s.port)]),
    /--server-url/
  )

  // an overlong https URL is rejected even though the protocol is fine
  const longUrl = `https://chat.example.com/${'a'.repeat(200)}`
  assert.ok(longUrl.length > 200)
  await assert.rejects(
    () => runAdmin(s.db, ['link-code', 'dan', '--server-url', longUrl, '--port', String(s.port)]),
    /--server-url/
  )
})

test('link-code: missing expires_in in the journal response is not printed as "NaN minutes"', async (t) => {
  // A stand-in for the journal that answers /link/preapprove without an
  // expires_in field, e.g. an older or nonstandard journal build.
  const fake = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ link_code: 'ABCD-EFGH' }))
  })
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
  t.after(() => fake.close())

  const db = openDb(':memory:')
  const out = await runAdmin(db, ['link-code', 'dan', '--server-url', 'https://chat.example.com', '--port', String(fake.address().port)])
  assert.ok(!/NaN/.test(out), `expected no "NaN" in output:\n${out}`)
  assert.match(out, /code:\s+ABCD-EFGH/)
})

test('parseExpiresSeconds: Nm/Nh within 1m-24h, null otherwise', () => {
  assert.equal(parseExpiresSeconds('30m'), 1800)
  assert.equal(parseExpiresSeconds('1m'), 60)
  assert.equal(parseExpiresSeconds('24h'), 86400)
  assert.equal(parseExpiresSeconds('2h'), 7200)
  for (const bad of ['0m', '25h', '1441m', 'bananas', '90', 'h', '', null, '1d', '-5m', '1.5h']) {
    assert.equal(parseExpiresSeconds(bad), null, JSON.stringify(bad))
  }
})

test('link-code --expires: sends ttl_seconds and prints the expiry in hours', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')
  const out = await runAdmin(s.db, ['link-code', 'dan', '--server-url', 'https://chat.example.com', '--port', String(s.port), '--expires', '24h'])
  assert.match(out, /expires in 24 hours and works once/)
  // the minted code really carries the long TTL
  const code = out.match(/code:\s+([0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4})/)?.[1]
  assert.ok(code, `expected a dashed code in output:\n${out}`)
  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: code, device_name: 'p' } })
  assert.equal(claim.status, 200)
})

test('link-code --expires: invalid duration fails with usage before any network call', async (t) => {
  const db = openDb(':memory:')
  // port 1 is unreachable — if the CLI tried the network first we would see
  // "not reachable" instead of the --expires usage error
  for (const bad of ['25h', '0m', 'bananas']) {
    await assert.rejects(
      () => runAdmin(db, ['link-code', 'dan', '--server-url', 'https://x.example.com', '--port', '1', '--expires', bad]),
      /--expires/
    )
  }
  db.close()
})

test('CLI entrypoint works directly and via symlink (npx-style)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-admin-'))
  const dbPath = path.join(dir, 'cli.db')
  const env = { ...process.env, MATRON_DB: dbPath }
  const real = path.resolve('bin/matron-admin.js')

  const direct = execFileSync(process.execPath, [real, 'status'], { env }).toString()
  assert.match(direct, /total events: 0/)

  const link = path.join(dir, 'matron-admin-link.js')
  fs.symlinkSync(real, link)
  const viaLink = execFileSync(process.execPath, [link, 'status'], { env }).toString()
  assert.match(viaLink, /total events: 0/)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('link-code --png: writes a 0600 PNG, prints scp+rm hints, suppresses the ANSI QR', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-admin-png-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pngPath = path.join(dir, 'link.png')

  const out = await runAdmin(s.db, ['link-code', 'dan', '--server-url', 'https://chat.example.com', '--port', String(s.port), '--expires', '24h', '--png', pngPath])

  const buf = fs.readFileSync(pngPath)
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]) // PNG magic
  assert.equal(fs.statSync(pngPath).mode & 0o777, 0o600)
  assert.match(out, /scp .*link\.png/)
  assert.match(out, /rm .*link\.png/)
  assert.match(out, /treat it like a password/)
  assert.match(out, /expires in 24 hours/)
  assert.doesNotMatch(out, /▄|█/) // no ANSI QR in file mode

  // the manual-entry fallback still carries a working code
  const code = out.match(/code:\s+([0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4})/)?.[1]
  assert.ok(code, `expected a dashed code in output:\n${out}`)
  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: code, device_name: 'p' } })
  assert.equal(claim.status, 200)
})

test('link-code --png: pre-mint failure removes the truncated file and leaks no fd', async (t) => {
  const db = openDb(':memory:')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-admin-png-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pngPath = path.join(dir, 'link.png')
  fs.writeFileSync(pngPath, 'stale contents from a previous run')

  // port 1: fd opens (truncating the file) but the mint never succeeds.
  await assert.rejects(
    () => runAdmin(db, ['link-code', 'dan', '--server-url', 'https://x.example.com', '--port', '1', '--png', pngPath]),
    /journal not reachable/
  )

  assert.equal(fs.existsSync(pngPath), false, 'truncated PNG file should be removed on failure')
  db.close()
})

test('link-code --png: post-mint render failure still prints the manual-entry code', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await createUser(s.db, 'dan', 'hunter22')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-admin-png-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pngPath = path.join(dir, 'link.png')

  const out = await runAdmin(
    s.db,
    ['link-code', 'dan', '--server-url', 'https://chat.example.com', '--port', String(s.port), '--png', pngPath],
    { renderPng: async () => { throw new Error('encoder exploded') } }
  )

  // The code is already live and single-use — it must reach the operator.
  assert.match(out, /could not write the qr png/i)
  assert.match(out, /server: https:\/\/chat\.example\.com/)
  const code = out.match(/code:\s+([0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4})/)?.[1]
  assert.ok(code, `expected a dashed code in output:\n${out}`)
  assert.equal(fs.existsSync(pngPath), false, 'failed PNG should not leave an empty file behind')

  // ...and the printed code actually works.
  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: code, device_name: 'p' } })
  assert.equal(claim.status, 200)
})

test('link-code --png: unwritable path fails before minting (unreachable port never contacted)', async (t) => {
  const db = openDb(':memory:')
  await assert.rejects(
    () => runAdmin(db, ['link-code', 'dan', '--server-url', 'https://x.example.com', '--port', '1', '--png', '/nonexistent-dir/never/link.png']),
    /cannot write --png file/
  )
  await assert.rejects(
    () => runAdmin(db, ['link-code', 'dan', '--server-url', 'https://x.example.com', '--port', '1', '--png']),
    /--png needs a file path/
  )
  db.close()
})

test('device private: on pins private, off pins visible, auto releases the pin', async () => {
  const db = openDb(':memory:')
  const u = await createUser(db, 'dan', 'pw')
  const a = createAgent(db, u.id, 'kit')
  const out = await runAdmin(db, ['device', 'private', String(a.deviceId), 'on'])
  assert.match(out, /private/)
  assert.deepEqual(db.prepare('SELECT private, private_pinned FROM devices WHERE id=?').get(a.deviceId), { private: 1, private_pinned: 1 })
  await runAdmin(db, ['device', 'private', String(a.deviceId), 'off'])
  assert.deepEqual(db.prepare('SELECT private, private_pinned FROM devices WHERE id=?').get(a.deviceId), { private: 0, private_pinned: 1 })
  const auto = await runAdmin(db, ['device', 'private', String(a.deviceId), 'auto'])
  assert.match(auto, /bridge|hello|env/i, 'output explains the flag now follows the bridge')
  assert.equal(db.prepare('SELECT private_pinned FROM devices WHERE id=?').get(a.deviceId).private_pinned, 0)
  db.close()
})

test('device private: unknown device and bad mode are refused', async () => {
  const db = openDb(':memory:')
  await assert.rejects(() => runAdmin(db, ['device', 'private', '999', 'on']), /no such device/)
  const u = await createUser(db, 'dan', 'pw')
  const a = createAgent(db, u.id, 'kit')
  await assert.rejects(() => runAdmin(db, ['device', 'private', String(a.deviceId), 'maybe']), /usage/i)
  db.close()
})

test('device list: shows the private flag and its pin state', async () => {
  const db = openDb(':memory:')
  const u = await createUser(db, 'dan', 'pw')
  const a = createAgent(db, u.id, 'kit')
  await runAdmin(db, ['device', 'private', String(a.deviceId), 'on'])
  const out = await runAdmin(db, ['device', 'list', 'dan'])
  assert.match(out, /private=yes \(pinned\)/)
  db.close()
})
