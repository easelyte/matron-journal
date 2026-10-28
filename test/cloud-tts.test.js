import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanTtsText, escapeXml, azureVoiceName, buildSsml, ttsCacheKey, resolveTtsCacheDir, resolveTtsKey, resolveTtsRegion,
  TtsError, TTS_ERROR_STATUS, TTS_VOICES, TTS_FORMATS, TTS_TEXT_MAX, TTS_CACHE_TTL_MS, TTS_USER_AGENT,
  DEFAULT_TTS_REGION, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, DEFAULT_TTS_DAILY_CHARS,
  makeCloudTts, makeConfiguredTts,
} from '../src/cloud-tts.js'

const tmpDir = (t, prefix = 'matron-tts-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---- The pure pieces: text, SSML, cache key, configuration ----

test('constants: the contract values', () => {
  assert.equal(DEFAULT_TTS_REGION, 'northeurope')
  assert.equal(DEFAULT_TTS_MODEL, 'MAI-Voice-2.1-Flash')
  assert.equal(DEFAULT_TTS_VOICE, 'en-GB-Harry')
  assert.equal(DEFAULT_TTS_DAILY_CHARS, 300000)
  assert.equal(TTS_TEXT_MAX, 2000)
  assert.equal(TTS_CACHE_TTL_MS, 86400000)
  assert.deepEqual(TTS_VOICES, [
    { id: 'en-GB-Harry', name: 'Harry', locale: 'en-GB', gender: 'male' },
    { id: 'en-GB-Emily', name: 'Emily', locale: 'en-GB', gender: 'female' },
  ])
  assert.deepEqual(TTS_FORMATS.mp3, { azure: 'audio-24khz-48kbitrate-mono-mp3', contentType: 'audio/mpeg', ext: 'mp3' })
  assert.deepEqual(TTS_FORMATS.wav, { azure: 'riff-16khz-16bit-mono-pcm', contentType: 'audio/wav', ext: 'wav' })
  assert.deepEqual(TTS_ERROR_STATUS, { bad_request: 400, unknown_voice: 400, tts_budget_exceeded: 429, tts_busy: 503, tts_failed: 502 })
  const e = new TtsError('tts_busy')
  assert.ok(e instanceof Error)
  assert.equal(e.code, 'tts_busy')
  assert.equal(e.status, 503)
})

test('cleanTtsText: trims, strips control characters and lone surrogates, keeps tab and newline, null for a non-string', () => {
  assert.equal(cleanTtsText('  Hello there.  '), 'Hello there.')
  assert.equal(cleanTtsText('a\u0000b\u0007c\u001bd\u007fe\u0085f\ufffeg'), 'abcdefg')
  assert.equal(cleanTtsText('line one\n\tline two\r\n'), 'line one\n\tline two')
  assert.equal(cleanTtsText('ok 😀 done'), 'ok 😀 done', 'a whole emoji survives')
  assert.equal(cleanTtsText('half \ud83d pair'), 'half  pair', 'a lone surrogate is dropped')
  assert.equal(cleanTtsText(' \u0000\u0001 '), '')
  for (const bad of [undefined, null, 42, true, {}, ['x']]) assert.equal(cleanTtsText(bad), null, JSON.stringify(bad))
})

test('escapeXml and buildSsml: the five characters are escaped, so text can never become markup', () => {
  assert.equal(escapeXml(`a & b < c > d " e ' f`), 'a &amp; b &lt; c &gt; d &quot; e &apos; f')
  assert.equal(escapeXml('&amp;'), '&amp;amp;', 'an entity in the text is text')
  assert.equal(azureVoiceName('en-GB-Harry', 'MAI-Voice-2.1-Flash'), 'en-GB-Harry:MAI-Voice-2.1-Flash')
  assert.equal(azureVoiceName('en-GB-RyanNeural', ''), 'en-GB-RyanNeural')
  assert.equal(
    buildSsml({ text: 'Tom & Jerry', voiceName: 'en-GB-Harry:MAI-Voice-2.1-Flash', locale: 'en-GB' }),
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-GB"><voice name="en-GB-Harry:MAI-Voice-2.1-Flash">Tom &amp; Jerry</voice></speak>'
  )
  const attack = '</voice><voice name="en-US-Evil"><break time="60s"/>hi'
  const ssml = buildSsml({ text: attack, voiceName: 'v', locale: 'en-GB' })
  assert.equal(ssml.match(/<voice /g).length, 1)
  assert.equal(ssml.match(/<\/voice>/g).length, 1)
  assert.ok(!ssml.includes('<break'))
  assert.ok(ssml.includes('&lt;/voice&gt;&lt;voice name=&quot;en-US-Evil&quot;&gt;&lt;break time=&quot;60s&quot;/&gt;hi'))
})

test('ttsCacheKey: sha256 of voice|model|format|text; any part changing changes the key', () => {
  const base = { voice: 'en-GB-Harry', model: 'MAI-Voice-2.1-Flash', format: 'mp3', text: 'Hello' }
  const k = ttsCacheKey(base)
  assert.equal(k, crypto.createHash('sha256').update('en-GB-Harry|MAI-Voice-2.1-Flash|mp3|Hello').digest('hex'))
  assert.match(k, /^[0-9a-f]{64}$/)
  assert.equal(ttsCacheKey({ ...base }), k)
  for (const change of [{ voice: 'en-GB-Emily' }, { model: 'other' }, { format: 'wav' }, { text: 'Hello.' }]) {
    assert.notEqual(ttsCacheKey({ ...base, ...change }), k, JSON.stringify(change))
  }
})

test('resolveTtsCacheDir: an override, else tts-cache beside the database', () => {
  assert.equal(resolveTtsCacheDir('/opt/matron-journal/data/matron.db'), '/opt/matron-journal/data/tts-cache')
  assert.equal(resolveTtsCacheDir('/opt/matron-journal/data/matron.db', '/var/cache/tts'), '/var/cache/tts')
})

test('resolveTtsKey: its own key, else its own key file, else the transcription key', (t) => {
  const dir = tmpDir(t, 'tts-key-')
  const own = path.join(dir, 'tts'); fs.writeFileSync(own, 'tts-from-file\n')
  const stt = path.join(dir, 'stt'); fs.writeFileSync(stt, 'stt-from-file\n')
  assert.equal(resolveTtsKey({ MATRON_TTS_AZURE_KEY: ' tts-env ', MATRON_STT_AZURE_KEY: 'stt-env' }), 'tts-env')
  assert.equal(resolveTtsKey({ MATRON_TTS_AZURE_KEY_FILE: own, MATRON_STT_AZURE_KEY: 'stt-env' }), 'tts-from-file')
  assert.equal(resolveTtsKey({ MATRON_STT_AZURE_KEY: ' stt-env ' }), 'stt-env')
  assert.equal(resolveTtsKey({ MATRON_STT_AZURE_KEY_FILE: stt }), 'stt-from-file')
  assert.equal(resolveTtsKey({}), '')
  assert.throws(() => resolveTtsKey({ MATRON_TTS_AZURE_KEY_FILE: path.join(dir, 'missing'), MATRON_STT_AZURE_KEY: 'stt-env' }), /ENOENT/, 'a set but unreadable file is not papered over by the fallback')
})

test('resolveTtsRegion: its own variable; else the transcription endpoint\'s region when the key is shared; else northeurope', () => {
  const logs = []
  const log = { log: (m) => logs.push(m), error: (m) => logs.push(m) }
  assert.equal(resolveTtsRegion({}, { log }), 'northeurope')
  assert.equal(resolveTtsRegion({ MATRON_TTS_AZURE_REGION: 'uksouth' }, { log }), 'uksouth')
  assert.equal(resolveTtsRegion({ MATRON_STT_AZURE_ENDPOINT: 'https://swedencentral.api.cognitive.microsoft.com' }, { log }), 'swedencentral')
  assert.equal(resolveTtsRegion({ MATRON_STT_AZURE_ENDPOINT: 'https://eastus2.api.cognitive.microsoft.com/' }, { log }), 'eastus2')
  assert.equal(resolveTtsRegion({ MATRON_TTS_AZURE_REGION: 'uksouth', MATRON_STT_AZURE_ENDPOINT: 'https://eastus2.api.cognitive.microsoft.com' }, { log }), 'uksouth')
  assert.equal(resolveTtsRegion({ MATRON_STT_AZURE_ENDPOINT: 'https://my-speech.cognitiveservices.azure.com' }, { log }), 'northeurope', 'a custom domain names no region')
  assert.equal(resolveTtsRegion({ MATRON_TTS_AZURE_KEY: 'own', MATRON_STT_AZURE_ENDPOINT: 'https://eastus2.api.cognitive.microsoft.com' }, { log }), 'northeurope', 'its own key is not tied to the transcription endpoint')
  assert.equal(logs.length, 0)
  assert.equal(resolveTtsRegion({ MATRON_TTS_AZURE_REGION: 'evil.example.com/x?' }, { log }), 'northeurope')
  assert.match(logs[0], /MATRON_TTS_AZURE_REGION.*not a region name/)
})

// ---- makeCloudTts: the request, the cache, the limits ----

const quiet = { log() {}, error() {} }

// fetch stand-in: records each request and answers with `reply`
// ({status?, bytes?, text?}), an Error to throw, or a function of the call.
function fakeFetch(reply = {}, seen = []) {
  return async (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers, body: init.body, signal: init.signal })
    const r = typeof reply === 'function' ? await reply(seen.length, init) : reply
    if (r instanceof Error) throw r
    const status = r.status ?? 200
    return {
      ok: status < 400,
      status,
      arrayBuffer: async () => { const b = Buffer.from(r.bytes ?? 'AUDIO'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) },
      text: async () => r.text ?? '',
    }
  }
}

