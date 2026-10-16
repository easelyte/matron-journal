#!/usr/bin/env node
// Offline hit@k for /search/all. Reads a PRIVATE query file (never commit
// one to this repo).
// Usage: node tools/search-eval.js --db path/to/copy.db --user 1 --queries file.json [--semantic]

// WARNING: openDb() runs migrations on the database. The --db path MUST be a
// COPY of a production database, never the live server file. Passing the live
// database will modify it in place.

import { openDb } from '../src/db.js'
import { searchAll } from '../src/search-all.js'
import { loadEmbedder } from '../src/embedder.js'
import { ensureVectorSchema, runVectorIndexer, createVectorStore } from '../src/vector-index.js'
import fs from 'node:fs'
import path from 'node:path'

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }

// Check for required arguments
const dbPath = arg('db')
const userArg = arg('user')
const queriesPath = arg('queries')

if (!dbPath || !userArg || !queriesPath) {
  console.error('Usage: node tools/search-eval.js --db path/to/copy.db --user 1 --queries file.json [--semantic]')
  process.exit(2)
}

// Refuse to run if the db path is the default production database name
const dbBasename = path.basename(dbPath)
if (dbBasename === 'matron.db') {
  console.error(`Error: refusing to run against ${dbBasename} (the live server database). Use a copy instead.`)
  process.exit(2)
}

const db = openDb(dbPath)
const userId = Number(userArg)

// File shape: { queries: [{q, targets}], exact_probes: [{q, targets}], unrelated_probes: [string] }
const file = JSON.parse(fs.readFileSync(queriesPath, 'utf8'))
const queries = file.queries

let similar = null
let useSemantic = false

if (process.argv.includes('--semantic')) {
  useSemantic = true
  ensureVectorSchema(db)
  const modelDir = arg('models') || './models'
  const allowDownload = !arg('models')
  const embedder = await loadEmbedder({ modelDir, allowDownload })
  if (!embedder) {
    console.error('semantic: model failed to load')
    db.close()
    process.exit(1)
  }
  await runVectorIndexer(db, embedder, { log: () => {} })
  similar = { store: createVectorStore(db, embedder), embedder }
}

// Print mode header
console.log(`mode: ${useSemantic ? 'semantic' : 'lexical'}`)

let h1 = 0, h5 = 0
for (const { q, targets } of queries) {
  const { results = [] } = await searchAll(db, userId, { query: q, limit: 20, similar })
  const rank = results.findIndex((r) => targets.some((t) => t.kind === r.kind && t.num === r.num)) + 1
  if (rank === 1) h1++
  if (rank >= 1 && rank <= 5) h5++
  console.log(`${rank || '—'}\t${rank ? results[rank - 1].why : ''}\t${q}`)
}
console.log(`hit@1 ${h1}/${queries.length}  hit@5 ${h5}/${queries.length}`)
for (const { q, targets } of file.exact_probes ?? []) {
  const { results = [] } = await searchAll(db, userId, { query: q, limit: 20, similar })
  const ok = results[0] && targets.some((t) => t.kind === results[0].kind && t.num === results[0].num) && ['exact', 'words'].includes(results[0].why)
  console.log(`exact probe ${ok ? 'PASS' : 'FAIL'}\t${q}`)
}
for (const q of file.unrelated_probes ?? []) {
  const { results = [] } = await searchAll(db, userId, { query: q, limit: 20, similar })
  const n = results.filter((r) => r.why === 'similar').length
  console.log(`unrelated probe ${n === 0 ? 'PASS' : `FAIL (${n} similar)`}\t${q}`)
}

db.close()
process.exit(0)
