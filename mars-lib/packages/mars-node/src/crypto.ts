import { MarsCryptoHasher, createHashDigest, normalizeHashAlgorithmName } from "@mars/crypto"

import type { MarsHashAlgorithm, MarsHashDigestEncoding, MarsHashInput } from "@mars/crypto"

export class MarsNodeHash {
  readonly #algorithm: MarsHashAlgorithm
  readonly #chunks: Uint8Array[] = []

  constructor(algorithm: MarsHashAlgorithm) {
    this.#algorithm = normalizeHashAlgorithmName(algorithm)
  }

  update(input: MarsHashInput): this {
    this.#chunks.push(toBytes(input))
    return this
  }

  digest(encoding: MarsHashDigestEncoding = "hex") {
    const bytes = concatBytes(this.#chunks)
    if (this.#algorithm === "sha1") return encodeDigest(digestSHA1(bytes), encoding)

    const hasher = new MarsCryptoHasher(this.#algorithm)
    hasher.update(bytes)
    if (this.#algorithm === "md5") return hasher.digestSync(encoding)
    return hasher.digest(encoding)
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

function encodeDigest(bytes: Uint8Array, encoding: MarsHashDigestEncoding): string | Uint8Array {
  if (encoding === "buffer") return bytes
  if (encoding === "hex") return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")

  const base64 = encodeBase64(bytes)
  if (encoding === "base64") return base64
  if (encoding === "base64url") return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")

  return bytes
}

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function encodeBase64(bytes: Uint8Array): string {
  let output = ""
  let offset = 0

  for (; offset + 2 < bytes.byteLength; offset += 3) {
    const value = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]
    output += base64Alphabet[(value >> 18) & 0x3f]
    output += base64Alphabet[(value >> 12) & 0x3f]
    output += base64Alphabet[(value >> 6) & 0x3f]
    output += base64Alphabet[value & 0x3f]
  }

  if (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset
    const value = bytes[offset] << 16 | (remaining === 2 ? bytes[offset + 1] << 8 : 0)
    output += base64Alphabet[(value >> 18) & 0x3f]
    output += base64Alphabet[(value >> 12) & 0x3f]
    output += remaining === 2 ? base64Alphabet[(value >> 6) & 0x3f] : "="
    output += "="
  }

  return output
}

function digestSHA1(input: Uint8Array): Uint8Array {
  const paddedLength = (((input.byteLength + 8) >>> 6) + 1) << 6
  const padded = new Uint8Array(paddedLength)
  padded.set(input)
  padded[input.byteLength] = 0x80

  const bitLength = input.byteLength * 8
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000) >>> 0, false)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const words = new Uint32Array(80)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false)
    }
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft32(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], 1)
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4

    for (let index = 0; index < 80; index += 1) {
      let f = 0
      let k = 0
      if (index < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (index < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }

      const temp = (rotateLeft32(a, 5) + f + e + k + words[index]) >>> 0
      e = d
      d = c
      c = rotateLeft32(b, 30)
      b = a
      a = temp
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  const output = new Uint8Array(20)
  const outputView = new DataView(output.buffer)
  outputView.setUint32(0, h0, false)
  outputView.setUint32(4, h1, false)
  outputView.setUint32(8, h2, false)
  outputView.setUint32(12, h3, false)
  outputView.setUint32(16, h4, false)
  return output
}

function rotateLeft32(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0
}

// ─── HKDF ──────────────────────────────────────────────────────────────────────

export function hkdf(
  hash: string,
  key: MarsHashInput,
  salt: MarsHashInput,
  info: MarsHashInput,
  keylen: number,
  callback: (err: Error | null, derivedKey: Uint8Array | null) => void,
): void {
  hkdfAsync(hash, key, salt, info, keylen)
    .then(dk => callback(null, dk))
    .catch(err => callback(err instanceof Error ? err : new Error(String(err)), null))
}

export async function hkdfAsync(
  hash: string,
  key: MarsHashInput,
  salt: MarsHashInput,
  info: MarsHashInput,
  keylen: number,
): Promise<Uint8Array> {
  const importedKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(toBytes(key)),
    "HKDF",
    false,
    ["deriveBits"],
  )
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: normalizeWebCryptoDigest(hash),
      salt: toArrayBuffer(toBytes(salt)),
      info: toArrayBuffer(toBytes(info)),
    },
    importedKey,
    keylen * 8,
  )

  return new Uint8Array(derivedBits)
}

export function hkdfSync(): never {
  throw new Error("hkdfSync is not available in browser context; use hkdf or hkdfAsync instead")
}

// ─── Key / cipher stubs ────────────────────────────────────────────────────────

export function getCiphers(): string[] {
  return []
}

export function getCurves(): string[] {
  return ["P-256", "P-384", "P-521"]
}

export function createSign(algorithm: string): never {
  throw new Error(
    `createSign('${algorithm}') is not supported in browser context. Use the WebCrypto SubtleCrypto API (crypto.subtle.sign) directly.`,
  )
}

export function createVerify(algorithm: string): never {
  throw new Error(
    `createVerify('${algorithm}') is not supported in browser context. Use the WebCrypto SubtleCrypto API (crypto.subtle.verify) directly.`,
  )
}

export function createCipheriv(algorithm: string): never {
  throw new Error(
    `createCipheriv('${algorithm}') is not supported in browser context. Use the WebCrypto SubtleCrypto API (crypto.subtle.encrypt) directly.`,
  )
}

export function createDecipheriv(algorithm: string): never {
  throw new Error(
    `createDecipheriv('${algorithm}') is not supported in browser context. Use the WebCrypto SubtleCrypto API (crypto.subtle.decrypt) directly.`,
  )
}
