import { Subscription, type Events } from '@mars/web-shared'
import { ProcessTable } from './process-table'
import { KernelStateError, ProcessNotFoundError } from './errors'
import { SyscallBridge } from './syscall-bridge'
import type {
  Pid,
  KernelConfig,
  KernelControlCommand,
  KernelControlResult,
  KernelShellContext,
  KernelShellCommandHook,
  KernelShellCommandRegistry,
  KernelProcessExecutionRequest,
  KernelProcessExecutionResult,
  KernelPortRegistration,
  ProcessDescriptor,
  SpawnOptions,
} from './kernel.types'
import type { VFS } from '@mars/web-vfs'
import { createBuiltinCommandRegistry } from '@mars/web-shell'

type KernelEvents = Events & {
  stdio: (payload: { pid: Pid; kind: 'stdout' | 'stderr'; data: string }) => void
  processExit: (payload: { pid: Pid; code: number }) => void
  portRegistered: (payload: { pid: Pid; port: number; host: string; protocol: 'http' | 'https' }) => void
}

function appendNewline(text: string): string {
  if (!text) return ''
  return text.endsWith('\n') ? text : `${text}\n`
}

function normalizeAbsolutePath(path: string): string {
  if (!path) return '/'
  return path.startsWith('/') ? path : `/${path}`
}

function resolvePath(cwd: string, path: string): string {
  if (path.startsWith('/')) return normalizeAbsolutePath(path)
  if (!cwd || cwd === '/') return normalizeAbsolutePath(path)
  return normalizeAbsolutePath(`${cwd}/${path}`)
}

function parsePackageSpecifier(specifier: string): { name: string; spec: string } | null {
  const trimmed = specifier.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('@')) {
    const secondAt = trimmed.lastIndexOf('@')
    if (secondAt > 0) {
      const maybeName = trimmed.slice(0, secondAt)
      const maybeSpec = trimmed.slice(secondAt + 1)
      if (maybeName.includes('/') && maybeSpec.length > 0) {
        return { name: maybeName, spec: maybeSpec }
      }
    }

    return { name: trimmed, spec: 'latest' }
  }

  const at = trimmed.indexOf('@')
  if (at > 0) {
    return {
      name: trimmed.slice(0, at),
      spec: trimmed.slice(at + 1) || 'latest',
    }
  }

  return { name: trimmed, spec: 'latest' }
}

type BunAddDependencyField = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'

type BunAddOptions = {
  installAfterAdd: boolean
  targetField: BunAddDependencyField
  packageSpecifiers: string[]
}

function parseBunAddOptions(args: string[]): BunAddOptions | { error: string } {
  let installAfterAdd = true
  let targetField: BunAddDependencyField = 'dependencies'
  const packageSpecifiers: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!

    if (token === '--no-install') {
      installAfterAdd = false
      continue
    }

    if (token === '--dev' || token === '-d') {
      targetField = 'devDependencies'
      continue
    }

    if (token === '--optional' || token === '-O') {
      targetField = 'optionalDependencies'
      continue
    }

    if (token === '--peer' || token === '-p') {
      targetField = 'peerDependencies'
      continue
    }

    if (token === '--cwd') {
      if (index + 1 >= args.length) {
        return { error: 'bun add --cwd requires a value\n' }
      }
      index += 1
      continue
    }

    if (token.startsWith('--cwd=')) {
      continue
    }

    if (token.startsWith('-')) {
      // Keep unknown flags non-fatal for now to stay permissive.
      continue
    }

    packageSpecifiers.push(token)
  }

  return {
    installAfterAdd,
    targetField,
    packageSpecifiers,
  }
}

type KernelExecutionContext = KernelShellContext & {
  __kernelRequest?: KernelProcessExecutionRequest
}

