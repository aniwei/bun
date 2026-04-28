import { createMarsKernel } from "@mars/kernel"
import { createMarsInstaller, createMemoryPackageCache } from "@mars/installer"
import { createMarsShell } from "@mars/shell"
import { createDeleteFilePatch, createMarsVFS, createWriteFilePatch, normalizePath, type FileTree } from "@mars/vfs"
import {
  createMarsBun,
  installBunGlobal,
  runEntryScript,
  type MarsBun,
  type RuntimeFeatures,
} from "@mars/runtime"
import {
  createServiceWorkerRouter,
  registerMarsServiceWorker,
  type MarsServiceWorkerClient,
  type MarsServiceWorkerContainer,
  type ServiceWorkerRouter,
} from "@mars/sw"
import { HookRegistry, type HookPreset } from "./hooks"
import { preview as createPreviewUrl } from "./preview"
import { registerRuntimeFeatureHooks, resolveRuntimeFeatures } from "./runtime-features"

import type { MarsKernel, ProcessHandle, SpawnOptions, VirtualServer } from "@mars/kernel"
import type { PackageCache, PackageLifecycleScripts, PackageRegistryClient, ResolvedPackage, WorkspacePackage } from "@mars/installer"
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
  runtimeFeatures?: Partial<RuntimeFeatures>
  hooks?: HookRegistry
  hookPreset?: HookPreset
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
  readonly runtimeFeatures: RuntimeFeatures
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
  readonly runtimeFeatures: RuntimeFeatures
  readonly #hooks: HookRegistry
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
    this.runtimeFeatures = resolveRuntimeFeatures(options.runtimeFeatures)
    this.#hooks = options.hooks ?? new HookRegistry({ preset: options.hookPreset ?? "default" })
    
    this.vfs = createMarsVFS({
      cwd: options.root ?? "/workspace",
      initialFiles: options.initialFiles,
    })
    this.kernel = createMarsKernel()
    this.shell = createMarsShell({ vfs: this.vfs, kernel: this.kernel, env: options.env })
    this.shell.registerCommand(this.#createBunCommand())
    
    registerRuntimeFeatureHooks(this.#hooks, this.runtimeFeatures)
    
    this.bun = createMarsBun({
      vfs: this.vfs,
      kernel: this.kernel,
      env: options.env,
      runtimeFeatures: this.runtimeFeatures,
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

    await this.#hooks.emit("runtime.boot.start", {})

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
    
    await this.#hooks.emit("features.load.start", {})
    
    const globalInstallContext = {
      vfs: this.vfs,
      kernel: this.kernel,
      runtimeFeatures: this.runtimeFeatures,
      spawn: (spawnOptions: MarsBunSpawnOptions) => this.#spawnBunCommand(spawnOptions),
    }
    
    await this.#hooks.execute("globals.install", globalInstallContext, globalInstallContext)
    
    installBunGlobal(globalInstallContext)
    
    await this.#hooks.emit("globals.installed", {})
    await this.#hooks.emit("features.load.end", {})
    await this.#hooks.emit("runtime.boot.end", {})
    this.#booted = true
  }

  async dispose(): Promise<void> {
    await this.#hooks.emit("runtime.dispose.start", {})
    
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
    
    await this.#hooks.emit("runtime.dispose.end", {})
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
        cwd,
        argv,
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
        optionalDependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
        workspaces?: string[] | { packages?: string[] }
        scripts?: PackageLifecycleScripts
        name?: string
      }
      const workspaces = await this.#collectWorkspacePackages(cwd, packageJson.workspaces)
      const installer = createMarsInstaller({
        vfs: this.vfs,
        cache: this.#packageCache,
        ...(this.#packageRegistryClient ? { registryClient: this.#packageRegistryClient } : {}),
      })
      const result = await installer.install({
        cwd,
        ...(packageJson.name ? { rootName: packageJson.name } : {}),
        offline: !this.#packageRegistryClient,
        ...(packageJson.dependencies ? { dependencies: packageJson.dependencies } : {}),
        ...(packageJson.devDependencies ? { devDependencies: packageJson.devDependencies } : {}),
        ...(packageJson.optionalDependencies ? { optionalDependencies: packageJson.optionalDependencies } : {}),
        ...(packageJson.peerDependencies ? { peerDependencies: packageJson.peerDependencies } : {}),
        ...(workspaces.length ? { workspaces } : {}),
      })
      const lifecycleResult = await this.#runInstallLifecycleScripts(cwd, result.packages, packageJson.scripts ?? {}, packageJson.name ?? "root")
      if (lifecycleResult.code !== 0) return lifecycleResult

      return {
        code: 0,
        stdout: result.packages.length
          ? `installed ${result.packages.map(pkg => `${pkg.name}@${pkg.version}`).join(", ")}\n${lifecycleResult.stdout}`
          : `installed 0 packages\n${lifecycleResult.stdout}`,
        stderr: lifecycleResult.stderr,
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

  async #runInstallLifecycleScripts(
    cwd: string,
    packages: ResolvedPackage[],
    rootScripts: PackageLifecycleScripts,
    rootPackageName: string,
  ): Promise<CommandResult> {
    let stdout = ""
    let stderr = ""
    const nodeModulesPath = normalizePath("node_modules", cwd)

    for (const pkg of packages) {
      const result = await this.#runPackageLifecycleScripts(
        `${pkg.name}@${pkg.version}`,
        normalizePath(pkg.name, nodeModulesPath),
        pkg.scripts,
        cwd,
        pkg.name,
      )
      stdout += result.stdout
      stderr += result.stderr
      if (result.code !== 0) return { code: result.code, stdout, stderr, ...(result.json === undefined ? {} : { json: result.json }) }
    }

    const rootResult = await this.#runPackageLifecycleScripts("root", cwd, rootScripts, cwd, rootPackageName)
    stdout += rootResult.stdout
    stderr += rootResult.stderr
    if (rootResult.code !== 0) return { code: rootResult.code, stdout, stderr, ...(rootResult.json === undefined ? {} : { json: rootResult.json }) }

    return { code: 0, stdout, stderr }
  }

  async #runPackageLifecycleScripts(
    label: string,
    cwd: string,
    scripts: PackageLifecycleScripts,
    installCwd: string,
    packageName: string,
  ): Promise<CommandResult> {
    let stdout = ""
    let stderr = ""

    for (const name of ["preinstall", "install", "postinstall"] as const) {
      const script = scripts[name]
      if (!script) continue

      const result = await this.shell.run(script, {
        cwd,
        env: this.#createLifecycleEnv(installCwd, cwd, packageName, name, script),
      })
      stdout += result.stdout
      stderr += result.stderr
      if (result.code !== 0) {
        return {
          code: result.code,
          stdout,
          stderr: `${stderr}${label} ${name} failed with exit code ${result.code}\n`,
          ...(result.json === undefined ? {} : { json: result.json }),
        }
      }
    }

    return { code: 0, stdout, stderr }
  }

  #createLifecycleEnv(
    installCwd: string,
    packageCwd: string,
    packageName: string,
    event: keyof PackageLifecycleScripts,
    script: string,
  ): Record<string, string> {
    const installBinPath = normalizePath(".bin", normalizePath("node_modules", installCwd))
    const packageBinPath = normalizePath(".bin", normalizePath("node_modules", packageCwd))
    const packageJsonPath = normalizePath("package.json", packageCwd)
    const packageEnv = this.#readLifecyclePackageEnv(packageJsonPath)
    const pathEntries = packageCwd === installCwd
      ? [installBinPath]
      : [packageBinPath, installBinPath]

    return {
      ...packageEnv,
      PATH: pathEntries.join(":"),
      INIT_CWD: installCwd,
      npm_config_global: "false",
      npm_config_local_prefix: installCwd,
      npm_config_prefix: installCwd,
      npm_config_user_agent: "bun/mars",
      npm_command: "install",
      npm_execpath: "bun",
      npm_node_execpath: "bun",
      npm_lifecycle_event: event,
      npm_lifecycle_script: script,
      npm_package_json: packageJsonPath,
      npm_package_name: packageEnv.npm_package_name ?? packageName,
    }
  }

  #readLifecyclePackageEnv(packageJsonPath: string): Record<string, string> {
    try {
      return flattenPackageJsonEnv(JSON.parse(String(this.vfs.readFileSync(packageJsonPath, "utf8"))))
    } catch {
      return {}
    }
  }

  async #collectWorkspacePackages(
    cwd: string,
    workspaces: string[] | { packages?: string[] } | undefined,
  ): Promise<WorkspacePackage[]> {
    const workspacePatterns = Array.isArray(workspaces) ? workspaces : workspaces?.packages ?? []
    const workspacePackages: WorkspacePackage[] = []
    const seenPackagePaths = new Set<string>()

    for (const pattern of workspacePatterns) {
      if (pattern.startsWith("!")) continue

      for (const workspacePath of this.#resolveWorkspacePattern(cwd, pattern)) {
        if (seenPackagePaths.has(workspacePath)) continue
        seenPackagePaths.add(workspacePath)

        const workspacePackage = await this.#readWorkspacePackage(workspacePath)
        if (workspacePackage) workspacePackages.push(workspacePackage)
      }
    }

    return workspacePackages.sort((left, right) => left.name.localeCompare(right.name))
  }

  #resolveWorkspacePattern(cwd: string, pattern: string): string[] {
    const normalizedPattern = pattern.replace(/\/+$/g, "").replace(/^\.\//, "")
    if (!normalizedPattern) return []

    if (!normalizedPattern.endsWith("/*")) {
      const workspacePath = normalizePath(normalizedPattern, cwd)
      return this.#hasWorkspacePackage(workspacePath) ? [workspacePath] : []
    }

    const workspaceRoot = normalizePath(normalizedPattern.slice(0, -2), cwd)
    if (!this.vfs.existsSync(workspaceRoot)) return []

    return (this.vfs.readdirSync(workspaceRoot) as string[])
      .map(entry => normalizePath(entry, workspaceRoot))
      .filter(workspacePath => this.#hasWorkspacePackage(workspacePath))
  }

  #hasWorkspacePackage(path: string): boolean {
    if (!this.vfs.existsSync(path)) return false

    try {
      return this.vfs.statSync(path).isDirectory() && this.vfs.existsSync(normalizePath("package.json", path))
    } catch {
      return false
    }
  }

  async #readWorkspacePackage(path: string): Promise<WorkspacePackage | null> {
    const packageJson = JSON.parse(String(this.vfs.readFileSync(normalizePath("package.json", path), "utf8"))) as {
      name?: string
      version?: string
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: WorkspacePackage["peerDependenciesMeta"]
      scripts?: PackageLifecycleScripts
      bin?: WorkspacePackage["bin"]
    }
    if (!packageJson.name || !packageJson.version) return null

    return {
      name: packageJson.name,
      version: packageJson.version,
      path,
      dependencies: packageJson.dependencies ?? {},
      optionalDependencies: packageJson.optionalDependencies ?? {},
      peerDependencies: packageJson.peerDependencies ?? {},
      peerDependenciesMeta: packageJson.peerDependenciesMeta ?? {},
      scripts: packageJson.scripts ?? {},
      bin: packageJson.bin ?? {},
      files: await this.vfs.snapshot(path),
    }
  }

  async spawn(
    command: string,
    args: string[] = [],
    options: Omit<SpawnOptions, "argv"> = {},
  ): Promise<ProcessHandle> {
    const argv = [command, ...args]
    const entry = parseBunRunEntry(argv)
    if (entry) {
      return this.#runScript(
        entry,
        { cwd: options.cwd, env: options.env },
        argv,
      )
    }

    return this.#runShellCommand(argv, options)
  }

  async #runShellCommand(argv: string[], options: Omit<SpawnOptions, "argv">): Promise<ProcessHandle> {
    const cwd = options.cwd ?? this.vfs.cwd()
    const processHandle = await this.kernel.spawn({
      ...options,
      argv,
      cwd,
      kind: options.kind ?? "shell",
    })

    try {
      const commandLine = argv.map(escapeShellArg).join(" ")
      const result = await this.shell.run(commandLine, {
        cwd,
        env: options.env,
      })

      if (result.stdout) this.kernel.writeStdio(processHandle.pid, 1, result.stdout)
      if (result.stderr) this.kernel.writeStdio(processHandle.pid, 2, result.stderr)
      await this.kernel.kill(processHandle.pid, result.code)
    } catch (error) {
      const message = `${error instanceof Error ? error.message : String(error)}\n`
      this.kernel.writeStdio(processHandle.pid, 2, message)
      await this.kernel.kill(processHandle.pid, 1)
    }

    return processHandle
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
      await Promise.all(this.#serviceWorkerVFSTasks)
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

function flattenPackageJsonEnv(packageJson: unknown): Record<string, string> {
  const env: Record<string, string> = {}
  if (!isRecord(packageJson)) return env

  flattenPackageJsonValue(env, [], packageJson)
  return env
}

function flattenPackageJsonValue(
  env: Record<string, string>,
  keyPath: string[],
  value: unknown,
): void {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (keyPath.length) env[`npm_package_${keyPath.map(normalizePackageEnvKey).join("_")}`] = String(value)
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenPackageJsonValue(env, [...keyPath, String(index)], item))
    return
  }

  if (!isRecord(value)) return

  for (const [key, item] of Object.entries(value)) {
    flattenPackageJsonValue(env, [...keyPath, key], item)
  }
}

function normalizePackageEnvKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_]/g, "_")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
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

function escapeShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}