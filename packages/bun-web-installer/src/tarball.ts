type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export type DownloadTarballOptions = {
  fetchFn?: FetchLike
  integrity?: string
}

export type ExtractedTarEntry = {
  path: string
  type: 'file' | 'directory'
  data: Uint8Array
}

function trimNullTerminated(input: Uint8Array): string {
  let end = input.length
  for (let i = 0; i < input.length; i++) {
    if (input[i] === 0) {
      end = i
      break
    }
  }
  return new TextDecoder().decode(input.subarray(0, end))
}

function parseOctal(input: Uint8Array): number {
  const value = trimNullTerminated(input).trim()
  if (value.length === 0) return 0
  return Number.parseInt(value, 8)
}

function align512(value: number): number {
  return Math.ceil(value / 512) * 512
}

function normalizeEntryPath(path: string): string {
  if (path.startsWith('./')) return path.slice(2)
  if (path.startsWith('/')) return path.slice(1)
  return path
}

function isAllZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false
  }
  return true
}

function maybeJoinPrefix(prefix: string, name: string): string {
  if (!prefix) return name
  if (!name) return prefix
  return `${prefix}/${name}`
}

function splitIntegrity(integrity: string): { algorithm: string; expectedBase64: string } {
  const dashIndex = integrity.indexOf('-')
  if (dashIndex <= 0 || dashIndex === integrity.length - 1) {
    throw new TypeError(`Invalid integrity format: ${integrity}`)
  }

  const algorithm = integrity.slice(0, dashIndex).toLowerCase()
  const expectedBase64 = integrity.slice(dashIndex + 1)
  return { algorithm, expectedBase64 }
}

function toBase64(input: ArrayBuffer): string {
  return Buffer.from(input).toString('base64')
}

function toStrictUint8Array(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(input.byteLength)
  out.set(input)
  return out
}

async function digestBytes(algorithm: string, data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, toStrictUint8Array(data))
  return toBase64(digest)
}

function mapSRIAlgorithm(algorithm: string): string {
  if (algorithm === 'sha512') return 'SHA-512'
  if (algorithm === 'sha384') return 'SHA-384'
  if (algorithm === 'sha256') return 'SHA-256'
  if (algorithm === 'sha1') return 'SHA-1'
  throw new TypeError(`Unsupported integrity algorithm: ${algorithm}`)
}

async function gunzip(input: Uint8Array): Promise<Uint8Array> {
  const decompression = new DecompressionStream('gzip')
  const writer = decompression.writable.getWriter()
  await writer.write(toStrictUint8Array(input))
  await writer.close()
  const raw = await new Response(decompression.readable).arrayBuffer()
  return new Uint8Array(raw)
}

function isGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b
}

export async function verifyIntegrity(data: Uint8Array, integrity: string): Promise<void> {
  const { algorithm, expectedBase64 } = splitIntegrity(integrity)
  const webCryptoAlgorithm = mapSRIAlgorithm(algorithm)
  const actualBase64 = await digestBytes(webCryptoAlgorithm, data)
  if (actualBase64 !== expectedBase64) {
    throw new Error(`Integrity mismatch for ${algorithm}`)
  }
}

export async function downloadTarball(
  tarballUrl: string,
  options: DownloadTarballOptions = {},
): Promise<Uint8Array> {
  if (!tarballUrl || tarballUrl.trim().length === 0) {
    throw new TypeError('tarballUrl must be a non-empty string')
  }

  const fetchFn = options.fetchFn ?? fetch
  const response = await fetchFn(tarballUrl)
  if (!response.ok) {
    throw new Error(`Failed to download tarball: ${response.status} ${response.statusText}`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (options.integrity) {
    await verifyIntegrity(bytes, options.integrity)
  }
  return bytes
}

export async function extractTarball(
  tarballData: Uint8Array,
): Promise<Map<string, ExtractedTarEntry>> {
  if (tarballData.length === 0) {
    throw new TypeError('tarballData must not be empty')
  }

  const tarData = isGzip(tarballData) ? await gunzip(tarballData) : tarballData
  const entries = new Map<string, ExtractedTarEntry>()

  let offset = 0
  while (offset + 512 <= tarData.length) {
    const header = tarData.subarray(offset, offset + 512)
    if (isAllZeroBlock(header)) {
      break
    }

    const name = trimNullTerminated(header.subarray(0, 100))
    const prefix = trimNullTerminated(header.subarray(345, 500))
    const entryPath = normalizeEntryPath(maybeJoinPrefix(prefix, name))

    const size = parseOctal(header.subarray(124, 136))
    const typeFlagRaw = header[156]
    const typeFlag = typeFlagRaw === 0 ? '0' : String.fromCharCode(typeFlagRaw)
    const type: 'file' | 'directory' = typeFlag === '5' ? 'directory' : 'file'

    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > tarData.length) {
      throw new Error(`Invalid tar entry size for ${entryPath || '<empty>'}`)
    }

    const entryData = tarData.slice(dataStart, dataEnd)
    const normalizedPath = type === 'directory' && entryPath.endsWith('/')
      ? entryPath.slice(0, -1)
      : entryPath

    if (normalizedPath.length > 0) {
      entries.set(normalizedPath, {
        path: normalizedPath,
        type,
        data: entryData,
      })
    }

    offset = dataStart + align512(size)
  }

  return entries
}