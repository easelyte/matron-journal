# Load test results

`tools/load-test.js` is the spec §12 load test: "synthetic publisher
replicating the worst observed traffic — ~40 deltas/s per session, 10
concurrent sessions, 300 conversations/user — validating coalescing rates
and append latency."

It spawns its own in-process server (`startServer`, temp SQLite DB under
`/tmp`, random port) — it never touches a running deployment. Provisioning
(1 user, 10 agent devices, 3 client devices, 300 conversations) goes
directly through the same `src/auth.js` / `src/journal.js` functions the
admin CLI and HTTP layer use, against the server's own db handle. See the
file's top-of-file comment for the full traffic-mix design.

Two measurement-integrity properties worth knowing:

- **Replay accounting is exact.** Every frame on the cold-client socket is
  counted from the moment the socket opens (the frame listener is attached
  *before* hello is sent), because the server emits `hello_ok` plus up to a
  full replay batch synchronously — frames landing in the same TCP read
  would be silently dropped by a listener attached after the hello await.
  A cursor-0 replay delivers every seq `1..helloSeq` in order, so on a
  completed replay `eventsReplayed === helloSeq` must hold exactly; the
  summary carries a `replay.reconciles` boolean asserting it.
- **Gates cannot pass vacuously.** While the cold replay is in flight, a
  probe train fires a publish every 5ms (first one synchronously at connect
  start) so the during-replay latency bucket always has samples even for a
  replay window of a few ms. Any gate whose sample set is empty FAILS with
  reason `insufficient_data` instead of passing by default.

## How to run

```
npm ci
node tools/load-test.js                          # 60s default run, 10 agents, 300 convos
node tools/load-test.js --duration=300            # 5-minute soak
node tools/load-test.js --duration=60 --agents=10 --convos=300 --cold-at=0.5 --json-out=/tmp/result.json
```

Flags: `--duration=<seconds>` (default 60), `--agents=<N>` (default 10),
`--convos=<N>` (default 300), `--cold-at=<0..1>` (fraction of the run at
which the cold client connects, default 0.5), `--port=<N>` (default 0,
OS-assigned), `--json-out=<path>` (also write the JSON summary to a file),
`--keep-db` (skip deleting the temp DB dir, for post-hoc inspection).

Output: a human-readable table followed by `=== JSON SUMMARY ===` and the
machine-readable JSON (also written to `--json-out` if given). Exit code is
non-zero if any gate fails (including `insufficient_data`).

`npm test` runs a 2-second, 3-agent/15-convo smoke variant
(`test/load-test.smoke.test.js`) that asserts every gate's `.ok === true`
and that the replay count reconciles exactly — a standalone regression
check that the tool itself works, not a substitute for the runs below.

## Hardware / environment context

Both runs below were executed on **devbox.example.com**, the dev box this
report lives on — not dedicated benchmarking hardware.

**Measurement bias, stated plainly:** the server and the load generator run
in the **same Node process on one shared event-loop thread**. This inflates
*every* reported number, not just event-loop lag: an append-latency sample
spans generator-side send scheduling, server-side processing, and
generator-side receive handling, all competing for the same thread. All
numbers in this report are therefore **conservative/pessimistic for the
server alone** — a server on its own event loop would do no worse than
this, and likely better.

- CPU: Intel Core i5-13500 (13th Gen), 20 logical CPUs (14 cores, HT)
- RAM: 62 GiB total (box was otherwise lightly loaded during both runs)
- OS: Ubuntu 24.04, kernel 6.8.0-134-generic
- Node: v22.23.1
- Disk: local SSD (`/`, ext4-on-mdraid), temp DB under `/tmp` on the same volume
- Note: `monitorEventLoopDelay({resolution: 20})` (the obvious default)
  showed a ~20ms floor on this box even fully idle (verified with a bare
  3-second idle-process baseline) — almost certainly virtualization/cgroup
  timer granularity, not real event-loop pressure. The tool uses
  `resolution: 2` instead, which drops the idle floor to ~2ms and makes real
  load-induced lag actually visible in the numbers below.

## Run 1: 60 seconds

Command: `node tools/load-test.js --duration=60 --agents=10 --convos=300 --cold-at=0.5`

| metric | value |
|---|---|
| append latency p50 / p95 / p99 / max | 0.70ms / 2.92ms / **45.8ms** / 562.9ms (n=5239) |
| ephemeral coalescing (hot convo) | sent 1704, received 317 → ratio **0.186** (~5.3 delivered/s, matches the ≤~5 frames/s coalescing design) |
| activity ephemerals | sent 29, received 29 (no coalescing pressure at 1/s) |
| cold-client replay | target seq 2776, replayed **2776 (reconciles exactly)** in 24.1ms → **114,988 events/s**, completed |
| event-loop lag p50 / p95 / p99 / max | 2.12ms / **2.56ms** / 2.97ms / 381.7ms |
| memory RSS before / after | 85.6MB / 92.5MB (Δ +6.9MB) |
| head_seq final / journal rows | 5537 / 5537 |
| provisioning time | 662.3ms (1 user, 10 agent devices, 3 client devices, 300 conversations) |

Gates: **appendP99 PASS** (45.8ms ≤ 250ms, n=5239), **eventLoopP95 PASS**
(2.56ms ≤ 200ms), **replayStarvation PASS** (during-cold-replay p99 was
6.7ms over 4 samples vs. 48.9ms pre-cold p99 — no elevation).

