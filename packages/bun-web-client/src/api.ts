import { Kernel } from '@mars/web-kernel'
import type { KernelProcessExecutor } from '@mars/web-kernel'
import type {
  BunContainerWorkerScriptProcessor,
  BunContainerWorkerScriptRecord,
  BunContainerBootOptions,
  ContainerEventMap,
  ContainerEventName,
  ContainerProcess,
  ContainerStatus,
  FileChangeEvent,
  FileTree,
  SpawnOpts,
  TerminalHandle,
} from './client.types'
import type { 
  KernelMountFile, 
  ProcessDescriptor 
} from '@mars/web-kernel'

type Listener<T> = (event: T) => void

const textEncoder = new TextEncoder()
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...params: unknown[]) => Promise<unknown>

function isFileTreeDirectory(value: string | Uint8Array | FileTree): value is FileTree {
  return typeof value === 'object' && !(value instanceof Uint8Array)
}

function normalizeMountPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`
}

function flattenFileTree(files: FileTree, prefix = ''): Array<[string, string | Uint8Array]> {
  const entries: Array<[string, string | Uint8Array]> = []

  for (const [name, value] of Object.entries(files)) {
    const nextPath = normalizeMountPath(prefix ? `${prefix}/${name}` : name)
    if (isFileTreeDirectory(value)) {
      entries.push(...flattenFileTree(value, nextPath))
      continue
    }
    entries.push([nextPath, value])
  }

  return entries
}

function createReadableStream() {
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  return {
    readable: stream.readable,
    writer: stream.writable.getWriter(),
  }
}

function decodeBytes(data: string | Uint8Array): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data)
}

// ── 简易事件总线 ───────────────────────────────────────────────────────────────

class EventBus {
  private readonly handlers: Map<string, Set<Listener<unknown>>> = new Map()

  on<K extends ContainerEventName>(event: K, listener: Listener<ContainerEventMap[K]>): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    const set = this.handlers.get(event)!
    set.add(listener as Listener<unknown>)
    // 返回取消订阅函数
    return () => set.delete(listener as Listener<unknown>)
  }

  emit<K extends ContainerEventName>(event: K, payload: ContainerEventMap[K]): void {
    this.handlers.get(event)?.forEach(fn => {
      try {
        fn(payload as unknown)
      } catch {
        // 事件监听器异常不影响主流程
      }
    })
  }

  clear(): void {
    this.handlers.clear()
  }
}

// ── 进程序号生成 ────────────────────────────────────────────────────────────────


// ── BunContainer ──────────────────────────────────────────────────────────────

/**
 * BunContainer — 浏览器端 Bun 运行时容器 SDK（RFC §23）
 *
 * 提供：
 * - 生命周期管理（boot / shutdown）
 * - 文件挂载（mount）
 * - 进程管理（spawn / eval）
 * - 事件订阅（on/off）
 * - 终端附加（attachTerminal）
 * - 只读文件系统视图（fs）
 *
 * 注意：此实现为协议层骨架（stub），实际运行时委托给 ServiceWorker / SharedWorker
 * 后端，该后端由 bun-web-kernel 包提供。SDK 层只负责类型安全的接口封装。
 */
export class BunContainer {
  private readonly bus = new EventBus()
  private readonly _fs: Map<string, string | Uint8Array> = new Map()
  private readonly options: BunContainerBootOptions
  private readonly kernel: Kernel
  private readonly swUninstall: (() => void) | null
  private _status: ContainerStatus = 'booting'

  // ── 静态工厂 ─────────────────────────────────────────────────────────────

  /**
   * 启动一个新的容器实例。
   * 在实际实现中，这会初始化 ServiceWorker 通道、建立 RPC 连接等。
   */
  static async boot(options: BunContainerBootOptions = {}): Promise<BunContainer> {
    const processExecutor = options.processExecutor ?? await loadDefaultProcessExecutor(options)
    const kernel = await Kernel.boot({
      tunnelUrl: options.tunnelUrl,
      processExecutor,
    })

    const swUninstall = await createServiceWorkerBridge(kernel, options)
    const container = new BunContainer(options, kernel, swUninstall)
    if (options.files) {
      await container.mount(options.files)
    }

    container._status = 'ready'
    return container
  }

  private constructor(opts: BunContainerBootOptions, kernel: Kernel, swUninstall: (() => void) | null) {
    this.options = opts
    this.kernel = kernel
    this.swUninstall = swUninstall

    this.kernel.on('processExit', ({ pid, code }) => {
      this.bus.emit('process-exit', { pid, exitCode: code })
    })

    this.kernel.on('portRegistered', ({ port, host, protocol }) => {
      this.bus.emit('server-ready', {
        url: `${protocol}://${host}:${port}`,
        host,
        port,
        protocol,
      })
    })
  }

  // ── 只读文件系统视图 ─────────────────────────────────────────────────────

  get fs(): ReadonlyMap<string, string | Uint8Array> {
    return this._fs
  }

  get status(): ContainerStatus {
    return this._status
  }

  // ── 文件挂载 ─────────────────────────────────────────────────────────────

  /**
   * 将文件树挂载到容器 VFS。
   * 已存在的路径会被覆盖；新路径会被创建。
   */
  async mount(files: FileTree): Promise<void> {
    this.assertNotDisposed()

    const flattened = flattenFileTree(files)
    const mountFiles: KernelMountFile[] = flattened.map(([path, content]) => ({
      path,
      content,
    }))

    await this.kernel.handleCommand({
      type: 'mount',
      files: mountFiles,
    })

    for (const [path, content] of flattened) {
      const existed = this._fs.has(path)
      this._fs.set(path, content)
      const event: FileChangeEvent = {
        path,
        type: existed ? 'modify' : 'create',
      }
      
      this.bus.emit('filechange', event)
    }
  }

  // ── 进程管理 ─────────────────────────────────────────────────────────────

  /**
   * 在容器内 spawn 进程（桩实现，真实版本通过 RPC 委托到 Worker）。
   */
  async spawn(opts: SpawnOpts): Promise<ContainerProcess>
  async spawn(cmd: string, args?: string[], opts?: Omit<SpawnOpts, 'argv'>): Promise<ContainerProcess>
  async spawn(
    input: SpawnOpts | string,
    args: string[] = [],
    opts: Omit<SpawnOpts, 'argv'> = {},
  ): Promise<ContainerProcess> {
    this.assertNotDisposed()
    const spawnOpts: SpawnOpts =
      typeof input === 'string'
        ? { ...opts, argv: [input, ...args] }
        : input

    const descriptor = await this.createKernelProcess(spawnOpts)
    const pid = descriptor.pid

    const stdoutChannel = createReadableStream()
    const stderrChannel = createReadableStream()
    let stdinBuffer = ''
    let finished = false

    let resolveExit!: (code: number) => void
    const exited = new Promise<number>(resolve => {
      resolveExit = resolve
    })

    const unsubscribeStdio = this.kernel.onStdio(pid, (kind, data) => {
      if (kind === 'stdout') {
        void stdoutChannel.writer.write(textEncoder.encode(data))
        return
      }
      void stderrChannel.writer.write(textEncoder.encode(data))
    })

    const processExitListener = (payload: { pid: number; code: number }) => {
      if (payload.pid !== pid || finished) return
      finished = true
      
      unsubscribeStdio()
      this.kernel.off('processExit', processExitListener)
      
      resolveExit(payload.code)
      void stdoutChannel.writer.close()
      void stderrChannel.writer.close()
    }
    
    this.kernel.on('processExit', processExitListener)

    const inputStream = new WritableStream<Uint8Array>({
      write: chunk => {
        stdinBuffer += decodeBytes(chunk)
      },
    })

    const process: ContainerProcess = {
      pid,
      output: stdoutChannel.readable,
      waitForExit: () => exited,
      exited,
      write: data => {
        stdinBuffer += decodeBytes(data)
      },
      input: inputStream,
      kill: (signal = 9) => {
        try {
          void this.kernel.handleCommand({
            type: 'kill',
            pid,
            signal,
          })
        } catch {
          // process may already be completed on kernel side
        }
      },
      stdout: stdoutChannel.readable,
      stderr: stderrChannel.readable,
    }

    queueMicrotask(() => {
      // Command execution is delegated to kernel executeProcess -> processExecutor.
      // runtime.spawn currently manages process handle lifecycle and stdio wiring,
      // but does not execute argv payload by itself.
      this.kernel
        .handleCommand({
          type: 'executeProcess',
          pid,
          argv: spawnOpts.argv,
          cwd: spawnOpts.cwd,
          env: {
            ...(typeof this.options.files === 'object' && this.options.files ? (this.options.files as Record<string, string>) : {}),
            ...(spawnOpts.env ?? {}),
          },
          stdin: stdinBuffer,
        })
        .catch(error => {
          const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          return this.kernel
            .handleCommand({
              type: 'stdio',
              pid,
              kind: 'stderr',
              data: `${message}\n`,
            })
            .then(() =>
              this.kernel.handleCommand({
                type: 'exit',
                pid,
                code: 1,
              }),
            )
        })
    })

    return process
  }

  /**
   * 在容器内 eval 一段脚本，返回最终 stdout 文本。
   */
  async eval(
    script: string,
    opts: Omit<SpawnOpts, 'argv'> & { filename?: string; argv?: string[] } = {},
  ): Promise<string> {
    this.assertNotDisposed()
    const output: string[] = []
    const errorOutput: string[] = []
    const capture = (target: string[]) => (...args: unknown[]) => {
      target.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    }

    const consoleLike = {
      log: capture(output),
      info: capture(output),
      warn: capture(errorOutput),
      error: capture(errorOutput),
    }

    const processLike = {
      argv: opts.argv ?? [],
      env: opts.env ?? {},
      cwd: () => opts.cwd ?? '/',
    }

    const bunLike = {
      version: '0.0.0-web',
      env: opts.env ?? {},
      argv: opts.argv ?? [],
      cwd: () => opts.cwd ?? '/',
      file: (path: string) => this._fs.get(path),
    }

    try {
      const fn = new AsyncFunction('console', 'Bun', 'process', script)
      await fn(consoleLike, bunLike, processLike)
    } catch (error) {
      errorOutput.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    }

    return [...output, ...errorOutput].filter(Boolean).join('\n') + ([...output, ...errorOutput].length ? '\n' : '')
  }

  // ── 终端 ──────────────────────────────────────────────────────────────────

  /**
   * 创建一个终端句柄。
   * 实际实现中会连接到进程的 pty；桩版本返回无操作句柄。
   */
  attachTerminal(_terminal?: unknown, _pid?: number): TerminalHandle {
    this.assertNotDisposed()
    return {
      attach: (_container) => {},
      write: (_data) => {},
      dispose: () => {},
    }
  }

  // ── 事件订阅 ─────────────────────────────────────────────────────────────

  on<K extends ContainerEventName>(
    event: K,
    listener: (payload: ContainerEventMap[K]) => void,
  ): () => void {
    return this.bus.on(event, listener)
  }

  off<K extends ContainerEventName>(event: K, listener: (payload: ContainerEventMap[K]) => void): void {
    void event
    void listener
  }

  // ── 关闭 ──────────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    this._status = 'disposed'
    this.bus.clear()
    this._fs.clear()
    this.swUninstall?.()
    await Kernel.shutdown()
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private assertNotDisposed(): void {
    if (this._status === 'disposed') {
      throw new Error('[BunContainer] Container has been disposed')
    }
  }

  private async createKernelProcess(opts: SpawnOpts): Promise<ProcessDescriptor> {
    const result = await this.kernel.handleCommand({
      type: 'spawn',
      options: {
        argv: opts.argv,
        cwd: opts.cwd,
        env: opts.env,
      },
    })

    if (result.type !== 'spawn') {
      throw new Error('[BunContainer] Unexpected kernel response for spawn command')
    }

    return result.process
  }

}

