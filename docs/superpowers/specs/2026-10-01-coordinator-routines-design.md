# Coordinator routines — journal-owned schedules and a playbook loaded at spawn

**Status:** approved by Dan, 1 Oct 2026 (tracker item "Plan: journal-owned Coordinator routines + a playbook loaded at spawn", answered "build it"; triggers added the same day on "Add triggers"). Mission 5651.
**Repos:** matron-journal (routines table, routes, sweep, firing, seeding), matron-bridge (the `routine` session-control action, `routine_*` tools, the playbook), matron-apple (Settings ▸ Coordinator ▸ Routines — a separate mission).
**Related:** [memories](2026-09-27-memories-design.md), [read state](2026-09-30-read-state-design.md), matron-bridge `2026-09-29-coordinator-session-control-design.md` (session control, the Alertmanager relay).

## Why

The Coordinator's recurring work lives in fragile places: bridge reminders that belong to one conversation and have to re-arm themselves, memories that are rules but not procedures, and conversation context that compaction discards. Replacing the Coordinator conversation loses the schedule; a reminder that misses its re-arm drifts or stops.

Two things fix that. A **routine** is a schedule and a prompt the journal owns and fires into whichever conversation holds the Coordinator role, waking its box if needed — nothing in any conversation keeps it alive. A **playbook** is the written procedure for each routine and each standard task, loaded into the Coordinator's instructions at spawn, so a new Coordinator conversation behaves the same from its first turn. Dan's rules stay memories; the playbook names them.

## The routine

```sql
CREATE TABLE IF NOT EXISTS routines(
  id            TEXT PRIMARY KEY,            -- 'rt_' + 16 hex
  user_id       INTEGER NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,               -- slug, the handle agents and prompts use
  title         TEXT NOT NULL,
  schedule      TEXT,                        -- 5-field cron, in `tz` — or NULL for a triggered routine
  trigger       TEXT,                        -- JSON, see "Triggers" — exactly one of schedule/trigger
  tz            TEXT NOT NULL,               -- IANA zone, default Europe/London
  prompt        TEXT NOT NULL,               -- the turn text, ≤ 2000 chars
  enabled       INTEGER NOT NULL DEFAULT 1,
  origin        TEXT NOT NULL CHECK(origin IN ('seed','user','agent')),
  next_at       INTEGER,                     -- next fire (ms); NULL while paused
  retry_at      INTEGER,                     -- the one retry after a failed delivery
  last_fired_at INTEGER,
  last_outcome  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(user_id, name),
  CHECK((schedule IS NULL) <> (trigger IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_routines_due ON routines(enabled, next_at);
CREATE TABLE IF NOT EXISTS routine_trigger_state(   -- a triggered routine's currently-tripped subjects
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  subject    TEXT NOT NULL,                  -- convo:<id> | device:<id>
  tripped_at INTEGER NOT NULL,
  PRIMARY KEY(routine_id, subject)
);
```

`user_settings` gains `routines_seeded_at INTEGER` (added with the same `PRAGMA table_info` guard as `coordinator_consent`), so the starter set is seeded once per user and never again after the user deletes it.

Limits: `name` matches `/^[a-z0-9][a-z0-9-]{0,63}$/`; `title` one line ≤ 200; `prompt` ≤ 2000 characters (the session-control message cap), control characters other than newlines stripped; `schedule` exactly five whitespace-separated fields that `croner` accepts, and whose consecutive fires are at least 15 minutes apart (checked over the next five fires from now — a routine is a check-in, not a poll); `tz` a zone `Intl.DateTimeFormat` accepts; at most 50 routines per user.

Cron is evaluated by **croner** (MIT, no dependencies, DST-correct in a named zone): the one new dependency. `next_at` is always `Cron(schedule, {timezone: tz}).nextRun(from)` for the `from` named below. A pattern with fewer than five future fires (a date that never comes) is refused, so an enabled routine can never silently run out; across a spring-forward fold croner reports the skipped hour twice at one instant, which the spacing check ignores.

## Triggers

