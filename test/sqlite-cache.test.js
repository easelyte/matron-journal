import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'

// openDb keeps hot pages in-process (the stock ~16 MB cache made nearly every
// query a read(2) that stalled the event loop when the disk was busy).
function cacheKib(env) {
  const prev = process.env.MATRON_SQLITE_CACHE_MB
  if (env === undefined) delete process.env.MATRON_SQLITE_CACHE_MB
  else process.env.MATRON_SQLITE_CACHE_MB = env
  try {
    const db = openDb(':memory:')
    const v = db.pragma('cache_size', { simple: true })
    db.close()
    return v
  } finally {
    if (prev === undefined) delete process.env.MATRON_SQLITE_CACHE_MB
    else process.env.MATRON_SQLITE_CACHE_MB = prev
  }
}

test('openDb defaults to a 256 MiB page cache', () => {
  assert.equal(cacheKib(undefined), -262144)
})

test('MATRON_SQLITE_CACHE_MB overrides the page cache size', () => {
  assert.equal(cacheKib('64'), -65536)
})

test('a bad MATRON_SQLITE_CACHE_MB leaves the SQLite default', () => {
  const stock = new Database(':memory:').pragma('cache_size', { simple: true })
  assert.equal(cacheKib('0'), stock)
  assert.equal(cacheKib('nope'), stock)
})