type KernelPortResolverLike = {
  resolvePort(port: number): number | null
  subscribe(
    event: 'portRegistered',
    listener: (payload: { pid: number; port: number; host: string; protocol: 'http' | 'https' }) => void,
  ): () => void
}

type ServiceWorkerScopeLike = {
  addEventListener(type: 'fetch' | 'install' | 'activate', listener: Function): void
  removeEventListener?(type: 'fetch' | 'install' | 'activate', listener: Function): void
  skipWaiting?(): Promise<void> | void
  clients?: { claim?(): Promise<void> | void }
}

type ServeHandlerRegistryLike = {
  getHandler(port: number): ((request: Request) => Promise<Response> | Response) | null
}

type WorkerScriptStoreLike = Map<string, BunContainerWorkerScriptRecord>

type KernelServiceWorkerBridgeOptionsLike = {
  workerScripts?: WorkerScriptStoreLike
  scriptProcessor?: BunContainerWorkerScriptProcessor
}

function createKernelSwBridge(kernel: Kernel): KernelPortResolverLike {
  return {
    resolvePort(port: number): number | null {
      return kernel.resolvePort(port)
    },
    subscribe(event, listener) {
      return kernel.subscribe(event, listener)
    },
  }
}

function assertValidWorkerScriptPath(pathname: string): void {
  if (!pathname || typeof pathname !== 'string' || !pathname.startsWith('/')) {
    throw new TypeError('[BunContainer.boot] serviceWorkerScripts key must be an absolute pathname')
  }
}

