// Cloud text-to-speech for voice mode: Azure Speech, MAI-Voice-2.1-Flash by
// default (spec 2026-10-03 voice mode, section 2). Optional by construction:
// with no key makeCloudTts returns null, POST /tts answers 501 and the app
// speaks with the on-device voice.
//
// One object, two callers. The HTTP route (src/tts-http.js) hands it a
// client's text; a later server-side caller (the spoken notification, phase
// 3 of the spec) calls synthesize({userId, text, format: 'wav'}) directly.
// Both get the same validation, cache, budget and concurrency cap.
//
// The text is the only thing a caller controls. It is stripped of control
// characters, XML-escaped and placed inside one <voice> element; the voice
// comes from an allow-list and the format from a fixed table, so no caller
// can put markup into the SSML.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveAzureKey } from './cloud-transcribe.js'

export const DEFAULT_TTS_REGION = 'northeurope'
export const DEFAULT_TTS_MODEL = 'MAI-Voice-2.1-Flash'
export const DEFAULT_TTS_VOICE = 'en-GB-Harry'
export const DEFAULT_TTS_DAILY_CHARS = 300000
export const TTS_TEXT_MAX = 2000
export const TTS_CACHE_TTL_MS = 24 * 3600000
// Azure's speech endpoint refuses a request with no User-Agent.
export const TTS_USER_AGENT = 'matron-journal'

// The voices on offer. The Azure voice name is `<id>:<model>`.
export const TTS_VOICES = Object.freeze([
  Object.freeze({ id: 'en-GB-Harry', name: 'Harry', locale: 'en-GB', gender: 'male' }),
  Object.freeze({ id: 'en-GB-Emily', name: 'Emily', locale: 'en-GB', gender: 'female' }),
])

// mp3 for playing in the app; wav (PCM) for notification sounds, which iOS
// will not play from mp3.
export const TTS_FORMATS = Object.freeze({
  mp3: Object.freeze({ azure: 'audio-24khz-48kbitrate-mono-mp3', contentType: 'audio/mpeg', ext: 'mp3' }),
  wav: Object.freeze({ azure: 'riff-16khz-16bit-mono-pcm', contentType: 'audio/wav', ext: 'wav' }),
})

export const TTS_ERROR_STATUS = Object.freeze({
  bad_request: 400,
  unknown_voice: 400,
  tts_budget_exceeded: 429,
  tts_busy: 503,
  tts_failed: 502,
})

// Every refusal synthesize() makes. `code` is the wire error; `status` its
// HTTP status. The message never carries the text or the key.
export class TtsError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'TtsError'
    this.code = code
    this.status = TTS_ERROR_STATUS[code] ?? 500
  }
}

// What XML 1.0 cannot carry (C0 controls other than tab, LF and CR), DEL and
// the C1 controls, the two non-characters, and U+FFFD (what toWellFormed
// leaves in place of a lone surrogate).
const UNSPEAKABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd\ufffe\uffff]/g

// The text as it is hashed, counted and spoken: control characters removed,
// then trimmed. null for anything that is not a string.
export function cleanTtsText(raw) {
  if (typeof raw !== 'string') return null
  return raw.toWellFormed().replace(UNSPEAKABLE, '').trim()
}

const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
export function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => XML_ENTITIES[c])
}

export function azureVoiceName(id, model) {
  return model ? `${id}:${model}` : id
}

export function buildSsml({ text, voiceName, locale }) {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(locale)}">` +
    `<voice name="${escapeXml(voiceName)}">${escapeXml(text)}</voice></speak>`
}

// sha256 of `voice|model|format|text`. voice, model and format come from
// fixed sets with no `|` in them and the text is last, so two different
// requests cannot share a key.
export function ttsCacheKey({ voice, model, format, text }) {
  return crypto.createHash('sha256').update(`${voice}|${model}|${format}|${text}`).digest('hex')
}

