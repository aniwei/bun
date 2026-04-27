// CompressionStream / DecompressionStream extensions (RFC §8.3)
// The browser ships native CompressionStream/DecompressionStream, but only
// supports "gzip", "deflate", and "deflate-raw".  Bun also supports "brotli"
// and "zstd" natively.  This module:
//   1. Passes through to native when format is supported
//   2. Stubs unsupported formats with a clear error
//   3. Exports helpers for userland to check support

export type SupportedFormat = 'gzip' | 'deflate' | 'deflate-raw' | 'brotli' | 'zstd'

const NATIVE_FORMATS = new Set<string>(['gzip', 'deflate', 'deflate-raw'])

export function isSupportedFormat(format: string): format is SupportedFormat {
  return NATIVE_FORMATS.has(format) || format === 'brotli' || format === 'zstd'
}

/**
 * Returns true if `CompressionStream` with the given format is natively
 * supported in the current environment.
 */
export function isNativeCompressionFormat(format: string): boolean {
  return NATIVE_FORMATS.has(format)
}

/**
 * Guard that throws a clear error when an unsupported format is requested.
 * In the browser runtime brotli/zstd are NOT available natively — they
 * require a WASM polyfill delivered in M6 (bun-web-crypto).
 */
export function assertCompressionFormat(format: string): void {
  if (!isSupportedFormat(format)) {
    throw new TypeError(
      `CompressionStream: unsupported format "${format}". ` +
        `Supported: gzip, deflate, deflate-raw, brotli (M6), zstd (M6)`
    )
  }
  if (!NATIVE_FORMATS.has(format)) {
    throw new TypeError(
      `CompressionStream: "${format}" requires the bun-web-crypto WASM polyfill (available in M6). ` +
        `Currently only "gzip", "deflate", and "deflate-raw" are supported natively.`
    )
  }
}

// Re-export native CompressionStream / DecompressionStream unchanged so
// consumers can always import from this module.
export const CompressionStreamImpl: typeof CompressionStream =
  typeof globalThis.CompressionStream !== 'undefined'
    ? globalThis.CompressionStream
    : (class UnsupportedCompressionStream {
        constructor(_format: string) {
          throw new Error('CompressionStream is not available in this environment')
        }
      } as unknown as typeof CompressionStream)

export const DecompressionStreamImpl: typeof DecompressionStream =
  typeof globalThis.DecompressionStream !== 'undefined'
    ? globalThis.DecompressionStream
    : (class UnsupportedDecompressionStream {
        constructor(_format: string) {
          throw new Error('DecompressionStream is not available in this environment')
        }
      } as unknown as typeof DecompressionStream)
