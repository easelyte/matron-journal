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
non-zero if any gate fails.

`npm test` runs a 2-second, 3-agent/15-convo smoke variant
(`test/load-test.smoke.test.js`) as a standalone regression check that the
tool itself works — it is not a substitute for the runs below.

## Hardware / environment context

Both runs below were executed on **devbox.example.com**, the dev box this
report lives on — not dedicated benchmarking hardware, and the server and
load generator run **in the same Node process** (single event loop), so the
event-loop-lag numbers reflect combined generator + server overhead, not
server-only overhead.

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
| append latency p50 / p95 / p99 / max | 0.77ms / 3.56ms / **49.4ms** / 396.5ms (n=5136) |
| ephemeral coalescing (hot convo) | sent 1695, received 315 → ratio **0.186** (~5.25 delivered/s, matches the ≤~5 frames/s coalescing design) |
| activity ephemerals | sent 29, received 29 (no coalescing pressure at 1/s) |
| cold-client replay | target seq 2764, replayed 2483 events in 31.4ms → **79,175 events/s**, completed |
| event-loop lag p50 / p95 / p99 / max | 2.12ms / **2.64ms** / 3.69ms / 395.8ms |
| memory RSS before / after | 87.7MB / 97.6MB (Δ +9.9MB) |
| head_seq final / journal rows | 5435 / 5435 |
| provisioning time | 388.7ms (1 user, 10 agent devices, 3 client devices, 300 conversations) |

Gates: **appendP99 PASS** (49.4ms ≤ 250ms), **eventLoopP95 PASS** (2.64ms ≤
200ms), **replayStarvation PASS** (during-cold-replay p99 was 5.95ms over 4
samples vs. 20.4ms pre-cold p99 — no elevation).

Observation (not a gate failure, reported per the honesty requirement): a
single append landed at 396.5ms, and the event-loop-lag max for the whole
run was 395.8ms — the two numbers track each other closely, which points to
one isolated event-loop-blocking pause (most likely a V8 GC pause or a
SQLite WAL auto-checkpoint under sustained write load) rather than a
systemic problem. The `preCold` bucket independently shows its own isolated
278ms max with a p99 of only 20.4ms, i.e. this pattern (one rare outlier,
otherwise tight percentiles) shows up on *both* halves of the run,
including the half before the cold client ever connects — so it is not
replay-induced. p99 stays two orders of magnitude under the 250ms gate
either way.

## Run 2: 5-minute soak

Command: `node tools/load-test.js --duration=300 --agents=10 --convos=300 --cold-at=0.5`

| metric | value |
|---|---|
| append latency p50 / p95 / p99 / max | 0.89ms / 8.71ms / **61.4ms** / 3732.5ms (n=24391) |
| ephemeral coalescing (hot convo) | sent 7857, received 1506 → ratio **0.192** (~5.02 delivered/s) |
| activity ephemerals | sent 142, received 142 |
| cold-client replay | target seq 13793, replayed 13784 events in 113.8ms → **121,132 events/s**, completed |
| event-loop lag p50 / p95 / p99 / max | 2.12ms / **3.06ms** / 6.85ms / 3569.4ms |
| memory RSS before / after | 88.0MB / 92.5MB (Δ +4.6MB) |
| head_seq final / journal rows | 25822 / 25822 |
| provisioning time | 1352.4ms (1 user, 10 agent devices, 3 client devices, 300 conversations) |

Gates: **appendP99 PASS** (61.4ms ≤ 250ms), **eventLoopP95 PASS** (3.06ms ≤
200ms), **replayStarvation PASS** (during-cold-replay p99 was 9.5ms over 9
samples vs. 32.0ms pre-cold p99 — no elevation; cold replay itself took
113.8ms end-to-end and did not visibly delay other traffic).

### Concern worth flagging honestly (does not fail a gate)

The soak run's **max** append latency was 3732.5ms, and the **max**
event-loop lag for the same run was 3569.4ms — again closely tracking each
other, and again present on *both* halves of the run independent of the
cold client (`preCold` max 731.3ms, `postCold` max 3732.5ms, `duringCold`
max only 9.5ms over 9 samples). So this is not cold-client-replay
starvation; it's some other periodic full-process stall, and it appears to
scale with run length: the 60s run's biggest stall was ~400ms, the 300s
run's was ~3.7s (roughly proportional to the ~5x growth in total journal
rows/WAL data written, 5435 → 25822).

Given the server and load generator share **one Node process and one
event-loop thread** in this design, and `better-sqlite3` is a *synchronous*
binding (every statement, including SQLite's automatic WAL checkpoint,
executes inline and blocks that single thread until it returns), the most
likely explanation is a SQLite WAL auto-checkpoint (`wal_autocheckpoint`
defaults to every ~1000 dirty pages, `src/db.js` doesn't override it)
firing inside a write and blocking the entire event loop — server request
handling included — until the checkpoint's fsync/flush completes. That
would explain both why append latency and event-loop lag spike in lockstep,
and why the stall gets worse as more WAL data has accumulated between
checkpoints on a longer run.

This was not investigated further or fixed here (out of scope for this
task, and it would touch server code) — but it's worth a follow-up with
proper profiling (e.g. correlate stall timing against WAL file size, or try
a smaller `wal_autocheckpoint` / explicit periodic `PASSIVE` checkpoint)
before treating multi-hour production traffic at this rate as safe. At the
tested durations/rates the tail (p99) stays well inside the 250ms gate, so
this is a latent tail-risk, not a failing measurement.

## Sanity-gate verdict

| gate | 60s run | 5-min soak | verdict |
|---|---|---|---|
| append p99 ≤ 250ms | 49.4ms | 61.4ms | **PASS** |
| event-loop p95 ≤ 200ms | 2.64ms | 3.06ms | **PASS** |
| replay does not starve live traffic | no elevation during replay | no elevation during replay | **PASS** |

All three sanity gates pass on both runs. The one thing worth carrying
forward is the isolated multi-hundred-ms-to-multi-second stall discussed
above (max, not p99/p95) that appears on longer runs and tracks 1:1 between
append latency and event-loop lag — most likely a synchronous SQLite WAL
checkpoint blocking the shared event loop. It doesn't fail any gate at
these durations/rates, but it's a real, reproducible signal, not noise, and
is called out here rather than buried in the JSON.
