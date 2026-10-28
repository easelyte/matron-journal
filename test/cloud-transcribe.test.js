import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  makeAzureTranscriber, makeConfiguredTranscriber, makeChainedTranscriber, phrasesFor, resolveAzureKey,
  DEFAULT_PHRASES, DEFAULT_AZURE_ENDPOINT, AZURE_API_VERSION,
} from '../src/cloud-transcribe.js'
import { makeTranscriber } from '../src/transcribe.js'

// ffmpeg stand-in: writes a few bytes where the FLAC would go.
function fakeExec(calls = []) {
  return async (cmd, args) => {
    calls.push([cmd, args])
    fs.writeFileSync(args[args.length - 1], 'flac')
    return { stdout: '' }
  }
}

// fetch stand-in recording the request and answering with `reply`.
function fakeFetch(reply, seen = []) {
  return async (url, init) => {
    const definition = JSON.parse(init.body.get('definition'))
    seen.push({ url, headers: init.headers, definition, audio: init.body.get('audio'), signal: init.signal })
    if (reply instanceof Error) throw reply
    return {
      ok: reply.status === undefined || reply.status < 400,
      status: reply.status ?? 200,
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body),
    }
  }
}

test('no key: no cloud transcriber', () => {
  assert.equal(makeAzureTranscriber({ key: '' }), null)
  assert.equal(makeAzureTranscriber({}), null)
})

test('MAI request: flac upload, enhanced mode, clean style, phrases with box names; words joined', async () => {
  const seen = []
  const execCalls = []
  const t = makeAzureTranscriber({
    key: 'k-123',
    fetchImpl: fakeFetch({ body: { combinedPhrases: [{ text: 'Deploy  to' }, { text: 'alice-mac now.' }] } }, seen),
    exec: fakeExec(execCalls),
    deviceNames: (uid) => (uid === 7 ? ['alice-mac', 'pat', 'bad name; rm -rf'] : []),
  })
  assert.equal(t.kind, 'cloud')
  assert.equal(await t.transcribeFile('/media/ab/abc', { userId: 7 }), 'Deploy to alice-mac now.')
  assert.equal(execCalls[0][0], 'ffmpeg')
  assert.ok(execCalls[0][1].includes('/media/ab/abc'))
  assert.equal(seen[0].url, `${DEFAULT_AZURE_ENDPOINT}/speechtotext/transcriptions:transcribe?api-version=${AZURE_API_VERSION}`)
  assert.equal(seen[0].headers['Ocp-Apim-Subscription-Key'], 'k-123')
  assert.equal(seen[0].audio.type, 'audio/flac')
  assert.deepEqual(seen[0].definition.locales, ['en'])
  assert.deepEqual(seen[0].definition.enhancedMode, { enabled: true, model: 'MAI-Transcribe-2', modelOptions: { transcribeStyle: 'clean' } })
  assert.deepEqual(seen[0].definition.phraseList.phrases, [...DEFAULT_PHRASES, 'alice-mac', 'pat'])
})

test('standard model: no enhanced mode, en-GB locale, custom endpoint without a doubled slash', async () => {
  const seen = []
  const t = makeAzureTranscriber({ key: 'k', model: '', endpoint: 'https://uksouth.api.cognitive.microsoft.com/', fetchImpl: fakeFetch({ body: { combinedPhrases: [{ text: 'hi' }] } }, seen), exec: fakeExec() })
  await t.transcribeFile('/x')
  assert.ok(seen[0].url.startsWith('https://uksouth.api.cognitive.microsoft.com/speechtotext/'))
  assert.equal(seen[0].definition.enhancedMode, undefined)
  assert.deepEqual(seen[0].definition.locales, ['en-GB'])
})

test('failures throw: HTTP error, empty result; the temp dir is removed either way', async () => {
  const calls = []
  const bad = makeAzureTranscriber({ key: 'k', fetchImpl: fakeFetch({ status: 400, body: { code: 'InvalidRequest', message: 'nope' } }), exec: fakeExec(calls) })
  await assert.rejects(bad.transcribeFile('/x'), /HTTP 400: .*InvalidRequest/)
  const empty = makeAzureTranscriber({ key: 'k', fetchImpl: fakeFetch({ body: { combinedPhrases: [{ text: '  ' }] } }), exec: fakeExec(calls) })
  await assert.rejects(empty.transcribeFile('/x'), /empty transcription/)
  const none = makeAzureTranscriber({ key: 'k', fetchImpl: fakeFetch({ body: {} }), exec: fakeExec(calls) })
  await assert.rejects(none.transcribeFile('/x'), /empty transcription/)
  assert.equal(calls.length, 3)
  for (const [, args] of calls) assert.equal(fs.existsSync(path.dirname(args[args.length - 1])), false)
})

