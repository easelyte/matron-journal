// Strict JSON for federation envelopes (docs/protocol.md "Federation":
// canonical JSON). JCS (RFC 8785) is defined over I-JSON (RFC 7493), and
// JSON.parse is more lenient than that in ways a signature cares about: it
// keeps the last of two duplicate keys without a word, and it accepts lone
// surrogates and integers it cannot hold exactly. Two journals that parse
// the same bytes must arrive at the same object, or a signature verified by
// one means something different to the other. So envelopes are parsed here,
// never with JSON.parse.
//
// Refused, every one as Error('malformed'):
//   - bytes that are not valid UTF-8, or a leading byte-order mark;
//   - anything outside the RFC 8259 grammar (trailing commas, comments,
//     leading zeros, single quotes, bare words, trailing data);
//   - a duplicate key in any object, at any depth;
//   - a lone surrogate, written raw or as a \u escape;
//   - a Unicode noncharacter (U+FDD0..U+FDEF, U+xFFFE, U+xFFFF), which
//     I-JSON forbids in keys and strings alike;
//   - a number that is not finite, or whose value is an integer outside
//     ±(2^53 - 1): such integers travel as strings;
//   - nesting deeper than MAX_DEPTH.

export const MAX_DEPTH = 64

const fail = () => { throw new Error('malformed') }

// A string I-JSON allows: no lone surrogates and no noncharacters.
const NONCHARACTER = /[\uFDD0-\uFDEF\uFFFE\uFFFF]|[\uD83F\uD87F\uD8BF\uD8FF\uD93F\uD97F\uD9BF\uD9FF\uDA3F\uDA7F\uDABF\uDAFF\uDB3F\uDB7F\uDBBF\uDBFF][\uDFFE\uDFFF]/
export const isIJsonString = (s) => s.isWellFormed() && !NONCHARACTER.test(s)

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// `input` is a Buffer/Uint8Array (decoded strictly) or an already-decoded
// string. Returns the parsed value; objects are null-prototype-free plain
// objects built with defineProperty, so a "__proto__" key is an ordinary key.
export function parseStrict(input) {
  let text
  if (typeof input === 'string') text = input
  else {
    try { text = decoder.decode(input) } catch { fail() }
  }
  if (text.charCodeAt(0) === 0xfeff) fail()
  const p = { s: text, i: 0 }
  ws(p)
  const value = parseValue(p, 0)
  ws(p)
  if (p.i !== p.s.length) fail()
  return value
}

function ws(p) {
  const s = p.s
  while (p.i < s.length) {
    const c = s.charCodeAt(p.i)
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) p.i++
    else break
  }
}

function parseValue(p, depth) {
  const c = p.s[p.i]
  if (c === '{') return parseObject(p, depth + 1)
  if (c === '[') return parseArray(p, depth + 1)
  if (c === '"') return parseString(p)
  if (c === '-' || (c >= '0' && c <= '9')) return parseNumber(p)
  if (p.s.startsWith('true', p.i)) { p.i += 4; return true }
  if (p.s.startsWith('false', p.i)) { p.i += 5; return false }
  if (p.s.startsWith('null', p.i)) { p.i += 4; return null }
  return fail()
}

function parseObject(p, depth) {
  if (depth > MAX_DEPTH) fail()
  p.i++
  const out = {}
  const seen = new Set()
  ws(p)
  if (p.s[p.i] === '}') { p.i++; return out }
  for (;;) {
    ws(p)
    if (p.s[p.i] !== '"') fail()
    const key = parseString(p)
    if (seen.has(key)) fail()
    seen.add(key)
    ws(p)
    if (p.s[p.i] !== ':') fail()
    p.i++
    ws(p)
    const value = parseValue(p, depth)
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
    ws(p)
    const c = p.s[p.i++]
    if (c === '}') return out
    if (c !== ',') fail()
  }
}

function parseArray(p, depth) {
  if (depth > MAX_DEPTH) fail()
  p.i++
  const out = []
  ws(p)
  if (p.s[p.i] === ']') { p.i++; return out }
  for (;;) {
    ws(p)
    out.push(parseValue(p, depth))
    ws(p)
    const c = p.s[p.i++]
    if (c === ']') return out
    if (c !== ',') fail()
  }
}

const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

function parseString(p) {
  const s = p.s
  p.i++
  let out = ''
  for (;;) {
    if (p.i >= s.length) fail()
    const c = s.charCodeAt(p.i)
    if (c === 0x22) { p.i++; break }
    if (c < 0x20) fail()
    if (c === 0x5c) {
      const e = s[p.i + 1]
      if (e === 'u') {
        const hex = s.slice(p.i + 2, p.i + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail()
        out += String.fromCharCode(parseInt(hex, 16))
        p.i += 6
      } else if (e !== undefined && Object.hasOwn(ESCAPES, e)) {
        out += ESCAPES[e]
        p.i += 2
      } else fail()
    } else {
      out += s[p.i]
      p.i++
    }
  }
  // Surrogates are checked on the decoded string, so a pair split across a
  // raw half and an escaped half is judged the same as either alone.
  if (!isIJsonString(out)) fail()
  return out
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y

function parseNumber(p) {
  NUMBER.lastIndex = p.i
  const m = NUMBER.exec(p.s)
  if (!m) fail()
  p.i += m[0].length
  const n = Number(m[0])
  if (!Number.isFinite(n)) fail()
  if (Number.isInteger(n) && !Number.isSafeInteger(n)) fail()
  return n
}