function assertValidWorkerScriptRecord(pathname: string, record: BunContainerWorkerScriptRecord): void {
  if (typeof record === 'string') {
    return
  }

  if (!record || typeof record !== 'object') {
    throw new TypeError(
      `[BunContainer.boot] serviceWorkerScripts[${pathname}] must be a string or descriptor object`,
    )
  }

  if (typeof record.source !== 'string') {
    throw new TypeError(
      `[BunContainer.boot] serviceWorkerScripts[${pathname}].source must be a string`,
    )
  }
}

function normalizeWorkerScriptStore(
  scripts:
    | Map<string, BunContainerWorkerScriptRecord>
    | Record<string, BunContainerWorkerScriptRecord>
    | undefined,
): WorkerScriptStoreLike | undefined {
  if (!scripts) return undefined
  if (scripts instanceof Map) {
    for (const [pathname, record] of scripts.entries()) {
      assertValidWorkerScriptPath(pathname)
      assertValidWorkerScriptRecord(pathname, record)
    }
    return scripts
  }

  const entries = Object.entries(scripts)
  for (const [pathname, record] of entries) {
    assertValidWorkerScriptPath(pathname)
    assertValidWorkerScriptRecord(pathname, record)
  }

  return new Map(entries)
}

function detectServiceWorkerScope(options: BunContainerBootOptions): ServiceWorkerScopeLike | null {
  if (options.serviceWorkerScope) {
    return options.serviceWorkerScope as ServiceWorkerScopeLike
  }

  const maybeScope = globalThis as unknown as {
    addEventListener?: (type: string, listener: Function) => void
    clients?: unknown
    skipWaiting?: unknown
  }

  if (
    typeof maybeScope.addEventListener === 'function' &&
    (typeof maybeScope.skipWaiting === 'function' || typeof maybeScope.clients === 'object')
  ) {
    return maybeScope as unknown as ServiceWorkerScopeLike
  }

  return null
}

