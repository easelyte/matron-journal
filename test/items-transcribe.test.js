import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { listComments, listPendingTranscripts } from '../src/items.js'
import { makeTranscriber, cleanWhisperText, parseSegments, resolveWhisperPrompt, withDeviceNames, promptLooksTruncated, DEFAULT_WHISPER_PROMPT } from '../src/transcribe.js'

// A transcriber whose jobs the test releases by hand, so "pending" is a state
// the assertions can actually observe rather than a race.
function gatedTranscriber() {
  const calls = []
  const waiters = []
  return {
    calls,
    transcribeFile(diskPath, { signal } = {}) {
      calls.push(diskPath)
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject })
        signal?.addEventListener('abort', () => reject(new Error('aborted'))) // as execFile does
      })
    },
    release(text) { waiters.shift().resolve(text) },
    fail(msg = 'boom') { waiters.shift().reject(new Error(msg)) },
  }
}

async function fleet(t, serverOpts = {}) {
  const wakeCalls = []
  const waker = { enabled: true, wake: (name) => wakeCalls.push(name) }
  const s = await startTestServer({ waker, ...serverOpts })
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const agent = createAgent(s.db, alice.id, 'box-2')
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: agent.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })
  const blob = (id, ownerId) => s.db.prepare('INSERT INTO blobs(id,owner_user_id,content_type,size,sha256,disk_path,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, ownerId, 'audio/mp4', 3, 'x', `/media/${id}`, Date.now())
  blob('b1', alice.id); blob('b2', alice.id); blob('patblob', pat.id)
  const made = await s.http('/items', { method: 'POST', token: agent.token, body: { kind: 'question', title: 'Which auth?', convo_id: 'c1' } })
  return { s, alice, agent, client: login.json.token, itemId: made.json.item.id, wakeCalls }
}

const voice = (ref) => ({ blob_ref: ref, mime: 'audio/mp4', name: `${ref}.m4a`, size: 3 })
const isItem = (action) => (f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === action

test('voice comment: announced pending, transcribed, then a quiet updated marker carries the words', async (t) => {
  const tr = gatedTranscriber()
  const { s, agent, client, itemId, wakeCalls } = await fleet(t, { transcriber: tr })
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, body: { attachments: [voice('b1'), { blob_ref: 'img', mime: 'image/png', name: 'a.png', size: 1 }] } })
  assert.equal(r.status, 201)
  assert.equal(r.json.comment.attachments[0].transcript_status, 'pending')
  assert.equal(r.json.comment.attachments[1].transcript_status, undefined) // images are nobody's job
  const first = await ws.waitFor(isItem('commented'))
  assert.equal(first.payload.comment.attachments[0].transcript_status, 'pending')
  assert.equal(first.payload.comment.attachments[0].transcript, null)
  assert.equal(first.payload.transcription, undefined)
  assert.deepEqual(tr.calls, ['/media/b1'])
  const eventsBefore = s.db.prepare('SELECT COUNT(*) AS n FROM events').get().n
  const wakesBefore = wakeCalls.length

  tr.release('  use option A  ')
  const second = await ws.waitFor(isItem('updated'))
  assert.equal(second.sender, 'user:alice'); assert.equal(second.payload.by, 'user')
  assert.equal(second.payload.transcription, 'done'); assert.equal(second.payload.for_action, 'commented')
  assert.equal(second.payload.comment.id, r.json.comment.id)
  assert.equal(second.payload.comment.attachments[0].transcript, 'use option A')
  assert.equal(second.payload.comment.attachments[0].transcript_status, 'done')
  assert.ok(second.seq > first.seq)
  ws.close()
  // Quiet: exactly one event (no fallback text), and no second wake.
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, eventsBefore + 1)
  assert.equal(wakeCalls.length, wakesBefore)
  const stored = listComments(s.db, itemId).find((c) => c.id === r.json.comment.id)
  assert.equal(stored.attachments[0].transcript, 'use option A')
})

test('failure still answers: transcription:failed, status failed, no transcript', async (t) => {
  const tr = gatedTranscriber()
  const { s, agent, client, itemId } = await fleet(t, { transcriber: tr })
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  await s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, body: { attachments: [voice('b1')] } })
  tr.fail()
  const m = await ws.waitFor(isItem('updated'))
  assert.equal(m.payload.transcription, 'failed')
  assert.equal(m.payload.comment.attachments[0].transcript, null)
  assert.equal(m.payload.comment.attachments[0].transcript_status, 'failed')
  ws.close()
})

