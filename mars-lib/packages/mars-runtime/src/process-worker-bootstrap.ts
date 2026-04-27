import { MarsKernel } from "@mars/kernel"
import { applyVFSPatches } from "@mars/vfs"

import { installMarsRuntimeContext } from "./install-global"
import { runEntryScript } from "./run-entry"

import type { Disposable } from "@mars/bridge"
import type { MarsVFS } from "@mars/vfs"
import type { MarsVFSPatch } from "@mars/vfs"
import type { MarsRuntimeContextInstallation } from "./install-global"
import type { RuntimeContext } from "./types"

export interface ProcessWorkerBootstrapScope extends Pick<typeof globalThis, "console"> {
  postMessage(message: unknown): void
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void
  close?(): void
}

export interface ProcessWorkerRuntimeBootstrapOptions {
  scope: ProcessWorkerBootstrapScope & Record<string, unknown>
  vfs: MarsVFS
  kernel?: MarsKernel
  autoRun?: boolean
}

export interface ProcessWorkerRuntimeBootstrap {
  idle(): Promise<void>
  dispose(): void
}

interface ProcessWorkerBootMessage {
  type: "process.worker.boot"
  id: string
  argv: string[]
  cwd?: string
  env?: Record<string, string>
}

interface ProcessWorkerDataMessage {
  type: "process.worker.message" | "process.worker.stdin"
  id: string
  data?: unknown
  chunk?: string | Uint8Array
}

interface ProcessWorkerRunMessage {
  type: "process.worker.run"
  id: string
  argv?: string[]
  cwd?: string
  env?: Record<string, string>
}

interface ProcessWorkerVFSPatchMessage {
  type: "process.worker.vfs.patch"
  id: string
  patches: MarsVFSPatch[]
}

interface ProcessWorkerTerminateMessage {
  type: "process.worker.terminate"
  id: string
}

type ProcessWorkerIncomingMessage =
  | ProcessWorkerBootMessage
  | ProcessWorkerDataMessage
  | ProcessWorkerRunMessage
  | ProcessWorkerVFSPatchMessage
  | ProcessWorkerTerminateMessage

export function installProcessWorkerRuntimeBootstrap(
  options: ProcessWorkerRuntimeBootstrapOptions,
): ProcessWorkerRuntimeBootstrap {
  return new DefaultProcessWorkerRuntimeBootstrap(options)
}

