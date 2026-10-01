// Voice-note transcription on the journal host (whisper.cpp + ffmpeg), so an
// item's voice note gets its words the moment it is uploaded rather than when
// the origin box next wakes up and runs its own whisper. Optional by
// construction: with no MATRON_WHISPER_MODEL the journal transcribes nothing
// and every caller behaves exactly as before (the origin bridge does the job).
//
// Works from the blob's path on disk — the audio is already a file in the
// media store, so nothing is buffered through the event loop.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

// Vocabulary prompt. whisper-cli decodes --prompt as if it were the text just
// before the audio, so its words become the likely spellings of what follows:
// box names, "sudo", "PR", template names. Measured on 50 of Dan's real voice
// notes (2026-09-30): small went from 4.5% to 3.9% word error and from 10 to
// 6 names wrong. Kept short and generic on purpose: a long list of rare terms
// made whisper hallucinate one of them onto a 3-second note. Same words as
// the bridge's lib/transcribe.js, so a note reads the same wherever it was
// transcribed.
export const DEFAULT_WHISPER_PROMPT = 'Matron voice note. Matron, Claude, Codex, sudo, GitHub, PR, merge train, deploy.'

// MATRON_WHISPER_PROMPT unset -> the built-in vocabulary; set but empty -> no
// prompt (an opt-out for a language or a fleet the default fits badly);
// otherwise the operator's own words.
// "<prompt> dan-mac, greg, pat." — names deduped, sorted, restricted to the
// hostname-ish shape a device name has, so a stray name can never smuggle
// whisper options or prose into the prompt. A failing lookup keeps the base.
export function withDeviceNames(prompt, deviceNames, userId) {
  if (typeof deviceNames !== 'function' || userId == null) return prompt
  let names = []
  try { names = deviceNames(userId) } catch { return prompt }
  const ok = [...new Set((Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && /^[\w.-]{1,40}$/.test(n)))].sort()
  return ok.length ? `${prompt} ${ok.join(', ')}.` : prompt
}

// The prompt's one failure mode, seen on one 124-second note out of 50: a
// particular wording made whisper small drop everything but the last sentence
// (16 words for two minutes of speech), deterministically, while a reordering
// of the same words was fine. No rule predicts it, so the guard is on the
// output: speech runs at two to three words a second, and a transcript under
// 0.4 words a second for anything longer than eight seconds is rerun without
// the prompt, keeping whichever run says more. The WAV is ffmpeg's own 16 kHz
// mono 16-bit output, so its byte length is its duration. Same guard as the
// bridge's lib/transcribe.js.
export const PROMPT_GUARD_MIN_SECONDS = 8
export const PROMPT_GUARD_WORDS_PER_SECOND = 0.4

export function wavSeconds(wavPath) {
  try { return Math.max(0, (fs.statSync(wavPath).size - 44) / 32000) } catch { return 0 }
}

export function promptLooksTruncated(text, seconds) {
  if (seconds < PROMPT_GUARD_MIN_SECONDS) return false
  const words = String(text).split(/\s+/).filter(Boolean).length
  return words < seconds * PROMPT_GUARD_WORDS_PER_SECOND
}

export function resolveWhisperPrompt(envValue = process.env.MATRON_WHISPER_PROMPT) {
  if (envValue === undefined) return DEFAULT_WHISPER_PROMPT
  return String(envValue).trim()
}

// whisper.cpp's own installer lays the tree out as models/<model>.bin next to
// build/bin/whisper-cli, so the binary is derivable from the configured model
// (same rule as the bridge's lib/transcribe.js).
export function whisperCliPath(modelPath) {
  return path.join(path.dirname(modelPath), '../build/bin/whisper-cli')
}

// whisper-cli prints non-speech markers ([BLANK_AUDIO], [MUSIC]) inline.
export const cleanWhisperText = (stdout) => String(stdout).replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim()

// Returns null when transcription is not configured on this host, or is
// configured but the binary/model is missing (said once, loudly, at boot —
// a journal that silently never transcribes looks identical to a slow one).
export function makeTranscriber({
  modelPath = process.env.MATRON_WHISPER_MODEL,
  cliPath = process.env.MATRON_WHISPER_CLI,
  language = process.env.MATRON_WHISPER_LANGUAGE || 'en',
  prompt = resolveWhisperPrompt(),
  // (userId) -> this user's device names, appended to the prompt: box names
  // are where most of the gain is (on the same 50 notes the generic words
  // alone took names wrong from 10 to 9, the box names took them to 5).
  // server.js wires the devices table; null leaves the prompt as is.
  deviceNames = null,
  // (cmd, args, opts) -> {stdout}; tests inject a recorder.
  exec = execFileAsync,
  ffmpegTimeoutMs = 30000,
  whisperTimeoutMs = 120000,
  log = console,
} = {}) {
  if (!modelPath) return null
  const cli = cliPath || whisperCliPath(modelPath)
  for (const [what, p] of [['whisper model', modelPath], ['whisper-cli', cli]]) {
    if (!fs.existsSync(p)) {
      log.error(`transcribe: MATRON_WHISPER_MODEL is set but the ${what} is missing at ${p} — voice notes will NOT be transcribed here`)
      return null
    }
  }
  return {
    // diskPath -> transcript string. Throws on any failure, including speech
    // whisper found no words in — the caller records that as 'failed'.
    // `signal` aborts the running child (journal shutdown).
    async transcribeFile(diskPath, { signal, userId = null } = {}) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'))
      const wavPath = path.join(tmpDir, 'audio.wav')
      try {
        // ffmpeg sniffs the container itself, so the blob's extensionless
        // path is fine as input.
        await exec('ffmpeg', ['-nostdin', '-i', diskPath, '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wavPath], { timeout: ffmpegTimeoutMs, signal })
        const promptArgs = prompt ? ['--prompt', withDeviceNames(prompt, deviceNames, userId)] : []
        const run = async (extra) => cleanWhisperText((await exec(cli, ['-m', modelPath, '-f', wavPath, '--no-timestamps', '-l', language, ...extra], { timeout: whisperTimeoutMs, signal })).stdout)
        let text = await run(promptArgs)
        if (promptArgs.length && promptLooksTruncated(text, wavSeconds(wavPath))) {
          // A rerun that fails (timeout, crash) costs nothing: the prompted
          // transcript stands. Cancellation still propagates.
          try {
            const bare = await run([])
            const words = (t) => t.split(/\s+/).filter(Boolean).length
            if (words(bare) > words(text)) text = bare
          } catch (err) {
            if (signal?.aborted || err?.name === 'AbortError') throw err
          }
        }
        if (!text) throw new Error('empty transcription result')
        return text
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
      }
    },
  }
}
