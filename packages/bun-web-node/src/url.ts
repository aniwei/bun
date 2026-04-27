export type QueryValue = string | string[]
export type QueryObject = Record<string, QueryValue>
export type SupportedEncoding = BufferEncoding | 'utf8' | 'utf-8' | 'base64' | 'hex' | 'latin1'

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function safeEncode(value: string): string {
  return encodeURIComponent(value)
}

export function parseQueryString(input: string, sep = '&', eq = '='): QueryObject {
  const result: QueryObject = {}
  const source = input.startsWith('?') ? input.slice(1) : input
  if (source.length === 0) {
    return result
  }

  for (const pair of source.split(sep)) {
    if (!pair) {
      continue
    }

    const index = pair.indexOf(eq)
    const rawKey = index >= 0 ? pair.slice(0, index) : pair
    const rawValue = index >= 0 ? pair.slice(index + eq.length) : ''

    const key = safeDecode(rawKey)
    const value = safeDecode(rawValue)
    const existing = result[key]

    if (existing === undefined) {
      result[key] = value
      continue
    }

    if (Array.isArray(existing)) {
      existing.push(value)
      continue
    }

    result[key] = [existing, value]
  }

  return result
}

export function stringifyQueryString(input: QueryObject, sep = '&', eq = '='): string {
  const pairs: string[] = []

  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        pairs.push(`${safeEncode(key)}${eq}${safeEncode(item)}`)
      }
      continue
    }

    pairs.push(`${safeEncode(key)}${eq}${safeEncode(value)}`)
  }

  return pairs.join(sep)
}

export function resolveURL(from: string, to: string): string {
  return new URL(to, from).toString()
}

export function formatURL(input: URL | string): string {
  return typeof input === 'string' ? input : input.toString()
}

export function parseURL(input: string, parseQuery = false): {
  href: string
  origin: string
  protocol: string
  host: string
  hostname: string
  port: string
  pathname: string
  search: string
  hash: string
  query: string | QueryObject
} {
  const url = new URL(input)
  return {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    query: parseQuery ? parseQueryString(url.search) : url.search,
  }
}

export const querystring = {
  parse: parseQueryString,
  stringify: stringifyQueryString,
  decode: parseQueryString,
  encode: stringifyQueryString,
}

function normalizeEncoding(encoding: SupportedEncoding = 'utf8'): BufferEncoding {
  if (encoding === 'utf-8') {
    return 'utf8'
  }
  return encoding as BufferEncoding
}

export class StringDecoder {
  private readonly encoding: BufferEncoding

  constructor(encoding: SupportedEncoding = 'utf8') {
    this.encoding = normalizeEncoding(encoding)
  }

  write(input: Buffer | Uint8Array | string): string {
    if (typeof input === 'string') {
      return input
    }

    return Buffer.from(input).toString(this.encoding)
  }

  end(input?: Buffer | Uint8Array | string): string {
    if (input === undefined) {
      return ''
    }

    return this.write(input)
  }
}

export const URL = globalThis.URL
export const URLSearchParams = globalThis.URLSearchParams

/**
 * Convert a `file://` URL to a filesystem path string.
 * Mirrors Node.js `url.fileURLToPath()`.
 */
export function fileURLToPath(url: string | URL): string {
  const u = typeof url === 'string' ? new globalThis.URL(url) : url
  if (u.protocol !== 'file:') {
    throw new TypeError(`The URL must be of scheme file, received ${u.protocol}`)
  }
  // On POSIX: decode percent-encoding, strip hostname (should be empty/localhost)
  return decodeURIComponent(u.pathname)
}

/**
 * Convert an absolute filesystem path to a `file://` URL.
 * Mirrors Node.js `url.pathToFileURL()`.
 */
export function pathToFileURL(path: string): URL {
  // Ensure absolute path — just prepend file:// prefix
  const abs = path.startsWith('/') ? path : `/${path}`
  // Encode special characters but keep slashes
  const encoded = abs.replace(/[^/]/g, (ch) => {
    const code = ch.charCodeAt(0)
    // Leave unreserved characters as-is
    if (
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x30 && code <= 0x39) || // 0-9
      ch === '-' ||
      ch === '_' ||
      ch === '.' ||
      ch === '~'
    ) {
      return ch
    }
    return encodeURIComponent(ch)
  })
  return new globalThis.URL(`file://${encoded}`)
}