test('an HTTP error message never carries the key', async () => {
  const t = makeAzureTranscriber({ key: 'super-secret', fetchImpl: fakeFetch({ status: 401, body: { error: 'unauthorized' } }), exec: fakeExec() })
  await assert.rejects(t.transcribeFile('/x'), (err) => !String(err.message).includes('super-secret'))
})

test('the caller signal reaches the request (journal shutdown aborts it)', async () => {
  const seen = []
  const t = makeAzureTranscriber({ key: 'k', fetchImpl: fakeFetch({ body: { combinedPhrases: [{ text: 'x' }] } }, seen), exec: fakeExec() })
  const ac = new AbortController()
  await t.transcribeFile('/x', { signal: ac.signal })
  ac.abort()
  assert.equal(seen[0].signal.aborted, true)
})

test('phrasesFor: dedupes, keeps the base on a throwing lookup', () => {
  assert.deepEqual(phrasesFor(['a', 'b'], () => ['b', 'c'], 1), ['a', 'b', 'c'])
  assert.deepEqual(phrasesFor(['a'], () => { throw new Error('db') }, 1), ['a'])
  assert.deepEqual(phrasesFor(['a'], () => ['x'], null), ['a'])
  assert.ok(DEFAULT_PHRASES.includes('Matron') && DEFAULT_PHRASES.includes('merge train') && !DEFAULT_PHRASES.some((p) => p.includes('.')))
})

test('resolveAzureKey: env value, else key file, else empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-key-'))
  const f = path.join(dir, 'key')
  fs.writeFileSync(f, 'from-file\n')
  assert.equal(resolveAzureKey({ MATRON_STT_AZURE_KEY: ' from-env ' }), 'from-env')
  assert.equal(resolveAzureKey({ MATRON_STT_AZURE_KEY_FILE: f }), 'from-file')
  assert.equal(resolveAzureKey({}), '')
})

test('makeConfiguredTranscriber: cloud when keyed (key never logged), whisper otherwise, loud fallback on an unreadable key file', () => {
  const logs = []
  const log = { log: (m) => logs.push(m), error: (m) => logs.push(m) }
  const whisper = () => ({ kind: 'whisper' })
  const cloud = makeConfiguredTranscriber({ env: { MATRON_STT_AZURE_KEY: 'sekrit', MATRON_STT_AZURE_MODEL: '' }, log, whisper })
  assert.equal(cloud.kind, 'cloud')
  assert.match(cloud.label, /standard at northeurope/)
  assert.ok(logs.every((l) => !l.includes('sekrit')))
  logs.length = 0
  assert.equal(makeConfiguredTranscriber({ env: {}, log, whisper }).kind, 'whisper')
  assert.deepEqual(logs, ["transcribe: item voice notes are transcribed here by whisper.cpp (chat notes stay the bridge's job)"])
  logs.length = 0
  assert.equal(makeConfiguredTranscriber({ env: {}, log, whisper: () => null }), null)
  assert.deepEqual(logs, [], 'no whisper, no key: nothing to say')
  logs.length = 0
  assert.equal(makeConfiguredTranscriber({ env: { MATRON_STT_AZURE_KEY_FILE: '/nonexistent/key' }, log, whisper }).kind, 'whisper')
  assert.match(logs[0], /unreadable.*OFF/)
})

// A transcriber stand-in: answers with `impl(diskPath, opts)` and counts calls.
function fakeTranscriber(impl, extra = {}) {
  const t = { calls: 0, ...extra, async transcribeFile(diskPath, opts) { t.calls++; return impl(diskPath, opts) } }
  return t
}

function logSpy() {
  const lines = []
  return { lines, log: (m) => lines.push(m), error: (m) => lines.push(m) }
}

const azureLike = (impl) => fakeTranscriber(impl, { kind: 'cloud', label: 'Azure X at host.example', concurrency: 4 })

test('chained: primary success never calls fallback', async () => {
  const primary = azureLike(async () => 'from azure')
  const fallback = fakeTranscriber(async () => 'from whisper')
  const t = makeChainedTranscriber(primary, fallback, { log: logSpy() })
  assert.equal(await t.transcribeFile('/x'), 'from azure')
  assert.equal(fallback.calls, 0)
})

