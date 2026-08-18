// Bounds a sanitised device name wherever one is handed to a client — the
// `from_name` embedded in a consent card (ws.js) and the names on
// GET /agent-chat/pending (http.js). Lives here, beside the sieve it is
// always applied with, so the two surfaces cannot drift to different caps.
export const PEER_NAME_CAP = 80
export const PEER_BODY_CAP = 2000

// Unicode format controls include zero-width and bidi characters that can hide
// or reorder peer-written text without occupying a visible character.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu

// Flatten peer-written text to one safe line before storing or publishing
// it in the journal's own voice. A remote agent writes from_name/topic/
// justification; a '\n' in any of them is line forgery in the user's chat,
// not cosmetics. Mirror of matron-bridge lib/peer-text.js peerField —
// hand-synced copy, same stance as matron-admin's isValidServerUrl.
export function sanitizePeerText(value, max = PEER_BODY_CAP) {
  if (value == null) return ''
  return String(value)
    .replace(CONTROL_OR_FORMAT, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}
