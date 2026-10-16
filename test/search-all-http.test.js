// test/search-all-http.test.js — GET /search/all (spec 2026-10-12 unified
// search §6): the route itself, server-side semantic status, excludeConsent
// end to end, mission_num on the chat groups, and a clean shutdown with an
// injected embedder.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer } from './helpers.js'
import { fakeEmbedder } from '../src/embedder.js'
import { createUser, createAgent } from '../src/auth.js'
import { append, upsertConversation } from '../src/journal.js'
import { createMission, joinMission } from '../src/missions.js'
import { createItem } from '../src/items.js'
import { openDb } from '../src/db.js'

async function loginAlice(t) {
  await createUser(t.db, 'alice', 'password-123')
  const { token, user_id } = (await t.http('/login', { method: 'POST', body: { username: 'alice', password: 'password-123' } })).json
  return { clientToken: token, userId: user_id }
}

test('/search/all: 400 on empty or overlong q, 200 with results and semantic off when no embedder', async () => {
  const t = await startTestServer({ embedder: null })
  try {
    const { userId } = await loginAlice(t)
    const { token } = createAgent(t.db, userId, 'kit')
    assert.equal((await t.http('/search/all?q=', { token })).status, 400)
    assert.equal((await t.http(`/search/all?q=${'x'.repeat(257)}`, { token })).status, 400)
    const r = await t.http('/search/all?q=anything+at+all', { token })
    assert.equal(r.status, 200)
    assert.equal(r.json.semantic, 'off')
    assert.ok(Array.isArray(r.json.results))
  } finally { await t.close() }
})

test('/search/all: bad kinds is 400; limit follows the same rules as /search', async () => {
  const t = await startTestServer({ embedder: null })
  try {
    const { userId } = await loginAlice(t)
    const { token } = createAgent(t.db, userId, 'kit')
    assert.equal((await t.http('/search/all?q=a&kinds=mission,nonsense', { token })).status, 400)
    assert.equal((await t.http('/search/all?q=a&limit=0', { token })).status, 400)
    assert.equal((await t.http('/search/all?q=a&limit=100000', { token })).status, 200)
  } finally { await t.close() }
})

