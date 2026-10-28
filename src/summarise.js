// Conversation titles and rolling summaries, written here for the bridges.
// A bridge used to hold its own model API keys to do this, in an env file on
// every developer box; now one key lives on the journal host (ideally in a
// root-only file, MATRON_SUMMARY_ANTHROPIC_KEY_FILE) and bridges ask
// POST /summarise (src/summarise-http.js) with their device token instead.
//
// The journal is a pass-through: the prompt goes to the Anthropic Messages
// API and the completion goes back to the calling device. Nothing from the
// prompt or the completion is stored or logged — only status codes, token
// counts and the calling device id, so spending stays attributable per
// device without keeping any conversation text.
//
// Optional by construction: with no key makeSummariser returns null, the
// route answers 503 summariser_unavailable, and a bridge falls through to
// whatever it did before.
import fs from 'node:fs'

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
export const ANTHROPIC_VERSION = '2023-06-01'
export const DEFAULT_SUMMARY_MODEL = 'claude-haiku-5-5'
export const DEFAULT_DEVICE_HOURLY = 120
export const DEFAULT_CONCURRENCY = 8
export const SUMMARY_MAX_TOKENS = 1024
export const SUMMARY_TIMEOUT_MS = 30000
const HOUR_MS = 3600000

// The key comes from MATRON_SUMMARY_ANTHROPIC_KEY, or from the file named by
// MATRON_SUMMARY_ANTHROPIC_KEY_FILE (so it need not sit in the unit's
// environment) — the same rule as cloud-transcribe.js's resolveAzureKey.
// Never logged.
export function resolveSummaryKey(env = process.env) {
  if (env.MATRON_SUMMARY_ANTHROPIC_KEY) return env.MATRON_SUMMARY_ANTHROPIC_KEY.trim()
  if (env.MATRON_SUMMARY_ANTHROPIC_KEY_FILE) return fs.readFileSync(env.MATRON_SUMMARY_ANTHROPIC_KEY_FILE, 'utf8').trim()
  return ''
}

// MATRON_SUMMARY_USERS: the journal user names allowed to use the key, as a
// comma-separated list. Whitespace around a name and empty entries are
// dropped. Unset, or nothing left after that, is null: every user allowed,
// so a single-operator install needs no setting.
export function parseSummaryUsers(raw) {
  if (typeof raw !== 'string') return null
  const names = raw.split(',').map((n) => n.trim()).filter(Boolean)
  return names.length ? new Set(names) : null
}

// A positive integer from the environment, or the default.
const positiveInt = (raw, fallback) => {
  const n = Number(raw)
  return raw != null && raw !== '' && Number.isInteger(n) && n > 0 ? n : fallback
}

// Rolling-window budget per key (device id). Unlike auth.js's
// makeRateLimiter it says when the oldest hit ages out, for Retry-After.
export function makeWindowLimiter({ max, windowMs = HOUR_MS, now = Date.now }) {
  const hits = new Map()
  const live = (key, t) => {
    if (hits.size > 10000) {
      for (const [k, list] of hits) if (!list.length || t - list[list.length - 1] >= windowMs) hits.delete(k)
    }
    const list = (hits.get(key) || []).filter((h) => t - h < windowMs)
    hits.set(key, list)
    return list
  }
  const verdict = (list, t) => (list.length >= max ? { ok: false, retryAfterMs: list[0] + windowMs - t } : { ok: true })
  return {
    // {ok:true}, or {ok:false, retryAfterMs}; never records a hit.
    check(key) {
      const t = now()
      return verdict(live(key, t), t)
    },
    // As check, and records a hit when ok.
    take(key) {
      const t = now()
      const list = live(key, t)
      const v = verdict(list, t)
      if (v.ok) list.push(t)
      return v
    },
  }
}