Dan, 1 Oct ("Add triggers"): the journal already holds every session's context gauge and stall (`conversation_status`) and every box's disk figures (`device_status`), so a routine may carry a **trigger** instead of a schedule and fire the moment a rule trips, rather than waiting for the Coordinator to notice at its next 2-hourly check. The Coordinator still decides what to do; the journal only prompts it.

| `trigger` | trips for |
|---|---|
| `{kind:'context_over', pct}` (1–99) | a live session (`running`/`waiting`, not the Coordinator itself, not a helper conversation inside a session) whose context tokens are at or past `pct` of its window — 1M at least for the 1M-class models (Opus, Fable, Mythos, any `[1m]` alias), since a bridge can only prove a 1M window once the gauge passes 200k (item 5894) |
| `{kind:'stalled', reset_minutes}` (0–10080, default 120) | a live session stalled on a usage limit whose reset is at least `reset_minutes` away, or has no reset time |
| `{kind:'disk_under', pct}` (1–99) | an agent box whose last report shows under `pct`% free disk |

A **trigger sweep** runs every five minutes (`src/routines-triggers.js`). For each enabled triggered routine it evaluates the rule for the routine's user as the Coordinator's box may see it (sessions on private devices and private boxes are invisible when the Coordinator sits on an ordinary box), then in one transaction forgets recorded subjects that no longer match and records the matching subjects it has not fired for (`routine_trigger_state`) — before delivery, so a crash mid-delivery costs one fire, never a double. The fresh subjects are delivered as one fire with the specifics appended to the prompt:

```
Routine context-over: follow the Session context over the threshold section of your playbook.

Tripped by:
- [Big session](matron://convo/<id>) at 42% of its window (420k/1M, opus-5-5)
```

(`stalled` lines read `… stalled on fable-5-1, resets 2026-10-01T15:00:00Z (in 5 h)` or `…, no reset time`; `disk_under` lines `- gene: 15% free (15.0 GB of 100.0 GB)`.) A subject fires once per crossing: while it keeps matching nothing more is sent; once it stops matching (compacted, reset, cleaned up) its record goes, and the next crossing fires again. Pausing a triggered routine or changing its trigger clears its records. A triggered routine fires at most once per 15 minutes (`retry_at` doubles as "not before"); a resting routine still forgets subjects that stop matching, and subjects crossing inside the gap are fresh at the first sweep after it, so a run of crossings costs the Coordinator one turn a quarter hour. A delivery failure the next attempt might cure forgets the fresh subjects and backs the routine off 15 minutes (`retry_at`); a refusal keeps them recorded. `next_at` is always NULL for a triggered routine; `run` fires it with whatever matches at that moment, records untouched. A routine is scheduled or triggered for life: a `PATCH` may change `schedule` only on a scheduled routine and `trigger` only on a triggered one (**400** otherwise).

Three more starter routines (seeded with the rest): `context-over` (`context_over` 40), `stalled-session` (`stalled` 120), `disk-low` (`disk_under` 20), each prompt pointing at its playbook section. The thresholds are the user's to edit; the playbook sections tell the Coordinator to act under the user's memories (compaction, which model a maxed box runs, what may be cleaned on which box).

## Routes (Bearer, either device kind)

| Route | Who | Body | Returns |
|---|---|---|---|
| `GET /routines` | any | | 200 `{routines:[…]}`, by `name` |
| `GET /routines/:key` | any | | 200 `{routine}`; `:key` is the id or the name |
| `POST /routines` | client, or the Coordinator | `{name, title, schedule \| trigger, prompt, tz?, enabled?, convo_id?}` | 201 `{routine}`; **409** `conflict` when the name is taken; **409** `{error:'conflict', blocked_by:'cap'}` at 50 |
| `PATCH /routines/:key` | client, or the Coordinator | `{title?, schedule?, trigger?, tz?, prompt?, enabled?, convo_id?}` — at least one, never both schedule and trigger | 200 `{routine}` |
| `DELETE /routines/:key` | client only (agent → **403**) | | 200 `{ok:true}` |
| `POST /routines/:key/run` | client, or the Coordinator | `{convo_id?}` | 202 `{accepted:true}` or `{delivered:false, reason:'no_coordinator'\|'busy'}` |

