/**
 * atomicWait —— 跨环境的 `Atomics.wait` / `Atomics.waitAsync` 抽象。
 *
 * 为 WASM 侧 `jsi_atomic_wait` 提供统一的调度器：
 *   - Worker + SAB：`Atomics.wait` 真阻塞。
 *   - 主线程 + SAB：`Atomics.waitAsync` 返回 Promise。
 *   - 无 SAB / 无 waitAsync：microtask 轮询降级。
 */

export type WaitResult = 'ok' | 'not-equal' | 'timed-out' | 'closed'

export interface AtomicWaitCapability {
  sab: boolean
  inWorker: boolean
  sync: boolean
  async: boolean
}

export function detectAtomicWait(): AtomicWaitCapability {
  const sab = typeof SharedArrayBuffer !== 'undefined'
  const A = (typeof Atomics !== 'undefined' ? Atomics : undefined) as
    | (typeof Atomics & { waitAsync?: (...a: unknown[]) => unknown })
    | undefined
  const inWorker = typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined'
  return {
    sab,
    inWorker,
    sync: sab && inWorker && typeof A?.wait === 'function',
    async: sab && typeof A?.waitAsync === 'function',
  }
}

/**
 * Wait until `view[index]` differs from `expected`, or timeout elapses.
 * Returns immediately if the value already differs.
 *
 * 仅在 Worker + SAB 下可用同步阻塞模式；否则回退到 microtask polling。
 * 主线程上请使用 `atomicWaitAsync`。
 */
export function atomicWaitSync(
  view: Int32Array,
  index: number,
  expected: number,
  timeoutMs: number = Infinity,
): WaitResult {
  const cap = detectAtomicWait()
  if (cap.sync) {
    const r = Atomics.wait(view, index, expected, timeoutMs)
    if (r === 'ok') return 'ok'
    if (r === 'not-equal') return 'not-equal'
    return 'timed-out'
  }
  // busy polling fallback (仅用于单线程单元测试；生产路径应使用 async 变体)
  const deadline = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY
  while (Date.now() < deadline) {
    if (Atomics.load(view, index) !== expected) return 'ok'
  }
  return Atomics.load(view, index) !== expected ? 'ok' : 'timed-out'
}

/** Promise 版本，主线程/无-Worker 场景使用。 */
export async function atomicWaitAsync(
  view: Int32Array,
  index: number,
  expected: number,
  timeoutMs: number = Infinity,
): Promise<WaitResult> {
  const cap = detectAtomicWait()
  if (cap.async) {
    const A = Atomics as typeof Atomics & {
      waitAsync(
        view: Int32Array,
        index: number,
        value: number,
        timeout?: number,
      ): { async: boolean; value: Promise<'ok' | 'not-equal' | 'timed-out'> | 'not-equal' | 'timed-out' | 'ok' }
    }
    const res = A.waitAsync(view, index, expected, timeoutMs)
    const v = res.async
      ? await (res.value as Promise<'ok' | 'not-equal' | 'timed-out'>)
      : (res.value as 'ok' | 'not-equal' | 'timed-out')
    if (v === 'ok') return 'ok'
    if (v === 'not-equal') return 'not-equal'
    return 'timed-out'
  }
  // microtask polling fallback
  const deadline = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY
  // 初始化即检测一次
  if (Atomics.load(view, index) !== expected) return 'not-equal'
  while (Date.now() < deadline) {
    await new Promise<void>(r => {
      // 使用 setTimeout(0) 而非 queueMicrotask，让 event loop 有机会处理消息
      setTimeout(r, 1)
    })
    if (Atomics.load(view, index) !== expected) return 'ok'
  }
  return 'timed-out'
}

/**
 * 唤醒最多 `count` 个等待者。非 SAB 环境下静默成功（状态位由 store 更新）。
 */
export function atomicNotify(view: Int32Array, index: number, count: number = Infinity): number {
  try {
    return Atomics.notify(view, index, count)
  } catch {
    return 0
  }
}
