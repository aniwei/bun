/**
 * ProcessManager — 管理以独立 WASM Instance 运行的子进程集合。
 *
 * 每次调用 `spawn()` 都会创建一个新的 `spawn-worker.ts` Worker 实例，
 * 并向其传递：
 *   - 与父进程相同的已编译 `WebAssembly.Module`（共享 module，独立 Instance）
 *   - 父进程积累的 VFS 快照列表（COW 快照语义）
 *   - 进程参数（argv / env / cwd）
 *
 * stdout/stderr 通过回调实时转发，Promise 在子进程退出后 resolve 退出码。
 */

import { sabCapability, createSabRing, SabRingConsumer } from './sab-ring'
import type { SpawnInitMessage } from './spawn-worker'

/** SAB ring 容量（字节），每个 stdout/stderr 通道独立分配。 */
const RING_CAPACITY = 65_536 // 64 KiB

/** `ProcessManager.spawn()` 的选项。 */
export interface ProcessSpawnOptions {
  /** 唯一请求 id，仅用于调用方追踪；ProcessManager 内部不使用。 */
  id: string
  /** 完整命令行参数，argv[0] = "bun"。 */
  argv: string[]
  /** 注入到 process.env 的环境变量（可选）。 */
  env?: Record<string, string> | undefined
  /** 工作目录（可选）。 */
  cwd?: string | undefined
  /** 接收子进程 stdout 流的回调（每次调用对应一次 print/write）。 */
  onStdout?: (data: string) => void
  /** 接收子进程 stderr 流的回调。 */
  onStderr?: (data: string) => void
  /**
   * 额外 VFS 快照（在 pendingSnapshots 末尾追加，比 pendingSnapshots 优先级高）。
   * 用于在每次 spawn 前注入父进程的 live VFS 状态（由 rt.dumpVfsSnapshot() 提供）。
   */
  extraSnapshots?: ArrayBuffer[] | undefined
}

/** `new ProcessManager(opts)` 的构造选项。 */
export interface ProcessManagerOptions {
  /**
   * spawn-worker.ts（或其打包产物）的 URL。
   * 在 kernel-worker 内通过 `new Worker(spawnWorkerUrl, { type: "module" })` 启动子进程。
   * 由 UI 线程的 `KernelOptions.spawnWorkerUrl` 经握手消息传入。
   */
  workerUrl: string | URL
  /** 已编译的 WebAssembly.Module（与父进程共享，子进程各自创建独立 Instance）。 */
  module: WebAssembly.Module
  /**
   * 初始 VFS 快照（handshake 时的 vfsSnapshot 字节，若存在）。
   * 后续可通过 `trackVfsSnapshot()` 追加。
   */
  initialSnapshot?: ArrayBuffer | undefined
  /**
   * Worker 工厂（可选，默认 `() => new Worker(workerUrl, { type: "module" })`）。
   *
   * 主要用于测试中注入 mock Worker，避免污染 `globalThis.Worker`。
   * 在生产代码中无需设置。
   */
  workerFactory?: (() => Worker) | undefined
}

/** 正在运行的 spawn Worker 状态（用于 kill 支持）。 */
interface ActiveSpawn {
  worker: Worker
  /** T5.12.3: 信号缓冲区（若 SAB 可用）；写入非零值即触发受控退出。 */
  signalBuffer: SharedArrayBuffer | ArrayBuffer | undefined
}

/**
 * 每个 `bun_spawn` 请求获得独立 WASM Worker Instance 的进程管理器。
 */
export class ProcessManager {
  private readonly workerUrl: string | URL
  private readonly module: WebAssembly.Module
  /** 父进程积累的全部 VFS 快照（按时间顺序）。 */
  private readonly pendingSnapshots: ArrayBuffer[]
  private readonly workerFactory: () => Worker
  /** T5.12.3: 正在运行的 spawn Worker 映射，键为 spawn id。 */
  private readonly activeSpawns = new Map<string, ActiveSpawn>()

  constructor(opts: ProcessManagerOptions) {
    this.workerUrl = opts.workerUrl
    this.module = opts.module
    this.pendingSnapshots = opts.initialSnapshot ? [opts.initialSnapshot] : []
    this.workerFactory = opts.workerFactory ?? (() => new Worker(this.workerUrl, { type: 'module' }))
  }

  /**
   * 追踪一个新的 VFS 快照（在 kernel-worker 每次处理 `vfs:snapshot` 消息时调用）。
   *
   * 后续所有 spawn 调用都会将该快照传给子进程，重建与父进程相同的 VFS 状态。
   */
  trackVfsSnapshot(snapshot: ArrayBuffer): void {
    this.pendingSnapshots.push(snapshot)
  }

