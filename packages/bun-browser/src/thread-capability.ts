/**
 * T5.5.3 — Cross-Origin Isolation 能力探测与 wasm-threads 初始化。
 *
 * wasm-threads 需要两个前提条件同时成立：
 *   1. `crossOriginIsolated === true`（COOP + COEP 响应头已就绪）
 *   2. `SharedArrayBuffer` 可调用
 *
 * 服务端需发两个响应头：
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * 若任一条件不满足，自动降级到单线程 bun-core.wasm。
 */

/** 当前环境的线程能力快照。 */
export interface ThreadCapability {
  /** `globalThis.crossOriginIsolated === true`（COOP+COEP 已启用）。 */
  crossOriginIsolated: boolean
  /** `SharedArrayBuffer` 类存在且可构造。 */
  sharedArrayBuffer: boolean
  /**
   * 完全具备 wasm-threads 能力（上两项均为 true）。
   * 只有 `threadsReady=true` 时才应该传入 `KernelOptions.threadsWasmModule`。
   */
  threadsReady: boolean
  /**
   * 环境处于 Web Worker 内部。
   * Worker 内可用 `Atomics.wait` 真阻塞；主线程只能用 `Atomics.waitAsync`。
   */
  inWorker: boolean
  /**
   * `Atomics.waitAsync` 可用（Chrome 87+, Firefox 100+, Safari 16.4+）。
   * 主线程异步等待的必要条件。
   */
  atomicsWaitAsync: boolean
}

/**
 * 探测当前环境是否具备 wasm-threads 所需能力。
 *
 * 可在 UI 线程或 Worker 内调用；结果仅依赖运行环境，无副作用。
 *
 * ```ts
 * const cap = detectThreadCapability();
 * const module = cap.threadsReady ? threadsModule : singleModule;
 * const kernel = new Kernel({ wasmModule: module, threadsCapability: cap, ... });
 * ```
 */
export function detectThreadCapability(): ThreadCapability {
  const coi =
    typeof (globalThis as { crossOriginIsolated?: unknown }).crossOriginIsolated === 'boolean'
      ? (globalThis as { crossOriginIsolated: boolean }).crossOriginIsolated
      : false

  const sabOk =
    typeof SharedArrayBuffer !== 'undefined' &&
    (() => {
      try {
        new SharedArrayBuffer(0)
        return true
      } catch {
        return false
      }
    })()

  const inWorker =
    typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined' ||
    typeof (globalThis as { importScripts?: unknown }).importScripts === 'function'

  const atomicsWaitAsync =
    typeof Atomics !== 'undefined' && typeof (Atomics as { waitAsync?: unknown }).waitAsync === 'function'

  return {
    crossOriginIsolated: coi,
    sharedArrayBuffer: sabOk,
    threadsReady: coi && sabOk,
    inWorker,
    atomicsWaitAsync,
  }
}

/**
 * 为 threads wasm 构造一个 SharedArrayBuffer-backed `WebAssembly.Memory`。
 *
 * threads wasm 使用 `import_memory = true`  ——  宿主必须传入共享 Memory，而不是
 * 让 wasm 自己定义。这里按照 `build-wasm-smoke.zig` 设定的值分配：
 *   - `initial = 256 pages（16 MiB）`
 *   - `maximum = 4096 pages（256 MiB）`
 *   - `shared = true`
 *
 * 若 `SharedArrayBuffer` / `WebAssembly.Memory` 不可用或构造失败，返回 `undefined`。
 */
export function createSharedMemory(initialPages = 256, maximumPages = 4096): WebAssembly.Memory | undefined {
  if (typeof SharedArrayBuffer === 'undefined') return undefined
  try {
    return new WebAssembly.Memory({ initial: initialPages, maximum: maximumPages, shared: true })
  } catch {
    return undefined
  }
}

/**
 * 根据能力探测结果选择合适的 WASM 模块。
 *
 * @param singleModule  非线程版 bun-core.wasm（必须提供）
 * @param threadsModule 线程版 bun-core.threads.wasm（可选）
 * @param cap           能力探测结果；省略时内部调用 `detectThreadCapability()`
 * @returns `{ module, threaded, sharedMemory }` 三元组
 */
export function selectWasmModule(
  singleModule: WebAssembly.Module,
  threadsModule: WebAssembly.Module | undefined,
  cap?: ThreadCapability,
): { module: WebAssembly.Module; threaded: boolean; sharedMemory: WebAssembly.Memory | undefined } {
  const c = cap ?? detectThreadCapability()
  if (c.threadsReady && threadsModule) {
    const sharedMemory = createSharedMemory()
    if (sharedMemory) {
      return { module: threadsModule, threaded: true, sharedMemory }
    }
  }
  return { module: singleModule, threaded: false, sharedMemory: undefined }
}
