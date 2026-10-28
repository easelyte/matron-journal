import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { ensurePeopleConvo } from '../src/people-convo.js'
import { expireGrantAsks, backfillGrantSent } from '../src/grants.js'
import { OWN_ASK_TTL_MS } from '../src/contacts.js'
import { onGrantAskExpired } from '../src/sharing-events.js'

// A grantee is never told of an ask its owner did not approve (docs/protocol.md
// "Grants"): not while it waits, and not after it ends — declined by the
// owner, expired, revoked, or refused at the approval. Its id is a 404 for
// them, it is in none of their lists, and nothing about it reaches their
// People log or their sockets. The same for a raise of an active share that
// ends before the owner approved it: the grantee sees the share exactly as
// it was.
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const post = (body) => ({ method: 'POST', body })
const BRIEF = 'Where it stands, and what is next.'

async function world(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const bob = await createUser(s.db, 'bob', 'pw')
  const aliceBox = createAgent(s.db, alice.id, 'alice-box')
  upsertConversation(s.db, { id: 'work', ownerUserId: alice.id, title: 'Work', agentDeviceId: aliceBox.deviceId })
  const login = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: `${name}-phone` } })).json.token
  const alicePhone = await login('alice')
  const bobPhone = await login('bob')
  const bobSocket = await makeWsClient(s.base, { token: bobPhone, cursor: null })
  await bobSocket.waitFor((f) => f.op === 'hello_ok')
  t.after(() => bobSocket.close())
  const http = (token) => (p, opts = {}) => s.http(p, { token, ...opts })
  const w = { s, alice, bob, bobSocket, aliceBox: http(aliceBox.token), alicePhone: http(alicePhone), bobPhone: http(bobPhone) }
  const r = await w.alicePhone('/contacts', post({ user: 'bob' }))
  const theirs = (await w.bobPhone('/contacts')).json.contacts[0]
  await w.bobPhone(`/contacts/${theirs.id}/answer`, post({ decision: 'approve' }))
  w.aliceContact = r.json.contact.id
  return w
}

const mission = async (w, title = 'Launch') => (await w.aliceBox('/missions', post({ convo_id: 'work', title, attach: false }))).json.mission

// Everything bob could learn of grant `id`: its own route, every list, his
// People log, and the frames his phone received.
async function assertUnseen(w, id, label, { history = [] } = {}) {
  assert.equal((await w.bobPhone(`/grants/${id}`)).status, 404, `${label}: the id is a 404`)
  for (const q of ['', '?direction=in', ...['awaiting_owner', 'pending', 'active', 'declined', 'revoked', 'expired'].flatMap((st) => [`?state=${st}`, `?direction=in&state=${st}`])]) {
    assert.ok(!(await w.bobPhone(`/grants${q}`)).json.grants.some((g) => g.id === id), `${label}: not in /grants${q}`)
  }
  const activity = (await w.bobPhone('/contacts')).json.contacts.map((c) => c.id)
  // `history`: the events of an earlier ask on the same row that did reach bob.
  for (const c of activity) {
    const named = (await w.bobPhone(`/contacts/${c}/activity`)).json.events.filter((e) => e.grant_id === id).map((e) => e.event)
    assert.deepEqual(named.sort(), [...history].sort(), `${label}: not in bob's activity`)
  }
  await settle()
  assert.ok(!JSON.stringify(w.bobSocket.frames).includes(id), `${label}: no frame names it`)
  assert.equal((await w.bobPhone(`/grants/${id}/answer`, post({ decision: 'approve' }))).status, 404, `${label}: not answerable`)
  assert.equal((await w.bobPhone(`/grants/${id}`, { method: 'DELETE' })).status, 404, `${label}: not revocable`)
}