async function createServiceWorkerBridge(
  kernel: Kernel,
  options: BunContainerBootOptions,
): Promise<(() => void) | null> {
  if (options.installServiceWorkerFromKernel === false) {
    return null
  }

  const scope = detectServiceWorkerScope(options)
  if (!scope) {
    return null
  }

  const swCandidates = [
    '@mars/web-sw',
    '../../bun-web-sw/src/index.ts',
  ]

  let installServiceWorkerFromKernelFn:
    | ((
      kernelBridge: KernelPortResolverLike,
      target: ServiceWorkerScopeLike,
      handlerRegistry: ServeHandlerRegistryLike,
      options?: KernelServiceWorkerBridgeOptionsLike,
    ) => () => void)
    | null = null

  for (const candidate of swCandidates) {
    try {
      const loaded = await import(candidate) as {
        installServiceWorkerFromKernel?: (
          kernelBridge: KernelPortResolverLike,
          target: ServiceWorkerScopeLike,
          handlerRegistry: ServeHandlerRegistryLike,
          options?: KernelServiceWorkerBridgeOptionsLike,
        ) => () => void
      }
      if (typeof loaded.installServiceWorkerFromKernel === 'function') {
        installServiceWorkerFromKernelFn = loaded.installServiceWorkerFromKernel
        break
      }
    } catch {
      // Try next candidate.
    }
  }

  if (!installServiceWorkerFromKernelFn) {
    return null
  }

  let handlerRegistry = options.serveHandlerRegistry as ServeHandlerRegistryLike | undefined
  if (!handlerRegistry) {
    const runtimeCandidates = [
      '@mars/web-runtime',
      '../../bun-web-runtime/src/index.ts',
    ]

    for (const candidate of runtimeCandidates) {
      try {
        const loaded = await import(candidate) as {
          getServeHandler?: (port: number) => ((request: Request) => Promise<Response> | Response) | null
        }
        if (typeof loaded.getServeHandler === 'function') {
          handlerRegistry = {
            getHandler: port => loaded.getServeHandler?.(port) ?? null,
          }
          break
        }
      } catch {
        // Try next candidate.
      }
    }
  }

  if (!handlerRegistry) {
    return null
  }

  return installServiceWorkerFromKernelFn(
    createKernelSwBridge(kernel),
    scope,
    handlerRegistry,
    {
      workerScripts: normalizeWorkerScriptStore(options.serviceWorkerScripts),
      scriptProcessor: options.serviceWorkerScriptProcessor,
    },
  )
}