test('chained: primary throws → fallback text, one log line naming the primary label', async () => {
  const log = logSpy()
  const seen = []
  const primary = azureLike(async () => { throw new Error('azure transcription HTTP 503: busy') })
  const fallback = fakeTranscriber(async (diskPath, opts) => { seen.push([diskPath, opts.userId]); return 'from whisper' })
  const t = makeChainedTranscriber(primary, fallback, { log })
  assert.equal(await t.transcribeFile('/media/ab/abc', { userId: 7 }), 'from whisper')
  assert.deepEqual(seen, [['/media/ab/abc', 7]])
  assert.equal(log.lines.length, 1)
  assert.ok(log.lines[0].includes('Azure X at host.example'))
  assert.match(log.lines[0], /failed .*trying whisper/)
  assert.match(log.lines[0], /HTTP 503/)
})

test('chained: four concurrent primary failures run the fallback one at a time', async () => {
  let inflight = 0
  let maxInflight = 0
  const releases = []
  const primary = azureLike(async () => { throw new Error('down') })
  const fallback = fakeTranscriber(async (diskPath) => {
    inflight++
    maxInflight = Math.max(maxInflight, inflight)
    await new Promise((resolve) => releases.push(resolve))
    inflight--
    return `whisper ${diskPath}`
  })
  const t = makeChainedTranscriber(primary, fallback, { log: logSpy() })
  const runs = ['/a', '/b', '/c', '/d'].map((p) => t.transcribeFile(p))
  // Release whichever run is waiting, one at a time, until all four are done.
  for (let released = 0; released < 4; released++) {
    while (releases.length === 0) await new Promise((r) => setImmediate(r))
    assert.equal(inflight, 1)
    releases.shift()()
  }
  assert.deepEqual(await Promise.all(runs), ['whisper /a', 'whisper /b', 'whisper /c', 'whisper /d'])
  assert.equal(maxInflight, 1)
  assert.equal(fallback.calls, 4)
})

test('chained: a fallback failure does not stall the runs queued behind it', async () => {
  const primary = azureLike(async () => { throw new Error('down') })
  const fallback = fakeTranscriber(async (diskPath) => { if (diskPath === '/bad') throw new Error('whisper crashed'); return 'ok' })
  const t = makeChainedTranscriber(primary, fallback, { log: logSpy() })
  const [bad, good] = await Promise.allSettled([t.transcribeFile('/bad'), t.transcribeFile('/good')])
  assert.equal(bad.reason.message, 'whisper crashed')
  assert.equal(good.value, 'ok')
})

test('chained: aborted signal skips the fallback and rethrows', async () => {
  const ac = new AbortController()
  const log = logSpy()
  const primary = azureLike(async () => { ac.abort(); throw new Error('This operation was aborted') })
  const fallback = fakeTranscriber(async () => 'from whisper')
  const t = makeChainedTranscriber(primary, fallback, { log })
  await assert.rejects(t.transcribeFile('/x', { signal: ac.signal }), /aborted/)
  assert.equal(ac.signal.aborted, true)
  assert.equal(fallback.calls, 0)
  assert.equal(log.lines.length, 0) // a shutdown says nothing about trying whisper
})

test('chained: an unreachable primary logs the network cause, not just "fetch failed"', async () => {
  const log = logSpy()
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 192.0.2.1:443'), { code: 'ECONNREFUSED' }) })
  const t = makeChainedTranscriber(azureLike(async () => { throw refused }), fakeTranscriber(async () => 'from whisper'), { log })
  assert.equal(await t.transcribeFile('/x'), 'from whisper')
  assert.match(log.lines[0], /failed \(fetch failed: ECONNREFUSED\)/)
  // A cause with no code gives its message instead.
  log.lines.length = 0
  const tls = Object.assign(new TypeError('fetch failed'), { cause: new Error('certificate has expired') })
  const t2 = makeChainedTranscriber(azureLike(async () => { throw tls }), fakeTranscriber(async () => 'w'), { log })
  await t2.transcribeFile('/x')
  assert.match(log.lines[0], /fetch failed: certificate has expired/)
})

