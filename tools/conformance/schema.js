// Loads the conformance JSON Schemas and validates fixtures, payload extracts
// and the message-box key table against them. Used by the schema test and by
// the replay coordinator (which refuses a fixture that fails validation).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const CONFORMANCE_DIR = path.resolve(here, '..', '..', 'test', 'fixtures', 'conformance')
const SCHEMA_DIR = path.join(CONFORMANCE_DIR, 'schema')

let compiled = null
function load() {
  if (compiled) return compiled
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  const read = (n) => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `${n}.schema.json`), 'utf8'))
  compiled = {
    fixture: ajv.compile(read('fixture')),
    payloadExtract: ajv.compile(read('payload-extract')),
    keyTable: ajv.compile(read('key-table')),
  }
  return compiled
}

function formatAjv(errors) {
  return (errors || []).map((e) => `${e.instancePath || '/'} ${e.message}${e.params && e.params.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`)
}

export function validateFixture(fixture) {
  const v = load().fixture
  if (!v(fixture)) return formatAjv(v.errors)
  return semanticErrors(fixture)
}

export function validatePayloadExtract(doc) {
  const v = load().payloadExtract
  return v(doc) ? [] : formatAjv(v.errors)
}

export function validateKeyTable(doc) {
  const v = load().keyTable
  if (!v(doc)) return formatAjv(v.errors)
  const seen = new Set()
  const errs = []
  for (const row of doc.rows) {
    if (seen.has(row.id)) errs.push(`duplicate row id '${row.id}'`)
    seen.add(row.id)
  }
  return errs
}

// Rules JSON Schema cannot express (they span several fields).
function semanticErrors(f) {
  const errs = []
  if (f.since !== undefined && f.since > f.protocol) errs.push(`since (${f.since}) is greater than protocol (${f.protocol})`)
  const seed = f.seed || {}
  const users = new Set((seed.users || []).map((u) => u.as))
  const agents = new Set((seed.agents || []).map((a) => a.as))
  const convos = new Set((seed.conversations || []).map((c) => c.id))
  for (const a of seed.agents || []) if (!users.has(a.user)) errs.push(`seed.agents '${a.as}': unknown user '${a.user}'`)
  for (const c of seed.conversations || []) {
    if (!users.has(c.owner)) errs.push(`seed.conversations '${c.id}': unknown user '${c.owner}'`)
    if (c.agent !== undefined && !agents.has(c.agent)) errs.push(`seed.conversations '${c.id}': unknown agent '${c.agent}'`)
  }
  for (const e of seed.events || []) if (!convos.has(e.convo)) errs.push(`seed.events: unknown conversation '${e.convo}'`)
  // Every connection belongs to exactly one actor (role plus client id), so
  // each actor can run in its own lane and a platform runner owns whole sockets.
  const owner = new Map()
  for (const [i, s] of f.steps.entries()) {
    if (s.conn === undefined) continue
    const who = actorKey(s)
    if (!owner.has(s.conn)) owner.set(s.conn, who)
    else if (owner.get(s.conn) !== who) errs.push(`step[${i}] uses connection '${s.conn}' as ${who}, but it belongs to ${owner.get(s.conn)}`)
  }
  return errs
}

export function actorKey(step) {
  return step.role === 'client' && step.client !== undefined ? `client:${step.client}` : step.role
}