export class Kernel extends Subscription<KernelEvents> {
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
  private readonly mountedFiles = new Map<string, string | Uint8Array>()
  private readonly bridge: SyscallBridge
  // stdio channels: pid → { stdout, stderr } MessageChannel ports
  private readonly stdios = new Map<Pid, { stdout: MessageChannel; stderr: MessageChannel }>()
  // process message port detach callbacks: pid → detach
  private readonly processPortDetachers = new Map<Pid, () => void>()
  // exit waiters: pid → resolve fn array
  private readonly exitWaiters = new Map<Pid, Array<(code: number) => void>>()
  // exited process codes awaiting waitpid reap
  private readonly exitedCodes = new Map<Pid, number>()
  private readonly commandRegistry: KernelShellCommandRegistry
  private readonly processWorkerExecutor?: KernelConfig['processExecutor']
  private readonly processExecutor: (request: KernelProcessExecutionRequest) => Promise<KernelProcessExecutionResult>

  private constructor(
    readonly config: KernelConfig,
    readonly vfs?: VFS,
  ) {
    super()
    const sab = new SharedArrayBuffer(config.sabSize ?? 1024 * 1024)

    this.bridge = new SyscallBridge(sab)
    this.commandRegistry = createBuiltinCommandRegistry() as KernelShellCommandRegistry
    
    this.processWorkerExecutor = config.processExecutor

    this.registerKernelProcessWorkerCommands()
    for (const hook of config.shellHooks ?? []) {
      hook(this.commandRegistry)
    }

    this.processExecutor = async request => this.executeWithShellRegistry(request)
  }

