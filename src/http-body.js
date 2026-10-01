// The two primitives every HTTP handler module needs: a JSON responder and
// the body reader with its size cap. Extracted from src/http.js when
// src/items-http.js became a second handler module — readBody carries
// security-relevant socket handling (the 1 MB cap, the unread-body 413 path
// http.js's outer catch pairs with, the non-object guard), and two
// hand-synced copies of that is exactly the kind of drift that turns into a
// hole. One copy, both callers.
import { StringDecoder } from 'node:string_decoder'

export const json = (res, status, obj) => {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

// The raw text of a request body, with the same 1 MB cap and socket
// handling as readBody. For the one non-JSON POST the journal accepts (the
// browser form on the GitHub confirm page). `maxBytes` lets a route cap
// tighter than the 1 MB default (the Alertmanager webhook takes 256 KiB);
// the overflow path is the same 413 either way.
//
// The cap counts bytes off the wire, not decoded characters: with
// setEncoding('utf8') a string's .length is UTF-16 code units, so a body
// of 3-byte characters (€) got three times the cap through (CodeRabbit,
// PR #104). Raw Buffer chunks are counted, then decoded with a
// StringDecoder, which carries a multibyte character split across two
// chunks over to the next write instead of mangling it. For an ASCII body
// (every JSON body the apps and bridges send in practice) bytes and
// characters are the same number, so the default cap is unchanged there.
export const readRawBody = (req, { maxBytes = 1e6 } = {}) => new Promise((resolve, reject) => {
  const decoder = new StringDecoder('utf8')
  let data = ''
  let bytes = 0
  let settled = false
  const fail = (err) => { if (!settled) { settled = true; reject(err) } }
  req.on('data', (c) => {
    const chunk = typeof c === 'string' ? Buffer.from(c) : c
    bytes += chunk.length
    if (bytes > maxBytes) {
      req.removeAllListeners('data')
      req.pause()
      fail(Object.assign(new Error('body too large'), { statusCode: 413 }))
      return
    }
    data += decoder.write(chunk)
  })
  req.on('end', () => {
    if (settled) return
    settled = true
    resolve(data + decoder.end())
  })
  req.on('close', () => fail(new Error('connection closed')))
  req.on('error', fail)
})

export const readBody = (req, opts) => readRawBody(req, opts).then((data) => new Promise((resolve, reject) => {
    if (!data) { resolve({}); return }
    let parsed
    try {
      parsed = JSON.parse(data)
    } catch {
      reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }))
      return
    }
    // Shared guard for every POST handler: any JSON value that isn't a
    // plain object (literal `null`, an array, or a bare string/number/bool)
    // would otherwise reach a handler's `const {x} = body` destructure and
    // either throw outright (null → 500) or silently produce `undefined`
    // fields that fail deeper and less legibly (e.g. as a DB bind-type
    // error → 500).
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      reject(Object.assign(new Error('request body must be a JSON object'), { statusCode: 400 }))
      return
    }
    resolve(parsed)
}))
