// An actor performs the steps of one role against a running journal: HTTP
// requests and WebSocket traffic with the fixture matcher applied to every
// expectation. The replay coordinator uses actors for every role the platform
// under test does not play, the Node reference runner is an actor, and the
// stub stdio runner wraps one.
import WebSocket from 'ws'
import { match, resolve, resolveString } from './matcher.js'

export const BASE_CAPABILITIES = ['http', 'ws', 'disconnect', 'reconnect_from_cursor', 'advance_clock']
export const MODEL_CAPABILITIES = ['set_app_state', 'expect_model', 'expect_notification']

// step kind -> capability a runner must declare to perform it
export function capabilityFor(kind) {
  if (kind === 'http') return 'http'
  if (kind.startsWith('ws_') || kind === 'wait') return 'ws'
  if (kind === 'admin_revoke_device') return 'admin'
  return kind
}

class StepFailure extends Error {}

export function createActor({ base, control, mapReceived } = {}) {
  const conns = {}
  let clockMs = 0

  async function openConn(name, hello) {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws')
    const rec = { ws, frames: [], nextIdx: 0, closed: false, closeCode: undefined, maxSeq: 0, hello }
    ws.on('message', (d) => {
      let frame = JSON.parse(d)
      if (mapReceived) frame = mapReceived(frame)
      rec.frames.push(frame)
    })
    ws.on('close', (code) => { rec.closed = true; rec.closeCode = code })
    conns[name] = rec
    await new Promise((res, rej) => {
      ws.on('open', () => res())
      ws.on('error', rej)
    })
    return rec
  }

  async function doHttp(step, bindings, observed) {
    const method = step.method || 'GET'
    const urlPath = resolveString(step.path, bindings)
    const headers = {}
    if (step.token !== undefined) headers.authorization = `Bearer ${resolve(step.token, bindings)}`
    for (const [k, v] of Object.entries(step.headers || {})) headers[k] = resolveString(String(v), bindings)
    let body
    if (step.body_base64 !== undefined) {
      body = Buffer.from(step.body_base64, 'base64')
      if (step.content_type && !headers['content-type']) headers['content-type'] = step.content_type
    } else if (step.body !== undefined) {
      body = JSON.stringify(resolve(step.body, bindings))
      headers['content-type'] = headers['content-type'] || 'application/json'
    }
    const res = await fetch(base + urlPath, { method, headers, body })
    const ct = res.headers.get('content-type') || ''
    let json = null
    let buf = null
    if (ct.includes('application/json')) {
      try { json = await res.json() } catch { json = null }
    } else {
      buf = Buffer.from(await res.arrayBuffer())
    }
    observed.status = res.status
    observed.body = json
    const exp = step.expect || {}
    const stepBindings = { ...bindings }
    if (exp.status !== undefined && res.status !== exp.status) throw new StepFailure(`expected status ${exp.status}, got ${res.status}`)
    if (exp.headers) {
      for (const [k, v] of Object.entries(exp.headers)) {
        const r = match(v, res.headers.get(k), stepBindings, `headers.${k}`)
        if (!r.ok) throw new StepFailure(r.reason)
      }
    }
    if (exp.body !== undefined) {
      const r = match(exp.body, json, stepBindings, 'body')
      if (!r.ok) throw new StepFailure(`${r.reason}\nfull actual body: ${JSON.stringify(json)}`)
    }
    if (exp.body_base64 !== undefined) {
      const expectedBuf = Buffer.from(exp.body_base64, 'base64')
      if (!(buf && buf.equals(expectedBuf))) throw new StepFailure('binary response body did not match expect.body_base64')
    }
    return stepBindings
  }

  async function expectFrame(conn, step, bindings, observed, timeoutMs = 2000) {
    if (!conn) throw new StepFailure('ws_expect: no such connection (ws_open/ws_send it first)')
    const t0 = Date.now()
    while (conn.nextIdx >= conn.frames.length) {
      if (Date.now() - t0 > timeoutMs) {
        throw new StepFailure(`timed out waiting for a frame (received so far: ${JSON.stringify(conn.frames.slice(conn.nextIdx))})`)
      }
      await new Promise((r) => setTimeout(r, 10))
    }
    const actual = conn.frames[conn.nextIdx]
    conn.nextIdx++
    // The cursor a reconnect resumes from: the highest journal seq consumed.
    if (actual && actual.kind === 'journal' && Number.isInteger(actual.seq)) conn.maxSeq = Math.max(conn.maxSeq, actual.seq)
    observed.frame = actual
    const stepBindings = { ...bindings }
    const r = match(step.frame, actual, stepBindings, 'frame')
    if (!r.ok) throw new StepFailure(`${r.reason}\nfull actual frame: ${JSON.stringify(actual)}`)
    return stepBindings
  }

  async function expectNoFrame(conn, step) {
    if (!conn) throw new StepFailure('ws_expect_none: no such connection')
    await new Promise((r) => setTimeout(r, step.ms || 200))
    // A dead socket receives nothing trivially: "no frame arrived" only means
    // something on a connection that is still open.
    if (conn.closed) throw new StepFailure('ws_expect_none: the connection closed during the quiet window, a dead socket must not pass a no-frame assertion')
    if (conn.nextIdx !== conn.frames.length) throw new StepFailure(`expected no new frame, but got: ${JSON.stringify(conn.frames.slice(conn.nextIdx))}`)
  }

  async function expectClose(conn, step, timeoutMs = 2000) {
    if (!conn) throw new StepFailure('ws_expect_close: no such connection')
    const t0 = Date.now()
    while (!conn.closed) {
      if (Date.now() - t0 > timeoutMs) throw new StepFailure('timed out waiting for the connection to close')
      await new Promise((r) => setTimeout(r, 10))
    }
    if (step.code !== undefined && conn.closeCode !== step.code) throw new StepFailure(`expected close code ${step.code}, got ${conn.closeCode}`)
  }

  // Runs one step. Returns { bindings } (the entries the step newly bound) and
  // what was observed, for expectations.
  async function run(step, bindings) {
    const observed = {}
    let out = bindings
    switch (step.kind) {
      case 'http':
        out = await doHttp(step, bindings, observed)
        break
      case 'ws_open':
        await openConn(step.conn, null)
        break
      case 'ws_send': {
        const conn = conns[step.conn]
        if (!conn) throw new StepFailure(`no open connection named '${step.conn}'`)
        const frame = resolve(step.frame, bindings)
        if (frame && frame.op === 'hello') conn.hello = frame
        conn.ws.send(JSON.stringify(frame))
        break
      }
      case 'ws_expect':
        out = await expectFrame(conns[step.conn], step, bindings, observed)
        break
      case 'ws_expect_none':
        await expectNoFrame(conns[step.conn], step)
        break
      case 'ws_expect_close':
        await expectClose(conns[step.conn], step)
        break
      case 'wait':
        await new Promise((r) => setTimeout(r, step.ms))
        break
      case 'admin_revoke_device': {
        if (!control) throw new StepFailure('admin_revoke_device: no control channel to the server')
        await control.revokeDevice(resolve(step.device_id, bindings))
        break
      }
      case 'disconnect': {
        const conn = conns[step.conn]
        if (!conn) throw new StepFailure(`disconnect: no open connection named '${step.conn}'`)
        conn.ws.terminate()
        const t0 = Date.now()
        while (!conn.closed) {
          if (Date.now() - t0 > 2000) throw new StepFailure('disconnect: the socket did not close')
          await new Promise((r) => setTimeout(r, 5))
        }
        break
      }
      case 'reconnect_from_cursor': {
        const prev = conns[step.conn]
        if (!prev || !prev.hello) throw new StepFailure(`reconnect_from_cursor: '${step.conn}' never sent a hello`)
        if (!prev.closed) throw new StepFailure(`reconnect_from_cursor: '${step.conn}' is still connected, disconnect it first`)
        const hello = { ...prev.hello }
        hello.cursor = step.cursor !== undefined
          ? resolve(step.cursor, bindings)
          : (prev.hello.cursor === null && prev.maxSeq === 0 ? null : Math.max(prev.maxSeq, Number.isInteger(prev.hello.cursor) ? prev.hello.cursor : 0))
        const rec = await openConn(step.conn, hello)
        rec.ws.send(JSON.stringify(hello))
        break
      }
      case 'advance_clock':
        clockMs += step.ms
        break
      default:
        throw new StepFailure(`this actor cannot perform step kind '${step.kind}'`)
    }
    // Only the bindings this step recorded: lanes may run side by side and
    // must not overwrite each other's updates with stale copies.
    const added = {}
    for (const [k, v] of Object.entries(out)) if (!(k in bindings) || bindings[k] !== v) added[k] = v
    return { bindings: added, observed }
  }

  async function close() {
    for (const conn of Object.values(conns)) {
      try { conn.ws.close() } catch { /* already closed */ }
    }
  }

  return {
    capabilities: new Set(BASE_CAPABILITIES),
    run,
    close,
    get clockMs() { return clockMs },
  }
}
