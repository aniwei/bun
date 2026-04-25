import { describe, expect, test } from 'vitest'
import {
  __resetBrotliForTests,
  __resetFlateForTests,
  __setBrotliBackend,
  __setFlateBackend,
  brotliCompressSyncWeb,
  brotliDecompressSyncWeb,
  deflateSyncWeb,
  gunzipSyncWeb,
  gzipSyncWeb,
  inflateSyncWeb,
  isFlateWasmReady,
} from '../../../packages/bun-web-node/src/zlib'
import {
  MarsWebUnsupportedError,
  assertModule,
  clusterModule,
  evaluateScript,
  osModule,
  utilModule,
  v8HeapStatistics,
} from '../../../packages/bun-web-node/src/vm-misc'
import { brotliCompressSync, brotliDecompressSync, deflateSync, gunzipSync, gzipSync, inflateSync } from 'node:zlib'
import { stableSnapshot } from './snapshot-utils'

const decoder = new TextDecoder()

describe('M6 node zlib and vm-misc baseline', () => {
  test('flate backend throws when not initialised', () => {
    __resetFlateForTests()
    expect(() => gzipSyncWeb('hello')).toThrow('flate backend not initialised')
    __resetFlateForTests()
  })

  test('isFlateWasmReady reflects backend state', () => {
    __resetFlateForTests()
    expect(isFlateWasmReady()).toBe(false)

    __setFlateBackend({
      gzipEncode: d => d,
      gzipDecode: d => d,
      deflateEncode: d => d,
      deflateDecode: d => d,
    })
    expect(isFlateWasmReady()).toBe(true)
    __resetFlateForTests()
  })

  test('gzip/deflate round-trip via injected wasm-flate backend', () => {
    __resetFlateForTests()

    // inject a node:zlib shim that mirrors what wasm-flate provides
    __setFlateBackend({
      gzipEncode: (data) => new Uint8Array(gzipSync(Buffer.from(data))),
      gzipDecode: (data) => new Uint8Array(gunzipSync(Buffer.from(data))),
      deflateEncode: (data) => new Uint8Array(deflateSync(Buffer.from(data))),
      deflateDecode: (data) => new Uint8Array(inflateSync(Buffer.from(data))),
    })

    const input = 'bun-web-m6-zlib'
    expect(decoder.decode(gunzipSyncWeb(gzipSyncWeb(input)))).toBe(input)
    expect(decoder.decode(inflateSyncWeb(deflateSyncWeb(input)))).toBe(input)

    __resetFlateForTests()
  })

  test('brotli round-trip via injected backend', () => {
    __resetBrotliForTests()

    __setBrotliBackend({
      compress: (data) => new Uint8Array(brotliCompressSync(Buffer.from(data))),
      decompress: (data) => new Uint8Array(brotliDecompressSync(Buffer.from(data))),
    })

    const input = 'bun-web-m6-brotli'
    expect(decoder.decode(brotliDecompressSyncWeb(brotliCompressSyncWeb(input)))).toBe(input)

    __resetBrotliForTests()
  })

  test('brotli throws when backend not initialised', () => {
    __resetBrotliForTests()
    expect(() => brotliCompressSyncWeb('hello')).toThrow('brotli backend not initialised')
    __resetBrotliForTests()
  })

  test('vm and misc node module adapters work', async () => {
    const value = evaluateScript('1 + 2 + 3')
    assertModule.strictEqual(value, 6)

    expect(typeof utilModule.format).toBe('function')
    expect(typeof osModule.platform()).toBe('string')

    const heap = await v8HeapStatistics()
    if (heap !== null) {
      expect(typeof heap).toBe('object')
    }
  })

  test('MarsWebUnsupportedError has correct shape', () => {
    const err = new MarsWebUnsupportedError('cluster.fork', { level: 'C' })
    expect(err.code).toBe('ERR_BUN_WEB_UNSUPPORTED')
    expect(err.symbol).toBe('cluster.fork')
    expect(err.compatLevel).toBe('C')
    expect(err).toBeInstanceOf(Error)
    expect(
      stableSnapshot({
        code: err.code,
        symbol: err.symbol,
        compatLevel: err.compatLevel,
        name: err.name,
      }),
    ).toMatchInlineSnapshot(`
      "{
        \"code\": \"ERR_BUN_WEB_UNSUPPORTED\",
        \"compatLevel\": \"C\",
        \"name\": \"MarsWebUnsupportedError\",
        \"symbol\": \"cluster.fork\"
      }"
    `)
  })

  test('clusterModule stubs throw MarsWebUnsupportedError', () => {
    expect(() => clusterModule.fork()).toThrow(MarsWebUnsupportedError)
    expect(() => clusterModule.setupPrimary()).toThrow(MarsWebUnsupportedError)
    expect(() => clusterModule.disconnect()).toThrow(MarsWebUnsupportedError)
  })
})
