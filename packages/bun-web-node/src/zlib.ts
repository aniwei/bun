import {
  brotliCompressSync,
  brotliDecompressSync,
  gunzipSync,
  gzipSync,
  inflateSync,
  deflateSync,
} from 'node:zlib'

function toBuffer(input: string | Uint8Array): Buffer {
  return typeof input === 'string' ? Buffer.from(input) : Buffer.from(input)
}

export function gzipSyncWeb(input: string | Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(toBuffer(input)))
}

export function gunzipSyncWeb(input: Uint8Array): Uint8Array {
  return new Uint8Array(gunzipSync(toBuffer(input)))
}

export function deflateSyncWeb(input: string | Uint8Array): Uint8Array {
  return new Uint8Array(deflateSync(toBuffer(input)))
}

export function inflateSyncWeb(input: Uint8Array): Uint8Array {
  return new Uint8Array(inflateSync(toBuffer(input)))
}

export function brotliCompressSyncWeb(input: string | Uint8Array): Uint8Array {
  return new Uint8Array(brotliCompressSync(toBuffer(input)))
}

export function brotliDecompressSyncWeb(input: Uint8Array): Uint8Array {
  return new Uint8Array(brotliDecompressSync(toBuffer(input)))
}
