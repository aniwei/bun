import { ProcessTable } from "./process-table"
import { PortTable } from "./port-table"

import type { Disposable } from "@mars/bridge"
import type {
  KernelEvents,
  MarsKernelInterface,
  Pid,
  ProcessDescriptor,
  ProcessHandle,
  SpawnOptions,
  VirtualServer,
} from "./types"

type KernelEventListener = (payload: unknown) => void

export class MarsKernel implements MarsKernelInterface {
  readonly #processTable = new ProcessTable()
  readonly #portTable = new PortTable()
  readonly #listeners = new Map<keyof KernelEvents, Set<KernelEventListener>>()
  readonly #exitResolvers = new Map<Pid, (code: number) => void>()
  readonly #handles = new Map<Pid, VirtualProcessHandle>()
  #booted = false

  async boot(): Promise<void> {
    this.#booted = true
  }

  async shutdown(): Promise<void> {
    for (const record of this.#portTable.list()) {
      record.server.stop?.(true)
    }

    this.#portTable.clear()
    this.#processTable.clear()
    this.#booted = false
  }

  async spawn(options: SpawnOptions): Promise<ProcessHandle> {
    this.#assertBooted()

    const descriptor = this.#processTable.create(options)
    this.#processTable.update(descriptor.pid, { status: "running" })
    this.#emit("process:start", { pid: descriptor.pid, argv: descriptor.argv })

    const exited = new Promise<number>(resolve => {
      this.#exitResolvers.set(descriptor.pid, resolve)
    })

    const processHandle = new VirtualProcessHandle(descriptor.pid, exited, options, async signal => {
      await this.kill(descriptor.pid, signal)
    })
    this.#handles.set(descriptor.pid, processHandle)

    return processHandle
  }

  async kill(pid: Pid, signal?: string | number): Promise<void> {
    const process = this.#processTable.get(pid)
    if (!process) throw new Error(`Unknown pid: ${pid}`)

    this.#processTable.setStatus(pid, "killed", typeof signal === "number" ? signal : 0)
    this.#handles.get(pid)?.close()
    this.#handles.delete(pid)
    this.#resolveExit(pid, typeof signal === "number" ? signal : 0)
  }

  writeStdio(pid: Pid, fd: 1 | 2, chunk: string | Uint8Array): void {
    const process = this.#processTable.get(pid)
    if (!process) throw new Error(`Unknown pid: ${pid}`)

    const data = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
    this.#handles.get(pid)?.writeStdio(fd, data)
    this.#emit("stdio", { pid, fd, chunk: data })
  }

  async waitpid(pid: Pid): Promise<number> {
    const process = this.#processTable.get(pid)
    if (!process) throw new Error(`Unknown pid: ${pid}`)
    if (process.exitCode !== null) return process.exitCode

    return new Promise(resolve => {
      this.#exitResolvers.set(pid, resolve)
    })
  }

  ps(): ProcessDescriptor[] {
    return this.#processTable.list()
  }

  registerPort(pid: Pid, port: number, server: VirtualServer): void {
    this.#assertBooted()
    this.#portTable.register(pid, port, server)
    this.#emit("server:listen", { pid, port, protocol: "http" })
  }

  unregisterPort(port: number): void {
    const pid = this.#portTable.resolve(port)
    this.#portTable.unregister(port)
    if (pid !== null) this.#emit("server:close", { pid, port })
  }

  resolvePort(port: number): Pid | null {
    return this.#portTable.resolve(port)
  }

  async dispatchToPort(port: number, request: Request): Promise<Response> {
    const record = this.#portTable.get(port)
    if (!record) return new Response("Port not found", { status: 404 })

    return record.server.fetch(request)
  }

  on<K extends keyof KernelEvents>(event: K, listener: KernelEvents[K]): Disposable {
    const listeners = this.#listeners.get(event) ?? new Set<KernelEventListener>()
    listeners.add(listener as KernelEventListener)
    this.#listeners.set(event, listeners)

    return {
      dispose: () => {
        listeners.delete(listener as KernelEventListener)
      },
    }
  }

  #resolveExit(pid: Pid, code: number): void {
    this.#emit("process:exit", { pid, code })
    this.#exitResolvers.get(pid)?.(code)
    this.#exitResolvers.delete(pid)
  }

  #emit<K extends keyof KernelEvents>(event: K, payload: Parameters<KernelEvents[K]>[0]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(payload)
    }
  }

  #assertBooted(): void {
    if (!this.#booted) throw new Error("MarsKernel is not booted")
  }
}

class VirtualProcessHandle implements ProcessHandle {
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly pid: Pid
  readonly exited: Promise<number>
  readonly #kill: (signal?: string | number) => Promise<void>
  #stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null
  #stderrController: ReadableStreamDefaultController<Uint8Array> | null = null
  #stdoutWriter: WritableStreamDefaultWriter<Uint8Array> | null = null
  #stderrWriter: WritableStreamDefaultWriter<Uint8Array> | null = null
  #closed = false

  constructor(
    pid: Pid,
    exited: Promise<number>,
    options: SpawnOptions,
    kill: (signal?: string | number) => Promise<void>,
  ) {
    this.pid = pid
    this.exited = exited
    this.#kill = kill
    this.stdout = new ReadableStream<Uint8Array>({
      start: controller => {
        this.#stdoutController = controller
      },
    })
    this.stderr = new ReadableStream<Uint8Array>({
      start: controller => {
        this.#stderrController = controller
      },
    })
    this.#stdoutWriter = options.stdout?.getWriter() ?? null
    this.#stderrWriter = options.stderr?.getWriter() ?? null
  }

  async write(input: string | Uint8Array): Promise<void> {
    void input
  }

  async kill(signal?: string | number): Promise<void> {
    await this.#kill(signal)
  }

  writeStdio(fd: 1 | 2, chunk: Uint8Array): void {
    if (this.#closed) return

    const controller = fd === 1 ? this.#stdoutController : this.#stderrController
    const writer = fd === 1 ? this.#stdoutWriter : this.#stderrWriter
    controller?.enqueue(chunk)
    void writer?.write(chunk)
  }

  close(): void {
    if (this.#closed) return

    this.#closed = true
    this.#stdoutController?.close()
    this.#stderrController?.close()
    void this.#stdoutWriter?.close()
    void this.#stderrWriter?.close()
  }
}

export function createMarsKernel(): MarsKernel {
  return new MarsKernel()
}