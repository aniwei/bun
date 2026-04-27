import { createMarsKernel } from "@mars/kernel"
import { createMarsInstaller, createMemoryPackageCache } from "@mars/installer"
import { createMarsShell } from "@mars/shell"
import { createDeleteFilePatch, createMarsVFS, createWriteFilePatch, type FileTree } from "@mars/vfs"
import { createMarsBun, installBunGlobal, type MarsBun } from "@mars/runtime"
import { runEntryScript } from "@mars/runtime"
import { createServiceWorkerRouter, registerMarsServiceWorker, type MarsServiceWorkerClient, type MarsServiceWorkerContainer, type ServiceWorkerRouter } from "@mars/sw"
import { preview as createPreviewUrl } from "./preview"

import type { MarsKernel, ProcessHandle, SpawnOptions, VirtualServer } from "@mars/kernel"
import type { PackageCache, PackageRegistryClient } from "@mars/installer"
import type { CommandResult, MarsShell, ShellCommand } from "@mars/shell"
import type { MarsBunSpawnOptions } from "@mars/runtime"
import type { Disposable, MarsVFS, MarsVFSPatch, VFSWatchEvent } from "@mars/vfs"

export interface MarsBootOptions {
  root?: string
  initialFiles?: FileTree
  env?: Record<string, string>
  serviceWorkerUrl?: string | URL
  serviceWorkerScope?: string
  serviceWorkerContainer?: MarsServiceWorkerContainer
  unregisterServiceWorkerOnDispose?: boolean
  autoSyncServiceWorkerVFS?: boolean
  packageCache?: PackageCache
  packageRegistryClient?: PackageRegistryClient
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
  readonly serviceWorker: MarsServiceWorkerClient | null
  boot(): Promise<void>
  dispose(): Promise<void>
  run(entry: string, options?: RunOptions): Promise<ProcessHandle>
  spawn(command: string, args?: string[], options?: Omit<SpawnOptions, "argv">): Promise<ProcessHandle>
  install(files: FileTree): Promise<void>
  snapshot(path?: string): Promise<FileTree>
  restore(tree: FileTree, root?: string): Promise<void>
  flushServiceWorkerVFS(): Promise<void>
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
  #serviceWorker: MarsServiceWorkerClient | null = null
  readonly #serviceWorkerUrl: string | URL | undefined
  readonly #serviceWorkerScope: string | undefined
  readonly #serviceWorkerContainer: MarsServiceWorkerContainer | undefined
  readonly #unregisterServiceWorkerOnDispose: boolean
  readonly #autoSyncServiceWorkerVFS: boolean
  readonly #packageCache: PackageCache | undefined
  readonly #packageRegistryClient: PackageRegistryClient | undefined
  #serviceWorkerVFSWatcher: Disposable | null = null
  #serviceWorkerVFSTasks = new Set<Promise<unknown>>()
  #booted = false

