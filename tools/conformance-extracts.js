#!/usr/bin/env node
// Generates (or checks) the decoder extracts in test/fixtures/conformance/payloads/
// from the fixtures. A build step, not a sync script: the extracts are derived,
// never edited by hand.
//
//   node tools/conformance-extracts.js           write payloads/*.json
//   node tools/conformance-extracts.js --check   exit 1 if payloads/ differs from a fresh generation
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateExtracts, readCommitted, diffExtracts, writeExtracts } from './conformance/extracts.js'

async function main() {
  const check = process.argv.includes('--check')
  const fresh = await generateExtracts()
  if (check) {
    const diff = diffExtracts(fresh, readCommitted())
    if (diff.length) {
      console.error(`payloads/ is out of date (${diff.join(', ')}). Run: node tools/conformance-extracts.js`)
      process.exit(1)
    }
    console.error(`payloads/ is up to date (${fresh.size} extracts)`)
    return
  }
  writeExtracts(fresh)
  console.error(`wrote ${fresh.size} extracts`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
}
