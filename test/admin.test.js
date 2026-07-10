import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { authToken } from '../src/auth.js'
import { runAdmin } from '../bin/matron-admin.js'

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