test('a read share the owner declined, revoked or let expire is never shown to the grantee', async (t) => {
  const w = await world(t)
  const declined = (await w.aliceBox(`/missions/${(await mission(w, 'One')).id}/shares`, post({ contact: 'bob', convo_id: 'work' }))).json.grant
  assert.equal((await w.alicePhone(`/grants/${declined.id}/answer`, post({ decision: 'decline' }))).json.grant.state, 'declined')
  await assertUnseen(w, declined.id, 'declined by the owner')

  const revoked = (await w.aliceBox(`/missions/${(await mission(w, 'Two')).id}/shares`, post({ contact: 'bob', convo_id: 'work' }))).json.grant
  assert.equal((await w.alicePhone(`/grants/${revoked.id}`, { method: 'DELETE' })).json.grant.state, 'revoked')
  await assertUnseen(w, revoked.id, 'revoked before approval')

  const expired = (await w.aliceBox(`/missions/${(await mission(w, 'Three')).id}/shares`, post({ contact: 'bob', convo_id: 'work' }))).json.grant
  for (const r of expireGrantAsks(w.s.db, Date.now() + OWN_ASK_TTL_MS + 1000)) onGrantAskExpired({ db: w.s.db, hub: w.s.hub }, r)
  assert.equal((await w.alicePhone(`/grants/${expired.id}`)).json.grant.state, 'expired')
  await assertUnseen(w, expired.id, 'expired')

  // The owner still sees all three.
  assert.equal((await w.alicePhone('/grants?state=declined')).json.grants.length, 1)
  // A share that did reach bob, and that he declined, stays his to see.
  const sent = (await w.alicePhone(`/missions/${(await mission(w, 'Four')).id}/shares`, post({ contact: 'bob' }))).json.grant
  assert.equal((await w.bobPhone(`/grants/${sent.id}/answer`, post({ decision: 'decline' }))).status, 200)
  assert.equal((await w.bobPhone(`/grants/${sent.id}`)).status, 200)
  assert.ok((await w.bobPhone('/grants?state=declined')).json.grants.some((g) => g.id === sent.id))
})

test('a hand-over ask that ends before the owner approves is never shown to the grantee', async (t) => {
  const w = await world(t)
  const m1 = await mission(w, 'One')
  const declined = (await w.aliceBox(`/missions/${m1.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, convo_id: 'work' }))).json.grant
  await w.alicePhone(`/grants/${declined.id}/answer`, post({ decision: 'decline' }))
  await assertUnseen(w, declined.id, 'hand-over declined by the owner')

  // Refused at the approval: the mission closed meanwhile.
  const m2 = await mission(w, 'Two')
  const refused = (await w.aliceBox(`/missions/${m2.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, convo_id: 'work' }))).json.grant
  await w.alicePhone(`/missions/${m2.id}/close`, post({ summary: 'done' }))
  assert.equal((await w.alicePhone(`/grants/${refused.id}/answer`, post({ decision: 'approve' }))).status, 409)
  await assertUnseen(w, refused.id, 'hand-over refused at the approval')

  // A renewed ask on a row bob once saw: once the new ask ends unsent,
  // bob is not told of it either.
  const m3 = await mission(w, 'Three')
  const first = (await w.alicePhone(`/missions/${m3.id}/shares`, post({ contact: 'bob' }))).json.grant
  await w.bobPhone(`/grants/${first.id}/answer`, post({ decision: 'decline' }))
  await settle()
  w.bobSocket.frames.length = 0
  const renewed = (await w.aliceBox(`/missions/${m3.id}/shares`, post({ contact: 'bob', level: 'owner', brief: BRIEF, convo_id: 'work' }))).json.grant
  assert.equal(renewed.id, first.id, 'the same row')
  await w.alicePhone(`/grants/${renewed.id}/answer`, post({ decision: 'decline' }))
  await assertUnseen(w, renewed.id, 'a renewed ask declined by the owner', { history: ['grant.received', 'grant.declined'] })
})

