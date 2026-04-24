import {
  createEmptyLockfile,
  type BunWebLockfile,
  upsertLockfilePackage,
} from './lockfile'
import { 
  fetchPackageMetadata, 
  resolveVersion, 
  type FetchPackageMetadataOptions, 
  type NpmPackageMetadata 
} from './registry'
import { downloadTarball, extractTarball, verifyIntegrity } from './tarball'
import { planNodeModulesLayoutFromLockfile, type NodeModulesLayoutPlan } from './node-modules-layout'

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

type TarballCache = {
  getTarball(cacheKey: string): Promise<Uint8Array | null>
  setTarball(cacheKey: string, tarball: Uint8Array): Promise<void>
}

export type InstallManifest = {
  dependencies: Record<string, string>
  optionalDependencies?: Record<string, string>
  overrides?: Record<string, string>
}

export type InstallFromManifestOptions = {
  lockfile?: BunWebLockfile
  registryUrl?: string
  fetchFn?: FetchLike
  tarballCache?: TarballCache
  mode?: 'full' | 'lockfile-only'
  retryCount?: number
}

export type InstallFromManifestResult = {
  lockfile: BunWebLockfile
  layoutPlan: NodeModulesLayoutPlan
  resolvedRootDependencies: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertManifest(manifest: InstallManifest): void {
  if (!isRecord(manifest.dependencies)) {
    throw new TypeError('manifest.dependencies must be an object')
  }

  if (manifest.overrides !== undefined && !isRecord(manifest.overrides)) {
    throw new TypeError('manifest.overrides must be an object when provided')
  }

  if (manifest.optionalDependencies !== undefined && !isRecord(manifest.optionalDependencies)) {
    throw new TypeError('manifest.optionalDependencies must be an object when provided')
  }
}

type VersionManifest = {
  dist: {
    tarball: string
    integrity?: string
  }
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
}

function pickVersion(metadata: NpmPackageMetadata, spec: string): string {
  // resolveVersion handles exact versions, dist-tags, and semver ranges
  return resolveVersion(metadata, spec)
}

function resolveDependencySpec(manifest: InstallManifest, name: string, fallbackSpec: string): string {
  const override = manifest.overrides?.[name]
  return typeof override === 'string' && override.length > 0 ? override : fallbackSpec
}

function getVersionManifest(metadata: NpmPackageMetadata, version: string): VersionManifest {
  const raw = metadata.versions[version]
  if (!isRecord(raw)) {
    throw new Error(`Version '${version}' not found for package '${metadata.name}'`)
  }

  const dist = raw.dist
  if (!isRecord(dist) || typeof dist.tarball !== 'string' || dist.tarball.length === 0) {
    throw new Error(`Invalid dist.tarball for package '${metadata.name}@${version}'`)
  }

  const dependencies = isRecord(raw.dependencies)
    ? Object.fromEntries(
      Object.entries(raw.dependencies).filter(([, value]) => typeof value === 'string') as Array<[string, string]>,
    )
    : {}

  const optionalDependencies = isRecord(raw.optionalDependencies)
    ? Object.fromEntries(
      Object.entries(raw.optionalDependencies).filter(([, value]) => typeof value === 'string') as Array<[string, string]>,
    )
    : {}

  return {
    dist: {
      tarball: dist.tarball,
      integrity: typeof dist.integrity === 'string' ? dist.integrity : undefined,
    },
    dependencies,
    optionalDependencies,
  }
}

async function withRetries<T>(
  run: () => Promise<T>,
  retryCount: number,
  shouldRetry: (error: unknown) => boolean,
): Promise<T> {
  let attempts = 0
  let lastError: unknown
  const totalAttempts = Math.max(1, retryCount + 1)

  while (attempts < totalAttempts) {
    try {
      return await run()
    } catch (error) {
      lastError = error
      attempts += 1
      if (!shouldRetry(error)) {
        break
      }
      if (attempts >= totalAttempts) {
        break
      }
    }
  }

  if (lastError instanceof Error) {
    const suffix = attempts === 1 ? '1 attempt' : `${attempts} attempts`
    throw new Error(`${lastError.message} (after ${suffix})`, { cause: lastError })
  }

  throw lastError
}

function getStatusCodeFromError(error: unknown): number | null {
  if (!(error instanceof Error)) return null
  const match = error.message.match(/:\s*(\d{3})\b/)
  if (!match) return null
  return Number(match[1])
}

function shouldRetryMetadataError(error: unknown): boolean {
  const statusCode = getStatusCodeFromError(error)
  if (statusCode === null) return true
  return statusCode >= 500
}

function shouldRetryTarballError(error: unknown): boolean {
  if (error instanceof Error && error.message.includes('Integrity mismatch')) {
    return false
  }

  const statusCode = getStatusCodeFromError(error)
  if (statusCode === null) return true
  return statusCode >= 500
}

function hasResolvablePackageReference(
  packages: BunWebLockfile['packages'],
  dependencyName: string,
  spec: string,
): boolean {
  const directKey = `${dependencyName}@${spec}`
  if (directKey in packages) {
    return true
  }

  const candidates = Object.values(packages).filter(entry => entry.name === dependencyName)
  if (candidates.length === 0) {
    return false
  }

  if (candidates.some(entry => entry.version === spec)) {
    return true
  }

  return candidates.length === 1
}

function pruneUnresolvableDependencies(lockfile: BunWebLockfile): BunWebLockfile {
  const normalizedPackages = Object.fromEntries(
    Object.entries(lockfile.packages).map(([packageKey, entry]) => {
      const dependencies = Object.fromEntries(
        Object.entries(entry.dependencies ?? {}).filter(([dependencyName, spec]) => {
          return hasResolvablePackageReference(lockfile.packages, dependencyName, spec)
        }),
      )

      return [
        packageKey,
        {
          ...entry,
          dependencies,
        },
      ]
    }),
  )

  return {
    ...lockfile,
    packages: normalizedPackages,
  }
}

export async function installFromManifest(
  manifest: InstallManifest,
  options: InstallFromManifestOptions = {},
): Promise<InstallFromManifestResult> {
  assertManifest(manifest)

  let lockfile = options.lockfile ?? createEmptyLockfile()
  const fetchOptions: FetchPackageMetadataOptions = {
    registryUrl: options.registryUrl,
    fetchFn: options.fetchFn,
  }

  const metadataCache = new Map<string, NpmPackageMetadata>()
  const queue: Array<{ name: string; spec: string; isRoot: boolean; isOptional: boolean }> = [
    ...Object.keys(manifest.dependencies)
      .sort()
      .map(name => ({ name, spec: manifest.dependencies[name], isRoot: true, isOptional: false })),
    ...Object.keys(manifest.optionalDependencies ?? {})
      .sort()
      .filter(name => !(name in manifest.dependencies))
      .map(name => ({
        name,
        spec: manifest.optionalDependencies![name],
        isRoot: true,
        isOptional: true,
      })),
  ]
  const visited = new Set<string>()
  const resolvedRootDependencies: Record<string, string> = {}

  const mode = options.mode ?? 'full'
  const retryCount = Math.max(0, options.retryCount ?? 0)

  while (queue.length > 0) {
    const task = queue.shift()!
    const taskSpec = resolveDependencySpec(manifest, task.name, task.spec)

    try {
      let metadata = metadataCache.get(task.name)
      if (!metadata) {
        metadata = await withRetries(
          async () => await fetchPackageMetadata(task.name, fetchOptions),
          retryCount,
          shouldRetryMetadataError,
        )
        metadataCache.set(task.name, metadata)
      }

      const version = pickVersion(metadata, taskSpec)
      const packageKey = `${task.name}@${version}`

      if (task.isRoot) {
        resolvedRootDependencies[task.name] = version
      }

      if (visited.has(packageKey)) {
        continue
      }

      const versionManifest = getVersionManifest(metadata, version)
      if (mode === 'full') {
        const cacheKey = packageKey
        let tarballBytes = await options.tarballCache?.getTarball(cacheKey)

        // A stale/corrupted cache entry must not bypass integrity guarantees.
        if (tarballBytes && versionManifest.dist.integrity) {
          try {
            await verifyIntegrity(tarballBytes, versionManifest.dist.integrity)
          } catch {
            tarballBytes = null
          }
        }

        if (!tarballBytes) {
          tarballBytes = await withRetries(
            async () => await downloadTarball(versionManifest.dist.tarball, {
              fetchFn: options.fetchFn,
              integrity: versionManifest.dist.integrity,
            }),
            retryCount,
            shouldRetryTarballError,
          )
          await options.tarballCache?.setTarball(cacheKey, tarballBytes)
        }

        // Ensure the downloaded/cached archive is parseable before mutating lockfile state.
        await extractTarball(tarballBytes)
      }

      lockfile = upsertLockfilePackage(lockfile, packageKey, {
        name: task.name,
        version,
        resolved: versionManifest.dist.tarball,
        integrity: versionManifest.dist.integrity,
        dependencies: {
          ...versionManifest.dependencies,
          ...versionManifest.optionalDependencies,
        },
      })
      visited.add(packageKey)

      for (const dependencyName of Object.keys(versionManifest.dependencies).sort()) {
        queue.push({
          name: dependencyName,
          spec: versionManifest.dependencies[dependencyName],
          isRoot: false,
          isOptional: false,
        })
      }

      for (const dependencyName of Object.keys(versionManifest.optionalDependencies).sort()) {
        queue.push({
          name: dependencyName,
          spec: versionManifest.optionalDependencies[dependencyName],
          isRoot: false,
          isOptional: true,
        })
      }
    } catch (error) {
      if (task.isOptional) {
        continue
      }
      throw error
    }
  }

  const normalizedLockfile = pruneUnresolvableDependencies(lockfile)
  const layoutPlan = planNodeModulesLayoutFromLockfile(normalizedLockfile, resolvedRootDependencies)

  return {
    lockfile: normalizedLockfile,
    layoutPlan,
    resolvedRootDependencies,
  }
}