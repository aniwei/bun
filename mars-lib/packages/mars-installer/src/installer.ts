import { extractPackageTarball } from "./extract-tarball"
import { createInstallPlan, resolvePackage } from "./plan"
import { writeNodeModules } from "./write-node-modules"
import { normalizePath } from "@mars/vfs"

import type {
  InstallOptions,
  InstallPlan,
  InstallResult,
  MarsInstallerOptions,
  PackageInstaller,
  ResolvedPackage,
} from "./types"

export class MarsInstaller implements PackageInstaller {
  readonly #options: MarsInstallerOptions

  constructor(options: MarsInstallerOptions) {
    this.#options = options
  }

  async install(options: InstallOptions): Promise<InstallResult> {
    const plan = (options.preferLockfile ?? true)
      ? await this.#createPlanFromLockfile(options)
        ?? await createInstallPlan(options, this.#options.cache, this.#options.registryClient)
      : await createInstallPlan(options, this.#options.cache, this.#options.registryClient)
    for (const pkg of plan.packages) {
      await this.#hydratePackageFiles(pkg, options)
    }
    await this.writeNodeModules(plan)

    return {
      packages: plan.packages,
      ...(plan.lockfile ? { lockfile: plan.lockfile } : {}),
    }
  }

  async resolvePackage(specifier: string, range: string): Promise<ResolvedPackage> {
    return resolvePackage(this.#options.cache, specifier, range, {}, this.#options.registryClient)
  }

  async fetchTarball(pkg: ResolvedPackage): Promise<Uint8Array> {
    if (!pkg.tarballKey) return new Uint8Array()

    const cached = await this.#options.cache.getTarball(pkg.tarballKey)
    if (cached) return cached
    if (!this.#options.registryClient) return new Uint8Array()

    const tarball = await this.#options.registryClient.fetchTarball(pkg)
    await this.#options.cache.setTarball(pkg.tarballKey, tarball)
    return tarball
  }

  async writeNodeModules(plan: InstallPlan): Promise<void> {
    await writeNodeModules(this.#options.vfs, plan)
  }

  async #hydratePackageFiles(pkg: ResolvedPackage, options: InstallOptions): Promise<void> {
    if (!pkg.tarballKey) return

    let tarball = await this.#options.cache.getTarball(pkg.tarballKey)
    if (!tarball && !options.offline && this.#options.registryClient) {
      tarball = await this.#options.registryClient.fetchTarball(pkg)
      await this.#options.cache.setTarball(pkg.tarballKey, tarball)
    }
    if (!tarball || hasPackageFiles(pkg)) return

    pkg.files = await extractPackageTarball(tarball)
  }

  async #createPlanFromLockfile(options: InstallOptions): Promise<InstallPlan | null> {
    const lockfile = this.#readInstallLockfile(options.cwd)
    if (!lockfile) return null
    if (!lockfileMatchesRequestedRoot(lockfile, options)) return null

    const workspacePackages = new Map((options.workspaces ?? []).map(pkg => [pkg.name, pkg]))
    const orderedPackageNames = Object.keys(lockfile.packages).sort((left, right) => left.localeCompare(right))
    const packages: ResolvedPackage[] = []

    for (const packageName of orderedPackageNames) {
      const lockEntry = lockfile.entries[packageName]
      if (lockEntry?.workspace) {
        const workspacePackage = workspacePackages.get(packageName)
        if (!workspacePackage) return null

        packages.push({
          name: workspacePackage.name,
          version: workspacePackage.version,
          dependencies: lockEntry.dependencies,
          optionalDependencies: lockEntry.optionalDependencies,
          peerDependencies: lockEntry.peerDependencies,
          peerDependenciesMeta: workspacePackage.peerDependenciesMeta ?? {},
          scripts: workspacePackage.scripts ?? {},
          bin: normalizeWorkspacePackageBin(workspacePackage.name, workspacePackage.bin),
          workspacePath: workspacePackage.path,
          files: workspacePackage.files,
        })
        continue
      }

      const version = lockfile.packages[packageName]
      const pkg = await resolvePackage(
        this.#options.cache,
        packageName,
        version,
        { offline: options.offline },
        this.#options.registryClient,
      )

      packages.push({
        ...pkg,
        dependencies: lockEntry?.dependencies ?? pkg.dependencies,
        optionalDependencies: lockEntry?.optionalDependencies ?? pkg.optionalDependencies,
        peerDependencies: lockEntry?.peerDependencies ?? pkg.peerDependencies,
        ...(lockEntry?.tarball ? { tarballKey: lockEntry.tarball } : {}),
      })
    }

    return {
      cwd: options.cwd,
      packages,
      lockfile,
    }
  }

  #readInstallLockfile(cwd: string) {
    const bunLockPath = normalizePath("bun.lock", cwd)
    const marsLockPath = normalizePath("mars-lock.json", cwd)

    const bunLock = this.#readJsonFile(bunLockPath)
    if (bunLock) {
      const parsedBunLock = parseBunLockfile(bunLock)
      if (parsedBunLock) return parsedBunLock
    }

    const marsLock = this.#readJsonFile(marsLockPath)
    if (marsLock) {
      const parsedMarsLock = parseMarsLockfile(marsLock)
      if (parsedMarsLock) return parsedMarsLock
    }

    return null
  }

  #readJsonFile(path: string): unknown {
    if (!this.#options.vfs.existsSync(path)) return null

    try {
      return JSON.parse(String(this.#options.vfs.readFileSync(path, "utf8")))
    } catch {
      return null
    }
  }
}

function parseMarsLockfile(value: unknown): InstallResult["lockfile"] | null {
  if (!isRecord(value)) return null

  const packages = toRecordOfString(value.packages)
  if (!packages) return null

  const root = isRecord(value.root)
    ? {
      ...(typeof value.root.name === "string" ? { name: value.root.name } : {}),
      dependencies: toRecordOfString(value.root.dependencies) ?? {},
      devDependencies: toRecordOfString(value.root.devDependencies) ?? {},
      optionalDependencies: toRecordOfString(value.root.optionalDependencies) ?? {},
      peerDependencies: toRecordOfString(value.root.peerDependencies) ?? {},
    }
    : {
      dependencies: {},
      devDependencies: {},
      optionalDependencies: {},
      peerDependencies: {},
    }

  const rawEntries = isRecord(value.entries) ? value.entries : {}
  const entries: NonNullable<InstallResult["lockfile"]>["entries"] = {}
  for (const [name, rawEntry] of Object.entries(rawEntries)) {
    if (!isRecord(rawEntry)) continue

    entries[name] = {
      version: typeof rawEntry.version === "string" ? rawEntry.version : packages[name] ?? "0.0.0",
      dependencies: toRecordOfString(rawEntry.dependencies) ?? {},
      optionalDependencies: toRecordOfString(rawEntry.optionalDependencies) ?? {},
      peerDependencies: toRecordOfString(rawEntry.peerDependencies) ?? {},
      ...(typeof rawEntry.tarball === "string" ? { tarball: rawEntry.tarball } : {}),
      ...(typeof rawEntry.workspace === "string" ? { workspace: rawEntry.workspace } : {}),
    }
  }

  for (const [name, version] of Object.entries(packages)) {
    if (entries[name]) continue
    entries[name] = {
      version,
      dependencies: {},
      optionalDependencies: {},
      peerDependencies: {},
    }
  }

  return {
    packages,
    root,
    entries,
  }
}

function parseBunLockfile(value: unknown): InstallResult["lockfile"] | null {
  if (!isRecord(value)) return null
  if (typeof value.lockfileVersion !== "number") return null

  const workspaceRoot = isRecord(value.workspaces) && isRecord(value.workspaces[""])
    ? value.workspaces[""]
    : null
  const rawPackages = isRecord(value.packages) ? value.packages : null
  if (!rawPackages) return null

  const packages: Record<string, string> = {}
  const entries: NonNullable<InstallResult["lockfile"]>["entries"] = {}

  for (const [name, rawEntry] of Object.entries(rawPackages)) {
    if (Array.isArray(rawEntry)) {
      const firstField = rawEntry[0]
      if (typeof firstField !== "string") return null

      const parsedVersion = parseVersionFromSpecifier(firstField, name)
      if (!parsedVersion) return null

      const maybeMetadata = rawEntry.find((item, index) => index > 1 && isRecord(item))
      const metadata = isRecord(maybeMetadata) ? maybeMetadata : null
      const resolved = rawEntry.find((item, index) => index > 1 && typeof item === "string")

      packages[name] = parsedVersion
      entries[name] = {
        version: parsedVersion,
        dependencies: toRecordOfString(metadata?.dependencies) ?? {},
        optionalDependencies: toRecordOfString(metadata?.optionalDependencies) ?? {},
        peerDependencies: toRecordOfString(metadata?.peerDependencies) ?? {},
        ...(typeof resolved === "string" ? { tarball: resolved } : {}),
        ...(typeof metadata?.workspace === "string" ? { workspace: metadata.workspace } : {}),
      }
      continue
    }

    if (!isRecord(rawEntry) || typeof rawEntry.version !== "string") return null
    packages[name] = rawEntry.version
    entries[name] = {
      version: rawEntry.version,
      dependencies: toRecordOfString(rawEntry.dependencies) ?? {},
      optionalDependencies: toRecordOfString(rawEntry.optionalDependencies) ?? {},
      peerDependencies: toRecordOfString(rawEntry.peerDependencies) ?? {},
      ...(typeof rawEntry.resolved === "string" ? { tarball: rawEntry.resolved } : {}),
      ...(typeof rawEntry.workspace === "string" ? { workspace: rawEntry.workspace } : {}),
    }
  }

  return {
    packages,
    root: {
      ...(typeof workspaceRoot?.name === "string" ? { name: workspaceRoot.name } : {}),
      dependencies: toRecordOfString(workspaceRoot?.dependencies) ?? {},
      devDependencies: toRecordOfString(workspaceRoot?.devDependencies) ?? {},
      optionalDependencies: toRecordOfString(workspaceRoot?.optionalDependencies) ?? {},
      peerDependencies: toRecordOfString(workspaceRoot?.peerDependencies) ?? {},
    },
    entries,
  }
}

function parseVersionFromSpecifier(specifier: string, packageName: string): string | null {
  const packagePrefix = `${packageName}@`
  if (!specifier.startsWith(packagePrefix)) return null
  const version = specifier.slice(packagePrefix.length).trim()
  return version || null
}

function lockfileMatchesRequestedRoot(lockfile: NonNullable<InstallResult["lockfile"]>, options: InstallOptions): boolean {
  return recordsEqual(lockfile.root.dependencies, options.dependencies ?? {})
    && recordsEqual(lockfile.root.devDependencies, options.devDependencies ?? {})
    && recordsEqual(lockfile.root.optionalDependencies, options.optionalDependencies ?? {})
    && recordsEqual(lockfile.root.peerDependencies, options.peerDependencies ?? {})
}

function recordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  if (leftEntries.length !== rightEntries.length) return false

  return leftEntries.every(([key, value]) => right[key] === value)
}

function normalizeWorkspacePackageBin(name: string, bin: string | Record<string, string> | undefined): Record<string, string> {
  if (!bin) return {}
  if (typeof bin === "string") return { [name.split("/").at(-1) ?? name]: bin }

  return bin
}

function toRecordOfString(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null

  const entries = Object.entries(value)
  if (entries.some(([, item]) => typeof item !== "string")) return null

  return Object.fromEntries(entries) as Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function hasPackageFiles(pkg: ResolvedPackage): boolean {
  return Object.keys(pkg.files).length > 0
}

export function createMarsInstaller(options: MarsInstallerOptions): PackageInstaller {
  return new MarsInstaller(options)
}