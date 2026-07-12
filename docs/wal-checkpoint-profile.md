# WAL-checkpoint stall profile (follow-up to load-test-results.md)

Follow-up to the "Concern worth flagging honestly" section of
[load-test-results.md](load-test-results.md): rare, isolated stalls where
the max append latency and max event-loop lag spike together (0.5–3.7s
across historical runs), never touching p99. That section named two
suspects — SQLite's WAL auto-checkpoint executing inline on the
single thread, and V8 major GC — and left attribution open. This document
closes it: method, evidence, attribution, chosen mitigation, and
before/after numbers. Historical numbers in load-test-results.md are
untouched; this is an append-only follow-up.

## Method

`tools/wal-profile.js` (new) reuses the load test's traffic generator
verbatim — same agent mix, hot viewer, live-follower probe observer; no
cold client (the baseline doc already established the stalls appear on both
halves of the run, independent of the cold replay) — and adds the
instrumentation the load test lacks:

- **Per-statement timing with WAL fingerprints.** Every statement,
  transaction, and pragma on the server's db handle is timed; anything
  ≥20ms is logged with the WAL-index state (`mxFrame`/`nBackfill`) before
  and after. SQLite's auto-checkpoint runs inside the COMMIT, so a
  checkpoint stall lands inside exactly one logged entry, and the
  fingerprint is unambiguous: `nBackfill` jumping / `mxFrame` resetting
  *inside that statement's window*.
- **Passive WAL-index observation.** WAL state is read from the `-shm`
  file (offsets per SQLite `wal.c`: `mxFrame` @16, `nBackfill` @96,
  `nBackfillAttempted` @128, native byte order), *never* via
  `PRAGMA wal_checkpoint`, which would itself run a checkpoint and
  contaminate the measurement. A 25ms sampler provides an independent
  checkpoint census and the WAL size bound.
- **GC separation.** `PerformanceObserver('gc')` timestamps every GC with
  kind and duration (no `--expose-gc`). A stall coinciding with a GC
  record and no checkpoint fingerprint is attributed to GC.
- **Loop-stall log with CPU discrimination.** A 10ms-tick timer timestamps
  every event-loop blockage ≥50ms and records process CPU consumed across
  the blockage: cpu ≈ wall means the thread was *busy* (JS/GC/SQLite);
  cpu ≪ wall means it was *blocked* in a syscall (fsync) or descheduled.
- **Out-of-process mode** (`--out-of-proc`): the server runs in a forked
  child, the generator drives it over localhost ws from the parent, and
  generator-side GC/loop stalls are logged separately — the honest split
  the baseline doc asked for. In-process mode is also kept because its
  bias matches the baseline numbers.

Stall accounting: one event-loop blockage delays every probe in flight
(~90 probes/s are), so raw >100ms samples arrive in bursts sharing one
cause. Samples whose in-flight windows overlap are merged into one *stall
event* (cluster); the table reports each cluster once with its worst
sample and sample count. Disclosure: ws.js's cached `deviceExistsStmt`
(prepared before instrumentation attaches) is not timed — it is a
read-only point SELECT and cannot trigger a checkpoint.

Baseline settings confirmed at runtime before profiling:
`journal_mode=wal`, `synchronous=1` (NORMAL), `wal_autocheckpoint=1000`,
`page_size=4096`, `journal_size_limit=-1` (WAL never truncated). NORMAL
means commits do not fsync — **the checkpoint is the only fsync point in
steady state**, which is what makes it the natural stall suspect.

## Phase 1 — attribution runs

All runs on devbox.example.com (same box and same caveats as
load-test-results.md), standard profile: 10 agents, 300 convos, default
rates, temp DB under /tmp. One run at a time.

### Run P1: in-process, 150s (same bias as the baseline runs)

`node tools/wal-profile.js --duration=150`

| metric | value |
|---|---|
| append latency p50 / p95 / p99 / max | 1.2ms / 2.5ms / 6.3ms / **47.5ms** (n=13507) |
| server event-loop lag p50 / p95 / p99 / max | 2.14ms / 2.60ms / 3.23ms / **47.78ms** |
| checkpoint census | **95 completed checkpoints** (WAL resets), WAL high-water 4.16MB / 1010 frames |
| GC census | minor n=274 max 5.0ms, incremental n=2 max 1.1ms, major n=2 max **2.7ms** |
| slow statements ≥20ms | **10 — every one an append transaction whose COMMIT ran the auto-checkpoint** |
| stalls >100ms | none this run (see run P3) |

The ten slow entries, verbatim fingerprints (walBefore→walAfter across the
statement window; `backfill 0→~1000` means the full 1000-page checkpoint
executed inside that commit):

| t+ | duration | WAL frames | backfill |
|---|---|---|---|
| 7.5s | 45ms | 997→1003 | 0→1003 |
| 45.2s | 46ms | 985→1000 | 0→1000 |
| 46.8s | 45ms | 981→1002 | 0→1002 |
| 48.4s | 29ms | 984→1001 | 0→1001 |
| 50.0s | 37ms | 994→1003 | 0→1003 |
| 76.9s | 34ms | 996→1002 | 0→1002 |
| 78.4s | 30ms | 979→1000 | 0→1000 |
| 80.0s | 39ms | 992→1004 | 0→1004 |
| 81.6s | 45ms | 989→1001 | 0→1001 |
| 138.5s | 20ms | 992→1004 | 0→1004 |

Every blockage ≥20ms in the run was a checkpoint-in-commit. The worst
append (47.5ms) and the worst loop lag (47.78ms) match the worst
checkpoint transaction (45–46ms). The worst GC of any kind was 2.7–5.0ms —
two orders of magnitude below the historical stall maxima.

### Run P2: out-of-process, 150s (generator bias removed)

`node tools/wal-profile.js --duration=150 --out-of-proc`

| metric | value |
|---|---|
| append latency p50 / p95 / p99 / max | 0.8ms / 1.8ms / 9.1ms / **55.1ms** (n=13514) |
| server event-loop lag p50 / p95 / p99 / max | 2.07ms / 2.81ms / 3.25ms / **57.18ms** |
| checkpoint census | 94 completed checkpoints, WAL high-water 4.15MB / 1008 frames |
| GC census | minor n=153 max 4.7ms, incremental n=1, major n=1 max 2.8ms |
| slow statements ≥20ms | **4 — all checkpoint-in-commit** (21 / 43 / 44 / 50ms) |
| generator-side | **0 loop stalls ≥50ms, 0 GCs ≥10ms** |
| stalls >100ms | none this run |

Generator-bias disclosure, quantified: moving the generator out of process
*improved* p50/p95 (1.2→0.8ms, 2.5→1.8ms — the shared thread inflates the
middle of the distribution) but the tail is unchanged and fully present
server-side (max 55.1ms, all slow entries checkpoint-fingerprinted, clean
generator logs). The stall tail is a server-side phenomenon, not generator
noise.

## Attribution verdict

TBD

## Phase 2 — mitigation experiments

TBD

## Phase 3 — validation

TBD
