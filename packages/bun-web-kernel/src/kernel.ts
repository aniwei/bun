import { ProcessTable } from './process-table'
import { KernelStateError, ProcessNotFoundError } from './errors'
import { SyscallBridge } from './syscall-bridge'
import { TypedEventEmitter, type Events } from '@mars/web-shared'
import type { KernelConfig, Pid, ProcessDescriptor, SpawnOptions } from './kernel.types'
import type { VFS } from '@mars/web-vfs'

type KernelEvents = Events & {
  stdio: (payload: { pid: Pid; kind: 'stdout' | 'stderr'; data: string }) => void
  processExit: (payload: { pid: Pid; code: number }) => void
}

export class Kernel extends TypedEventEmitter<KernelEvents> {
  private static current: Kernel | null = null

  static async boot(config: KernelConfig = {}, vfs?: VFS): Promise<Kernel> {
    if (Kernel.current) {
      return Kernel.current
    }

    const kernel = new Kernel(config, vfs)
    Kernel.current = kernel
    return kernel
  }

  static async shutdown(): Promise<void> {
    Kernel.current = null
  }

  static get instance(): Kernel {
    if (!Kernel.current) {
      throw new KernelStateError('Kernel has not been booted')
    }

    return Kernel.current
  }

  private nextPid = 100
  private readonly processTable = new ProcessTable()
  private readonly portTable = new Map<number, Pid>()
  private readonly bridge: SyscallBridge
  // stdio channels: pid → { stdout, stderr } MessageChannel ports
  private readonly stdioChannels = new Map<Pid, { stdout: MessageChannel; stderr: MessageChannel }>()
  // process message port detach callbacks: pid → detach
  private readonly processPortDetachers = new Map<Pid, () => void>()
  // exit waiters: pid → resolve fn array
  private readonly exitWaiters = new Map<Pid, Array<(code: number) => void>>()

  private constructor(
    readonly config: KernelConfig,
    readonly vfs?: VFS,
  ) {
    super()
    this.bridge = new SyscallBridge(config.asyncFallback ? null : new SharedArrayBuffer(config.sabSize ?? 1024 * 1024))
  }

  get processes(): ProcessTable {
    return this.processTable
  }

  get syscallBridge(): SyscallBridge {
    return this.bridge
  }

  /**
   * Allocate stdio channels for a pid.
   * Returns the "process side" MessagePorts (for the Process Worker).
   * The "kernel side" ports are stored internally for reading.
   */
  allocateStdio(pid: Pid): { stdoutPort: MessagePort; stderrPort: MessagePort } {
    const stdoutCh = new MessageChannel()
    const stderrCh = new MessageChannel()
    this.stdioChannels.set(pid, { stdout: stdoutCh, stderr: stderrCh })
    // Kernel side: listen for data on port1
    stdoutCh.port1.start()
    stderrCh.port1.start()
    stdoutCh.port1.onmessage = (event: MessageEvent) => {
      this.emitStdio(pid, 'stdout', event.data?.data ?? '')
    }
    stderrCh.port1.onmessage = (event: MessageEvent) => {
      this.emitStdio(pid, 'stderr', event.data?.data ?? '')
    }
    return { stdoutPort: stdoutCh.port2, stderrPort: stderrCh.port2 }
  }

  /**
   * Attach a worker message port that emits { kind, pid, data?, code? }.
   * - stdout/stderr messages are forwarded to stdio listeners
   * - exit messages notify waitpid and process lifecycle
   */
  attachProcessPort(pid: Pid, port: MessagePort): () => void {
    this.processPortDetachers.get(pid)?.()
    this.processPortDetachers.delete(pid)

    port.start()
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as {
        kind?: unknown
        pid?: unknown
        data?: unknown
        code?: unknown
      }
      if (!msg || msg.pid !== pid || typeof msg.kind !== 'string') return
      if (msg.kind === 'stdout' || msg.kind === 'stderr') {
        this.emitStdio(pid, msg.kind, typeof msg.data === 'string' ? msg.data : '')
        return
      }
      if (msg.kind === 'exit') {
        this.notifyExit(pid, typeof msg.code === 'number' ? msg.code : 0)
      }
    }
    port.addEventListener('message', onMessage)

