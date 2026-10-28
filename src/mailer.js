// Outgoing email, for the forgot-password link (src/password-reset.js).
// One provider today: Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email),
// a single HTTPS POST, so no SDK. Off unless a key, a From address and the
// journal's public URL are all set; the reset routes then say so and the
// apps hide "Forgot password?".
import fs from 'node:fs'

const RESEND_URL = 'https://api.resend.com/emails'

export function resolveResendKey(env = process.env) {
  if (env.MATRON_RESEND_API_KEY) return env.MATRON_RESEND_API_KEY.trim()
  if (env.MATRON_RESEND_API_KEY_FILE) return fs.readFileSync(env.MATRON_RESEND_API_KEY_FILE, 'utf8').trim()
  return ''
}

// send({to, subject, text, html}) resolves on a 2xx and throws otherwise.
// The error carries the status only, never the key or the message body.
export function makeResendMailer({ apiKey, from, fetchImpl = fetch, timeoutMs = 10000 }) {
  return {
    async send({ to, subject, text, html }) {
      const r = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!r.ok) throw new Error(`resend: HTTP ${r.status}`)
    },
  }
}

// The configured mailer, or null (feature off). MATRON_PUBLIC_URL must be
// set explicitly: building the link from the request's Host header would
// let anyone have the journal mail a link to their own site.
export function makeConfiguredMailer({ env = process.env, log = console, fetchImpl } = {}) {
  let apiKey = ''
  try { apiKey = resolveResendKey(env) } catch (err) {
    log.error(`mail: MATRON_RESEND_API_KEY_FILE is set but unreadable (${err.code ?? err.message}) — password reset by email is off`)
    return null
  }
  const from = (env.MATRON_MAIL_FROM || '').trim()
  const publicUrl = parsePublicUrl(env.MATRON_PUBLIC_URL)
  if (!apiKey && !from) return null
  if (!apiKey || !from || !publicUrl) {
    log.error('mail: password reset by email needs MATRON_RESEND_API_KEY (or _FILE), MATRON_MAIL_FROM and an https MATRON_PUBLIC_URL — it is off')
    return null
  }
  log.log(`mail: password reset by email is on, from ${from}`)
  return { ...makeResendMailer({ apiKey, from, ...(fetchImpl ? { fetchImpl } : {}) }), publicUrl }
}

// The journal's own origin as users reach it, e.g. https://journal.example.com.
// https only (http allowed for localhost, for development); no path.
export function parsePublicUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let u
  try { u = new URL(raw.trim()) } catch { return null }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null
  return u.origin
}
