// The "People" system conversation (spec 2026-10-02 matron-to-matron
// sharing, phase 1). A user's log is theirs alone and every event needs a
// conversation, but a contact request from another person arrives with no
// conversation in common. So each user gets ONE conversation the journal
// itself owns: the home of cards that come from other people, of those
// cards' tracker mirrors, and of the contact/grant audit events.
//
// It has no agent, and no agent may read, write or adopt it. The guards
// live where each path is decided — upsertConversation and agentTargetsFor
// (journal.js), authorizeAgentWrite (auth.js), /snapshot and /roster
// (http.js) — and each of them checks the row's `system` column itself.
// Recognised by that marker, never by id, so an agent upserting a guessable
// id first gains nothing.
import { randomBytes } from 'node:crypto'

export const PEOPLE_SYSTEM = 'people'
export const PEOPLE_TITLE = 'People'

export function peopleConvoId(db, userId) {
  return db.prepare('SELECT id FROM conversations WHERE owner_user_id=? AND system=?').get(userId, PEOPLE_SYSTEM)?.id ?? null
}

// Returns {id, created}. `created` tells the caller to announce the new
// conversation (a convo_meta event) so a connected client lists it before
// the first card lands. session_state 'done': there is no session to wait on.
export function ensurePeopleConvo(db, userId, now = Date.now()) {
  return db.transaction(() => {
    const existing = peopleConvoId(db, userId)
    if (existing) return { id: existing, created: false }
    const id = `people_${randomBytes(12).toString('hex')}`
    db.prepare(`INSERT INTO conversations(id, owner_user_id, title, session_state, created_at, system)
      VALUES(?,?,?,'done',?,?)`).run(id, userId, PEOPLE_TITLE, now, PEOPLE_SYSTEM)
    return { id, created: true }
  })()
}
