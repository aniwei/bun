/**
 * Kernel client —— 运行在 UI 线程，封装 Worker 生命周期与消息协议。
 */

import {
  PROTOCOL_VERSION,
  type HostRequest,
  type KernelEvent,
  type VfsSnapshotRequest,
  type SpawnRequest,
  type SpawnKillRequest,
  type ServeFetchRequest,
  type InstallRequest,
  type FsReadFileRequest,
  type FsReaddirRequest,
  type FsStatRequest,
  type FsMkdirRequest,
  type FsRmRequest,
  type FsRenameRequest,
  type FsWatchRequest,
  type FsUnwatchRequest,
  type FsDirEntry,
  type FsStatInfo,
} from './protocol'
import {
  buildSnapshot,
  parseSnapshot,
  fileSystemTreeToVfsFiles,
  vfsFilesToFileSystemTree,
  type VfsFile,
  type FileSystemTree,
} from './vfs-client'
import { PreviewPortRegistry, buildPreviewUrl } from './preview-router'
import { detectThreadCapability, createSharedMemory } from './thread-capability'

type WasmModuleLike =
  | WebAssembly.Module
  | {
      module: WebAssembly.Module
      instance?: WebAssembly.Instance | undefined
    }

function normalizeWasmModule(input: WasmModuleLike, optionName: 'wasmModule' | 'threadsWasmModule'): WebAssembly.Module {
  if (input instanceof WebAssembly.Module) return input
  if (input.module instanceof WebAssembly.Module) return input.module
  throw new TypeError(
    `[Kernel] ${optionName} must be a WebAssembly.Module or an object containing { module: WebAssembly.Module }`,
  )
}

// ---------------------------------------------------------------------------
// Phase 5.14: Service Worker 桥接 API
// ---------------------------------------------------------------------------

/** SW fetch 消息的协议类型（service-worker.ts → Kernel 方向）。 */
export type SwFetchMessage = {
  type: 'fetch'
  id: string
  port: number
  url: string
  method: string
  headers: Record<string, string>
  body?: string | undefined
}

/**
 * `ServiceWorker` 注册选项。
 *
 * 传给 `Kernel.attachServiceWorker()` 或 `WebContainer.boot({ serviceWorker })`。
 */
export interface ServiceWorkerOptions {
  /** service-worker 脚本 URL（通常为打包产物 `bun-preview-sw.js` 的路径）。 */
  scriptUrl: string | URL
  /** SW 作用域（默认 `'/__bun_preview__/'`）。 */
  scope?: string | undefined
  /**
   * 是否向预览响应注入 `cross-origin-embedder-policy: require-corp` /
   * `cross-origin-opener-policy: same-origin` 头（默认 `false`）。
   *
   * - `true` — 始终注入。
   * - `false` / `undefined` — 不注入。
   * - `'auto'` — T5.14.2：根据 Kernel 工作线程是否运行在 threaded 模式自动决定。
   *
   * 仅在需要跨源隔离（使用 SharedArrayBuffer / wasm-threads）的场景下开启。
   */
  injectIsolationHeaders?: boolean | 'auto' | undefined
  /**
   * fetch 超时毫秒数；`0` 表示不限制超时（默认 `30000`）。
   *
   * 若上游有长轮询 / SSE 响应，应将此值设为 `0`。
   */
  fetchTimeoutMs?: number | undefined
  /**
   * T5.14.3 — 是否向 `text/html` 预览响应注入 iframe bridge 脚本（默认 `false`）。
   *
   * 注入后 iframe 内的脚本可通过 `window.parent.postMessage` 将消息路由到
   * Kernel 的 `on("preview-message")` listener；反向也可从父页面向 iframe 内
   * `dispatchEvent` 转发消息。
   */
  injectBridgeScript?: boolean | undefined
}

/**
 * 处理来自 ServiceWorker 的 fetch 消息，将其路由到 `fetchFn` 后把结果回发给 SW。
 *
 * 此函数作为独立导出，方便在不实例化 Kernel 的环境中进行单元测试。
 *
 * @internal
 */
export function handleSwFetchMessage(
  msg: SwFetchMessage,
  fetchFn: (
    port: number,
    init: { url: string; method: string; headers: Record<string, string>; body?: string | undefined },
  ) => Promise<{ status: number; statusText?: string | undefined; headers: Record<string, string>; body: string }>,
  replyPort: { postMessage(m: unknown): void },
): void {
  const { id, port, url, method, headers, body } = msg
  fetchFn(port, { url, method, headers, ...(body !== undefined ? { body } : {}) })
    .then(r => {
      replyPort.postMessage({
        type: 'fetch:response',
        id,
        status: r.status,
        ...(r.statusText !== undefined ? { statusText: r.statusText } : {}),
        headers: r.headers,
        body: r.body,
      })
    })
    .catch((e: Error) => {
      replyPort.postMessage({ type: 'fetch:error', id, error: e.message })
    })
}

/** @internal 等待 ServiceWorkerRegistration 中的 SW 进入 activated 状态。 */
function _waitForSWActive(reg: ServiceWorkerRegistration): Promise<ServiceWorker> {
  return new Promise<ServiceWorker>((resolve, reject) => {
    const worker = reg.installing ?? reg.waiting
    if (!worker) {
      reject(new Error('[Kernel] SW registration has no pending worker'))
      return
    }
    const onStateChange = (): void => {
      if (worker.state === 'activated') {
        worker.removeEventListener('statechange', onStateChange)
        resolve(worker)
      } else if (worker.state === 'redundant') {
        worker.removeEventListener('statechange', onStateChange)
        reject(new Error('[Kernel] SW became redundant during activation'))
      }
    }
    worker.addEventListener('statechange', onStateChange)
  })
}

