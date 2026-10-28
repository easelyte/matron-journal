// HTTP surface of cloud speech (src/cloud-tts.js; spec 2026-10-03 voice
// mode, section 2):
//   POST /tts {text, voice?, format?}  -> the audio bytes
//   GET  /tts/voices                   -> {voices: [{id, name, locale, gender}], default}
// Client devices only: speech is for the person listening, and an agent
// token must not be able to spend the user's daily budget. With no
// synthesiser configured both routes answer 501 tts_unconfigured, which is
// also how an app learns to use the on-device voice (an older journal
// answers 404).
import { json, readBody } from './http-body.js'
import { TtsError } from './cloud-tts.js'

export async function handleTtsRoute({ tts }, req, res, url, who) {
  const speak = req.method === 'POST' && url.pathname === '/tts'
  const list = req.method === 'GET' && url.pathname === '/tts/voices'
  if (!speak && !list) return false
  if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }
  if (list) {
    if (!tts) { json(res, 501, { error: 'tts_unconfigured' }); return true }
    json(res, 200, tts.voices())
    return true
  }
  // Read before answering 501, so the body never sits unread on the socket.
  const body = await readBody(req)
  if (!tts) { json(res, 501, { error: 'tts_unconfigured' }); return true }
  let clip
  try {
    clip = await tts.synthesize({ userId: who.userId, text: body.text, voice: body.voice, format: body.format })
  } catch (err) {
    if (!(err instanceof TtsError)) throw err
    if (err.code === 'tts_busy') res.setHeader('Retry-After', '1')
    json(res, err.status, { error: err.code })
    return true
  }
  // The caller hung up while Azure was working: the clip is cached for its
  // retry, and there is nobody to write to.
  if (res.writableEnded || res.destroyed) return true
  res.writeHead(200, {
    'content-type': clip.contentType,
    'content-length': String(clip.bytes.length),
    etag: clip.etag,
    'cache-control': 'private, max-age=86400',
    'x-content-type-options': 'nosniff',
  })
  res.end(clip.bytes)
  return true
}