    const detach = () => {
      port.removeEventListener('message', onMessage)
    }

    this.processPortDetachers.set(pid, detach)

    return () => {
      detach()
      if (this.processPortDetachers.get(pid) === detach) {
        this.processPortDetachers.delete(pid)
      }
    }
  }

  /**
   * Subscribe to a process's stdout/stderr.
   * Returns an unsubscribe function.
   */
  onStdio(
    pid: Pid,
    listener: (kind: 'stdout' | 'stderr', data: string) => void,
  ): () => void {
    const handler = (payload: { pid: Pid; kind: 'stdout' | 'stderr'; data: string }) => {
      if (payload.pid !== pid) return
      listener(payload.kind, payload.data)
    }
    this.on('stdio', handler)
    return () => {
      this.off('stdio', handler)
    }
  }

  private emitStdio(pid: Pid, kind: 'stdout' | 'stderr', data: string): void {
    this.emit('stdio', { pid, kind, data })
  }

  async spawn(opts: SpawnOptions): Promise<ProcessDescriptor> {
    const pid = this.nextPid++
    const channel = new MessageChannel()
    const desc: ProcessDescriptor = {
      pid,
      cwd: opts.cwd ?? '/',
      env: opts.env ?? {},
      argv: opts.argv,
      stdio: {
        stdin: 0,
        stdout: 1,
        stderr: 2,
      },
      status: 'running',
      exitCode: null,
      port: channel.port1,
    }

    this.processTable.add(desc)
    channel.port2.close()
    return desc
  }

  kill(pid: Pid, _signal?: number): void {
    const process = this.processTable.get(pid)
    if (!process) {
      throw new ProcessNotFoundError(pid)
    }

    process.status = 'exited'
    process.exitCode = 0
    this._resolveExitWaiters(pid, 0)
    this.emit('processExit', { pid, code: 0 })
    this.processTable.remove(pid)
    this.cleanupProcessResources(pid)
  }

  /** Mark a process as exited with the given code (called when process sends exit message) */
  notifyExit(pid: Pid, code: number): void {
    const process = this.processTable.get(pid)
    if (!process) return
    process.status = 'exited'
    process.exitCode = code
    this._resolveExitWaiters(pid, code)
    this.emit('processExit', { pid, code })
    this.processTable.remove(pid)
    this.cleanupProcessResources(pid)
  }

  private cleanupProcessResources(pid: Pid): void {
    this.processPortDetachers.get(pid)?.()
    this.processPortDetachers.delete(pid)

    const stdio = this.stdioChannels.get(pid)
    if (stdio) {
      stdio.stdout.port1.onmessage = null
      stdio.stderr.port1.onmessage = null
      stdio.stdout.port1.close()
      stdio.stderr.port1.close()
    }
    this.stdioChannels.delete(pid)
  }

  private _resolveExitWaiters(pid: Pid, code: number): void {
    const waiters = this.exitWaiters.get(pid)
    if (waiters) {
      for (const resolve of waiters) resolve(code)
      this.exitWaiters.delete(pid)
    }
  }

  async waitpid(pid: Pid): Promise<number> {
    const process = this.processTable.get(pid)
    if (!process) {
      // Already exited — return 0
      return 0
    }
    if (process.status === 'exited') {
      return process.exitCode ?? 0
    }
    // Wait for exit notification
    return new Promise<number>(resolve => {
      let waiters = this.exitWaiters.get(pid)
      if (!waiters) {
        waiters = []
        this.exitWaiters.set(pid, waiters)
      }
      waiters.push(resolve)
    })
  }

  registerPort(pid: Pid, port: number): void {
    this.portTable.set(port, pid)
  }

  unregisterPort(port: number): void {
    this.portTable.delete(port)
  }

  resolvePort(port: number): Pid | null {
    return this.portTable.get(port) ?? null
  }
}