class DefaultProcessWorkerRuntimeBootstrap implements ProcessWorkerRuntimeBootstrap {
  readonly #scope: ProcessWorkerBootstrapScope & Record<string, unknown>
  readonly #vfs: MarsVFS
  readonly #kernel: MarsKernel
  readonly #autoRun: boolean
  readonly #messageListener = (event: MessageEvent<unknown>) => {
    void this.#handleMessage(event.data as Partial<ProcessWorkerIncomingMessage> | undefined)
  }
  #processId: string | null = null
  #pid: number | null = null
  #stdioSubscription: Disposable | null = null
  #contextInstallation: MarsRuntimeContextInstallation | null = null
  #runtimeContext: RuntimeContext | null = null
  #currentTask: Promise<void> | null = null
  #disposed = false
  #exited = false

  constructor(options: ProcessWorkerRuntimeBootstrapOptions) {
    this.#scope = options.scope
    this.#vfs = options.vfs
    this.#kernel = options.kernel ?? new MarsKernel()
    this.#autoRun = options.autoRun ?? true
    this.#scope.addEventListener("message", this.#messageListener)
  }

  dispose(): void {
    if (this.#disposed) return

    this.#disposed = true
    this.#scope.removeEventListener("message", this.#messageListener)
    this.#stdioSubscription?.dispose()
    this.#stdioSubscription = null
    this.#contextInstallation?.dispose()
    this.#contextInstallation = null
  }

  idle(): Promise<void> {
    return this.#currentTask ?? Promise.resolve()
  }

  async #handleMessage(message: Partial<ProcessWorkerIncomingMessage> | undefined): Promise<void> {
    if (!message?.type || !message.id) return

    if (message.type === "process.worker.boot") {
      this.#currentTask = this.#boot(message as ProcessWorkerBootMessage)
      await this.#currentTask
      return
    }

    if (message.id !== this.#processId) return

    if (message.type === "process.worker.message") {
      this.#scope.postMessage({ type: "message", id: message.id, data: (message as ProcessWorkerDataMessage).data })
      return
    }

    if (message.type === "process.worker.vfs.patch") {
      this.#currentTask = this.#applyVFSPatches(message as ProcessWorkerVFSPatchMessage)
      await this.#currentTask
      return
    }

    if (message.type === "process.worker.run") {
      this.#currentTask = this.#run(message as ProcessWorkerRunMessage)
      await this.#currentTask
      return
    }

    if (message.type === "process.worker.terminate") {
      this.#currentTask = this.#terminate(0)
      await this.#currentTask
    }
  }

  async #boot(message: ProcessWorkerBootMessage): Promise<void> {
    if (this.#processId) await this.#terminate(0, false)
    await this.#kernel.boot()

    const handle = await this.#kernel.spawn({
      argv: message.argv,
      cwd: message.cwd ?? this.#vfs.cwd(),
      env: message.env,
      kind: "worker",
    })
    const context = this.#createRuntimeContext(message, handle.pid)

    this.#processId = message.id
    this.#pid = handle.pid
    this.#exited = false
    this.#stdioSubscription = this.#kernel.on("stdio", payload => {
      if (payload.pid !== handle.pid) return

      this.#scope.postMessage({
        type: payload.fd === 1 ? "process.worker.stdout" : "process.worker.stderr",
        id: message.id,
        chunk: payload.chunk,
      })
    })
    this.#contextInstallation = installMarsRuntimeContext(context)
    this.#runtimeContext = context
    this.#scope.postMessage({ type: "boot", id: message.id, argv: message.argv })

    if (!this.#autoRun) return

    await this.#run({ type: "process.worker.run", id: message.id, argv: message.argv, cwd: message.cwd, env: message.env })
  }

  async #applyVFSPatches(message: ProcessWorkerVFSPatchMessage): Promise<void> {
    try {
      await applyVFSPatches(this.#vfs, message.patches)
      this.#scope.postMessage({ type: "process.worker.vfs.patch", id: message.id, ok: true, count: message.patches.length })
    } catch (error) {
      this.#scope.postMessage({
        type: "process.worker.vfs.patch",
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async #run(message: ProcessWorkerRunMessage): Promise<void> {
    if (!this.#runtimeContext || this.#pid === null) return

    const argv = message.argv ?? this.#runtimeContext.argv ?? []
    const entry = parseBunRunEntry(argv)
    if (!entry) return

    const context = {
      ...this.#runtimeContext,
      argv,
      cwd: message.cwd ?? this.#runtimeContext.cwd,
      env: message.env ?? this.#runtimeContext.env,
    }

    try {
      await runEntryScript(context, entry, { cwd: context.cwd })
    } catch (error) {
      this.#writeStderr(message.id, this.#pid, `${error instanceof Error ? error.message : String(error)}\n`)
      await this.#terminate(1)
      return
    }

    await this.#terminate(0)
  }

  #writeStderr(processId: string, pid: number, chunk: string): void {
    try {
      this.#kernel.writeStdio(pid, 2, chunk)
    } catch {
      this.#scope.postMessage({ type: "process.worker.stderr", id: processId, chunk })
    }
  }

  async #terminate(code: number, postExit = true): Promise<void> {
    if (this.#exited) return

    this.#exited = true
    const processId = this.#processId
    const pid = this.#pid

    this.#stdioSubscription?.dispose()
    this.#stdioSubscription = null
    this.#contextInstallation?.dispose()
    this.#contextInstallation = null
    this.#runtimeContext = null
    this.#processId = null
    this.#pid = null

    if (pid !== null) {
      try {
        await this.#kernel.kill(pid, code)
      } catch {
        // The process may already be gone if the worker was disposed mid-run.
      }
    }

    if (postExit && processId) {
      this.#scope.postMessage({ type: "process.worker.exit", id: processId, code })
    }
  }

  #createRuntimeContext(message: ProcessWorkerBootMessage, pid: number): RuntimeContext {
    return {
      vfs: this.#vfs,
      kernel: this.#kernel,
      pid,
      cwd: message.cwd,
      argv: message.argv,
      env: message.env,
      scope: this.#scope as typeof globalThis,
    }
  }
}

function parseBunRunEntry(argv: string[]): string | null {
  if (argv[0] !== "bun") return null
  if (argv[1] === "run" && argv[2]) return argv[2]
  if (argv[1] && argv[1] !== "run") return argv[1]

  return null
}