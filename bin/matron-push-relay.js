#!/usr/bin/env node
import { makeApnsClient } from '../src/apns.js'
import { startRelay } from '../src/relay.js'

// The relay is useless without the APNs key — unlike the journal (where push
// is an optional feature that degrades to a warn log), missing config here
// is a hard startup error.
const { MATRON_APNS_KEY_FILE, MATRON_APNS_KEY_ID, MATRON_APNS_TEAM_ID, MATRON_APNS_TOPIC } = process.env
if (!(MATRON_APNS_KEY_FILE && MATRON_APNS_KEY_ID && MATRON_APNS_TEAM_ID && MATRON_APNS_TOPIC)) {
  console.error('matron-push-relay: MATRON_APNS_KEY_FILE, MATRON_APNS_KEY_ID, MATRON_APNS_TEAM_ID and MATRON_APNS_TOPIC must all be set')
  process.exit(1)
}

const apnsClient = makeApnsClient({
  keyFile: MATRON_APNS_KEY_FILE, keyId: MATRON_APNS_KEY_ID,
  teamId: MATRON_APNS_TEAM_ID, topic: MATRON_APNS_TOPIC,
})

const port = Number(process.env.MATRON_RELAY_PORT || 9821)
const bind = process.env.MATRON_RELAY_BIND || '127.0.0.1'
const relay = await startRelay({ apnsClient, port, bind })
console.log(`matron-push-relay listening on ${bind}:${relay.port}`)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { relay.close(); process.exit(0) })
}
