// Bounds a sanitised device name wherever one is handed to a client — the
// `from_name` embedded in a consent card (ws.js) and the names on
// GET /agent-chat/pending (http.js). Lives here, beside the sieve it is
// always applied with, so the two surfaces cannot drift to different caps.
export const PEER_NAME_CAP = 80

// Flatten peer-written text to one safe line before storing or publishing
// it in the journal's own voice. A remote agent writes from_name/topic/
// justification; a '\n' in any of them is line forgery in the user's chat,
// not cosmetics. Mirror of matron-bridge lib/peer-text.js peerField —
// hand-synced copy, same stance as matron-admin's isValidServerUrl.
export function sanitizePeerText(value, max) {
  if (value == null) return ''
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}
// For text shown on a consent card (an agent-room invite/join justification).
// sanitizePeerText leaves Unicode format characters alone, so a justification
// of only zero-width spaces passes the empty check and renders as a blank
// card, and a bidi override can reorder the text around it. Strip \p{Cf}
// first, keeping U+200C/U+200D (ZWNJ, ZWJ): emoji such as a ZWJ sequence need
// the joiner. \p{Cf} also covers the emoji tag characters (U+E0020-E007F), so
// a subdivision flag such as the England flag is reduced to a plain black
// flag; acceptable for card text.
// Kept separate so the other callers of sanitizePeerText are unchanged.
export function sanitizeConsentText(value, max) {
  if (value == null) return ''
  return sanitizePeerText(String(value).replace(/(?![\u200c\u200d])\p{Cf}/gu, ''), max)
}
// Peer text placed inside markdown the journal writes in its own voice (a
// consent item's body): the characters that would bold, link, image-load or
// close a code span from inside the sentence around it are dropped.
export const plainText = (s) => String(s ?? '').replace(/[*_`~[\]()<>!#|\\"]/g, '')
