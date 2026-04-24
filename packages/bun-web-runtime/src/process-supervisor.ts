import type { Kernel, Pid } from '@mars/web-kernel'
import type { ProcessDescriptor, SpawnOptions } from '@mars/web-kernel'
import {
  bootstrapProcessWorker,
  type BootstrappedContext,
  type ProcessBootstrapOptions,
} from './process-bootstrap'

export interface AttachProcessControlOptions {
  pid: Pid
  port: MessagePort
  onExit?: (code: number) => void
}

export interface BootstrapSupervisedProcessOptions {
  bootstrap: ProcessBootstrapOptions
  onExit?: (code: number) => void
}

export interface SupervisedBootstrappedProcess extends BootstrappedContext {
  exited: Promise<number>
  onStdio: (listener: (kind: 'stdout' | 'stderr', data: string) => void) => () => void
  cleanup: () => void
}

export interface SpawnedSupervisedProcess extends SupervisedBootstrappedProcess {
  descriptor: ProcessDescriptor
}

export interface SpawnSupervisedProcessOptions extends SpawnOptions {
  sabBuffer?: SharedArrayBuffer | null
  onExit?: (code: number) => void
}

export class RuntimeProcessSupervisor {
  private readonly cleanupByPid = new Map<Pid, () => void>()

  constructor(private readonly kernel: Kernel) {}

  attachProcessControl(options: AttachProcessControlOptions): () => void {
    const { pid, port, onExit } = options

    this.cleanupByPid.get(pid)?.()
    this.cleanupByPid.delete(pid)

    const detachPort = this.kernel.attachProcessPort(pid, port)
    const handleExit = (payload: { pid: Pid; code: number }) => {
      if (payload.pid !== pid) return
      onExit?.(payload.code)
    }
    this.kernel.on('processExit', handleExit)

    const cleanup = () => {
      detachPort()
      this.kernel.off('processExit', handleExit)
      if (this.cleanupByPid.get(pid) === cleanup) {
        this.cleanupByPid.delete(pid)
      }
    }

    this.cleanupByPid.set(pid, cleanup)
    return cleanup
  }

  async bootstrapSupervisedProcess(
    options: BootstrapSupervisedProcessOptions,
  ): Promise<SupervisedBootstrappedProcess> {
    const { bootstrap, onExit } = options
    const channel = new MessageChannel()
    const exited = this.kernel.waitpid(bootstrap.pid)
    const cleanupControl = this.attachProcessControl({
      pid: bootstrap.pid,
      port: channel.port1,
      onExit,
    })

    try {
      const bootstrapped = await bootstrapProcessWorker(bootstrap, channel.port2)
      const cleanup = () => {
        cleanupControl()
        channel.port1.close()
        channel.port2.close()
      }

      return {
        ...bootstrapped,
        exited,
        onStdio: listener => this.kernel.onStdio(bootstrap.pid, listener),
        cleanup,
      }
    } catch (error) {
      cleanupControl()
      channel.port1.close()
      channel.port2.close()
      throw error
    }
  }

  async spawnSupervisedProcess(
    options: SpawnSupervisedProcessOptions,
  ): Promise<SpawnedSupervisedProcess> {
    const descriptor = await this.kernel.spawn({
      argv: options.argv,
      cwd: options.cwd,
      env: options.env,
    })

    const supervised = await this.bootstrapSupervisedProcess({
      bootstrap: {
        kernel: this.kernel,
        pid: descriptor.pid,
        argv: descriptor.argv,
        env: descriptor.env,
        cwd: descriptor.cwd,
        sabBuffer: options.sabBuffer ?? null,
      },
      onExit: options.onExit,
    })

    return {
      ...supervised,
      descriptor,
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanupByPid.values()) {
      cleanup()
    }
    this.cleanupByPid.clear()
  }
}
