import { createMarsStdioBridge } from "./stdio"

import { createDeleteFilePatch, createWriteFilePatch } from "@mars/vfs"

import type { Disposable, MarsVFS, MarsVFSPatch, VFSWatchEvent } from "@mars/vfs"
import type { MarsStdioBridge } from "./stdio"

export type MarsProcessWorkerStatus = "created" | "running" | "stopped"

export interface ProcessWorkerFactoryOptions {
  scope?: typeof globalThis
  workerURL?: string | URL
  workerOptions?: WorkerOptions
  workerConstructor?: WorkerConstructor
  vfs?: MarsVFS
  syncRoot?: string
  autoSyncVFS?: boolean
}

export interface ProcessWorkerCreateOptions {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  onMessage?(message: unknown): unknown | Promise<unknown>
}

export interface MarsProcessWorkerController {
  readonly id: string
  readonly argv: string[]
  readonly stdin: ReadableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly messages: ReadableStream<unknown>
  status(): MarsProcessWorkerStatus
  boot(): Promise<void>
  write(input: string | Uint8Array): Promise<void>
  syncVFS(patches: MarsVFSPatch[]): Promise<void>
  run(options?: { argv?: string[]; cwd?: string; env?: Record<string, string> }): Promise<void>
  postMessage(message: unknown): Promise<void>
  terminate(): Promise<void>
}

export interface ProcessWorkerOutputMessage {
  type: "process.worker.stdout" | "process.worker.stderr"
  id: string
  chunk: string | Uint8Array
}

export interface ProcessWorkerExitMessage {
  type: "process.worker.exit"
  id: string
  code: number
}

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void
  terminate(): void
}

export type WorkerConstructor = new (url: string | URL, options?: WorkerOptions) => WorkerLike

interface WorkerConstructorScope {
  Worker?: WorkerConstructor
}

export class MarsProcessWorkerFactory {
  readonly #scope: typeof globalThis
  readonly #workerURL: string | URL | undefined
  readonly #workerOptions: WorkerOptions | undefined
  readonly #workerConstructor: WorkerConstructor | undefined
  readonly #vfs: MarsVFS | undefined
  readonly #syncRoot: string | undefined
  readonly #autoSyncVFS: boolean
  #nextWorkerId = 1

  constructor(options: ProcessWorkerFactoryOptions = {}) {
    this.#scope = options.scope ?? globalThis
    this.#workerURL = options.workerURL
    this.#workerOptions = options.workerOptions
    this.#workerConstructor = options.workerConstructor
    this.#vfs = options.vfs
    this.#syncRoot = options.syncRoot
    this.#autoSyncVFS = options.autoSyncVFS ?? true
  }

  supportsNativeWorker(): boolean {
    const workerConstructor = this.#workerConstructor ?? (this.#scope as WorkerConstructorScope).Worker
    return typeof workerConstructor === "function" && Boolean(this.#workerURL)
  }

  async create(options: ProcessWorkerCreateOptions): Promise<MarsProcessWorkerController> {
    const id = `process-worker-${this.#nextWorkerId}`
    this.#nextWorkerId += 1
    let controller: MarsProcessWorkerController

    if (this.supportsNativeWorker()) {
      const workerConstructor = this.#workerConstructor ?? (this.#scope as WorkerConstructorScope).Worker
      if (workerConstructor && this.#workerURL) {
        controller = new BrowserProcessWorkerController(
          id,
          options,
          new workerConstructor(this.#workerURL, this.#workerOptions),
        )
        return this.#wrapAutoSync(controller)
      }
    }

    controller = new InMemoryProcessWorkerController(id, options)
    return this.#wrapAutoSync(controller)
  }

  #wrapAutoSync(controller: MarsProcessWorkerController): MarsProcessWorkerController {
    if (!this.#autoSyncVFS || !this.#vfs) return controller

    return new AutoSyncProcessWorkerController(
      controller,
      this.#vfs,
      this.#syncRoot ?? this.#vfs.cwd(),
    )
  }
}

export function createMarsProcessWorkerFactory(
  options?: ProcessWorkerFactoryOptions,
): MarsProcessWorkerFactory {
  return new MarsProcessWorkerFactory(options)
}

class AutoSyncProcessWorkerController implements MarsProcessWorkerController {
  readonly id: string
  readonly argv: string[]
  readonly stdin: ReadableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly messages: ReadableStream<unknown>
  readonly #controller: MarsProcessWorkerController
  readonly #vfs: MarsVFS
  readonly #watcher: Disposable
  readonly #tasks = new Set<Promise<unknown>>()
  #terminated = false

  constructor(controller: MarsProcessWorkerController, vfs: MarsVFS, syncRoot: string) {
    this.#controller = controller
    this.#vfs = vfs
    this.id = controller.id
    this.argv = controller.argv
    this.stdin = controller.stdin
    this.stdout = controller.stdout
    this.stderr = controller.stderr
    this.messages = controller.messages
    this.#watcher = vfs.watch(syncRoot, (event, path) => {
      const patch = this.#createPatch(event, path)
      if (!patch) return

      this.#queuePatch(patch)
    })
  }