let cachedDefaultProcessExecutor: KernelProcessExecutor | null = null
let hasWarnedDefaultProcessExecutorLoadFailure = false

function shouldPreferServiceWorkerScriptUrl(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  const nav = globalThis.navigator as Navigator | undefined
  return !!nav?.serviceWorker
}

async function loadDefaultProcessExecutor(
  options?: Pick<BunContainerBootOptions, 'workerUrl'>,
): Promise<KernelProcessExecutor | undefined> {
  const explicitWorkerUrl = options?.workerUrl?.trim() || undefined
  const shouldBypassCache = !!explicitWorkerUrl

  if (!shouldBypassCache && cachedDefaultProcessExecutor) {
    return cachedDefaultProcessExecutor
  }

  const candidates = [
    '@mars/web-runtime',
  ]

  const errors: string[] = []

  for (const id of candidates) {
    try {
      const mod = (await import(id)) as {
        PROCESS_EXECUTOR_WORKER_PATH?: string
        createRuntimeProcessExecutor?: (options?: { workerUrl?: string | URL }) => KernelProcessExecutor
        runtimeProcessExecutor?: KernelProcessExecutor
      }

      if (typeof mod.createRuntimeProcessExecutor === 'function') {
        const shouldUseSwPath = shouldPreferServiceWorkerScriptUrl()
        const scriptUrl = explicitWorkerUrl ?? (shouldUseSwPath ? mod.PROCESS_EXECUTOR_WORKER_PATH : undefined)

        const createdExecutor = mod.createRuntimeProcessExecutor(
          scriptUrl ? { workerUrl: scriptUrl } : undefined,
        )

        if (!shouldBypassCache) {
          cachedDefaultProcessExecutor = createdExecutor
        }
        return createdExecutor
      }

      if (mod.runtimeProcessExecutor) {
        cachedDefaultProcessExecutor = mod.runtimeProcessExecutor
        return cachedDefaultProcessExecutor
      }
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!hasWarnedDefaultProcessExecutorLoadFailure) {
    hasWarnedDefaultProcessExecutorLoadFailure = true
    console.warn(
      `[BunContainer] Failed to load default runtime process executor. ` +
        `bun command execution may fail unless processExecutor is provided. ` +
        `Tried: ${errors.join(' | ')}`,
    )
  }

  return undefined
}