// Thrown for every upstream problem. `reason` and `status` are safe to log;
// the upstream body never rides along.
export class SummariseError extends Error {
  constructor(reason, status = null) {
    super(`summarise upstream ${reason}${status != null ? ` HTTP ${status}` : ''}`)
    this.reason = reason
    this.status = status
  }
}

const blankUsage = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
const blankStats = () => ({ requests: 0, outcomes: {}, ...blankUsage() })

export function makeSummariser({
  key,
  model = DEFAULT_SUMMARY_MODEL,
  deviceHourly = DEFAULT_DEVICE_HOURLY,
  concurrency = DEFAULT_CONCURRENCY,
  timeoutMs = SUMMARY_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = console,
  // A Set of user names, or null for everyone (parseSummaryUsers).
  users = null,
} = {}) {
  if (!key) return null
  const limiter = makeWindowLimiter({ max: deviceHourly, now })
  let inFlight = 0
  // Usage for GET /metrics: totals, and per device with its user so the
  // route can show a user only their own devices. In memory: a restart
  // starts from zero. The durable record is the log: one line for each call
  // that goes upstream and each MATRON_SUMMARY_USERS refusal; `rate_limited`
  // and `busy` refusals are counted here only.
  const totals = blankStats()
  const byDevice = new Map()

  const record = (who, outcome, usage = blankUsage()) => {
    let d = byDevice.get(who.deviceId)
    if (!d) { d = { userId: who.userId, ...blankStats() }; byDevice.set(who.deviceId, d) }
    for (const s of [totals, d]) {
      s.requests += 1
      s.outcomes[outcome] = (s.outcomes[outcome] || 0) + 1
      for (const k of Object.keys(usage)) s[k] += usage[k]
    }
  }

  async function callUpstream({ system, prompt }) {
    const body = {
      model,
      max_tokens: SUMMARY_MAX_TOKENS,
      thinking: { type: 'disabled' },
      // The system prompt is the same instructions on every call from a
      // bridge, so it is cached.
      ...(system ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : {}),
      messages: [{ role: 'user', content: prompt }],
    }
    let res
    try {
      res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw new SummariseError(err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network')
    }
    // The body of an error carries nothing we need and may echo the
    // request: drain it, never read it into a message.
    if (!res.ok) {
      try { await res.body?.cancel() } catch { /* already gone */ }
      throw new SummariseError('status', res.status)
    }
    let out
    try { out = await res.json() } catch { throw new SummariseError('bad_json', res.status) }
    const u = out?.usage || {}
    const usage = {
      inputTokens: u.input_tokens | 0,
      outputTokens: u.output_tokens | 0,
      cacheReadTokens: u.cache_read_input_tokens | 0,
      cacheWriteTokens: u.cache_creation_input_tokens | 0,
    }
    // Billed even when unusable, so the usage rides on the error too.
    if (out?.stop_reason !== 'end_turn') throw Object.assign(new SummariseError('stop_reason'), { usage })
    const text = (Array.isArray(out.content) ? out.content : [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text).join('').trim()
    if (!text) throw Object.assign(new SummariseError('empty'), { usage })
    return { text, model: typeof out.model === 'string' ? out.model : model, usage }
  }

  return {
    model,
    // Is this user (by name, users.name — unique, and exact as at /login)
    // allowed to spend the key? An unlisted user's call is recorded against
    // its device and logged, and the route answers 503 as if there were no
    // key: a bridge backs off on 503, where a 403 would be retried on every
    // summary.
    allows(who, userName) {
      if (!users || (typeof userName === 'string' && users.has(userName))) return true
      record(who, 'not_allowed')
      log.log(`summarise: device=${who.deviceId} user=${who.userId} not allowed (not in MATRON_SUMMARY_USERS)`)
      return false
    },
    // {status:'ok', text, model, usage} | {status:'rate_limited', retryAfter}
    // | {status:'busy', retryAfter} | {status:'upstream_failed'}.
    // `who` is the authenticated device; only its id and user are used.
    async summarise(who, { system, prompt }) {
      const rateLimited = (gate) => {
        record(who, 'rate_limited')
        return { status: 'rate_limited', retryAfter: Math.max(1, Math.ceil(gate.retryAfterMs / 1000)) }
      }
      // Budget first without spending it, so an over-budget device is told
      // the real wait rather than the busy one.
      const gate = limiter.check(who.deviceId)
      if (!gate.ok) return rateLimited(gate)
      // A burst from many devices at once is refused rather than queued,
      // so upstream calls never pile up behind the cap. A call refused here
      // does not spend the device's hourly budget.
      if (inFlight >= concurrency) {
        record(who, 'busy')
        return { status: 'busy', retryAfter: 2 }
      }
      // Holding a slot, the call is charged — whatever upstream then does,
      // failures included, so a broken upstream cannot be hammered. Nothing
      // awaits between check and take, so this cannot disagree with it.
      const taken = limiter.take(who.deviceId)
      if (!taken.ok) return rateLimited(taken)
      inFlight += 1
      const t0 = now()
      try {
        const r = await callUpstream({ system, prompt })
        record(who, 'ok', r.usage)
        log.log(`summarise: device=${who.deviceId} ok in=${r.usage.inputTokens} out=${r.usage.outputTokens} cache_read=${r.usage.cacheReadTokens} cache_write=${r.usage.cacheWriteTokens} ms=${now() - t0}`)
        return { status: 'ok', ...r }
      } catch (err) {
        if (!(err instanceof SummariseError)) throw err
        record(who, 'upstream_failed', err.usage)
        log.error(`summarise: device=${who.deviceId} upstream failed: ${err.reason}${err.status != null ? ` HTTP ${err.status}` : ''} ms=${now() - t0}`)
        return { status: 'upstream_failed' }
      } finally {
        inFlight -= 1
      }
    },
    // GET /metrics' `summarise` section: global totals (bare numbers, safe
    // for any caller, like `push`) and per-device usage for ONE user's
    // devices, `keepDevice` dropping the ones the caller may not see.
    metrics(userId, keepDevice = () => true) {
      const shape = (s) => ({
        requests: s.requests, outcomes: { ...s.outcomes },
        input_tokens: s.inputTokens, output_tokens: s.outputTokens,
        cache_read_tokens: s.cacheReadTokens, cache_write_tokens: s.cacheWriteTokens,
      })
      const devices = [...byDevice].filter(([id, d]) => d.userId === userId && keepDevice(id))
        .sort(([a], [b]) => a - b).map(([id, d]) => ({ device_id: id, ...shape(d) }))
      return { enabled: true, model, ...shape(totals), devices }
    },
  }
}

// The summariser this journal runs: one when a key is configured, else
// null. A key file that is set but unreadable is said loudly at boot.
export function makeConfiguredSummariser({ env = process.env, log = console, fetchImpl } = {}) {
  let key = ''
  try { key = resolveSummaryKey(env) } catch (err) {
    log.error(`summarise: MATRON_SUMMARY_ANTHROPIC_KEY_FILE is set but unreadable (${err.code ?? err.message}) — POST /summarise answers 503`)
  }
  if (!key) return null
  const s = makeSummariser({
    key,
    model: env.MATRON_SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL,
    deviceHourly: positiveInt(env.MATRON_SUMMARY_DEVICE_HOURLY, DEFAULT_DEVICE_HOURLY),
    concurrency: positiveInt(env.MATRON_SUMMARY_CONCURRENCY, DEFAULT_CONCURRENCY),
    users: parseSummaryUsers(env.MATRON_SUMMARY_USERS),
    log,
    ...(fetchImpl ? { fetchImpl } : {}),
  })
  const users = parseSummaryUsers(env.MATRON_SUMMARY_USERS)
  log.log(`summarise: POST /summarise is on, model ${s.model}, ${users ? `for ${users.size} listed user(s)` : 'for every user'}`)
  return s
}
