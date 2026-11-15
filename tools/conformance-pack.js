#!/usr/bin/env node
// Build the versioned conformance artifact:
//   node tools/conformance-pack.js [--out DIR]     (default: ./dist)
// The tarball holds the fixtures, schema, decoder extracts, key table and a
// manifest with the protocol revision and a hash of every file. Attach it to a
// release; a client pins that release.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { packConformance } from './conformance/pack.js'

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out')
  packConformance(i >= 0 ? process.argv[i + 1] : 'dist').then(
    (p) => { console.error(p); process.exit(0) },
    (e) => { console.error(e.message); process.exit(1) },
  )
}
