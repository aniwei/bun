import { createMarsProcessWorkerFactory } from "./process-worker-factory"

import type { MarsBridgeEndpoint } from "@mars/bridge"
import type { MarsVFSPatch } from "@mars/vfs"
import type { MarsKernel } from "./kernel"
import type { MarsProcessWorkerController, MarsProcessWorkerFactory, ProcessWorkerExitMessage } from "./process-worker-factory"
import type { SpawnOptions } from "./types"

export interface KernelWorkerController {
  dispose(): void
}

export interface KernelWorkerControllerOptions {
  endpoint: MarsBridgeEndpoint
  kernel: MarsKernel
  processWorkerFactory?: MarsProcessWorkerFactory
}

export interface ProcessWorkerCreatePayload {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface ProcessWorkerMessagePayload {
  id: string
  message: unknown
}

export interface ProcessWorkerVFSPatchPayload {
  id: string
  patches: MarsVFSPatch[]
}

export interface ProcessWorkerRunPayload {
  id: string
  argv?: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface ProcessWorkerTerminatePayload {
  id: string
}

export interface KernelResolvePortPayload {
  port: number
}

export interface SerializedKernelRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

export interface KernelServerRequestPayload {
  pid: number
  request: SerializedKernelRequest
}

interface ManagedProcessWorker {
  pid: number
  controller: MarsProcessWorkerController
  reader: ReadableStreamDefaultReader<unknown>
  stdinDone?: Promise<void>
  stdoutDone?: Promise<void>
  stderrDone?: Promise<void>
}

export function createKernelWorkerController(
  options: KernelWorkerControllerOptions,
): KernelWorkerController {
  return new DefaultKernelWorkerController(options)
}

class DefaultKernelWorkerController implements KernelWorkerController {
  readonly #endpoint: MarsBridgeEndpoint
  readonly #kernel: MarsKernel
  readonly #processWorkerFactory: MarsProcessWorkerFactory
  readonly #workers = new Map<string, ManagedProcessWorker>()
  readonly #disposables: Array<{ dispose(): void }> = []

  constructor(options: KernelWorkerControllerOptions) {
    this.#endpoint = options.endpoint
    this.#kernel = options.kernel
    this.#processWorkerFactory = options.processWorkerFactory ?? createMarsProcessWorkerFactory()
    this.#registerHandlers()
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose()
    for (const worker of this.#workers.values()) {
      void worker.controller.terminate()
    }
    this.#workers.clear()
  }

