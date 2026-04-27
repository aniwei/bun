import type { MarsHashInput } from "./hasher"

export type MarsPasswordAlgorithm = "mars-pbkdf2-sha256"

export interface MarsPasswordHashOptions {
  algorithm?: MarsPasswordAlgorithm
  iterations?: number
  salt?: MarsHashInput
}

export interface MarsPasswordFacade {
  hash(password: MarsHashInput, options?: MarsPasswordHashOptions): Promise<string>
  verify(password: MarsHashInput, hash: string): Promise<boolean>
}

const marsPasswordPrefix = "$mars$pbkdf2-sha256"
const defaultIterations = 100_000
const saltByteLength = 16
const digestBitLength = 256

export const marsPassword: MarsPasswordFacade = {
  hash: hashPassword,
  verify: verifyPassword,
}

export async function hashPassword(
  password: MarsHashInput,
  options: MarsPasswordHashOptions = {},
): Promise<string> {
  const algorithm = options.algorithm ?? "mars-pbkdf2-sha256"
  if (algorithm !== "mars-pbkdf2-sha256") throw new Error(`Unsupported password algorithm: ${algorithm}`)

  const iterations = options.iterations ?? defaultIterations
  if (!Number.isInteger(iterations) || iterations <= 0) throw new Error(`Invalid password iterations: ${iterations}`)

  const salt = options.salt ? toBytes(options.salt) : randomSalt()
  const digest = await derivePasswordDigest(password, salt, iterations)

  return [
    marsPasswordPrefix,
    String(iterations),
    toBase64Url(salt),
    toBase64Url(digest),
  ].join("$")
}

export async function verifyPassword(password: MarsHashInput, hash: string): Promise<boolean> {
  const parsedHash = parsePasswordHash(hash)
  if (!parsedHash) return false

  const digest = await derivePasswordDigest(password, parsedHash.salt, parsedHash.iterations)
  return timingSafeEqual(digest, parsedHash.digest)
}

async function derivePasswordDigest(
  password: MarsHashInput,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const passwordBytes = toBytes(password)
  const saltBytes = toArrayBuffer(salt)
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(passwordBytes),
    "PBKDF2",
    false,
    ["deriveBits"],
  )
  const digest = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltBytes,
      iterations,
    },
    key,
    digestBitLength,
  )

  return new Uint8Array(digest)
}

function parsePasswordHash(hash: string): { iterations: number; salt: Uint8Array; digest: Uint8Array } | null {
  const [empty, namespace, algorithm, iterationsText, saltText, digestText] = hash.split("$")
  if (empty !== "" || namespace !== "mars" || algorithm !== "pbkdf2-sha256") return null
  if (!iterationsText || !saltText || !digestText) return null

  const iterations = Number(iterationsText)
  if (!Number.isInteger(iterations) || iterations <= 0) return null

  return {
    iterations,
    salt: fromBase64Url(saltText),
    digest: fromBase64Url(digestText),
  }
}

function randomSalt(): Uint8Array {
  const salt = new Uint8Array(saltByteLength)
  crypto.getRandomValues(salt)
  return salt
}

function toBytes(input: MarsHashInput): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input)
  if (input instanceof ArrayBuffer) return new Uint8Array(input)

  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(arrayBuffer).set(bytes)
  return arrayBuffer
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false

  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index]
  }

  return difference === 0
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}