  status(): MarsProcessWorkerStatus {
    return this.#controller.status()
  }

  boot(): Promise<void> {
    return this.#controller.boot()
  }

  write(input: string | Uint8Array): Promise<void> {
    return this.#controller.write(input)
  }

  syncVFS(patches: MarsVFSPatch[]): Promise<void> {
    return this.#controller.syncVFS(patches)
  }

  run(options?: { argv?: string[]; cwd?: string; env?: Record<string, string> }): Promise<void> {
    return this.#controller.run(options)
  }

  postMessage(message: unknown): Promise<void> {
    return this.#controller.postMessage(message)
  }

  async terminate(): Promise<void> {
    if (this.#terminated) return

    this.#terminated = true
    this.#watcher.dispose()
    await this.#flushVFS()
    await this.#controller.terminate()
  }

  #createPatch(event: VFSWatchEvent, path: string): MarsVFSPatch | null {
    if (event === "delete") return createDeleteFilePatch(path)
    if (!this.#vfs.existsSync(path)) return null

    try {
      const stats = this.#vfs.statSync(path)
      if (!stats.isFile()) return null
      const data = this.#vfs.readFileSync(path)

      return createWriteFilePatch(path, typeof data === "string" ? data : data)
    } catch {
      return null
    }
  }

  #queuePatch(patch: MarsVFSPatch): void {
    if (this.#terminated) return

    const task = this.#controller.syncVFS([patch]).catch(() => {})
    this.#tasks.add(task)
    void task.finally(() => {
      this.#tasks.delete(task)
    })
  }

  async #flushVFS(): Promise<void> {
    while (this.#tasks.size) {
      await Promise.all([...this.#tasks])
    }
  }
}

class InMemoryProcessWorkerController implements MarsProcessWorkerController {
  readonly id: string
  readonly argv: string[]
  readonly stdin: ReadableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly messages: ReadableStream<unknown>
  readonly #onMessage: ProcessWorkerCreateOptions["onMessage"]
  readonly #stdio: MarsStdioBridge
  #controller: ReadableStreamDefaultController<unknown> | null = null
  #status: MarsProcessWorkerStatus = "created"

  constructor(id: string, options: ProcessWorkerCreateOptions) {
    this.id = id
    this.argv = options.argv
    this.#onMessage = options.onMessage
    this.#stdio = createMarsStdioBridge()
    this.stdin = this.#stdio.stdin
    this.stdout = this.#stdio.stdout
    this.stderr = this.#stdio.stderr
    this.messages = new ReadableStream<unknown>({
      start: controller => {
        this.#controller = controller
      },
    })
  }

  status(): MarsProcessWorkerStatus {
    return this.#status
  }

  async boot(): Promise<void> {
    if (this.#status !== "created") return
    this.#status = "running"
    this.#controller?.enqueue({ type: "boot", id: this.id, argv: this.argv })
  }

  async write(input: string | Uint8Array): Promise<void> {
    await this.#stdio.writeStdin(input)
  }

  async syncVFS(patches: MarsVFSPatch[]): Promise<void> {
    this.#assertRunning()
    this.#controller?.enqueue({ type: "process.worker.vfs.patch", id: this.id, ok: true, count: patches.length })
  }

  async run(): Promise<void> {
    this.#assertRunning()
  }

  async postMessage(message: unknown): Promise<void> {
    this.#assertRunning()
    const response = this.#onMessage ? await this.#onMessage(message) : message
    this.#controller?.enqueue({ type: "message", id: this.id, data: response })
  }

  async terminate(): Promise<void> {
    if (this.#status === "stopped") return
    this.#status = "stopped"
    this.#stdio.closeStdin()
    this.#stdio.closeOutput()
    this.#controller?.close()
  }

  #assertRunning(): void {
    if (this.#status !== "running") throw new Error(`Process worker is not running: ${this.id}`)
  }
}

class BrowserProcessWorkerController implements MarsProcessWorkerController {
  readonly id: string
  readonly argv: string[]
  readonly stdin: ReadableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly messages: ReadableStream<unknown>
  readonly #worker: WorkerLike
  readonly #cwd: string | undefined
  readonly #env: Record<string, string> | undefined
  readonly #stdio: MarsStdioBridge
  readonly #handleMessage = (event: MessageEvent<unknown>) => {
    const message = event.data as Partial<ProcessWorkerOutputMessage | ProcessWorkerExitMessage> | undefined

    if (message?.type === "process.worker.stdout" && message.id === this.id) {
      void this.#stdio.writeStdout(message.chunk ?? "")
      return
    }
    if (message?.type === "process.worker.stderr" && message.id === this.id) {
      void this.#stdio.writeStderr(message.chunk ?? "")
      return
    }
    if (message?.type === "process.worker.exit" && message.id === this.id) {
      this.#status = "stopped"
      this.#stdio.closeStdin()
      this.#stdio.closeOutput()
      this.#controller?.enqueue(event.data)
      this.#closeMessages()
      return
    }

    this.#controller?.enqueue(event.data)
  }
  #controller: ReadableStreamDefaultController<unknown> | null = null
  #status: MarsProcessWorkerStatus = "created"
  #terminated = false
  #messagesClosed = false

  constructor(id: string, options: ProcessWorkerCreateOptions, worker: WorkerLike) {
    this.id = id
    this.argv = options.argv
    this.#cwd = options.cwd
    this.#env = options.env
    this.#worker = worker
    this.#stdio = createMarsStdioBridge()
    this.stdin = this.#stdio.stdin
    this.stdout = this.#stdio.stdout
    this.stderr = this.#stdio.stderr
    this.messages = new ReadableStream<unknown>({
      start: controller => {
        this.#controller = controller
        this.#worker.addEventListener("message", this.#handleMessage)
      },
      cancel: () => {
        this.#worker.removeEventListener("message", this.#handleMessage)
      },
    })
  }

  status(): MarsProcessWorkerStatus {
    return this.#status
  }

  async boot(): Promise<void> {
    if (this.#status !== "created") return
    this.#status = "running"
    this.#worker.postMessage({
      type: "process.worker.boot",
      id: this.id,
      argv: this.argv,
      cwd: this.#cwd,
      env: this.#env,
    })
  }

  async write(input: string | Uint8Array): Promise<void> {
    this.#assertRunning()
    await this.#stdio.writeStdin(input)
    this.#worker.postMessage({
      type: "process.worker.stdin",
      id: this.id,
      chunk: input,
    })
  }