export interface KernelOptions {
  /**
   * 已编译的 bun-core.wasm 模块。
   *
   * 支持直接传入 `WebAssembly.Module`，或传入 `{ module }` 形状对象
   * （例如 `WebAssembly.instantiate*` 返回值或 bun-browser `WasmRuntime`）。
   */
  wasmModule: WasmModuleLike
  /**
   * 已编译的 bun-core-threads.wasm 模块（可选）。
   *
   * 若当前环境支持跨源隔离（`crossOriginIsolated === true`）且提供了此模块，
   * Kernel 会在握手时传给 Worker，Worker 将优先使用多线程模式启动 WASM。
   */
  threadsWasmModule?: WasmModuleLike | undefined
  /** Worker URL（通常由打包器在 import.meta.url 下解析 kernel-worker.ts）。 */
  workerUrl: string | URL
  /**
   * spawn-worker.ts（或其打包产物）的 URL（可选）。
   *
   * 若提供，每次 `kernel.spawn(argv)` 调用都会在独立 WASM Worker Instance 中运行
   * 子命令（真正的进程隔离）。若不提供，则回退到 in-process `bun_spawn` 行为。
   *
   * 示例：`new URL('./spawn-worker.ts', import.meta.url).href`
   */
  spawnWorkerUrl?: string | URL | undefined
  /** 初始 VFS 内容。 */
  initialFiles?: VfsFile[]
  /** 握手后首次运行前设置到 process.argv（不含前置的 "bun"）。 */
  argv?: string[]
  /** 握手后首次运行前设置到 process.env。 */
  env?: Record<string, string>
  /**
   * 握手完成后自动运行的入口文件路径（VFS 内绝对路径）。
   * 仅在 Worker 已加载 VFS 内容后才有效，应与 `initialFiles` 配合使用。
   */
  entry?: string
  /** 事件回调。 */
  onStdout?: (data: string) => void
  onStderr?: (data: string) => void
  onExit?: (code: number) => void
  onError?: (err: { message: string; stack?: string | undefined }) => void
}

type PendingEval = { resolve: () => void; reject: (e: Error) => void }
type PendingSpawn = { resolve: (code: number) => void; reject: (e: Error) => void }
type PendingServeFetch = {
  resolve: (r: { status: number; statusText?: string; headers: Record<string, string>; body: string }) => void
  reject: (e: Error) => void
}
type InstallProgressFromWorker = {
  name: string
  version?: string | undefined
  phase: 'metadata' | 'tarball' | 'extract' | 'done'
}
type InstallResultFromWorker = {
  packages: { name: string; version: string; fileCount: number; dependencies: Record<string, string> }[]
  lockfile: {
    lockfileVersion: 1
    workspaceCount: 1
    packageCount: number
    packages: { key: string; name: string; version: string }[]
  }
}
type PendingInstall = {
  resolve: (r: InstallResultFromWorker) => void
  reject: (e: Error) => void
  onProgress?: (p: InstallProgressFromWorker) => void
}
type PendingFsRead = { resolve: (data: ArrayBuffer) => void; reject: (e: Error) => void; encoding?: 'utf8' | 'binary' }
type PendingFsReadText = { resolve: (text: string) => void; reject: (e: Error) => void }
type PendingFsReaddir = { resolve: (entries: FsDirEntry[]) => void; reject: (e: Error) => void }
type PendingFsStat = { resolve: (stat: FsStatInfo) => void; reject: (e: Error) => void }
type PendingFsVoid = { resolve: () => void; reject: (e: Error) => void }

// ---------------------------------------------------------------------------
// ProcessHandle —— WebContainer 兼容的进程句柄
// ---------------------------------------------------------------------------

/**
 * `kernel.process()` 返回的进程句柄，提供 WebContainer 兼容的 Streams API。
 *
 * - `output`：合并的 stdout + stderr ReadableStream
 * - `stdout` / `stderr`：独立的单流（bun-browser 扩展）
 * - `exit`：Promise<number>，resolve 为退出码
 * - `kill(signal?)`：终止进程（当前为 stub，T5.12.3 实现真实信号）
 * - `input`：WritableStream<string>（当前为 stub，T5.12.2 实现 SAB stdin）
 */
export class ProcessHandle {
  readonly output: ReadableStream<string>
  readonly stdout: ReadableStream<string>
  readonly stderr: ReadableStream<string>
  readonly exit: Promise<number>

  /** @internal */
  _outputController!: ReadableStreamDefaultController<string>
  /** @internal */
  _stdoutController!: ReadableStreamDefaultController<string>
  /** @internal */
  _stderrController!: ReadableStreamDefaultController<string>
  /** @internal */
  _resolveExit!: (code: number) => void
  /** @internal */
  _rejectExit!: (err: Error) => void
  /** @internal — true once _complete/_error has been called */
  _done = false
  /**
   * @internal T5.12.3: Kill function injected by Kernel.process().
   * Called by kill() to route the signal through to the kernel worker.
   */
  _killFn: ((signal: number) => void) | undefined = undefined