A routine row on the wire is every column except `retry_at`; `trigger` is the parsed object or null, `schedule` a string or null. **400** `bad_request` for any invalid field; **404** `not_found` for an unknown key or another user's routine.

**The Coordinator gate.** An agent writer must name its own conversation in `convo_id`, and it must be the user's Coordinator — the `closingConvo(…, {required: true})` rule missions and projects use: no `convo_id` or another conversation → **403** `{error:'forbidden', detail:'not_coordinator'}`; a conversation this device does not own → **404**. The journal is the gate, as for consent: an ordinary agent can read the list but never change it, and no agent can delete a routine (the user's list, the user's delete).

**`enabled`.** Pausing sets `next_at` and `retry_at` to NULL; resuming, or changing `schedule`/`tz`, recomputes `next_at` from now. Editing `title` or `prompt` leaves the schedule alone. The `run` route fires the routine now whatever `enabled` says and never touches `next_at`.

## Firing

A sweep (`src/routines-sweep.js`) runs once a minute, like the stall-wake sweep, and is stopped in `close()`. A routine is **due** when it is enabled and `next_at ≤ now`, or `retry_at ≤ now`.

For each due routine, in one transaction *before* anything is delivered: `last_fired_at = now`, `next_at = nextRun(now)`, `retry_at = NULL`. Advancing first means a crash, a slow wake or a journal restart mid-delivery can never fire the same occurrence twice.

- **Too late to be useful.** A `next_at` more than 6 hours in the past (the journal was down, or the clock jumped) is skipped with `last_outcome = 'missed'` and the row advances; a 07:05 sweep is not run at 15:00.
- **Delivery**, off the sweep's loop and bounded to 4 in flight per journal process (a fifth due routine waits for the next sweep without advancing): resolve the user's Coordinator and its box (`coordinatorDevice`); none → `last_outcome = 'no_coordinator'`. Otherwise `wakeIfOffline`, wait for the box to attach (`MATRON_SPAWN_WAKE_WAIT_MS`) when a wake was fired, then issue the journal-originated RPC, exactly as the Alertmanager relay does:

```json
{ "method": "session_control",
  "params": { "convo_id": "<the Coordinator conversation>", "action": "routine",
              "routine_id": "rt_…", "name": "daily-sweep", "title": "Daily sweep",
              "message": "<prompt>", "fired_at": "2026-10-02T06:05:00.000Z", "tz": "Europe/London",
              "from_name": "Routines" } }
```

- **Outcome.** The bridge answers `{ok:true, result:{applied:'now'|'deferred'}}` → `last_outcome = 'applied now'|'applied deferred'`. An error → `last_outcome = 'failed <code>'`. A delivery failure the next sweep might cure (`agent_unreachable`, `timeout`, `send_failed`, an internal error) sets `retry_at = now + 15 min` **once**: the retry's own failure leaves `retry_at` NULL, and the routine waits for its next scheduled time. A refusal from the bridge (`bad_request`, `not_coordinator`, `gone`) is not retried. A box the infra cannot wake costs one fire, never a storm (the wake gap itself is mission 5623).
- **Marker.** After the outcome is known, a `routine` event is appended into the Coordinator conversation: `{routine_id, name, action:'fired', outcome, next_at}`. Create, update and delete append `{routine_id, name, action:'saved'|'deleted', by:'user'|'agent'}` there too (nothing when no Coordinator is set). `routine` is not a `MESSAGE_TYPE` (no unread, no snippet), not an `AGENT_PUBLISH_TYPES` member, never pushes, never wakes; apps refetch `GET /routines` on it. One line is logged per fire: `routines: <name> for <user> -> Coordinator <convo> on device <id>: <outcome>`.

