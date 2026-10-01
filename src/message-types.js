// The event types that are conversation CONTENT — what bumps unread and the
// snippet, and what counts as "activity" for last_ts (/snapshot, /roster)
// and a mission's last_activity_at (missions.js). Its own module so
// missions.js can use it without importing journal.js (which imports
// missions.js).
export const MESSAGE_TYPES = [
  'text', 'peer_message', 'tool_output', 'diff', 'prompt', 'permission_request', 'file', 'image', 'spawn_outcome',
]

// SQL literal of MESSAGE_TYPES for correlated last-message subqueries
// (snapshot in journal.js, roster in http.js, mission activity in
// missions.js). Safe to inline — a compile-time constant of bare
// identifiers, and a placeholder spread inside a correlated subquery would
// force every caller to append the same arguments.
export const MESSAGE_TYPES_SQL = MESSAGE_TYPES.map((t) => `'${t}'`).join(',')
