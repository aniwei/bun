import { describe, expect, test } from 'vitest'
import {
  brotliCompressSyncWeb,
  brotliDecompressSyncWeb,
  deflateSyncWeb,
  gunzipSyncWeb,
  gzipSyncWeb,
  inflateSyncWeb,
} from '../../../packages/bun-web-node/src/zlib'
import {
  assertModule,
  evaluateScript,
  osModule,
  utilModule,
  v8HeapStatistics,
} from '../../../packages/bun-web-node/src/vm-misc'

const decoder = new TextDecoder()

describe('M6 node zlib and vm-misc baseline', () => {
  test('gzip/deflate/brotli round-trip', () => {
    const input = 'bun-web-m6-zlib'

    expect(decoder.decode(gunzipSyncWeb(gzipSyncWeb(input)))).toBe(input)
    expect(decoder.decode(inflateSyncWeb(deflateSyncWeb(input)))).toBe(input)
    expect(decoder.decode(brotliDecompressSyncWeb(brotliCompressSyncWeb(input)))).toBe(input)
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
})
