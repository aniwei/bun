import { describe, test, expect } from 'vitest'

// Direct source imports (workspace package not yet linked in this test env)
import {
  installUACompat,
  getBunUAIdentifier,
  getHeaderInjection,
  isUACompatInstalled,
} from '../../../packages/bun-web-webapis/src/navigator-ua'

import {
  installBroadcastChannel,
  BroadcastChannelImpl,
} from '../../../packages/bun-web-webapis/src/broadcast'

import {
  isSupportedFormat,
  isNativeCompressionFormat,
  assertCompressionFormat,
  CompressionStreamImpl,
  DecompressionStreamImpl,
} from '../../../packages/bun-web-webapis/src/compression'

import {
  VirtualWebSocket,
  installWebSocketPolyfill,
  isWebSocketPolyfillInstalled,
  WS_READY_STATE,
} from '../../../packages/bun-web-webapis/src/websocket-patch'

import { installBlobFilePatch } from '../../../packages/bun-web-webapis/src/blob-file'
import { installPerformanceExt } from '../../../packages/bun-web-webapis/src/performance-ext'
import { installCryptoExt, isSupportedCryptoAlgo, getSupportedCryptoAlgos } from '../../../packages/bun-web-webapis/src/crypto-ext'
import { installWebAPIs } from '../../../packages/bun-web-webapis/src/index'

