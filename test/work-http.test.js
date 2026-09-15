import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgent } from '../src/auth.js'
import { openDb } from '../src/db.js'
import { makeHttpHandler } from '../src/http.js'
import { upsertConversation } from '../src/journal.js'
import { createWorkView, resolveClaimLiveness } from '../src/work-http.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORK_SCHEMA_PATH = path.join(HERE, '..', 'src', 'contracts', 'work-view.schema.json')
const WORK_SCHEMA = JSON.parse(readFileSync(WORK_SCHEMA_PATH, 'utf8'))
const CLAIMED_AT = '2026-09-15T12:34:56Z'

function workEnv(producerRoot, storePath, ownerUserId = '1') {
  return {
    PATH: process.env.PATH,
    PYTHONPATH: '/must/be-removed-by-the-journal',
    WORK_VIEW_TEST_SECRET: 'must-not-reach-the-builder',
    WORK_VIEW_OWNER_USER_ID: ownerUserId,
    WORK_VIEW_PRODUCER_ROOT: producerRoot,
    WORK_VIEW_STORE_PATH: storePath,
  }
}

function makeFakeProducer(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'matron-work-producer-'))
  const scripts = path.join(root, 'scripts')
  mkdirSync(scripts)
  writeFileSync(path.join(scripts, 'work_view_cli.py'), `
import argparse
import json
import os
from pathlib import Path
import sys
import time

if "PYTHONPATH" in os.environ:
    raise SystemExit(90)
if "WORK_VIEW_TEST_SECRET" in os.environ:
    raise SystemExit(91)

parser = argparse.ArgumentParser()
parser.add_argument("--group-by", choices=("repo", "domain"), default="repo")
parser.add_argument("--store", type=Path)
args = parser.parse_args()

if args.store is None or not args.store.exists():
    print(json.dumps({
        "schema_version": 1,
        "status": "error",
        "group_by": args.group_by,
        "groups": [],
        "error": {"code": "store_missing", "message": "The canonical loop store is missing."},
    }))
    raise SystemExit(0)

fixture = json.loads(args.store.read_text())
mode = fixture.get("mode")
if mode == "sleep":
    time.sleep(10)
if mode == "exit":
    raise SystemExit(7)
if mode == "invalid":
    print("not-json")
    raise SystemExit(0)
print(json.dumps(fixture[args.group_by]))
`.trimStart())
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function claim(convoId) {
  return {
    convo_id: convoId,
    holder_label: null,
    claimed_at: CLAIMED_AT,
    liveness: 'unknown',
  }
}

function loop(id, convoId = null) {
  return {
    id,
    title: `work-loop-${id}`,
    repo: 'matron-journal',
    domain: 'infra',
    priority: 6 - id,
    description: `loop ${id}`,
    status: 'active',
    claim: convoId === null ? null : claim(convoId),
  }
}

function envelope(groupBy, loops, key = groupBy === 'repo' ? 'matron-journal' : 'infra') {
  return {
    schema_version: 1,
    status: 'ok',
    group_by: groupBy,
    groups: [{ key, loops }],
  }
}

function writeFixture(storePath, repoPayload, domainPayload = null) {
  writeFileSync(storePath, JSON.stringify({
    repo: repoPayload,
    domain: domainPayload ?? { ...repoPayload, group_by: 'domain', groups: repoPayload.groups.map((group) => ({ ...group, key: 'infra' })) },
  }))
}

function addUser(db, name) {
  const result = db.prepare(
    'INSERT INTO users(name, password_hash, created_at) VALUES(?,?,?)'
  ).run(name, 'test-only-unused-password-hash', Date.now())
  const id = Number(result.lastInsertRowid)
  return { id, token: createAgent(db, id, `${name}-agent`).token }
}

class MockResponse extends EventEmitter {
  constructor() {
    super()
    this.destroyed = false
    this.writableEnded = false
    this.headers = {}
  }

  setHeader(name, value) { this.headers[name.toLowerCase()] = value }
  writeHead(status, headers = {}) {
    this.statusCode = status
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
  }
  end(body = '') {
    this.body = body
    this.writableEnded = true
    this.emit('finish')
  }
}

