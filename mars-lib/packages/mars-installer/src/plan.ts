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
    return packageInstallKey(left).localeCompare(packageInstallKey(right))
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
        orderedPackages.map(pkg => [packageInstallKey(pkg), pkg.version]),
      ),
      entries: Object.fromEntries(
        orderedPackages.map(pkg => [
          packageInstallKey(pkg),
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

  async function addPackage(name: string, range: string, requester?: ResolvedPackage): Promise<void> {
    const existingPackage = findVisiblePackage(packages, requester, name, range)
    if (existingPackage) return

    if (!requester) {
      const rootPackage = packages.get(name)
      if (rootPackage) {
        assertPackageRange(rootPackage, range, name)
      }
    }

    const installPath = chooseInstallPath(packages, requester, name)
    const packageAtInstallPath = packages.get(installPath)
    if (packageAtInstallPath) {
      assertPackageRange(packageAtInstallPath, range, name)
      return
    }

    const workspacePackage = workspacePackages.get(name)
    const packageResolution = workspacePackage
      ? resolveWorkspacePackage(workspacePackage, range)
      : await resolvePackage(cache, name, range, options, registryClient)
    const resolvedPackage = {
      ...packageResolution,
      ...(installPath === name ? {} : { installPath }),
    }
    packages.set(installPath, resolvedPackage)

    for (const [dependencyName, dependencyRange] of sortedEntries(resolvedPackage.dependencies)) {
      await addPackage(dependencyName, dependencyRange, resolvedPackage)
    }

    for (const [dependencyName, dependencyRange] of sortedEntries(resolvedPackage.optionalDependencies)) {
      await addOptionalPackage(dependencyName, dependencyRange, resolvedPackage)
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
    const visiblePackage = findNearestVisiblePackage(packages, requester, name)
    if (visiblePackage) {
      assertPackageRange(visiblePackage, range, name, requester)
      return
    }

    const rootRequestedRange = requestedDependencies[name] ?? requestedPeerDependencies[name]
    if (rootRequestedRange) {
      await addPackage(name, rootRequestedRange)
      const installedPackage = findNearestVisiblePackage(packages, requester, name)
      if (installedPackage) assertPackageRange(installedPackage, range, name, requester)
      return
    }

    await addPackage(name, range)
  }

  async function addOptionalPeerPackage(requester: ResolvedPackage, name: string, range: string): Promise<void> {
    await addOptionalPackage(name, range, requester)
  }

  async function addOptionalPackage(name: string, range: string, requester?: ResolvedPackage): Promise<void> {
    const packageSnapshot = new Map(packages)

    try {
      await addPackage(name, range, requester)
    } catch {
      packages.clear()
      for (const [installPath, pkg] of packageSnapshot) {
        packages.set(installPath, pkg)
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
      .map(([name, range]) => [name, findResolvedPackageByName(resolvedPackages, name)?.version ?? range]),
  )
}

function packageInstallKey(pkg: ResolvedPackage): string {
  return pkg.installPath ?? pkg.name
}

function findResolvedPackageByName(
  packages: Map<string, ResolvedPackage>,
  name: string,
): ResolvedPackage | null {
  for (const pkg of packages.values()) {
    if (pkg.name === name) return pkg
  }

  return null
}

function findVisiblePackage(
  packages: Map<string, ResolvedPackage>,
  requester: ResolvedPackage | undefined,
  name: string,
  range: string,
): ResolvedPackage | null {
  for (const installPath of visiblePackageInstallPaths(requester, name)) {
    const pkg = packages.get(installPath)
    if (pkg && packageVersionSatisfies(pkg.version, range)) return pkg
  }

  return null
}

function findNearestVisiblePackage(
  packages: Map<string, ResolvedPackage>,
  requester: ResolvedPackage | undefined,
  name: string,
): ResolvedPackage | null {
  for (const installPath of visiblePackageInstallPaths(requester, name)) {
    const pkg = packages.get(installPath)
    if (pkg) return pkg
  }

  return null
}

function chooseInstallPath(
  packages: Map<string, ResolvedPackage>,
  requester: ResolvedPackage | undefined,
  name: string,
): string {
  if (!requester || !packages.has(name)) return name

  for (const installPath of visiblePackageInstallPaths(requester, name).filter(path => path !== name)) {
    if (!packages.has(installPath)) return installPath
  }

  return `${packageInstallKey(requester)}/node_modules/${name}`
}

function visiblePackageInstallPaths(requester: ResolvedPackage | undefined, name: string): string[] {
  const paths: string[] = []
  let cursor = requester ? packageInstallKey(requester) : ""

  while (cursor) {
    paths.push(`${cursor}/node_modules/${name}`)
    const nestedIndex = cursor.lastIndexOf("/node_modules/")
    if (nestedIndex === -1) break
    cursor = cursor.slice(0, nestedIndex)
  }

  paths.push(name)
  return paths
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