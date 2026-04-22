/**
 * ThreadPool —— Phase 5.5 T5.5.2 host 侧 pthread 孵化器。
 *
 * 与 `worker-pool.ts`（任务分发器）互补：这里每个 Worker 是"一个线程",
 * 绑定到 `bun_thread_entry(arg)` wasm export，共享主 Worker 的
 * `WebAssembly.Memory`（SharedArrayBuffer-backed），生命周期结束后才释放。
 *
 * 设计约束：
 *   - **工厂可注入**：真实浏览器场景里由 kernel 提供 `threadWorkerFactory`
 *     并在 Worker 里完成 wasm instantiate + 调用 `bun_thread_entry`；
 *     测试场景下注入 mock Worker，不依赖 wasm。
 *   - **tid 空间**：主线程固定为 0，子线程从 1 单调分配；结束后不回收
 *     （WebContainer 同样策略，避免与 Zig 侧的 tid-table 发生回收竞态）。
 *   - **能力探测**：`ThreadPool.available(memory)` 在 `SharedArrayBuffer`
 *     不可用或 `memory.buffer` 非 SAB 时返回 false，调用方应直接跳过
 *     注入 `spawnThread`，让 `jsi_thread_spawn` 回到返回 0 的默认实现。
 *
 * 协议 UI → Thread Worker：
 *   ```ts
 *   { type: "thread:start", tid: number, arg: number, memory: WebAssembly.Memory, module: WebAssembly.Module }
 *   ```
 * Thread Worker → UI：
 *   ```ts
 *   { type: "thread:exit", tid: number, code: number }
 *   | { type: "thread:error", tid: number, message: string }
 *   ```
 * 真实 Worker 需要在收到 `thread:start` 后 instantiate wasm，调用
 * `bun_thread_entry(arg)`，然后 post `thread:exit`。测试里由 mock 模拟。
 */

export type ThreadWorkerLike = {
  postMessage(msg: unknown, transfer?: Transferable[]): void
  terminate(): void
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void
  addEventListener(type: 'error', listener: (ev: unknown) => void): void
}

export type ThreadWorkerFactory = () => ThreadWorkerLike

export interface ThreadPoolOptions {
  /** 共享内存（必须是 SharedArrayBuffer-backed，否则 `available()` 返回 false）。 */
  memory: WebAssembly.Memory
  /** 已编译的 threads-enabled wasm Module（由 kernel 统一传入）。 */
  module: WebAssembly.Module
  /** 创建"线程 Worker"的工厂。 */
  factory: ThreadWorkerFactory
  /** 每个线程退出时回调（tid + 退出码）。 */
  onExit?: (tid: number, code: number) => void
  /** 线程内部未捕获异常回调。 */
  onError?: (tid: number, message: string) => void
  /** 池容量上限，默认 `navigator.hardwareConcurrency || 4`；超出 `spawn()` 返回 0。 */
  maxThreads?: number
}

interface ThreadEntry {
  tid: number
  worker: ThreadWorkerLike
  arg: number
  exited: boolean
}

type ThreadMessage =
  | { type: 'thread:exit'; tid: number; code: number }
  | { type: 'thread:error'; tid: number; message: string }

function isThreadMessage(x: unknown): x is ThreadMessage {
  if (typeof x !== 'object' || x === null) return false
  const m = x as { type?: unknown }
  return m.type === 'thread:exit' || m.type === 'thread:error'
}

/**
 * 检测当前环境是否支持 shared-memory 线程。
 *
 * - `SharedArrayBuffer` 存在（需要 COOP/COEP）
 * - 传入 `memory.buffer` 确实是 SAB（ie. wasm 模块以 shared memory import 实例化）
 */
export function threadPoolAvailable(memory: WebAssembly.Memory | undefined): boolean {
  if (!memory) return false
  if (typeof SharedArrayBuffer === 'undefined') return false
  return memory.buffer instanceof SharedArrayBuffer
}

export class ThreadPool {
  private readonly threads = new Map<number, ThreadEntry>()
  private readonly waiters = new Map<number, Array<(code: number) => void>>()
  private nextTid = 1
  private readonly memory: WebAssembly.Memory
  private readonly module: WebAssembly.Module
  private readonly factory: ThreadWorkerFactory
  private readonly onExit: ((tid: number, code: number) => void) | undefined
  private readonly onError: ((tid: number, message: string) => void) | undefined
  private readonly maxThreads: number
  private terminated = false

