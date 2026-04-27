import { createMarsKernel } from "@mars/kernel"
import { createMarsShell } from "@mars/shell"
import { createMarsVFS, type FileTree } from "@mars/vfs"
import { createMarsBun, installBunGlobal, type MarsBun } from "@mars/runtime"
import { runEntryScript } from "@mars/runtime"
import { createServiceWorkerRouter, type ServiceWorkerRouter } from "@mars/sw"
import { preview as createPreviewUrl } from "./preview"

import type { MarsKernel, ProcessHandle, SpawnOptions, VirtualServer } from "@mars/kernel"
import type { MarsShell } from "@mars/shell"
import type { MarsVFS } from "@mars/vfs"

export interface MarsBootOptions {
  root?: string
  initialFiles?: FileTree
  env?: Record<string, string>
}

export interface RunOptions {
  cwd?: string
  env?: Record<string, string>
}

export interface MarsRuntime {
  readonly vfs: MarsVFS
  readonly shell: MarsShell
  readonly kernel: MarsKernel
  readonly bun: MarsBun
  readonly router: ServiceWorkerRouter
  boot(): Promise<void>
  dispose(): Promise<void>
  run(entry: string, options?: RunOptions): Promise<ProcessHandle>
  spawn(command: string, args?: string[], options?: Omit<SpawnOptions, "argv">): Promise<ProcessHandle>
  install(files: FileTree): Promise<void>
  snapshot(path?: string): Promise<FileTree>
  restore(tree: FileTree, root?: string): Promise<void>
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  preview(port: number): string
  registerServer(server: VirtualServer): Promise<void>
}

class DefaultMarsRuntime implements MarsRuntime {
  readonly vfs: MarsVFS
  readonly shell: MarsShell
  readonly kernel: MarsKernel
  readonly bun: MarsBun
  readonly router: ServiceWorkerRouter
  #booted = false

  constructor(options: MarsBootOptions = {}) {
    this.vfs = createMarsVFS({
      cwd: options.root ?? "/workspace",
      initialFiles: options.initialFiles,
    })
    this.kernel = createMarsKernel()
    this.shell = createMarsShell({ vfs: this.vfs, kernel: this.kernel, env: options.env })
    this.bun = createMarsBun({ vfs: this.vfs, kernel: this.kernel, env: options.env })
    this.router = createServiceWorkerRouter({
      kernelClient: {
        resolvePort: async port => this.kernel.resolvePort(port),
        dispatchToKernel: async (_pid, request) => {
          const port = Number(new URL(request.url).port || 80)
          return this.kernel.dispatchToPort(port, request)
        },
      },
      vfsClient: {
        readFile: async path => {
          if (!this.vfs.existsSync(path)) return null
          const data = await this.vfs.readFile(path)
          return typeof data === "string" ? new TextEncoder().encode(data) : data
        },
        stat: async path => this.vfs.existsSync(path) ? this.vfs.stat(path) : null,
        contentType: path => path.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
      },
      moduleClient: {
        vfs: this.vfs,
      },
    })
  }

  async boot(): Promise<void> {
    if (this.#booted) return

    await this.kernel.boot()
    installBunGlobal({ vfs: this.vfs, kernel: this.kernel })
    this.#booted = true
  }

  async dispose(): Promise<void> {
    await this.kernel.shutdown()
    this.#booted = false
  }

  async run(entry: string, options: RunOptions = {}): Promise<ProcessHandle> {
    const processHandle = await this.kernel.spawn({
      argv: [entry],
      cwd: options.cwd ?? this.vfs.cwd(),
      env: options.env,
      kind: "script",
    })

    try {
      await runEntryScript(
        {
          vfs: this.vfs,
          kernel: this.kernel,
          env: options.env,
          pid: processHandle.pid,
        },
        entry,
        {
          cwd: options.cwd,
        },
      )

      await this.kernel.kill(processHandle.pid, 0)
      return processHandle
    } catch (error) {
      await this.kernel.kill(processHandle.pid, 1)
      throw error
    }
  }

  async spawn(
    command: string,
    args: string[] = [],
    options: Omit<SpawnOptions, "argv"> = {},
  ): Promise<ProcessHandle> {
    return this.kernel.spawn({ ...options, argv: [command, ...args] })
  }

  async install(files: FileTree): Promise<void> {
    await this.vfs.restore(files, this.vfs.cwd())
  }

  async snapshot(path?: string): Promise<FileTree> {
    return this.vfs.snapshot(path)
  }

  async restore(tree: FileTree, root?: string): Promise<void> {
    await this.vfs.restore(tree, root)
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.router.fetch(new Request(input, init))
  }

  preview(port: number): string {
    return createPreviewUrl(port)
  }

  async registerServer(server: VirtualServer): Promise<void> {
    this.kernel.registerPort(1, server.port, server)
  }
}

export async function createMarsRuntime(options?: MarsBootOptions): Promise<MarsRuntime> {
  const runtime = new DefaultMarsRuntime(options)
  await runtime.boot()

  return runtime
}