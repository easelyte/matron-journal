import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, insertBlob } from '../src/db.js'
import { authToken, createUser, createAgent, login } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { resolveMediaDir, writeBlobSync } from '../src/media.js'
import { runAdmin } from '../bin/matron-admin.js'
import { startTestServer } from './helpers.js'

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
