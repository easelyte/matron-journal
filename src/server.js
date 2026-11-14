import http from 'node:http'
import { makeAgentCommentLimiter } from './agent-comment-limiter.js'
import path from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.js'
import { makeLoginGuard, makeRateLimiter } from './auth.js'
import { makeTwoFactorTickets, isTwoFactorRequired } from './two-factor.js'
import { makeHttpHandler } from './http.js'
import { ensurePreapproveKey } from './preapprove-key.js'
import { makePairStore } from './pairing.js'
import { makeLinkStore } from './link.js'
import { makeHub } from './hub.js'
import { attachWs } from './ws.js'
import { makeToolStreamStore } from './tool-stream.js'
import { makeApnsClient } from './apns.js'
import { makeGatewayClient } from './gateway.js'
import { makePushPipeline, BACKGROUND_WAKE_MS } from './push.js'
import { resolveMediaDir } from './media.js'
import { resolveFileReads } from './files-read-http.js'
import { startStallLog, timed, logSlowRequests } from './stall-log.js'
import { offloadPass, expireLogsPass, runReapMedia, reapOrphanBlobsPass, runExpireVoiceNotes, runExpireDeviceContent, runExpireTransfers, drainSync, drainAsync } from './retention.js'
import { backfillSearchIndex, backfillIsDiff } from './search.js'
import { loadEmbedder } from './embedder.js'
import { ensureVectorSchema, runVectorIndexer, createVectorStore } from './vector-index.js'
import { backfillImageDims } from './items.js'
import { scheduleGithubRefresh } from './github-refresh.js'
import { makeRpcBroker } from './rpc-broker.js'
import { resolveWebDir, makeStaticHandler } from './static-http.js'
import { makeWellKnown, parseList } from './well-known.js'
import { loadFederation, makeFederationWellKnown } from './federation-identity.js'
import { makeContactPage } from './contact-page.js'
import { makeFederationHandler, makeFederationLimiter, pruneReceipts, DEFAULT_OPS } from './federation-inbound.js'
import { makeMediaHandler, makeReplicaMedia, purgeReplicaMedia } from './federation-media.js'
import { makeContactFederation } from './federation-contacts.js'
import { makeGrantFederation } from './federation-grants.js'
import { makeContributeFederation } from './federation-contribute.js'
import { makeRoomFederation } from './federation-rooms.js'
import { makeOutbox, pruneOutbox } from './federation-outbox.js'
import { makeConfiguredFederationClient } from './federation-client.js'
import { makeWaker, markWakeRefused, clearWakeRefused } from './wake.js'
import { makeConfiguredTranscriber } from './cloud-transcribe.js'
import { makeConfiguredMailer } from './mailer.js'
import { makeConfiguredSummariser } from './summarise.js'
import { makeBlobTranscripts } from './blob-transcripts.js'
import { makeConfiguredTts, resolveTtsCacheDir } from './cloud-tts.js'
import { makeItemTranscription } from './items-transcribe.js'
import { emitTranscriptionMarker } from './items-http.js'
import { makeGithub, DEFAULT_GITHUB_CLIENT_ID } from './github.js'
import { makeTokenBox } from './token-box.js'
import { startUnseenNudge } from './unseen-nudge.js'
import { makeRoutineFirer, startRoutinesSweep } from './routines-sweep.js'
import { seedRoutines } from './routines.js'
import { startStallWakeSweep } from './stall-wake.js'
import { startAutoArchiveSweep } from './archive.js'
import { sealStoredTokens } from './github-accounts.js'
import { CONSENT_DAILY_CAP_DEFAULT, CONSENT_ROUTINE_CAP_DEFAULT, CONSENT_TRANSFER_DAILY_CAP_DEFAULT } from './consent.js'
import { makeVerifier } from './verifier.js'
import { warnAlertWebhookConfig } from './alerts-http.js'
import { throttle, cancellableDelay } from './background.js'
import { TRANSFER_MAX_BYTES_DEFAULT, TRANSFER_USER_QUOTA_BYTES_DEFAULT, TRANSFER_MAX_AWAITING_PER_SENDER_DEFAULT } from './transfers.js'

export const DEFAULT_MEDIA_MAX_BYTES = 52428800 // 50 MB
// Per-user total blob budget (all uploads + retention-offloaded payloads for a
// user, summed). Unlike tool_output, user-uploaded media has no TTL, so without
// a ceiling a single valid device token could fill the disk. 2 GiB is ~75x the
// busiest user's footprint on a production deployment — generous headroom, not a squeeze.
export const DEFAULT_MEDIA_USER_QUOTA_BYTES = 2147483648 // 2 GiB
export const DEFAULT_MAX_REPLAY = 50000
const DEFAULT_RETENTION_DAYS = 30
const RETENTION_INITIAL_DELAY_MS = 2 * 60 * 1000 // let the reconnect burst after a restart pass first
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h
const DEFAULT_TOOL_LOG_TTL_HOURS = 24
const DEFAULT_VOICE_NOTE_TTL_DAYS = 7 // audio goes a week after its transcript

// Shared validator for small numeric env knobs that guard a size/gap check
// (`size > mediaMaxBytes`, `gap > maxReplay`): an unset var is the normal,
// expected "use the default" case (no warning). But an unparseable or
// non-positive value must never silently become NaN and disable the check
// it guards — `x > NaN` is always false, so e.g. a garbage
// MATRON_MEDIA_MAX_BYTES would make the upload size cap accept anything,
// and a garbage MATRON_MAX_REPLAY would make the snapshot_required valve
// never fire. Fails closed to `defaultValue` instead, with one warn log
// naming the var, so a misconfiguration is loud rather than invisible.
// On/off env flag: 1/true/on/yes and 0/false/off/no (case-insensitive);
// unset -> default; anything else warns and falls back to the default, the
// same fail-visible stance as resolveNumericEnv.
export function resolveBooleanEnv(name, raw, defaultValue) {
  if (raw === undefined) return defaultValue
  const v = String(raw).trim().toLowerCase()
  if (['1', 'true', 'on', 'yes'].includes(v)) return true
  if (['0', 'false', 'off', 'no'].includes(v)) return false
  console.warn(`${name}=${JSON.stringify(raw)} is invalid (expected 1/0, true/false, on/off, yes/no) — using default ${defaultValue}`)
  return defaultValue
}

export function resolveNumericEnv(name, raw, defaultValue) {
  if (raw === undefined) return defaultValue
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    console.warn(`${name}=${JSON.stringify(raw)} is invalid (must be a positive integer) — using default ${defaultValue}`)
    return defaultValue
  }
  return n
}

// The consent cap is the one knob where 0 is a value, not garbage: it means
// "no cap" — the operator has decided the reason on every decision and the
// audit trail are guardrail enough. Anything else is validated like every other numeric knob.
export function resolveConsentDailyCap(raw, defaultValue = CONSENT_DAILY_CAP_DEFAULT) {
  if (typeof raw === 'string' && raw.trim() === '0') return 0
  return resolveNumericEnv('MATRON_COORDINATOR_CONSENT_DAILY_CAP', raw, defaultValue)
}

// The background pacing knobs take 0 too: no startup delay, and no rest
// beyond one event-loop turn. Anything else is validated as above.
export function resolveZeroableEnv(name, raw, defaultValue) {
  if (typeof raw === 'string' && raw.trim() === '0') return 0
  return resolveNumericEnv(name, raw, defaultValue)
}

// The retention windows (`retentionDays`, `toolLogTtlHours`,
// `voiceNoteTtlDays`). `override` is startServer's opt — when given, it
// takes precedence over the env var (this is how tests disable/shrink a
// window without touching process.env), but BOTH sources run through the
// same validation: unset means ENABLED at the default; `0` disables; and
// anything that isn't a non-negative integer disables with one log line —
// fails closed. (A raw pass-through of a negative override would compute a
// FUTURE cutoff and offload every payload including brand-new ones.)
// Returns the window, or null when the pass is disabled.
function resolveWindow(override, { env, opt, fallback, what }) {
  const fromEnv = override === undefined
  const raw = fromEnv ? process.env[env] : override
  if (raw === undefined) return fallback
  const name = fromEnv ? env : opt
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    console.warn(`retention: ${name}=${JSON.stringify(raw)} is invalid — ${what} disabled`)
    return null
  }
  if (n === 0) {
    console.warn(`retention: ${name}=0 — ${what} disabled`)
    return null
  }
  return n
}