test('two voice notes: one marker, after the LAST settles; a failed one marks the whole failed', async (t) => {
  const tr = gatedTranscriber()
  const { s, client, itemId } = await fleet(t, { transcriber: tr })
  await s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, body: { attachments: [voice('b1'), voice('b2')] } })
  const updated = () => s.db.prepare("SELECT payload FROM events WHERE type='item'").all().map((r) => JSON.parse(r.payload)).filter((p) => p.action === 'updated')
  tr.release('one')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(updated().length, 0)
  tr.fail()
  await s.itemTranscription.idle()
  const u = updated()
  assert.equal(u.length, 1); assert.equal(u[0].transcription, 'failed')
  assert.deepEqual(u[0].comment.attachments.map((a) => a.transcript), ['one', null])
})

test("another user's blob is never transcribed into this user's comment", async (t) => {
  const tr = gatedTranscriber()
  const { s, client, itemId } = await fleet(t, { transcriber: tr })
  const r = await s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, body: { attachments: [voice('patblob')] } })
  await s.itemTranscription.idle()
  assert.deepEqual(tr.calls, [])
  assert.equal(listComments(s.db, itemId).find((c) => c.id === r.json.comment.id).attachments[0].transcript_status, 'failed')
})

test('agent comments and idempotent replays queue nothing; transcription off leaves markers untouched', async (t) => {
  const tr = gatedTranscriber()
  const { s, agent, client, itemId } = await fleet(t, { transcriber: tr })
  const a = await s.http(`/items/${itemId}/comments`, { method: 'POST', token: agent.token, body: { attachments: [voice('b1')] } })
  assert.equal(a.json.comment.attachments[0].transcript_status, undefined)
  const post = () => s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, headers: { 'idempotency-key': 'k1' }, body: { attachments: [voice('b1')] } })
  assert.equal((await post()).status, 201); assert.equal((await post()).status, 200)
  assert.equal(tr.calls.length, 1)
  tr.release('x'); await s.itemTranscription.idle()

  const off = await fleet(t, { transcriber: null })
  const r = await off.s.http(`/items/${off.itemId}/comments`, { method: 'POST', token: off.client, body: { attachments: [voice('b1')] } })
  assert.equal(r.json.comment.attachments[0].transcript_status, undefined)
  assert.equal(off.s.itemTranscription.enabled, false)
})

test("the bridge's own PATCH wins the race: its words are kept, the marker still goes out as done", async (t) => {
  const tr = gatedTranscriber()
  const { s, agent, client, itemId } = await fleet(t, { transcriber: tr })
  const r = await s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, body: { attachments: [voice('b1')] } })
  const p = await s.http(`/items/${itemId}/comments/${r.json.comment.id}`, { method: 'PATCH', token: agent.token, body: { blob_ref: 'b1', transcript: 'bridge words' } })
  assert.equal(p.json.comment.attachments[0].transcript_status, 'done')
  tr.release('journal words'); await s.itemTranscription.idle()
  assert.equal(listComments(s.db, itemId).find((c) => c.id === r.json.comment.id).attachments[0].transcript, 'bridge words')
})

test('recover(): a comment left pending by a dead process is re-queued at boot', async (t) => {
  const tr = gatedTranscriber()
  const { s, alice, client, itemId } = await fleet(t, { transcriber: tr })
  const r = await s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, body: { attachments: [voice('b1')] } })
  assert.deepEqual(listPendingTranscripts(s.db), [{ commentId: r.json.comment.id, userId: alice.id, blobRef: 'b1' }])
  assert.equal(s.itemTranscription.recover(), 1) // what a fresh process would do
  tr.release('first'); await s.itemTranscription.idle()
  assert.equal(tr.calls.length, 1) // the duplicate job saw it settled and never ran whisper
  assert.deepEqual(listPendingTranscripts(s.db), [])
  // ...and emitted no second marker.
  const n = s.db.prepare("SELECT payload FROM events WHERE type='item'").all().filter((e) => JSON.parse(e.payload).action === 'updated').length
  assert.equal(n, 1)
})