// A fetch whose requests the test releases by hand; an aborted signal
// rejects the request, as real fetch does.
function gatedFetch(seen = []) {
  const gates = []
  const impl = (url, init) => new Promise((resolve, reject) => {
    seen.push({ url, body: init.body, signal: init.signal })
    const ok = (bytes = 'AUDIO') => resolve({ ok: true, status: 200, arrayBuffer: async () => { const b = Buffer.from(bytes); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }, text: async () => '' })
    gates.push({ ok, fail: (err = new Error('boom')) => reject(err) })
    init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true })
  })
  return { impl, gates, seen }
}

const tick = () => new Promise((r) => setTimeout(r, 5))
const rejectsWith = (p, code) => assert.rejects(p, (err) => err instanceof TtsError && err.code === code)

test('no key: no synthesiser; a key needs a cache directory', () => {
  assert.equal(makeCloudTts({ key: '' }), null)
  assert.equal(makeCloudTts({}), null)
  assert.throws(() => makeCloudTts({ key: 'k' }), /cacheDir is required/)
})

test('the Azure request: endpoint, headers, SSML with the escaped text and <id>:<model>; the clip comes back with a strong ETag', async (t) => {
  const seen = []
  const tts = makeCloudTts({ key: 'k-123', cacheDir: tmpDir(t), fetchImpl: fakeFetch({ bytes: 'MP3DATA' }, seen), log: quiet })
  assert.equal(tts.kind, 'cloud')
  assert.equal(tts.label, 'Azure MAI-Voice-2.1-Flash at northeurope.tts.speech.microsoft.com')
  assert.deepEqual(tts.voices(), { voices: [...TTS_VOICES], default: 'en-GB-Harry' })
  const clip = await tts.synthesize({ userId: 1, text: '  Tom & Jerry <b>say</b> "hi"\u0007  ' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://northeurope.tts.speech.microsoft.com/cognitiveservices/v1')
  assert.equal(seen[0].method, 'POST')
  assert.deepEqual(seen[0].headers, {
    'Ocp-Apim-Subscription-Key': 'k-123',
    'Content-Type': 'application/ssml+xml',
    'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
    'User-Agent': TTS_USER_AGENT,
  })
  assert.equal(seen[0].body,
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-GB"><voice name="en-GB-Harry:MAI-Voice-2.1-Flash">Tom &amp; Jerry &lt;b&gt;say&lt;/b&gt; &quot;hi&quot;</voice></speak>')
  assert.deepEqual(clip.bytes, Buffer.from('MP3DATA'))
  assert.equal(clip.contentType, 'audio/mpeg')
  assert.equal(clip.format, 'mp3')
  assert.equal(clip.voice, 'en-GB-Harry')
  assert.equal(clip.cached, false)
  assert.equal(clip.key, ttsCacheKey({ voice: 'en-GB-Harry', model: 'MAI-Voice-2.1-Flash', format: 'mp3', text: 'Tom & Jerry <b>say</b> "hi"' }))
  assert.equal(clip.etag, `"${crypto.createHash('sha256').update('MP3DATA').digest('hex')}"`)
})

test('voice and format: Emily and wav reach Azure; region, model and default voice are configurable', async (t) => {
  const seen = []
  const tts = makeCloudTts({ key: 'k', cacheDir: tmpDir(t), fetchImpl: fakeFetch({ bytes: 'RIFF' }, seen), log: quiet })
  const wav = await tts.synthesize({ userId: 1, text: 'Hello', voice: 'en-GB-Emily', format: 'wav' })
  assert.equal(seen[0].headers['X-Microsoft-OutputFormat'], 'riff-16khz-16bit-mono-pcm')
  assert.match(seen[0].body, /<voice name="en-GB-Emily:MAI-Voice-2.1-Flash">Hello<\/voice>/)
  assert.equal(wav.contentType, 'audio/wav')
  assert.equal(wav.format, 'wav')
  assert.equal(wav.voice, 'en-GB-Emily')

  const seen2 = []
  const other = makeCloudTts({ key: 'k', region: 'uksouth', model: '', defaultVoice: 'en-GB-Emily', cacheDir: tmpDir(t), fetchImpl: fakeFetch({}, seen2), log: quiet })
  assert.equal(other.label, 'Azure standard voices at uksouth.tts.speech.microsoft.com')
  assert.equal(other.voices().default, 'en-GB-Emily')
  await other.synthesize({ userId: 1, text: 'Hello', voice: null, format: null })
  assert.equal(seen2[0].url, 'https://uksouth.tts.speech.microsoft.com/cognitiveservices/v1')
  assert.match(seen2[0].body, /<voice name="en-GB-Emily">Hello<\/voice>/)
  assert.equal(seen2[0].headers['X-Microsoft-OutputFormat'], 'audio-24khz-48kbitrate-mono-mp3')
})

test('validation: text 1 to 2,000 characters after cleaning, a known format, a voice on the list; nothing reaches Azure', async (t) => {
  const seen = []
  const tts = makeCloudTts({ key: 'k', cacheDir: tmpDir(t), fetchImpl: fakeFetch({}, seen), log: quiet })
  for (const text of [undefined, null, 42, {}, '', '   ', '\u0000\u0001', 'x'.repeat(2001)]) {
    await rejectsWith(tts.synthesize({ userId: 1, text }), 'bad_request')
  }
  for (const format of ['ogg', 'MP3', '', 7, {}, 'toString']) {
    await rejectsWith(tts.synthesize({ userId: 1, text: 'hi', format }), 'bad_request')
  }
  for (const voice of ['en-US-Jenny', 'en-GB-Harry:MAI-Voice-2.1-Flash', '', 7, {}]) {
    await rejectsWith(tts.synthesize({ userId: 1, text: 'hi', voice }), 'unknown_voice')
  }
  await assert.rejects(tts.synthesize({ text: 'hi' }), TypeError, 'a server-side caller must say whose budget it is')
  assert.equal(seen.length, 0)
  assert.equal(tts.usage(1).used, 0)
  await tts.synthesize({ userId: 1, text: `  ${'x'.repeat(2000)}  ` })
  assert.equal(seen.length, 1, 'the limit applies after trimming')
})

test('cache: the same line is synthesised once; a hit costs no budget; voice and format are separate clips; a restart keeps the cache', async (t) => {
  const dir = tmpDir(t)
  const seen = []
  let n = 0
  const fetchImpl = fakeFetch(() => ({ bytes: `AUDIO-${++n}` }), seen)
  const tts = makeCloudTts({ key: 'k', cacheDir: dir, fetchImpl, log: quiet })
  const first = await tts.synthesize({ userId: 1, text: 'Three things need you.' })
  const again = await tts.synthesize({ userId: 1, text: '  Three things need you.  ' })
  assert.equal(seen.length, 1)
  assert.equal(first.cached, false)
  assert.equal(again.cached, true)
  assert.deepEqual(again.bytes, first.bytes)
  assert.equal(again.etag, first.etag)
  assert.equal(again.key, first.key)
  assert.equal(tts.usage(1).used, 22, 'charged once, for the 22 characters')
  assert.deepEqual(fs.readdirSync(dir), [`${first.key}.mp3`])
  assert.equal(fs.statSync(path.join(dir, `${first.key}.mp3`)).mode & 0o777, 0o600)

  // Another user's request for the same line is a hit too, and free.
  assert.equal((await tts.synthesize({ userId: 2, text: 'Three things need you.' })).cached, true)
  assert.equal(tts.usage(2).used, 0)

  await tts.synthesize({ userId: 1, text: 'Three things need you.', format: 'wav' })
  await tts.synthesize({ userId: 1, text: 'Three things need you.', voice: 'en-GB-Emily' })
  assert.equal(seen.length, 3)
  assert.equal(fs.readdirSync(dir).length, 3)

  const reborn = makeCloudTts({ key: 'k', cacheDir: dir, fetchImpl, log: quiet })
  assert.equal((await reborn.synthesize({ userId: 1, text: 'Three things need you.' })).cached, true)
  assert.equal(seen.length, 3)
})

test('cache expiry: a clip older than 24 hours is not served and is synthesised again; sweep deletes old clips and only its own files', async (t) => {
  const dir = tmpDir(t)
  const seen = []
  const tts = makeCloudTts({ key: 'k', cacheDir: dir, fetchImpl: fakeFetch({}, seen), log: quiet })
  const age = (name, ms) => { const at = new Date(Date.now() - ms); fs.utimesSync(path.join(dir, name), at, at) }

  const a = await tts.synthesize({ userId: 1, text: 'old line' })
  age(`${a.key}.mp3`, TTS_CACHE_TTL_MS - 60000)
  assert.equal((await tts.synthesize({ userId: 1, text: 'old line' })).cached, true, 'a minute short of 24 hours: still served')
  age(`${a.key}.mp3`, TTS_CACHE_TTL_MS + 60000)
  const b = await tts.synthesize({ userId: 1, text: 'old line' })
  assert.equal(b.cached, false, 'past 24 hours the file is not served')
  assert.equal(seen.length, 2)
  assert.equal(b.key, a.key)
  assert.equal((await tts.synthesize({ userId: 1, text: 'old line' })).cached, true, 'the new clip replaced the old file')

  const stale = await tts.synthesize({ userId: 1, text: 'stale line' })
  age(`${stale.key}.mp3`, TTS_CACHE_TTL_MS + 60000)
  const abandoned = `${'a'.repeat(64)}.mp3.0123456789ab.tmp`
  fs.writeFileSync(path.join(dir, abandoned), 'half a clip')
  age(abandoned, TTS_CACHE_TTL_MS + 60000)
  fs.writeFileSync(path.join(dir, 'README.txt'), 'not ours')
  age('README.txt', 2 * TTS_CACHE_TTL_MS)
  assert.deepEqual(tts.sweep(), { removed: 2 }, 'the stale clip and the abandoned temp file')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['README.txt', `${b.key}.mp3`].sort())
  assert.deepEqual(tts.sweep(), { removed: 0 })
  assert.deepEqual(makeCloudTts({ key: 'k', cacheDir: path.join(dir, 'never-made'), log: quiet }).sweep(), { removed: 0 })
})

test('two requests for the same line at once make one Azure call; the second waits for the first', async (t) => {
  const g = gatedFetch()
  const tts = makeCloudTts({ key: 'k', cacheDir: tmpDir(t), fetchImpl: g.impl, log: quiet })
  const p1 = tts.synthesize({ userId: 1, text: 'same line' })
  const p2 = tts.synthesize({ userId: 2, text: 'same line' })
  await tick()
  assert.equal(g.seen.length, 1)
  g.gates[0].ok('ONE')
  const [c1, c2] = await Promise.all([p1, p2])
  assert.deepEqual(c1.bytes, Buffer.from('ONE'))
  assert.deepEqual(c2.bytes, Buffer.from('ONE'))
  assert.equal(c1.cached, false)
  assert.equal(c2.cached, true)
  assert.equal(tts.usage(1).used, 9)
  assert.equal(tts.usage(2).used, 0, 'the one who joined is not charged')
})

test('failures are tts_failed: HTTP error, network error, empty audio; logged without the key or the text; nothing cached', async (t) => {
  const dir = tmpDir(t)
  const logs = []
  const log = { log: (m) => logs.push(m), error: (m) => logs.push(m) }
  const mk = (reply) => makeCloudTts({ key: 'super-secret', cacheDir: dir, fetchImpl: fakeFetch(reply), log })
  await rejectsWith(mk({ status: 401, text: 'Access denied due to invalid subscription key' }).synthesize({ userId: 1, text: 'private words' }), 'tts_failed')
  await rejectsWith(mk(new Error('getaddrinfo ENOTFOUND')).synthesize({ userId: 1, text: 'private words' }), 'tts_failed')
  await rejectsWith(mk({ bytes: '' }).synthesize({ userId: 1, text: 'private words' }), 'tts_failed')
  assert.equal(logs.length, 3)
  assert.match(logs[0], /^tts: synthesis failed: azure tts HTTP 401: Access denied/)
  assert.match(logs[1], /ENOTFOUND/)
  assert.match(logs[2], /empty audio/)
  assert.ok(logs.every((l) => !l.includes('super-secret') && !l.includes('private words')))
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0)
  // A later success for the same line still goes to Azure.
  const seen = []
  const ok = makeCloudTts({ key: 'k', cacheDir: dir, fetchImpl: fakeFetch({}, seen), log })
  assert.equal((await ok.synthesize({ userId: 1, text: 'private words' })).cached, false)
  assert.match(logs[3], /^tts: user 1: 13 chars, en-GB-Harry, mp3, 5 bytes in \d+ ms$/)
})

test('timeout: a request Azure never answers fails as tts_failed after requestTimeoutMs', async (t) => {
  const g = gatedFetch()
  const tts = makeCloudTts({ key: 'k', cacheDir: tmpDir(t), fetchImpl: g.impl, requestTimeoutMs: 30, log: quiet })
  // AbortSignal.timeout's timer is unref'd: with nothing else pending, the
  // test process would exit before it fires. The server's listener keeps
  // the loop alive in production; here a plain timer does.
  const keepAlive = setTimeout(() => {}, 5000)
  t.after(() => clearTimeout(keepAlive))
  const t0 = Date.now()
  await rejectsWith(tts.synthesize({ userId: 1, text: 'slow' }), 'tts_failed')
  assert.ok(Date.now() - t0 < 2000)
  assert.equal(g.seen[0].signal.aborted, true)
})

test('daily budget: characters per user per UTC day, counted on a miss that goes to Azure; over it is tts_budget_exceeded; a new day resets', async (t) => {
  const seen = []
  let clock = Date.parse('2026-10-03T23:59:00Z')
  const tts = makeCloudTts({ key: 'k', cacheDir: tmpDir(t), dailyChars: 25, fetchImpl: fakeFetch({}, seen), now: () => clock, log: quiet })
  assert.deepEqual(tts.usage(1), { day: '2026-10-03', used: 0, limit: 25 })
  await tts.synthesize({ userId: 1, text: 'x'.repeat(10) })
  await tts.synthesize({ userId: 1, text: 'y'.repeat(15) })
  assert.equal(tts.usage(1).used, 25, 'exactly the budget is allowed')
  await rejectsWith(tts.synthesize({ userId: 1, text: 'z' }), 'tts_budget_exceeded')
  assert.equal(seen.length, 2)
  // A cached line still plays when the budget is spent.
  assert.equal((await tts.synthesize({ userId: 1, text: 'x'.repeat(10) })).cached, true)
  // Another user has their own budget.
  await tts.synthesize({ userId: 2, text: 'z' })
  assert.equal(tts.usage(2).used, 1)
  // A failed call was still sent, so it still counts.
  const failing = makeCloudTts({ key: 'k', cacheDir: tmpDir(t), dailyChars: 25, fetchImpl: fakeFetch({ status: 500 }), now: () => clock, log: quiet })
  await rejectsWith(failing.synthesize({ userId: 1, text: 'x'.repeat(20) }), 'tts_failed')
  assert.equal(failing.usage(1).used, 20)
  // Midnight UTC.
  clock = Date.parse('2026-10-04T00:00:01Z')
  assert.deepEqual(tts.usage(1), { day: '2026-10-04', used: 0, limit: 25 })
  await tts.synthesize({ userId: 1, text: 'z'.repeat(25) })
  assert.equal(seen.length, 4)
})

test('concurrency: 4 requests at Azure at once across users, the next wait their turn, and past the queue it is tts_busy and not charged', async (t) => {
  const g = gatedFetch()
  const tts = makeCloudTts({ key: 'k', cacheDir: tmpDir(t), fetchImpl: g.impl, maxQueued: 2, log: quiet })
  const running = [1, 2, 3, 4].map((i) => tts.synthesize({ userId: i, text: `line ${i}` }))
  const queued = [5, 6].map((i) => tts.synthesize({ userId: i, text: `line ${i}` }))
  await tick()
  assert.equal(g.seen.length, 4, 'four in flight, two waiting')
  await rejectsWith(tts.synthesize({ userId: 7, text: 'line 7' }), 'tts_busy')
  assert.equal(tts.usage(7).used, 0)
  assert.equal(g.seen.length, 4)

  g.gates[0].ok()
  await running[0]
  await tick()
  assert.equal(g.seen.length, 5, 'a finished request hands its slot to the first in the queue')
  assert.match(g.seen[4].body, />line 5</)
  g.gates[1].fail()
  await rejectsWith(running[1], 'tts_failed')
  await tick()
  assert.equal(g.seen.length, 6, 'a failed request frees its slot too')
  for (const i of [2, 3, 4, 5]) g.gates[i].ok()
  await Promise.all([running[2], running[3], ...queued])
  // Everything has drained: four more can start at once.
  const more = [8, 9, 10, 11].map((i) => tts.synthesize({ userId: i, text: `line ${i}` }))
  await tick()
  assert.equal(g.seen.length, 10)
  for (const i of [6, 7, 8, 9]) g.gates[i].ok()
  await Promise.all(more)
})

test('close: aborts what is in flight, fails what is queued, refuses what comes after; resolves when all have returned', async (t) => {
  const g = gatedFetch()
  const tts = makeCloudTts({ key: 'k', cacheDir: tmpDir(t), fetchImpl: g.impl, concurrency: 1, log: quiet })
  const inFlight = tts.synthesize({ userId: 1, text: 'one' })
  const waiting = tts.synthesize({ userId: 1, text: 'two' })
  await tick()
  const flightFailed = rejectsWith(inFlight, 'tts_failed')
  const waitFailed = rejectsWith(waiting, 'tts_failed')
  await tts.close()
  await flightFailed
  await waitFailed
  assert.equal(g.seen.length, 1, 'the queued one never reached Azure')
  assert.equal(g.seen[0].signal.aborted, true)
  await rejectsWith(tts.synthesize({ userId: 1, text: 'three' }), 'tts_failed')
  await tts.close()
})

// ---- makeConfiguredTts: the synthesiser the environment describes ----

test('makeConfiguredTts: off without a key; on with the transcription key (never logged); its own settings from the environment', async (t) => {
  const dir = tmpDir(t)
  const logs = []
  const log = { log: (m) => logs.push(m), error: (m) => logs.push(m) }
  assert.equal(makeConfiguredTts({ env: {}, cacheDir: dir, log }), null)
  assert.equal(logs.length, 0)

  const shared = makeConfiguredTts({ env: { MATRON_STT_AZURE_KEY: 'sekrit' }, cacheDir: dir, log })
  assert.equal(shared.kind, 'cloud')
  assert.equal(shared.label, 'Azure MAI-Voice-2.1-Flash at northeurope.tts.speech.microsoft.com')
  assert.equal(shared.voices().default, 'en-GB-Harry')
  assert.equal(shared.usage(1).limit, 300000)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /^tts: speech is synthesised by Azure MAI-Voice-2\.1-Flash at northeurope\.tts\.speech\.microsoft\.com \(default voice en-GB-Harry, 300000 characters per user per day\)$/)
  assert.ok(logs.every((l) => !l.includes('sekrit')))

  const seen = []
  const own = makeConfiguredTts({
    env: {
      MATRON_TTS_AZURE_KEY: 'tts-key', MATRON_STT_AZURE_KEY: 'stt-key', MATRON_TTS_AZURE_REGION: 'uksouth',
      MATRON_TTS_MODEL: 'MAI-Voice-3', MATRON_TTS_VOICE: 'en-GB-Emily', MATRON_TTS_DAILY_CHARS: '1000',
    },
    cacheDir: dir, log, fetchImpl: fakeFetch({}, seen),
  })
  assert.equal(own.label, 'Azure MAI-Voice-3 at uksouth.tts.speech.microsoft.com')
  assert.equal(own.voices().default, 'en-GB-Emily')
  assert.equal(own.usage(1).limit, 1000)
  await own.synthesize({ userId: 1, text: 'hi' })
  assert.equal(seen[0].headers['Ocp-Apim-Subscription-Key'], 'tts-key')
  assert.match(seen[0].body, /<voice name="en-GB-Emily:MAI-Voice-3">/)
})