test('chained: the fallback is named by its label when it has one', async () => {
  const log = logSpy()
  const t = makeChainedTranscriber(azureLike(async () => { throw new Error('down') }), fakeTranscriber(async () => 'w', { label: 'other STT' }), { log })
  assert.equal(t.label, 'Azure X at host.example, then other STT')
  await t.transcribeFile('/x')
  assert.match(log.lines[0], /trying other STT$/)
})

test('chained: a request aborted while queued for the fallback never starts it', async () => {
  let release
  const primary = azureLike(async () => { throw new Error('down') })
  const fallback = fakeTranscriber(async () => { await new Promise((r) => { release = r }); return 'from whisper' })
  const t = makeChainedTranscriber(primary, fallback, { log: logSpy() })
  const first = t.transcribeFile('/first')
  const ac = new AbortController()
  const second = t.transcribeFile('/second', { signal: ac.signal })
  while (!release) await new Promise((r) => setImmediate(r))
  ac.abort()
  release()
  assert.equal(await first, 'from whisper')
  await assert.rejects(second, /down/)
  assert.equal(fallback.calls, 1)
})

test('chained: fallback throw propagates', async () => {
  const primary = azureLike(async () => { throw new Error('azure down') })
  const fallback = fakeTranscriber(async () => { throw new Error('empty transcription result') })
  const t = makeChainedTranscriber(primary, fallback, { log: logSpy() })
  await assert.rejects(t.transcribeFile('/x'), { message: 'empty transcription result' })
})

test('chained: kind, label and concurrency come from the primary', () => {
  const t = makeChainedTranscriber(azureLike(async () => ''), fakeTranscriber(async () => ''), { log: logSpy() })
  assert.equal(t.kind, 'cloud')
  assert.equal(t.label, 'Azure X at host.example, then whisper.cpp')
  assert.equal(t.concurrency, 4)
})

test('makeConfiguredTranscriber: key + whisper → chain', async () => {
  const log = logSpy()
  const whisperT = fakeTranscriber(async () => 'from whisper')
  const t = makeConfiguredTranscriber({
    env: { MATRON_STT_AZURE_KEY: 'sekrit' },
    log,
    whisper: () => whisperT,
  })
  assert.equal(t.kind, 'cloud')
  assert.match(t.label, /^Azure MAI-Transcribe-2 at northeurope\..*, then whisper\.cpp$/)
  assert.equal(t.concurrency, 4)
  assert.ok(log.lines.some((l) => l.includes(t.label)))
  assert.ok(log.lines.every((l) => !l.includes('sekrit')))
})

test('makeConfiguredTranscriber: key + no whisper → plain azure', () => {
  const log = logSpy()
  const t = makeConfiguredTranscriber({ env: { MATRON_STT_AZURE_KEY: 'sekrit' }, log, whisper: () => null })
  assert.equal(t.kind, 'cloud')
  assert.doesNotMatch(t.label, /whisper/)
  assert.ok(log.lines.some((l) => l.includes(t.label)))
})

test('makeConfiguredTranscriber: key + a configured but missing whisper model → boot says Azure with no fallback, never "not transcribed"', () => {
  const log = logSpy()
  const t = makeConfiguredTranscriber({
    env: { MATRON_STT_AZURE_KEY: 'sekrit' },
    log,
    // The real whisper factory, pointed at a model that is not there.
    whisper: (opts) => makeTranscriber({ ...opts, modelPath: '/nonexistent/models/ggml-small.bin' }),
  })
  assert.equal(t.kind, 'cloud')
  assert.doesNotMatch(t.label, /whisper/)
  assert.equal(log.lines.length, 2)
  assert.match(log.lines[0], /whisper model is missing at .* no whisper fallback/)
  assert.match(log.lines[1], /transcribed on upload by Azure .* \(no whisper fallback\)$/)
  assert.ok(log.lines.every((l) => !/NOT be transcribed/.test(l)))
})

test('segments: phrases become start_ms/text, text is combinedPhrases', async () => {
  const seen = []
  const t = makeAzureTranscriber({
    key: 'k',
    fetchImpl: fakeFetch({ body: { combinedPhrases: [{ text: 'a b' }], phrases: [{ offsetMilliseconds: 0, text: 'a' }, { offsetMilliseconds: 1200, text: 'b' }] } }, seen),
    exec: fakeExec(),
    deviceNames: () => ['alice-mac'],
  })
  assert.deepEqual(await t.transcribeFileSegments('/media/ab/vid', { userId: 7 }), {
    text: 'a b',
    segments: [{ start_ms: 0, text: 'a' }, { start_ms: 1200, text: 'b' }],
  })
  // Same request as transcribeFile: the user's box names ride in the phrase list.
  assert.ok(seen[0].definition.phraseList.phrases.includes('alice-mac'))
  // transcribeFile still answers with the words alone.
  assert.equal(await t.transcribeFile('/x'), 'a b')
})

