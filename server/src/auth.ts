import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, 64)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length)
  return timingSafeEqual(actual, expected)
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Only hashes of session tokens are stored, so a database leak doesn't hand out sessions. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

export const MIN_PASSWORD_LENGTH = 8

/** API keys start with this, so they are easy to spot (and to scan for in leaked text). */
export const API_KEY_PREFIX = 'kbn_'
