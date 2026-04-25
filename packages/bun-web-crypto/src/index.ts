import { blake3 } from '@noble/hashes/blake3.js'
import { argon2id } from '@noble/hashes/argon2.js'
import { sha3_224, sha3_256, sha3_384, sha3_512, keccak_256, keccak_512 } from '@noble/hashes/sha3.js'
import { sha256 as nobleSha256, sha512 as nobleSha512 } from '@noble/hashes/sha2.js'

// ----- helpers ----------------------------------------------------------------

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === 'string' ? new TextEncoder().encode(input) : input
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function fromHex(hex: string): Uint8Array {
  const pairs = hex.match(/.{2}/g)
  if (!pairs) return new Uint8Array(0)
  return Uint8Array.from(pairs.map(b => parseInt(b, 16)))
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

/** Browser-native random bytes (no node:crypto dependency) */
function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n)
  globalThis.crypto.getRandomValues(buf)
  return buf
}

/** Constant-time byte comparison (XOR-fold, no early exit) */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// ----- algorithm registry (WebCrypto + @noble/hashes) -------------------------

type HashAlgorithm =
  | 'sha256' | 'sha512' | 'md5'        // CryptoHasher compat
  | 'sha3-224' | 'sha3-256' | 'sha3-384' | 'sha3-512'
  | 'keccak-256' | 'keccak-512'
  | 'blake3'

const NOBLE_HASHERS: Record<string, (data: Uint8Array) => Uint8Array> = {
  'sha256':     d => nobleSha256(d),
  'sha512':     d => nobleSha512(d),
  'sha3-224':   d => sha3_224(d),
  'sha3-256':   d => sha3_256(d),
  'sha3-384':   d => sha3_384(d),
  'sha3-512':   d => sha3_512(d),
  'keccak-256': d => keccak_256(d),
  'keccak-512': d => keccak_512(d),
  'blake3':     d => blake3(d),
}

// ----- CryptoHasher -----------------------------------------------------------

export class CryptoHasher {
  private readonly algorithm: HashAlgorithm
  private chunks: Uint8Array[] = []

  constructor(algorithm: HashAlgorithm = 'sha256') {
    this.algorithm = algorithm
  }

  update(input: string | Uint8Array): this {
    this.chunks.push(toBytes(input))
    return this
  }

  digest(encoding: 'hex' | 'base64' = 'hex'): string {
    const total = new Uint8Array(this.chunks.reduce((s, c) => s + c.length, 0))
    let offset = 0
    for (const c of this.chunks) { total.set(c, offset); offset += c.length }

    const fn = NOBLE_HASHERS[this.algorithm]
    if (!fn) throw new TypeError(`Unsupported hash algorithm: ${this.algorithm}`)
    const result = fn(total)
    return encoding === 'base64' ? toBase64(result) : toHex(result)
  }
}

// ----- async hash helpers ----------------------------------------------------

const WEBCRYPTO_MAP: Record<string, string> = {
  'sha256': 'SHA-256',
  'sha512': 'SHA-512',
  'SHA-256': 'SHA-256',
  'SHA-512': 'SHA-512',
}

export async function hash(
  input: string | Uint8Array,
  algorithm: string = 'SHA-256',
): Promise<Uint8Array> {
  const webAlgo = WEBCRYPTO_MAP[algorithm]
  if (webAlgo) {
    const bytes = toBytes(input)
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    return new Uint8Array(await crypto.subtle.digest(webAlgo, buf))
  }
  // fall through to @noble for sha3 / blake3 etc.
  const nobleKey = algorithm.toLowerCase().replace('_', '-')
  const fn = NOBLE_HASHERS[nobleKey]
  if (!fn) throw new TypeError(`Unsupported hash algorithm: ${algorithm}`)
  return fn(toBytes(input))
}

export async function hashHex(
  input: string | Uint8Array,
  algorithm: string = 'SHA-256',
): Promise<string> {
  return toHex(await hash(input, algorithm))
}

// ----- Bun.hash.* fast-hash surface ------------------------------------------

export const bunHash = {
  /** 32-byte BLAKE3 hash (pure JS, constant-time) */
  blake3: (input: string | Uint8Array): Uint8Array => blake3(toBytes(input)),
  /** SHA3-256 */
  sha3_256: (input: string | Uint8Array): Uint8Array => sha3_256(toBytes(input)),
  /** Keccak-256 (Ethereum-style) */
  keccak256: (input: string | Uint8Array): Uint8Array => keccak_256(toBytes(input)),
}

// ----- password hash / verify (argon2id — browser-native, no WASM needed) -----

const ARGON2_PARAMS = { t: 3, m: 64 * 1024, p: 1, dkLen: 32 } as const

export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = argon2id(toBytes(password), salt, ARGON2_PARAMS)
  return `$argon2id$v=19$m=${ARGON2_PARAMS.m},t=${ARGON2_PARAMS.t},p=${ARGON2_PARAMS.p}$${toHex(salt)}$${toHex(hash)}`
}

export async function passwordVerify(password: string, hashed: string): Promise<boolean> {
  const match = hashed.match(
    /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/,
  )
  if (!match) return false
  const [, m, t, p, saltHex, hashHex] = match
  const salt = fromHex(saltHex)
  const derived = argon2id(toBytes(password), salt, {
    t: Number(t), m: Number(m), p: Number(p), dkLen: 32,
  })
  return timingSafeEqual(derived, fromHex(hashHex))
}
