import { createProcess, installProcessGlobal } from '@mars/web-node'
import { installBunGlobals } from './bun-globals'
import { initRuntimeBundler } from './bundler-runtime'
import { initRuntimeTranspiler } from './transpiler-runtime'
import { InitializerPipeline } from '@mars/web-shared'
import type { Kernel } from '@mars/web-kernel'
import type { RuntimeBundlerInitOptions } from './bundler-runtime'

export interface ProcessBootstrapOptions {
  kernel: Kernel
  pid: number
  argv: string[]
  env: Record<string, string>
  cwd: string
  sabBuffer: SharedArrayBuffer | null
  bootstrapInitializers?: 'all' | string[]
  initializeTranspiler?: boolean
  initializeBundler?: boolean
  bundlerInit?: RuntimeBundlerInitOptions
}

export interface ProcessBootstrapInitializerContext {
  opts: ProcessBootstrapOptions
  scope: Record<string, unknown>
}

export interface ProcessBootstrapInitializer {
  id: string
  shouldRun?: (context: ProcessBootstrapInitializerContext) => boolean
  run: (context: ProcessBootstrapInitializerContext) => void | Promise<void>
}

// ---------------------------------------------------------------------------
// StdioWriter — wraps a MessagePort to deliver stdout/stderr back to parent
// ---------------------------------------------------------------------------

export type StdioEventKind = 'stdout' | 'stderr' | 'exit'

export interface StdioMessage {
  kind: StdioEventKind
  pid: number
  data?: string
  code?: number
}

type PostMessageFn = (message: StdioMessage) => void

export class StdioWriter {
  constructor(
    private readonly port: MessagePort | null,
    private readonly pid: number,
    private readonly kind: 'stdout' | 'stderr',
    private readonly fallbackPostMessage: PostMessageFn | null = null,
  ) {}

  write(chunk: string | Uint8Array): void {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    const msg: StdioMessage = { kind: this.kind, pid: this.pid, data: text }
    if (this.port) {
      this.port.postMessage(msg)
      return
    }
    this.fallbackPostMessage?.(msg)
  }

  writeln(line: string): void {
    this.write(line + '\n')
  }

  end(): void {}
}

// ---------------------------------------------------------------------------
// installConsoleCapture — redirect console.log/warn/error to StdioWriters
// ---------------------------------------------------------------------------

function installConsoleCapture(stdout: StdioWriter, stderr: StdioWriter): void {
  const scope = globalThis as Record<string, unknown>

  // Only install if not already patched
  if ((scope.console as Record<string, unknown>)?.__bun_web_patched__) return

  const origLog = console.log.bind(console)
  const origWarn = console.warn.bind(console)
  const origError = console.error.bind(console)
  const origInfo = console.info.bind(console)

  const fmt = (...args: unknown[]) =>
    args
      .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')

  console.log = (...args: unknown[]) => {
    stdout.writeln(fmt(...args))
    origLog(...args)
  }
  console.info = (...args: unknown[]) => {
    stdout.writeln(fmt(...args))
    origInfo(...args)
  }
  console.warn = (...args: unknown[]) => {
    stderr.writeln('[warn] ' + fmt(...args))
    origWarn(...args)
  }
  console.error = (...args: unknown[]) => {
    stderr.writeln('[error] ' + fmt(...args))
    origError(...args)
  }
  ;(console as unknown as Record<string, unknown>).__bun_web_patched__ = true
}

// ---------------------------------------------------------------------------
// bootstrapProcessWorker — main entry for a Process Worker
// ---------------------------------------------------------------------------

export interface BootstrappedContext {
  process: ReturnType<typeof createProcess>
  stdout: StdioWriter
  stderr: StdioWriter
}

export class ProcessBootstrap {
  private readonly initializerPipeline = new InitializerPipeline<ProcessBootstrapInitializerContext>()

  registerInitializer(initializer: ProcessBootstrapInitializer): () => void {
    return this.initializerPipeline.register(initializer)
  }

