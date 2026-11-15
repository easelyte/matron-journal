// The conformance matcher: the reference implementation of the variable
// convention documented in test/fixtures/conformance/README.md. Platform
// harnesses re-implement these rules (they are deliberately small).
// ---------------------------------------------------------------------------
// The matcher. Four rules, applied uniformly to HTTP bodies, HTTP headers,
// and WS frames:
//   {"$bind": "name"}  — matches anything; records the actual value under
//                         `name` in the shared bindings map for later $ref.
//   {"$ref": "name"}   — must deep-equal the value previously bound to `name`.
//   {"$type": "T"}     — matches when the actual value's type is T, one of
//                         integer|number|string|boolean|null|array|object.
//   {"$ignore": true}  — matches anything; not recorded.
// Any plain object must match the actual value's key set EXACTLY (no extra,
// no missing) — every other key is matched recursively. Arrays must match
// length and every element, in order. Everything else is compared with ===.
// ---------------------------------------------------------------------------

export function typeMatches(actual, typeStr) {
  switch (typeStr) {
    case 'integer': return typeof actual === 'number' && Number.isInteger(actual)
    case 'number': return typeof actual === 'number'
    case 'string': return typeof actual === 'string'
    case 'boolean': return typeof actual === 'boolean'
    case 'null': return actual === null
    case 'array': return Array.isArray(actual)
    case 'object': return actual !== null && typeof actual === 'object' && !Array.isArray(actual)
    default: throw new Error(`unknown $type: ${typeStr}`)
  }
}

function isVarNode(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x) &&
    ('$bind' in x || '$ref' in x || '$type' in x || '$ignore' in x)
}

// Plain-value deep-equal, used to check a $ref against its bound value (both
// sides here are real captured JSON, never variable nodes).
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a === 'object') {
    const ak = Object.keys(a).sort()
    const bk = Object.keys(b).sort()
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false
    return ak.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

export function match(expected, actual, bindings, at = '$') {
  if (isVarNode(expected)) {
    if ('$ignore' in expected) return { ok: true }
    if ('$bind' in expected) { bindings[expected.$bind] = actual; return { ok: true } }
    if ('$ref' in expected) {
      const name = expected.$ref
      if (!(name in bindings)) return { ok: false, reason: `${at}: $ref '${name}' is unbound` }
      return deepEqual(bindings[name], actual)
        ? { ok: true }
        : { ok: false, reason: `${at}: expected $ref '${name}' = ${JSON.stringify(bindings[name])}, got ${JSON.stringify(actual)}` }
    }
    if ('$type' in expected) {
      return typeMatches(actual, expected.$type)
        ? { ok: true }
        : { ok: false, reason: `${at}: expected $type '${expected.$type}', got ${JSON.stringify(actual)}` }
    }
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return { ok: false, reason: `${at}: expected an array, got ${JSON.stringify(actual)}` }
    if (expected.length !== actual.length) return { ok: false, reason: `${at}: expected array length ${expected.length}, got ${actual.length}` }
    for (let i = 0; i < expected.length; i++) {
      const r = match(expected[i], actual[i], bindings, `${at}[${i}]`)
      if (!r.ok) return r
    }
    return { ok: true }
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return { ok: false, reason: `${at}: expected an object, got ${JSON.stringify(actual)}` }
    }
    const ek = Object.keys(expected).sort()
    const ak = Object.keys(actual).sort()
    if (ek.length !== ak.length || ek.some((k, i) => k !== ak[i])) {
      return { ok: false, reason: `${at}: key set mismatch — expected [${ek}], got [${ak}]` }
    }
    for (const k of ek) {
      const r = match(expected[k], actual[k], bindings, `${at}.${k}`)
      if (!r.ok) return r
    }
    return { ok: true }
  }
  return expected === actual
    ? { ok: true }
    : { ok: false, reason: `${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` }
}

// The inverse direction: fixture -> outbound wire value. Only $ref is legal
// here (there is nothing to "bind" or "type-check" about a value the fixture
// itself is choosing to send).
export function resolve(template, bindings) {
  if (template !== null && typeof template === 'object' && !Array.isArray(template) && '$ref' in template) {
    const name = template.$ref
    if (!(name in bindings)) throw new Error(`$ref '${name}' is unbound`)
    return bindings[name]
  }
  if (Array.isArray(template)) return template.map((v) => resolve(v, bindings))
  if (template !== null && typeof template === 'object') {
    const out = {}
    for (const k of Object.keys(template)) out[k] = resolve(template[k], bindings)
    return out
  }
  return template
}

// A separate, tiny, string-only templating mechanism for URL paths and
// header values (where a `{"$ref": ...}` object can't be embedded inline in
// a JSON string): `${name}` is replaced with String(bindings[name]).
export function resolveString(s, bindings) {
  return s.replace(/\$\{([^}]+)\}/g, (_, name) => {
    if (!(name in bindings)) throw new Error(`'\${${name}}' is unbound`)
    return String(bindings[name])
  })
}
