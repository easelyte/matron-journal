// Cloud speech-to-text for voice notes: Azure Speech fast transcription,
// MAI-Transcribe-2 by default. Optional by construction: with no key the
// journal keeps whatever it had before (whisper if MATRON_WHISPER_MODEL is
// set, nothing otherwise) and every bridge transcribes locally as it does
// today.
//
// Chosen from a bake-off on 49 real voice notes, each
// system given the same short word list as the whisper prompt:
// MAI-Transcribe-2 2.79% word error, 0/51 numbers wrong, 0.6 s median per
// note; whisper small with the prompt 3.51%, ~8 s. Azure's fast
// transcription does not store the audio it is sent.
//
// Same transcriber shape as transcribe.js — transcribeFile(diskPath,
// {signal, userId}) -> text — so items-transcribe.js runs either. `kind:
// 'cloud'` is what turns on transcription of chat voice notes at upload
// (blob-transcripts.js): a remote call costs this host nothing, whisper
// would cost it minutes of CPU per note. With whisper configured as well, a
// note the cloud call fails on (an error, not an answer with no words in
// it) falls back to whisper here, one note at a time
// (makeChainedTranscriber), so a cloud outage does put whisper CPU on
// this host, serialised, for as long as the upload backlog lasts.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_WHISPER_PROMPT, makeTranscriber } from './transcribe.js'

const execFileAsync = promisify(execFile)

export const DEFAULT_AZURE_ENDPOINT = 'https://northeurope.api.cognitive.microsoft.com'
export const DEFAULT_AZURE_MODEL = 'MAI-Transcribe-2'
export const AZURE_API_VERSION = '2025-10-15'

// The whisper prompt's vocabulary, as a phrase list: "Matron voice note.
// Matron, Claude, …, deploy." -> ['Matron', 'Claude', …, 'deploy'].
export const DEFAULT_PHRASES = DEFAULT_WHISPER_PROMPT.replace(/^[^.]*\.\s*/, '').replace(/\.$/, '').split(',').map((s) => s.trim()).filter(Boolean)

// Phrases plus this user's device names (box names are where most of the
// name errors were), deduped, restricted to the hostname shape a device name
// has. A failing lookup keeps the base list.
export function phrasesFor(base, deviceNames, userId) {
  let names = []
  if (typeof deviceNames === 'function' && userId != null) {
    try { names = deviceNames(userId) } catch { names = [] }
  }
  const ok = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && /^[\w.-]{1,40}$/.test(n))
  return [...new Set([...base, ...ok])]
}

// The key comes from MATRON_STT_AZURE_KEY, or from the file named by
// MATRON_STT_AZURE_KEY_FILE (so it need not sit in the unit's environment).
// Never logged.
export function resolveAzureKey(env = process.env) {
  if (env.MATRON_STT_AZURE_KEY) return env.MATRON_STT_AZURE_KEY.trim()
  if (env.MATRON_STT_AZURE_KEY_FILE) return fs.readFileSync(env.MATRON_STT_AZURE_KEY_FILE, 'utf8').trim()
  return ''
}

// Azure takes WAV, MP3 or FLAC; voice notes arrive as m4a/ogg/webm, so
// ffmpeg turns them into 16 kHz mono FLAC (about half a WAV's size).
async function toFlac(exec, diskPath, outPath, { timeout, signal }) {
  await exec('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', diskPath, '-vn', '-ar', '16000', '-ac', '1', '-f', 'flac', '-y', outPath], { timeout, signal })
}

