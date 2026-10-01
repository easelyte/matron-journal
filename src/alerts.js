// Alertmanager webhook payload -> the plain-text turn the user's Coordinator
// receives (src/alerts-http.js owns the route and the delivery). Pure: no DB,
// no I/O, so the whole shape is unit-tested in test/alerts.test.js.
//
// Everything in the payload is untrusted peer text as far as the journal is
// concerned — label values come from whatever exporter Prometheus scraped,
// and anyone holding the webhook token can write any of it. Every field is
// sieved through sanitizePeerText on its own, so a '\n' inside a label can
// never forge a line of the message (the same stance as a room's from_name),
// and every field has its own cap so one huge annotation cannot crowd out
// the rest of the alerts.
import { sanitizePeerText } from './peer-text.js'

// The bridge's session_control message cap (SESSION_CONTROL_MESSAGE_MAX):
// the alert rides the same RPC, so it obeys the same bound.
export const ALERT_MESSAGE_MAX = 2000
export const ALERT_LINE_MAX = 300
export const ALERT_LINES_MAX = 10
const NAME_CAP = 120
const FIELD_CAP = 200
const TEXT_CAP = ALERT_LINE_MAX

export const DISK_ALERT_RE = /Disk|Zpool/
export const DISK_HINT = "Check the box's disk (agent_boxes). Below 20% free, start a safe clean-up session per the standing rule."

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const field = (v, max = FIELD_CAP) => (typeof v === 'string' || typeof v === 'number' ? sanitizePeerText(v, max) : '')
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

// The shape check the route applies before anything else: Alertmanager's
// webhook v4 always carries an `alerts` array (never empty — a group with
// nothing in it is not sent).
export function isAlertmanagerPayload(body) {
  return !!body && typeof body === 'object' && !Array.isArray(body) && Array.isArray(body.alerts) && body.alerts.length > 0
}

// The group's alertname: the grouping label when the route groups by it,
// else the common label, else the distinct names of the alerts themselves.
export function alertName(payload) {
  const named = field(obj(payload.groupLabels).alertname, NAME_CAP) || field(obj(payload.commonLabels).alertname, NAME_CAP)
  if (named) return named
  const names = [...new Set(payload.alerts.map((a) => field(obj(obj(a).labels).alertname, NAME_CAP)).filter(Boolean))]
  if (!names.length) return 'alert'
  return names.length > 3 ? `${names.slice(0, 3).join(', ')}, …` : names.join(', ')
}

// Where an alert is: the guest (dev box) name when the exporter labels one,
// else the scrape instance; then the mountpoint; then the host, when it
// says something the first part did not.
export function alertWhere(labels) {
  const l = obj(labels)
  const base = field(l.guest) || field(l.instance)
  const parts = [base, field(l.mountpoint)].filter(Boolean)
  const host = field(l.hostname)
  if (host && host !== base) parts.push(`on ${host}`)
  return parts.join(' ') || '?'
}

function alertLine(a) {
  const alert = obj(a)
  const annotations = obj(alert.annotations)
  const status = field(alert.status, 20) || 'unknown'
  const what = field(annotations.summary, TEXT_CAP) || field(annotations.description, TEXT_CAP) || field(obj(alert.labels).alertname, NAME_CAP)
  return clip(`- ${status} ${alertWhere(alert.labels)}${what ? `: ${what}` : ''}`, ALERT_LINE_MAX)
}

// The message. Header, up to ALERT_LINES_MAX alert lines, `+N more` when
// any were dropped, and — for a firing disk alert — the standing instruction
// the Coordinator acts on. Lines are dropped (and counted into `+N more`)
// rather than the message cut mid-line if the 2000-char budget runs out;
// the header and the hint always survive.
export function formatAlertMessage(payload) {
  const status = field(payload.status, 20).toLowerCase()
  const alerts = payload.alerts
  const name = alertName(payload)
  const severity = field(obj(payload.commonLabels).severity, 40)
  const n = alerts.length
  const header = clip(`🔔 Alertmanager: ${(status || 'unknown').toUpperCase()} ${name}${severity ? ` [${severity}]` : ''} (${n} alert${n === 1 ? '' : 's'})`, ALERT_LINE_MAX)
  const disk = status === 'firing' && (DISK_ALERT_RE.test(name) ||
    alerts.some((a) => DISK_ALERT_RE.test(field(obj(obj(a).labels).alertname, NAME_CAP))))
  const footer = disk ? [DISK_HINT] : []
  // Room for "+N more" is reserved up front so adding it can never push
  // the message over the cap.
  const moreReserve = `+${n} more`.length + 1
  let budget = ALERT_MESSAGE_MAX - header.length - footer.reduce((s, l) => s + l.length + 1, 0) - moreReserve
  const lines = []
  for (const a of alerts.slice(0, ALERT_LINES_MAX)) {
    const line = alertLine(a)
    if (line.length + 1 > budget) break
    budget -= line.length + 1
    lines.push(line)
  }
  const more = n - lines.length
  return [header, ...lines, ...(more > 0 ? [`+${more} more`] : []), ...footer].join('\n')
}