  constructor(options: MarsBootOptions = {}) {
    this.#serviceWorkerUrl = options.serviceWorkerUrl
    this.#serviceWorkerScope = options.serviceWorkerScope
    this.#serviceWorkerContainer = options.serviceWorkerContainer
    this.#unregisterServiceWorkerOnDispose = options.unregisterServiceWorkerOnDispose ?? false
    this.#autoSyncServiceWorkerVFS = options.autoSyncServiceWorkerVFS ?? true
    this.#packageRegistryClient = options.packageRegistryClient
    this.#packageCache = options.packageCache ?? (options.packageRegistryClient ? createMemoryPackageCache() : undefined)
    this.vfs = createMarsVFS({
      cwd: options.root ?? "/workspace",
      initialFiles: options.initialFiles,
    })
    this.kernel = createMarsKernel()
    this.shell = createMarsShell({ vfs: this.vfs, kernel: this.kernel, env: options.env })
    this.shell.registerCommand(this.#createBunCommand())
    this.bun = createMarsBun({
      vfs: this.vfs,
      kernel: this.kernel,
      env: options.env,
      spawn: spawnOptions => this.#spawnBunCommand(spawnOptions),
    })
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

  get serviceWorker(): MarsServiceWorkerClient | null {
    return this.#serviceWorker
  }

  async boot(): Promise<void> {
    if (this.#booted) return

    if (this.#serviceWorkerUrl && !this.#serviceWorker) {
      this.#serviceWorker = await registerMarsServiceWorker({
        scriptURL: this.#serviceWorkerUrl,
        scope: this.#serviceWorkerScope,
        type: "module",
        container: this.#serviceWorkerContainer,
      })
    }

    this.#installServiceWorkerVFSFanout()

    await this.kernel.boot()
    installBunGlobal({
      vfs: this.vfs,
      kernel: this.kernel,
      spawn: spawnOptions => this.#spawnBunCommand(spawnOptions),
    })
    this.#booted = true
  }

  async dispose(): Promise<void> {
    if (this.#serviceWorker) {
      await this.flushServiceWorkerVFS()
      this.#serviceWorkerVFSWatcher?.dispose()
      this.#serviceWorkerVFSWatcher = null
      if (this.#unregisterServiceWorkerOnDispose) await this.#serviceWorker.unregister()
      this.#serviceWorker.close()
      this.#serviceWorker = null
    }

    await this.kernel.shutdown()
    this.#booted = false
  }

  async run(entry: string, options: RunOptions = {}): Promise<ProcessHandle> {
    return this.#runScript(entry, options, [entry])
  }

  async #runScript(entry: string, options: RunOptions, argv: string[]): Promise<ProcessHandle> {
    const cwd = options.cwd ?? this.vfs.cwd()
    const processHandle = await this.kernel.spawn({
      argv,
      cwd,
      env: options.env,
      kind: "script",
    })

    try {
      await runEntryScript({
        vfs: this.vfs,
        kernel: this.kernel,
        env: options.env,
        pid: processHandle.pid,
      }, entry, { cwd })

      await this.kernel.kill(processHandle.pid, 0)
      return processHandle
    } catch (error) {
      await this.kernel.kill(processHandle.pid, 1)
      throw error
    }
  }

  #createBunCommand(): ShellCommand {
    return {
      name: "bun",
      description: "Run a Bun-compatible script from MarsVFS.",
      usage: "bun run <entry>",
      run: async context => {
        if (isBunInstallCommand(context.argv)) {
          return await this.#runBunInstall(context.cwd)
        }

        const entry = parseBunRunEntry(context.argv)
        if (!entry) {
          return {
            code: 1,
            stdout: "",
            stderr: "usage: bun run <entry>\n",
          }
        }

        try {
          const processHandle = await this.#runScript(
            entry,
            { cwd: context.cwd, env: context.env },
            context.argv,
          )
          const [stdout, stderr, code] = await Promise.all([
            new Response(processHandle.stdout).text(),
            new Response(processHandle.stderr).text(),
            processHandle.exited,
          ])

          return { code, stdout, stderr } satisfies CommandResult
        } catch (error) {
          return {
            code: 1,
            stdout: "",
            stderr: `${error instanceof Error ? error.message : String(error)}\n`,
          }
        }
      },
    }
  }

  async #runBunInstall(cwd: string): Promise<CommandResult> {
    if (!this.#packageCache) {
      return {
        code: 1,
        stdout: "",
        stderr: "bun install requires a Mars package cache in the browser runtime\n",
      }
    }

    const packageJsonPath = `${cwd.replace(/\/+$/, "")}/package.json`
    if (!this.vfs.existsSync(packageJsonPath)) {
      return {
        code: 1,
        stdout: "",
        stderr: `package.json not found: ${packageJsonPath}\n`,
      }
    }

    try {
      const packageJson = JSON.parse(String(this.vfs.readFileSync(packageJsonPath, "utf8"))) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      const installer = createMarsInstaller({
        vfs: this.vfs,
        cache: this.#packageCache,
        ...(this.#packageRegistryClient ? { registryClient: this.#packageRegistryClient } : {}),
      })
      const result = await installer.install({
        cwd,
        offline: !this.#packageRegistryClient,
        ...(packageJson.dependencies ? { dependencies: packageJson.dependencies } : {}),
        ...(packageJson.devDependencies ? { devDependencies: packageJson.devDependencies } : {}),
      })

      return {
        code: 0,
        stdout: result.packages.length
          ? `installed ${result.packages.map(pkg => `${pkg.name}@${pkg.version}`).join(", ")}\n`
          : "installed 0 packages\n",
        stderr: "",
        json: result,
      }
    } catch (error) {
      return {
        code: 1,
        stdout: "",
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      }
    }
  }

  async spawn(
    command: string,
    args: string[] = [],
    options: Omit<SpawnOptions, "argv"> = {},
  ): Promise<ProcessHandle> {
    const entry = parseBunRunEntry([command, ...args])
    if (entry) {
      return this.#runScript(
        entry,
        { cwd: options.cwd, env: options.env },
        [command, ...args],
      )
    }

    return this.kernel.spawn({ ...options, argv: [command, ...args] })
  }

  #spawnBunCommand(options: MarsBunSpawnOptions): Promise<ProcessHandle> {
    const [command = "", ...args] = options.cmd
    return this.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin,
      stdout: options.stdout,
      stderr: options.stderr,
      kind: "worker",
    })
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

  async flushServiceWorkerVFS(): Promise<void> {
    while (this.#serviceWorkerVFSTasks.size) {
      await Promise.all([...this.#serviceWorkerVFSTasks])
    }
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

  #installServiceWorkerVFSFanout(): void {
    if (!this.#autoSyncServiceWorkerVFS || !this.#serviceWorker || this.#serviceWorkerVFSWatcher) return

    this.#serviceWorkerVFSWatcher = this.vfs.watch(this.vfs.cwd(), (event, path) => {
      const patch = this.#createServiceWorkerVFSPatch(event, path)
      if (!patch) return

      this.#queueServiceWorkerVFSPatch(patch)
    })
  }

  #createServiceWorkerVFSPatch(event: VFSWatchEvent, path: string): MarsVFSPatch | null {
    if (event === "delete") return createDeleteFilePatch(path)
    if (!this.vfs.existsSync(path)) return null

    try {
      const stats = this.vfs.statSync(path)
      if (!stats.isFile()) return null
      const data = this.vfs.readFileSync(path)

      return createWriteFilePatch(path, typeof data === "string" ? data : data)
    } catch {
      return null
    }
  }

  #queueServiceWorkerVFSPatch(patch: MarsVFSPatch): void {
    const serviceWorker = this.#serviceWorker
    if (!serviceWorker) return

    const task = serviceWorker.endpoint.request(
      "sw.vfs.patch",
      { patches: [patch] },
      { target: "sw" },
    ).catch(() => {})

    this.#serviceWorkerVFSTasks.add(task)
    void task.finally(() => {
      this.#serviceWorkerVFSTasks.delete(task)
    })
  }
}

export async function createMarsRuntime(options?: MarsBootOptions): Promise<MarsRuntime> {
  const runtime = new DefaultMarsRuntime(options)
  await runtime.boot()

  return runtime
}

function parseBunRunEntry(argv: string[]): string | null {
  if (argv[0] !== "bun") return null
  if (argv[1] === "run" && argv[2]) return argv[2]
  if (argv[1] && argv[1] !== "run") return argv[1]

  return null
}

function isBunInstallCommand(argv: string[]): boolean {
  return argv[0] === "bun" && argv[1] === "install"
}