import { Kernel, type KernelConfig } from '@mars/web-kernel'
import { createCommandRegistry, runShellCommandSync } from '@mars/web-shell'
import { RuntimeProcessSupervisor } from './process-supervisor'
import type { RuntimeBundlerInitOptions } from './bundler-runtime'
import type { SpawnedSupervisedProcess } from './process-supervisor'

const HOST_PROCESS = (globalThis as Record<string, unknown>).process as
  | {
      stdout?: { write?: (chunk: string) => unknown }
      stderr?: { write?: (chunk: string) => unknown }
    }
  | undefined

export interface SpawnOptions {
  cmd: string[]
  cwd?: string
  env?: Record<string, string>
  stdin?: 'pipe' | 'inherit' | 'ignore' | Blob | ReadableStream | string
  stdout?: 'pipe' | 'inherit' | 'ignore'
  stderr?: 'pipe' | 'inherit' | 'ignore'
  onExit?(proc: ChildProcess, exitCode: number, signal: number | null): void
}

export interface ChildProcess {
  readonly pid: number
  readonly stdin: WritableStream<Uint8Array> | null
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  kill(signal?: number): void
  ref(): void
  unref(): void
}

export interface RuntimeSpawnOptions extends SpawnOptions {
  kernel?: Kernel
  kernelConfig?: KernelConfig
  supervisor?: RuntimeProcessSupervisor
  sabBuffer?: SharedArrayBuffer | null
  bootstrapInitializers?: 'all' | string[]
  initializeTranspiler?: boolean
  initializeBundler?: boolean
  bundlerInit?: RuntimeBundlerInitOptions
}

export interface SyncSubprocess {
  readonly exitCode: number
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

function createOutputChannel(): {
  stream: ReadableStream<Uint8Array>
  write(chunk: string): void
  close(): void
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController
    },
  })

  return {
    stream,
    write(chunk: string) {
      controller?.enqueue(new TextEncoder().encode(chunk))
    },
    close() {
      controller?.close()
      controller = null
    },
  }
}

function createInputChannel(enabled: boolean): WritableStream<Uint8Array> | null {
  if (!enabled) return null

  return new WritableStream<Uint8Array>({
    write() {},
  })
}

type StdioOutputMode = 'pipe' | 'inherit' | 'ignore'

function resolveOutputMode(
  mode: SpawnOptions['stdout'] | SpawnOptions['stderr'] | undefined,
): StdioOutputMode {
  if (mode === 'inherit' || mode === 'ignore') {
    return mode
  }
  return 'pipe'
}

function writeInheritedOutput(kind: 'stdout' | 'stderr', data: string): void {
  if (kind === 'stdout') {
    if (typeof HOST_PROCESS?.stdout?.write === 'function') {
      HOST_PROCESS.stdout.write(data)
      return
    }
    console.log(data)
    return
  }

  if (typeof HOST_PROCESS?.stderr?.write === 'function') {
    HOST_PROCESS.stderr.write(data)
    return
  }
  console.error(data)
}

function dispatchOutput(
  mode: StdioOutputMode,
  kind: 'stdout' | 'stderr',
  data: string,
  channel: ReturnType<typeof createOutputChannel>,
): void {
  if (mode === 'ignore') {
    return
  }

  if (mode === 'inherit') {
    writeInheritedOutput(kind, data)
    return
  }

  channel.write(data)
}

export function createChildProcessHandle(
  kernel: Kernel,
  supervised: SpawnedSupervisedProcess,
  options: Pick<SpawnOptions, 'stdin' | 'stdout' | 'stderr' | 'onExit'> = {},
): ChildProcess {
  const stdoutChannel = createOutputChannel()
  const stderrChannel = createOutputChannel()
  const stdoutMode = resolveOutputMode(options.stdout)
  const stderrMode = resolveOutputMode(options.stderr)

  const unsubscribe = supervised.onStdio((kind, data) => {
    if (kind === 'stdout') {
      dispatchOutput(stdoutMode, 'stdout', data, stdoutChannel)
      return
    }

    dispatchOutput(stderrMode, 'stderr', data, stderrChannel)
  })

  let childProcess!: ChildProcess
  const exited = supervised.exited.then(code => {
    unsubscribe()
    stdoutChannel.close()
    stderrChannel.close()
    options.onExit?.(childProcess, code, null)
    return code
  })

  childProcess = {
    pid: supervised.descriptor.pid,
    stdin: createInputChannel(options.stdin === 'pipe'),
    stdout: stdoutChannel.stream,
    stderr: stderrChannel.stream,
    exited,
    kill(signal?: number) {
      kernel.kill(supervised.descriptor.pid, signal)
    },
    ref() {},
    unref() {},
  }

  return childProcess
}