  private registerKernelProcessWorkerCommands(): void {
    this.commandRegistry.register('bun', async (_args, context) => {
      const request = (context as KernelExecutionContext).__kernelRequest
      if (!request) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'kernel execution request is missing\n',
        }
      }

      const subcommand = _args[0]

      if (subcommand === 'install' || subcommand === 'i') {
        if (_args.length > 1) {
          return await this.executeBunAdd(request, _args.slice(1))
        }
        return await this.executeBunInstall(request)
      }

      if (subcommand === 'add') {
        return await this.executeBunAdd(request, _args.slice(1))
      }

      if (!this.processWorkerExecutor) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'bun command requires process worker executor\n',
        }
      }

      return await this.processWorkerExecutor(request)
    })
  }

  private readMountedText(path: string): string | null {
    const value = this.mountedFiles.get(path)
    if (typeof value === 'string') return value
    if (value instanceof Uint8Array) {
      return new TextDecoder().decode(value)
    }

    if (!this.vfs) return null

    try {
      return this.vfs.readFileSync(path).toString()
    } catch {
      return null
    }
  }

  private writeMounted(path: string, content: string): void {
    this.mountedFiles.set(path, content)
    this.vfs?.writeFileSync(path, content)
  }

  private getManifestPath(cwd: string | undefined): string {
    const fromCwd = resolvePath(cwd ?? '/', 'package.json')
    if (this.readMountedText(fromCwd) !== null) {
      return fromCwd
    }

    return '/package.json'
  }

  private async executeBunInstall(
    request: KernelProcessExecutionRequest,
  ): Promise<KernelProcessExecutionResult> {
    const cwd = request.cwd ?? '/'
    const manifestPath = this.getManifestPath(cwd)
    const rawManifest = this.readMountedText(manifestPath)

    if (rawManifest === null) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `bun install requires package.json at ${manifestPath}\n`,
      }
    }

    let manifest: {
      dependencies: Record<string, string>
      devDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      overrides?: Record<string, string>
    }
    try {
      const parsed = JSON.parse(rawManifest) as Record<string, unknown>
      const dependencies =
        parsed && typeof parsed.dependencies === 'object' && parsed.dependencies
          ? (parsed.dependencies as Record<string, string>)
          : {}
      const devDependencies =
        parsed && typeof parsed.devDependencies === 'object' && parsed.devDependencies
          ? (parsed.devDependencies as Record<string, string>)
          : undefined
      const optionalDependencies =
        parsed && typeof parsed.optionalDependencies === 'object' && parsed.optionalDependencies
          ? (parsed.optionalDependencies as Record<string, string>)
          : undefined
      const overrides =
        parsed && typeof parsed.overrides === 'object' && parsed.overrides
          ? (parsed.overrides as Record<string, string>)
          : undefined

      manifest = { dependencies, devDependencies, optionalDependencies, overrides }
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Invalid package.json: ${error instanceof Error ? error.message : String(error)}\n`,
      }
    }

    try {
      const hasDependencies = Object.keys(manifest.dependencies ?? {}).length > 0
      const hasDevDependencies = Object.keys(manifest.devDependencies ?? {}).length > 0
      const hasOptionalDependencies = Object.keys(manifest.optionalDependencies ?? {}).length > 0
      if (!hasDependencies && !hasDevDependencies && !hasOptionalDependencies) {
        const lockfilePath = resolvePath(cwd, 'bun.lock')
        this.writeMounted(lockfilePath, `${JSON.stringify({ lockfileVersion: 1, packages: {} }, null, 2)}\n`)
        return {
          exitCode: 0,
          stdout: 'Installed 0 packages\n',
          stderr: '',
        }
      }

      const installerCandidates = [
        '@mars/web-installer',
      ]

      let installer: {
        readLockfile(content: string | Uint8Array): unknown
        installFromManifest(manifest: {
          dependencies: Record<string, string>
          optionalDependencies?: Record<string, string>
          overrides?: Record<string, string>
        }, options: { lockfile?: unknown; fetchFn?: typeof fetch }): Promise<{
          lockfile: { packages: Record<string, { name: string; version: string; dependencies?: Record<string, string> }> }
          layoutPlan: { entries: Array<{ packageKey: string; installPath: string }> }
        }>
        writeLockfile(lockfile: unknown): string
      } | null = null

      for (const candidate of installerCandidates) {
        try {
          installer = await import(candidate)
          break
        } catch {
          // Try next candidate.
        }
      }

      if (!installer) {
        throw new Error('Unable to load installer module')
      }

      const lockfilePath = resolvePath(cwd, 'bun.lock')
      const existingLockfileContent = this.readMountedText(lockfilePath)
      const existingLockfile =
        existingLockfileContent && existingLockfileContent.trim().length > 0
          ? installer.readLockfile(existingLockfileContent)
          : undefined

      const result = await installer.installFromManifest({
        // Installer currently models a single dependency map. We merge dev deps
        // into root resolution so bun install and bun i cover both buckets.
        dependencies: {
          ...(manifest.devDependencies ?? {}),
          ...(manifest.dependencies ?? {}),
        },
        optionalDependencies: manifest.optionalDependencies,
        overrides: manifest.overrides,
      }, {
        lockfile: existingLockfile,
        fetchFn: globalThis.fetch,
      })

      this.writeMounted(lockfilePath, installer.writeLockfile(result.lockfile))

      for (const entry of result.layoutPlan.entries) {
        const lockEntry = result.lockfile.packages[entry.packageKey]
        if (!lockEntry) continue

        this.writeMounted(
          `${entry.installPath}/package.json`,
          `${JSON.stringify(
            {
              name: lockEntry.name,
              version: lockEntry.version,
              dependencies: lockEntry.dependencies ?? {},
            },
            null,
            2,
          )}\n`,
        )
      }

      return {
        exitCode: 0,
        stdout: `Installed ${result.layoutPlan.entries.length} packages\n`,
        stderr: '',
      }
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `bun install failed: ${error instanceof Error ? error.message : String(error)}\n`,
      }
    }
  }

  private async executeBunAdd(
    request: KernelProcessExecutionRequest,
    packages: string[],
  ): Promise<KernelProcessExecutionResult> {
    if (packages.length === 0) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'bun add requires at least one package specifier\n',
      }
    }

    const parsedOptions = parseBunAddOptions(packages)
    if ('error' in parsedOptions) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: parsedOptions.error,
      }
    }

    if (parsedOptions.packageSpecifiers.length === 0) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'bun add requires at least one valid package specifier\n',
      }
    }

    const cwd = request.cwd ?? '/'
    const manifestPath = this.getManifestPath(cwd)
    const rawManifest = this.readMountedText(manifestPath)
    if (rawManifest === null) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `bun add requires package.json at ${manifestPath}\n`,
      }
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(rawManifest) as Record<string, unknown>
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Invalid package.json: ${error instanceof Error ? error.message : String(error)}\n`,
      }
    }

    const targetDependencies =
      parsed[parsedOptions.targetField] && typeof parsed[parsedOptions.targetField] === 'object'
        ? { ...(parsed[parsedOptions.targetField] as Record<string, string>) }
        : {}

    const added: string[] = []
    for (const specifier of parsedOptions.packageSpecifiers) {
      const parsedSpecifier = parsePackageSpecifier(specifier)
      if (!parsedSpecifier) continue
      targetDependencies[parsedSpecifier.name] = parsedSpecifier.spec
      added.push(`${parsedSpecifier.name}@${parsedSpecifier.spec}`)
    }

    if (added.length === 0) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'bun add requires at least one valid package specifier\n',
      }
    }

    parsed[parsedOptions.targetField] = targetDependencies
    this.writeMounted(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`)

    if (!parsedOptions.installAfterAdd) {
      return {
        exitCode: 0,
        stdout: `Added ${added.join(', ')} (no install)\n`,
        stderr: '',
      }
    }

    const installResult = await this.executeBunInstall(request)
    if (installResult.exitCode !== 0) {
      return installResult
    }

    return {
      exitCode: 0,
      stdout: `Added ${added.join(', ')}\n${installResult.stdout}`,
      stderr: '',
    }
  }

  use(plugin: KernelShellCommandHook): void {
    plugin(this.commandRegistry)
  }

  registerShellCommand(name: Parameters<KernelShellCommandRegistry['register']>[0], command: Parameters<KernelShellCommandRegistry['register']>[1]): void {
    this.commandRegistry.register(name, command)
  }

  unregisterShellCommand(name: Parameters<KernelShellCommandRegistry['unregister']>[0]): boolean {
    return this.commandRegistry.unregister(name)
  }

  hasShellCommand(name: Parameters<KernelShellCommandRegistry['has']>[0]): boolean {
    return this.commandRegistry.has(name)
  }

  private async executeWithShellRegistry(
    request: KernelProcessExecutionRequest,
  ): Promise<KernelProcessExecutionResult> {
    if (request.argv.length === 0) {
      return { exitCode: 1, stdout: '', stderr: 'spawn argv must not be empty\n' }
    }

    const [command, ...args] = request.argv
    const result = await this.commandRegistry.executeAsync(command!, args, {
      cwd: request.cwd ?? '/',
      env: request.env ?? {},
      stdin: request.stdin ?? '',
      setCwd() {},
      __kernelRequest: request,
    } as KernelExecutionContext)

    if (result.exitCode === 127 && this.processWorkerExecutor) {
      const workerResult = await this.processWorkerExecutor(request)
      return {
        exitCode: workerResult.exitCode,
        stdout: appendNewline(workerResult.stdout),
        stderr: appendNewline(workerResult.stderr),
      }
    }

    return {
      exitCode: result.exitCode,
      stdout: appendNewline(result.stdout),
      stderr: appendNewline(result.stderr),
    }
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
    this.stdios.set(pid, { stdout: stdoutCh, stderr: stderrCh })
    // Kernel side: listen for data on port1
    stdoutCh.port1.start()
    stderrCh.port1.start()
    stdoutCh.port1.onmessage = (event: MessageEvent) => {
      this.publish({
        stdio: [{ pid, kind: 'stdout', data: event.data?.data ?? '' }],
      })
    }
    stderrCh.port1.onmessage = (event: MessageEvent) => {
      this.publish({
        stdio: [{ pid, kind: 'stderr', data: event.data?.data ?? '' }],
      })
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
        this.publish({
          stdio: [{ pid, kind: msg.kind, data: typeof msg.data === 'string' ? msg.data : '' }],
        })
        return
      }
      if (msg.kind === 'exit') {
        this.exit(pid, typeof msg.code === 'number' ? msg.code : 0)
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
    return this.subscribe('stdio', handler)
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
    this.exitedCodes.set(pid, 0)
    this._resolveExitWaiters(pid, 0)
    this.publish({
      processExit: [{ pid, code: 0 }],
    })
    this.processTable.remove(pid)
    this.cleanupProcessResources(pid)
  }

  /** Mark a process as exited with the given code (called when process sends exit message) */
  exit(pid: Pid, code: number): void {
    const process = this.processTable.get(pid)
    if (!process) return
    process.status = 'exited'
    process.exitCode = code
    this.exitedCodes.set(pid, code)
    this._resolveExitWaiters(pid, code)
    this.publish({
      processExit: [{ pid, code }],
    })
    this.processTable.remove(pid)
    this.cleanupProcessResources(pid)
  }

  private cleanupProcessResources(pid: Pid): void {
    this.processPortDetachers.get(pid)?.()
    this.processPortDetachers.delete(pid)

    const stdio = this.stdios.get(pid)
    if (stdio) {
      stdio.stdout.port1.onmessage = null
      stdio.stderr.port1.onmessage = null
      stdio.stdout.port1.close()
      stdio.stderr.port1.close()
    }
    this.stdios.delete(pid)
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
      // Already exited — return reaped exit code when available.
      const exitedCode = this.exitedCodes.get(pid)
      if (typeof exitedCode === 'number') {
        this.exitedCodes.delete(pid)
        return exitedCode
      }
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

  registerPort(pid: Pid, port: number, registration: KernelPortRegistration = {}): void {
    this.portTable.set(port, pid)
    const host = registration.host?.trim() || 'localhost'
    const protocol = registration.protocol ?? 'http'
    this.publish({
      portRegistered: [{ pid, port, host, protocol }],
    })
  }

  unregisterPort(port: number): void {
    this.portTable.delete(port)
  }

  resolvePort(port: number): Pid | null {
    return this.portTable.get(port) ?? null
  }

  async handleCommand(command: KernelControlCommand): Promise<KernelControlResult> {
    switch (command.type) {
      case 'spawn': {
        const process = await this.spawn(command.options)
        return {
          ok: true,
          type: 'spawn',
          process,
        }
      }

      case 'mount': {
        const changedPaths: string[] = []
        for (const file of command.files) {
          this.mountedFiles.set(file.path, file.content)
          changedPaths.push(file.path)

          if (this.vfs) {
            this.vfs.writeFileSync(
              file.path,
              typeof file.content === 'string' ? file.content : Buffer.from(file.content),
            )
          }
        }

        return {
          ok: true,
          type: 'mount',
          changedPaths,
        }
      }

      case 'kill': {
        this.kill(command.pid, command.signal)
        return {
          ok: true,
          type: 'kill',
        }
      }

      case 'registerPort': {
        this.registerPort(command.pid, command.port, {
          host: command.host,
          protocol: command.protocol,
        })
        return {
          ok: true,
          type: 'registerPort',
        }
      }

      case 'unregisterPort': {
        this.unregisterPort(command.port)
        return {
          ok: true,
          type: 'unregisterPort',
        }
      }

      case 'stdio': {
        this.publish({
          stdio: [{ pid: command.pid, kind: command.kind, data: command.data }],
        })
        return {
          ok: true,
          type: 'stdio',
        }
      }

      case 'exit': {
        this.exit(command.pid, command.code)
        return {
          ok: true,
          type: 'exit',
        }
      }

      case 'executeProcess': {
        const result = await this.processExecutor({
          pid: command.pid,
          argv: command.argv,
          cwd: command.cwd,
          env: command.env,
          stdin: command.stdin,
          registerPort: (port: number, registration?: KernelPortRegistration) =>
            this.registerPort(command.pid, port, registration),
          readMountedFile: (path: string) => this.mountedFiles.get(path),
        })

        if (result.stdout) {
          this.publish({
            stdio: [{ pid: command.pid, kind: 'stdout', data: result.stdout }],
          })
        }

        if (result.stderr) {
          this.publish({
            stdio: [{ pid: command.pid, kind: 'stderr', data: result.stderr }],
          })
        }

        this.exit(command.pid, result.exitCode)

        return {
          ok: true,
          type: 'executeProcess',
        }
      }
    }
  }
}

