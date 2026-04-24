// crypto.subtle missing algorithm patch (RFC §8.3)
// The browser WebCrypto only implements a limited set of algorithms.
// This module detects missing algorithms and provides soft stubs that
// throw clear ERR_BUN_WEB_UNSUPPORTED with upgrade guidance.
//
// In M6, bun-web-crypto ships WASM implementations for missing algos.

const BROWSER_SUPPORTED_ALGOS = new Set([
  'AES-CBC',
  'AES-CTR',
  'AES-GCM',
  'AES-KW',
  'HMAC',
  'RSA-OAEP',
  'RSA-PSS',
  'RSASSA-PKCS1-v1_5',
  'ECDSA',
  'ECDH',
  'PBKDF2',
  'HKDF',
  'Ed25519',
  'X25519',
  // SHA family (not standalone importKey/generateKey, but supported in HMAC/digest)
  'SHA-1',
  'SHA-256',
  'SHA-384',
  'SHA-512',
])

/**
 * Returns true if the algorithm name is known to be supported by the
 * browser's native WebCrypto implementation.
 */
export function isSupportedCryptoAlgo(name: string): boolean {
  return BROWSER_SUPPORTED_ALGOS.has(name.toUpperCase())
}

/**
 * Returns a human-readable list of algorithms supported natively.
 */
export function getSupportedCryptoAlgos(): string[] {
  return [...BROWSER_SUPPORTED_ALGOS]
}

// Patch globalThis.crypto to expose Bun-style `Bun.hash.*` shims
// These are minimal wrappers; full implementation lives in M6.
export function installCryptoExt(): void {
  if (typeof globalThis.Bun === 'undefined') return

  const bun = globalThis.Bun as Record<string, unknown>

  // Bun.hash — minimal shim returning sha256 via WebCrypto
  if (!('hash' in bun)) {
    bun['hash'] = {
      async sha256(data: string | Uint8Array): Promise<string> {
        const encoder = new TextEncoder()
        const bytes = typeof data === 'string' ? encoder.encode(data) : data
        const buf = await crypto.subtle.digest('SHA-256', bytes)
        return Array.from(new Uint8Array(buf))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')
      },
    }
  }

  // Bun.SHA256 / Bun.MD5 — class shim stubs
  if (!('SHA256' in bun)) {
    bun['SHA256'] = class BunSHA256Stub {
      constructor() {
        throw new Error(
          'Bun.SHA256 class requires the bun-web-crypto WASM polyfill (available in M6)'
        )
      }
    }
  }
}