`routine` is **not** a `session_control` op action: only the sweep and the `run` route build it, so no agent can forge one through its own op (the bridge refuses a `routine` whose `from_device_id` is not the journal's 0, and one aimed anywhere but the Coordinator).

## The bridge

- `lib/session-control.js` gains action `routine` (journal-only, Coordinator-only, like `alert`). The turn is framed on the bridge: `[routine daily-sweep, fired by the journal at 07:05 Europe/London] <prompt>`. Parked while the Coordinator is mid-turn, in its own slot kind: a newer fire of the **same** routine replaces an unapplied one (a 2-hourly check never piles up); fires of different routines are appended, oldest first, under the alert cap. Notice line: `🔔 Routine daily-sweep: Daily sweep` (`… once this turn finishes` when parked).
- `lib/routines-client.js` + `lib/routines-tools.js`: `routine_list`, `routine_update(name, {title?, schedule?, trigger?, tz?, prompt?, enabled?})`, `routine_run(name)`, mounted in `ask-user.js` like the consent tools and refused locally for a session that is not the Coordinator. No create or delete tool: the apps own those. A routine body keeps its line breaks (a triggered fire lists its subjects) but a continuation line that starts with `[` is indented one space, so a prompt can never forge a second provenance frame inside the turn.
- **Playbook.** `BRIDGE_COORDINATOR.md` stays the preamble (role, never do the work, hand work out, links, memories, tracker, reading the journal, and a short section on the playbook and the routine tools). A `coordinator/` directory holds `procedures/*.md` (sweep, triage a consent request, unstick a session, close missions, refresh statuses, file projects, infrastructure alert, what the user missed, hand work to the merge train or deploy owner — consent and session control moved here from the preamble, as procedures) and `routines/*.md` (one per starter routine, scheduled and triggered, each a section headed by the routine's name). The playbook stays generic: it names the user's memories by meaning (thresholds, boxes, who deploys) and never copies one user's rules. `loadCoordinatorBlock` concatenates the preamble, then every file in each directory in name order, into the one block appended to the Coordinator's system prompt. The `Check-ins` section (bridge reminders) is replaced by a `Routines` section.

## Seeding

`seedRoutines(db, userId, now)` inserts the starter set with `origin='seed'` when `user_settings.routines_seeded_at` is NULL and the user has no routines, then stamps `routines_seeded_at`. It runs when the user's Coordinator is first assigned (`PUT /coordinator`, after the role transaction commits) and once at boot for every user who already has a Coordinator — the one-off for Dan. Prompts are one line each and point at the playbook section, so editing a procedure never means editing the journal.

| name | schedule (Europe/London) | prompt |
|---|---|---|
| `daily-sweep` | `5 7 * * *` | Routine daily-sweep: follow the Daily sweep section of your playbook. |
| `session-health` | `0 */2 * * *` | Routine session-health: follow the Session health section of your playbook. |
| `project-status` | `0 8,17 * * *` | Routine project-status: follow the Project status refresh section of your playbook. |
| `unseen-digest` | `0 12,18 * * *` | Routine unseen-digest: follow the Unseen digest section of your playbook. |
| `deploy-window` | `30 18 * * 1-5` | Routine deploy-window: follow the Evening deploy window section of your playbook. |

## Migration

Once the routines are firing, the Coordinator cancels its own reminders (the daily sweep, the 2-hourly health check, the 08:00/17:00 project check-ins) with `reminder_cancel` and the standing rule about the check-in cadence is retired; the playbook's Routines section tells it to. Nothing re-arms itself any more.

## Testing

Journal: unit tests for validation and `nextRun` (including a DST crossing and the 15-minute spacing rule), the sweep (due, missed, advance-before-deliver, in-flight bound, retry once), delivery through a fake bridge socket (the `alerts-http` test fleet), the routes (gate, caps, conflict, marker), seeding (once per user, at assignment and at boot). Bridge: the `routine` action (authorisation, framing, parked merge), the tools, `loadCoordinatorBlock` concatenation. Tests run serially (`--test-concurrency=1`); the DB is backed up before the services-1 deploy.
