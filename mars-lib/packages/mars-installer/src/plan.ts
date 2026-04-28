import { packageVersionSatisfies, pickPackageVersion } from "./version-range"

import type { InstallOptions, InstallPlan, PackageCache, PackageRegistryClient, ResolvedPackage, WorkspacePackage } from "./types"

export async function createInstallPlan(
  options: InstallOptions,
  cache: PackageCache,
  registryClient?: PackageRegistryClient,
): Promise<InstallPlan> {
  const packages = new Map<string, ResolvedPackage>()
  const workspacePackages = new Map((options.workspaces ?? []).map(pkg => [pkg.name, pkg]))
  const requestedDependencies = {
    ...options.dependencies,
    ...options.devDependencies,
  }
  const requestedOptionalDependencies = options.optionalDependencies ?? {}
  const requestedPeerDependencies = options.peerDependencies ?? {}

  for (const workspacePackage of [...workspacePackages.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    await addWorkspacePackage(workspacePackage, `workspace:${workspacePackage.version}`)
  }

  for (const [name, range] of sortedEntries(requestedDependencies)) {
    await addPackage(name, range)
  }

  for (const [name, range] of sortedEntries(requestedOptionalDependencies)) {
    await addOptionalPackage(name, range)
  }

  for (const [name, range] of sortedEntries(requestedPeerDependencies)) {
    await addPackage(name, range)
  }

  const orderedPackages = [...packages.values()].sort((left, right) => {
    return left.name.localeCompare(right.name)
  })
  const lockfile = options.lockfile === false
    ? undefined
    : {
      root: {
        ...(options.rootName ? { name: options.rootName } : {}),
        dependencies: requestedDependencies,
        devDependencies: options.devDependencies ?? {},
        optionalDependencies: requestedOptionalDependencies,
        peerDependencies: requestedPeerDependencies,
      },
      packages: Object.fromEntries(
        orderedPackages.map(pkg => [pkg.name, pkg.version]),
      ),
      entries: Object.fromEntries(
        orderedPackages.map(pkg => [
          pkg.name,
          {
            version: pkg.version,
            dependencies: resolveLockfileDependencyVersions(pkg.dependencies, packages),
            optionalDependencies: resolveLockfileDependencyVersions(pkg.optionalDependencies, packages),
            peerDependencies: resolveLockfileDependencyVersions(pkg.peerDependencies, packages),
            ...(pkg.tarballKey ? { tarball: pkg.tarballKey } : {}),
            ...(pkg.workspacePath ? { workspace: pkg.workspacePath } : {}),
          },
        ]),
      ),
    }

  return {
    cwd: options.cwd,
    packages: orderedPackages,
    ...(lockfile ? { lockfile } : {}),
  }

  async function addPackage(name: string, range: string): Promise<void> {
    const existingPackage = packages.get(name)
    if (existingPackage) {
      assertPackageRange(existingPackage, range, name)
      return
    }

    const workspacePackage = workspacePackages.get(name)
    const resolvedPackage = workspacePackage
      ? resolveWorkspacePackage(workspacePackage, range)
      : await resolvePackage(cache, name, range, options, registryClient)
    packages.set(name, resolvedPackage)

    for (const [dependencyName, dependencyRange] of sortedEntries(resolvedPackage.dependencies)) {
      await addPackage(dependencyName, dependencyRange)
    }

    for (const [dependencyName, dependencyRange] of sortedEntries(resolvedPackage.optionalDependencies)) {
      await addOptionalPackage(dependencyName, dependencyRange)
    }

    for (const [dependencyName, dependencyRange] of sortedEntries(resolvedPackage.peerDependencies)) {
      if (resolvedPackage.peerDependenciesMeta[dependencyName]?.optional) {
        await addOptionalPeerPackage(resolvedPackage, dependencyName, dependencyRange)
        continue
      }

      await addPeerPackage(resolvedPackage, dependencyName, dependencyRange)
    }
  }

  async function addWorkspacePackage(workspacePackage: WorkspacePackage, range: string): Promise<void> {
    await addPackage(workspacePackage.name, range)
  }

  async function addPeerPackage(requester: ResolvedPackage, name: string, range: string): Promise<void> {
    const existingPackage = packages.get(name)
    if (existingPackage) {
      assertPackageRange(existingPackage, range, name, requester)
      return
    }

    await addPackage(name, range)
  }

  async function addOptionalPeerPackage(requester: ResolvedPackage, name: string, range: string): Promise<void> {
    const existingPackage = packages.get(name)
    if (existingPackage) {
      assertPackageRange(existingPackage, range, name, requester)
      return
    }

    await addOptionalPackage(name, range)
  }

  async function addOptionalPackage(name: string, range: string): Promise<void> {
    const packageSnapshot = new Map(packages)

    try {
      await addPackage(name, range)
    } catch {
      packages.clear()
      for (const [packageName, pkg] of packageSnapshot) {
        packages.set(packageName, pkg)
      }
    }
  }
}

function resolveLockfileDependencyVersions(
  dependencies: Record<string, string>,
  resolvedPackages: Map<string, ResolvedPackage>,
): Record<string, string> {
  return Object.fromEntries(
    sortedEntries(dependencies)
      .map(([name, range]) => [name, resolvedPackages.get(name)?.version ?? range]),
  )
}

function resolveWorkspacePackage(workspacePackage: WorkspacePackage, range: string): ResolvedPackage {
  if (!packageVersionSatisfies(workspacePackage.version, range)) {
    throw new Error(`Workspace package ${workspacePackage.name}@${workspacePackage.version} does not satisfy range ${range}`)
  }

  return {
    name: workspacePackage.name,
    version: workspacePackage.version,
    dependencies: workspacePackage.dependencies ?? {},
    optionalDependencies: workspacePackage.optionalDependencies ?? {},
    peerDependencies: workspacePackage.peerDependencies ?? {},
    peerDependenciesMeta: workspacePackage.peerDependenciesMeta ?? {},
    scripts: workspacePackage.scripts ?? {},
    bin: normalizePackageBin(workspacePackage.name, workspacePackage.bin),
    workspacePath: workspacePackage.path,
    files: workspacePackage.files,
  }
}

function assertPackageRange(
  pkg: ResolvedPackage,
  range: string,
  name: string,
  requester?: ResolvedPackage,
): void {
  if (packageVersionSatisfies(pkg.version, range)) return

  const requestedBy = requester ? ` required by ${requester.name}@${requester.version}` : ""
  throw new Error(`Package ${name}@${pkg.version} does not satisfy range ${range}${requestedBy}`)
}

export async function resolvePackage(
  cache: PackageCache,
  name: string,
  range: string,
  options: Pick<InstallOptions, "offline"> = {},
  registryClient?: PackageRegistryClient,
): Promise<ResolvedPackage> {
  let metadata = await cache.getMetadata(name)
  if (!metadata && !options.offline && registryClient) {
    metadata = await registryClient.fetchMetadata(name)
    await cache.setMetadata(name, metadata)
  }
  if (!metadata) throw new Error(`Package metadata not found in offline cache: ${name}`)

  return resolvePackageMetadata(metadata, name, range)
}

export async function resolveCachedPackage(
  cache: PackageCache,
  name: string,
  range: string,
): Promise<ResolvedPackage> {
  const metadata = await cache.getMetadata(name)
  if (!metadata) throw new Error(`Package metadata not found in offline cache: ${name}`)

  return resolvePackageMetadata(metadata, name, range)
}

function resolvePackageMetadata(
  metadata: Awaited<ReturnType<PackageCache["getMetadata"]>>,
  name: string,
  range: string,
): ResolvedPackage {
  if (!metadata) throw new Error(`Package metadata not found in offline cache: ${name}`)
  const version = pickPackageVersion(metadata.distTags, Object.keys(metadata.versions), range)
  const versionMetadata = metadata.versions[version]
  if (!versionMetadata) throw new Error(`Package version not found in offline cache: ${name}@${range}`)

  return {
    name,
    version,
    dependencies: versionMetadata.dependencies ?? {},
    optionalDependencies: versionMetadata.optionalDependencies ?? {},
    peerDependencies: versionMetadata.peerDependencies ?? {},
    peerDependenciesMeta: versionMetadata.peerDependenciesMeta ?? {},
    scripts: versionMetadata.scripts ?? {},
    bin: versionMetadata.bin ?? {},
    files: versionMetadata.files ?? {},
    ...(versionMetadata.tarballKey ? { tarballKey: versionMetadata.tarballKey } : {}),
  }
}

function normalizePackageBin(name: string, bin: string | Record<string, string> | undefined): Record<string, string> {
  if (!bin) return {}
  if (typeof bin === "string") return { [name.split("/").at(-1) ?? name]: bin }

  return bin
}

function sortedEntries(input: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(input ?? {}).sort(([left], [right]) => left.localeCompare(right))
}