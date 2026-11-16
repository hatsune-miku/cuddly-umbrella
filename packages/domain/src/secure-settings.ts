import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export interface EncryptedValue {
  version: 1
  iv: string
  tag: string
  ciphertext: string
}

function encryptionKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

export function encryptSetting(value: string, secret: string): EncryptedValue {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

export function decryptSetting(value: EncryptedValue, secret: string): string {
  if (value.version !== 1) throw new Error('Unsupported encrypted setting version')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(secret),
    Buffer.from(value.iv, 'base64')
  )
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
