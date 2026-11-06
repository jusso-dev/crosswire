import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from '../env'

/** AES-256-GCM with APP_ENCRYPTION_KEY. Format: v1.<iv>.<tag>.<ciphertext> (base64url). */
function key(): Buffer {
  const hex = env().APP_ENCRYPTION_KEY
  if (!hex) throw new Error('APP_ENCRYPTION_KEY is not set; cannot encrypt or decrypt connector secrets.')
  return Buffer.from(hex, 'hex')
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

export function decryptSecret(value: string): string {
  const [v, iv, tag, ct] = value.split('.')
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unsupported ciphertext format')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
}
