import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http2 from 'node:http2'

// Never reads a real .p8: generates a throwaway EC P-256 key pair and writes
// it out as PKCS8 PEM, the same shape as Apple's .p8 file.
export function makeTestKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-apns-key-'))
  const keyFile = path.join(dir, 'AuthKey_TEST123.p8')
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  return { keyFile, publicKey }
}

// Plain (non-TLS) HTTP/2 "prior knowledge" server standing in for Apple —
// no network, no real APNs. `respond(ctx)` decides the response per request;
// every received request is pushed onto `requests` for assertions.
export function makeFakeApnsServer(respond) {
  const requests = []
  const server = http2.createServer()
  server.on('stream', (stream, headers) => {
    let body = ''
    stream.on('data', (c) => { body += c })
    stream.on('end', () => {
      const ctx = { headers, payload: body ? JSON.parse(body) : null }
      requests.push(ctx)
      const { status, reasonBody } = respond(ctx)
      stream.respond({ ':status': status })
      stream.end(reasonBody ? JSON.stringify(reasonBody) : '')
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }))
  })
}
