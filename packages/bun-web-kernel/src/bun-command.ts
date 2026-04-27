import type { KernelConfig, KernelProcessExecutionRequest, KernelProcessExecutionResult } from './kernel.types'

type BunAddDependencyField = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'

interface BunAddOptions {
  installAfterAdd: boolean
  targetField: BunAddDependencyField
  packageSpecifiers: string[]
}

interface BunCommandExecutorOptions {
  readMountedText(path: string): string | null
  writeMounted(path: string, content: string): void
  getManifestPath(cwd: string | undefined): string
  processWorkerExecutor?: KernelConfig['processExecutor']
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

export class BunCommandExecutor {
  constructor(private readonly options: BunCommandExecutorOptions) {}

  async execute(
    args: string[],
    request: KernelProcessExecutionRequest,
  ): Promise<KernelProcessExecutionResult> {
    const subcommand = args[0]

    switch (subcommand) {
      case 'run':
        return await this.executeRun(request)
      case 'install':
      case 'i':
        return await this.executeInstall(request)
        break
      case 'add':
        return await this.executeAdd(request, args.slice(1))
      case 'version':
        // TODO
        // return await this.executeVersion()
      default:
        return {
          exitCode: 1,
          stdout: '',
          stderr: `Unsupported bun subcommand: ${subcommand}\n`,
        }
    }
  }

  private async executeRun(request: KernelProcessExecutionRequest): Promise<KernelProcessExecutionResult> {
    if (!this.options.processWorkerExecutor) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'bun command requires process worker executor\n',
      }
    }

    return await this.options.processWorkerExecutor(request)
  }

  private async executeInstall(
    request: KernelProcessExecutionRequest,
  ): Promise<KernelProcessExecutionResult> {
    const cwd = request.cwd ?? '/'
    const manifestPath = this.options.getManifestPath(cwd)
    const rawManifest = this.options.readMountedText(manifestPath)

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
        this.options.writeMounted(lockfilePath, `${JSON.stringify({ lockfileVersion: 1, packages: {} }, null, 2)}\n`)
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
      const existingLockfileContent = this.options.readMountedText(lockfilePath)
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

      this.options.writeMounted(lockfilePath, installer.writeLockfile(result.lockfile))

      for (const entry of result.layoutPlan.entries) {
        const lockEntry = result.lockfile.packages[entry.packageKey]
        if (!lockEntry) continue

        this.options.writeMounted(
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

  private async executeAdd(
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
    const manifestPath = this.options.getManifestPath(cwd)
    const rawManifest = this.options.readMountedText(manifestPath)
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
    this.options.writeMounted(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`)

    if (!parsedOptions.installAfterAdd) {
      return {
        exitCode: 0,
        stdout: `Added ${added.join(', ')} (no install)\n`,
        stderr: '',
      }
    }

    const installResult = await this.executeInstall(request)
    if (installResult.exitCode !== 0) {
      return installResult
    }

    return {
      exitCode: 0,
      stdout: `Added ${added.join(', ')}\n${installResult.stdout}`,
      stderr: '',
    }
  }
}

export function createBunCommandExecutor(options: BunCommandExecutorOptions): BunCommandExecutor {
  return new BunCommandExecutor(options)
} 