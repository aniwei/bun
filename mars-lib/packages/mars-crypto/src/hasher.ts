export type MarsHashAlgorithm = "md5" | "sha1" | "sha256" | "sha512"
export type MarsHashDigestEncoding = "hex" | "base64" | "base64url" | "buffer"
export type MarsHashInput = string | ArrayBuffer | ArrayBufferView

export class MarsCryptoHasher {
  readonly algorithm: MarsHashAlgorithm
  readonly #chunks: Uint8Array[] = []

  constructor(algorithm: MarsHashAlgorithm) {
    this.algorithm = normalizeHashAlgorithmName(algorithm)
  }

  update(input: MarsHashInput): this {
    this.#chunks.push(toBytes(input))
    return this
  }

  async digest(encoding: MarsHashDigestEncoding = "hex"): Promise<string | Uint8Array> {
    const bytes = concatBytes(this.#chunks)
    return digestBytes(this.algorithm, bytes, encoding)
  }
}

export async function createHashDigest(
  algorithm: MarsHashAlgorithm,
  input: MarsHashInput,
  encoding: MarsHashDigestEncoding = "hex",
): Promise<string | Uint8Array> {
  return digestBytes(normalizeHashAlgorithmName(algorithm), toBytes(input), encoding)
}

export function normalizeHashAlgorithmName(algorithm: string): MarsHashAlgorithm {
  const normalized = algorithm.toLowerCase().replace(/[-_]/g, "")

  if (normalized === "md5") return "md5"
  if (normalized === "sha1") return "sha1"
  if (normalized === "sha256") return "sha256"
  if (normalized === "sha512") return "sha512"

  throw new Error(`Unsupported hash algorithm: ${algorithm}`)
}

async function digestBytes(
  algorithm: MarsHashAlgorithm,
  bytes: Uint8Array,
  encoding: MarsHashDigestEncoding,
): Promise<string | Uint8Array> {
  const digestInput = new Uint8Array(bytes.byteLength)
  digestInput.set(bytes)
  const output = algorithm === "md5"
    ? digestMD5(digestInput)
    : new Uint8Array(await crypto.subtle.digest(toWebCryptoAlgorithm(algorithm), digestInput.buffer))

  if (encoding === "buffer") return output
  if (encoding === "hex") return toHex(output)
  if (encoding === "base64") return toBase64(output)
  if (encoding === "base64url") return toBase64(output).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")

  return output
}

function toWebCryptoAlgorithm(algorithm: MarsHashAlgorithm): AlgorithmIdentifier {
  if (algorithm === "sha1") return "SHA-1"
  if (algorithm === "sha256") return "SHA-256"
  if (algorithm === "sha512") return "SHA-512"

  throw new Error(`Unsupported WebCrypto hash algorithm: ${algorithm}`)
}

const md5ShiftAmounts = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]
const md5Constants = Array.from({ length: 64 }, (_, index) => {
  return Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0
})

function digestMD5(input: Uint8Array): Uint8Array {
  const paddedLength = (((input.byteLength + 8) >>> 6) + 1) << 6
  const padded = new Uint8Array(paddedLength)
  padded.set(input)
  padded[input.byteLength] = 0x80

  const bitLength = input.byteLength * 8
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, bitLength >>> 0, true)
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000) >>> 0, true)

  let wordA = 0x67452301
  let wordB = 0xefcdab89
  let wordC = 0x98badcfe
  let wordD = 0x10325476

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const chunkWords = new Array<number>(16)
    for (let index = 0; index < 16; index += 1) {
      chunkWords[index] = view.getUint32(offset + index * 4, true)
    }

    let chunkA = wordA
    let chunkB = wordB
    let chunkC = wordC
    let chunkD = wordD

    for (let index = 0; index < 64; index += 1) {
      let mixed = 0
      let wordIndex = 0

      if (index < 16) {
        mixed = (chunkB & chunkC) | (~chunkB & chunkD)
        wordIndex = index
      } else if (index < 32) {
        mixed = (chunkD & chunkB) | (~chunkD & chunkC)
        wordIndex = (5 * index + 1) % 16
      } else if (index < 48) {
        mixed = chunkB ^ chunkC ^ chunkD
        wordIndex = (3 * index + 5) % 16
      } else {
        mixed = chunkC ^ (chunkB | ~chunkD)
        wordIndex = (7 * index) % 16
      }

      const nextD = chunkD
      chunkD = chunkC
      chunkC = chunkB
      chunkB = (chunkB + rotateLeft32(
        (chunkA + mixed + md5Constants[index] + chunkWords[wordIndex]) >>> 0,
        md5ShiftAmounts[index],
      )) >>> 0
      chunkA = nextD
    }

    wordA = (wordA + chunkA) >>> 0
    wordB = (wordB + chunkB) >>> 0
    wordC = (wordC + chunkC) >>> 0
    wordD = (wordD + chunkD) >>> 0
  }

  const output = new Uint8Array(16)
  const outputView = new DataView(output.buffer)
  outputView.setUint32(0, wordA, true)
  outputView.setUint32(4, wordB, true)
  outputView.setUint32(8, wordC, true)
  outputView.setUint32(12, wordD, true)

  return output
}

function rotateLeft32(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0
}

function toBytes(input: MarsHashInput): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input)
  if (input instanceof ArrayBuffer) return new Uint8Array(input)

  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
}

function toBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  let output = ""

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    const triplet = (first << 16) | ((second ?? 0) << 8) | (third ?? 0)

    output += alphabet[(triplet >> 18) & 0x3f]
    output += alphabet[(triplet >> 12) & 0x3f]
    output += second === undefined ? "=" : alphabet[(triplet >> 6) & 0x3f]
    output += third === undefined ? "=" : alphabet[triplet & 0x3f]
  }

  return output
}