function createLazyChildProcess(
  kernel: Kernel,
  options: RuntimeSpawnOptions,
  supervisedPromise: Promise<SpawnedSupervisedProcess>,
  ownSupervisor: RuntimeProcessSupervisor | null,
): ChildProcess {
  const stdoutChannel = createOutputChannel()
  const stderrChannel = createOutputChannel()
  const stdoutMode = resolveOutputMode(options.stdout)
  const stderrMode = resolveOutputMode(options.stderr)
  let resolvedPid = -1
  let pendingKill = false
  let pendingSignal: number | undefined

  const stdin = createInputChannel(options.stdin === 'pipe')

  let childProcess!: ChildProcess
  const exited = supervisedPromise.then(async supervised => {
    resolvedPid = supervised.descriptor.pid

    const unsubscribe = supervised.onStdio((kind, data) => {
      if (kind === 'stdout') {
        dispatchOutput(stdoutMode, 'stdout', data, stdoutChannel)
        return
      }

      dispatchOutput(stderrMode, 'stderr', data, stderrChannel)
    })

    if (pendingKill) {
      kernel.kill(resolvedPid, pendingSignal)
    }

    try {
      const code = await supervised.exited
      options.onExit?.(childProcess, code, null)
      return code
    } finally {
      unsubscribe()
      stdoutChannel.close()
      stderrChannel.close()
      supervised.cleanup()
      if (ownSupervisor) {
        ownSupervisor.dispose()
      }
    }
  })

  childProcess = {
    get pid() {
      return resolvedPid
    },
    stdin,
    stdout: stdoutChannel.stream,
    stderr: stderrChannel.stream,
    exited,
    kill(signal?: number) {
      if (resolvedPid > 0) {
        kernel.kill(resolvedPid, signal)
        return
      }
      pendingKill = true
      pendingSignal = signal
    },
    ref() {},
    unref() {},
  }

  return childProcess
}

export function spawn(options: RuntimeSpawnOptions): ChildProcess {
  if (options.cmd.length === 0) {
    throw new Error('spawn requires a non-empty cmd array')
  }

  const kernel = options.kernel ?? new Kernel(options.kernelConfig ?? {})
  const ownSupervisor = options.supervisor ? null : new RuntimeProcessSupervisor(kernel)
  const supervisor = options.supervisor ?? ownSupervisor!

  const supervised = supervisor.spawnSupervisedProcess({
    argv: options.cmd,
    cwd: options.cwd,
    env: options.env,
    sabBuffer: options.sabBuffer,
    bootstrapInitializers: options.bootstrapInitializers,
    initializeTranspiler: options.initializeTranspiler,
    initializeBundler: options.initializeBundler,
    bundlerInit: options.bundlerInit,
  })

  return createLazyChildProcess(kernel, options, supervised, ownSupervisor)
}

export function spawnSync(_options: SpawnOptions): SyncSubprocess {
  if (_options.cmd.length === 0) {
    throw new Error('spawnSync requires a non-empty cmd array')
  }

  const isShellScript = _options.cmd[0] === 'sh' && _options.cmd[1] === '-c' && typeof _options.cmd[2] === 'string'
  const commandLine = isShellScript ? _options.cmd[2] : _options.cmd.join(' ')
  const stdin =
    typeof _options.stdin === 'string' &&
    _options.stdin !== 'pipe' &&
    _options.stdin !== 'inherit' &&
    _options.stdin !== 'ignore'
      ? _options.stdin
      : ''

  const result = runShellCommandSync(commandLine, {
    cwd: _options.cwd,
    env: _options.env,
    stdin,
    registry: createCommandRegistry(),
  })

  return {
    exitCode: result.exitCode,
    stdout: new TextEncoder().encode(result.stdout),
    stderr: new TextEncoder().encode(result.stderr),
  }
}