// Clips live beside the database, in their own directory: never in the media
// store, whose blobs are user-owned rows that count against the user's quota
// and are only reaped under quota pressure.
export function resolveTtsCacheDir(dbPath, override) {
  return override || path.join(path.dirname(dbPath), 'tts-cache')
}

// MATRON_TTS_AZURE_KEY, or the file named by MATRON_TTS_AZURE_KEY_FILE. With
// neither set, the transcription key (cloud-transcribe.js): it is the same
// Azure Speech resource. Never logged.
export function resolveTtsKey(env = process.env) {
  if (env.MATRON_TTS_AZURE_KEY) return env.MATRON_TTS_AZURE_KEY.trim()
  if (env.MATRON_TTS_AZURE_KEY_FILE) return fs.readFileSync(env.MATRON_TTS_AZURE_KEY_FILE, 'utf8').trim()
  return resolveAzureKey(env)
}

const REGION_RE = /^[a-z0-9]{2,40}$/
const STT_REGIONAL_ENDPOINT_RE = /^https:\/\/([a-z0-9]{2,40})\.api\.cognitive\.microsoft\.com\/?$/

// MATRON_TTS_AZURE_REGION when it has a region's shape. Otherwise, when the
// key in use is the transcription key and MATRON_STT_AZURE_ENDPOINT is a
// regional endpoint, that endpoint's region (a key only works in its own
// region). Otherwise northeurope. A custom-domain transcription endpoint
// names no region, so it is never guessed from.
export function resolveTtsRegion(env = process.env, { log = console } = {}) {
  const raw = env.MATRON_TTS_AZURE_REGION
  if (raw) {
    if (REGION_RE.test(raw)) return raw
    log.error(`tts: MATRON_TTS_AZURE_REGION=${JSON.stringify(raw)} is not a region name (e.g. northeurope) — ignored`)
  }
  const ownKey = !!(env.MATRON_TTS_AZURE_KEY || env.MATRON_TTS_AZURE_KEY_FILE)
  const m = ownKey ? null : STT_REGIONAL_ENDPOINT_RE.exec(env.MATRON_STT_AZURE_ENDPOINT || '')
  return m ? m[1] : DEFAULT_TTS_REGION
}

const CLIP_FILE_RE = /^[0-9a-f]{64}\.(mp3|wav)(\.[0-9a-f]{12}\.tmp)?$/

