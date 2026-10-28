#!/usr/bin/env node
// Listening test for the cloud voices (spec 2026-10-03 voice mode, phase 0:
// "the first build step is a listening test of Emily and Harry on real
// spoken lines"). Sends three lines of the kind the bridge's summary pass
// writes to Azure with each voice on the allow-list, through the same
// makeCloudTts the journal runs, and writes one mp3 per voice and line.
// Prints, per clip, the time to the first byte of audio and the total time.
//
// This is the only thing in the repo that calls Azure for speech, and it is
// run by hand. It costs about 800 characters (under 2 US cents).
//
// Usage:
//   MATRON_TTS_AZURE_KEY=... node tools/tts-listen.js [--out DIR]
//
// Config (env), the same variables the journal reads:
//   MATRON_TTS_AZURE_KEY / MATRON_TTS_AZURE_KEY_FILE, else
//   MATRON_STT_AZURE_KEY / MATRON_STT_AZURE_KEY_FILE   the Azure Speech key
//   MATRON_TTS_AZURE_REGION                            default northeurope
//   MATRON_TTS_MODEL                                   default MAI-Voice-2.1-Flash
// --out DIR: where the clips go (default <tmpdir>/matron-tts-samples).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { makeCloudTts, resolveTtsKey, resolveTtsRegion, TTS_VOICES, DEFAULT_TTS_MODEL } from '../src/cloud-tts.js'

const LINES = [
  'The deploy finished and all the checks passed. I need one decision from you: should I merge the pull request now, or wait for Sam to review it first?',
  'I found the bug. The reaper was counting voice notes twice, so the quota looked full when it was not. The fix is ready, and there is a table of the numbers in the chat.',
  'Three things need you. First, Ash wants to run a command: git push origin main. Allow or deny?',
]

const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
const outDir = path.resolve(outAt >= 0 && args[outAt + 1] ? args[outAt + 1] : path.join(os.tmpdir(), 'matron-tts-samples'))

let key = ''
try { key = resolveTtsKey(process.env) } catch (err) {
  console.error(`tts-listen: the key file is unreadable (${err.code ?? err.message})`)
  process.exit(2)
}
if (!key) {
  console.error('tts-listen: set MATRON_TTS_AZURE_KEY (or MATRON_TTS_AZURE_KEY_FILE, or the MATRON_STT_AZURE_ ones) to the Azure Speech key')
  process.exit(2)
}

// fetch, timed: reads the body itself so it can stamp the first audio byte,
// then hands makeCloudTts the bytes in the shape it reads.
let timing = null
async function timedFetch(url, init) {
  const t0 = performance.now()
  const res = await fetch(url, init)
  if (!res.ok || !res.body) return res
  const reader = res.body.getReader()
  const chunks = []
  let firstByteMs = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (firstByteMs === null && value.length) firstByteMs = performance.now() - t0
    chunks.push(value)
  }
  const bytes = Buffer.concat(chunks)
  timing = { firstByteMs, totalMs: performance.now() - t0 }
  return {
    ok: true,
    status: res.status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => '',
  }
}

// A cache directory of its own, emptied afterwards, so every clip is a real
// request and nothing is left behind but the samples.
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-tts-listen-'))
const tts = makeCloudTts({
  key,
  region: resolveTtsRegion(process.env),
  model: process.env.MATRON_TTS_MODEL ?? DEFAULT_TTS_MODEL,
  cacheDir,
  fetchImpl: timedFetch,
  // Failures are printed (Azure's status and message); successes are in the table.
  log: { log() {}, error: (m) => console.error(m) },
})

fs.mkdirSync(outDir, { recursive: true })
console.log(tts.label)
console.log(`clips: ${outDir}\n`)
console.log('voice         line  chars   bytes  first byte   total')

const ms = (n) => `${Math.round(n)} ms`.padStart(8)
const totals = []
let failed = 0
try {
  for (const voice of TTS_VOICES) {
    for (const [i, text] of LINES.entries()) {
      timing = null
      try {
        const clip = await tts.synthesize({ userId: 0, text, voice: voice.id, format: 'mp3' })
        const file = path.join(outDir, `${voice.name.toLowerCase()}-${i + 1}.mp3`)
        fs.writeFileSync(file, clip.bytes)
        totals.push(timing.totalMs)
        console.log(`${voice.id.padEnd(13)} ${String(i + 1).padStart(4)} ${String(text.length).padStart(6)} ${String(clip.bytes.length).padStart(7)}  ${ms(timing.firstByteMs)} ${ms(timing.totalMs)}`)
      } catch (err) {
        failed += 1
        console.log(`${voice.id.padEnd(13)} ${String(i + 1).padStart(4)} ${String(text.length).padStart(6)}  FAILED (${err.code ?? err.message})`)
      }
    }
  }
} finally {
  await tts.close()
  fs.rmSync(cacheDir, { recursive: true, force: true })
}

if (totals.length) {
  const sorted = [...totals].sort((a, b) => a - b)
  console.log(`\n${totals.length} clip(s); median total ${Math.round(sorted[Math.floor(sorted.length / 2)])} ms, slowest ${Math.round(sorted[sorted.length - 1])} ms`)
  if (process.platform === 'darwin') console.log(`listen: for f in ${outDir}/*.mp3; do echo "$f"; afplay "$f"; done`)
}
process.exit(failed ? 1 : 0)