function startWorkServer(t, { env, timeoutMs = 5000, logger = console }) {
  const db = openDb(':memory:')
  const handler = makeHttpHandler({
    db,
    workViewOptions: { env, timeoutMs, logger },
  })
  t.after(() => { if (db.open) db.close() })
  return {
    db,
    async http(requestPath, { method = 'GET', token = null } = {}) {
      const req = new EventEmitter()
      req.method = method
      req.url = requestPath
      req.headers = token ? { authorization: `Bearer ${token}` } : {}
      req.socket = { remoteAddress: '127.0.0.1' }
      req.destroy = () => { req.destroyed = true }
      const res = new MockResponse()
      await handler(req, res)
      let parsed = null
      try { parsed = JSON.parse(res.body) } catch { /* empty/non-JSON body */ }
      return { status: res.statusCode, json: parsed }
    },
  }
}

function assertWorkEnvelopeUsesVendoredSchema(payload) {
  for (const required of WORK_SCHEMA.required) assert.ok(Object.hasOwn(payload, required))
  assert.ok(WORK_SCHEMA.properties.status.enum.includes(payload.status))
  assert.ok(WORK_SCHEMA.properties.group_by.enum.includes(payload.group_by))
  if (payload.error) {
    assert.ok(WORK_SCHEMA.definitions.error.properties.code.enum.includes(payload.error.code))
  }
  for (const group of payload.groups) {
    for (const item of group.loops) {
      if (item.claim) {
        assert.ok(WORK_SCHEMA.definitions.claim.properties.liveness.enum.includes(item.claim.liveness))
      }
    }
  }
}

test('vendored Work schema carries the canonical endpoint contract', () => {
  assert.equal(WORK_SCHEMA.properties.schema_version.const, 1)
  assert.deepEqual(WORK_SCHEMA.properties.group_by.enum, ['repo', 'domain'])
  assert.deepEqual(WORK_SCHEMA.definitions.claim.required, ['convo_id', 'holder_label', 'claimed_at', 'liveness'])
  assert.deepEqual(WORK_SCHEMA.definitions.claim.properties.liveness.enum, ['live', 'stale', 'unknown'])
  assert.deepEqual(WORK_SCHEMA.definitions.error.properties.code.enum, [
    'store_missing', 'store_corrupt', 'builder_failed', 'builder_timeout',
  ])
})

test('GET /work reuses Bearer auth, enforces the configured owner, and validates group_by', async (t) => {
  const producerRoot = makeFakeProducer(t)
  const storePath = path.join(producerRoot, 'fixture.json')
  writeFixture(storePath, envelope('repo', [loop(1)]))
  const s = startWorkServer(t, { env: workEnv(producerRoot, storePath) })
  const owner = addUser(s.db, 'owner')
  const secondUser = addUser(s.db, 'second-user')

  const noAuth = await s.http('/work')
  assert.equal(noAuth.status, 401)
  assert.deepEqual(noAuth.json, { error: 'unauthenticated' })

  const forbidden = await s.http('/work', { token: secondUser.token })
  assert.equal(forbidden.status, 403)
  assert.deepEqual(forbidden.json, { error: 'forbidden' })

  const ok = await s.http('/work', { token: owner.token })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.status, 'ok')
  assertWorkEnvelopeUsesVendoredSchema(ok.json)

  const badGroup = await s.http('/work?group_by=owner', { token: owner.token })
  assert.equal(badGroup.status, 400)
  assert.deepEqual(badGroup.json, { error: 'bad_request' })
})

test('GET /work fails closed and logs when WORK_VIEW_OWNER_USER_ID is absent or malformed', async (t) => {
  const producerRoot = makeFakeProducer(t)
  const storePath = path.join(producerRoot, 'fixture.json')
  writeFixture(storePath, envelope('repo', [loop(1)]))

  for (const rawOwner of [undefined, 'not-an-id']) {
    const errors = []
    const env = workEnv(producerRoot, storePath, rawOwner)
    if (rawOwner === undefined) delete env.WORK_VIEW_OWNER_USER_ID
    const s = startWorkServer(t, {
      env,
      logger: { error: (...args) => errors.push(args) },
    })
    const caller = addUser(s.db, `caller-${errors.length}-${rawOwner}`)

    const result = await s.http('/work', { token: caller.token })
    assert.equal(result.status, 500)
    assert.deepEqual(result.json, { error: 'internal' })
    assert.equal(errors.length, 1)
    assert.match(String(errors[0][0]), /WORK_VIEW_OWNER_USER_ID/)
  }
})