Replay reconciliation: `eventsReplayed (2776) === helloSeq (2776)` — every
journal row that existed at hello time was delivered exactly once. (An
earlier version of this tool reported a ~10% undercount here; that was a
measurement bug — the counting listener was attached after the hello await,
dropping frames the server had emitted synchronously in the same TCP read
as `hello_ok` — not a server-side delivery gap. Fixed by attaching the
listener before hello is sent.)

Observation (not a gate failure, reported per the honesty requirement): a
single append landed at 562.9ms, and the event-loop-lag max for the whole
run was 381.7ms — isolated stalls in an otherwise tight distribution
(p99 45.8ms, p95 2.9ms). The `preCold` bucket shows its own isolated
329.4ms max with a p99 of 48.9ms — i.e. rare outliers appear on both
halves of the run, including before the cold client ever connects, so they
are not replay-induced. See the soak run below for the fuller picture.

## Run 2: 5-minute soak

Command: `node tools/load-test.js --duration=300 --agents=10 --convos=300 --cold-at=0.5`

| metric | value |
|---|---|
| append latency p50 / p95 / p99 / max | 0.92ms / 3.37ms / **34.1ms** / 751.1ms (n=26179) |
| ephemeral coalescing (hot convo) | sent 8588, received 1607 → ratio **0.187** (~5.3 delivered/s) |
| activity ephemerals | sent 148, received 148 |
| cold-client replay | target seq 14056, replayed **14056 (reconciles exactly)** in 255.6ms → **54,984 events/s**, completed |
| event-loop lag p50 / p95 / p99 / max | 2.14ms / **2.74ms** / 4.73ms / 660.1ms |
| memory RSS before / after | 85.2MB / 93.7MB (Δ +8.4MB) |
| head_seq final / journal rows | 27662 / 27662 |
| provisioning time | 1304.7ms (1 user, 10 agent devices, 3 client devices, 300 conversations) |

Gates: **appendP99 PASS** (34.1ms ≤ 250ms, n=26179), **eventLoopP95 PASS**
(2.74ms ≤ 200ms), **replayStarvation PASS** (during-cold-replay p99 was
17.4ms over 49 probe-train samples vs. 16.4ms pre-cold p99 — a mild bump
during the 255.6ms replay window, far under both the 2x-elevation and
absolute thresholds).

Replay reconciliation: `eventsReplayed (14056) === helloSeq (14056)` —
exact, same as run 1. The 14k-row replay completed in 255.6ms while all 10
agents kept publishing; the during-replay probe train (49 samples at 5ms
cadence) shows worst-case append latency of 17.4ms during that window —
replay demonstrably does not starve live traffic.

### Concern worth flagging honestly (does not fail a gate)

Both runs show rare, isolated stalls where the **max** append latency and
the **max** event-loop lag spike together: this soak's worst append was
751.1ms against a loop-lag max of 660.1ms; run 1's worst was 562.9ms against
381.7ms; and an earlier 5-minute soak of the same load profile (run before
a replay-*counting* fix that did not touch the latency probe path, so the
observation stands) recorded a 3.7s append max tracking a 3.6s loop-lag
max. The pattern is consistent: tight percentiles (p99 well under 100ms in
every run), then one or two extreme outliers whose magnitude closely
matches the loop-lag max of the same run, appearing on both halves of the
run independent of the cold client (`duringCold` max never exceeded 17.4ms).

So this is not cold-replay starvation; it's some other whole-process pause,
variable across runs (hundreds of ms to multi-second). Given the server and
generator share **one Node process and one event-loop thread**, and
`better-sqlite3` is a *synchronous* binding (every statement, including
SQLite's automatic WAL checkpoint, executes inline and blocks that thread
until it returns), the leading suspect is a WAL auto-checkpoint
(`wal_autocheckpoint` defaults to every ~1000 dirty pages; `src/db.js`
doesn't override it) firing inside a write and stalling the event loop —
server handling included — for the duration of its flush. A V8 major GC is
the other candidate. Either would explain the 1:1 append/loop-lag coupling.

This was not investigated further or fixed here (out of scope for this
task, and a fix would touch server code) — but it deserves a follow-up with
proper profiling (correlate stall timing against WAL file size; try a
smaller `wal_autocheckpoint` or an explicit periodic `PASSIVE` checkpoint;
run the generator out-of-process to remove its share of the blame) before
treating multi-hour production traffic at this rate as safe. At the tested
durations/rates the tail (p99) stays comfortably inside the 250ms gate.

## Sanity-gate verdict

| gate | 60s run | 5-min soak | verdict |
|---|---|---|---|
| append p99 ≤ 250ms | 45.8ms (n=5239) | 34.1ms (n=26179) | **PASS** |
| event-loop p95 ≤ 200ms | 2.56ms | 2.74ms | **PASS** |
| replay does not starve live traffic | during-replay p99 6.7ms | during-replay p99 17.4ms (49 samples) | **PASS** |
| replay count reconciles (`eventsReplayed === helloSeq`) | 2776 = 2776 | 14056 = 14056 | **PASS (exact)** |

All gates pass on both runs, with non-vacuous sample counts throughout
(empty sample sets now fail with `insufficient_data` by construction). The
one item worth carrying forward is the isolated whole-process stall
discussed above — real and reproducible across runs (max 563ms–3.7s
depending on the run), tracking 1:1 between append latency and event-loop
lag, most plausibly a synchronous SQLite WAL checkpoint on the shared
thread. It never breaches the p99 gate at these durations, but it is a
genuine tail-risk signal, called out here rather than buried in the JSON.