  async boot(
    opts: ProcessBootstrapOptions,
    /** Optional MessagePort to send stdio back through. When null, uses globalThis.postMessage. */
    stdioPort?: MessagePort | null,
  ): Promise<BootstrappedContext> {
    const scope = globalThis as Record<string, unknown>
    const initializerContext: ProcessBootstrapInitializerContext = { opts, scope }
    await this.initializerPipeline.run(initializerContext, opts.bootstrapInitializers)

    const port = stdioPort ?? null
    const fallbackPostMessage: PostMessageFn | null =
      port || typeof scope.postMessage !== 'function'
        ? null
        : ((message: StdioMessage) => {
            ;(scope.postMessage as (m: StdioMessage) => void)(message)
          })

    const stdout = new StdioWriter(port, opts.pid, 'stdout', fallbackPostMessage)
    const stderr = new StdioWriter(port, opts.pid, 'stderr', fallbackPostMessage)
    const bunGlobal = (globalThis as Record<string, unknown>).Bun as { version?: string } | undefined

    // 1. Create process object
    const proc = createProcess({
      pid: opts.pid,
      argv: opts.argv,
      env: opts.env,
      cwd: opts.cwd,
      version: bunGlobal?.version ?? '0.0.0-web',
      stdin: {
        read: () => null,
      },
      stdout: {
        write: chunk => stdout.write(chunk),
        end: () => stdout.end(),
      },
      stderr: {
        write: chunk => stderr.write(chunk),
        end: () => stderr.end(),
      },
    })

    // 2. Install as globalThis.process
    installProcessGlobal(proc)

    // 3. Expose context on globalThis for interop
    scope.__BUN_WEB_PROCESS_CONTEXT__ = opts

    // 4. Install Bun globals for the current process worker.
    installBunGlobals(proc, {
      argv: opts.argv,
      cwd: opts.cwd,
      env: opts.env,
      vfs: opts.kernel.vfs ?? null,
    })

    // 5. Redirect console -> stdio writers
    installConsoleCapture(stdout, stderr)

    // 6. Hook process.exit to send exit message
    const origExit = proc.exit.bind(proc)
    proc.exit = (code = 0): never => {
      const msg: StdioMessage = { kind: 'exit', pid: opts.pid, code }
      try {
        if (port) {
          port.postMessage(msg)
        } else {
          fallbackPostMessage?.(msg)
        }
      } catch {
        // worker may already be closing
      }
      origExit(code)
      throw new Error('unreachable process.exit return')
    }

    // 7. Expose VFS reference if kernel has one
    if (opts.kernel.vfs) {
      scope.__BUN_WEB_VFS__ = opts.kernel.vfs
    }

    return { process: proc, stdout, stderr }
  }
}

const defaultProcessBootstrap = new ProcessBootstrap()

defaultProcessBootstrap.registerInitializer({
  id: 'runtime-transpiler-init',
  shouldRun: ({ opts }) => opts.initializeTranspiler === true,
  run: async ({ scope }) => {
    await initRuntimeTranspiler()
    scope.__BUN_WEB_TRANSPILER_READY__ = true
  },
})

defaultProcessBootstrap.registerInitializer({
  id: 'runtime-bundler-init',
  shouldRun: ({ opts }) => opts.initializeBundler === true,
  run: async ({ opts, scope }) => {
    await initRuntimeBundler(opts.bundlerInit ?? {})
    scope.__BUN_WEB_BUNDLER_READY__ = true
  },
})

export function getDefaultProcessBootstrap(): ProcessBootstrap {
  return defaultProcessBootstrap
}

export function registerProcessBootstrapInitializer(initializer: ProcessBootstrapInitializer): () => void {
  return defaultProcessBootstrap.registerInitializer(initializer)
}

export async function bootstrapProcessWorker(
  opts: ProcessBootstrapOptions,
  /** Optional MessagePort to send stdio back through. When null, uses globalThis.postMessage. */
  stdioPort?: MessagePort | null,
): Promise<BootstrappedContext> {
  return defaultProcessBootstrap.boot(opts, stdioPort)
}

