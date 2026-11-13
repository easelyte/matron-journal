// A fixed recipient key pair for sealed-content tests. Not a secret: it is a
// fixture, derived from a public string, and guards nothing.
import crypto from 'node:crypto'

const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')

export function keyPairFrom(seed) {
  const privateKey = crypto.createHash('sha256').update(seed).digest()
  const object = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, privateKey]), format: 'der', type: 'pkcs8' })
  const publicKey = Buffer.from(crypto.createPublicKey(object).export({ format: 'jwk' }).x, 'base64url')
  return { privateKey, publicKey, key: publicKey.toString('base64url') }
}

export const RECIPIENT = keyPairFrom('fixture recipient')
export const EPHEMERAL = keyPairFrom('fixture ephemeral')
