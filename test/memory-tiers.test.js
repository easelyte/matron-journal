// Memory tiers and topics: `always` memories are listed in full in every
// session of their scope, `on_demand` ones are named under a topic. Neither
// tier has a size limit.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { seed } from './search-fixtures.js'
import { validateMemoryFields, upsertMemory, getMemory } from '../src/memories.js'
import { recordProposal } from '../src/memory-proposals.js'
import { proposalItemFields } from '../src/memory-proposals-http.js'

const save = (db, name, over = {}) => upsertMemory(db, {
  userId: 1, name, description: `Rule ${name}.`, body: '', by: 'agent', now: 1000, ...over,
})
const fill = (db, scope, n, prefix = 'm') => {
  for (let i = 0; i < n; i++) save(db, `${prefix}-${i}`, { scope })
}

test('validateMemoryFields: tier and topic', () => {
  const ok = (extra) => validateMemoryFields({ description: 'x', ...extra })
  assert.equal(ok({}).value.tier, undefined)
  assert.equal(ok({}).value.topic, undefined)
  assert.equal(ok({ tier: 'on_demand' }).value.tier, 'on_demand')
  assert.equal(ok({ tier: 'always' }).value.tier, 'always')
  assert.equal(ok({ tier: 'sometimes' }).ok, false)
  assert.equal(ok({ topic: '  Couriers ' }).value.topic, 'Couriers')
  assert.equal(ok({ topic: null }).value.topic, '')
  assert.equal(ok({ topic: '' }).value.topic, '')
  assert.equal(ok({ topic: 'a'.repeat(41) }).ok, false)
  assert.equal(ok({ topic: 'a\nb' }).ok, false)
  assert.equal(ok({ topic: 7 }).ok, false)
})

test('a new memory is always by default; tier and topic are kept on an update that omits them, and topic clears with ""', () => {
  const db = seed()
  assert.equal(save(db, 'a').memory.tier, 'always')
  assert.equal(getMemory(db, 1, 'a').topic, null)
  const b = save(db, 'b', { tier: 'on_demand', topic: 'couriers' }).memory
  assert.deepEqual([b.tier, b.topic], ['on_demand', 'couriers'])
  const b2 = save(db, 'b', { description: 'Changed.' }).memory
  assert.deepEqual([b2.tier, b2.topic, b2.description], ['on_demand', 'couriers', 'Changed.'])
  assert.equal(save(db, 'b', { topic: '' }).memory.topic, null)
  assert.equal(save(db, 'b', { tier: 'always' }).memory.tier, 'always')
})

test('no size limit: a scope takes any number of always memories, and a tier is only what the writer names', () => {
  const db = seed()
  fill(db, 'global', 80)
  const r = save(db, 'one-more', { scope: 'global' })
  assert.equal(r.memory.tier, 'always')
  assert.equal('capped' in r, false)
  assert.equal(save(db, 'named', { scope: 'global', tier: 'always' }).memory.tier, 'always')
  save(db, 'mover', { scope: 'repo:gadgets' })
  assert.deepEqual([save(db, 'mover', { scope: 'global' }).memory.scope, getMemory(db, 1, 'mover').tier], ['global', 'always'])
  save(db, 'm-0', { tier: 'on_demand' })
  assert.equal(save(db, 'm-0', { tier: 'always' }).memory.tier, 'always')
})

test('schema: a pre-tier memories table gets tier (always) and topic in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-memory-tier-'))
  const dbPath = path.join(dir, 'pre-tier.db')
  const raw = new Database(dbPath)
  raw.exec(`CREATE TABLE memories(
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL,
    type TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
    origin_convo_id TEXT, origin_device_id INTEGER, origin_private INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL, updated_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global', UNIQUE(user_id, name))`)
  raw.prepare("INSERT INTO memories VALUES('me_1', 1, 'old', 'feedback', 'Old rule.', '', NULL, NULL, 0, 'user', 'user', 1, 1, 'global')").run()
  raw.close()
  const db = openDb(dbPath)
  const row = db.prepare("SELECT tier, topic FROM memories WHERE id='me_1'").get()
  assert.deepEqual({ ...row }, { tier: 'always', topic: null })
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a proposal records tier and topic; its card shows them', async () => {
  const db = seed()
  const { proposal } = recordProposal(db, { userId: 1, name: 'p1', action: 'save', fields: { description: 'Rule.', body: '', tier: 'on_demand', topic: 'couriers' }, fromDeviceId: 1, fromConvoId: 'c1' })
  assert.deepEqual([proposal.tier, proposal.topic], ['on_demand', 'couriers'])
  assert.match(proposalItemFields(db, proposal).body, /\*\*Tier:\*\* on demand, topic: couriers/)
  const { proposal: p2 } = recordProposal(db, { userId: 1, name: 'p2', action: 'save', fields: { description: 'Rule.', body: '' }, fromDeviceId: 1, fromConvoId: 'c1' })
  assert.equal(p2.tier, null, 'not named')
  assert.match(proposalItemFields(db, p2).body, /\*\*Tier:\*\* always/)
  const { proposal: p4 } = recordProposal(db, { userId: 1, name: 'p4', action: 'save', fields: { description: 'Rule.', body: '', tier: 'on_demand', topic: '[details](https://example.com)' }, fromDeviceId: 1, fromConvoId: 'c1' })
  assert.doesNotMatch(proposalItemFields(db, p4).body, /\[details\]\(https/, 'a topic cannot render as a link on the card')
})
