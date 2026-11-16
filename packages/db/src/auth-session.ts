import { createHash } from 'node:crypto'

export function hashAuthSessionToken(token: string): string {
  if (!token) throw new Error('Auth session token is required')
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