test('a raise refused before the owner approves leaves the grantee\'s share exactly as it was', async (t) => {
  const w = await world(t)
  const m = await mission(w)
  const g = (await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob' }))).json.grant
  await w.bobPhone(`/grants/${g.id}/answer`, post({ decision: 'approve' }))
  const before = (await w.bobPhone(`/grants/${g.id}`)).json.grant
  const ends = [
    ['declined', async () => w.alicePhone(`/grants/${g.id}/answer`, post({ decision: 'decline' }))],
    ['expired', async () => { for (const r of expireGrantAsks(w.s.db, Date.now() + OWN_ASK_TTL_MS + 1000)) onGrantAskExpired({ db: w.s.db, hub: w.s.hub }, r) }],
  ]
  for (const level of ['contribute', 'owner']) {
    for (const [how, end] of ends) {
      await settle(5)
      w.bobSocket.frames.length = 0
      const ask = await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level, convo_id: 'work', ...(level === 'owner' ? { brief: BRIEF } : {}) }))
      assert.equal(ask.status, 202)
      assert.deepEqual((await w.bobPhone(`/grants/${g.id}`)).json.grant, before, `${level} ${how}: unchanged while it waits`)
      await end()
      assert.equal((await w.alicePhone(`/grants/${g.id}`)).json.grant.pending_level, null)
      assert.deepEqual((await w.bobPhone(`/grants/${g.id}`)).json.grant, before, `${level} ${how}: unchanged after`)
      assert.deepEqual((await w.bobPhone('/grants')).json.grants, [before])
      await settle()
      assert.deepEqual(w.bobSocket.frames.filter((f) => f.kind === 'people' || f.kind === 'shared' || f.type === 'people' || f.type === 'permission_request'), [], `${level} ${how}: no frame`)
    }
  }
})

