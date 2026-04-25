// ----- helpers ----------------------------------------------------------------

function toUint8(input: string | Uint8Array): Uint8Array {
  return typeof input === 'string' ? new TextEncoder().encode(input) : input
}

// ----- flate backend (wasm-flate – gzip / deflate / zlib) --------------------

export type FlateBackend = {
  gzipEncode: (data: Uint8Array) => Uint8Array
  gzipDecode: (data: Uint8Array) => Uint8Array
  deflateEncode: (data: Uint8Array) => Uint8Array
  deflateDecode: (data: Uint8Array) => Uint8Array
}

let _flateBackend: FlateBackend | undefined

/**
 * Register a flate wasm backend.
 * In production call `initFlateWasm()` which does this automatically.
 * In tests inject a mock or a node:zlib shim.
 */
export function __setFlateBackend(backend: FlateBackend): void {
  _flateBackend = backend
}

/** Reset flate backend (used in tests). */
export function __resetFlateForTests(): void {
  _flateBackend = undefined
}

function getFlate(): FlateBackend {
  if (!_flateBackend) {
    throw new Error('flate backend not initialised; call initFlateWasm() before using zlib APIs')
  }
  return _flateBackend
}

/**
 * Initialise wasm-flate and register the backend.
 * Safe to call multiple times – subsequent calls are no-ops.
 */
export async function initFlateWasm(wasmUrl?: string | URL): Promise<void> {
  if (_flateBackend) return
  const mod = await import('wasm-flate/wasm_flate.js')
  await mod.default(wasmUrl)
  _flateBackend = {
    gzipEncode: mod.gzip_encode_raw,
    gzipDecode: mod.gzip_decode_raw,
    deflateEncode: mod.deflate_encode_raw,
    deflateDecode: mod.deflate_decode_raw,
  }
}

/** Returns true when flate wasm backend is ready. */
export function isFlateWasmReady(): boolean {
  return _flateBackend !== undefined
}

// ----- gzip ------------------------------------------------------------------

export function gzipSyncWeb(input: string | Uint8Array): Uint8Array {
  return getFlate().gzipEncode(toUint8(input))
}

export function gunzipSyncWeb(input: Uint8Array): Uint8Array {
  return getFlate().gzipDecode(toUint8(input))
}

// ----- deflate ---------------------------------------------------------------

export function deflateSyncWeb(input: string | Uint8Array): Uint8Array {
  return getFlate().deflateEncode(toUint8(input))
}

export function inflateSyncWeb(input: Uint8Array): Uint8Array {
  return getFlate().deflateDecode(toUint8(input))
}

// ----- brotli backend (separate wasm loader) ---------------------------------

export type BrotliBackend = {
  compress: (data: Uint8Array) => Uint8Array
  decompress: (data: Uint8Array) => Uint8Array
}

let _brotliBackend: BrotliBackend | undefined

/** Register a brotli wasm backend (called by the wasm loader once ready). */
export function __setBrotliBackend(backend: BrotliBackend): void {
  _brotliBackend = backend
}

/** Reset brotli backend (used in tests). */
export function __resetBrotliForTests(): void {
  _brotliBackend = undefined
}

function getBrotli(): BrotliBackend {
  if (!_brotliBackend) {
    throw new Error('brotli backend not initialised; call initBrotliWasm() before using brotli APIs')
  }
  return _brotliBackend
}

export function brotliCompressSyncWeb(input: string | Uint8Array): Uint8Array {
  return getBrotli().compress(toUint8(input))
}

export function brotliDecompressSyncWeb(input: Uint8Array): Uint8Array {
  return getBrotli().decompress(toUint8(input))
}

export async function brotliCompressWeb(input: string | Uint8Array): Promise<Uint8Array> {
  return getBrotli().compress(toUint8(input))
}

export async function brotliDecompressWeb(input: Uint8Array): Promise<Uint8Array> {
  return getBrotli().decompress(toUint8(input))
}