  async syncVFS(patches: MarsVFSPatch[]): Promise<void> {
    this.#assertRunning()
    this.#worker.postMessage({
      type: "process.worker.vfs.patch",
      id: this.id,
      patches,
    })
  }

  async run(options: { argv?: string[]; cwd?: string; env?: Record<string, string> } = {}): Promise<void> {
    this.#assertRunning()
    this.#worker.postMessage({
      type: "process.worker.run",
      id: this.id,
      argv: options.argv,
      cwd: options.cwd,
      env: options.env,
    })
  }

  async postMessage(message: unknown): Promise<void> {
    this.#assertRunning()
    this.#worker.postMessage({
      type: "process.worker.message",
      id: this.id,
      data: message,
    })
  }

  async terminate(): Promise<void> {
    if (this.#terminated) return

    this.#status = "stopped"
    this.#worker.postMessage({ type: "process.worker.terminate", id: this.id })
    this.#worker.removeEventListener("message", this.#handleMessage)
    this.#worker.terminate()
    this.#terminated = true
    this.#closeMessages()
  }

  #assertRunning(): void {
    if (this.#status !== "running") throw new Error(`Process worker is not running: ${this.id}`)
  }

  #closeMessages(): void {
    if (this.#messagesClosed) return

    this.#messagesClosed = true
    this.#controller?.close()
  }
}
