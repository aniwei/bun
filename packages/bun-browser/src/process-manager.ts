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

import type { SpawnInitMessage } from './spawn-worker'

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

/**
 * 每个 `bun_spawn` 请求获得独立 WASM Worker Instance 的进程管理器。
 */
export class ProcessManager {
  private readonly workerUrl: string | URL
  private readonly module: WebAssembly.Module
  /** 父进程积累的全部 VFS 快照（按时间顺序）。 */
  private readonly pendingSnapshots: ArrayBuffer[]
  private readonly workerFactory: () => Worker

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
   * 创建新 Worker → 传入 module + 当前 VFS 快照列表 + 进程参数 →
   * 中继 stdout/stderr 到回调 → 等待 spawn:exit → resolve 退出码。
   *
   * @returns 子进程退出码（0 = 正常）
   */
  spawn(opts: ProcessSpawnOptions): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const worker = this.workerFactory()

      worker.addEventListener('message', (ev: MessageEvent) => {
        const msg = ev.data as { type: string; data?: string; code?: number; message?: string; stack?: string }
        switch (msg.type) {
          case 'spawn:stdout':
            opts.onStdout?.(msg.data ?? '')
            break
          case 'spawn:stderr':
            opts.onStderr?.(msg.data ?? '')
            break
          case 'spawn:error':
            opts.onStderr?.(`[spawn error] ${msg.message ?? 'unknown'}\n`)
            break
          case 'spawn:exit':
            worker.terminate()
            resolve(msg.code ?? 0)
            break
        }
      })

      worker.addEventListener('error', (e: ErrorEvent) => {
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
      }
      worker.postMessage(initMsg)
    })
  }
}
