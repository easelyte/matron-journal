import { MESSAGE_TYPES } from './message-types.js'

// The marker types by name rather than imported from their modules: hub.js
// and journal.js read this file, and most of those modules import journal.js.
// test/sync-scope.test.js checks the names still match.
const ITEM = 'item'
const MISSION = 'mission'
const MILESTONE = 'milestone'
const COORDINATOR = 'coordinator'
const MEMORY = 'memory'
const ROUTINE = 'routine'

// A client's sync scope: how much of the journal its socket carries.
//
// 'everything' (the default, and what a client that sends nothing gets) is
// every event of every conversation, live and on replay. 'for_you' is for a
// phone that only follows the tracker: it gets the tracker, mission and
// Coordinator events, conversation metadata (titles, session state), every
// event of the Coordinator conversation, and every event of a conversation
// it is viewing. Everything else stays on the server, and the app fetches a
// conversation's history over HTTP when it opens one.
//
// The scope is the connection's (named in `hello`) and is also kept on the
// device row, so the push pipeline can stop waking a for_you phone for
// events its socket would not carry anyway.
export const SYNC_SCOPES = ['everything', 'for_you']

// Events a for_you socket carries from every conversation. Markers drive the
// tracker, mission and Coordinator screens; convo_meta and session_status keep
// the conversation list's titles and session dots current. All are small and
// rare next to conversation content.
export const FOR_YOU_EVENT_TYPES = [
  ITEM, MISSION, MILESTONE, COORDINATOR, MEMORY, ROUTINE, 'convo_meta', 'session_status',
]
const FOR_YOU_TYPE_SET = new Set(FOR_YOU_EVENT_TYPES)
export const FOR_YOU_TYPES_SQL = FOR_YOU_EVENT_TYPES.map((t) => `'${t}'`).join(',')

// Events worth a silent background wake to a for_you phone: what changes the
// For you list and the mission pages, and the Coordinator's messages.
// convo_meta and session_status are carried but not worth a wake.
const FOR_YOU_WAKE_TYPES = new Set([ITEM, MISSION, MILESTONE])
const MESSAGE_TYPE_SET = new Set(MESSAGE_TYPES)

// `hello.sync`: absent or null = 'everything'. Returns the stored form (null
// for everything, so device rows that predate the column read the same), or
// undefined for a value no client should send.
export function parseSyncScope(value) {
  if (value === undefined || value === null || value === 'everything') return null
  if (value === 'for_you') return 'for_you'
  return undefined
}

// Whether a connection's scope carries this event. `conn.syncScope` null =
// everything; `conn.coordinatorConvoId` is kept current by noteCoordinator.
export function scopeCarries(conn, event) {
  if (conn.syncScope !== 'for_you') return true
  if (FOR_YOU_TYPE_SET.has(event.type)) return true
  if (event.convo_id != null && event.convo_id === conn.coordinatorConvoId) return true
  return conn.viewingConvoIds?.has(event.convo_id) === true
}

// A `coordinator` frame moves the Coordinator role: `assigned` lands in the
// new Coordinator conversation and `released` in the old one. A for_you
// connection follows it so the new Coordinator conversation's events reach it.
export function noteCoordinator(conn, event) {
  if (event.type !== COORDINATOR) return
  const role = event.payload?.role
  if (role === 'assigned') conn.coordinatorConvoId = event.convo_id
  else if (role === 'released' && conn.coordinatorConvoId === event.convo_id) conn.coordinatorConvoId = null
}

// Whether a for_you device is woken for this event.
export function wakesForYou(event, coordinatorConvoId) {
  if (FOR_YOU_WAKE_TYPES.has(event.type)) return true
  return event.convo_id != null && event.convo_id === coordinatorConvoId && MESSAGE_TYPE_SET.has(event.type)
}