test('makeTranscriber: off without a model, off (loudly) when the model path is missing; whisper text is cleaned', () => {
  assert.equal(makeTranscriber({ modelPath: '' }), null)
  const errs = []
  assert.equal(makeTranscriber({ modelPath: '/nope/models/ggml-base.bin', log: { error: (m) => errs.push(m) } }), null)
  assert.equal(errs.length, 1)
  assert.match(errs[0], /whisper model is missing at .* voice notes will NOT be transcribed here/)
  assert.equal(cleanWhisperText(' [BLANK_AUDIO]\n Use option A.\n'), 'Use option A.')
})

test('makeTranscriber: whisper-cli gets the vocabulary prompt as --prompt, and none when it is off', async (t) => {
  // Model and cli only have to exist for the boot check; the injected exec
  // never runs them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const modelPath = path.join(dir, 'ggml-small.bin'); fs.writeFileSync(modelPath, '')
  const cliPath = path.join(dir, 'whisper-cli'); fs.writeFileSync(cliPath, '')
  const calls = []
  const exec = async (cmd, args) => { calls.push({ cmd, args }); return { stdout: cmd === cliPath ? 'Alice-mac can get the sudo password.' : '' } }

  const withPrompt = makeTranscriber({ modelPath, cliPath, prompt: 'Matron, alice-mac, sudo.', exec })
  assert.equal(await withPrompt.transcribeFile('/blob'), 'Alice-mac can get the sudo password.')
  const w = calls.find((c) => c.cmd === cliPath)
  assert.deepEqual(w.args.slice(w.args.indexOf('--prompt')), ['--prompt', 'Matron, alice-mac, sudo.'])

  calls.length = 0
  const without = makeTranscriber({ modelPath, cliPath, prompt: '', exec })
  await without.transcribeFile('/blob')
  assert.ok(!calls.find((c) => c.cmd === cliPath).args.includes('--prompt'))

  // With a device lookup, the user's box names ride on the end of the prompt.
  calls.length = 0
  const seen = []
  const named = makeTranscriber({ modelPath, cliPath, prompt: 'Matron.', deviceNames: (uid) => { seen.push(uid); return ['pat', 'alice-mac', 'pat'] }, exec })
  await named.transcribeFile('/blob', { userId: 7 })
  assert.deepEqual(seen, [7])
  const n = calls.find((c) => c.cmd === cliPath)
  assert.equal(n.args[n.args.indexOf('--prompt') + 1], 'Matron. alice-mac, pat.')
})

test('prompt guard: an implausibly short prompted transcript is rerun without the prompt, keeping the fuller one', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const modelPath = path.join(dir, 'ggml-small.bin'); fs.writeFileSync(modelPath, '')
  const cliPath = path.join(dir, 'whisper-cli'); fs.writeFileSync(cliPath, '')
  const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
  const calls = []
  // ffmpeg's stand-in writes a WAV whose size says "124 seconds".
  const exec = async (cmd, args) => {
    calls.push({ cmd, args })
    if (cmd === 'ffmpeg') { fs.writeFileSync(args[args.length - 1], Buffer.alloc(44 + 32000 * 124)); return { stdout: '' } }
    return { stdout: args.includes('--prompt') ? words(16) : words(300) }
  }
  const tr = makeTranscriber({ modelPath, cliPath, prompt: 'Matron.', exec })
  const text = await tr.transcribeFile('/blob')
  const whisper = calls.filter((c) => c.cmd === cliPath)
  assert.equal(whisper.length, 2)
  assert.ok(whisper[0].args.includes('--prompt'))
  assert.ok(!whisper[1].args.includes('--prompt'))
  assert.equal(text.split(' ').length, 300)

  // A rerun that fails keeps the prompted transcript; an abort still propagates.
  calls.length = 0
  const flaky = makeTranscriber({ modelPath, cliPath, prompt: 'Matron.', exec: async (cmd, args) => { calls.push({ cmd, args }); if (cmd === 'ffmpeg') { fs.writeFileSync(args[args.length - 1], Buffer.alloc(44 + 32000 * 124)); return { stdout: '' } } if (args.includes('--prompt')) return { stdout: words(16) }; throw new Error('timed out') } })
  assert.equal((await flaky.transcribeFile('/blob')).split(' ').length, 16)
  assert.equal(calls.filter((c) => c.cmd === cliPath).length, 2)
  const ac = new AbortController()
  const aborting = makeTranscriber({ modelPath, cliPath, prompt: 'Matron.', exec: async (cmd, args) => { if (cmd === 'ffmpeg') { fs.writeFileSync(args[args.length - 1], Buffer.alloc(44 + 32000 * 124)); return { stdout: '' } } if (args.includes('--prompt')) return { stdout: words(16) }; ac.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }) } })
  await assert.rejects(aborting.transcribeFile('/blob', { signal: ac.signal }), { name: 'AbortError' })

  // A plausible transcript is never rerun.
  calls.length = 0
  const fine = makeTranscriber({ modelPath, cliPath, prompt: 'Matron.', exec: async (cmd, args) => { calls.push({ cmd, args }); if (cmd === 'ffmpeg') fs.writeFileSync(args[args.length - 1], Buffer.alloc(44 + 32000 * 60)); return { stdout: cmd === cliPath ? words(150) : '' } } })
  await fine.transcribeFile('/blob')
  assert.equal(calls.filter((c) => c.cmd === cliPath).length, 1)

  assert.equal(promptLooksTruncated(words(16), 124), true)
  assert.equal(promptLooksTruncated(words(300), 124), false)
  assert.equal(promptLooksTruncated('', 7), false)
})