test('segments: empty → throws \'empty transcription result\'', async () => {
  const calls = []
  const empty = makeAzureTranscriber({ key: 'k', fetchImpl: fakeFetch({ body: { combinedPhrases: [], phrases: [] } }), exec: fakeExec(calls) })
  await assert.rejects(empty.transcribeFileSegments('/x'), { message: 'empty transcription result' })
  const none = makeAzureTranscriber({ key: 'k', fetchImpl: fakeFetch({ body: {} }), exec: fakeExec(calls) })
  await assert.rejects(none.transcribeFileSegments('/x'), { message: 'empty transcription result' })
  for (const [, args] of calls) assert.equal(fs.existsSync(path.dirname(args[args.length - 1])), false)
})

test('segments: a video with no audio stream (ffmpeg fails) throws, and the temp dir is removed', async () => {
  let flacDir = null
  const exec = async (cmd, args) => { flacDir = path.dirname(args[args.length - 1]); throw new Error('Output file does not contain any stream') }
  let fetched = 0
  const t = makeAzureTranscriber({ key: 'k', fetchImpl: async () => { fetched++ }, exec })
  await assert.rejects(t.transcribeFileSegments('/media/ab/mute'), /does not contain any stream/)
  assert.equal(fetched, 0)
  assert.equal(fs.existsSync(flacDir), false)
})

const withSegments = (t, impl) => Object.assign(t, { segCalls: 0, async transcribeFileSegments(diskPath, opts) { t.segCalls++; return impl(diskPath, opts) } })

test('segments: primary failure → fallback segments', async () => {
  const log = logSpy()
  const primary = withSegments(azureLike(async () => 'unused'), async () => { throw new Error('azure transcription HTTP 503: busy') })
  const seen = []
  const fallback = withSegments(fakeTranscriber(async () => 'unused'), async (diskPath, opts) => { seen.push([diskPath, opts.userId]); return { text: 'w', segments: [{ start_ms: 1200, text: 'w' }] } })
  const t = makeChainedTranscriber(primary, fallback, { log })
  assert.deepEqual(await t.transcribeFileSegments('/media/ab/vid', { userId: 7 }), { text: 'w', segments: [{ start_ms: 1200, text: 'w' }] })
  assert.deepEqual(seen, [['/media/ab/vid', 7]])
  assert.equal(primary.calls + fallback.calls, 0) // transcribeFile never ran
  assert.equal(log.lines.length, 1)
  assert.match(log.lines[0], /HTTP 503.*trying whisper/)
})

test('segments: the chain offers transcribeFileSegments only when both sides have it', () => {
  const both = makeChainedTranscriber(withSegments(azureLike(async () => ''), async () => ({})), withSegments(fakeTranscriber(async () => ''), async () => ({})), { log: logSpy() })
  assert.equal(typeof both.transcribeFileSegments, 'function')
  const primaryOnly = makeChainedTranscriber(withSegments(azureLike(async () => ''), async () => ({})), fakeTranscriber(async () => ''), { log: logSpy() })
  assert.equal(primaryOnly.transcribeFileSegments, undefined)
})

test('segments: whisper runs one at a time across transcribeFile and transcribeFileSegments', async () => {
  let inflight = 0
  let maxInflight = 0
  const releases = []
  const hold = async (out) => { inflight++; maxInflight = Math.max(maxInflight, inflight); await new Promise((r) => releases.push(r)); inflight--; return out }
  const primary = withSegments(azureLike(async () => { throw new Error('down') }), async () => { throw new Error('down') })
  const fallback = withSegments(fakeTranscriber(async () => hold('note')), async () => hold({ text: 'vid', segments: [] }))
  const t = makeChainedTranscriber(primary, fallback, { log: logSpy() })
  const runs = [t.transcribeFile('/a'), t.transcribeFileSegments('/v'), t.transcribeFile('/b')]
  for (let released = 0; released < 3; released++) {
    while (releases.length === 0) await new Promise((r) => setImmediate(r))
    assert.equal(inflight, 1)
    releases.shift()()
  }
  assert.deepEqual(await Promise.all(runs), ['note', { text: 'vid', segments: [] }, 'note'])
  assert.equal(maxInflight, 1)
})

