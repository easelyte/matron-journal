// Packages the conformance suite as one versioned artifact: fixtures, schema,
// decoder extracts and the key table, with a manifest of file hashes. Clients
// pin a version of this artifact (a release of this repository) and replay it.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { CONFORMANCE_DIR } from './schema.js'
import { generateExtracts, readCommitted, diffExtracts } from './extracts.js'

const ROOT = path.resolve(CONFORMANCE_DIR, '..', '..', '..')

function walk(dir, base = dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, base))
    else out.push(path.relative(base, p).split(path.sep).join('/'))
  }
  return out
}

export function buildManifest(dir, version) {
  const files = walk(dir).filter((f) => f !== 'manifest.json')
  let protocol = 1
  for (const f of files) {
    if (/^[^/]+\.json$/.test(f) && f !== 'manifest.json') {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (Number.isInteger(doc.protocol)) protocol = Math.max(protocol, doc.protocol)
    }
  }
  return {
    name: 'matron-journal-conformance',
    version,
    protocol,
    files: files.map((f) => ({ path: f, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex') })),
  }
}

// Refuses when payloads/ is out of date (verify: false skips that check).
// Writes <outDir>/matron-journal-conformance-<version>.tgz and returns its path.
export async function packConformance(outDir, { verify = true } = {}) {
  const diff = verify ? diffExtracts(await generateExtracts(), readCommitted()) : []
  if (diff.length) throw new Error(`payloads/ is out of date (${diff.join(', ')}); run: node tools/conformance-extracts.js`)
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  const name = `matron-journal-conformance-${version}`
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-conformance-pack-'))
  try {
    const dest = path.join(stage, name)
    fs.cpSync(CONFORMANCE_DIR, dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(buildManifest(dest, version), null, 2) + '\n')
    fs.mkdirSync(outDir, { recursive: true })
    const out = path.resolve(outDir, `${name}.tgz`)
    const r = spawnSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', out, '-C', stage, name], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`)
    return out
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}
