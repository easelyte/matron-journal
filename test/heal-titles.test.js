import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { labelCandidates, labelSet, stripServerLabel, healBakedTitles } from '../src/heal-titles.js'

test('labelCandidates mirrors the bridge SERVER_LABEL derivation', () => {
  // `hostname.match(/^(\w+)-(\d+)/)` -> the digits; otherwise the first four
  // chars, upper-cased (compared lower-cased here). The whole name rides
  // along for boxes that set SERVER_LABEL explicitly.
  assert.deepEqual(labelCandidates('dev-2'), ['2', 'dev-', 'dev-2'])
  assert.deepEqual(labelCandidates('dev-y'), ['dev-', 'dev-y'])
  assert.deepEqual(labelCandidates('mac'), ['mac'])
  // The numbered branch is ANY word, not `dev-`: the bridge's own line
  // comment says "dev-3" but its regex does not, and a box named `build-7`
  // really does label itself `7`. Dropping that candidate would not be the
  // conservative choice, it would be wrong about a real bridge.
  assert.deepEqual(labelCandidates('build-7'), ['7', 'buil', 'build-7'])
  assert.deepEqual(labelCandidates('dev-12'), ['12', 'dev-', 'dev-12'])
  // a name that could never appear as a `LABEL:` prefix yields nothing
  assert.deepEqual(labelCandidates('Dan Mac'), [])
  assert.deepEqual(labelCandidates('   '), [])
  assert.deepEqual(labelCandidates(null), [])
  // over the 12-char label cap: the slice survives, the whole name does not
  assert.deepEqual(labelCandidates('averylonglabelx'), ['aver'])
})

test('stripServerLabel only strips prefixes that name a known box label', () => {
  // the user owns boxes `dev-y` and `dev-3`, plus a client that is not a box
  const labels = labelSet(['dev-y', 'dev-3', 'Dan Mac'])

  // fallback / Gemini form: label + ':' + 2-char session fragment + space
  assert.equal(stripServerLabel('DEV-:a3 Fix the thing', labels), 'Fix the thing')
  assert.equal(stripServerLabel('3:f0 fix the folder picker', labels), 'fix the folder picker')
  assert.equal(stripServerLabel('dev-3:A1 Ship the release', labels), 'Ship the release')
  // workdir-seed form: label + ': ' + a single space-free basename
  assert.equal(stripServerLabel('DEV-: matron-apple', labels), 'matron-apple')
  assert.equal(stripServerLabel('3: yearbook_app', labels), 'yearbook_app')

  // ORGANIC LOOKALIKES. Every one of these has a baked-prefix SHAPE; none of
  // them names a label this database knows, so none is rewritten.
  assert.equal(stripServerLabel('Q: help', labels), 'Q: help')
  assert.equal(stripServerLabel('2: fix', labels), '2: fix')
  assert.equal(stripServerLabel('Note: document', labels), 'Note: document')
  assert.equal(stripServerLabel('Plan: go next steps', labels), 'Plan: go next steps')
  assert.equal(stripServerLabel('Fix: parser bug', labels), 'Fix: parser bug')
  assert.equal(stripServerLabel('TODO: ship the thing', labels), 'TODO: ship the thing')
  assert.equal(stripServerLabel('Fix the thing', labels), 'Fix the thing')
  assert.equal(stripServerLabel('', labels), '')
  // a client device is not a box, so its name never licenses a strip
  assert.equal(stripServerLabel('Dan: Mac', labels), 'Dan: Mac')
  // right label, wrong shape: a 3-char fragment is not the fallback form and
  // the remainder has spaces so it is not the seed form either
  assert.equal(stripServerLabel('dev-y:abc something', labels), 'dev-y:abc something')
  // no known labels at all (a user with no agent boxes) -> never rewrite
  assert.equal(stripServerLabel('DEV-:a3 Fix the thing', new Set()), 'DEV-:a3 Fix the thing')
  assert.equal(stripServerLabel('DEV-:a3 Fix the thing'), 'DEV-:a3 Fix the thing')

  // idempotent: healed output re-heals to itself
  for (const t of ['DEV-:a3 Fix the thing', 'DEV-: matron-apple', 'Fix: parser bug']) {
    const once = stripServerLabel(t, labels)
    assert.equal(stripServerLabel(once, labels), once)
  }
})

test('healBakedTitles rewrites stored titles once and is gated on user_version', () => {
  const db = openDb(':memory:')
  const now = Date.now()
  const users = db.prepare('INSERT INTO users(id, name, password_hash, created_at) VALUES(?,?,?,?)')
  users.run(1, 'dan', 'x', now)
  users.run(2, 'zahra', 'x', now)
  const devices = db.prepare(
    'INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(?,?,?,?,?,?)')
  devices.run(7, 1, 'agent', 'dev-y', 'h7', now)   // labels: dev-, dev-y
  devices.run(8, 1, 'agent', 'dev-3', 'h8', now)   // labels: 3, dev-, dev-3
  devices.run(9, 1, 'client', 'Dan Mac', 'h9', now)
  const insert = db.prepare(
    'INSERT INTO conversations(id, owner_user_id, title, created_at, agent_device_id) VALUES(?,?,?,?,?)')
  insert.run('c1', 1, 'DEV-:a3 Fix the thing', now, 7)
  insert.run('c2', 1, 'DEV-: matron-apple', now, null)   // legacy row: owner's union
  insert.run('c3', 1, 'Fix: parser bug', now, 7)
  insert.run('c4', 1, 'Q: help', now, 8)
  insert.run('c5', 1, 'Note: document', now, null)
  insert.run('c6', 1, '2: fix', now, null)               // no box of this user yields "2"
  insert.run('c7', 1, '3: yearbook_app', now, 8)
  insert.run('c8', 1, 'Plan: go next steps', now, 8)
  // recorded box is dev-y, whose labels do not include "3": only the box
  // that could have baked a prefix gets to license stripping it
  insert.run('c9', 1, '3: yearbook_app', now, 7)
  // another user, no agent boxes at all -> nothing is a known label
  insert.run('z1', 2, 'DEV-: matron-apple', now, null)

  // openDb already ran it — user_version is claimed and titles are healed
  assert.equal(db.pragma('user_version', { simple: true }) >= 1, true)
  const titles = () => Object.fromEntries(
    db.prepare('SELECT id, title FROM conversations').all().map((r) => [r.id, r.title]))
  // rows inserted AFTER open are untouched by that first run
  assert.equal(titles().c1, 'DEV-:a3 Fix the thing')

  // a direct call still heals (this is what a real upgrade does, at open,
  // with rows already present)
  const logged = []
  const r = healBakedTitles(db, { log: (m) => logged.push(m), force: true })
  assert.deepEqual(titles(), {
    c1: 'Fix the thing',
    c2: 'matron-apple',
    c3: 'Fix: parser bug',
    c4: 'Q: help',
    c5: 'Note: document',
    c6: '2: fix',
    c7: 'yearbook_app',
    c8: 'Plan: go next steps',
    c9: '3: yearbook_app',
    z1: 'DEV-: matron-apple',
  })
  assert.equal(r.scanned, 10)
  assert.equal(r.healed, 3)
  assert.equal(logged.length, 3)
  assert.match(logged[0], /c1/)

  // gated: a second ungated call is a no-op because user_version is set
  const again = healBakedTitles(db, { log: () => {} })
  assert.equal(again.healed, 0)
  // and even ungated it would be a no-op — healed titles no longer match
  assert.equal(healBakedTitles(db, { force: true }).healed, 0)
})
