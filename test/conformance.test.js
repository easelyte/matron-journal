// Protocol conformance suite (spec §12).
//
// Replays every golden fixture in test/fixtures/conformance/*.json against a
// fresh, real, in-process journal server through the replay coordinator
// (tools/conformance/coordinator.js). This Node runner plays the `client` role
// through its own actor; the coordinator plays the agent and admin roles. The
// fixture format, the roles and the matcher are documented in
// test/fixtures/conformance/README.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootFixtureServer } from '../tools/conformance/server.js'
import { createActor, MODEL_CAPABILITIES } from '../tools/conformance/actor.js'
import { replayFixture } from '../tools/conformance/coordinator.js'

export { match } from '../tools/conformance/matcher.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'conformance')

const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json')).sort()

test('at least one conformance fixture is present', () => {
  assert.ok(files.length > 0, `no *.json fixtures found in ${FIXTURES_DIR}`)
})

// Every fixture gets its own server on its own database, so they run side by
// side (a few at a time: password hashing is CPU-heavy and the expectations have
// a 2 s timeout).
test('conformance fixtures', { concurrency: 3 }, async (t) => {
  const runs = []
  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'))
    runs.push(t.test(`conformance: ${fixture.name} (${file})`, async (st) => {
      const booted = await bootFixtureServer(fixture)
      st.after(() => booted.close())
      const runner = createActor({ base: booted.base })
      st.after(() => runner.close())
      const result = await replayFixture({
        fixture, base: booted.base, bindings: booted.bindings, control: booted.control,
        runner, play: ['client'],
      })
      // A skip is a failure here, unless the only thing missing is an app-model
      // hook (set_app_state, expect_model, expect_notification) that this
      // server-side runner has no app to provide.
      if (result.status === 'skip' && result.missing.every((k) => MODEL_CAPABILITIES.includes(k))) return st.skip(result.reason)
      assert.equal(result.status, 'pass', result.error ?? result.reason)
    }))
  }
  await Promise.all(runs)
})
