import { Kernel } from '@mars/web-kernel'
import { Subscription } from '@mars/web-shared'
import type { KernelProcessExecutor, KernelModuleRequestHandler } from '@mars/web-kernel'
import { resolveKernelServiceWorkerUrl } from '@mars/web-kernel'
import { createKernelModuleRequestProtocolHandler } from '@mars/web-kernel'
import type {
  BunContainerBootOptions,
  ContainerEvents,
  ContainerProcess,
  ContainerStatus,
  FileChangeEvent,
  FileTree,
  SpawnOpts,
  TerminalHandle,
} from './client.types'
import { createServiceWorkerBridge } from './service-worker-bridge.ts'
import type { 
  KernelMountFile, 
  ProcessDescriptor 
} from '@mars/web-kernel'

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

function createDefaultModuleRequestHandler(): KernelModuleRequestHandler {
  return async (request) => {
    return {
      requestId: request.requestId,
      status: 404,
      headers: [['content-type', 'text/plain']],
      error: `Module not found: ${request.pathname}`,
    }
  }
}

function createDefaultProcessExecutor(): KernelProcessExecutor {
  return async (request) => {
    const [command, ...args] = request.argv

    if (!command) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'No command specified\n',
      }
    }

    if (command === 'echo') {
      const output = args.join(' ')
      return {
        exitCode: 0,
        stdout: output + '\n',
        stderr: '',
      }
    }

    if (command === 'cat') {
      if (args.length === 0) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'cat: missing filename\n',
        }
      }

      const filePath = args[0]
      const content = request.readMountedFile(filePath)
      
      if (content === undefined) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `cat: ${filePath}: No such file or directory\n`,
        }
      }

      const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
      return {
        exitCode: 0,
        stdout: text.endsWith('\n') ? text : text + '\n',
        stderr: '',
      }
    }

    return {
      exitCode: 127,
      stdout: '',
      stderr: `${command}: command not found\n`,
    }
  }
}


export class BunContainer extends Subscription<ContainerEvents> {
  private readonly _fsMap: Map<string, string | Uint8Array> = new Map()
  private readonly options: BunContainerBootOptions
  private readonly _kernelInstance: Kernel
  private readonly swUninstall: (() => void) | null
  private _status: ContainerStatus = 'booting'

  get status(): ContainerStatus {
    return this._status
  }

  get fs(): ReadonlyMap<string, string | Uint8Array> {
    return this._fsMap
  }

  get _kernel(): Kernel {
    return this._kernelInstance
  }

  static async boot(options: BunContainerBootOptions = {}): Promise<BunContainer> {
    const processExecutor = options.processExecutor ?? createDefaultProcessExecutor()
    const moduleRequestHandler = options.moduleRequestHandler ?? createDefaultModuleRequestHandler()

    const kernel = new Kernel({
      tunnelUrl: options.tunnelUrl,
      moduleRequestHandler,
      processExecutor,
      bootHooks: options.hooks?.boot,
      serviceWorkerBeforeRegisterHooks: options.hooks?.serviceWorkerBeforeRegister,
      serviceWorkerRegisterHooks: options.hooks?.serviceWorkerRegister,
      serviceWorkerRegisterErrorHooks: options.hooks?.serviceWorkerRegisterError,
    })

    const serviceWorkerUrl = await resolveKernelServiceWorkerUrl(options.serviceWorkerUrl)
    kernel.configureServiceWorker({
      url: serviceWorkerUrl,
      registerOptions: options.serviceWorkerRegisterOptions,
    })
    kernel.serviceWorker.configureModuleRequestHandler(createKernelModuleRequestProtocolHandler(kernel))

    await kernel.runInitializers({
      serviceWorkerUrl,
      selectedInitializers: options.initializers ?? 'all',
    })

    const swBridge = await createServiceWorkerBridge(kernel, serviceWorkerUrl, {
      serviceWorkerScripts: options.serviceWorkerScripts,
      serviceWorkerScriptProcessor: options.serviceWorkerScriptProcessor,
      serveHandlerRegistry: options.serveHandlerRegistry,
    })
    await kernel.publishServiceWorkerRegister(swBridge.registered, serviceWorkerUrl)

    const swUninstall = swBridge.uninstall
    const container = new BunContainer(options, kernel, swUninstall)
    if (options.files) {
      await container.mount(options.files)
    }

    container._status = 'ready'
    return container
  }

  private constructor(opts: BunContainerBootOptions, kernel: Kernel, swUninstall: (() => void) | null) {
    super()
    this.options = opts
    this._kernelInstance = kernel
    this.swUninstall = swUninstall

    this._kernelInstance.on('processExit', ({ pid, code }) => {
      this.emit('process-exit', { pid, exitCode: code })
    })

    this._kernelInstance.on('portRegistered', ({ port, host, protocol }) => {
      this.emit('server-ready', {
        url: `${protocol}://${host}:${port}`,
        host,
        port,
        protocol,
      })
    })
  }

  async mount(files: FileTree): Promise<void> {
    this.assertNotDisposed()

    const flattened = flattenFileTree(files)
    const mountFiles: KernelMountFile[] = flattened.map(([path, content]) => ({
      path,
      content,
    }))

    await this._kernelInstance.handleCommand({
      type: 'mount',
      files: mountFiles,
    })

    for (const [path, content] of flattened) {
      const existed = this._fsMap.has(path)
      this._fsMap.set(path, content)
      const event: FileChangeEvent = {
        path,
        type: existed ? 'modify' : 'create',
      }
      
      this.emit('filechange', event)
    }
  }

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

    const unsubscribeStdio = this._kernelInstance.onStdio(pid, (kind, data) => {
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
      this._kernelInstance.off('processExit', processExitListener)
      
      resolveExit(payload.code)
      void stdoutChannel.writer.close()
      void stderrChannel.writer.close()
    }
    
    this._kernelInstance.on('processExit', processExitListener)

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
          void this._kernelInstance.handleCommand({
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
      this._kernelInstance
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
          return this._kernelInstance
            .handleCommand({
              type: 'stdio',
              pid,
              kind: 'stderr',
              data: `${message}\n`,
            })
            .then(() =>
              this._kernelInstance.handleCommand({
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
      file: (path: string) => this._fsMap.get(path),
    }

    try {
      const fn = new AsyncFunction('console', 'Bun', 'process', script)
      await fn(consoleLike, bunLike, processLike)
    } catch (error) {
      errorOutput.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    }

    return [...output, ...errorOutput].filter(Boolean).join('\n') + ([...output, ...errorOutput].length ? '\n' : '')
  }

  attachTerminal(_terminal?: unknown, _pid?: number): TerminalHandle {
    this.assertNotDisposed()
    return {
      attach: (_container) => {},
      write: (_data) => {},
      dispose: () => {},
    }
  }

  async shutdown(): Promise<void> {
    this._status = 'disposed'
    this._fsMap.clear()
    this.swUninstall?.()
    await this._kernelInstance.shutdown()
  }

  private assertNotDisposed(): void {
    if (this._status === 'disposed') {
      throw new Error('[BunContainer] Container has been disposed')
    }
  }

  private async createKernelProcess(opts: SpawnOpts): Promise<ProcessDescriptor> {
    const result = await this._kernelInstance.handleCommand({
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
