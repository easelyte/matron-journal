// RFC 8785 JSON Canonicalization Scheme (docs/protocol.md "Federation":
// canonical JSON). The bytes a federation signature covers are the JCS form
// of the envelope, so both journals sign and check identical bytes however
// the envelope was spaced or ordered on the wire.
//
// JCS is the ECMAScript serialisation with object keys sorted by UTF-16
// code units, which is what JSON.stringify does for strings and numbers and
// what Array.prototype.sort does for keys. What JSON.stringify would quietly
// do differently is refused instead: undefined, functions, symbols, bigints
// and non-finite numbers are Error('not_canonical'), and so is a string
// holding a lone surrogate or a noncharacter (I-JSON has neither;
// federation-json.js never produces one). Only plain data goes in: no toJSON, no class instances.

import { isIJsonString } from './federation-json.js'

const fail = () => { throw new Error('not_canonical') }

export function canonicalize(value) {
  return ser(value, 0)
}

function ser(v, depth) {
  if (depth > 128) fail()
  if (v === null) return 'null'
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(v)) fail()
      return JSON.stringify(v)
    case 'string':
      if (!isIJsonString(v)) fail()
      return JSON.stringify(v)
    case 'object': {
      if (Array.isArray(v)) {
        // By index, never the iterator: what goes on the wire is the indices.
        const parts = []
        for (let i = 0; i < v.length; i++) parts.push(ser(v[i], depth + 1))
        return '[' + parts.join(',') + ']'
      }
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) fail()
      const keys = Object.keys(v).sort()
      return '{' + keys.map((k) => {
        if (!isIJsonString(k)) fail()
        return JSON.stringify(k) + ':' + ser(v[k], depth + 1)
      }).join(',') + '}'
    }
    default: return fail()
  }
}
