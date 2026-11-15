// The coordinator's side of the runner protocol: spawn a platform runner as a
// child process and talk to it in newline-delimited JSON on stdio.
//
//   coordinator -> runner   {"op":"init","protocol":1,"base":"http://127.0.0.1:PORT","client":"mac"|null,"fixture":"name"}
//   runner -> coordinator   {"op":"ready","capabilities":["http","ws",...]}
//   coordinator -> runner   {"op":"step","id":7,"index":12,"step":{...},"bindings":{...}}
//   runner -> coordinator   {"id":7,"ok":true,"bindings":{"new_name":...}}
//                           {"id":7,"ok":false,"error":"..."}
//   coordinator -> runner   {"op":"close"}
//
// A runner implements only its own role's actions and assertions. `step` is
// sent unresolved with a snapshot of the shared bindings; the runner resolves
// $ref, matches expectations, and reports only the bindings the step recorded.
import { spawn } from 'node:child_process'
import readline from 'node:readline'

export async function spawnRunner({ command, args = [], env, base, client = null, fixture = '', protocol = 1, readyTimeoutMs = 10000, stepTimeoutMs = 10000 }) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } })
  const rl = readline.createInterface({ input: child.stdout })
  const pending = new Map()
  let nextId = 1
  let readyResolve
  let readyReject
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej })
  let exited = false
  child.on('exit', (code) => {
    exited = true
    failAll(new Error(`runner exited (code ${code})`))
  })
  const failAll = (err) => {
    readyReject(err)
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err) }
    pending.clear()
  }
  child.on('error', failAll)
  // A runner that dies or never starts closes its stdin; writing to it must
  // fail the run, not crash the coordinator.
  child.stdin.on('error', failAll)
  rl.on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.op === 'ready') return readyResolve(msg)
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve({ bindings: msg.bindings || {}, observed: msg.observed })
    else p.reject(new Error(msg.error || 'runner reported a failure'))
  })
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')
  send({ op: 'init', protocol, base, client, fixture })
  const timer = setTimeout(() => readyReject(new Error('runner did not report ready')), readyTimeoutMs)
  let hello
  try { hello = await ready } catch (e) {
    child.kill()
    rl.close()
    throw e
  } finally { clearTimeout(timer) }
  return {
    capabilities: new Set(hello.capabilities || []),
    run(step, bindings, ctx = {}) {
      if (exited) return Promise.reject(new Error('runner has exited'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        // A runner that drops a step must fail it, not hang every lane behind it.
        const limit = stepTimeoutMs + (step.kind === 'wait' || step.kind === 'ws_expect_none' ? step.ms || 0 : 0)
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`runner did not answer step ${ctx.index} within ${limit} ms`))
        }, limit)
        pending.set(id, { resolve, reject, timer })
        send({ op: 'step', id, index: ctx.index, step, bindings })
      })
    },
    async close() {
      if (!exited) {
        try { send({ op: 'close' }) } catch { /* gone */ }
        await new Promise((res) => {
          const t = setTimeout(() => { child.kill(); res() }, 2000)
          child.once('exit', () => { clearTimeout(t); res() })
        })
      }
    },
  }
}