test('withDeviceNames: dedupes and sorts, drops names that are not hostname-shaped, survives a failing lookup', () => {
  assert.equal(withDeviceNames('Matron.', () => ['reed', 'elm', 'reed', 'evil --prompt x', '', 42], 1), 'Matron. elm, reed.')
  assert.equal(withDeviceNames('Matron.', () => [], 1), 'Matron.')
  assert.equal(withDeviceNames('Matron.', () => { throw new Error('db') }, 1), 'Matron.')
  assert.equal(withDeviceNames('Matron.', null, 1), 'Matron.')
  assert.equal(withDeviceNames('Matron.', () => ['pat'], null), 'Matron.')
})

test('resolveWhisperPrompt: unset -> built-in vocabulary, empty -> off, set -> trimmed value', () => {
  // An explicit undefined still triggers the default parameter, which reads
  // the real environment, so the test's own env is isolated here.
  const saved = process.env.MATRON_WHISPER_PROMPT
  delete process.env.MATRON_WHISPER_PROMPT
  try {
    assert.equal(resolveWhisperPrompt(), DEFAULT_WHISPER_PROMPT)
  } finally {
    if (saved !== undefined) process.env.MATRON_WHISPER_PROMPT = saved
  }
  assert.ok(DEFAULT_WHISPER_PROMPT.length > 0)
  assert.equal(resolveWhisperPrompt(''), '')
  assert.equal(resolveWhisperPrompt('  '), '')
  assert.equal(resolveWhisperPrompt(' Acme, widget-2. '), 'Acme, widget-2.')
})

// A whisper transcriber whose model and cli exist only for the boot check;
// `exec` stands in for ffmpeg and whisper-cli and records every call.
function fakeWhisper(t, stdout, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const modelPath = path.join(dir, 'ggml-small.bin'); fs.writeFileSync(modelPath, '')
  const cliPath = path.join(dir, 'whisper-cli'); fs.writeFileSync(cliPath, '')
  const calls = []
  const exec = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { stdout: cmd === cliPath ? stdout : '' } }
  return { tr: makeTranscriber({ modelPath, cliPath, prompt: 'Matron.', exec, ...extra }), calls, cliPath }
}

test('segments: runs whisper without --no-timestamps and parses "[00:00:01.200 --> 00:00:02.000]  b" to start_ms 1200', async (t) => {
  const { tr, calls, cliPath } = fakeWhisper(t, '[00:00:00.000 --> 00:00:01.200]   a\n[00:00:01.200 --> 00:00:02.000]  b\n[00:00:02.000 --> 00:00:03.000]   [BLANK_AUDIO]\n')
  assert.deepEqual(await tr.transcribeFileSegments('/blob', { userId: 7 }), { text: 'a b', segments: [{ start_ms: 0, text: 'a' }, { start_ms: 1200, text: 'b' }] })
  const ffmpeg = calls.find((c) => c.cmd === 'ffmpeg')
  assert.ok(ffmpeg.args.includes('-vn'), 'a video container decodes to its audio track')
  const w = calls.find((c) => c.cmd === cliPath)
  assert.ok(!w.args.includes('--no-timestamps'))
  assert.ok(w.args.includes('--prompt'))
  // transcribeFile keeps its untimed run.
  calls.length = 0
  await tr.transcribeFile('/blob')
  assert.ok(calls.find((c) => c.cmd === cliPath).args.includes('--no-timestamps'))
})

