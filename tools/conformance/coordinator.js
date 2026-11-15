// The replay coordinator. Runs every step of a fixture and plays every actor
// the platform under test does not: admin, agent and any other client. A
// platform runner (in process, or another process behind stdio-runner.js)
// performs only the steps of the actors it plays, and reports each result and
// any bindings the step recorded.
//
// Each actor (role, plus client name for a client) is a lane. Steps in one lane
// run in order. With the barrier on (the default), a step also waits for every
// earlier step in the other lanes to finish, whichever role ran it, so a
// frame an agent step causes is in flight before the client step that expects
// it, and a binding one lane records exists before another lane refers to it.
// The barrier is conservative: it orders against every earlier cross-lane step
// rather than working out which ones a step really depends on.
import { actorKey, validateFixture } from './schema.js'
import { createActor, capabilityFor } from './actor.js'

// opts:
//   fixture, base, bindings (from the seed), control (admin channel)
//   runner:  the platform runner ({ capabilities, run(step, bindings, { index }), close }), or null
//   play:    which lanes the runner plays: 'client' (every client) or 'client:<name>'
//   barrier: cross-lane ordering, default true
//   clientProtocol: the protocol revision the client under test declares; a
//            fixture whose `since` is greater is skipped
//   collect: an object that receives what each step observed, by step index
//
// Resolves to { status: 'pass' } or { status: 'skip', reason } or
// { status: 'invalid', error } or { status: 'fail', failedStep, error, failures }.
// A skip names the step kinds nobody could perform in `missing`.
export async function replayFixture(opts) {
  const { fixture, base, control, runner = null, play = [], barrier = true, clientProtocol = Infinity, collect = null } = opts
  const schemaErrors = validateFixture(fixture)
  if (schemaErrors.length) return { status: 'invalid', error: `fixture does not match the schema: ${schemaErrors.join('; ')}` }

  const since = fixture.since ?? 1
  if (since > clientProtocol) return { status: 'skip', reason: `fixture is since ${since}, client protocol is ${clientProtocol}` }

  const builtin = createActor({ base, control })
  // The coordinator has no client clock to advance: a fixture that moves the
  // clock needs a runner that plays that client.
  const builtinCaps = new Set([...builtin.capabilities, ...(control ? ['admin'] : [])])
  builtinCaps.delete('advance_clock')
  const plays = (key) => runner !== null && (play.includes('client') ? key === 'client' || key.startsWith('client:') : play.includes(key))
  const executorFor = (key) => (plays(key) ? runner : builtin)
  const capsFor = (key) => (plays(key) ? runner.capabilities : builtinCaps)

  const laneOf = fixture.steps.map(actorKey)
  const badPlay = play.filter((p) => !/^client(:[^:]+)?$/.test(p) || (p !== 'client' && !laneOf.includes(p)))
  if (badPlay.length || (runner !== null && play.length === 0)) {
    await builtin.close()
    return { status: 'invalid', error: badPlay.length ? `--play names no client lane of this fixture: ${badPlay.join(', ')}` : 'a runner was given but no lane for it to play (--play)' }
  }
  const lanes = new Map()
  laneOf.forEach((key, i) => {
    if (!lanes.has(key)) lanes.set(key, [])
    lanes.get(key).push(i)
  })

  const missing = []
  for (const [i, s] of fixture.steps.entries()) {
    const need = capabilityFor(s.kind)
    if (!capsFor(laneOf[i]).has(need) && !missing.some((m) => m.kind === s.kind)) {
      missing.push({ kind: s.kind, step: i, by: plays(laneOf[i]) ? 'the runner' : `the coordinator (${laneOf[i]})` })
    }
  }
  if (missing.length) {
    await builtin.close()
    return {
      status: 'skip',
      missing: missing.map((m) => m.kind),
      reason: missing.map((m) => `${m.by} cannot perform '${m.kind}' (step ${m.step})`).join('; '),
    }
  }

  const bindings = { ...opts.bindings }
  const done = fixture.steps.map(() => { let res; const p = new Promise((r) => { res = r }); return { p, res } })
  let aborted = false
  let abort
  const abortP = new Promise((r) => { abort = r })
  const failures = []

  await Promise.allSettled([...lanes.entries()].map(async ([key, idxs]) => {
    const exec = executorFor(key)
    for (const i of idxs) {
      if (aborted) return
      if (barrier) {
        const deps = []
        for (let j = 0; j < i; j++) if (laneOf[j] !== key) deps.push(done[j].p)
        await Promise.race([Promise.all(deps), abortP])
        if (aborted) return
      }
      try {
        const r = await exec.run(fixture.steps[i], { ...bindings }, { index: i })
        Object.assign(bindings, r.bindings)
        if (collect) collect[i] = r.observed ?? {}
        done[i].res()
      } catch (e) {
        failures.push({ index: i, error: `step[${i}] (${fixture.steps[i].kind}): ${e.message}` })
        aborted = true
        abort()
        return
      }
    }
  }))
  await builtin.close()
  if (!failures.length) return { status: 'pass' }
  failures.sort((a, b) => a.index - b.index)
  return { status: 'fail', failedStep: failures[0].index, error: failures[0].error, failures }
}
