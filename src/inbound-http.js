// The two doors an inbound source (src/inbound.js) posts through. Both take
// the source's own key, `Authorization: Bearer <key>`, and
// both end in the same acceptReport.
//
//   POST /inbound/reports   {title?, body, links?}
//     201 {accepted:true} | 200 {accepted:false, duplicate:true}
//     400 bad_request | 413 too_large | 429 rate_limited (Retry-After)
//     403 account_locked
//
//   POST /inbound/mcp       a Model Context Protocol server (Streamable
//     HTTP, stateless, JSON replies) with one tool, `post_report`, for
//     assistants that connect to tools by address. initialize, ping,
//     tools/list and tools/call are answered; there is nothing to read.
//
// Mounted in http.js AHEAD of the device Bearer auth, like the Alertmanager
// webhook, and with the same rule for wrong keys: each is charged to the
// caller address's unauthenticated budget (/login's), and once that is
// spent every request from the address is 429, a right key included. A
// journal with no source declines both paths, so they answer as any
// unknown path does.
import { json, readBody } from './http-body.js'
import { anySource, sourceForKey, acceptReport, REPORT_BODY_MAX_BYTES, REPORT_TITLE_MAX, REPORT_LINKS_MAX } from './inbound.js'

export const INBOUND_REPORTS_PATH = '/inbound/reports'
export const INBOUND_MCP_PATH = '/inbound/mcp'
// The report's own cap plus room for the title, links and JSON escaping.
export const INBOUND_REQUEST_MAX = 3 * REPORT_BODY_MAX_BYTES
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const TOOL = {
  name: 'post_report',
  title: 'Post a report to Matron',
  description: 'Post one finished report to the user\'s Matron. It appears as a message in this source\'s own conversation. Text only: markdown and links. Post each report once.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: REPORT_TITLE_MAX, description: 'A one-line title.' },
      body: { type: 'string', description: `The report, in markdown. At most ${REPORT_BODY_MAX_BYTES} bytes.` },
      links: { type: 'array', maxItems: REPORT_LINKS_MAX, description: 'Sources, as web addresses.', items: { type: 'string' } },
    },
    required: ['body'],
    additionalProperties: false,
  },
}
const INSTRUCTIONS = 'Use post_report to send a finished report to the user\'s Matron. This server takes reports only; it returns nothing about the user.'

// What the caller is told. Never the text it sent.
function outcomeText(out) {
  if (out.status === 'accepted') return 'Posted.'
  if (out.status === 'duplicate') return 'Already posted: an identical report arrived within the last day. Nothing to do.'
  if (out.status === 'rate_limited') return `Not posted: this source is over its limit. Try again in ${out.retryAfter} seconds, and do not retry before then.`
  if (out.status === 'account_locked') return 'Not posted: the account is locked.'
  return `Not posted: ${out.detail || out.status}.`
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

export function makeInboundHandler({ db, hub = null, pushPipeline = null, rateLimiter = null, log = console.log }) {
  const ctx = { db, hub, pushPipeline }
  const post = (source, input) => {
    const out = acceptReport(ctx, source, input)
    // One line, no content: which source, the outcome, the size.
    log(`inbound: ${source.id} ${out.status}${out.bytes != null ? ` bytes=${out.bytes}` : ''}`)
    return out
  }
  return async (req, res, url, { rejectEarly }) => {
    const mcp = url.pathname === INBOUND_MCP_PATH
    if (!mcp && url.pathname !== INBOUND_REPORTS_PATH) return false
    if (!anySource(db)) return false
    if (req.method !== 'POST') {
      // An MCP client may try GET for a stream this server does not offer.
      res.setHeader('allow', 'POST')
      rejectEarly(req, res, 405, { error: 'method_not_allowed' })
      return true
    }
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown'
    if (rateLimiter?.blocked?.(ip)) { rejectEarly(req, res, 429, { error: 'rate_limited' }); return true }
    const given = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1]
    const source = given ? sourceForKey(db, given.trim()) : null
    if (!source) {
      rateLimiter?.allow(ip)
      res.setHeader('www-authenticate', 'Bearer')
      rejectEarly(req, res, 401, { error: 'unauthenticated' })
      return true
    }
    // readBody's 400 (not JSON / not an object) and 413 (over the cap)
    // propagate to http.js's outer catch like every other route's.
    const body = await readBody(req, { maxBytes: INBOUND_REQUEST_MAX })
    if (!mcp) {
      const out = post(source, body)
      if (out.status === 'accepted') json(res, 201, { accepted: true })
      else if (out.status === 'duplicate') json(res, 200, { accepted: false, duplicate: true })
      else if (out.status === 'rate_limited') { res.setHeader('retry-after', String(out.retryAfter)); json(res, 429, { error: 'rate_limited', retry_after: out.retryAfter }) }
      else if (out.status === 'too_large') json(res, 413, { error: 'too_large', detail: out.detail })
      else if (out.status === 'account_locked') json(res, 403, { error: 'account_locked' })
      else json(res, 400, { error: 'bad_request', detail: out.detail })
      return true
    }
    // --- MCP: one JSON-RPC message per POST ---
    const { id, method, params } = body
    if (body.jsonrpc !== '2.0' || typeof method !== 'string') {
      // A response or anything else a client sends that needs no answer.
      if (body.jsonrpc === '2.0' && method === undefined) { res.writeHead(202); res.end(); return true }
      json(res, 400, rpcError(id, -32600, 'Invalid Request'))
      return true
    }
    if (id === undefined) { res.writeHead(202); res.end(); return true } // a notification
    if (method === 'initialize') {
      const asked = params?.protocolVersion
      json(res, 200, rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'matron-inbound', title: 'Matron', version: '1' },
        instructions: INSTRUCTIONS,
      }))
    } else if (method === 'ping') {
      json(res, 200, rpcResult(id, {}))
    } else if (method === 'tools/list') {
      json(res, 200, rpcResult(id, { tools: [TOOL] }))
    } else if (method === 'tools/call') {
      if (params?.name !== TOOL.name) { json(res, 200, rpcError(id, -32602, `Unknown tool: ${String(params?.name).slice(0, 80)}`)); return true }
      const out = post(source, params.arguments)
      json(res, 200, rpcResult(id, { content: [{ type: 'text', text: outcomeText(out) }], isError: out.status !== 'accepted' && out.status !== 'duplicate' }))
    } else {
      json(res, 200, rpcError(id, -32601, 'Method not found'))
    }
    return true
  }
}