test('/search/all: semantic reports ready after the indexer finishes with an injected embedder', async () => {
  const t = await startTestServer({ embedder: fakeEmbedder() })
  try {
    const { userId } = await loginAlice(t)
    const { token } = createAgent(t.db, userId, 'kit')
    let body
    for (let i = 0; i < 40; i++) {
      body = (await t.http('/search/all?q=find+the+old+project', { token })).json
      if (body.semantic === 'ready') break
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.equal(body.semantic, 'ready')
    // semantic=0 opts out of the status
    // too, not just the tier — never 'ready'/'indexing' for a request
    // that asked the tier off.
    const off = (await t.http('/search/all?q=find+the+old+project&semantic=0', { token })).json
    assert.equal(off.semantic, 'off')
  } finally { await t.close() }
})

test('/search/all: chats=1 includes typed chat groups with mission_num', async () => {
  const t = await startTestServer({ embedder: null })
  try {
    const { clientToken, userId } = await loginAlice(t)
    const { deviceId } = createAgent(t.db, userId, 'kit')
    upsertConversation(t.db, { id: 'c1', ownerUserId: userId, title: 'chat', agentDeviceId: deviceId })
    const { mission } = createMission(t.db, { userId, deviceId, createdBy: 'agent', convoId: 'c1', title: 'harbour lantern export' })
    append(t.db, { userId, convoId: 'c1', sender: 'agent:kit', type: 'text', payload: { body: 'checking the harbour lantern export colours' } })
    const r = await t.http('/search/all?q=harbour+lantern+export&chats=1', { token: clientToken })
    assert.equal(r.status, 200)
    assert.ok(r.json.chats.length > 0)
    assert.equal(r.json.chats[0].mission_num, mission.num)
  } finally { await t.close() }
})

// The chat group's mission_num must
// follow the same ORIGIN_SIEVE rule GET /conversations applies — a
// filtered (ordinary, non-private) agent caller never learns the number
// of a mission whose own origin conversation is on a private box, even
// through an otherwise-visible public conversation currently on it.
test('/search/all: chats mission_num hides a private-origin mission from a filtered agent but not from the owning user', async () => {
  const t = await startTestServer({ embedder: null })
  try {
    const { clientToken, userId } = await loginAlice(t)
    const { token: agentToken, deviceId: pubDeviceId } = createAgent(t.db, userId, 'pub')
    const { deviceId: privDeviceId } = createAgent(t.db, userId, 'secret')
    t.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(privDeviceId)
    // The mission is BORN on the private device's conversation...
    upsertConversation(t.db, { id: 'secret-convo', ownerUserId: userId, title: 'secret', agentDeviceId: privDeviceId })
    const { mission } = createMission(t.db, { userId, deviceId: privDeviceId, createdBy: 'agent', convoId: 'secret-convo', title: 'harbour lantern export' })
    // ...but a PUBLIC conversation is (also) joined to it, and it's that
    // public conversation's own chat group the filtered agent can see.
    upsertConversation(t.db, { id: 'pub-convo', ownerUserId: userId, title: 'chat', agentDeviceId: pubDeviceId })
    joinMission(t.db, { userId, missionId: mission.id, convoId: 'pub-convo' })
    append(t.db, { userId, convoId: 'pub-convo', sender: 'agent:pub', type: 'text', payload: { body: 'checking the harbour lantern export colours' } })
    const forAgent = (await t.http('/search/all?q=harbour+lantern+export&chats=1', { token: agentToken })).json
    assert.equal(forAgent.chats[0].convo_id, 'pub-convo')
    assert.equal(forAgent.chats[0].mission_num, null)
    const forUser = (await t.http('/search/all?q=harbour+lantern+export&chats=1', { token: clientToken })).json
    assert.equal(forUser.chats[0].mission_num, mission.num)
  } finally { await t.close() }
})

// excludeConsent must be passed for every agent
// caller, mirroring items-http.js's visibleItem rule — a consent-mirror
// item is invisible to an agent regardless of q, but visible to the owning
// user, who can still see their own consent cards.
test('/search/all: a consent item is hidden from an agent but not from the owning user', async () => {
  const t = await startTestServer({ embedder: null })
  try {
    const { clientToken, userId } = await loginAlice(t)
    const { token: agentToken, deviceId } = createAgent(t.db, userId, 'kit')
    upsertConversation(t.db, { id: 'c1', ownerUserId: userId, title: 'chat', agentDeviceId: deviceId })
    createItem(t.db, {
      userId, originDeviceId: deviceId, originConvoId: 'c1', createdBy: 'agent',
      kind: 'task', title: 'gibbon consent ask', consent: 'spawn',
    })
    const forAgent = (await t.http('/search/all?q=gibbon+consent+ask', { token: agentToken })).json
    assert.equal(forAgent.results.some((r) => r.kind === 'item'), false)
    const forUser = (await t.http('/search/all?q=gibbon+consent+ask', { token: clientToken })).json
    assert.equal(forUser.results.some((r) => r.kind === 'item'), true)
  } finally { await t.close() }
})

// With a fresh :memory: db nothing is pending, so the first reindex pass
// leaves runVectorIndexer's loop before ever awaiting anything and close()
// is never exercised mid-pass. So this seeds one doc on a real file (so it exists before the server's own first pass ever reads
// search_docs — a :memory: db can't be pre-seeded from outside the
// connection that creates it) and uses an embedder whose embedDocs takes
// real wall-clock time, then closes while that call is still pending.
function slowEmbedder(delayMs) {
  const fe = fakeEmbedder()
  return { ...fe, embedDocs: async (texts) => { await new Promise((r) => setTimeout(r, delayMs)); return fe.embedDocs(texts) } }
}

test('/search/all: starting with a fake embedder and closing immediately does not throw or hang', async () => {
  const t = await startTestServer({ embedder: fakeEmbedder() })
  await assert.doesNotReject(t.close())
})

test('/search/all: closing while a reindex pass is mid-await (slow embedder, a seeded doc) does not throw or hang', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-search-all-close-'))
  const dbPath = path.join(dir, 'test.db')
  try {
    const seedDb = openDb(dbPath)
    seedDb.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'alice','x',0)").run()
    seedDb.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(1,1,'agent','kit','h',0)").run()
    upsertConversation(seedDb, { id: 'c1', ownerUserId: 1, title: 'chat', agentDeviceId: 1 })
    createMission(seedDb, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'harbour lantern export' })
    seedDb.close()

    const t = await startTestServer({ dbPath, embedder: slowEmbedder(500) })
    // Let the initial pass read the one pending doc and enter its slow
    // embedDocs await — genuinely mid-flight, not already finished.
    await new Promise((r) => setTimeout(r, 50))
    await assert.doesNotReject(t.close())
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('/search/all: while the first index pass runs, answers are lexical-only and say indexing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-search-all-indexing-'))
  const dbPath = path.join(dir, 'test.db')
  let release
  const gate = new Promise((r) => { release = r })
  try {
    const seedDb = openDb(dbPath)
    seedDb.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'alice','x',0)").run()
    seedDb.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(1,1,'agent','kit','h',0)").run()
    upsertConversation(seedDb, { id: 'c1', ownerUserId: 1, title: 'chat', agentDeviceId: 1 })
    createMission(seedDb, { userId: 1, deviceId: 1, createdBy: 'agent', convoId: 'c1', title: 'harbour lantern export' })
    seedDb.close()

    const fe = fakeEmbedder()
    let queries = 0
    const gated = {
      ...fe,
      embedDocs: async (texts) => { await gate; return fe.embedDocs(texts) },
      embedQuery: async (text) => { queries++; return fe.embedQuery(text) },
    }
    const t = await startTestServer({ dbPath, embedder: gated })
    try {
      const { token } = createAgent(t.db, 1, 'box-a')
      const during = (await t.http('/search/all?q=harbour+lantern+export', { token })).json
      assert.equal(during.semantic, 'indexing')
      assert.equal(during.results.length > 0, true, 'lexical results still come back')
      assert.equal(queries, 0, 'the similar tier does not run while indexing')

      release()
      let body
      for (let i = 0; i < 40; i++) {
        body = (await t.http('/search/all?q=lantern+for+a+boat', { token })).json
        if (body.semantic === 'ready') break
        await new Promise((r) => setTimeout(r, 50))
      }
      assert.equal(body.semantic, 'ready')
      assert.ok(queries > 0, 'the similar tier runs once ready')
    } finally { release(); await t.close() }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