  constructor(readonly id: string) {
    this.output = new ReadableStream<string>({ start: ctrl => { this._outputController = ctrl } })
    this.stdout = new ReadableStream<string>({ start: ctrl => { this._stdoutController = ctrl } })
    this.stderr = new ReadableStream<string>({ start: ctrl => { this._stderrController = ctrl } })
    this.exit = new Promise<number>((resolve, reject) => {
      this._resolveExit = resolve
      this._rejectExit = reject
    })
  }

  /** @internal 推送 stdout 数据到 output + stdout 流。 */
  _pushStdout(data: string): void {
    if (this._done) return
    this._outputController.enqueue(data)
    this._stdoutController.enqueue(data)
  }

  /** @internal 推送 stderr 数据到 output + stderr 流。 */
  _pushStderr(data: string): void {
    if (this._done) return
    this._outputController.enqueue(data)
    this._stderrController.enqueue(data)
  }

  /** @internal 进程正常结束，关闭所有流并 resolve exit Promise。 */
  _complete(code: number): void {
    if (this._done) return
    this._done = true
    this._outputController.close()
    this._stdoutController.close()
    this._stderrController.close()
    this._resolveExit(code)
  }

  /** @internal 进程出错，关闭流并 reject exit Promise。 */
  _error(err: Error): void {
    if (this._done) return
    this._done = true
    this._outputController.error(err)
    this._stdoutController.error(err)
    this._stderrController.error(err)
    this._rejectExit(err)
  }

  /**
   * 终止进程。
   *
   * 将信号通过 `spawn:kill` 消息路由到 kernel-worker，由 ProcessManager.kill() 处理。
   * 支持 POSIX 数字信号（9/15/2）或字符串名称（"SIGKILL"/"SIGTERM"/"SIGINT"）。
   *
   * @param signal 信号名或数字（默认 "SIGTERM" / 15）
   */
  kill(signal?: string | number): void {
    const sigNum =
      signal === undefined ? 15
      : typeof signal === 'number' ? signal
      : signal === 'SIGKILL' ? 9
      : signal === 'SIGINT' ? 2
      : 15
    this._killFn?.(sigNum)
  }

  /**
   * 调整 PTY 窗口大小。
   * 当前为 stub（T5.14 实现 PTY 协议对接）。
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  resize(_cols: number, _rows: number): void {
    // TODO: T5.14 — PTY resize
  }

  /** stdin WritableStream（当前为 no-op stub，T5.12.2 实现 SAB ring stdin）。 */
  get input(): WritableStream<string> {
    return new WritableStream({ write: () => {} })
  }
}

// ---------------------------------------------------------------------------
// Kernel 事件类型（on/off API）
// ---------------------------------------------------------------------------

/** `Kernel.on("port", listener)` 回调参数。 */
export interface KernelPortEvent {
  /** Bun.serve({ port }) 绑定的端口号。 */
  port: number
  /** 预览 URL（基于 origin + preview-router 规则，仅在浏览器环境有意义）。 */
  url: string
}

/**
 * `Kernel.on("preview-message", listener)` 回调参数。
 *
 * 当预览 iframe 内的脚本调用 `window.parent.postMessage(data, '*')` 时，
 * Kernel 的 window.message 监听器捕获后触发此事件。
 */
export interface KernelPreviewMessageEvent {
  /** iframe 通过 `postMessage` 发送的原始数据。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  /** 消息来源（`MessageEventSource`，可用于向 iframe 回复）。 */
  source: MessageEventSource | null
  /** 消息来源的 origin。 */
  origin: string
}

type KernelEventMap = {
  port: KernelPortEvent
  'server-ready': KernelPortEvent
  /** 来自预览 iframe 的 postMessage 事件。 */
  'preview-message': KernelPreviewMessageEvent
}

/** Handle returned by `Kernel.watch()`, call `close()` to unsubscribe. */
export interface WatchHandle {
  close(): void
}

type WatchEntry = {
  path: string
  recursive: boolean
  fn: (eventType: 'rename' | 'change', filename: string) => void
}

export class Kernel {
  private worker: Worker
  private ready: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (e: unknown) => void

  private pendingEvals = new Map<string, PendingEval>()
  private pendingSpawns = new Map<string, PendingSpawn>()
  private pendingServeFetches = new Map<string, PendingServeFetch>()
  private pendingInstalls = new Map<string, PendingInstall>()
  private pendingFsReads = new Map<string, PendingFsRead | PendingFsReadText>()
  private pendingFsReaddirs = new Map<string, PendingFsReaddir>()
  private pendingFsStats = new Map<string, PendingFsStat>()
  private pendingFsMkdirs = new Map<string, PendingFsVoid>()
  private pendingFsRms = new Map<string, PendingFsVoid>()
  private pendingFsRenames = new Map<string, PendingFsVoid>()
  /** Active watch registrations. */
  private readonly watchEntries = new Map<string, WatchEntry>()
  private watchCounter = 0
  /** 进程句柄映射（streamOutput=true 的 spawn）。 */
  private pendingProcesses = new Map<string, ProcessHandle>()
  /** port / server-ready 事件 listeners。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly eventListeners = new Map<string, Set<(ev: any) => void>>()
  /** 已注册的预览端口（供 ServiceWorker 同步）。 */
  readonly previewPorts = new PreviewPortRegistry()
  /** 当前附加的 ServiceWorker MessagePort（接收 SW 的 fetch 消息）。 */
  private _swPort: MessagePort | null = null
  /** 当前附加的 ServiceWorkerRegistration。 */
  private _swRegistration: ServiceWorkerRegistration | null = null
  /** T5.14.2：记录 Worker 实际运行模式（来自 HandshakeAck）。 */
  private _threadMode: 'threaded' | 'single' | undefined = undefined

