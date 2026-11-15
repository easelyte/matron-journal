// The versioned conformance artifact.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { packConformance } from '../tools/conformance/pack.js'

test('the artifact holds fixtures, schema, extracts, key table and a manifest whose hashes match', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-pack-test-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const tgz = await packConformance(path.join(tmp, 'out'), { verify: false })
  assert.match(path.basename(tgz), /^matron-journal-conformance-\d+\.\d+\.\d+.*\.tgz$/)
  const x = path.join(tmp, 'x')
  fs.mkdirSync(x)
  const r = spawnSync('tar', ['-xzf', tgz, '-C', x], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const root = path.join(x, fs.readdirSync(x)[0])
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  assert.equal(manifest.name, 'matron-journal-conformance')
  assert.ok(Number.isInteger(manifest.protocol) && manifest.protocol >= 1)
  const paths = manifest.files.map((f) => f.path)
  assert.ok(paths.includes('01_login.json'))
  assert.ok(paths.includes('schema/fixture.schema.json'))
  assert.ok(paths.includes('keys/message-box.json'))
  assert.ok(paths.some((p) => p.startsWith('payloads/ws.journal.')))
  assert.ok(paths.includes('README.md'))
  for (const f of manifest.files) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f.path))).digest('hex')
    assert.equal(h, f.sha256, f.path)
  }
})
