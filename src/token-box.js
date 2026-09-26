// Encryption at rest for stored GitHub tokens (spec 2026-09-23 tracker
// web/teams, "Token at rest" follow-up). AES-256-GCM under a journal-side
// key from MATRON_TOKEN_KEY (64 hex chars). Sealed values carry an `enc1:`
// prefix so a row written before the key existed still reads through
// `open`, and a box without a key refuses to hand back a sealed value
// rather than treating ciphertext as a token. Equality guards elsewhere
// use tokenHash, never the sealed text (a fresh IV makes every seal
// distinct).
import crypto from 'node:crypto'

const PREFIX = 'enc1:'
const IV_LEN = 12
const TAG_LEN = 16

export const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX)
export const tokenHash = (plain) => crypto.createHash('sha256').update(String(plain)).digest('hex')

export function makeTokenBox(keyHex) {
  if (keyHex == null || keyHex === '') {
    return {
      enabled: false,
      seal: (plain) => plain,
      open: (stored) => { if (isSealed(stored)) throw new Error('token_sealed'); return stored },
    }
  }
  if (typeof keyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error('MATRON_TOKEN_KEY must be 64 hex characters (32 bytes)')
  const key = Buffer.from(keyHex, 'hex')
  return {
    enabled: true,
    seal(plain) {
      const iv = crypto.randomBytes(IV_LEN)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
    },
    open(stored) {
      if (!isSealed(stored)) return stored
      try {
        const buf = Buffer.from(stored.slice(PREFIX.length), 'base64')
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_LEN), { authTagLength: TAG_LEN })
        decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN))
        return Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8')
      } catch {
        throw new Error('token_unreadable')
      }
    },
  }
}

export const PLAIN_BOX = makeTokenBox(null)