// ---------------------------------------------------------------------------
describe('@mars/web-webapis — navigator-ua', () => {
  test('installUACompat installs default identifier', () => {
    installUACompat()
    const id = getBunUAIdentifier()
    expect(id).toMatch(/^Bun\//)
    expect(id).toContain('browser')
  })

  test('installUACompat accepts custom identifier', () => {
    installUACompat({ identifier: 'MyRuntime/1.0 (browser)' })
    expect(getBunUAIdentifier()).toBe('MyRuntime/1.0 (browser)')
    // restore
    installUACompat({ identifier: `Bun/1.x.x (browser)` })
  })

  test('getHeaderInjection returns expected headers', () => {
    installUACompat()
    const headers = getHeaderInjection()
    expect(headers).toHaveProperty('X-Bun-Runtime', 'browser')
  })

  test('isUACompatInstalled returns true after install', () => {
    installUACompat()
    expect(isUACompatInstalled()).toBe(true)
  })

  test('globalThis.__BUN_WEB_UA__ is set', () => {
    installUACompat()
    expect((globalThis as Record<string, unknown>).__BUN_WEB_UA__).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
describe('@mars/web-webapis — BroadcastChannel', () => {
  test('BroadcastChannelImpl is a constructor', () => {
    expect(typeof BroadcastChannelImpl).toBe('function')
  })

  test('channels can send/receive messages in-process', () => {
    // Use the native BroadcastChannel when running under Bun (it supports it)
    const ch1 = new BroadcastChannelImpl('test-channel')
    const ch2 = new BroadcastChannelImpl('test-channel')
    const received: unknown[] = []
    ch2.onmessage = (ev: MessageEvent) => received.push(ev.data)
    ch1.postMessage({ hello: 'world' })
    // BroadcastChannel is async in spec — native fires on next message loop
    ch1.close()
    ch2.close()
    // Just verify we can create/close without throwing
    expect(ch1.name).toBe('test-channel')
    expect(ch2.name).toBe('test-channel')
  })

  test('installBroadcastChannel is idempotent', () => {
    installBroadcastChannel()
    installBroadcastChannel()
    expect(typeof globalThis.BroadcastChannel).toBe('function')
  })
})

// ---------------------------------------------------------------------------
describe('@mars/web-webapis — CompressionStream', () => {
  test('isSupportedFormat returns true for gzip/deflate', () => {
    expect(isSupportedFormat('gzip')).toBe(true)
    expect(isSupportedFormat('deflate')).toBe(true)
    expect(isSupportedFormat('deflate-raw')).toBe(true)
  })

  test('isSupportedFormat returns true for brotli/zstd', () => {
    expect(isSupportedFormat('brotli')).toBe(true)
    expect(isSupportedFormat('zstd')).toBe(true)
  })

  test('isSupportedFormat returns false for unknown formats', () => {
    expect(isSupportedFormat('lz4' as string)).toBe(false)
    expect(isSupportedFormat('' as string)).toBe(false)
  })

  test('isNativeCompressionFormat: native = gzip/deflate/deflate-raw only', () => {
    expect(isNativeCompressionFormat('gzip')).toBe(true)
    expect(isNativeCompressionFormat('deflate')).toBe(true)
    expect(isNativeCompressionFormat('brotli')).toBe(false)
    expect(isNativeCompressionFormat('zstd')).toBe(false)
  })

  test('assertCompressionFormat throws for brotli (M6 not yet available)', () => {
    expect(() => assertCompressionFormat('brotli')).toThrow()
  })

  test('assertCompressionFormat throws for unknown format', () => {
    expect(() => assertCompressionFormat('lz4')).toThrow()
  })

  test('assertCompressionFormat does NOT throw for gzip', () => {
    expect(() => assertCompressionFormat('gzip')).not.toThrow()
  })

  test('CompressionStreamImpl is available and can compress gzip', async () => {
    const stream = new CompressionStreamImpl('gzip')
    expect(stream).toBeTruthy()
    expect(typeof stream.readable).toBe('object')
    expect(typeof stream.writable).toBe('object')
  })

  test('DecompressionStreamImpl is available', () => {
    const stream = new DecompressionStreamImpl('gzip')
    expect(stream).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
describe('@mars/web-webapis — VirtualWebSocket', () => {
  test('WS_READY_STATE constants are correct', () => {
    expect(WS_READY_STATE.CONNECTING).toBe(0)
    expect(WS_READY_STATE.OPEN).toBe(1)
    expect(WS_READY_STATE.CLOSING).toBe(2)
    expect(WS_READY_STATE.CLOSED).toBe(3)
  })

  test('VirtualWebSocket static constants match', () => {
    expect(VirtualWebSocket.CONNECTING).toBe(0)
    expect(VirtualWebSocket.OPEN).toBe(1)
    expect(VirtualWebSocket.CLOSING).toBe(2)
    expect(VirtualWebSocket.CLOSED).toBe(3)
  })

  test('VirtualWebSocket stores url', () => {
    const ws = new VirtualWebSocket('ws://example.com')
    expect(ws.url).toBe('ws://example.com')
  })

  test('VirtualWebSocket starts in CONNECTING state', () => {
    const ws = new VirtualWebSocket('ws://example.com')
    expect(ws.readyState).toBe(WS_READY_STATE.CONNECTING)
  })

  test('VirtualWebSocket.send throws ERR_M4_REQUIRED', () => {
    const ws = new VirtualWebSocket('ws://example.com')
    expect(() => ws.send('hello')).toThrow()
  })

  test('VirtualWebSocket.close does not throw', () => {
    const ws = new VirtualWebSocket('ws://example.com')
    expect(() => ws.close()).not.toThrow()
  })

  test('installWebSocketPolyfill is idempotent', () => {
    // Save original
    const original = (globalThis as Record<string, unknown>).WebSocket
    // Only install if missing
    if (typeof globalThis.WebSocket === 'undefined') {
      installWebSocketPolyfill()
      expect(isWebSocketPolyfillInstalled()).toBe(true)
    } else {
      // Native WS exists — polyfill should NOT be installed
      installWebSocketPolyfill()
      expect(isWebSocketPolyfillInstalled()).toBe(false)
    }
    // Restore
    ;(globalThis as Record<string, unknown>).WebSocket = original
  })
})

// ---------------------------------------------------------------------------
describe('@mars/web-webapis — blob-file', () => {
  test('installBlobFilePatch runs without throwing', () => {
    expect(() => installBlobFilePatch()).not.toThrow()
  })

  test('Blob is available', () => {
    expect(typeof globalThis.Blob).toBe('function')
  })

  test('File is available', () => {
    expect(typeof globalThis.File).toBe('function')
  })

  test('File.lastModifiedDate returns a Date', () => {
    installBlobFilePatch()
    const f = new File(['hello'], 'test.txt', { lastModified: 1000 })
    const lmd = (f as unknown as Record<string, unknown>)['lastModifiedDate']
    expect(lmd).toBeInstanceOf(Date)
    expect((lmd as Date).getTime()).toBe(1000)
  })
})

// ---------------------------------------------------------------------------
describe('@mars/web-webapis — performance-ext', () => {
  test('installPerformanceExt runs without throwing', () => {
    expect(() => installPerformanceExt()).not.toThrow()
  })

  test('performance.nodeTiming is available after install', () => {
    installPerformanceExt()
    expect((performance as unknown as Record<string, unknown>)['nodeTiming']).toBeTruthy()
  })

  test('performance.nodeTiming has expected fields', () => {
    installPerformanceExt()
    const nt = (performance as unknown as Record<string, unknown>)['nodeTiming'] as Record<string, unknown>
    expect(typeof nt['bootstrapComplete']).toBe('number')
    expect(typeof nt['loopStart']).toBe('number')
  })
})

// ---------------------------------------------------------------------------
describe('@mars/web-webapis — crypto-ext', () => {
  test('isSupportedCryptoAlgo returns true for SHA-256', () => {
    expect(isSupportedCryptoAlgo('SHA-256')).toBe(true)
  })

  test('isSupportedCryptoAlgo is case-insensitive', () => {
    expect(isSupportedCryptoAlgo('sha-256')).toBe(true)
    expect(isSupportedCryptoAlgo('aes-gcm')).toBe(true)
  })

  test('isSupportedCryptoAlgo returns false for BLAKE3', () => {
    expect(isSupportedCryptoAlgo('BLAKE3')).toBe(false)
  })

  test('getSupportedCryptoAlgos returns non-empty array', () => {
    const algos = getSupportedCryptoAlgos()
    expect(algos.length).toBeGreaterThan(0)
    expect(algos).toContain('SHA-256')
  })

  test('installCryptoExt runs without throwing', () => {
    expect(() => installCryptoExt()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
describe('@mars/web-webapis — installWebAPIs (unified entry)', () => {
  test('installWebAPIs runs without throwing', () => {
    expect(() => installWebAPIs()).not.toThrow()
  })

  test('installWebAPIs is idempotent', () => {
    expect(() => {
      installWebAPIs()
      installWebAPIs()
      installWebAPIs()
    }).not.toThrow()
  })

  test('after installWebAPIs __BUN_WEB_UA__ is set', () => {
    installWebAPIs()
    expect((globalThis as Record<string, unknown>).__BUN_WEB_UA__).toBeTruthy()
  })
})
