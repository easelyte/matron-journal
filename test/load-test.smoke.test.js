import test from 'node:test'
import assert from 'node:assert/strict'
import { runLoadTest, formatReport } from '../tools/load-test.js'

// Standalone smoke test for tools/load-test.js (spec §12 load-test tool):
// a short, small-scale run should complete cleanly and produce a
// well-formed summary. The full-scale 60s/5min runs are executed manually
// (see docs/load-test-results.md), not as part of `npm test`.
test('load-test tool: a short run completes and produces a well-formed summary', { timeout: 20000 }, async () => {
  const summary = await runLoadTest({
    durationMs: 2000,
    numAgents: 3,
    numConvos: 15,
    coldConnectFraction: 0.5,
    drainMs: 800,
  })

  assert.equal(typeof summary.headSeqFinal, 'number')
  assert.ok(summary.headSeqFinal > 0, 'expected some journal events to have been appended')
  assert.equal(summary.provisioning.numAgentDevices, 3)
  assert.equal(summary.provisioning.numClientDevices, 3)
  assert.equal(summary.provisioning.numConversations, 15)

  assert.ok(summary.appendLatencyMs.count > 0, 'expected at least one append-latency sample')
  assert.ok(summary.appendLatencyMs.p50 >= 0)

  assert.ok(summary.ephemeral.streamSent > 0, 'expected the hot agent to have sent stream ephemerals')
  assert.ok(summary.ephemeral.streamReceived <= summary.ephemeral.streamSent, 'coalescing must never deliver more than was sent')

  // Replay accounting must reconcile EXACTLY: a completed cursor-0 replay
  // delivers every seq 1..helloSeq once, so eventsReplayed === helloSeq.
  assert.equal(summary.replay.completed, true, 'cold client should finish its replay within the run+drain window')
  assert.equal(summary.replay.eventsReplayed, summary.replay.helloSeq,
    'cold-client replay count must equal the hello_ok head seq exactly')
  assert.equal(summary.replay.reconciles, true)
  assert.ok(summary.replay.throughputEventsPerSec >= 0)

  // The probe train must have produced during-cold samples — a starvation
  // gate that cannot be assessed (insufficient_data) is a failure.
  assert.ok(summary.appendLatencyByPhaseMs.duringCold.count > 0,
    'probe train should guarantee at least one during-cold-replay latency sample')

  assert.ok(summary.eventLoopLagMs.p95 >= 0)
  assert.ok(summary.memory.rssBeforeMb > 0)
  assert.ok(summary.memory.rssAfterMb > 0)

  // Gates must actually PASS (.ok === true), not merely exist — asserting
  // object truthiness would let a failing or vacuous gate slip through.
  assert.equal(summary.gates.appendP99.ok, true,
    `appendP99 gate failed: ${JSON.stringify(summary.gates.appendP99)}`)
  assert.equal(summary.gates.eventLoopP95.ok, true,
    `eventLoopP95 gate failed: ${JSON.stringify(summary.gates.eventLoopP95)}`)
  assert.equal(summary.gates.replayStarvation.ok, true,
    `replayStarvation gate failed: ${JSON.stringify(summary.gates.replayStarvation)}`)

  // formatReport must not throw on a real summary shape.
  const report = formatReport(summary)
  assert.match(report, /matron-journal load test/)
})