const resolveRetentionDays = (override) =>
  resolveWindow(override, { env: 'MATRON_RETENTION_DAYS', opt: 'retentionDays', fallback: DEFAULT_RETENTION_DAYS, what: 'retention' })
const resolveToolLogTtlHours = (override) =>
  resolveWindow(override, { env: 'MATRON_TOOL_LOG_TTL_HOURS', opt: 'toolLogTtlHours', fallback: DEFAULT_TOOL_LOG_TTL_HOURS, what: 'retention' })
const resolveVoiceNoteTtlDays = (override) =>
  resolveWindow(override, { env: 'MATRON_VOICE_NOTE_TTL_DAYS', opt: 'voiceNoteTtlDays', fallback: DEFAULT_VOICE_NOTE_TTL_DAYS, what: 'voice-note expiry' })

export const DEFAULT_ORPHAN_BLOB_GRACE_HOURS = 168

// Grace window for the orphan-blob reaper (runReapOrphanBlobs):
// how old an unreferenced blob must be before it is deleted. `override` is
// startServer's `orphanBlobGraceHours` opt and beats MATRON_ORPHAN_BLOB_GRACE_HOURS,
// mirroring the other retention resolvers: unset means ENABLED at 7 days
// (168h — see runReapOrphanBlobs for why not 24h); `0`
// disables; anything that is not a non-negative integer disables with one
// warn line (this pass deletes data — fail closed means off). Returns hours
// or null.
export function resolveOrphanBlobGraceHours(override) {
  const fromEnv = override === undefined
  const raw = fromEnv ? process.env.MATRON_ORPHAN_BLOB_GRACE_HOURS : override
  if (raw === undefined) return DEFAULT_ORPHAN_BLOB_GRACE_HOURS
  const name = fromEnv ? 'MATRON_ORPHAN_BLOB_GRACE_HOURS' : 'orphanBlobGraceHours'
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    console.warn(`retention: ${name}=${JSON.stringify(raw)} is invalid — orphan-blob reaper disabled`)
    return null
  }
  if (n === 0) {
    console.warn(`retention: ${name}=${JSON.stringify(raw)} resolves to 0 — orphan-blob reaper disabled`)
    return null
  }
  return n
}

// `override` is startServer's `deviceRetention` opt and beats
// MATRON_DEVICE_RETENTION, as with the other retention resolvers. The value
// is a comma-separated list of `<deviceId>:<days>` (e.g. `4:30,9:7`):
// expire the content of that device's conversations and rooms older than
// that many days (runExpireDeviceContent). Unset or empty is OFF — unlike
// the passes above there is no default, it names devices. Fail closed means
// DISABLED, for the whole setting: this pass deletes user data, so an entry
// that isn't two positive integers, a device named twice or a non-string
// override turns it off with one warn line rather than running whatever
// part of it parsed. Returns [{deviceId, days}] or null.
export function resolveDeviceRetention(override) {
  const fromEnv = override === undefined
  const raw = fromEnv ? process.env.MATRON_DEVICE_RETENTION : override
  if (raw === undefined) return null
  const name = fromEnv ? 'MATRON_DEVICE_RETENTION' : 'deviceRetention'
  const invalid = (why) => {
    console.warn(`retention: ${name}=${JSON.stringify(raw)} is invalid (${why}; want <deviceId>:<days>,...) — device content expiry disabled`)
    return null
  }
  if (typeof raw !== 'string') return invalid('not a string')
  if (raw.trim() === '') return null
  const rules = []
  for (const entry of raw.split(',')) {
    const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(entry)
    if (!m) return invalid(`entry ${JSON.stringify(entry)}`)
    const deviceId = Number(m[1])
    const days = Number(m[2])
    if (!Number.isSafeInteger(deviceId) || deviceId <= 0) return invalid(`device id ${JSON.stringify(m[1])}`)
    if (!Number.isSafeInteger(days) || days <= 0) return invalid(`days ${JSON.stringify(m[2])} for device ${deviceId}`)
    if (rules.some((r) => r.deviceId === deviceId)) return invalid(`device ${deviceId} named twice`)
    rules.push({ deviceId, days })
  }
  return rules
}

export const DEFAULT_MEDIA_REAP_HIGH_PCT = 90
export const DEFAULT_MEDIA_REAP_LOW_PCT = 70

// High/low-water marks for the quota-pressure attachment reaper
// (runReapMedia), as integer percentages of the per-user media quota.
// Overrides (startServer's `mediaReapHighPct`/`mediaReapLowPct` opts) beat
// the env vars per-knob, mirroring the other retention resolvers. Fail
// closed means DISABLED here — this pass deletes user data, so an
// unparseable value, 0, a percentage over 100, or an inverted pair
// (low >= high would make the reap loop's stop condition unreachable on
// entry) must all turn the reaper off with one warn line, never run it
// with surprise thresholds. Returns { highPct, lowPct } or null.
export function resolveReapPcts({ mediaReapHighPct, mediaReapLowPct } = {}) {
  const resolveOne = (override, envName, optName, defaultValue) => {
    const fromEnv = override === undefined
    const raw = fromEnv ? process.env[envName] : override
    if (raw === undefined) return defaultValue
    const name = fromEnv ? envName : optName
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      console.warn(`retention: ${name}=${JSON.stringify(raw)} is invalid — media reaper disabled`)
      return null
    }
    if (n === 0) {
      // JSON.stringify(raw), not `0`: Number('') is 0, so an empty env
      // assignment lands here too and "=0" would misdirect the diagnosis.
      console.warn(`retention: ${name}=${JSON.stringify(raw)} resolves to 0 — media reaper disabled`)
      return null
    }
    return n
  }
  const highPct = resolveOne(mediaReapHighPct, 'MATRON_MEDIA_REAP_HIGH_PCT', 'mediaReapHighPct', DEFAULT_MEDIA_REAP_HIGH_PCT)
  const lowPct = resolveOne(mediaReapLowPct, 'MATRON_MEDIA_REAP_LOW_PCT', 'mediaReapLowPct', DEFAULT_MEDIA_REAP_LOW_PCT)
  if (highPct === null || lowPct === null) return null
  if (lowPct >= highPct) {
    console.warn(`retention: media reap low-water ${lowPct}% >= high-water ${highPct}% — media reaper disabled`)
    return null
  }
  return { highPct, lowPct }
}

