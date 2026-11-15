// Inbound sources: an outside tool (a hosted assistant, a cron job, a
// workflow service) that the user lets post reports into Matron.
//
// A source has a name, a key and one conversation of its own. The key can
// post a report and nothing else: it reads nothing, and it is not a device
// token. Each report is one message in the source's conversation.
//
// That conversation is a system conversation (`conversations.system =
// 'inbound:<source id>'`), so every guard the People conversation has
// applies to it: no agent lists it, reads it, writes to it or adopts it,
// and agent searches leave it out. A report is text written by a tool that
// may itself have read text from strangers, so it never starts an agent
// turn. It reaches an agent only when the user replies in the conversation
// (src/inbound-replies.js), quoted as information.
//
// Guards that are not settings:
//   - a size cap, an hourly cap and a daily cap per source;
//   - an identical report within a day is dropped;
//   - text only: images become links, raw HTML is escaped, control and
//     direction-override characters are removed;
//   - the log says which source, how many bytes and the outcome, never the
//     text.
import { createHash, randomBytes } from 'node:crypto'
import { append, broadcastAppended, toEventShape } from './journal.js'
import { sanitizeConsentText, plainText } from './peer-text.js'
import { isPanicLocked } from './panic.js'

export const INBOUND_SYSTEM_PREFIX = 'inbound:'
export const INBOUND_SENDER_PREFIX = 'source:'
export const INBOUND_KEY_PREFIX = 'mis_'
export const SOURCE_NAME_MAX = 40
export const SOURCES_PER_USER_MAX = 20
export const REPORT_TITLE_MAX = 200
export const REPORT_BODY_MAX_BYTES = 64 * 1024
export const REPORT_LINKS_MAX = 10
export const REPORT_LINK_MAX = 2000
export const DEFAULT_HOURLY_MAX = 10
export const DEFAULT_DAILY_MAX = 40
export const CAP_MAX = 1000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const JOURNAL = 'journal'

const sha256 = (s) => createHash('sha256').update(s).digest('hex')
export const hashInboundKey = sha256

// Letters, digits, spaces and . _ - only: the name is a conversation title
// and part of a sender string, and is quoted to agents.
export function cleanSourceName(name) {
  const n = sanitizeConsentText(name, SOURCE_NAME_MAX + 1)
  return n && n.length <= SOURCE_NAME_MAX && /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(n) ? n : null
}

const validCap = (n) => Number.isInteger(n) && n >= 1 && n <= CAP_MAX

export const inboundSystem = (sourceId) => `${INBOUND_SYSTEM_PREFIX}${sourceId}`
export const isInboundSystem = (system) => typeof system === 'string' && system.startsWith(INBOUND_SYSTEM_PREFIX)