test('makeConfiguredTranscriber: key + the real whisper → the chain offers transcribeFileSegments', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const modelPath = path.join(dir, 'ggml-small.bin'); fs.writeFileSync(modelPath, '')
  const cliPath = path.join(dir, 'whisper-cli'); fs.writeFileSync(cliPath, '')
  const tr = makeConfiguredTranscriber({ env: { MATRON_STT_AZURE_KEY: 'k' }, log: logSpy(), whisper: (opts) => makeTranscriber({ ...opts, modelPath, cliPath }) })
  assert.equal(typeof tr.transcribeFileSegments, 'function')
  assert.equal(tr.kind, 'cloud')
})

test('segments: Azure phrases come back in time order', async () => {
  const t = makeAzureTranscriber({ key: 'k', exec: fakeExec(), fetchImpl: fakeFetch({ body: { combinedPhrases: [{ text: 'a b' }], phrases: [{ offsetMilliseconds: 1200, text: 'b' }, { offsetMilliseconds: 0, text: 'a' }] } }) })
  assert.deepEqual((await t.transcribeFileSegments('/x')).segments, [{ start_ms: 0, text: 'a' }, { start_ms: 1200, text: 'b' }])
})

test('chained: audio Azure\'s ffmpeg cannot decode is not retried on whisper (it decodes the same way)', async () => {
  const log = logSpy()
  const exec = async () => { throw new Error('Output file #0 does not contain any stream') }
  let fetched = 0
  const azure = makeAzureTranscriber({ key: 'k', exec, fetchImpl: async () => { fetched++ } })
  const fallback = withSegments(fakeTranscriber(async () => 'from whisper'), async () => ({ text: 'w', segments: [] }))
  const t = makeChainedTranscriber(azure, fallback, { log })
  await assert.rejects(t.transcribeFileSegments('/mute'), /does not contain any stream/)
  await assert.rejects(t.transcribeFile('/mute'), /does not contain any stream/)
  assert.equal(fetched, 0)
  assert.equal(fallback.calls + fallback.segCalls, 0)
  assert.equal(log.lines.length, 2)
  assert.match(log.lines[0], /could not decode .*does not contain any stream.* not trying whisper/)
  assert.doesNotMatch(log.lines[0], /trying whisper\.cpp$/)
  // An HTTP failure after a good decode still falls back.
  const down = makeAzureTranscriber({ key: 'k', exec: fakeExec(), fetchImpl: fakeFetch({ status: 503, body: { code: 'busy' } }) })
  assert.equal(await makeChainedTranscriber(down, fallback, { log: logSpy() }).transcribeFile('/x'), 'from whisper')
})

test('chained: an empty Azure result is not handed to whisper (the cloud heard nothing); a 5xx still is', async () => {
  const fallback = withSegments(fakeTranscriber(async () => 'invented words'), async () => ({ text: 'invented', segments: [{ start_ms: 0, text: 'invented' }] }))
  for (const body of [{ combinedPhrases: [{ text: '  ' }] }, { combinedPhrases: [], phrases: [] }, {}]) {
    const log = logSpy()
    const silent = makeAzureTranscriber({ key: 'k', exec: fakeExec(), fetchImpl: fakeFetch({ body }) })
    const t = makeChainedTranscriber(silent, fallback, { log })
    await assert.rejects(t.transcribeFile('/quiet'), (err) => err.message === 'empty transcription result' && err.emptyResult === true)
    await assert.rejects(t.transcribeFileSegments('/quiet'), (err) => err.message === 'empty transcription result' && err.emptyResult === true)
    assert.equal(log.lines.length, 2)
    assert.match(log.lines[0], /heard no words .* not trying whisper\.cpp/)
  }
  assert.equal(fallback.calls + fallback.segCalls, 0, 'whisper never ran')
  const down = makeAzureTranscriber({ key: 'k', exec: fakeExec(), fetchImpl: fakeFetch({ status: 503, body: { code: 'busy' } }) })
  const chain = makeChainedTranscriber(down, fallback, { log: logSpy() })
  assert.equal(await chain.transcribeFile('/x'), 'invented words')
  assert.deepEqual(await chain.transcribeFileSegments('/x'), { text: 'invented', segments: [{ start_ms: 0, text: 'invented' }] })
})
