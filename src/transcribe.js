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
    async transcribeFile(diskPath, { signal } = {}) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'))
      const wavPath = path.join(tmpDir, 'audio.wav')
      try {
        // ffmpeg sniffs the container itself, so the blob's extensionless
        // path is fine as input.
        await execFileAsync('ffmpeg', ['-nostdin', '-i', diskPath, '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wavPath], { timeout: ffmpegTimeoutMs, signal })
        const { stdout } = await execFileAsync(cli, ['-m', modelPath, '-f', wavPath, '--no-timestamps', '-l', language], { timeout: whisperTimeoutMs, signal })
        const text = cleanWhisperText(stdout)
        if (!text) throw new Error('empty transcription result')
        return text
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
      }
    },
  }
}