// Returns {source, key}. The key is returned once and only its hash kept.
export function createSource(db, userId, name, { hourlyMax = DEFAULT_HOURLY_MAX, dailyMax = DEFAULT_DAILY_MAX, now = Date.now() } = {}) {
  const clean = cleanSourceName(name)
  if (!clean) throw new Error(`bad source name: 1 to ${SOURCE_NAME_MAX} letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit`)
  if (!validCap(hourlyMax) || !validCap(dailyMax)) throw new Error(`caps must be whole numbers from 1 to ${CAP_MAX}`)
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM inbound_sources WHERE user_id=? AND name=? COLLATE NOCASE').get(userId, clean)) throw new Error(`a source named ${clean} already exists`)
    if (db.prepare('SELECT COUNT(*) AS n FROM inbound_sources WHERE user_id=?').get(userId).n >= SOURCES_PER_USER_MAX) throw new Error(`at most ${SOURCES_PER_USER_MAX} sources per user`)
    const id = `src_${randomBytes(8).toString('hex')}`
    const convoId = `inbound_${randomBytes(12).toString('hex')}`
    const key = INBOUND_KEY_PREFIX + randomBytes(32).toString('base64url')
    db.prepare(`INSERT INTO conversations(id, owner_user_id, title, session_state, created_at, system)
      VALUES(?,?,?,'done',?,?)`).run(convoId, userId, clean, now, inboundSystem(id))
    db.prepare(`INSERT INTO inbound_sources(id, user_id, name, token_hash, convo_id, hourly_max, daily_max, created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, userId, clean, sha256(key), convoId, hourlyMax, dailyMax, now)
    return { source: getSource(db, id), key }
  })()
}

export const getSource = (db, id) => db.prepare('SELECT * FROM inbound_sources WHERE id=?').get(id) ?? null
export const listSources = (db, userId) => db.prepare('SELECT * FROM inbound_sources WHERE user_id=? ORDER BY created_at, id').all(userId)
export const anySource = (db) => !!db.prepare('SELECT 1 FROM inbound_sources LIMIT 1').get()

// The enabled source a key belongs to, or null. Looked up by hash, so the
// comparison never runs over the key itself.
export function sourceForKey(db, key) {
  if (typeof key !== 'string' || !key.startsWith(INBOUND_KEY_PREFIX) || key.length > 200) return null
  return db.prepare('SELECT * FROM inbound_sources WHERE token_hash=? AND enabled=1').get(sha256(key)) ?? null
}

export function setSourceEnabled(db, id, enabled) {
  return db.prepare('UPDATE inbound_sources SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id).changes > 0
}

// A new key for the same source; the old one stops working at once.
export function rotateSourceKey(db, id) {
  const key = INBOUND_KEY_PREFIX + randomBytes(32).toString('base64url')
  return db.prepare('UPDATE inbound_sources SET token_hash=? WHERE id=?').run(sha256(key), id).changes > 0 ? key : null
}

export function setSourceCaps(db, id, { hourlyMax, dailyMax }) {
  if (!validCap(hourlyMax) || !validCap(dailyMax)) throw new Error(`caps must be whole numbers from 1 to ${CAP_MAX}`)
  return db.prepare('UPDATE inbound_sources SET hourly_max=?, daily_max=? WHERE id=?').run(hourlyMax, dailyMax, id).changes > 0
}

// --- what a report may contain -------------------------------------------

// Control characters (newline and tab kept) and Unicode format characters
// (ZWNJ/ZWJ kept, as sanitizeConsentText does): no hidden text, no
// direction overrides.
const stripHidden = (s) => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/(?![‌‍])\p{Cf}/gu, '')

// An image becomes a link everywhere, code included: an app must not fetch
// an address because a report named it, and no reading of where code starts
// and ends is safe enough to stake that on (a span may run over lines, a
// fence may sit in a list). Outside code a raw HTML tag is shown as typed.
// Code is read narrowly, so a doubtful stretch is treated as prose: a span
// closes only on a backtick run of the same length on the same line and
// never opens on an escaped backtick, a line that follows an unclosed
// backtick run in the same paragraph is all prose (a renderer may pair
// that run with one further down), and a fence opens only at the start of
// a line.
const dropImages = (s) => s.replace(/!+(?=\[)/g, '')
const escapeTags = (s) => s.replace(/<(?=[A-Za-z/!?])/g, '&lt;')
function defuseLine(line, state) {
  if (!line.trim()) state.open = false
  if (state.open) return escapeTags(line)
  let out = ''
  let prose = 0
  let i = 0
  while (i < line.length) {
    if (line[i] === '\\') { i += 2; continue }
    if (line[i] !== '`') { i++; continue }
    let end = i
    while (line[end] === '`') end++
    const run = end - i
    // The closing run: the next one of exactly this length.
    let close = -1
    for (let j = end; j < line.length;) {
      if (line[j] !== '`') { j++; continue }
      let k = j
      while (line[k] === '`') k++
      if (k - j === run) { close = k; break }
      j = k
    }
    if (close < 0) { state.open = true; i = end; continue }
    out += escapeTags(line.slice(prose, i)) + line.slice(i, close)
    prose = i = close
  }
  return out + escapeTags(line.slice(prose))
}
export function defuseMarkdown(text) {
  const out = []
  let fence = null
  const state = { open: false }
  for (const line of dropImages(text).split('\n')) {
    if (fence) {
      // Closes wherever CommonMark would, and a little more readily.
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      out.push(line)
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null
      continue
    }
    const m = /^(`{3,}(?=[^`]*$)|~{3,})/.exec(line)
    if (m) { fence = m[1]; state.open = false; out.push(line); continue }
    out.push(defuseLine(line, state))
  }
  return out.join('\n')
}