test('the backfill counts as sent exactly the rows that reached the grantee', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const bob = await createUser(db, 'bob', 'pw')
  db.prepare(`INSERT INTO contacts(id,user_id,peer_user,peer_user_id,state,created_at,updated_at) VALUES('ct_a',?,'bob',?,'active',1,1)`).run(alice.id, bob.id)
  const row = (id, state, extra = {}) => db.prepare(`INSERT INTO grants(id,owner_user_id,subject_kind,subject_id,contact_id,level,state,grantee_item_id,revoked_by,answered_at,created_at,updated_at)
    VALUES(?,?,'mission','ms_x'||?,'ct_a','read',?,?,?,?,1,5)`).run(id, alice.id, id, state, extra.item ?? null, extra.by ?? null, extra.answered ?? null)
  row('gr_wait', 'awaiting_owner')
  row('gr_pend', 'pending', { item: 'it_1' })
  row('gr_act', 'active', { item: 'it_2', answered: 3 })
  row('gr_bobno', 'declined', { item: 'it_3', answered: 4 })
  row('gr_aliceno', 'declined', { answered: 4 })
  row('gr_exp', 'expired')
  row('gr_revsent', 'revoked', { item: 'it_4', by: 'owner' })
  row('gr_revunsent', 'revoked', { by: 'owner' })
  row('gr_left', 'revoked', { by: 'grantee' })
  // Sent and ended, but its card for bob was never filed (filing is
  // best-effort): bob's own "received" audit line still says it reached him.
  row('gr_nocard', 'revoked', { by: 'owner' })
  row('gr_nocard2', 'declined', { answered: 4 })
  const people = ensurePeopleConvo(db, bob.id).id
  append(db, { userId: bob.id, convoId: people, sender: 'journal', type: 'people', payload: { event: 'grant.received', grant_id: 'gr_nocard' } })
  append(db, { userId: bob.id, convoId: people, sender: 'journal', type: 'people', payload: { event: 'grant.handover_received', grant_id: 'gr_nocard2' } })
  // A row reused for a later agent ask that ended unsent: bob's receipt is
  // from the earlier ask (older than the new ask's card), so it proves
  // nothing about this one. And an agent ask whose card is missing cannot be
  // dated, so a receipt does not count for it either.
  row('gr_renewed', 'declined', { answered: 9 })
  append(db, { userId: bob.id, convoId: people, sender: 'journal', type: 'people', payload: { event: 'grant.received', grant_id: 'gr_renewed' } })
  const later = Date.now() + 60000
  db.prepare(`INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at,consent)
    VALUES('it_card',?,99,'question','closed',1,'card','c',0,'agent',?,?,'share')`).run(alice.id, later, later)
  db.prepare("UPDATE grants SET requested_by='agent', owner_item_id='it_card' WHERE id='gr_renewed'").run()
  row('gr_undated', 'declined', { answered: 9 })
  append(db, { userId: bob.id, convoId: people, sender: 'journal', type: 'people', payload: { event: 'grant.received', grant_id: 'gr_undated' } })
  db.prepare("UPDATE grants SET requested_by='agent' WHERE id='gr_undated'").run()
  // An agent ask approved and sent: the receipt is newer than its card.
  row('gr_agentsent', 'revoked', { by: 'owner' })
  db.prepare(`INSERT INTO items(id,user_id,num,kind,state,rank,title,origin_convo_id,origin_device_id,created_by,created_at,updated_at,consent)
    VALUES('it_card2',?,98,'question','closed',1,'card','c',0,'agent',0,0,'share')`).run(alice.id)
  db.prepare("UPDATE grants SET requested_by='agent', owner_item_id='it_card2' WHERE id='gr_agentsent'").run()
  append(db, { userId: bob.id, convoId: people, sender: 'journal', type: 'people', payload: { event: 'grant.received', grant_id: 'gr_agentsent' } })
  // A share bob accepted, then an agent raise that was never sent (the code
  // before this column overwrote requested_by and the card ids for it), then
  // revoked: bob had it, and his accept (answered_at, which only a renewal
  // resets) still says so.
  row('gr_raised', 'revoked', { by: 'owner', answered: 3 })
  db.prepare("UPDATE grants SET requested_by='agent', owner_item_id='it_card' WHERE id='gr_raised'").run()
  // A line in someone else's log proves nothing about bob.
  const alicePeople = ensurePeopleConvo(db, alice.id).id
  append(db, { userId: alice.id, convoId: alicePeople, sender: 'journal', type: 'people', payload: { event: 'grant.received', grant_id: 'gr_exp' } })
  db.prepare('UPDATE grants SET sent_at=NULL').run()
  backfillGrantSent(db)
  const sent = db.prepare('SELECT id FROM grants WHERE sent_at IS NOT NULL ORDER BY id').all().map((r) => r.id)
  assert.deepEqual(sent, ['gr_act', 'gr_agentsent', 'gr_bobno', 'gr_left', 'gr_nocard', 'gr_nocard2', 'gr_pend', 'gr_raised', 'gr_revsent'])
})

test('revoking a share with a raise in flight leaves no trace of the raise', async (t) => {
  const w = await world(t)
  const m = await mission(w)
  const g = (await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob' }))).json.grant
  await w.bobPhone(`/grants/${g.id}/answer`, post({ decision: 'approve' }))
  const ask = (await w.aliceBox(`/missions/${m.id}/shares`, post({ contact: 'bob', level: 'contribute', convo_id: 'work' }))).json.grant
  assert.equal(ask.pending_requested_by, 'agent')
  const rev = (await w.alicePhone(`/grants/${g.id}`, { method: 'DELETE' })).json.grant
  assert.equal(rev.state, 'revoked')
  assert.deepEqual([rev.pending_level, rev.pending_state, 'pending_requested_by' in rev], [null, null, false])
  assert.deepEqual(w.s.db.prepare('SELECT pending_by, pending_at FROM grants WHERE id=?').get(g.id), { pending_by: null, pending_at: null })
})