test('GET /work fails closed and logs when WORK_VIEW_PRODUCER_ROOT is absent', async (t) => {
  const errors = []
  const env = workEnv('/unused', '/unused')
  delete env.WORK_VIEW_PRODUCER_ROOT
  const s = startWorkServer(t, {
    env,
    logger: { error: (...args) => errors.push(args) },
  })
  const owner = addUser(s.db, 'missing-root-owner')

  const result = await s.http('/work', { token: owner.token })
  assert.equal(result.status, 500)
  assert.deepEqual(result.json, { error: 'internal' })
  assert.equal(errors.length, 1)
  assert.match(String(errors[0][0]), /WORK_VIEW_PRODUCER_ROOT/)
})

test('Work route startup rejects an unresolvable WORK_VIEW_PRODUCER_ROOT', () => {
  assert.throws(
    () => createWorkView({
      db: {},
      env: {
        WORK_VIEW_OWNER_USER_ID: '1',
        WORK_VIEW_PRODUCER_ROOT: '/definitely/missing/work-view-producer',
      },
    }),
    /WORK_VIEW_PRODUCER_ROOT/
  )
})

test('GET /work resolves all real journal session states, switches grouping, and never serves stale cache', async (t) => {
  const producerRoot = makeFakeProducer(t)
  const storePath = path.join(producerRoot, 'fixture.json')
  const loops = [
    loop(1, 'running-convo'),
    loop(2, 'waiting-convo'),
    loop(3, 'done-convo'),
    loop(4, 'archived-convo'),
    loop(5, 'absent-convo'),
  ]
  writeFixture(storePath, envelope('repo', loops))
  const s = startWorkServer(t, { env: workEnv(producerRoot, storePath) })
  const owner = addUser(s.db, 'liveness-owner')
  for (const [id, state] of [
    ['running-convo', 'running'],
    ['waiting-convo', 'waiting'],
    ['done-convo', 'done'],
    ['archived-convo', 'archived'],
  ]) {
    upsertConversation(s.db, { id, ownerUserId: owner.id, title: id, sessionState: state })
  }

  const byRepo = await s.http('/work?group_by=repo', { token: owner.token })
  assert.equal(byRepo.status, 200)
  assert.equal(byRepo.json.group_by, 'repo')
  assert.deepEqual(
    byRepo.json.groups[0].loops.map((item) => item.claim.liveness),
    ['live', 'live', 'stale', 'stale', 'stale']
  )
  assertWorkEnvelopeUsesVendoredSchema(byRepo.json)

  const byDomain = await s.http('/work?group_by=domain', { token: owner.token })
  assert.equal(byDomain.status, 200)
  assert.equal(byDomain.json.group_by, 'domain')
  assert.equal(byDomain.json.groups[0].key, 'infra')

  unlinkSync(storePath)
  const afterReadFailure = await s.http('/work', { token: owner.token })
  assert.equal(afterReadFailure.status, 200)
  assert.equal(afterReadFailure.json.status, 'error')
  assert.equal(afterReadFailure.json.error.code, 'store_missing')
  assertWorkEnvelopeUsesVendoredSchema(afterReadFailure.json)
})

test('query failures resolve claim liveness to unknown against the real database handle', () => {
  const db = openDb(':memory:')
  db.close()
  assert.equal(resolveClaimLiveness(db, 'closed-db-convo'), 'unknown')
})

test('GET /work bounds the builder and maps non-zero or unparseable output to canonical errors', async (t) => {
  const producerRoot = makeFakeProducer(t)
  const storePath = path.join(producerRoot, 'fixture.json')
  writeFileSync(storePath, JSON.stringify({ mode: 'sleep' }))
  const s = startWorkServer(t, {
    env: workEnv(producerRoot, storePath),
    timeoutMs: 500,
    logger: { error: () => {} },
  })
  const owner = addUser(s.db, 'builder-owner')

  const timedOut = await s.http('/work', { token: owner.token })
  assert.equal(timedOut.status, 200)
  assert.equal(timedOut.json.status, 'error')
  assert.equal(timedOut.json.error.code, 'builder_timeout')
  assertWorkEnvelopeUsesVendoredSchema(timedOut.json)

  writeFileSync(storePath, JSON.stringify({ mode: 'exit' }))
  const failed = await s.http('/work', { token: owner.token })
  assert.equal(failed.status, 200)
  assert.equal(failed.json.error.code, 'builder_failed')

  writeFileSync(storePath, JSON.stringify({ mode: 'invalid' }))
  const invalid = await s.http('/work', { token: owner.token })
  assert.equal(invalid.status, 200)
  assert.equal(invalid.json.error.code, 'builder_failed')
})
