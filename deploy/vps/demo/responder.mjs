// Live-agent responder for the demo journal: keeps mac-studio and homelab
// registered as CONNECTED agents, answers recent_folders RPCs so the New
// Chat flow renders, refreshes the hero convo's status frame (with reset
// times), and flips the sub-chat child to running so the strip shows.
//
// Env: MATRON_DEMO_WS (default ws://127.0.0.1:9810/ws),
//      MATRON_DEMO_AGENT_TOKEN (mac-studio), MATRON_DEMO_AGENT2_TOKEN (homelab).
import WebSocket from 'ws'

const WS_URL = process.env.MATRON_DEMO_WS || 'ws://127.0.0.1:9810/ws'
const AGENTS = {
  'mac-studio': {
    token: process.env.MATRON_DEMO_AGENT_TOKEN,
    folders: [
      { path: '~/dev/matron', last_used: Date.now() - 10 * 60 * 1000 },
      { path: '~/dev/api-server', last_used: Date.now() - 3 * 3600 * 1000 },
      { path: '~/dev/website', last_used: Date.now() - 26 * 3600 * 1000 },
      { path: '~/dev/infra', last_used: Date.now() - 4 * 86400 * 1000 },
    ],
  },
  homelab: {
    token: process.env.MATRON_DEMO_AGENT2_TOKEN,
    folders: [
      { path: '~/services/media-stack', last_used: Date.now() - 2 * 86400 * 1000 },
      { path: '~/services/backup', last_used: null },
    ],
  },
}
for (const [name, cfg] of Object.entries(AGENTS)) {
  if (!cfg.token) { console.error(`responder: missing token for ${name}`); process.exit(1) }
}

function run(name, { token, folders }) {
  const ws = new WebSocket(WS_URL)
  ws.on('open', () => ws.send(JSON.stringify({ op: 'hello', token, cursor: null })))
  ws.on('close', () => setTimeout(() => run(name, { token, folders }), 1000))
  ws.on('error', (e) => console.error(name, 'ws error', e.message))
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString())
    if (f.kind === 'control' && f.op === 'hello_ok') {
      console.log(name, 'connected')
      if (name === 'mac-studio') {
        // Sub-chat strip needs a RUNNING child.
        ws.send(JSON.stringify({ op: 'convo_upsert', convo_id: 'demo-refactor-auth:sub:explore-1', title: 'Explore: auth call sites', session_state: 'running', parent_convo_id: 'demo-refactor-auth' }))
        // Refresh the hero status frame with reset times on the bars.
        ws.send(JSON.stringify({ op: 'status', convo_id: 'demo-flaky-upload', status: {
          model: 'claude-fable-5',
          context: { tokens: 96500, window: 200000, pct: 48 },
          limits: [
            { label: 'Session', percent: 31, resets: '2h 40m' },
            { label: 'Week', percent: 62, resets: 'Thu 09:00' },
          ],
        } }))
      }
      return
    }
    if (f.kind === 'rpc' && f.request) {
      const { request_id, from_device_id, method } = f.request
      const ok = method === 'recent_folders'
      const reply = ok
        ? { op: 'agent_response', request_id, to_device_id: from_device_id, ok: true, result: { folders } }
        : { op: 'agent_response', request_id, to_device_id: from_device_id, ok: false, error: { code: 'unknown_method' } }
      ws.send(JSON.stringify(reply))
      console.log(name, 'answered', method)
    }
  })
}

for (const [name, cfg] of Object.entries(AGENTS)) run(name, cfg)
