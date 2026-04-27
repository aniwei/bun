import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === 'string' ? new TextEncoder().encode(input) : input
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

export class CryptoHasher {
  private readonly hasher

  constructor(algorithm: 'sha256' | 'sha512' | 'md5' = 'sha256') {
    this.hasher = createHash(algorithm)
  }

  update(input: string | Uint8Array): this {
    this.hasher.update(toBytes(input))
    return this
  }

  digest(encoding: 'hex' | 'base64' = 'hex'): string {
    return this.hasher.digest(encoding)
  }
}

export async function hash(
  input: string | Uint8Array,
  algorithm: 'SHA-256' | 'SHA-512' = 'SHA-256',
): Promise<Uint8Array> {
  const bytes = toBytes(input)
  const slice = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const digest = await crypto.subtle.digest(algorithm, slice)
  return new Uint8Array(digest)
}

export async function hashHex(
  input: string | Uint8Array,
  algorithm: 'SHA-256' | 'SHA-512' = 'SHA-256',
): Promise<string> {
  return toHex(await hash(input, algorithm))
}

export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = pbkdf2Sync(password, salt, 100_000, 32, 'sha256')
  return `pbkdf2$${salt.toString('hex')}$${derived.toString('hex')}`
}

export async function passwordVerify(password: string, hashed: string): Promise<boolean> {
  const [kind, saltHex, digestHex] = hashed.split('$')
  if (kind !== 'pbkdf2' || !saltHex || !digestHex) {
    return false
  }

  const derived = pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), 100_000, 32, 'sha256')
  const target = Buffer.from(digestHex, 'hex')
  if (derived.length !== target.length) {
    return false
  }
  return timingSafeEqual(derived, target)
}
