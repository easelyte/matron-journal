#!/usr/bin/env node
// A minimal platform runner for the coordinator's stdio protocol (see
// stdio-runner.js). It performs only the steps handed to it, with the shared
// actor code, and exists to prove a runner needs nothing from the server
// process. A real platform runner implements the same messages in its own
// language and drives its own networking and decoding code.
import readline from 'node:readline'
import { createActor } from './actor.js'

let actor = null
const rl = readline.createInterface({ input: process.stdin })
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

rl.on('line', async (line) => {
  const msg = JSON.parse(line)
  if (msg.op === 'init') {
    actor = createActor({ base: msg.base })
    out({ op: 'ready', capabilities: [...actor.capabilities] })
  } else if (msg.op === 'step') {
    try {
      const r = await actor.run(msg.step, msg.bindings)
      out({ id: msg.id, ok: true, bindings: r.bindings })
    } catch (e) {
      out({ id: msg.id, ok: false, error: e.message })
    }
  } else if (msg.op === 'close') {
    await actor.close()
    process.exit(0)
  }
})