// Runs at boot (called after `server.listen` succeeds) and every 6h
// thereafter (unref'd — never keeps the process alive on its own). Runs the
// live-log TTL pass BEFORE the offload pass (opposite of declaration order
// above) so that even a mis-configured-then-re-enabled system tombstones a
// stale inline live_log row before offload ever gets a chance to see it —
// runOffload's `blob_ref IS NULL` scan can't otherwise distinguish a
// long-overdue live_log row from a genuinely-inline one, and offloading it
// would permanently exempt it from the TTL pass (see runOffload's live_log
// skip). The two passes remain independent knobs otherwise — either can be
// disabled on its own (see resolveRetentionDays / resolveToolLogTtlHours)
// without affecting the other — each with its own try/catch so one pass
// failing (e.g. a disk error) never prevents the other from running on this
// tick or being scheduled for the next. The quota-pressure media reaper runs
// LAST: the offload pass just before it converts inline payloads into new
// blobs, so reaping after offload sees the user's honest post-offload
// footprint instead of triggering one tick late. The per-device content
// expiry runs FIRST: what it tombstones the later passes skip, so an old
// tool log of such a device is never offloaded to a blob only to be
// deleted, and the reaper sees the bytes it freed. Its rules are logged
// once, here, at boot. The orphan-blob reaper (runReapOrphanBlobs) runs
// after the media reaper, on its own knob (MATRON_ORPHAN_BLOB_GRACE_HOURS).
// The transfer-expiry pass (runExpireTransfers) runs LAST and
// unconditionally — see the comment at its call site below.
// Returns the interval handle (for close()).
function scheduleRetention(db, { mediaDir, hub, retentionDays, retentionIntervalMs, retentionInitialDelayMs, toolLogTtlHours, voiceNoteTtlDays, mediaReapHighPct, mediaReapLowPct, mediaUserQuotaBytes, deviceRetention, orphanBlobGraceHours }) {
  const days = resolveRetentionDays(retentionDays)
  const ttlHours = resolveToolLogTtlHours(toolLogTtlHours)
  const voiceDays = resolveVoiceNoteTtlDays(voiceNoteTtlDays)
  const reapPcts = resolveReapPcts({ mediaReapHighPct, mediaReapLowPct })
  const orphanGraceHours = resolveOrphanBlobGraceHours(orphanBlobGraceHours)
  const deviceRules = resolveDeviceRetention(deviceRetention)
  if (deviceRules) {
    console.log(`retention: device content expiry on — ${deviceRules.map((r) => `device ${r.deviceId} after ${r.days}d`).join(', ')}`)
  }
  // Transfer expiry (runExpireTransfers) has no knob and no disable path —
  // unlike every pass above it deletes only bytes the state machine has
  // already decided are done for (a collected copy past its grace, an
  // uncollected one past 7 days), never "everything older than N" against
  // a setting that could be misconfigured — so the schedule always runs,
  // even when every other pass below is off.
  // One pass, as a generator: `yield*` hands the heavy passes' own yields
  // through, and a bare `yield` between passes gives the loop a turn there
  // too. See drainAsync in retention.js for why.
  function* pass() {
    if (deviceRules !== null) {
      try {
        const r = runExpireDeviceContent(db, { rules: deviceRules })
        if (r.expired > 0 || r.blobsDeleted > 0) {
          console.log(`retention: expired content of ${r.expired} event(s) for ${deviceRules.length} device rule(s), ` +
            `${r.blobsDeleted} blob(s), ${r.bytesFreed} bytes, ${r.searchRowsDeleted} search row(s)`)
        }
      } catch (err) {
        console.error('retention: device content expiry run failed', err)
      }
      yield
    }
    if (ttlHours !== null) {
      try {
        const r = yield* expireLogsPass(db, { hours: ttlHours, mediaDir })
        if (r.expired > 0) console.log(`retention: purged ${r.expired} live_log payload(s) older than ${ttlHours}h`)
      } catch (err) {
        console.error('retention: expire-logs run failed', err)
      }
      yield
    }
    // Voice-note audio before offload/reap, so the reaper sees the user's
    // footprint without recordings whose words have already outlived them.
    if (voiceDays !== null) {
      try {
        const r = runExpireVoiceNotes(db, { days: voiceDays })
        if (r.expired > 0) console.log(`retention: expired ${r.expired} voice-note recording(s) transcribed more than ${voiceDays}d ago, ${r.bytesFreed} bytes`)
      } catch (err) {
        console.error('retention: voice-note expiry run failed', err)
      }
      yield
    }
    if (days !== null) {
      try {
        const r = yield* offloadPass(db, { days, mediaDir })
        if (r.offloaded > 0) console.log(`retention: offloaded ${r.offloaded} tool_output payload(s) older than ${days}d`)
      } catch (err) {
        console.error('retention: offload run failed', err)
      }
      yield
    }
    if (reapPcts !== null) {
      try {
        const r = runReapMedia(db, { quotaBytes: mediaUserQuotaBytes, highPct: reapPcts.highPct, lowPct: reapPcts.lowPct })
        if (r.reaped > 0) console.log(`retention: reaped ${r.reaped} attachment blob(s), ${r.bytesFreed} bytes, from user(s) over ${reapPcts.highPct}% of the media quota`)
      } catch (err) {
        console.error('retention: media reap run failed', err)
      }
      yield
    }
    if (orphanGraceHours !== null) {
      try {
        const r = yield* reapOrphanBlobsPass(db, { graceMs: orphanGraceHours * 3600000, mediaDir })
        if (r.reaped > 0) console.log(`retention: reaped ${r.reaped} orphan blob(s), ${r.bytesFreed} bytes, unreferenced for over ${orphanGraceHours}h`)
      } catch (err) {
        console.error('retention: orphan-blob reap run failed', err)
      }
      yield
    }
    // Agent-to-agent file transfers: a collected copy past its 1h grace,
    // and an open or released transfer nobody collected within 7 days —
    // always on, see the comment above.
    try {
      const r = runExpireTransfers(db, { mediaDir, hub })
      if (r.deleted > 0 || r.expired > 0) console.log(`retention: transfers — ${r.deleted} copy/copies deleted, ${r.expired} expired after 7 days uncollected`)
    } catch (err) {
      console.error('retention: transfer expiry run failed', err)
    }
  }
  // The first pass waits retentionInitialDelayMs (a restart is when every
  // client reconnects at once); 0 keeps the synchronous run-at-boot for
  // programmatic callers and tests. Every pass after boot, the delayed
  // first one included, yields between batches (drainAsync), so the loop
  // serves requests while a pass runs; the summary line says how long the pass took end to end and how
  // long its longest uninterrupted stretch was. A pass still running when
  // the next is due is not doubled up. stop() (close) ends a pass in flight
  // at its next yield.
  let running = false
  let stopped = false
  const runAsync = async () => {
    if (running || stopped) return
    running = true
    const start = performance.now()
    let longest = 0
    try {
      await drainAsync(pass(), { shouldStop: () => stopped, onSlice: (ms) => { if (ms > longest) longest = ms } })
    } catch (err) {
      console.error('retention: pass failed', err)
    } finally {
      running = false
      const ms = performance.now() - start
      if (ms >= 1000 || longest >= 500) console.log(`retention: run took ${Math.round(ms)}ms, longest blocking stretch ${Math.round(longest)}ms`)
    }
  }
  const initialDelay = retentionInitialDelayMs ?? RETENTION_INITIAL_DELAY_MS
  let firstTimer = null
  if (initialDelay > 0) {
    firstTimer = setTimeout(runAsync, initialDelay)
    firstTimer.unref()
  } else {
    drainSync(pass())
  }
  const interval = setInterval(runAsync, retentionIntervalMs ?? RETENTION_INTERVAL_MS)
  interval.unref()
  interval.stop = () => { stopped = true; clearTimeout(firstTimer) }
  return interval
}

// The explicit-checkpoint half of the WAL mitigation (the pragma half —
// wal_autocheckpoint=0 + journal_size_limit — lives in openDb; measured
// rationale in docs/wal-checkpoint-profile.md). PASSIVE never blocks readers
// or the writer, and on an empty WAL it is sub-ms, so a 1s cadence costs
// nothing when idle; under load it keeps backfills small and the WAL bounded
// (~4.8MiB worst observed vs unbounded growth without it, since autockpt is
// now off). It still runs the fsync on this thread — profiled cost p99 46ms,
// max 59ms per pass under load — but appends themselves no longer carry it.
// Unref'd like the retention timer; cleared in close().
const WAL_CHECKPOINT_INTERVAL_MS = 1000

function scheduleWalCheckpoint(db, walCheckpointIntervalMs) {
  const run = () => {
    try {
      timed('wal_checkpoint(PASSIVE)', () => db.pragma('wal_checkpoint(PASSIVE)'))
    } catch (err) {
      // A failed passive pass is retried by the next tick; log once per tick
      // rather than crash — the DB itself is still healthy (busy/locked are
      // expected transient outcomes).
      console.error('wal-checkpoint: passive pass failed', err)
    }
  }
  const interval = setInterval(run, walCheckpointIntervalMs ?? WAL_CHECKPOINT_INTERVAL_MS)
  interval.unref()
  return interval
}

// Cached speech clips live 24 hours (src/cloud-tts.js). A clip past that age
// is never served; this hourly pass is what takes it off the disk. Runs once
// at boot too, for what a previous process left. Unref'd like the retention
// timer; cleared in close(). null when speech is off.
const TTS_SWEEP_INTERVAL_MS = 60 * 60 * 1000

function scheduleTtsSweep(tts, ttsSweepIntervalMs) {
  if (!tts) return null
  const run = () => {
    try {
      const r = timed('tts sweep', () => tts.sweep())
      if (r.removed > 0) console.log(`tts: removed ${r.removed} cached clip(s) older than 24h`)
    } catch (err) {
      console.error('tts: cache sweep failed', err)
    }
  }
  run()
  const interval = setInterval(run, ttsSweepIntervalMs ?? TTS_SWEEP_INTERVAL_MS)
  interval.unref()
  return interval
}