test('parseSegments: hours and minutes count, markers and empty lines are dropped', () => {
  assert.deepEqual(parseSegments('[01:02:03.004 --> 01:02:04.000]  late\n  [00:00:05.500 --> 00:00:06.000] (typing)\nnoise\n[00:00:07.000 --> 00:00:08.000]   \n'), [{ start_ms: 3723004, text: 'late' }])
  assert.deepEqual(parseSegments(''), [])
})

test('segments: timeout is 600000', async (t) => {
  const { tr, calls, cliPath } = fakeWhisper(t, '[00:00:00.000 --> 00:00:01.000]  a\n')
  await tr.transcribeFileSegments('/blob')
  assert.equal(calls.find((c) => c.cmd === cliPath).opts.timeout, 600000)
  calls.length = 0
  await tr.transcribeFile('/blob')
  assert.equal(calls.find((c) => c.cmd === cliPath).opts.timeout, 120000)
  const custom = fakeWhisper(t, '[00:00:00.000 --> 00:00:01.000]  a\n', { segmentsTimeoutMs: 5000 })
  await custom.tr.transcribeFileSegments('/blob')
  assert.equal(custom.calls.find((c) => c.cmd === custom.cliPath).opts.timeout, 5000)
})

test('segments: no words throws "empty transcription result"; ffmpeg failing (a video with no audio stream) throws', async (t) => {
  const silent = fakeWhisper(t, '[00:00:00.000 --> 00:00:30.000]   [BLANK_AUDIO]\n')
  await assert.rejects(silent.tr.transcribeFileSegments('/blob'), { message: 'empty transcription result' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const modelPath = path.join(dir, 'ggml-small.bin'); fs.writeFileSync(modelPath, '')
  const cliPath = path.join(dir, 'whisper-cli'); fs.writeFileSync(cliPath, '')
  let wavDir = null
  let whisperRan = false
  const mute = makeTranscriber({ modelPath, cliPath, exec: async (cmd, args) => {
    if (cmd !== 'ffmpeg') { whisperRan = true; return { stdout: '' } }
    wavDir = path.dirname(args[args.length - 1])
    throw new Error('Output file does not contain any stream')
  } })
  await assert.rejects(mute.transcribeFileSegments('/blob'), /does not contain any stream/)
  assert.equal(whisperRan, false)
  assert.equal(fs.existsSync(wavDir), false)
})

test('segments: the prompt guard reruns a truncated prompted run without the prompt', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const modelPath = path.join(dir, 'ggml-small.bin'); fs.writeFileSync(modelPath, '')
  const cliPath = path.join(dir, 'whisper-cli'); fs.writeFileSync(cliPath, '')
  const lines = (n) => Array.from({ length: n }, (_, i) => `[00:00:${String(i % 60).padStart(2, '0')}.000 --> 00:00:59.999]  w${i}`).join('\n')
  const calls = []
  const tr = makeTranscriber({ modelPath, cliPath, prompt: 'Matron.', exec: async (cmd, args) => {
    calls.push({ cmd, args })
    if (cmd === 'ffmpeg') { fs.writeFileSync(args[args.length - 1], Buffer.alloc(44 + 32000 * 124)); return { stdout: '' } }
    return { stdout: args.includes('--prompt') ? lines(16) : lines(300) }
  } })
  const out = await tr.transcribeFileSegments('/blob')
  assert.equal(calls.filter((c) => c.cmd === cliPath).length, 2)
  assert.equal(out.segments.length, 300)
  assert.equal(out.text.split(' ').length, 300)
})

// A whisper whose prompted run comes back implausibly short for a 124-second
// WAV (so the prompt guard wants a rerun), on a clock the test moves: each
// whisper run takes `runMs` of it.
function guardedWhisper(t, { runMs, segmentsTimeoutMs, timed = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const modelPath = path.join(dir, 'ggml-small.bin'); fs.writeFileSync(modelPath, '')
  const cliPath = path.join(dir, 'whisper-cli'); fs.writeFileSync(cliPath, '')
  let clock = 1_000_000
  const runs = []
  const out = (n) => Array.from({ length: n }, (_, i) => (timed ? `[00:00:${String(i % 60).padStart(2, '0')}.000 --> 00:00:59.999]  w${i}` : `w${i}`)).join('\n')
  const exec = async (cmd, args, opts) => {
    if (cmd === 'ffmpeg') { fs.writeFileSync(args[args.length - 1], Buffer.alloc(44 + 32000 * 124)); return { stdout: '' } }
    runs.push({ prompted: args.includes('--prompt'), timeout: opts.timeout })
    clock += runMs
    return { stdout: args.includes('--prompt') ? out(16) : out(300) }
  }
  const tr = makeTranscriber({ modelPath, cliPath, prompt: 'Matron.', exec, now: () => clock, ...(segmentsTimeoutMs ? { segmentsTimeoutMs } : {}) })
  return { tr, runs }
}

test('segments: the prompt-guard rerun gets what is left of the one 600 s budget, not a fresh one', async (t) => {
  const { tr, runs } = guardedWhisper(t, { runMs: 200_000 })
  const got = await tr.transcribeFileSegments('/blob')
  assert.deepEqual(runs.map((r) => [r.prompted, r.timeout]), [[true, 600000], [false, 400000]])
  assert.equal(got.segments.length, 300)
  assert.ok(200_000 + runs[1].timeout <= 600000, 'the first run\'s time plus the rerun\'s limit fit the single budget')
})

test('segments: no rerun when under 60 s of the budget is left; the prompted run stands', async (t) => {
  const { tr, runs } = guardedWhisper(t, { runMs: 545_000 })
  const got = await tr.transcribeFileSegments('/blob')
  assert.equal(runs.length, 1)
  assert.equal(got.segments.length, 16)
  // A custom budget is honoured the same way.
  const custom = guardedWhisper(t, { runMs: 1_000, segmentsTimeoutMs: 10_000 })
  await custom.tr.transcribeFileSegments('/blob')
  assert.equal(custom.runs.length, 1)
})

test('transcribeFile: the prompt-guard rerun still gets its own 120 s timeout (voice notes unchanged)', async (t) => {
  const { tr, runs } = guardedWhisper(t, { runMs: 100_000, timed: false })
  await tr.transcribeFile('/blob')
  assert.deepEqual(runs.map((r) => [r.prompted, r.timeout]), [[true, 120000], [false, 120000]])
})

test('parseSegments: inline markers are stripped like a note\'s, and segments come back in time order', () => {
  assert.deepEqual(parseSegments('[00:00:03.000 --> 00:00:04.000]  later\n[00:00:01.000 --> 00:00:02.000]  [MUSIC] hello [BLANK_AUDIO]\n[00:00:02.000 --> 00:00:03.000]  [MUSIC] \n'), [
    { start_ms: 1000, text: 'hello' },
    { start_ms: 3000, text: 'later' },
  ])
})

test('the same blob attached twice is one whisper run and settles both attachments', async (t) => {
  const tr = gatedTranscriber()
  const { s, client, itemId } = await fleet(t, { transcriber: tr })
  const r = await s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, body: { attachments: [voice('b1'), voice('b1')] } })
  tr.release('same words'); await s.itemTranscription.idle()
  assert.equal(tr.calls.length, 1)
  const atts = listComments(s.db, itemId).find((c) => c.id === r.json.comment.id).attachments
  assert.deepEqual(atts.map((a) => [a.transcript, a.transcript_status]), [['same words', 'done'], ['same words', 'done']])
  assert.deepEqual(listPendingTranscripts(s.db), [])
})