export function makeAzureTranscriber({
  key,
  endpoint = DEFAULT_AZURE_ENDPOINT,
  // '' = Azure's standard model (no enhanced mode).
  model = DEFAULT_AZURE_MODEL,
  // Locale hint. MAI takes a bare language ('en'); the standard model wants a
  // full locale ('en-GB').
  locale = model ? 'en' : 'en-GB',
  phrases = DEFAULT_PHRASES,
  deviceNames = null,
  // MAI's 'clean' drops fillers and false starts; it scored 2.79% against
  // verbatim's 3.43% on the bake-off set.
  style = 'clean',
  fetchImpl = globalThis.fetch,
  exec = execFileAsync,
  ffmpegTimeoutMs = 30000,
  requestTimeoutMs = 60000,
  // Parallel jobs this transcriber is worth: a remote call is I/O, not CPU.
  concurrency = 4,
} = {}) {
  if (!key) return null
  const url = `${String(endpoint).replace(/\/+$/, '')}/speechtotext/transcriptions:transcribe?api-version=${AZURE_API_VERSION}`
  // diskPath -> Azure's parsed reply. Throws on an ffmpeg failure (a video
  // with no audio stream among them), marked `decodeFailed` so the chain
  // does not hand the same undecodable file to whisper, or on an HTTP error.
  async function callAzure(diskPath, { signal, userId = null } = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'))
    const flacPath = path.join(tmpDir, 'audio.flac')
    try {
      try {
        await toFlac(exec, diskPath, flacPath, { timeout: ffmpegTimeoutMs, signal })
      } catch (err) {
        if (err && typeof err === 'object' && !signal?.aborted) err.decodeFailed = true
        throw err
      }
      const definition = {
        locales: [locale],
        phraseList: { phrases: phrasesFor(phrases, deviceNames, userId) },
        ...(model ? { enhancedMode: { enabled: true, model, modelOptions: { transcribeStyle: style } } } : {}),
      }
      const form = new FormData()
      // Streamed from disk as the request is sent, not read whole into
      // memory: a long video's FLAC can run past 100 MB.
      form.append('audio', await fs.openAsBlob(flacPath, { type: 'audio/flac' }), 'audio.flac')
      form.append('definition', JSON.stringify(definition))
      const timeout = AbortSignal.timeout(requestTimeoutMs)
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': key },
        body: form,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (!res.ok) {
        // The body is Azure's {code, message}; it never echoes the key.
        const detail = (await res.text().catch(() => '')).slice(0, 200)
        throw new Error(`azure transcription HTTP ${res.status}: ${detail}`)
      }
      return await res.json()
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
  const combinedText = (body) => (body?.combinedPhrases ?? []).map((p) => p.text ?? '').join(' ').replace(/\s+/g, ' ').trim()
  return {
    kind: 'cloud',
    label: `Azure ${model || 'standard'} at ${new URL(url).host}`,
    concurrency,
    // diskPath -> transcript string. Throws on any failure, including audio
    // with no words in it (err.emptyResult); the caller records that as
    // 'failed'.
    async transcribeFile(diskPath, opts = {}) {
      const text = combinedText(await callAzure(diskPath, opts))
      if (!text) throw emptyResult()
      return text
    },
    // diskPath -> {text, segments: [{start_ms, text}]}, one segment per
    // phrase Azure recognised, from where it starts. For a video upload's
    // audio track; the same failures throw, an empty one included.
    async transcribeFileSegments(diskPath, opts = {}) {
      const body = await callAzure(diskPath, opts)
      const text = combinedText(body)
      if (!text) throw emptyResult()
      const segments = (body.phrases ?? [])
        .map((p) => ({ start_ms: Math.max(0, Math.round(Number(p.offsetMilliseconds) || 0)), text: String(p.text ?? '').replace(/\s+/g, ' ').trim() }))
        .filter((seg) => seg.text)
        .sort((a, b) => a.start_ms - b.start_ms)
      return { text, segments }
    },
  }
}

// Azure answered and heard no words: marked, so the chain does not hand
// the audio to whisper, which on near-silence invents a phrase.
function emptyResult() {
  return Object.assign(new Error('empty transcription result'), { emptyResult: true })
}

// An unreachable endpoint rejects fetch with a bare "fetch failed"; why
// (ECONNREFUSED, ENOTFOUND, a certificate error) is on err.cause. The cause
// names a host or an address at most, never the key, which is a header.
function failureReason(err) {
  const cause = err?.cause
  return cause ? `${err.message}: ${cause.code ?? cause.message}` : err?.message
}

// Runs the functions it is handed one at a time, in arrival order: each
// starts when the one before it settles, whether that resolved or threw.
function serialize() {
  let tail = Promise.resolve()
  return (fn) => {
    const run = tail.then(fn)
    tail = run.catch(() => {})
    return run
  }
}

// The primary transcriber, falling back to `fallback` when it throws. The
// chain is the primary as far as callers can tell (kind, label, concurrency),
// so a cloud primary still turns on transcription at upload and still runs
// `concurrency` jobs at once — while the fallback, whisper on this host's
// CPU, runs one note at a time however many cloud calls fail together. A
// request whose signal has aborted (the client went away, the journal is
// shutting down) never starts the fallback, not even after waiting its turn.
// Nor does a file the primary could not decode (err.decodeFailed: ffmpeg
// refused it, e.g. a video with no audio stream): whisper decodes it with
// the same ffmpeg, so queueing it behind other whisper runs would only fail
// it later. Nor does an answer with no words in it (err.emptyResult): the
// cloud heard nothing, and whisper on near-silent audio tends to invent a
// short phrase, at a run's worth of this host's CPU. Every other failure
// (an HTTP error, the network, a timeout) falls back.
export function makeChainedTranscriber(primary, fallback, { log = console } = {}) {
  const fallbackName = fallback.label ?? 'whisper.cpp'
  const fallbackQueue = serialize()
  const chained = (method) => async (diskPath, opts = {}) => {
    try {
      return await primary[method](diskPath, opts)
    } catch (err) {
      if (opts.signal?.aborted) throw err
      if (err?.decodeFailed) {
        log.error(`transcribe: ${primary.label} could not decode the audio (${failureReason(err)}) — not trying ${fallbackName}, which decodes it the same way`)
        throw err
      }
      if (err?.emptyResult) {
        log.error(`transcribe: ${primary.label} heard no words — not trying ${fallbackName}, which would only invent some`)
        throw err
      }
      log.error(`transcribe: ${primary.label} failed (${failureReason(err)}) — trying ${fallbackName}`)
      return fallbackQueue(() => {
        if (opts.signal?.aborted) throw err
        return fallback[method](diskPath, opts)
      })
    }
  }
  return {
    kind: primary.kind,
    label: `${primary.label}, then ${fallbackName}`,
    concurrency: primary.concurrency,
    transcribeFile: chained('transcribeFile'),
    // Timed segments only when both sides can give them; the shared queue
    // keeps it to one whisper run at a time across both methods.
    ...(primary.transcribeFileSegments && fallback.transcribeFileSegments
      ? { transcribeFileSegments: chained('transcribeFileSegments') }
      : {}),
  }
}

// The transcriber this journal runs: the cloud one when a key is configured
// (falling back to whisper when MATRON_WHISPER_MODEL is set too), else
// whisper when MATRON_WHISPER_MODEL is, else none. A key that is set but
// unreadable is said loudly at boot and falls back, rather than failing every
// note quietly.
export function makeConfiguredTranscriber({ env = process.env, deviceNames = null, log = console, whisper = makeTranscriber } = {}) {
  let key = ''
  try { key = resolveAzureKey(env) } catch (err) {
    log.error(`transcribe: MATRON_STT_AZURE_KEY_FILE is set but unreadable (${err.code ?? err.message}) — cloud transcription is OFF`)
  }
  if (key) {
    const model = env.MATRON_STT_AZURE_MODEL ?? DEFAULT_AZURE_MODEL
    const azure = makeAzureTranscriber({
      key,
      endpoint: env.MATRON_STT_AZURE_ENDPOINT || DEFAULT_AZURE_ENDPOINT,
      model,
      ...(env.MATRON_STT_LOCALE ? { locale: env.MATRON_STT_LOCALE } : {}),
      deviceNames,
    })
    // Whisper here is only the fallback: a missing model must not be
    // reported as notes going untranscribed.
    const w = whisper({ deviceNames, log, missingMeans: 'no whisper fallback for cloud transcription' })
    const t = w ? makeChainedTranscriber(azure, w, { log }) : azure
    log.log(`transcribe: voice notes are transcribed on upload by ${t.label}${w ? '' : ' (no whisper fallback)'}`)
    return t
  }
  const w = whisper({ deviceNames, log })
  if (w) log.log("transcribe: item voice notes are transcribed here by whisper.cpp (chat notes stay the bridge's job)")
  return w
}
