export interface MarsRuntimeCapabilities {
  serviceWorker: boolean
  sharedArrayBuffer: boolean
  atomicsWait: boolean
  opfs: boolean
  webCrypto: boolean
  worker: boolean
  crossOriginIsolated: boolean
  broadcastChannel: boolean
  indexedDB: boolean
}

export function detectMarsCapabilities(scope: typeof globalThis = globalThis): MarsRuntimeCapabilities {
  const navigatorLike = scope.navigator as (Navigator & {
    storage?: StorageManager & {
      getDirectory?: () => Promise<unknown>
    }
  }) | undefined

  return {
    serviceWorker: Boolean(navigatorLike && "serviceWorker" in navigatorLike),
    sharedArrayBuffer: typeof scope.SharedArrayBuffer === "function",
    atomicsWait: typeof scope.SharedArrayBuffer === "function" && typeof Atomics.wait === "function",
    opfs: typeof navigatorLike?.storage?.getDirectory === "function",
    webCrypto: Boolean(scope.crypto?.subtle),
    worker: typeof scope.Worker === "function",
    crossOriginIsolated: Boolean((scope as typeof globalThis & { crossOriginIsolated?: boolean }).crossOriginIsolated),
    broadcastChannel: typeof (scope as typeof globalThis & { BroadcastChannel?: unknown }).BroadcastChannel === "function",
    indexedDB: Boolean((scope as typeof globalThis & { indexedDB?: unknown }).indexedDB),
  }
}