  /**
   * 在独立 WASM Worker 中执行一条命令。
   *
   * T5.12.2：当 SharedArrayBuffer 可用时，为 stdout/stderr 各创建一个 SAB ring；
   * spawn-worker 写入 ring 并发送 `spawn:flush` 通知；此处 drain ring 后调用回调。
   * SAB 不可用时回退到 `spawn:stdout`/`spawn:stderr` postMessage 字符串路径。
   *
   * T5.12.3：创建信号缓冲区（SharedArrayBuffer | ArrayBuffer）；
   * `ProcessManager.kill()` 向其写入信号值，spawn-worker 在检查点退出。
   *
   * @returns 子进程退出码（0 = 正常）
   */
  spawn(opts: ProcessSpawnOptions): Promise<number> {
    // ── T5.12.2/3: 能力探测 ──────────────────────────────────────────────
    const { sab } = sabCapability()
    const stdoutRing = sab ? createSabRing(RING_CAPACITY) : undefined
    const stderrRing = sab ? createSabRing(RING_CAPACITY) : undefined
    const stdoutConsumer = stdoutRing ? new SabRingConsumer(stdoutRing) : undefined
    const stderrConsumer = stderrRing ? new SabRingConsumer(stderrRing) : undefined
    const signalBuffer: SharedArrayBuffer | ArrayBuffer | undefined = sab
      ? new SharedArrayBuffer(4)
      : typeof ArrayBuffer !== 'undefined'
        ? new ArrayBuffer(4) // 测试环境 fallback：ArrayBuffer 不跨 Worker 共享，仅本地用
        : undefined

    const decoder = new TextDecoder()

    /** 从环形缓冲中 drain 所有可读字节，UTF-8 解码后调用回调。 */
    const drainRing = (consumer: SabRingConsumer | undefined, cb: ((s: string) => void) | undefined): void => {
      if (!consumer || !cb) return
      const tmp = new Uint8Array(4096)
      let n: number
      while ((n = consumer.read(tmp)) > 0) {
        cb(decoder.decode(tmp.subarray(0, n)))
      }
    }

    return new Promise<number>((resolve, reject) => {
      const worker = this.workerFactory()

      // T5.12.3: 注册活跃 spawn，供 kill() 使用
      if (opts.id) {
        this.activeSpawns.set(opts.id, { worker, signalBuffer })
      }

      worker.addEventListener('message', (ev: MessageEvent) => {
        const msg = ev.data as { type: string; data?: string; code?: number; message?: string; stack?: string }
        switch (msg.type) {
          case 'spawn:stdout':
            // postMessage 回退路径（无 SAB ring 时由 spawn-worker 发出）
            opts.onStdout?.(msg.data ?? '')
            break
          case 'spawn:stderr':
            opts.onStderr?.(msg.data ?? '')
            break
          case 'spawn:flush':
            // T5.12.2: SAB ring 有新数据，drain 后调用回调
            drainRing(stdoutConsumer, opts.onStdout)
            drainRing(stderrConsumer, opts.onStderr)
            break
          case 'spawn:error':
            opts.onStderr?.(`[spawn error] ${msg.message ?? 'unknown'}\n`)
            break
          case 'spawn:exit':
            // T5.12.2: 最终 drain（spawn-worker 已 close() 环形缓冲后才发 exit）
            drainRing(stdoutConsumer, opts.onStdout)
            drainRing(stderrConsumer, opts.onStderr)
            if (opts.id) this.activeSpawns.delete(opts.id)
            worker.terminate()
            resolve(msg.code ?? 0)
            break
        }
      })

      worker.addEventListener('error', (e: ErrorEvent) => {
        if (opts.id) this.activeSpawns.delete(opts.id)
        worker.terminate()
        reject(new Error(e.message ?? 'spawn worker crashed'))
      })

      const snapshots = [...this.pendingSnapshots, ...(opts.extraSnapshots ?? [])]
      const initMsg: SpawnInitMessage = {
        type: 'spawn:init',
        module: this.module,
        vfsSnapshots: snapshots,
        argv: opts.argv,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(stdoutRing !== undefined ? { stdoutRing } : {}),
        ...(stderrRing !== undefined ? { stderrRing } : {}),
        ...(signalBuffer !== undefined ? { signalBuffer } : {}),
      }
      worker.postMessage(initMsg)
    })
  }

  /**
   * T5.12.3: 向指定 spawn 发送信号。
   *
   * - 若 SAB 信号缓冲区可用，先写入信号值（spawn-worker 会在下个检查点响应）。
   * - 然后通过 Worker.terminate() 立即强制终止（确保不会挂起）。
   * - 信号值遵循 POSIX：15=SIGTERM, 9=SIGKILL, 2=SIGINT。
   *
   * @param id    对应 ProcessSpawnOptions.id
   * @param signal 信号编号（默认 15=SIGTERM）
   */
  kill(id: string, signal = 15): void {
    const entry = this.activeSpawns.get(id)
    if (!entry) return
    // T5.12.3: 写入信号值（SAB 时跨 Worker 可见；ArrayBuffer fallback 本地可见）
    if (entry.signalBuffer) {
      Atomics.store(new Int32Array(entry.signalBuffer), 0, signal)
    }
    // 终止 Worker（立即生效；即使 Zig 代码正在运行也会中断）
    entry.worker.terminate()
    this.activeSpawns.delete(id)
  }
}