function cleanLink(link) {
  const raw = typeof link === 'string' ? link : link && typeof link === 'object' ? link.url : null
  if (typeof raw !== 'string' || raw.length > REPORT_LINK_MAX) return null
  let u
  try { u = new URL(raw.trim()) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const href = u.href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E')
  const title = plainText(sanitizeConsentText(typeof link === 'object' ? link.title : '', 120))
  return title ? `- [${title}](${href})` : `- <${href}>`
}

// {ok:true, text, bytes} or {ok:false, error:'bad_request'|'too_large', detail}.
export function buildReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'bad_request', detail: 'the report must be a JSON object' }
  const { title, body, links } = input
  if (typeof body !== 'string') return { ok: false, error: 'bad_request', detail: 'body must be a string of markdown' }
  if (title != null && typeof title !== 'string') return { ok: false, error: 'bad_request', detail: 'title must be a string' }
  if (Buffer.byteLength(body, 'utf8') > REPORT_BODY_MAX_BYTES) return { ok: false, error: 'too_large', detail: `body is over ${REPORT_BODY_MAX_BYTES} bytes` }
  const text = defuseMarkdown(stripHidden(body)).trim()
  if (!text) return { ok: false, error: 'bad_request', detail: 'body is empty' }
  const parts = []
  const heading = plainText(sanitizeConsentText(title, REPORT_TITLE_MAX))
  if (heading) parts.push(`**${heading}**`)
  parts.push(text)
  if (links != null) {
    if (!Array.isArray(links) || links.length > REPORT_LINKS_MAX) return { ok: false, error: 'bad_request', detail: `links must be a list of at most ${REPORT_LINKS_MAX}` }
    const lines = links.map(cleanLink)
    if (lines.some((l) => l == null)) return { ok: false, error: 'bad_request', detail: `each link must be an http(s) address of at most ${REPORT_LINK_MAX} characters, or {title, url}` }
    if (lines.length) parts.push(lines.join('\n'))
  }
  const full = parts.join('\n\n')
  return { ok: true, text: full, bytes: Buffer.byteLength(full, 'utf8') }
}

// --- accepting one -------------------------------------------------------

const senderOf = (source) => `${INBOUND_SENDER_PREFIX}${source.name}`

// Appends happen inside the caller's transaction; `fan` collects what to
// broadcast once it has committed.
function say(db, fan, source, sender, type, payload) {
  const r = append(db, { userId: source.user_id, convoId: source.convo_id, sender, type, payload })
  fan.push({ userId: source.user_id, convoId: source.convo_id, seq: r.seq, ts: r.ts, sender, type, payload })
  return r
}

// The conversation is created with the source, by a command that has no
// connected clients to tell. So the first message announces it.
function announceOnce(db, fan, source) {
  if (source.announced) return
  say(db, fan, source, JOURNAL, 'convo_meta', { title: source.name, parent_convo_id: null, system: inboundSystem(source.id) })
  db.prepare('UPDATE inbound_sources SET announced=1 WHERE id=?').run(source.id)
}

// Over a cap: the post is refused, and at most once a day the journal says
// so in the source's conversation, so the user knows reports are missing.
function refuseOverCap(db, fan, source, { windowMs, max, per, now }) {
  const oldest = db.prepare('SELECT MIN(ts) AS ts FROM inbound_posts WHERE source_id=? AND ts>?').get(source.id, now - windowMs).ts
  const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
  if (source.limit_notified_at == null || now - source.limit_notified_at >= DAY) {
    db.prepare('UPDATE inbound_sources SET limit_notified_at=? WHERE id=?').run(now, source.id)
    announceOnce(db, fan, source)
    say(db, fan, source, JOURNAL, 'text', { body: `${source.name} reached its limit of ${max} reports ${per}. Reports over the limit are refused, so some may be missing here.` })
  }
  return { status: 'rate_limited', retryAfter }
}

