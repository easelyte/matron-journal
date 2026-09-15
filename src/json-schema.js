// Compile the JSON Schema subset used by the repository's vendored wire
// contracts into a boolean validator. Keeping this schema-driven means strict
// field sets and conditional requirements come from the canonical contract,
// rather than from a second hand-maintained description in the HTTP handler.
export function compileJsonSchema(rootSchema) {
  const compiled = new WeakMap()
  const supportedKeywords = new Set([
    '$schema', '$comment', '$id', 'title', 'description', 'definitions',
    '$ref', 'type', 'const', 'enum', 'required', 'properties',
    'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength',
    'minimum', 'maximum', 'format', 'oneOf', 'allOf', 'not', 'if', 'then', 'else',
  ])

  const resolveRef = (ref) => {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) {
      throw new Error(`unsupported JSON Schema reference: ${ref}`)
    }
    let node = rootSchema
    for (const rawPart of ref.slice(2).split('/')) {
      const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~')
      node = node?.[part]
    }
    if (node === undefined) throw new Error(`unresolved JSON Schema reference: ${ref}`)
    return node
  }

  const typeMatches = (value, type) => {
    switch (type) {
      case 'null': return value === null
      case 'array': return Array.isArray(value)
      case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
      case 'integer': return Number.isInteger(value)
      case 'number': return typeof value === 'number' && Number.isFinite(value)
      case 'string': return typeof value === 'string'
      case 'boolean': return typeof value === 'boolean'
      default: throw new Error(`unsupported JSON Schema type: ${type}`)
    }
  }

  // Draft-07 date-time is RFC 3339. Date.parse alone normalizes impossible
  // dates, so compare the parsed UTC components back to the source as well.
  const isDateTime = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
    if (!match) return false
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) return false
    const [, year, month, day, hour, minute, second] = match
    const parts = [year, month, day, hour, minute, second].map(Number)
    const [y, mo, d, h, mi, s] = parts
    const local = new Date(0)
    local.setUTCFullYear(y, mo - 1, d)
    local.setUTCHours(h, mi, s, 0)
    if (local.getUTCFullYear() !== y || local.getUTCMonth() + 1 !== mo ||
        local.getUTCDate() !== d || local.getUTCHours() !== h ||
        local.getUTCMinutes() !== mi || local.getUTCSeconds() !== s) return false
    if (match[8] !== 'Z') {
      const [offsetHour, offsetMinute] = match[8].slice(1).split(':').map(Number)
      if (offsetHour > 23 || offsetMinute > 59) return false
    }
    return true
  }

  const compile = (schema) => {
    if (schema === true) return () => true
    if (schema === false) return () => false
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new Error('invalid JSON Schema node')
    }
    if (compiled.has(schema)) return compiled.get(schema)
    for (const keyword of Object.keys(schema)) {
      if (!supportedKeywords.has(keyword)) {
        // A future canonical schema must never gain a constraint this small
        // compiler silently ignores. Fail startup until support is explicit.
        throw new Error(`unsupported JSON Schema keyword: ${keyword}`)
      }
    }

    if (schema.$ref !== undefined) {
      let validateTarget
      const validateRef = (value) => validateTarget(value)
      compiled.set(schema, validateRef)
      validateTarget = compile(resolveRef(schema.$ref))
      return validateRef
    }

    const checks = []
    const types = schema.type === undefined
      ? null
      : (Array.isArray(schema.type) ? schema.type : [schema.type])
    if (types) checks.push((value) => types.some((type) => typeMatches(value, type)))
    if (schema.const !== undefined) checks.push((value) => Object.is(value, schema.const))
    if (schema.enum) checks.push((value) => schema.enum.some((candidate) => Object.is(value, candidate)))

    if (schema.required) {
      checks.push((value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
        schema.required.every((name) => Object.hasOwn(value, name)))
    }

    const propertyValidators = schema.properties
      ? Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, compile(child)]))
      : null
    if (propertyValidators) {
      checks.push((value) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return true
        return Object.entries(propertyValidators).every(([name, validate]) =>
          !Object.hasOwn(value, name) || validate(value[name]))
      })
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}))
      checks.push((value) => value === null || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).every((name) => allowed.has(name)))
    }

    if (schema.items !== undefined) {
      const validateItem = compile(schema.items)
      checks.push((value) => !Array.isArray(value) || value.every(validateItem))
    }
    if (schema.minItems !== undefined) checks.push((value) => !Array.isArray(value) || value.length >= schema.minItems)
    if (schema.maxItems !== undefined) checks.push((value) => !Array.isArray(value) || value.length <= schema.maxItems)
    if (schema.minLength !== undefined) checks.push((value) => typeof value !== 'string' || [...value].length >= schema.minLength)
    if (schema.minimum !== undefined) checks.push((value) => typeof value !== 'number' || value >= schema.minimum)
    if (schema.maximum !== undefined) checks.push((value) => typeof value !== 'number' || value <= schema.maximum)
    if (schema.format === 'date-time') checks.push((value) => typeof value !== 'string' || isDateTime(value))
    else if (schema.format !== undefined) throw new Error(`unsupported JSON Schema format: ${schema.format}`)

    if (schema.oneOf) {
      const validators = schema.oneOf.map(compile)
      checks.push((value) => validators.filter((validate) => validate(value)).length === 1)
    }
    if (schema.allOf) {
      const validators = schema.allOf.map(compile)
      checks.push((value) => validators.every((validate) => validate(value)))
    }
    if (schema.not !== undefined) {
      const validateNot = compile(schema.not)
      checks.push((value) => !validateNot(value))
    }
    if (schema.if !== undefined) {
      const validateIf = compile(schema.if)
      const validateThen = schema.then === undefined ? () => true : compile(schema.then)
      const validateElse = schema.else === undefined ? () => true : compile(schema.else)
      checks.push((value) => validateIf(value) ? validateThen(value) : validateElse(value))
    }

    const validate = (value) => checks.every((check) => check(value))
    compiled.set(schema, validate)
    return validate
  }

  return compile(rootSchema)
}
