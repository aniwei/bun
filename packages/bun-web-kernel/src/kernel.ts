import { ProcessTable } from './process-table'
import { KernelStateError, ProcessNotFoundError } from './errors'
import { SyscallBridge } from './syscall-bridge'
import type { KernelConfig, Pid, ProcessDescriptor, SpawnOptions } from './kernel.types'
import type { VFS } from '../../bun-web-vfs/src/overlay-fs'

export class Kernel {
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

  private constructor(
    readonly config: KernelConfig,
    readonly vfs?: VFS,
  ) {
    this.bridge = new SyscallBridge(config.asyncFallback ? null : new SharedArrayBuffer(config.sabSize ?? 1024 * 1024))
  }

  get processes(): ProcessTable {
    return this.processTable
  }

  get syscallBridge(): SyscallBridge {
    return this.bridge
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

  kill(pid: Pid): void {
    const process = this.processTable.get(pid)
    if (!process) {
      throw new ProcessNotFoundError(pid)
    }

    process.status = 'exited'
    process.exitCode = 0
    this.processTable.remove(pid)
  }

  async waitpid(pid: Pid): Promise<number> {
    const process = this.processTable.get(pid)
    if (!process) {
      throw new ProcessNotFoundError(pid)
    }

    return process.exitCode ?? 0
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