test('admission: past the per-user backlog a comment is stored un-pending (the bridge transcribes it)', async (t) => {
  const { makeItemTranscription } = await import('../src/items-transcribe.js')
  const tr = gatedTranscriber()
  const q = makeItemTranscription({ db: { prepare: () => ({ all: () => [], get: () => null }) }, transcriber: tr, onSettled() {}, maxQueued: 3, maxQueuedPerUser: 2, log: { error() {}, log() {} } })
  assert.equal(q.admit(1, 2), true); assert.equal(q.admit(1, 3), false)
  q.enqueue({ commentId: 'a', userId: 1, blobRef: 'x' }); q.enqueue({ commentId: 'b', userId: 1, blobRef: 'y' })
  assert.equal(q.admit(1, 1), false) // user 1 is full
  assert.equal(q.admit(2, 1), true); assert.equal(q.admit(2, 2), false) // global cap of 3
  await q.idle()
  assert.equal(q.admit(1, 2), true) // drained
})

test('close(): aborts the running job, leaves it pending for the next boot, and resolves', async (t) => {
  let seenSignal = null
  const tr = { transcribeFile: (p, { signal }) => new Promise((_, reject) => { seenSignal = signal; signal.addEventListener('abort', () => reject(new Error('aborted'))) }) }
  const { s, client, itemId } = await fleet(t, { transcriber: tr })
  await s.http(`/items/${itemId}/comments`, { method: 'POST', token: client, body: { attachments: [voice('b1')] } })
  await new Promise((r) => setTimeout(r, 20))
  await s.itemTranscription.close()
  assert.equal(seenSignal.aborted, true)
  assert.equal(listPendingTranscripts(s.db).length, 1)
})

