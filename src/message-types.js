// The event types that are conversation CONTENT — what bumps unread and the
// snippet, and what counts as "activity" for last_ts (/snapshot, /roster)
// and a mission's last_activity_at (missions.js). Its own module so
// missions.js can use it without importing journal.js (which imports
// missions.js).
export const MESSAGE_TYPES = [
  'text', 'tool_output', 'diff', 'prompt', 'permission_request', 'file', 'image', 'spawn_outcome',
]

// A silent event is content the user can read in the chat but is never told
// about: `silent: true` on the payload of any message type. It sends no
// push, never counts as unread and is never listed as unseen. For a card
// that only records something, such as the reminder an agent set itself.
// Strictly `true`, so a client that sends something else changes nothing.
export const isSilentEvent = (payload) =>
  !!payload && typeof payload === 'object' && payload.silent === true

// The same test in SQL, for an events row aliased `alias` (or unaliased).
// json_type, not json_extract: that reads both `true` and `1` as 1.
export const notSilentSql = (alias = '') =>
  `json_type(${alias ? alias + '.' : ''}payload, '$.silent') IS NOT 'true'`

// SQL literal of MESSAGE_TYPES for correlated last-message subqueries
// (snapshot in journal.js, roster in http.js, mission activity in
// missions.js). Safe to inline — a compile-time constant of bare
// identifiers, and a placeholder spread inside a correlated subquery would
// force every caller to append the same arguments.
export const MESSAGE_TYPES_SQL = MESSAGE_TYPES.map((t) => `'${t}'`).join(',')
