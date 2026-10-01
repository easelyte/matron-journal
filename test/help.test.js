import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { HELP_TEXT } from '../src/help.js'

test('GET /help serves the API digest to authenticated devices only', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'hunter22')
  const ag = createAgent(s.db, dan.id, 'dev-2')

  // Unauthenticated callers get the same 401 as the rest of the surface.
  assert.equal((await s.http('/help', {})).status, 401)

  const r = await fetch(s.base + '/help', {
    headers: { authorization: `Bearer ${ag.token}` },
  })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /text\/markdown/)
  const body = await r.text()
  assert.equal(body, HELP_TEXT)

  // The digest must at least name the discovery surface it exists to expose.
  assert.match(body, /GET \/search\?q=/)
  assert.match(body, /around_seq/)
  assert.match(body, /GET \/items\?scope=shared/)
  assert.match(body, /GET \/lookup\?user=/)
  assert.match(body, /GET \/me\b.*is_admin/)

  // Final review, I3: /help and docs/protocol.md must agree about missions.
  // A bridge session arrives with a token and no checkout, so every mission
  // route it can call — and the item fields the feature added — have to be
  // named here, not only in the repo's protocol doc.
  for (const route of [
    'POST /missions', 'GET /missions?state=', 'GET /missions/:id', 'PATCH /missions/:id',
    'POST /missions/:id/join', 'POST /missions/:id/close', 'POST /milestones', 'GET /milestones?convo=',
    'GET /coordinator', 'GET /memories', 'PUT /memories/:name', 'DELETE /memories/:name',
    'POST /missions/:id/leave', 'GET /conversations/:id/missions', 'POST /projects', 'GET /projects?state=',
    'GET /projects/:id', 'PATCH /projects/:id', 'POST /projects/:id/close', 'POST /projects/:id/merge',
  ]) assert.ok(body.includes(route), `/help must name ${route}`)
  assert.match(body, /attach: false/)
  // Mission status (spec 2026-09-28 missions dashboard §1): a bridge session
  // learns the field, its clear, its attribution and the marker flag here.
  assert.ok(body.includes('status?: string|null'), '/help must document PATCH /missions/:id {status}')
  for (const field of ['status_by', 'status_convo_id', 'status_updated_at', 'status_changed']) {
    assert.ok(body.includes(field), `/help must name ${field}`)
  }
  for (const field of ['mission_id', 'mission_num', 'mission: id|"#num"|null']) {
    assert.ok(body.includes(field), `/help must name ${field}`)
  }

  // Fix round 2, minor 3: the two answers an agent cannot guess from the
  // route list — POST /missions 404s when the conversation's existing mission
  // is one it cannot see, and a CLOSED mission is still a legal move target
  // for PATCH /items/:id {mission}.
  assert.match(body, /404 if that existing\s+mission is one you cannot see/)
  assert.match(body, /CLOSED mission is still a legal target/)

  // Spec 2026-09-30 projects & mission links: the answers a bridge cannot
  // guess — join no longer refuses, how to name a mission on a milestone,
  // the leave fallback, the activity vocabulary and who may close/merge.
  // `other_missions` is a legitimate new field, so this must not be a plain
  // substring check (D2) — \b keeps it from matching `other_missions`.
  assert.equal(/other_mission\b/.test(body), false, '/help must not document the retired 409')
  for (const s of ['not_linked', 'current_changed', 'project_changed', 'mission_count', 'subchats=1',
    'running|waiting|idle|quiet', 'not_coordinator', 'open_missions', 'merged_from', 'project: id|"#n"|n|null']) {
    assert.ok(body.includes(s), `/help must name ${s}`)
  }
})