export function makeCloudTts({
  key,
  region = DEFAULT_TTS_REGION,
  // '' = the bare voice id (one of Azure's older neural voices).
  model = DEFAULT_TTS_MODEL,
  voices = TTS_VOICES,
  defaultVoice = DEFAULT_TTS_VOICE,
  // Characters of text per user per UTC day that may be sent to Azure.
  dailyChars = DEFAULT_TTS_DAILY_CHARS,
  cacheDir,
  cacheTtlMs = TTS_CACHE_TTL_MS,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 20000,
  // Requests to Azure at once, across all users; and how many more may wait
  // for a slot before a caller is told tts_busy.
  concurrency = 4,
  maxQueued = 16,
  now = Date.now,
  log = console,
} = {}) {
  if (!key) return null
  if (!cacheDir) throw new Error('makeCloudTts: cacheDir is required')
  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`
  const abort = new AbortController()
  let closed = false
  let running = 0
  const waiting = []
  // cache key -> promise of the audio bytes, from admission until settled:
  // the same line asked for twice at once is synthesised once.
  const inflight = new Map()
  // userId -> {day, chars}. In memory, like the journal's other limiters
  // (auth.js makeRateLimiter): a restart forgets the day's spend.
  const spent = new Map()

  const today = () => new Date(now()).toISOString().slice(0, 10)
  const usedToday = (userId) => {
    const s = spent.get(userId)
    return s && s.day === today() ? s.chars : 0
  }
  const charge = (userId, chars) => spent.set(userId, { day: today(), chars: usedToday(userId) + chars })

  function acquire() {
    if (running < concurrency) { running += 1; return Promise.resolve(true) }
    return new Promise((r) => waiting.push(r))
  }
  function release() {
    const next = waiting.shift()
    // The slot passes straight to the next waiter, so `running` is unchanged.
    if (next) next(true)
    else running -= 1
  }

  // The clip's bytes when the file exists and is younger than the TTL. Stat
  // and read are synchronous, as sweep() is, so a sweep can never remove a
  // file between the two or part-way through a read.
  function readFresh(file) {
    try {
      if (now() - fs.statSync(file).mtimeMs >= cacheTtlMs) return null
      const bytes = fs.readFileSync(file)
      return bytes.length ? bytes : null
    } catch {
      return null
    }
  }

  // tmp + rename, so a reader sees a whole clip or none. A full disk costs
  // the cache, not the request.
  function writeCache(file, bytes) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
      const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
      fs.writeFileSync(tmp, bytes, { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (err) {
      log.error(`tts: could not cache a clip (${err.code ?? err.message})`)
    }
  }

  async function callAzure(ssml, fmt) {
    const timeout = AbortSignal.timeout(requestTimeoutMs)
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': fmt.azure,
        'User-Agent': TTS_USER_AGENT,
      },
      body: ssml,
      signal: AbortSignal.any([abort.signal, timeout]),
    })
    if (!res.ok) {
      // Azure's error text; it never echoes the key.
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      throw new Error(`azure tts HTTP ${res.status}: ${detail}`)
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    if (!bytes.length) throw new Error('empty audio')
    return bytes
  }

  const clip = ({ key: cacheKey, fmt, format, voice, bytes, cached }) => ({
    key: cacheKey,
    format,
    voice,
    contentType: fmt.contentType,
    bytes,
    // Strong: the hash of exactly these bytes.
    etag: `"${crypto.createHash('sha256').update(bytes).digest('hex')}"`,
    cached,
  })

  return {
    kind: 'cloud',
    label: `Azure ${model || 'standard voices'} at ${new URL(url).host}`,
    voices: () => ({ voices: voices.map((v) => ({ ...v })), default: defaultVoice }),
    // What this user has sent to Azure today, for tests and diagnostics.
    usage: (userId) => ({ day: today(), used: usedToday(userId), limit: dailyChars }),

    // {userId, text, voice?, format?} -> {key, format, voice, contentType,
    // bytes, etag, cached}. Throws TtsError (bad_request, unknown_voice,
    // tts_budget_exceeded, tts_busy, tts_failed).
    async synthesize({ userId, text, voice = null, format = null } = {}) {
      if (userId == null) throw new TypeError('synthesize: userId is required')
      const clean = cleanTtsText(text)
      if (clean === null || clean.length < 1 || clean.length > TTS_TEXT_MAX) throw new TtsError('bad_request', 'text')
      const formatName = format ?? 'mp3'
      if (typeof formatName !== 'string' || !Object.hasOwn(TTS_FORMATS, formatName)) throw new TtsError('bad_request', 'format')
      const fmt = TTS_FORMATS[formatName]
      const v = voices.find((x) => x.id === (voice ?? defaultVoice))
      if (!v) throw new TtsError('unknown_voice')
      const cacheKey = ttsCacheKey({ voice: v.id, model, format: formatName, text: clean })
      const file = path.join(cacheDir, `${cacheKey}.${fmt.ext}`)
      const found = { key: cacheKey, fmt, format: formatName, voice: v.id }

      const hit = readFresh(file)
      if (hit) return clip({ ...found, bytes: hit, cached: true })
      const already = inflight.get(cacheKey)
      if (already) return clip({ ...found, bytes: await already, cached: true })

      // Admission. Nothing below this line awaits before the job holds its
      // slot or its place in the queue, so these checks cannot be raced.
      if (closed) throw new TtsError('tts_failed', 'shutting down')
      if (running >= concurrency && waiting.length >= maxQueued) throw new TtsError('tts_busy')
      if (usedToday(userId) + clean.length > dailyChars) throw new TtsError('tts_budget_exceeded')
      charge(userId, clean.length)

      const job = (async () => {
        if (!(await acquire())) throw new TtsError('tts_failed', 'shutting down')
        try {
          const started = now()
          const bytes = await callAzure(buildSsml({ text: clean, voiceName: azureVoiceName(v.id, model), locale: v.locale }), fmt)
          writeCache(file, bytes)
          log.log(`tts: user ${userId}: ${clean.length} chars, ${v.id}, ${formatName}, ${bytes.length} bytes in ${now() - started} ms`)
          return bytes
        } catch (err) {
          log.error(`tts: synthesis failed: ${err?.message ?? err}`)
          throw new TtsError('tts_failed')
        } finally {
          release()
        }
      })()
      inflight.set(cacheKey, job)
      const settled = () => inflight.delete(cacheKey)
      job.then(settled, settled)
      return clip({ ...found, bytes: await job, cached: false })
    },

    // Deletes clips (and abandoned temp files) older than the TTL, and
    // forgets yesterday's spend. Touches only names this module writes.
    sweep() {
      for (const [userId, s] of spent) if (s.day !== today()) spent.delete(userId)
      let names
      try { names = fs.readdirSync(cacheDir) } catch { return { removed: 0 } }
      let removed = 0
      for (const name of names) {
        if (!CLIP_FILE_RE.test(name)) continue
        const p = path.join(cacheDir, name)
        try {
          if (now() - fs.statSync(p).mtimeMs >= cacheTtlMs) { fs.unlinkSync(p); removed += 1 }
        } catch { /* gone already, or unreadable: the next sweep tries again */ }
      }
      return { removed }
    },

    // Abort the requests in flight, fail the ones waiting for a slot, and
    // resolve once they have all returned.
    close() {
      closed = true
      abort.abort()
      for (const w of waiting.splice(0)) w(false)
      return Promise.allSettled([...inflight.values()]).then(() => {})
    },
  }
}

function positiveInt(name, raw, defaultValue, log) {
  if (raw === undefined) return defaultValue
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    log.error(`tts: ${name}=${JSON.stringify(raw)} is invalid (must be a positive integer) — using default ${defaultValue}`)
    return defaultValue
  }
  return n
}

// The speech synthesiser this journal runs, or null: MATRON_TTS_DISABLED=1,
// no key, or a key file that is set but unreadable (said loudly at boot
// rather than failing every request).
export function makeConfiguredTts({ env = process.env, cacheDir, log = console, ...overrides } = {}) {
  if (env.MATRON_TTS_DISABLED === '1') {
    log.log('tts: MATRON_TTS_DISABLED=1 — cloud speech is OFF')
    return null
  }
  let key = ''
  try { key = resolveTtsKey(env) } catch (err) {
    const which = env.MATRON_TTS_AZURE_KEY_FILE ? 'MATRON_TTS_AZURE_KEY_FILE' : 'MATRON_STT_AZURE_KEY_FILE'
    log.error(`tts: ${which} is set but unreadable (${err.code ?? err.message}) — cloud speech is OFF`)
  }
  if (!key) return null
  let defaultVoice = env.MATRON_TTS_VOICE || DEFAULT_TTS_VOICE
  if (!TTS_VOICES.some((v) => v.id === defaultVoice)) {
    log.error(`tts: MATRON_TTS_VOICE=${JSON.stringify(defaultVoice)} is not one of ${TTS_VOICES.map((v) => v.id).join(', ')} — using ${DEFAULT_TTS_VOICE}`)
    defaultVoice = DEFAULT_TTS_VOICE
  }
  const t = makeCloudTts({
    key,
    region: resolveTtsRegion(env, { log }),
    model: env.MATRON_TTS_MODEL ?? DEFAULT_TTS_MODEL,
    defaultVoice,
    dailyChars: positiveInt('MATRON_TTS_DAILY_CHARS', env.MATRON_TTS_DAILY_CHARS, DEFAULT_TTS_DAILY_CHARS, log),
    cacheDir,
    log,
    ...overrides,
  })
  log.log(`tts: speech is synthesised by ${t.label} (default voice ${defaultVoice}, ${t.usage(0).limit} characters per user per day)`)
  return t
}
