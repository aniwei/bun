import { TypedEventEmitter } from '@mars/web-shared'

export type ProcessEnv = Record<string, string>

export type ProcessEvents = Record<string, (...args: unknown[]) => void> & {
  exit: (code: number) => void
  signal: (signal: string) => void
}

export type ProcessChunk = string | Uint8Array

export interface ProcessReadableAdapter {
  read(size?: number): ProcessChunk | null
}

export interface ProcessWritableAdapter {
  write(chunk: ProcessChunk): void
  end?(): void
}

export interface ProcessStdinShape {
  readonly fd: 0
  readonly isTTY: false
  read(size?: number): ProcessChunk | null
  resume(): void
  pause(): void
}

export interface ProcessWritableShape {
  readonly fd: 1 | 2
  readonly isTTY: false
  write(chunk: ProcessChunk): boolean
  end(chunk?: ProcessChunk): void
}

export interface MarsWebProcessShape {
  readonly pid: number
  readonly ppid: number
  readonly platform: 'browser'
  readonly version: string
  readonly versions: Record<string, string>
  readonly isBun: true
  readonly browser: true
  readonly stdin: ProcessStdinShape
  readonly stdout: ProcessWritableShape
  readonly stderr: ProcessWritableShape
  argv: string[]
  env: ProcessEnv
  cwd(): string
  chdir(nextDir: string): void
  on(event: string, listener: (...args: unknown[]) => void): MarsWebProcessShape
  addListener(event: string, listener: (...args: unknown[]) => void): MarsWebProcessShape
  off(event: string, listener: (...args: unknown[]) => void): MarsWebProcessShape
  removeListener(event: string, listener: (...args: unknown[]) => void): MarsWebProcessShape
  removeAllListeners(event?: string): MarsWebProcessShape
  listeners(event: string): Array<(...args: unknown[]) => void>
  listenerCount(event: string): number
  once(event: string, listener: (...args: unknown[]) => void): MarsWebProcessShape
  emit(event: string, ...args: unknown[]): boolean
  nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]): void
  kill(pid: number, signal?: string | number): boolean
  exit(code?: number): never
}

export class MarsWebProcess extends TypedEventEmitter<ProcessEvents> implements MarsWebProcessShape {
  readonly pid: number
  readonly ppid: number
  readonly platform: 'browser'
  readonly version: string
  readonly versions: Record<string, string>
  readonly isBun = true
  readonly browser = true
  readonly stdin: ProcessStdinShape
  readonly stdout: ProcessWritableShape
  readonly stderr: ProcessWritableShape

  argv: string[]
  env: ProcessEnv

  private currentDir: string

  constructor(options: CreateProcessOptions) {
    super()

    this.pid = options.pid
    this.ppid = options.ppid ?? 1
    this.platform = 'browser'
    this.version = options.version ?? '0.0.0-web'
    this.versions = {
      bun: this.version,
      webcontainer: 'm1',
    }

    this.argv = options.argv ?? []
    this.env = options.env ?? {}
    this.currentDir = options.cwd ?? '/'
    this.stdin = createStdinHandle(options.stdin)
    this.stdout = createWritableHandle(1, options.stdout)
    this.stderr = createWritableHandle(2, options.stderr)
  }

  cwd(): string {
    return this.currentDir
  }

  chdir(nextDir: string): void {
    if (!nextDir || !nextDir.startsWith('/')) {
      throw new Error('process.chdir only accepts absolute paths in bun-web m1')
    }

    this.currentDir = nextDir
  }

  nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]): void {
    queueMicrotask(() => {
      fn(...args)
    })
  }

  kill(pid: number, signal?: string | number): boolean {
    if (pid !== this.pid) {
      throw new Error('process.kill only supports current process pid in bun-web m1')
    }

    const normalizedSignal = this.normalizeSignal(signal)
    this.emit(normalizedSignal, normalizedSignal)
    this.emit('signal', normalizedSignal)
    return true
  }

  exit(code = 0): never {
    this.emit('exit', code)
    throw new Error(`process.exit(${code})`)
  }

  private normalizeSignal(signal?: string | number): string {
    if (typeof signal === 'number') {
      if (signal === 2) {
        return 'SIGINT'
      }

      if (signal === 15) {
        return 'SIGTERM'
      }

      return `SIG${signal}`
    }

    return signal ?? 'SIGTERM'
  }
}

export interface CreateProcessOptions {
  pid: number
  argv?: string[]
  env?: ProcessEnv
  cwd?: string
  version?: string
  ppid?: number
  stdin?: ProcessReadableAdapter
  stdout?: ProcessWritableAdapter
  stderr?: ProcessWritableAdapter
}

function createStdinHandle(adapter?: ProcessReadableAdapter): ProcessStdinShape {
  return {
    fd: 0,
    isTTY: false,
    read(size?: number) {
      return adapter?.read(size) ?? null
    },
    resume() {},
    pause() {},
  }
}

function createWritableHandle(fd: 1 | 2, adapter?: ProcessWritableAdapter): ProcessWritableShape {
  return {
    fd,
    isTTY: false,
    write(chunk: ProcessChunk) {
      adapter?.write(chunk)
      return true
    },
    end(chunk?: ProcessChunk) {
      if (chunk !== undefined) {
        adapter?.write(chunk)
      }
      adapter?.end?.()
    },
  }
}

export function createProcess(options: CreateProcessOptions): MarsWebProcessShape {
  return new MarsWebProcess(options)
}

export function installProcessGlobal(proc: MarsWebProcessShape): MarsWebProcessShape {
  const scope = globalThis as Record<string, unknown>
  scope.process = proc
  return proc
}
