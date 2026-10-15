// Shared seed fixture for the unified-search test suite (spec 2026-10-12
// unified search). Not a *.test.js file on purpose: importing a test file
// would re-run its tests.
import { openDb } from '../src/db.js'
import { upsertConversation } from '../src/journal.js'

// One user (alice), one agent device (box-a) and one conversation (c1),
// ready for createMission/createItem/upsertMemory calls.
export function seed() {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'alice','x',0)").run()
  db.prepare("INSERT INTO devices(id, user_id, kind, name, token_hash, created_at) VALUES(1,1,'agent','box-a','h',0)").run()
  upsertConversation(db, { id: 'c1', ownerUserId: 1, title: 'chat', agentDeviceId: 1 })
  return db
}
