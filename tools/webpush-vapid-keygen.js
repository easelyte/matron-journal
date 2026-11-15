#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'

const output = process.argv[2]
if (!output || process.argv.length !== 3) {
  console.error('Usage: node tools/webpush-vapid-keygen.js <out.pem>')
  process.exitCode = 1
} else {
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    fs.writeFileSync(output, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 })
    const jwk = publicKey.export({ format: 'jwk' })
    console.log(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'))
  } catch {
    console.error('Could not create VAPID key file (the destination must not exist)')
    process.exitCode = 1
  }
}