  constructor(opts: ThreadPoolOptions) {
    if (!threadPoolAvailable(opts.memory)) {
      throw new Error('ThreadPool requires a SharedArrayBuffer-backed WebAssembly.Memory')
    }
    this.memory = opts.memory
    this.module = opts.module
    this.factory = opts.factory
    this.onExit = opts.onExit
    this.onError = opts.onError
    const defaultCap =
      typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
        ? Math.max(1, navigator.hardwareConcurrency)
        : 4
    this.maxThreads = Math.max(1, opts.maxThreads ?? defaultCap)
  }

  /** 当前活跃线程数（尚未退出）。 */
  get activeCount(): number {
    let n = 0
    for (const e of this.threads.values()) if (!e.exited) n++
    return n
  }

  /** 已分配过的 tid（含已退出）。测试用。 */
  get totalSpawned(): number {
    return this.nextTid - 1
  }

  /**
   * 孵化一个线程。对应 `jsi_thread_spawn(arg) -> tid`。
   *
   * 返回 0 表示失败（pool 已终止 / 超出 `maxThreads`），Zig 侧应把它
   * 当作"线程创建失败"传回 user code（映射到 EAGAIN / errno=11）。
   */
  spawn(arg: number): number {
    if (this.terminated) return 0
    if (this.activeCount >= this.maxThreads) return 0

    const tid = this.nextTid++
    const worker = this.factory()
    const entry: ThreadEntry = { tid, worker, arg, exited: false }
    this.threads.set(tid, entry)

    worker.addEventListener('message', ev => this.onMessage(entry, ev.data))
    worker.addEventListener('error', e => {
      const msg =
        typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : 'worker error'
      this.failThread(entry, msg)
    })

    // 投递启动消息：真实 Worker 里会 instantiate wasm 并调用 bun_thread_entry(arg)。
    try {
      worker.postMessage({
        type: 'thread:start',
        tid,
        arg,
        memory: this.memory,
        module: this.module,
      })
    } catch (e) {
      this.failThread(entry, e instanceof Error ? e.message : String(e))
      return 0
    }

    return tid
  }

  /** 等待某线程退出（调试用；生产代码应通过 Atomics.wait 在 Zig 侧同步）。 */
  join(tid: number): Promise<number> {
    const e = this.threads.get(tid)
    if (!e) return Promise.resolve(0)
    if (e.exited) return Promise.resolve(0)
    return new Promise(resolve => {
      const list = this.waiters.get(tid) ?? []
      list.push(resolve)
      this.waiters.set(tid, list)
    })
  }

  /** 终止全部线程并释放 worker。pool 无法再 spawn。 */
  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    for (const e of this.threads.values()) {
      if (!e.exited) {
        try {
          e.worker.terminate()
        } catch {
          /* ignore */
        }
        e.exited = true
        this.drainWaiters(e.tid, -1)
      }
    }
  }

  private drainWaiters(tid: number, code: number): void {
    const list = this.waiters.get(tid)
    if (!list) return
    this.waiters.delete(tid)
    for (const r of list) {
      try {
        r(code)
      } catch {
        /* ignore */
      }
    }
  }

  private onMessage(entry: ThreadEntry, data: unknown): void {
    if (!isThreadMessage(data)) return
    if (data.tid !== entry.tid) return
    if (data.type === 'thread:exit') {
      if (entry.exited) return
      entry.exited = true
      try {
        entry.worker.terminate()
      } catch {
        /* ignore */
      }
      const code = data.code | 0
      this.onExit?.(entry.tid, code)
      this.drainWaiters(entry.tid, code)
    } else {
      this.failThread(entry, data.message)
    }
  }

  private failThread(entry: ThreadEntry, message: string): void {
    if (entry.exited) return
    entry.exited = true
    try {
      entry.worker.terminate()
    } catch {
      /* ignore */
    }
    this.onError?.(entry.tid, message)
    // 同时触发 exit(-1) 让 Zig 侧的 join/wait 能释放。
    this.onExit?.(entry.tid, -1)
    this.drainWaiters(entry.tid, -1)
  }
}