  constructor(private readonly opts: KernelOptions) {
    this.worker = new Worker(opts.workerUrl, { type: 'module' })
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.worker.addEventListener('message', this.onMessage)
    this.worker.addEventListener('error', e => this.rejectReady(e))

    const wasmModule = normalizeWasmModule(opts.wasmModule, 'wasmModule')

    const vfsSnapshot = opts.initialFiles ? buildSnapshot(opts.initialFiles) : undefined
    const transfer: Transferable[] = vfsSnapshot ? [vfsSnapshot] : []

    // 若提供了 threads 模块且当前环境支持跨源隔离，在握手时传入线程所需资源。
    let threadsWasmModule: WebAssembly.Module | undefined
    let sharedMemory: WebAssembly.Memory | undefined
    if (opts.threadsWasmModule) {
      const cap = detectThreadCapability()
      if (cap.threadsReady) {
        threadsWasmModule = normalizeWasmModule(opts.threadsWasmModule, 'threadsWasmModule')
        sharedMemory = createSharedMemory()
      }
    }

    this.post({
      kind: 'handshake',
      protocolVersion: PROTOCOL_VERSION,
      wasmModule,
      vfsSnapshot,
      entry: opts.entry,
      argv: opts.argv,
      env: opts.env,
      ...(threadsWasmModule !== undefined ? { threadsWasmModule } : {}),
      ...(sharedMemory !== undefined ? { sharedMemory } : {}),
      // 传递 spawn-worker URL，让 kernel-worker 可以创建独立 WASM 子进程
      ...(opts.spawnWorkerUrl !== undefined ? { spawnWorkerUrl: String(opts.spawnWorkerUrl) } : {}),
    }, transfer)
  }

  private onMessage = (ev: MessageEvent<KernelEvent>): void => {
    const msg = ev.data
    switch (msg.kind) {
      case 'handshake:ack':
        // T5.14.2: 记录 Worker 实际运行樖式，供 attachServiceWorker 自动决定 COOP/COEP。
        this._threadMode = msg.threadMode
        break
      case 'ready':
        this.resolveReady()
        break
      case 'stdout':
        this.opts.onStdout?.(msg.data)
        break
      case 'stderr':
        this.opts.onStderr?.(msg.data)
        break
      case 'exit':
        this.opts.onExit?.(msg.code)
        break
      case 'error':
        this.opts.onError?.({ message: msg.message, stack: msg.stack })
        break
      case 'port': {
        const origin = typeof location !== 'undefined' && location?.origin ? location.origin : 'http://localhost'
        const url = buildPreviewUrl(origin, msg.port, '/')
        const portEv: KernelPortEvent = { port: msg.port, url }
        this._emit('port', portEv)
        this._emit('server-ready', portEv)
        this.previewPorts.add(msg.port)
        break
      }
      // T5.14.1: Bun.serve.stop() 导致 __bun_routes 中的 key 被删除，发送此事件。
      case 'port:close': {
        this.previewPorts.remove(msg.port)
        this._emit('port:close', { port: msg.port })
        break
      }
      case 'spawn:stdout': {
        this.pendingProcesses.get(msg.id)?._pushStdout(msg.data)
        break
      }
      case 'spawn:stderr': {
        this.pendingProcesses.get(msg.id)?._pushStderr(msg.data)
        break
      }
      case 'eval:result': {
        const pending = this.pendingEvals.get(msg.id)
        if (pending) {
          this.pendingEvals.delete(msg.id)
          if (msg.error) pending.reject(new Error(msg.error))
          else pending.resolve()
        }
        break
      }
      case 'spawn:exit': {
        const pending = this.pendingSpawns.get(msg.id)
        if (pending) {
          this.pendingSpawns.delete(msg.id)
          pending.resolve(msg.code)
        }
        const handle = this.pendingProcesses.get(msg.id)
        if (handle) {
          this.pendingProcesses.delete(msg.id)
          handle._complete(msg.code)
        }
        break
      }
      case 'serve:fetch:response': {
        const pending = this.pendingServeFetches.get(msg.id)
        if (pending) {
          this.pendingServeFetches.delete(msg.id)
          if (msg.error) pending.reject(new Error(msg.error))
          else
            pending.resolve({
              status: msg.status,
              ...(msg.statusText !== undefined ? { statusText: msg.statusText } : {}),
              headers: msg.headers,
              body: msg.body,
            })
        }
        break
      }
      case 'install:progress': {
        const pending = this.pendingInstalls.get(msg.id)
        pending?.onProgress?.({
          name: msg.name,
          ...(msg.version !== undefined ? { version: msg.version } : {}),
          phase: msg.phase,
        })
        break
      }
      case 'install:result': {
        const pending = this.pendingInstalls.get(msg.id)
        if (pending) {
          this.pendingInstalls.delete(msg.id)
          if (msg.error) pending.reject(new Error(msg.error))
          else if (msg.result) pending.resolve(msg.result)
          else pending.reject(new Error('install:result missing result payload'))
        }
        break
      }
      case 'fs:read:response': {
        const pending = this.pendingFsReads.get(msg.id)
        if (pending) {
          this.pendingFsReads.delete(msg.id)
          if (msg.error) {
            pending.reject(Object.assign(new Error(msg.error), { code: msg.error }))
          } else if ('encoding' in pending && pending.encoding === 'utf8') {
            ;(pending as unknown as PendingFsReadText).resolve(msg.text ?? '')
          } else if (msg.data !== undefined) {
            ;(pending as PendingFsRead).resolve(msg.data)
          } else if (msg.text !== undefined) {
            const buf = new TextEncoder().encode(msg.text)
            ;(pending as PendingFsRead).resolve(buf.buffer as ArrayBuffer)
          } else {
            pending.reject(new Error('fs:read:response missing data'))
          }
        }
        break
      }
      case 'fs:readdir:response': {
        const pending = this.pendingFsReaddirs.get(msg.id)
        if (pending) {
          this.pendingFsReaddirs.delete(msg.id)
          if (msg.error) pending.reject(Object.assign(new Error(msg.error), { code: msg.error }))
          else pending.resolve(msg.entries ?? [])
        }
        break
      }
      case 'fs:stat:response': {
        const pending = this.pendingFsStats.get(msg.id)
        if (pending) {
          this.pendingFsStats.delete(msg.id)
          if (msg.error) pending.reject(Object.assign(new Error(msg.error), { code: msg.error }))
          else if (msg.stat) pending.resolve(msg.stat)
          else pending.reject(new Error('fs:stat:response missing stat'))
        }
        break
      }
      case 'fs:mkdir:response': {
        const pending = this.pendingFsMkdirs.get(msg.id)
        if (pending) {
          this.pendingFsMkdirs.delete(msg.id)
          if (msg.error) pending.reject(new Error(msg.error))
          else pending.resolve()
        }
        break
      }
      case 'fs:rm:response': {
        const pending = this.pendingFsRms.get(msg.id)
        if (pending) {
          this.pendingFsRms.delete(msg.id)
          if (msg.error) pending.reject(new Error(msg.error))
          else pending.resolve()
        }
        break
      }
      case 'fs:rename:response': {
        const pending = this.pendingFsRenames.get(msg.id)
        if (pending) {
          this.pendingFsRenames.delete(msg.id)
          if (msg.error) pending.reject(new Error(msg.error))
          else pending.resolve()
        }
        break
      }
      case 'fs:watch:event': {
        // T5.12.5: WASM-internal VFS mutation event from kernel-worker.
        const entry = this.watchEntries.get(msg.id)
        entry?.fn(msg.eventType, msg.filename)
        break
      }
      default:
        break
    }
  }