// ctx: {db, hub?, pushPipeline?}. `source` is a fresh row (sourceForKey).
// Returns {status: 'accepted', seq, bytes} | {status: 'duplicate'} |
// {status: 'rate_limited', retryAfter} | {status: 'bad_request'|'too_large', detail} |
// {status: 'account_locked'}.
export function acceptReport(ctx, source, input, { now = Date.now() } = {}) {
  const { db, hub = null, pushPipeline = null } = ctx
  const keyHash = source.token_hash
  const built = buildReport(input)
  if (!built.ok) return { status: built.error, detail: built.detail }
  // A panic-locked account (src/panic.js) takes nothing new from outside.
  if (isPanicLocked(db, source.user_id)) return { status: 'account_locked' }
  const hash = sha256(built.text)
  const fan = []
  const out = db.transaction(() => {
    // Read again inside the transaction: the caller's row was loaded before
    // the request body arrived, and another post may have announced the
    // conversation, said the limit line, or disabled the source since,
    source = getSource(db, source.id)
    // ...or its key may have been replaced.
    if (!source || !source.enabled || source.token_hash !== keyHash) return { status: 'bad_request', detail: 'the source is no longer enabled, or its key changed' }
    if (db.prepare('SELECT 1 FROM inbound_posts WHERE source_id=? AND body_hash=? AND ts>?').get(source.id, hash, now - DAY)) return { status: 'duplicate' }
    const count = (windowMs) => db.prepare('SELECT COUNT(*) AS n FROM inbound_posts WHERE source_id=? AND ts>?').get(source.id, now - windowMs).n
    if (count(HOUR) >= source.hourly_max) return refuseOverCap(db, fan, source, { windowMs: HOUR, max: source.hourly_max, per: 'an hour', now })
    if (count(DAY) >= source.daily_max) return refuseOverCap(db, fan, source, { windowMs: DAY, max: source.daily_max, per: 'a day', now })
    db.prepare('DELETE FROM inbound_posts WHERE source_id=? AND ts<=?').run(source.id, now - 2 * DAY)
    db.prepare('INSERT INTO inbound_posts(source_id, ts, body_hash, bytes) VALUES(?,?,?,?)').run(source.id, now, hash, built.bytes)
    db.prepare('UPDATE inbound_sources SET last_post_at=? WHERE id=?').run(now, source.id)
    announceOnce(db, fan, source)
    // `from: 'source'` and `source` tell an app this is an outside tool's
    // text, not an agent's and not the user's.
    const r = say(db, fan, source, senderOf(source), 'text', { body: built.text, from: 'source', source: { id: source.id, name: source.name } })
    return { status: 'accepted', seq: r.seq, bytes: built.bytes }
  })()
  for (const f of fan) {
    if (hub) broadcastAppended(db, hub, f)
    // Only the report itself is worth a notification.
    if (out.status === 'accepted' && f.seq === out.seq) {
      try { pushPipeline?.onAppend(f.userId, toEventShape({ seq: f.seq, convo_id: f.convoId, ts: f.ts, sender: f.sender, type: f.type, payload: f.payload }), null) } catch (err) { console.error('inbound: push failed', err) }
    }
  }
  return out
}

// The newest report in a source's conversation before `beforeSeq`, as text.
export function latestReportBefore(db, source, beforeSeq) {
  const row = db.prepare(`SELECT payload FROM events WHERE user_id=? AND convo_id=? AND seq<? AND type='text' AND sender=?
    ORDER BY seq DESC LIMIT 1`).get(source.user_id, source.convo_id, beforeSeq, senderOf(source))
  if (!row) return null
  try { return String(JSON.parse(row.payload)?.body ?? '') || null } catch { return null }
}

export function sourceOfConvo(db, userId, convoId) {
  return db.prepare('SELECT * FROM inbound_sources WHERE user_id=? AND convo_id=?').get(userId, convoId) ?? null
}