test('makeConfiguredTts: MATRON_TTS_DISABLED=1 wins over a key; an unreadable key file is loud and off; bad voice and budget fall back', (t) => {
  const dir = tmpDir(t)
  const logs = []
  const log = { log: (m) => logs.push(m), error: (m) => logs.push(m) }
  assert.equal(makeConfiguredTts({ env: { MATRON_STT_AZURE_KEY: 'k', MATRON_TTS_DISABLED: '1' }, cacheDir: dir, log }), null)
  assert.match(logs[0], /MATRON_TTS_DISABLED=1.*OFF/)
  assert.notEqual(makeConfiguredTts({ env: { MATRON_STT_AZURE_KEY: 'k', MATRON_TTS_DISABLED: '0' }, cacheDir: dir, log: quiet }), null)

  logs.length = 0
  assert.equal(makeConfiguredTts({ env: { MATRON_TTS_AZURE_KEY_FILE: '/nonexistent/key', MATRON_STT_AZURE_KEY: 'k' }, cacheDir: dir, log }), null)
  assert.match(logs[0], /MATRON_TTS_AZURE_KEY_FILE is set but unreadable.*OFF/)
  logs.length = 0
  assert.equal(makeConfiguredTts({ env: { MATRON_STT_AZURE_KEY_FILE: '/nonexistent/key' }, cacheDir: dir, log }), null)
  assert.match(logs[0], /MATRON_STT_AZURE_KEY_FILE is set but unreadable.*OFF/)

  logs.length = 0
  const t1 = makeConfiguredTts({ env: { MATRON_STT_AZURE_KEY: 'k', MATRON_TTS_VOICE: 'en-US-Jenny', MATRON_TTS_DAILY_CHARS: 'lots' }, cacheDir: dir, log })
  assert.equal(t1.voices().default, 'en-GB-Harry')
  assert.equal(t1.usage(1).limit, 300000)
  assert.match(logs[0], /MATRON_TTS_VOICE="en-US-Jenny" is not one of en-GB-Harry, en-GB-Emily/)
  assert.match(logs[1], /MATRON_TTS_DAILY_CHARS="lots" is invalid/)

  // An empty model means the bare voice id.
  assert.equal(makeConfiguredTts({ env: { MATRON_STT_AZURE_KEY: 'k', MATRON_TTS_MODEL: '' }, cacheDir: dir, log: quiet }).label, 'Azure standard voices at northeurope.tts.speech.microsoft.com')
})
