import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from '../env'

/**
 * AES-256-GCM with APP_ENCRYPTION_KEY. Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 *
 * Key rotation: encryption always uses APP_ENCRYPTION_KEY. Decryption tries APP_ENCRYPTION_KEY
 * first, then each key in APP_ENCRYPTION_KEY_PREVIOUS in order. GCM authenticates, so a wrong key
 * fails cleanly and the next one is tried. `pnpm rotate-secrets` re-encrypts stored values with
 * the current key, after which the previous keys can be removed.
 */
function currentKey(): Buffer {
  const hex = env().APP_ENCRYPTION_KEY
  if (!hex) throw new Error('APP_ENCRYPTION_KEY is not set; cannot encrypt or decrypt connector secrets.')
  return Buffer.from(hex, 'hex')
}

function previousKeys(): Buffer[] {
  return (env().APP_ENCRYPTION_KEY_PREVIOUS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => Buffer.from(k, 'hex'))
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', currentKey(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

function decryptWith(key: Buffer, iv: string, tag: string, ct: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
}

/**
 * Decrypts with the current key or any previous key. `keyIndex` is 0 for the current key and
 * 1.. for APP_ENCRYPTION_KEY_PREVIOUS entries, so callers can tell whether re-encryption is due.
 */
export function decryptSecretDetailed(value: string): { plaintext: string; keyIndex: number } {
  const [v, iv, tag, ct] = value.split('.')
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unsupported ciphertext format')
  const keys = [currentKey(), ...previousKeys()]
  for (let i = 0; i < keys.length; i++) {
    try {
      return { plaintext: decryptWith(keys[i]!, iv, tag, ct), keyIndex: i }
    } catch {
      // Authentication failed with this key; try the next one.
    }
  }
  throw new Error('cannot decrypt secret with APP_ENCRYPTION_KEY or any APP_ENCRYPTION_KEY_PREVIOUS key')
}

export function decryptSecret(value: string): string {
  return decryptSecretDetailed(value).plaintext
}
