import { MarsCryptoHasher, createHashDigest } from "@mars/crypto"

import type { MarsHashAlgorithm, MarsHashDigestEncoding, MarsHashInput } from "@mars/crypto"

export class MarsNodeHash {
  readonly #hasher: MarsCryptoHasher

  constructor(algorithm: MarsHashAlgorithm) {
    this.#hasher = new MarsCryptoHasher(algorithm)
  }

  update(input: MarsHashInput): this {
    this.#hasher.update(input)
    return this
  }

  digest(encoding: MarsHashDigestEncoding = "hex") {
    return this.#hasher.digest(encoding)
  }
}

export class MarsNodeHmac {
  readonly #algorithm: MarsHashAlgorithm
  readonly #key: Uint8Array
  readonly #chunks: Uint8Array[] = []

  constructor(algorithm: MarsHashAlgorithm, key: MarsHashInput) {
    this.#algorithm = algorithm
    this.#key = toBytes(key)
  }

  update(input: MarsHashInput): this {
    this.#chunks.push(toBytes(input))
    return this
  }

  async digest(encoding: MarsHashDigestEncoding = "hex") {
    return createHmacDigest(this.#algorithm, this.#key, concatBytes(this.#chunks), encoding)
  }
}

export function createHash(algorithm: MarsHashAlgorithm): MarsNodeHash {
  return new MarsNodeHash(algorithm)
}

export function createHmac(algorithm: MarsHashAlgorithm, key: MarsHashInput): MarsNodeHmac {
  return new MarsNodeHmac(algorithm, key)
}

export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()

  const bytes = randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0"))

  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`
}

export function randomBytes(size: number): Uint8Array {
  if (!Number.isInteger(size) || size < 0) throw new Error(`Invalid random byte size: ${size}`)

  const bytes = new Uint8Array(size)
  let offset = 0

  while (offset < size) {
    const chunk = bytes.subarray(offset, Math.min(offset + 65_536, size))
    crypto.getRandomValues(chunk)
    offset += chunk.byteLength
  }

  return bytes
}

async function createHmacDigest(
  algorithm: MarsHashAlgorithm,
  key: Uint8Array,
  message: Uint8Array,
  encoding: MarsHashDigestEncoding,
): Promise<string | Uint8Array> {
  const blockSize = algorithm === "sha512" ? 128 : 64
  const normalizedKey = key.byteLength > blockSize
    ? await createHashDigest(algorithm, key, "buffer") as Uint8Array
    : key
  const keyBlock = new Uint8Array(blockSize)
  keyBlock.set(normalizedKey)
  const outerKeyPad = new Uint8Array(blockSize)
  const innerKeyPad = new Uint8Array(blockSize)

  for (let index = 0; index < blockSize; index += 1) {
    outerKeyPad[index] = keyBlock[index] ^ 0x5c
    innerKeyPad[index] = keyBlock[index] ^ 0x36
  }

  const innerDigest = await createHashDigest(
    algorithm,
    concatBytes([innerKeyPad, message]),
    "buffer",
  ) as Uint8Array

  return createHashDigest(algorithm, concatBytes([outerKeyPad, innerDigest]), encoding)
}

function toBytes(input: MarsHashInput): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input)
  if (input instanceof ArrayBuffer) return new Uint8Array(input)

  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
}

const supportedHashAlgorithms = ["sha1", "sha256", "sha384", "sha512", "md5"] as const

export function getHashes(): string[] {
  return [...supportedHashAlgorithms]
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false

  let result = 0

  for (let index = 0; index < a.byteLength; index += 1) {
    result |= a[index] ^ b[index]
  }

  return result === 0
}

export interface Pbkdf2Options {
  hash?: string
}

export function pbkdf2(
  password: MarsHashInput,
  salt: MarsHashInput,
  iterations: number,
  keylen: number,
  digest: string,
  callback: (err: Error | null, derivedKey: Uint8Array | null) => void,
): void {
  pbkdf2Async(password, salt, iterations, keylen, digest)
    .then(key => callback(null, key))
    .catch(err => callback(err instanceof Error ? err : new Error(String(err)), null))
}

export async function pbkdf2Async(
  password: MarsHashInput,
  salt: MarsHashInput,
  iterations: number,
  keylen: number,
  digest: string,
): Promise<Uint8Array> {
  const normalizedDigest = normalizeWebCryptoDigest(digest)
  const passwordBytes = toBytes(password)
  const saltBytes = toBytes(salt)
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(passwordBytes),
    "PBKDF2",
    false,
    ["deriveBits"],
  )
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: normalizedDigest,
      salt: toArrayBuffer(saltBytes),
      iterations,
    },
    key,
    keylen * 8,
  )

  return new Uint8Array(derivedBits)
}

export function pbkdf2Sync(): never {
  throw new Error("pbkdf2Sync is not available in browser context; use pbkdf2 or pbkdf2Async instead")
}

export function scrypt(): never {
  throw new Error("scrypt is not available in browser context; use pbkdf2Async instead")
}

export function scryptSync(): never {
  throw new Error("scryptSync is not available in browser context; use pbkdf2Async instead")
}

function normalizeWebCryptoDigest(digest: string): string {
  const lower = digest.toLowerCase().replace(/-/g, "")
  if (lower === "sha1") return "SHA-1"
  if (lower === "sha256") return "SHA-256"
  if (lower === "sha384") return "SHA-384"
  if (lower === "sha512") return "SHA-512"

  return digest.toUpperCase()
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(arrayBuffer).set(bytes)
  return arrayBuffer
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((length, chunk) => length + chunk.byteLength, 0)
  const bytes = new Uint8Array(totalLength)
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return bytes
}