  private post(msg: HostRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer)
  }

  async whenReady(): Promise<void> {
    return this.ready
  }

  async run(entry: string, argv: string[] = [], env: Record<string, string> = {}): Promise<void> {
    await this.ready
    this.post({ kind: 'run', entry, argv, env })
  }

  /**
   * 在运行时中同步执行一条 `bun` 命令（Phase 2 in-process spawn）。
   *
   * - `argv[0]` 必须为 `"bun"`
   * - 支持 `["bun", "-e", "<js>"]` 和 `["bun", "run", "<vfs-path>"]`
   * - stdout/stderr 通过 `onStdout`/`onStderr` 回调流出
   * - 返回退出码（0 = 正常）
   */
  async spawn(argv: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): Promise<number> {
    await this.ready
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36)
    return new Promise<number>((resolve, reject) => {
      this.pendingSpawns.set(id, { resolve, reject })
      const msg: SpawnRequest = {
        kind: 'spawn',
        id,
        argv,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      }
      this.post(msg)
    })
  }

  /**
   * 在运行时中直接 eval 一段源码（不经 VFS 加载器）。
   * – `id` 需全局唯一，用于将 `eval:result` 响应路由回对应的 Promise。
   * – `filename` 用于 sourceURL 注释，影响 stack trace。
   */
  async eval(id: string, source: string, filename?: string): Promise<void> {
    await this.ready
    return new Promise<void>((resolve, reject) => {
      this.pendingEvals.set(id, { resolve, reject })
      this.post({ kind: 'eval', id, source, ...(filename !== undefined ? { filename } : {}) })
    })
  }

  async writeFile(path: string, data: Uint8Array | string, mode = 0o644): Promise<void> {
    await this.ready
    const snapshot = buildSnapshot([{ path, data, mode }])
    const msg: VfsSnapshotRequest = { kind: 'vfs:snapshot', snapshot }
    this.post(msg, [snapshot])
    // T5.12.5: vfs:snapshot is fire-and-forget; fire watch event locally.
    this._fireLocalWatchEvents(path, 'change')
  }

  /**
   * 向已注册的 `Bun.serve({ fetch, port })` 路由派发一个请求。
   *
   * 用于测试与 SSR 场景下的直调通道（非浏览器地址栏访问路径）。
   */
  async fetch(
    port: number,
    init: {
      url?: string
      method?: string
      headers?: Record<string, string>
      body?: string | ArrayBuffer
    } = {},
  ): Promise<{
    status: number
    statusText?: string
    headers: Record<string, string>
    body: string
  }> {
    await this.ready
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36)
    const url = init.url ?? `http://localhost:${port}/`
    return new Promise((resolve, reject) => {
      this.pendingServeFetches.set(id, { resolve, reject })
      const req: ServeFetchRequest = {
        kind: 'serve:fetch',
        id,
        port,
        url,
        ...(init.method !== undefined ? { method: init.method } : {}),
        ...(init.headers !== undefined ? { headers: init.headers } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
      }
      this.post(req)
    })
  }

  stop(code = 130): void {
    this.post({ kind: 'stop', code })
  }

  /**
   * 标记一个端口已由 `Bun.serve()` 注册，供 ServiceWorker 拦截
   * `${origin}/__bun_preview__/{port}/...` 时转发到本 Kernel。
   *
   * 返回对应的预览 URL 基地址，调用方可将 `iframe.src` 指向该 URL。
   */
  registerPreviewPort(port: number, origin?: string): string {
    this.previewPorts.add(port)
    const resolvedOrigin =
      origin ?? (typeof location !== 'undefined' && location?.origin ? location.origin : 'http://localhost')
    return buildPreviewUrl(resolvedOrigin, port, '/')
  }

  /** 解除某个端口的预览注册。 */
  unregisterPreviewPort(port: number): boolean {
    return this.previewPorts.remove(port)
  }

  /**
   * 在 **Worker 线程**中执行 `bun install`。
   *
   * fetch → gunzip → ustar → 写 VFS 流水线跑在 Kernel Worker 内，文件字节直接写入 WASM VFS。
   */
  async installPackages(
    deps: Record<string, string>,
    opts: {
      registry?: string
      installRoot?: string
      onProgress?: (p: InstallProgressFromWorker) => void
    } = {},
  ): Promise<InstallResultFromWorker> {
    await this.ready
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36)
    return new Promise<InstallResultFromWorker>((resolve, reject) => {
      this.pendingInstalls.set(id, {
        resolve,
        reject,
        ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      })
      const req: InstallRequest = {
        kind: 'install:request',
        id,
        deps,
        opts: {
          ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
          ...(opts.installRoot !== undefined ? { installRoot: opts.installRoot } : {}),
        },
      }
      this.post(req)
    })
  }

  /** 订阅内核事件。 */
  on<K extends keyof KernelEventMap>(event: K, listener: (ev: KernelEventMap[K]) => void): this {
    let set = this.eventListeners.get(event)
    if (!set) {
      set = new Set()
      this.eventListeners.set(event, set)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set.add(listener as (ev: any) => void)
    // T5.11.5：首个 preview-message 订阅时惰性安装 window.message 监听器。
    if (event === 'preview-message' && set.size === 1) {
      this._installPreviewMessageListener()
    }
    return this
  }

  /** T5.11.1：取消订阅内核事件。 */
  off<K extends keyof KernelEventMap>(event: K, listener: (ev: KernelEventMap[K]) => void): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.eventListeners.get(event)?.delete(listener as (ev: any) => void)
    // T5.11.5：最后一个 preview-message 监听器被移除时卸载 window.message 监听器。
    if (event === 'preview-message' && (this.eventListeners.get(event)?.size ?? 0) === 0) {
      this._uninstallPreviewMessageListener()
    }
    return this
  }

  /** @internal window.message 监听器引用（用于 removeEventListener）。 */
  private _previewMsgHandler: ((ev: MessageEvent) => void) | null = null

  /** @internal 惰性安装 window.message 监听器（仅在浏览器环境下生效）。 */
  private _installPreviewMessageListener(): void {
    if (this._previewMsgHandler !== null || typeof window === 'undefined') return
    const handler = (ev: MessageEvent): void => {
      // 只中继来自同源其他 frame 的消息（非当前顶层 window）。
      if (ev.source === window || ev.source === null) return
      if (ev.origin !== window.location.origin) return
      const msgEv: KernelPreviewMessageEvent = { data: ev.data, source: ev.source, origin: ev.origin }
      this._emit('preview-message', msgEv)
    }
    this._previewMsgHandler = handler
    window.addEventListener('message', handler)
  }

  /** @internal 卸载 window.message 监听器。 */
  private _uninstallPreviewMessageListener(): void {
    if (!this._previewMsgHandler || typeof window === 'undefined') return
    window.removeEventListener('message', this._previewMsgHandler)
    this._previewMsgHandler = null
  }

  private _emit<K extends keyof KernelEventMap>(event: K, data: KernelEventMap[K]): void {
    this.eventListeners.get(event)?.forEach(fn => fn(data))
  }

  /** T5.11.2：以 ReadableStream 方式运行进程，返回 ProcessHandle。 */
  async process(
    argv: string[],
    opts: { env?: Record<string, string>; cwd?: string } = {},
  ): Promise<ProcessHandle> {
    await this.ready
    const id = this.genId()
    const handle = new ProcessHandle(id)
    // T5.12.3: 注入 kill 函数 —— 发送 spawn:kill 消息给 kernel-worker
    handle._killFn = (signal: number) => {
      const killMsg: SpawnKillRequest = { kind: 'spawn:kill', id, signal }
      this.post(killMsg)
    }
    this.pendingProcesses.set(id, handle)
    const msg: SpawnRequest = {
      kind: 'spawn',
      id,
      argv,
      streamOutput: true,
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    }
    this.post(msg)
    return handle
  }

  terminate(): void {
    this.detachServiceWorker()
    this.worker.terminate()
  }

  // ---------------------------------------------------------------------------
  // Phase 5.14: Service Worker 桥接方法
  // ---------------------------------------------------------------------------

  /**
   * 注册并附加一个 ServiceWorker，使预览端口的 HTTP 请求能被 SW 拦截后
   * 转发到 Kernel（WASM Bun.serve）处理。
   *
   * - 若当前环境不支持 `navigator.serviceWorker`，抛出错误。
   * - 若已附加 SW，先调用 `detachServiceWorker()` 再重新注册。
   */
  async attachServiceWorker(opts: ServiceWorkerOptions): Promise<void> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      throw new Error('[Kernel] ServiceWorker not available in this environment')
    }
    this.detachServiceWorker()
    const scope = opts.scope ?? '/__bun_preview__/'
    const reg = await navigator.serviceWorker.register(opts.scriptUrl, { scope })
    const active: ServiceWorker = reg.active ?? (await _waitForSWActive(reg))
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as SwFetchMessage | undefined
      if (msg?.type === 'fetch') this._handleSwFetchMessage(msg, port1)
    }
    this._swPort = port1
    this._swRegistration = reg
    // T5.14.2: 'auto' 模式下，当 Worker 实际运行在 threaded 模式时自动开启 COOP/COEP 注入。
    const inject =
      opts.injectIsolationHeaders === 'auto'
        ? this._threadMode === 'threaded'
        : (opts.injectIsolationHeaders ?? false)
    active.postMessage(
      {
        type: 'registerKernel',
        port: port2,
        opts: {
          injectIsolationHeaders: inject,
          // T5.14.3: 传递 bridge script 注入选项
          ...(opts.injectBridgeScript ? { injectBridgeScript: true } : {}),
          ...(opts.fetchTimeoutMs !== undefined ? { fetchTimeoutMs: opts.fetchTimeoutMs } : {}),
        },
      },
      [port2],
    )
  }

  /**
   * 解除 ServiceWorker 附加：关闭 MessagePort，并向 SW 发送 `unregisterKernel`
   * 消息（若有）。若当前未附加 SW，此调用是安全的空操作。
   */
  detachServiceWorker(): void {
    if (this._swPort) {
      this._swPort.onmessage = null
      this._swPort.close()
      this._swPort = null
    }
    if (this._swRegistration) {
      const sw =
        this._swRegistration.active ?? this._swRegistration.installing ?? this._swRegistration.waiting
      sw?.postMessage({ type: 'unregisterKernel' })
      this._swRegistration = null
    }
  }

  /**
   * 处理来自 SW 的 fetch 消息，将其路由到 `Kernel.fetch()` 后回复 SW。
   *
   * @internal 公开以便测试，不属于稳定 API 面。
   */
  _handleSwFetchMessage(msg: SwFetchMessage, replyPort: { postMessage(m: unknown): void }): void {
    handleSwFetchMessage(msg, (port, init) => this.fetch(port, init), replyPort)
  }

  // ---------------------------------------------------------------------------
  // VFS 文件系统 API
  // ---------------------------------------------------------------------------
  private genId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }

  // ---------------------------------------------------------------------------
  // T5.12.5：VFS fs.watch API
  // ---------------------------------------------------------------------------

  /**
   * 订阅 VFS 路径的变更通知。
   *
   * - UI 线程发起的写操作（`writeFile`, `mkdir`, `rm`, `rename`）直接在
   *   本地触发回调，无需 Worker round-trip。
   * - WASM 内部写操作（`eval`/`spawn` 写入的文件）由 kernel-worker 发送
   *   `fs:watch:event` 消息触发。
   *
   * @returns WatchHandle — 调用 `close()` 取消订阅。
   */
  watch(
    path: string,
    listener: (eventType: 'rename' | 'change', filename: string) => void,
    opts: { recursive?: boolean } = {},
  ): WatchHandle {
    const watchId = `w${++this.watchCounter}`
    const normPath = path.startsWith('/') ? path : '/' + path
    this.watchEntries.set(watchId, { path: normPath, recursive: opts.recursive ?? false, fn: listener })
    const req: FsWatchRequest = { kind: 'fs:watch', id: watchId, path: normPath, recursive: opts.recursive ?? false }
    this.post(req)
    return {
      close: () => {
        this.watchEntries.delete(watchId)
        const unreq: FsUnwatchRequest = { kind: 'fs:unwatch', id: watchId }
        this.post(unreq)
      },
    }
  }

  /** @internal Fire local watch events for UI-thread-initiated VFS mutations. */
  private _fireLocalWatchEvents(changedPath: string, eventType: 'rename' | 'change'): void {
    if (this.watchEntries.size === 0) return
    const norm = changedPath.startsWith('/') ? changedPath : '/' + changedPath
    for (const { path: watchPath, recursive, fn } of this.watchEntries.values()) {
      const watchDir = watchPath.endsWith('/') ? watchPath : watchPath + '/'
      if (norm === watchPath) {
        fn(eventType, norm)
      } else if (norm.startsWith(watchDir)) {
        if (recursive) {
          fn(eventType, norm)
        } else {
          const rel = norm.slice(watchDir.length)
          if (!rel.includes('/')) fn(eventType, norm)
        }
      }
    }
  }

  /**
   * 读取 VFS 文件内容（二进制）。
   *
   * encoding 省略或为 `"binary"` 时返回 `ArrayBuffer`；
   * 为 `"utf8"` 时返回 `string`。
   */
  async readFile(path: string): Promise<ArrayBuffer>
  async readFile(path: string, encoding: 'binary'): Promise<ArrayBuffer>
  async readFile(path: string, encoding: 'utf8'): Promise<string>
  async readFile(path: string, encoding?: 'utf8' | 'binary'): Promise<ArrayBuffer | string> {
    await this.ready
    const id = this.genId()
    return new Promise<ArrayBuffer | string>((resolve, reject) => {
      if (encoding === 'utf8') {
        this.pendingFsReads.set(id, {
          resolve: resolve as (t: string) => void,
          reject,
          encoding: 'utf8',
        } as PendingFsReadText)
      } else {
        this.pendingFsReads.set(id, { resolve: resolve as (b: ArrayBuffer) => void, reject } as PendingFsRead)
      }
      const req: FsReadFileRequest = { kind: 'fs:read', id, path, ...(encoding ? { encoding } : {}) }
      this.post(req)
    })
  }

  /** 列举 VFS 目录内容，返回 `{ name, type }` 条目列表。 */
  async readdir(path: string): Promise<FsDirEntry[]> {
    await this.ready
    const id = this.genId()
    return new Promise<FsDirEntry[]>((resolve, reject) => {
      this.pendingFsReaddirs.set(id, { resolve, reject })
      const req: FsReaddirRequest = { kind: 'fs:readdir', id, path }
      this.post(req)
    })
  }

  /** 查询 VFS 文件/目录的 stat 信息。不存在时 reject（code = "ENOENT"）。 */
  async stat(path: string): Promise<FsStatInfo> {
    await this.ready
    const id = this.genId()
    return new Promise<FsStatInfo>((resolve, reject) => {
      this.pendingFsStats.set(id, { resolve, reject })
      const req: FsStatRequest = { kind: 'fs:stat', id, path }
      this.post(req)
    })
  }

  /** 在 VFS 中递归创建目录。 */
  async mkdir(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    await this.ready
    const id = this.genId()
    await new Promise<void>((resolve, reject) => {
      this.pendingFsMkdirs.set(id, { resolve, reject })
      const req: FsMkdirRequest = { kind: 'fs:mkdir', id, path, recursive: opts.recursive ?? true }
      this.post(req)
    })
    // T5.12.5: Directory created — fire rename event for watchers.
    this._fireLocalWatchEvents(path, 'rename')
  }

  /** 删除 VFS 中的文件（或目录）。`recursive: true` 时递归删除目录树。 */
  async rm(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    await this.ready
    const id = this.genId()
    await new Promise<void>((resolve, reject) => {
      this.pendingFsRms.set(id, { resolve, reject })
      const req: FsRmRequest = { kind: 'fs:rm', id, path, ...(opts.recursive !== undefined ? { recursive: opts.recursive } : {}) }
      this.post(req)
    })
    // T5.12.5: File/directory removed — fire rename event for watchers.
    this._fireLocalWatchEvents(path, 'rename')
  }

  /** 重命名/移动 VFS 中的文件。 */
  async rename(from: string, to: string): Promise<void> {
    await this.ready
    const id = this.genId()
    await new Promise<void>((resolve, reject) => {
      this.pendingFsRenames.set(id, { resolve, reject })
      const req: FsRenameRequest = { kind: 'fs:rename', id, from, to }
      this.post(req)
    })
    // T5.12.5: File renamed — fire rename event for both source and destination.
    this._fireLocalWatchEvents(from, 'rename')
    this._fireLocalWatchEvents(to, 'rename')
  }

  // ---------------------------------------------------------------------------
  // WebContainer 兼容的 FileSystemTree API
  // ---------------------------------------------------------------------------

  /**
   * 以 WebContainer 兼容的 `FileSystemTree` 格式挂载文件树到 VFS。
   *
   * 等同于 `@webcontainer/api` 的 `webcontainerInstance.mount(tree)`。
   *
   * @param tree  要挂载的文件树
   * @param prefix  挂载目标路径前缀（VFS 绝对路径，默认 "/"）
   */
  async mount(tree: FileSystemTree, prefix = '/'): Promise<void> {
    await this.ready
    const files = fileSystemTreeToVfsFiles(tree, prefix === '/' ? '' : prefix)
    if (files.length === 0) return
    const snapshot = buildSnapshot(files)
    const msg: VfsSnapshotRequest = { kind: 'vfs:snapshot', snapshot }
    this.post(msg, [snapshot])
  }

  /**
   * 将 VFS（或 VFS 某子目录）导出为 `FileSystemTree` 格式。
   *
   * 需要先 `await kernel.whenReady()`；通过 round-trip 消息从 Worker 里 dump
   * 当前 VFS 快照，然后在主线程解析为树形结构。
   *
   * @param prefix  只导出此目录下的文件（VFS 绝对路径，默认 "/"）
   */
  async exportFs(prefix = '/'): Promise<FileSystemTree> {
    await this.ready
    // Uses fs:readdir + fs:readFile recursively to reconstruct the tree.
    // Functional but potentially slow for deep trees; T5.12 can add a
    // dedicated bun_vfs_dump_snapshot round-trip for better efficiency.
    const allFiles = await this._listAllFiles(prefix)
    const vfsFiles: VfsFile[] = []
    for (const path of allFiles) {
      const data = await this.readFile(path)
      vfsFiles.push({ path, data: new Uint8Array(data) })
    }
    return vfsFilesToFileSystemTree(vfsFiles, prefix === '/' ? '/' : prefix)
  }

  /** @internal Recursively list all file paths under a directory. */
  private async _listAllFiles(dir: string): Promise<string[]> {
    let entries: FsDirEntry[]
    try {
      entries = await this.readdir(dir)
    } catch {
      return []
    }
    const paths: string[] = []
    for (const entry of entries) {
      const fullPath = dir.endsWith('/') ? dir + entry.name : dir + '/' + entry.name
      if (entry.type === 'file') {
        paths.push(fullPath)
      } else {
        const nested = await this._listAllFiles(fullPath)
        paths.push(...nested)
      }
    }
    return paths
  }
}