// Push client selection, in strict priority order:
//   1. injected (tests) — caller owns its lifecycle.
//   2. all four MATRON_APNS_* set → direct APNs (full-content
//      alerts, exactly the pre-relay behavior).
//   3. MATRON_PUSH_GATEWAY_URL set → the push.matron.chat relay (self-hosted
//      journals with no APNs key; generic alert text, content never leaves
//      the box — see src/gateway.js).
//   4. neither → push disabled, one warn log at boot, pipeline is inert.
// Exported for the selection-order tests only.
export function resolveApnsClient(injected) {
  if (injected) return { client: injected, owned: false }
  const { MATRON_APNS_KEY_FILE, MATRON_APNS_KEY_ID, MATRON_APNS_TEAM_ID, MATRON_APNS_TOPIC, MATRON_PUSH_GATEWAY_URL } = process.env
  if (MATRON_APNS_KEY_FILE && MATRON_APNS_KEY_ID && MATRON_APNS_TEAM_ID && MATRON_APNS_TOPIC) {
    const client = makeApnsClient({
      keyFile: MATRON_APNS_KEY_FILE, keyId: MATRON_APNS_KEY_ID,
      teamId: MATRON_APNS_TEAM_ID, topic: MATRON_APNS_TOPIC,
    })
    return { client, owned: true }
  }
  if (MATRON_PUSH_GATEWAY_URL) {
    // A typo'd URL (e.g. missing scheme) degrades to push-disabled like the
    // other misconfigurations — new URL() in makeGatewayClient would
    // otherwise throw and take the whole journal down at boot.
    if (URL.canParse('/push', MATRON_PUSH_GATEWAY_URL)) {
      return { client: makeGatewayClient({ url: MATRON_PUSH_GATEWAY_URL }), owned: true }
    }
    console.warn(`push: disabled — MATRON_PUSH_GATEWAY_URL is not a valid URL: ${MATRON_PUSH_GATEWAY_URL}`)
    return { client: undefined, owned: false }
  }
  console.warn('push: disabled — set all four MATRON_APNS_* vars (direct APNs) or MATRON_PUSH_GATEWAY_URL (relay) to enable')
  return { client: undefined, owned: false }
}

// The per-IP rate limiter and the pairing "who's asking" IP both trust the
// `cf-connecting-ip` header (see http.js). That is only sound because the sole
// route to this process is the cloudflared tunnel to a LOOPBACK bind —
// Cloudflare overwrites the header, so it can't be spoofed. If the process is
// ever bound to a non-loopback address, that header becomes attacker-supplied
// and both defenses are defeated. Warn loudly at boot rather than silently
// weakening them. Not a hard refuse — a deliberate reverse-proxy setup that
// sets cf-connecting-ip itself is legitimate — but it must be a conscious choice.
function warnIfBindTrustsSpoofableIp(bind) {
  const loopback = bind === '127.0.0.1' || bind === '::1' || bind === 'localhost'
  if (!loopback) {
    console.warn(
      `SECURITY: MATRON_BIND=${JSON.stringify(bind)} is not loopback. The cf-connecting-ip ` +
      'header is only trustworthy when the sole ingress is the cloudflared tunnel; on a ' +
      'directly-reachable bind a client can spoof it, defeating the per-IP rate limiter and ' +
      'the pairing requester-IP display. Ensure a trusted proxy sets cf-connecting-ip and the ' +
      'port is firewalled off from untrusted networks.'
    )
  }
}

