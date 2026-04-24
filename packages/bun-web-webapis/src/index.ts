// @mars/web-webapis — Web 标准 API 补丁层 (RFC §8.3, M2-9)
//
// Usage:
//   import { installWebAPIs } from '@mars/web-webapis'
//   installWebAPIs()   // call once at boot in each Process Worker

import { installUACompat } from './navigator-ua'
import { installBroadcastChannel } from './broadcast'
import { installBlobFilePatch } from './blob-file'
import { installPerformanceExt } from './performance-ext'
import { installCryptoExt } from './crypto-ext'
import { installWebSocketPolyfill } from './websocket-patch'

export { installUACompat, getBunUAIdentifier, getHeaderInjection, isUACompatInstalled } from './navigator-ua'
export { BroadcastChannelImpl, installBroadcastChannel } from './broadcast'
export {
  CompressionStreamImpl,
  DecompressionStreamImpl,
  isSupportedFormat,
  isNativeCompressionFormat,
  assertCompressionFormat,
} from './compression'
export { VirtualWebSocket, installWebSocketPolyfill, isWebSocketPolyfillInstalled, WS_READY_STATE } from './websocket-patch'
export { installBlobFilePatch } from './blob-file'
export { installPerformanceExt } from './performance-ext'
export { installCryptoExt, isSupportedCryptoAlgo, getSupportedCryptoAlgos } from './crypto-ext'
export type { UACompatStrategy, BunNodeTiming, SupportedFormat } from './webapis.types'

/**
 * Install all Web API patches in one call.
 * Safe to call multiple times — each patch is idempotent.
 */
export function installWebAPIs(options?: {
  uaStrategy?: import('./navigator-ua').UACompatStrategy
  skipWebSocket?: boolean
}): void {
  installUACompat(options?.uaStrategy)
  installBroadcastChannel()
  installBlobFilePatch()
  installPerformanceExt()
  installCryptoExt()
  if (!options?.skipWebSocket) {
    installWebSocketPolyfill()
  }
}
