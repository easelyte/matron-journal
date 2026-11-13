// Gateway client for self-hosted journals: speaks the push.matron.chat relay
// protocol instead of APNs directly. Exact makeApnsClient contract —
// send(opts) resolves {status, reason} and NEVER rejects; transport failure
// resolves {status: 0, reason: 'transport'}, timeout {status: 0, reason:
// 'timeout'} — so makePushPipeline (and its dead-token prune
// handleResult logic) works against a relay unchanged.
//
// Privacy is structural: only the fields below are ever serialized. The
// payload.aps.alert built by push.js stays in-process and is dropped here —
// a readable title, body, or conversation name has no field it could travel
// in. `box` is the one field with content, and it is sealed to the receiving
// device's key before it gets here (src/push-box.js): the relay cannot read
// it.
//
// A relay that predates `box` answers 400 unknown_field, or 413 too_large
// when the box takes the request past its older, smaller body limit. Either
// way the push is sent again without it, so the notification still arrives
// with the relay's fixed text, and boxes are left off for `boxRetryMs`
// before one is tried again.
export function makeGatewayClient({ url, fetchImpl = fetch, requestTimeoutMs = 30000, boxRetryMs = 60 * 60 * 1000, now = Date.now }) {
  const endpoint = new URL('/push', url).toString()
  let noBoxUntil = 0

  async function send({ deviceToken, env, payload, collapseId, priority, pushType, category }) {
    const aps = (payload && payload.aps) || {}
    const body = {
      device_token: deviceToken,
      env,
      // push.js always sets category (Task 2); the fallback keeps a stale
      // caller safe rather than sending an unclassifiable request.
      category: category || (pushType === 'background' ? 'wake' : 'activity'),
      priority,
      push_type: pushType,
    }
    if (typeof aps.badge === 'number') body.badge = aps.badge
    if (typeof aps['thread-id'] === 'string') body.thread_id = aps['thread-id']
    if (collapseId) body.collapse_id = collapseId
    if (typeof payload?.box === 'string' && now() >= noBoxUntil) body.box = payload.box

    const result = await post(body)
    const refusedBox = (result.status === 400 && result.reason === 'unknown_field') || result.status === 413
    if (body.box === undefined || !refusedBox) return result
    noBoxUntil = now() + boxRetryMs
    console.warn('push: the relay does not take sealed content yet — sending notifications without it')
    delete body.box
    return post(body)
  }

  async function post(body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    timer.unref()
    let res
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch {
      return { status: 0, reason: controller.signal.aborted ? 'timeout' : 'transport' }
    } finally {
      clearTimeout(timer)
    }
    let reason = null
    try {
      const parsed = await res.json()
      if (parsed && typeof parsed.reason === 'string') reason = parsed.reason
    } catch { /* non-JSON body (proxy error page): status alone is enough */ }
    return { status: res.status, reason }
  }

  // Nothing to tear down — fetch owns its connections — but the pipeline
  // calls close() on shutdown, so honor the contract.
  function close() {}

  return { send, close }
}