export function startServer({
  dbPath, port = 0, bind = '127.0.0.1', mediaDir, mediaMaxBytes, mediaUserQuotaBytes, transferMaxBytes, transferUserQuotaBytes, transferMaxAwaitingPerSender, transferChunkBytes, apnsClient, replayBackpressureBytes,
  retentionDays, retentionIntervalMs, retentionInitialDelayMs, maxReplay, revocationSweepMs, inviteTtlMs, walCheckpointIntervalMs, toolStreamOpts, wsDeflate,
  toolLogTtlHours, voiceNoteTtlDays, deviceRetention, pairs, links, preapproveKey, preapproveKeyPath, spawnStartTimeoutMs = 30000, spawnFoldersTimeoutMs = 4000,
  // How long an approved spawn waits for a woken target box to attach
  // before issuing `start` (wake-before-spawn). Sized for a cold VM boot:
  // incus start + bridge start + journal dial is ~3 minutes on the shared
  // hosts (the infra's timer_wake_lead_minutes). Only ever waited when a
  // wake is actually under way, so a journal without MATRON_WAKE_CMD never
  // pays it.
  spawnWakeWaitMs = resolveNumericEnv('MATRON_SPAWN_WAKE_WAIT_MS', process.env.MATRON_SPAWN_WAKE_WAIT_MS, 240000),
  sessionControlTimeoutMs = resolveNumericEnv('MATRON_SESSION_CONTROL_TIMEOUT_MS', process.env.MATRON_SESSION_CONTROL_TIMEOUT_MS, 30000),
  // Coordinator consent approvals per rolling 24 h (spec: 2026-09-29
  // coordinator consent); beyond it the ask stays for the user. 0 = no cap.
  consentDailyCap = resolveConsentDailyCap(process.env.MATRON_COORDINATOR_CONSENT_DAILY_CAP),
  // Coordinator approvals of file transfers per rolling 24 h, counted apart
  // from the daily cap above. 0 = no cap.
  consentTransferDailyCap = resolveZeroableEnv('MATRON_COORDINATOR_TRANSFER_DAILY_CAP', process.env.MATRON_COORDINATOR_TRANSFER_DAILY_CAP, CONSENT_TRANSFER_DAILY_CAP_DEFAULT),
  agentCommentClock = Date.now,
  // Approvals of the Coordinator's own routine-born asks per rolling 24 h
  // (src/consent-own-ask.js), on top of the daily cap. 0 = no cap.
  consentRoutineCap = resolveZeroableEnv('MATRON_COORDINATOR_ROUTINE_CAP', process.env.MATRON_COORDINATOR_ROUTINE_CAP, CONSENT_ROUTINE_CAP_DEFAULT),
  // The second opinion on those asks (src/verifier.js): off without a key,
  // and then every routine-born own ask stays for the user.
  verifier = makeVerifier(),
  stallWakeIntervalMs = null,
  autoArchiveIntervalMs = null,
  autoArchive = process.env.MATRON_AUTO_ARCHIVE !== '0',
  // The unseen nudge (src/unseen-nudge.js). MATRON_UNSEEN_NUDGE=0 turns it off.
  unseenNudgeIntervalMs = null,
  unseenNudge = process.env.MATRON_UNSEEN_NUDGE !== '0',
  // Coordinator routines (src/routines-sweep.js). MATRON_ROUTINES=0 stops
  // the sweep (the routes and `run` still work).
  routinesSweepIntervalMs = null,
  routinesTriggerIntervalMs = null,
  routinesSweep = process.env.MATRON_ROUTINES !== '0',
  mediaReapHighPct, mediaReapLowPct, orphanBlobGraceHours, waker, transcriber, fileReadRoots,
  fileOwnerUserId, procSelfFdAvailable, fileHomeDir,
  github, githubRefreshIntervalMs, webDir,
  // Cloud speech (src/cloud-tts.js). `tts` is the test seam; `null` forces
  // it off. `ttsCacheDir` overrides where the clips are kept.
  tts, ttsCacheDir, ttsSweepIntervalMs,
  appleAppIds, androidPackage, androidCertSha256, tokenKey,
  httpHandlerFactory = makeHttpHandler,
  // Federation between journals (src/federation-identity.js): the test
  // seam, {federation, publicUrl}; env (MATRON_FEDERATION,
  // MATRON_PUBLIC_URL) otherwise. Off unless turned on.
  federationEnv, federationOps, federationClient, federationLimits,
  // Alertmanager webhook (src/alerts-http.js): {token, username}. The
  // option is the test seam; env otherwise. Off unless both are usable.
  alertWebhook,
  // POST /summarise (src/summarise.js): the test seam; `null` forces it
  // off. Undefined resolves from MATRON_SUMMARY_ANTHROPIC_KEY(_FILE).
  summariser,
  // Password reset by email (src/mailer.js): the test seam; `null` forces
  // it off. Undefined resolves from MATRON_RESEND_API_KEY(_FILE),
  // MATRON_MAIL_FROM and MATRON_PUBLIC_URL.
  mailer,
  // Unified search's similar tier (spec 2026-10-12 §5): the test seam — an
  // injected embedder (incl. `null` to force the tier off) bypasses
  // loadEmbedder entirely, so the suite never loads or downloads a real
  // model. Undefined (the production default) means "resolve for real",
  // gated by MATRON_SEMANTIC_SEARCH below.
  embedder,
  // Startup backfills and vector indexing (src/background.js): wait this
  // long after listening before starting them, so a restart's reconnect
  // burst is served first, and then rest `backgroundPace`× each batch's
  // time between batches. Tests pass 0 and 0.
  backgroundDelayMs = resolveZeroableEnv('MATRON_BACKGROUND_DELAY_MS', process.env.MATRON_BACKGROUND_DELAY_MS, 30000),
  backgroundPace = resolveZeroableEnv('MATRON_BACKGROUND_PACE', process.env.MATRON_BACKGROUND_PACE, 1),
} = {}) {
  warnIfBindTrustsSpoofableIp(bind)
  const resolvedDbPath = dbPath || process.env.MATRON_DB || './matron.db'
  const db = openDb(resolvedDbPath)
  // Token encryption at rest (spec 2026-09-23 tracker web/teams). The
  // option is the test seam; env otherwise. A key that appears after rows
  // exist seals them here, once.
  const tokenBox = makeTokenBox(tokenKey !== undefined ? tokenKey : process.env.MATRON_TOKEN_KEY)
  const sealed = sealStoredTokens(db, tokenBox)
  if (sealed.sealed) console.log(`github: sealed ${sealed.sealed} stored token(s) under MATRON_TOKEN_KEY`)
  if (sealed.unreadable) console.warn(`github: ${sealed.unreadable} stored token(s) are sealed under a different or missing MATRON_TOKEN_KEY; those users must re-link`)
  // WAL-checkpoint tail mitigation, server half (docs/wal-checkpoint-profile.md;
  // journal_size_limit lives in openDb). With synchronous=NORMAL the
  // auto-checkpoint is the only steady-state fsync and it runs INLINE in
  // whichever append COMMIT crosses the 1000-page mark: 69/69 profiled
  // event-loop blockages >=20ms carried that fingerprint, worst 1.22s under
  // real disk contention (GC max 6.2ms — exonerated). Disabling it here and
  // checkpointing from scheduleWalCheckpoint's 1s PASSIVE timer instead moves
  // the fsync out of append COMMITs: matched-window A/B improved append p99
  // 9.7->3.1ms, contended-round max 1221.7->26.8ms, zero >100ms stall events
  // in every mitigated run, WAL bounded <=4.8MB. Server-only on purpose — a
  // standalone opener (admin CLI) has no timer and keeps the stock inline
  // auto-checkpoint (see openDb).
  db.pragma('wal_autocheckpoint = 0')
  const rateLimiter = makeRateLimiter()
  const loginGuard = makeLoginGuard()
  // Two-factor code steps (/login/2fa*): their own per-IP budget, sized for
  // a code request or two per sign-in (src/two-factor-http.js).
  const twoFactorLimiter = makeRateLimiter({ max: 10 })
  const tickets = makeTwoFactorTickets()
  if (isTwoFactorRequired(db) && !tokenBox.enabled) {
    console.warn('two-factor: required for everyone, but MATRON_TOKEN_KEY is not set — nobody can enrol, so the requirement is not enforced')
  }
  const resolvedPairs = pairs || makePairStore()
  const resolvedLinks = links || makeLinkStore({ db })
  const resolvedMediaDir = resolveMediaDir(resolvedDbPath, mediaDir)
  // Finding 1 hardening (Bugbot, PR #29): /link/preapprove's loopback +
  // no-forwarding-header guard alone is defeated by a headerless reverse
  // proxy (default nginx `proxy_pass` adds nothing). This key is the
  // second, independent factor — auto-minted next to the DB, never
  // operator-provisioned (see src/preapprove-key.js). `preapproveKey` lets
  // a caller (tests) inject a known value directly with zero disk I/O;
  // otherwise it's read from (or minted into) the file at `preapproveKeyPath`
  // (or its default, derived from resolvedDbPath).
  const resolvedPreapproveKey = preapproveKey || ensurePreapproveKey(resolvedDbPath, preapproveKeyPath)
  const resolvedMediaMaxBytes = mediaMaxBytes ?? resolveNumericEnv('MATRON_MEDIA_MAX_BYTES', process.env.MATRON_MEDIA_MAX_BYTES, DEFAULT_MEDIA_MAX_BYTES)
  const resolvedMediaUserQuotaBytes = mediaUserQuotaBytes ?? resolveNumericEnv('MATRON_MEDIA_USER_QUOTA_BYTES', process.env.MATRON_MEDIA_USER_QUOTA_BYTES, DEFAULT_MEDIA_USER_QUOTA_BYTES)
  // Agent-to-agent file transfers: a per-file cap and a per-user quota of
  // their own, apart from the media ones (src/transfers.js).
  const resolvedTransferMaxBytes = transferMaxBytes ?? resolveNumericEnv('MATRON_TRANSFER_MAX_BYTES', process.env.MATRON_TRANSFER_MAX_BYTES, TRANSFER_MAX_BYTES_DEFAULT)
  const resolvedTransferUserQuotaBytes = transferUserQuotaBytes ?? resolveNumericEnv('MATRON_TRANSFER_USER_QUOTA_BYTES', process.env.MATRON_TRANSFER_USER_QUOTA_BYTES, TRANSFER_USER_QUOTA_BYTES_DEFAULT)
  const resolvedTransferMaxAwaiting = transferMaxAwaitingPerSender ?? resolveNumericEnv('MATRON_TRANSFER_MAX_AWAITING_PER_SENDER', process.env.MATRON_TRANSFER_MAX_AWAITING_PER_SENDER, TRANSFER_MAX_AWAITING_PER_SENDER_DEFAULT)
  const resolvedMaxReplay = maxReplay ?? resolveNumericEnv('MATRON_MAX_REPLAY', process.env.MATRON_MAX_REPLAY, DEFAULT_MAX_REPLAY)
  const fileReads = resolveFileReads({ fileReadRoots, fileOwnerUserId, procSelfFdAvailable, fileHomeDir, dbPath: resolvedDbPath, mediaDir: resolvedMediaDir, preapproveKeyPath })
  const hub = makeHub()
  const broker = makeRpcBroker()
  // Wake-on-message for idle-stopped agent boxes (src/wake.js). Off unless
  // MATRON_WAKE_CMD is set (or a waker is injected by tests). Its verdicts
  // are kept on the device rows, so a box the command refuses shows offline
  // rather than asleep, across restarts.
  const resolvedWaker = waker || makeWaker({
    onRefused: (box) => markWakeRefused(db, box),
    onWoken: (box) => clearWakeRefused(db, box),
  })
  // A journal that cannot wake anything never waits for a wake — and its
  // orphan sweep TTL (derived in attachWs from this value) stays what it
  // always was, rather than growing by a window that can never be used.
  const effectiveWakeWaitMs = resolvedWaker.enabled ? spawnWakeWaitMs : 0
  // Stall wake sweep (src/stall-wake.js): a box whose stalled session's
  // usage-limit reset has passed is woken so its bridge can carry on. No-op
  // without a waker; stopped in close().
  const stallWakeSweep = startStallWakeSweep({ db, hub, waker: resolvedWaker, ...(stallWakeIntervalMs ? { intervalMs: stallWakeIntervalMs } : {}) })
  // Auto-archive (src/archive.js): hourly, archives each user's idle
  // conversations per their setting. MATRON_AUTO_ARCHIVE=0 stops it.
  const autoArchiveSweep = startAutoArchiveSweep({ db, hub, enabled: autoArchive, ...(autoArchiveIntervalMs ? { intervalMs: autoArchiveIntervalMs } : {}) })
  const unseenNudgeSweep = startUnseenNudge({ db, hub, enabled: unseenNudge, ...(unseenNudgeIntervalMs ? { intervalMs: unseenNudgeIntervalMs } : {}) })
  // Coordinator routines (spec 2026-10-01): one firer per process (the
  // sweep and POST /routines/:key/run share its in-flight bound), the
  // once-a-minute sweep, and the one-off seed for users who already have a
  // Coordinator (new assignments seed in coordinator-http.js).
  const routineFirer = makeRoutineFirer({ db, hub, broker, waker: resolvedWaker, wakeWaitMs: effectiveWakeWaitMs, timeoutMs: sessionControlTimeoutMs })
  const routinesSweeper = startRoutinesSweep({ db, firer: routineFirer, enabled: routinesSweep, ...(routinesSweepIntervalMs ? { intervalMs: routinesSweepIntervalMs } : {}), ...(routinesTriggerIntervalMs ? { triggerIntervalMs: routinesTriggerIntervalMs } : {}) })
  try {
    for (const { user_id: userId } of db.prepare('SELECT user_id FROM user_settings WHERE coordinator_convo_id IS NOT NULL AND routines_seeded_at IS NULL').all()) {
      const n = seedRoutines(db, userId)
      if (n > 0) console.log(`routines: seeded ${n} starter routine(s) for user ${userId}`)
    }
  } catch (err) { console.error('routines: boot seeding failed', err) }
  const toolStreams = makeToolStreamStore({
    maxBytes: resolveNumericEnv('MATRON_TOOL_STREAM_MAX_BYTES', process.env.MATRON_TOOL_STREAM_MAX_BYTES, 1048576),
    maxBuffers: resolveNumericEnv('MATRON_TOOL_STREAM_MAX_BUFFERS', process.env.MATRON_TOOL_STREAM_MAX_BUFFERS, 64),
    idleMs: resolveNumericEnv('MATRON_TOOL_STREAM_IDLE_MS', process.env.MATRON_TOOL_STREAM_IDLE_MS, 1800000),
    ...(toolStreamOpts || {}),
  })
  const { client: resolvedApnsClient, owned: ownsApnsClient } = resolveApnsClient(apnsClient)
  const pushPipeline = makePushPipeline({ db, hub, apnsClient: resolvedApnsClient, backgroundWakeMs: BACKGROUND_WAKE_MS })
  // A consent-card push whose 30 s hold a restart swallowed still goes out.
  try { pushPipeline.resumeHeldConsent() } catch (err) { console.error('push: consent resume failed', err) }
  // Voice notes are transcribed here when the journal has a transcriber: a
  // cloud one (MATRON_STT_AZURE_KEY; src/cloud-transcribe.js), or whisper
  // (MATRON_WHISPER_MODEL; src/transcribe.js). Neither: off, and the origin
  // bridge does it as before. `transcriber` is the test seam; `null` forces
  // it off.
  const resolvedTranscriber = transcriber === undefined
    ? makeConfiguredTranscriber({ deviceNames: (userId) => db.prepare('SELECT DISTINCT name FROM devices WHERE user_id=? ORDER BY name').all(userId).map((r) => r.name) })
    : transcriber
  // Chat voice notes, at upload: cloud only (src/blob-transcripts.js).
  const blobTranscripts = makeBlobTranscripts({ db, transcriber: resolvedTranscriber })
  const itemTranscription = makeItemTranscription({
    db,
    transcriber: resolvedTranscriber,
    blobTranscripts,
    onSettled: (out) => emitTranscriptionMarker({ db, hub, pushPipeline, waker: resolvedWaker }, out),
  })
  // Speech for voice mode (spec 2026-10-03 voice mode, section 2): Azure,
  // with MATRON_TTS_AZURE_KEY or, failing that, the transcription key. No
  // key (or MATRON_TTS_DISABLED=1): null, and POST /tts answers 501.
  const resolvedTts = tts === undefined
    ? makeConfiguredTts({ cacheDir: resolveTtsCacheDir(resolvedDbPath, ttsCacheDir) })
    : tts
  // GitHub account linking (spec 2026-09-23 tracker web/teams). `github` is
  // the test seam; env otherwise. An empty client id disables the routes.
  const resolvedGithub = github !== undefined ? github : makeGithub({
    clientId: process.env.MATRON_GITHUB_CLIENT_ID ?? DEFAULT_GITHUB_CLIENT_ID,
    clientSecret: process.env.MATRON_GITHUB_CLIENT_SECRET || null,
    deviceFlow: process.env.MATRON_GITHUB_DEVICE_FLOW !== '0',
    host: (process.env.MATRON_GITHUB_HOST || 'github.com').toLowerCase(),
  })
  // Static hosting of the web app (spec 2026-09-23 tracker web/teams). The
  // option is the test seam; env otherwise; unset serves nothing.
  const resolvedWebDir = resolveWebDir(webDir !== undefined ? webDir : process.env.MATRON_WEB_DIR)
  const handleStatic = makeStaticHandler({ webDir: resolvedWebDir })
  // App-link well-known files (spec 2026-09-23 tracker web/teams). The
  // options are the test seam; env otherwise; unset claims nothing (404).
  const handleAppWellKnown = makeWellKnown({
    appleAppIds: appleAppIds !== undefined ? appleAppIds : parseList(process.env.MATRON_APPLE_APP_IDS),
    androidPackage: androidPackage !== undefined ? androidPackage : (process.env.MATRON_ANDROID_PACKAGE || null),
    androidCertSha256: androidCertSha256 !== undefined ? androidCertSha256 : parseList(process.env.MATRON_ANDROID_CERT_SHA256),
  })
  const federation = loadFederation(db, tokenBox, federationEnv ?? {
    federation: process.env.MATRON_FEDERATION, publicUrl: process.env.MATRON_PUBLIC_URL,
    allowJournals: process.env.MATRON_FEDERATION_ALLOW_JOURNALS, denyJournals: process.env.MATRON_FEDERATION_DENY_JOURNALS,
  })
  const handleFederationWellKnown = makeFederationWellKnown(federation)
  const handleContactPage = makeContactPage(federation)
  const handleWellKnown = (req, res, url) => handleFederationWellKnown(req, res, url) || handleContactPage(req, res, url) || handleAppWellKnown(req, res, url)
  // The outbound client (src/federation-client.js): `federationClient` is
  // its test seam. Contacts across journals (src/federation-contacts.js)
  // register their ops with both ends.
  const federationClientInUse = federation.enabled ? (federationClient ?? makeConfiguredFederationClient()) : null
  const federationContacts = federation.enabled
    ? makeContactFederation({ db, hub, pushPipeline, federation, client: federationClientInUse })
    : null
  // Mission shares with contacts on other journals (src/federation-grants.js).
  const federationGrants = federation.enabled ? makeGrantFederation({ db, hub, pushPipeline, federation }) : null
  // What a contributor on another journal writes, and the owner's replies
  // (src/federation-contribute.js).
  const federationContribute = federation.enabled ? makeContributeFederation({ db, hub, pushPipeline, waker: resolvedWaker, federation }) : null
  // Rooms with contacts on other journals (src/federation-rooms.js).
  const federationRooms = federation.enabled ? makeRoomFederation({ db, hub, pushPipeline, waker: resolvedWaker, federation }) : null
  // POST /federation/v1 (src/federation-inbound.js): 404 while off.
  // `federationOps` is the test seam: extra ops, over the journal's own.
  // One set of abuse limits for both federation routes (federationLimits
  // is the test seam).
  const federationLimiter = makeFederationLimiter(federationLimits ?? {})
  const handleFederationOps = makeFederationHandler({
    db, federation, client: federationClientInUse, limiter: federationLimiter,
    ops: { ...DEFAULT_OPS, ...(federationContacts?.inbound ?? {}), ...(federationGrants?.inbound ?? {}), ...(federationContribute?.inbound ?? {}), ...(federationRooms?.inbound ?? {}), ...(federationOps ?? {}) },
  })
  // Attachments of read shares (src/federation-media.js): the owner's
  // signed pull, and the grantee's pull-through copy behind GET /media/:id.
  const handleFederationMedia = makeMediaHandler({ db, federation, limiter: federationLimiter })
  const handleFederation = async (req, res, url) => (await handleFederationMedia(req, res, url)) || handleFederationOps(req, res, url)
  const federationMedia = federation.enabled
    ? makeReplicaMedia({ db, federation, client: federationClientInUse, mediaDir: resolvedMediaDir, mediaMaxBytes: resolvedMediaMaxBytes, quotaBytes: resolvedMediaUserQuotaBytes })
    : null
  // The outbox (src/federation-outbox.js): built only when federation is on.
  const federationOutbox = federation.enabled
    ? makeOutbox({ db, hub, federation, client: federationClientInUse, ops: { ...federationContacts.outbound, ...federationGrants.outbound, ...federationContribute.outbound, ...federationRooms.outbound }, beforePass: () => federationGrants.resnapshot() })
    : null
  federationContacts?.setOutbox(federationOutbox)
  federationGrants?.setOutbox(federationOutbox)
  federationContribute?.setOutbox(federationOutbox)
  federationRooms?.setOutbox(federationOutbox)
  const resolvedAlertWebhook = alertWebhook !== undefined ? alertWebhook : {
    token: process.env.MATRON_ALERT_WEBHOOK_TOKEN || null,
    username: process.env.MATRON_ALERT_WEBHOOK_USER || null,
  }
  if (resolvedAlertWebhook) warnAlertWebhookConfig(db, resolvedAlertWebhook)
  const resolvedSummariser = summariser !== undefined ? summariser : makeConfiguredSummariser()
  const resolvedMailer = mailer !== undefined ? mailer : makeConfiguredMailer()
  // Unified search's similar tier (spec 2026-10-12 §5). `semantic.store`/
  // `.embedder` start null — /search/all answers `semantic: 'off'` until
  // (if ever) the embedder loads and the first index pass finishes, below.
  // Declared before the handler is built so both it and close() share the
  // same mutable record. `semanticTimer` is the periodic reindex sweep;
  // `semanticInFlight` is whichever reindex pass (initial or periodic) is
  // currently running, so close() can wait for it instead of racing a
  // write against a closing db handle.
  const semantic = { store: null, embedder: null }
  let semanticTimer = null
  let indexingNow = false
  let semanticInFlight = Promise.resolve()
  const server = http.createServer(logSlowRequests(httpHandlerFactory({
    db, rateLimiter, loginGuard, twoFactorLimiter, tickets, mediaDir: resolvedMediaDir, mediaMaxBytes: resolvedMediaMaxBytes,
    mediaUserQuotaBytes: resolvedMediaUserQuotaBytes,
    // transferChunkBytes: tests only (small chunks); production uses TRANSFER_CHUNK_BYTES.
    transferMaxBytes: resolvedTransferMaxBytes, transferUserQuotaBytes: resolvedTransferUserQuotaBytes, transferMaxAwaitingPerSender: resolvedTransferMaxAwaiting, transferChunkBytes,
    hub, pushPipeline, dbPath: resolvedDbPath, pairs: resolvedPairs, links: resolvedLinks,
    preapproveKey: resolvedPreapproveKey, broker, spawnStartTimeoutMs, spawnWakeWaitMs: effectiveWakeWaitMs, waker: resolvedWaker, itemTranscription, blobTranscripts, consentDailyCap, consentTransferDailyCap, consentRoutineCap, verifier,
    agentCommentLimiter: makeAgentCommentLimiter({ now: agentCommentClock }),
    fileReads,
    github: resolvedGithub, handleWellKnown, handleFederation, federationOutbox, federationContacts, federationGrants, federationContribute, federationMedia, handleStatic, tokenBox,
    sessionControlTimeoutMs, alertWebhook: resolvedAlertWebhook, routineFirer, semantic, summariser: resolvedSummariser, mailer: resolvedMailer, tts: resolvedTts,
  })))
  // A reverse proxy in front of the journal keeps its connections to it open
  // and reuses them. Node closes an idle connection after 5 s by default,
  // well before a proxy gives it up, so a request the proxy sent down a
  // connection the journal was closing at that moment was reset, and the
  // caller got a 502 for a request that never ran. Keep idle connections
  // longer than a proxy does (the usual 60–90 s). The header timeout is
  // left alone: on the Node versions this runs on it times a request's
  // headers from when they start arriving, not the idle wait before them.
  server.keepAliveTimeout = resolveNumericEnv('MATRON_KEEPALIVE_TIMEOUT_MS', process.env.MATRON_KEEPALIVE_TIMEOUT_MS, 120000)
  const wss = attachWs({
    server, db, hub, pushPipeline, replayBackpressureBytes, maxReplay: resolvedMaxReplay, toolStreams,
    // 55s: under the common 60s proxy idle-timeout defaults, and a 2.75x
    // cut in heartbeat radio wakes for idle phone clients vs the old 20s.
    pingMs: resolveNumericEnv('MATRON_WS_PING_MS', process.env.MATRON_WS_PING_MS, 55000),
    rpcMaxBytes: resolveNumericEnv('MATRON_RPC_MAX_BYTES', process.env.MATRON_RPC_MAX_BYTES, 16384),
    // permessage-deflate for clients that offer it (see WS_DEFLATE_OPTIONS);
    // MATRON_WS_DEFLATE=0 turns it off without a code change.
    perMessageDeflate: wsDeflate ?? resolveBooleanEnv('MATRON_WS_DEFLATE', process.env.MATRON_WS_DEFLATE, true),
    ...(revocationSweepMs !== undefined ? { revocationSweepMs } : {}),
    ...(inviteTtlMs !== undefined ? { inviteTtlMs } : {}),
    // spawnStartTimeoutMs rides along so the orphan sweep's TTL can never
    // undercut a configured start timeout (attachWs derives the TTL).
    broker, spawnFoldersTimeoutMs, spawnStartTimeoutMs, spawnWakeWaitMs: effectiveWakeWaitMs, sessionControlTimeoutMs, waker: resolvedWaker,
  })
  let retentionInterval = null
  let walCheckpointInterval = null
  let stallLog = null
  let receiptPruneInterval = null
  let githubRefreshInterval = null
  let ttsSweepInterval = null
  let closing = false
  return new Promise((resolve) => {
    server.listen(port, bind, () => {
      const startDelay = cancellableDelay(backgroundDelayMs)
      retentionInterval = scheduleRetention(db, {
        mediaDir: resolvedMediaDir, hub, retentionDays, retentionIntervalMs, retentionInitialDelayMs, toolLogTtlHours, voiceNoteTtlDays,
        mediaReapHighPct, mediaReapLowPct, mediaUserQuotaBytes: resolvedMediaUserQuotaBytes, deviceRetention,
        orphanBlobGraceHours,
      })
      walCheckpointInterval = scheduleWalCheckpoint(db, walCheckpointIntervalMs)
      stallLog = startStallLog()
      // Federation receipts are the replay memory for 30 days, then go.
      // What the outbox sent or cancelled goes a week after it ended, with
      // federation on or off (its bodies hold snapshot pages and invite
      // tokens).
      receiptPruneInterval = setInterval(() => {
        try { pruneOutbox(db) } catch (err) { console.error('federation: outbox prune failed', err) }
        if (!federation.enabled) return
        try { pruneReceipts(db) } catch (err) { console.error('federation: receipt prune failed', err) }
        try { purgeReplicaMedia(db) } catch (err) { console.error('federation: media purge failed', err) }
      }, 3600_000)
      receiptPruneInterval.unref()
      if (federation.enabled) federationOutbox.start()
      githubRefreshInterval = scheduleGithubRefresh(db, resolvedGithub, { intervalMs: githubRefreshIntervalMs, box: tokenBox })
      ttsSweepInterval = scheduleTtsSweep(resolvedTts, ttsSweepIntervalMs)
      // Whatever a previous process left mid-transcription: a bridge is
      // holding a turn for each, so finish them (or fail them) now.
      itemTranscription.recover()
      blobTranscripts.recover()
      // Background work, one job at a time and only after the startup
      // delay: the message index backfill, the is_diff fix-up, image sizes,
      // then the embedder load and the first vector pass. Each walk saves
      // its place per batch, so a restart picks up where the last process
      // stopped. Search serves partial results meanwhile (self-healing —
      // spec). shouldStop lets close() end a walk cleanly instead of racing
      // a closed DB handle, and close() cancels the delay. Each walk gets a
      // fresh throttle, which times a batch from the end of the last rest,
      // so the gap before a walk starts never counts as work.
      const bg = () => ({ log: (l) => console.log(l), shouldStop: () => closing, pause: throttle({ ratio: backgroundPace }) })
      const searchBackfill = startDelay.promise.then(() => (closing ? null : backfillSearchIndex(db, bg())))
        .catch((err) => { console.error('search backfill failed', err) })
      // search_messages.is_diff on rows written before the column existed
      // (spec 2026-10-12 unified search) — ranked search answers with
      // whatever is fixed up so far meanwhile.
      const isDiffBackfill = searchBackfill.then(() => (closing ? null : backfillIsDiff(db, bg())))
        .catch((err) => { console.error('search is_diff backfill failed', err) })
      // Older item comments get their images' sizes stamped on.
      const imageDimsBackfill = isDiffBackfill.then(() => (closing ? null : backfillImageDims(db, bg())))
        .catch((err) => { console.error('image size backfill failed', err) })
      // Unified search (spec 2026-10-12 §5): tracker docs are indexed by
      // trigger; vectors come from a local model loaded in the background.
      // Off by env, by a missing optional package, or by a failed load —
      // search answers lexically meanwhile. ensureVectorSchema runs
      // unconditionally (idempotent, CREATE ... IF NOT EXISTS) so the
      // search_vectors table exists before the indexer ever touches it,
      // whether or not an embedder ends up loading.
      ensureVectorSchema(db)
      const semanticOff = process.env.MATRON_SEMANTIC_SEARCH === 'off'
      const embedderReady = imageDimsBackfill.then(() => {
        if (closing) return null
        if (embedder !== undefined) return embedder
        return semanticOff ? null : loadEmbedder({
          modelDir: process.env.MATRON_SEMANTIC_MODEL_DIR || path.join(path.dirname(resolvedDbPath), 'models'),
          allowDownload: !process.env.MATRON_SEMANTIC_MODEL_DIR,
        })
      })
      embedderReady.then(async (loadedEmbedder) => {
        if (!loadedEmbedder || closing) return
        semantic.embedder = loadedEmbedder
        semantic.store = createVectorStore(db, loadedEmbedder)
        // Docs the embedder failed on, kept for this process run so a
        // sweep doesn't retry them every 30 seconds.
        const skippedDocs = new Set()
        // `trackIndexing`: the store
        // already starts `indexing` (createVectorStore's own default), so
        // `'indexing'` naturally covers this first pass without an extra
        // call. Only this initial call flips it back to `'ready'` when
        // done — a later 30s sweep pass runs with `trackIndexing: false`,
        // so `semantic` stays `'ready'` between boot and the next edit
        // instead of flickering to `'indexing'` every 30 seconds.
        const reindex = async (trackIndexing) => {
          try {
            await runVectorIndexer(db, loadedEmbedder, { ...bg(), onWrite: (rows) => semantic.store.upsertVectors(rows), skipped: skippedDocs })
          } catch (err) {
            // Never reject: semanticInFlight is awaited both here and by
            // close() (alongside the other background work) — a rejection
            // (e.g. a write that lost its race with a closing db handle)
            // would otherwise stop close() from ever reaching db.close().
            console.error('vector index: reindex pass failed', err)
          } finally {
            if (trackIndexing) semantic.store.setIndexing(false)
          }
        }
        semanticInFlight = reindex(true)
        await semanticInFlight
        // Closed while that first pass ran: don't arm a sweep nothing will
        // ever clear (close() below only clears a timer it can already see).
        if (closing) return
        // New and edited docs: a periodic sweep. An edited body drops its
        // vector by trigger, so an idle pass is one anti-join of search_docs
        // against search_vectors' primary key — no hashing, no embedding —
        // that finds nothing pending. unref'd like the
        // other background timers — never keeps the process alive on its own.
        // Runs with trackIndexing:false — the similar tier still answers
        // from whatever is already indexed while a sweep is in flight.
        semanticTimer = setInterval(() => {
          if (!indexingNow) {
            indexingNow = true
            semanticInFlight = reindex(false).finally(() => { indexingNow = false })
          }
        }, 30_000)
        semanticTimer.unref()
      }).catch((err) => console.error('semantic search setup failed', err))
      resolve({
        port: server.address().port,
        db,
        server,
        hub,
        broker,
        toolStreams,
        pushPipeline,
        itemTranscription,
        blobTranscripts,
        tts: resolvedTts,
        preapproveKey: resolvedPreapproveKey,
        searchBackfill,
        isDiffBackfill,
        imageDimsBackfill,
        unseenNudge: unseenNudgeSweep,
        routinesSweep: routinesSweeper,
        autoArchive: autoArchiveSweep,
        routineFirer,
        github: resolvedGithub,
        federationOutbox,
        federationContacts,
        federationGrants,
        federationMedia,
        federation,
        // close({ closeCode, closeReason, graceMs }): with a closeCode every
        // open websocket first gets a close frame carrying it, so a client
        // can tell a restart from a network drop, and up to graceMs to
        // acknowledge. Whatever is left is terminated either way.
        close: ({ closeCode, closeReason, graceMs = 1000, hardCutMs = 5000 } = {}) => new Promise((r) => {
          closing = true
          startDelay.cancel()
          if (retentionInterval) { clearInterval(retentionInterval); retentionInterval.stop() }
          if (walCheckpointInterval) clearInterval(walCheckpointInterval)
          if (stallLog) stallLog.stop()
          if (receiptPruneInterval) clearInterval(receiptPruneInterval)
          // A delivery pass in flight finishes (its requests time out at
          // 30 s) before the db handle closes.
          const outboxDone = federationOutbox ? federationOutbox.stop() : Promise.resolve()
          if (githubRefreshInterval) clearInterval(githubRefreshInterval)
          // No new reindex pass can start after this: the only other
          // starter is embedderReady's own `.then`, which re-checks
          // `closing` right after its first pass (above) before ever
          // arming the timer this clears.
          if (semanticTimer) clearInterval(semanticTimer)
          if (ttsSweepInterval) clearInterval(ttsSweepInterval)
          stallWakeSweep.stop()
          autoArchiveSweep.stop()
          unseenNudgeSweep.stop()
          routinesSweeper.stop()
          // Wake-before-spawn waiters (hub.waitForDevice) hold ref'd timers
          // of up to spawnWakeWaitMs; release them before the sockets go so
          // each approveSpawn settles its row while the DB is still open.
          hub.close()
          wss.close()
          const finish = () => {
            for (const c of wss.clients) c.terminate()
            pushPipeline.close()
            if (ownsApnsClient) resolvedApnsClient.close()
            // The transcription queue touches the DB between awaits: abort its
            // child and let it drain before the handle closes.
            const transcriptionDone = Promise.all([itemTranscription.close(), blobTranscripts.close()])
            // semanticInFlight: whichever reindex pass (initial or periodic)
            // is running right now — runVectorIndexer's own shouldStop only
            // re-checks between batches, so a pass already inside an awaited
            // embed call could otherwise still be mid-write when db.close()
            // below fires. Waiting for it here, alongside the other
            // background work, keeps that from racing a closed db handle.
            // A POST /tts waiting on Azure would hold server.close() for up to
            // its 20 s timeout: abort it, so the caller gets its 502 now.
            if (resolvedTts) resolvedTts.close()
            // A kept-alive socket whose request is still running stays open
            // after the reply, so server.close() alone can wait out the
            // keep-alive timeout. Release each one as soon as it is idle;
            // a request still running at hardCutMs (before the shutdown
            // watchdog) is cut so a stalled one cannot hold shutdown open.
            const idleSweep = setInterval(() => server.closeIdleConnections(), 100)
            idleSweep.unref()
            const hardCut = setTimeout(() => server.closeAllConnections(), hardCutMs)
            hardCut.unref()
            server.close(() => { clearInterval(idleSweep); clearTimeout(hardCut); Promise.all([searchBackfill, isDiffBackfill, imageDimsBackfill, embedderReady.catch(() => {}), transcriptionDone, semanticInFlight, outboxDone]).then(() => { db.close(); r() }) })
          }
          const open = closeCode === undefined ? [] : [...wss.clients].filter((c) => c.readyState === 1)
          if (!open.length) { finish(); return }
          let grace
          Promise.race([
            Promise.all(open.map((c) => new Promise((done) => {
              c.once('close', done)
              try { c.close(closeCode, closeReason) } catch { done() }
            }))),
            new Promise((done) => { grace = setTimeout(done, graceMs) }),
          ]).then(() => { clearTimeout(grace); finish() })
        }),
      })
    })
  })
}