  #registerHandlers(): void {
    this.#disposables.push(
      this.#endpoint.on("kernel.boot", async () => {
        await this.#kernel.boot()
        return { booted: true }
      }),
      this.#endpoint.on("kernel.shutdown", async () => {
        await this.#kernel.shutdown()
        return { booted: false }
      }),
      this.#endpoint.on<SpawnOptions>("kernel.spawn", async options => {
        if (options.kind === "worker") return this.#spawnProcessWorker(options)

        const processHandle = await this.#kernel.spawn(options)
        return {
          pid: processHandle.pid,
          argv: options.argv,
        }
      }),
      this.#endpoint.on<{ pid: number; signal?: string | number }>("kernel.kill", async payload => {
        await this.#kernel.kill(payload.pid, payload.signal)
        return { pid: payload.pid }
      }),
      this.#endpoint.on<{ pid: number }>("kernel.waitpid", async payload => {
        return { pid: payload.pid, exitCode: await this.#kernel.waitpid(payload.pid) }
      }),
      this.#endpoint.on<KernelResolvePortPayload>("kernel.resolvePort", async payload => {
        return { pid: this.#kernel.resolvePort(payload.port) }
      }),
      this.#endpoint.on<KernelServerRequestPayload>("server.request", payload => {
        return this.#dispatchServerRequest(payload)
      }),
      this.#endpoint.on<ProcessWorkerCreatePayload>("process.worker.create", payload => {
        return this.#createProcessWorker(payload)
      }),
      this.#endpoint.on<ProcessWorkerMessagePayload>("process.worker.message", payload => {
        return this.#postProcessWorkerMessage(payload)
      }),
      this.#endpoint.on<ProcessWorkerVFSPatchPayload>("process.worker.vfs.patch", payload => {
        return this.#syncProcessWorkerVFS(payload)
      }),
      this.#endpoint.on<ProcessWorkerRunPayload>("process.worker.run", payload => {
        return this.#runProcessWorker(payload)
      }),
      this.#endpoint.on<ProcessWorkerTerminatePayload>("process.worker.terminate", payload => {
        return this.#terminateProcessWorker(payload.id)
      }),
    )
  }

  async #createProcessWorker(payload: ProcessWorkerCreatePayload) {
    const controller = await this.#processWorkerFactory.create({
      argv: payload.argv,
      cwd: payload.cwd,
      env: payload.env,
      onMessage: message => ({ echoed: message }),
    })
    const reader = controller.messages.getReader()

    this.#workers.set(controller.id, { pid: 0, controller, reader })
    await controller.boot()

    return {
      id: controller.id,
      argv: controller.argv,
      status: controller.status(),
      event: (await reader.read()).value,
    }
  }

  async #dispatchServerRequest(payload: KernelServerRequestPayload) {
    const request = deserializeKernelRequest(payload.request)
    const port = Number(new URL(request.url).port || 80)
    const resolvedPid = this.#kernel.resolvePort(port)
    if (resolvedPid !== payload.pid) return serializeKernelResponse(new Response("Port not found", { status: 404 }))

    return serializeKernelResponse(await this.#kernel.dispatchToPort(port, request))
  }

  async #spawnProcessWorker(options: SpawnOptions) {
    const processHandle = await this.#kernel.spawn(options)
    const controller = await this.#processWorkerFactory.create({
      argv: options.argv,
      cwd: options.cwd,
      env: options.env,
      onMessage: message => ({ echoed: message }),
    })
    const reader = controller.messages.getReader()
    const stdinDone = this.#pipeWorkerInput(processHandle.stdin, controller)
    const stdoutDone = this.#pipeWorkerOutput(processHandle.pid, 1, controller.stdout)
    const stderrDone = this.#pipeWorkerOutput(processHandle.pid, 2, controller.stderr)

    this.#workers.set(controller.id, {
      pid: processHandle.pid,
      controller,
      reader,
      stdinDone,
      stdoutDone,
      stderrDone,
    })
    await controller.boot()
    const bootEvent = await reader.read()

    void processHandle.exited.finally(() => {
      void Promise.allSettled([stdinDone]).finally(() => controller.terminate().catch(() => {}))
    })
    void this.#monitorProcessWorker(processHandle.pid, controller.id, reader, stdoutDone, stderrDone)

    return {
      pid: processHandle.pid,
      argv: options.argv,
      workerId: controller.id,
      status: controller.status(),
      event: bootEvent.value,
    }
  }

  async #pipeWorkerInput(
    stream: ReadableStream<Uint8Array>,
    controller: MarsProcessWorkerController,
  ): Promise<void> {
    const reader = stream.getReader()

    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) {
          await controller.closeStdin()
          return
        }

        await controller.write(chunk.value)
      }
    } catch {
      // The worker may exit while stdin is still being drained.
    } finally {
      reader.releaseLock()
    }
  }

  async #pipeWorkerOutput(pid: number, fd: 1 | 2, stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader()

    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return

        this.#kernel.writeStdio(pid, fd, chunk.value)
      }
    } catch {
      // The kernel process may have been killed before the worker stream drains.
    } finally {
      reader.releaseLock()
    }
  }

  async #monitorProcessWorker(
    pid: number,
    id: string,
    reader: ReadableStreamDefaultReader<unknown>,
    stdoutDone: Promise<void>,
    stderrDone: Promise<void>,
  ): Promise<void> {
    try {
      while (true) {
        const message = await reader.read()
        if (message.done) return

        const payload = message.value as Partial<ProcessWorkerExitMessage> | undefined
        if (payload?.type !== "process.worker.exit") continue

        await Promise.all([stdoutDone, stderrDone])
        await this.#kernel.kill(pid, payload.code ?? 0)
        this.#workers.delete(id)
        return
      }
    } finally {
      reader.releaseLock()
    }
  }

  async #postProcessWorkerMessage(payload: ProcessWorkerMessagePayload) {
    const worker = this.#requireWorker(payload.id)

    await worker.controller.postMessage(payload.message)
    return {
      id: worker.controller.id,
      status: worker.controller.status(),
      event: (await worker.reader.read()).value,
    }
  }

  async #syncProcessWorkerVFS(payload: ProcessWorkerVFSPatchPayload) {
    const worker = this.#requireWorker(payload.id)

    await worker.controller.syncVFS(payload.patches)
    return {
      id: worker.controller.id,
      status: worker.controller.status(),
      event: worker.stdoutDone ? undefined : (await worker.reader.read()).value,
    }
  }

  async #runProcessWorker(payload: ProcessWorkerRunPayload) {
    const worker = this.#requireWorker(payload.id)

    await worker.controller.run({
      argv: payload.argv,
      cwd: payload.cwd,
      env: payload.env,
    })
    return {
      id: worker.controller.id,
      status: worker.controller.status(),
      event: worker.stdoutDone ? undefined : (await worker.reader.read()).value,
    }
  }

  async #terminateProcessWorker(id: string) {
    const worker = this.#requireWorker(id)

    await worker.controller.terminate()
    try {
      worker.reader.releaseLock()
    } catch {
      // The worker may already be monitored by kernel.spawn(kind: "worker").
    }
    this.#workers.delete(id)

    return {
      id,
      status: worker.controller.status(),
    }
  }

  #requireWorker(id: string): ManagedProcessWorker {
    const worker = this.#workers.get(id)
    if (!worker) throw new Error(`Unknown process worker: ${id}`)

    return worker
  }
}

async function serializeKernelResponse(response: Response) {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })

  return {
    status: response.status,
    headers,
    body: await response.text(),
  }
}

function deserializeKernelRequest(request: SerializedKernelRequest): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  })
}