test("a voice note on a new item's BODY: created marker carries it pending, follow-up is for_action:created", async (t) => {
  const tr = gatedTranscriber()
  const { s, agent, client } = await fleet(t, { transcriber: tr })
  const ws = await makeWsClient(s.base, { token: agent.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  const r = await s.http('/items', { method: 'POST', token: client, body: { kind: 'task', title: 'Spoken task', body: 'see the note', convo_id: 'c1', attachments: [voice('b1')] } })
  assert.equal(r.status, 201); assert.equal(r.json.item.attachments[0].transcript_status, 'pending')
  const created = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'created' && f.payload.num === r.json.item.num)
  assert.equal(created.payload.comment.attachments[0].transcript_status, 'pending')
  // The old-client fallback text still leads with the item body, plus the note.
  const fb = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'text' && f.payload.fallback_for === 'item' && f.payload.num === r.json.item.num)
  assert.match(fb.payload.body, /see the note\n\[voice note b1\.m4a\]/)
  tr.release('do the thing')
  const up = await ws.waitFor((f) => f.kind === 'journal' && f.type === 'item' && f.payload.action === 'updated' && f.payload.num === r.json.item.num)
  assert.equal(up.payload.for_action, 'created'); assert.equal(up.payload.transcription, 'done')
  assert.equal(up.payload.comment.id, created.payload.comment.id)
  assert.equal(up.payload.comment.attachments[0].transcript, 'do the thing')
  ws.close()
  assert.equal((await s.http(`/items/${r.json.item.id}`, { token: client })).json.item.attachments[0].transcript, 'do the thing')
  // The bridge's own PATCH onto the body row is labelled the same way.
  const viaBridge = await s.http('/items', { method: 'POST', token: client, body: { kind: 'task', title: 'Second', convo_id: 'c1', attachments: [voice('b2')] } })
  const bodyCid = JSON.parse(s.db.prepare("SELECT payload FROM events WHERE type='item' ORDER BY seq DESC LIMIT 1").get().payload).comment.id
  assert.equal((await s.http(`/items/${viaBridge.json.item.id}/comments/${bodyCid}`, { method: 'PATCH', token: agent.token, body: { blob_ref: 'b2', transcript: 'bridge words' } })).status, 200)
  const patched = JSON.parse(s.db.prepare("SELECT payload FROM events WHERE type='item' ORDER BY seq DESC LIMIT 1").get().payload)
  assert.equal(patched.action, 'updated'); assert.equal(patched.for_action, 'created')
  // An agent-filed item, and one with no audio, put no comment on the marker.
  const plain = await s.http('/items', { method: 'POST', token: client, body: { kind: 'task', title: 'Plain', convo_id: 'c1', attachments: [{ blob_ref: 'img', mime: 'image/png', name: 'a.png', size: 1 }] } })
  const pm = JSON.parse(s.db.prepare("SELECT payload FROM events WHERE type='item' ORDER BY seq DESC LIMIT 1").get().payload)
  assert.equal(pm.num, plain.json.item.num); assert.equal(pm.comment, undefined)
})