// WebSocket close code 1012 (Service Restart): tells a client the server is
// going away on purpose and will be back, so it can reconnect at once
// instead of treating the drop as a network failure and backing off.
export const RESTART_CLOSE_CODE = 1012
export const RESTART_CLOSE_REASON = 'restarting'
const SHUTDOWN_TIMEOUT_MS = 10000

// SIGTERM/SIGINT: close every socket with 1012 "restarting", close the
// server cleanly, exit 0. The whole sequence is bounded: a close that has
// not finished in timeoutMs exits 1 so a stuck handle cannot hang a restart.
export function installShutdownHandlers(s, {
  proc = process, timeoutMs = SHUTDOWN_TIMEOUT_MS, graceMs = 1000, log = (l) => console.log(l),
} = {}) {
  let stopping = false
  const stop = (signal) => {
    if (stopping) return
    stopping = true
    log(`matron-journal: ${signal}, closing`)
    const timer = setTimeout(() => {
      log('matron-journal: shutdown timed out, exiting')
      proc.exit(1)
    }, timeoutMs)
    s.close({ closeCode: RESTART_CLOSE_CODE, closeReason: RESTART_CLOSE_REASON, graceMs, hardCutMs: Math.max(0, timeoutMs - graceMs - 2000) })
      .then(() => { clearTimeout(timer); proc.exit(0) },
        (err) => { console.error('shutdown failed', err); proc.exit(1) })
  }
  proc.on('SIGTERM', () => stop('SIGTERM'))
  proc.on('SIGINT', () => stop('SIGINT'))
}

let isMain = false
try {
  isMain = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
} catch { /* argv[1] missing or unresolvable: not the entrypoint */ }
if (isMain) {
  const port = Number(process.env.MATRON_PORT || 9810)
  const bind = process.env.MATRON_BIND || '127.0.0.1'
  startServer({ port, bind }).then((s) => {
    console.log(`matron-journal listening on ${bind}:${s.port}`)
    installShutdownHandlers(s)
  })
}
