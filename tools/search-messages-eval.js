#!/usr/bin/env node
// Offline hit@k for GET /search (conversation messages). Reads a PRIVATE
// query file (never commit one to this repo).
// Usage: node tools/search-messages-eval.js --db path/to/copy.db --user 1 --queries file.json [--verbose]
// File shape: [{ kind?, q, seq }] — `seq` is the message the query should find.
// WARNING: openDb() runs migrations; --db MUST be a COPY, never the live file.
import { openDb } from '../src/db.js'
import { searchMessages } from '../src/search.js'
import fs from 'node:fs'
import path from 'node:path'

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }
const dbPath = arg('db'); const userArg = arg('user'); const queriesPath = arg('queries')
if (!dbPath || !userArg || !queriesPath) {
  console.error('Usage: node tools/search-messages-eval.js --db path/to/copy.db --user 1 --queries file.json [--verbose]')
  process.exit(2)
}
if (path.basename(dbPath) === 'matron.db') {
  console.error('refusing to run against matron.db (the live server database). Use a copy.')
  process.exit(2)
}
const db = openDb(dbPath)
const userId = Number(userArg)
const by = {}
for (const e of JSON.parse(fs.readFileSync(queriesPath, 'utf8'))) {
  const { hits = [] } = searchMessages(db, userId, { query: e.q, limit: 20 })
  const rank = hits.findIndex((h) => h.seq === e.seq) + 1
  const b = (by[e.kind ?? 'all'] ??= { n: 0, h1: 0, h5: 0 })
  b.n++
  if (rank === 1) b.h1++
  if (rank >= 1 && rank <= 5) b.h5++
  if (process.argv.includes('--verbose')) console.log(`${rank || '—'}\t${hits[rank - 1]?.why ?? ''}\t${e.q}`)
}
let n = 0, h1 = 0, h5 = 0
for (const [k, b] of Object.entries(by)) {
  console.log(`${k}\tn=${b.n} hit@1=${b.h1} hit@5=${b.h5}`)
  n += b.n; h1 += b.h1; h5 += b.h5
}
console.log(`hit@1 ${h1}/${n} (${(h1 / n).toFixed(3)})  hit@5 ${h5}/${n} (${(h5 / n).toFixed(3)})`)
db.close()
