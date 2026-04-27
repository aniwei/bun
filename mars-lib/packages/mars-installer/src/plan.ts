import type { InstallOptions, InstallPlan, PackageCache, ResolvedPackage } from "./types"

export async function createInstallPlan(
  options: InstallOptions,
  cache: PackageCache,
): Promise<InstallPlan> {
  const packages = new Map<string, ResolvedPackage>()
  const requestedDependencies = {
    ...options.dependencies,
    ...options.devDependencies,
  }

  for (const [name, range] of sortedEntries(requestedDependencies)) {
    await addPackage(name, range)
  }

  const orderedPackages = [...packages.values()].sort((left, right) => {
    return left.name.localeCompare(right.name)
  })
  const lockfile = options.lockfile === false
    ? undefined
    : {
      packages: Object.fromEntries(
        orderedPackages.map(pkg => [pkg.name, pkg.version]),
      ),
    }

  return {
    cwd: options.cwd,
    packages: orderedPackages,
    ...(lockfile ? { lockfile } : {}),
  }

  async function addPackage(name: string, range: string): Promise<void> {
    if (packages.has(name)) return

    const resolvedPackage = await resolveCachedPackage(cache, name, range)
    packages.set(name, resolvedPackage)

    for (const [dependencyName, dependencyRange] of sortedEntries(resolvedPackage.dependencies)) {
      await addPackage(dependencyName, dependencyRange)
    }
  }
}

export async function resolveCachedPackage(
  cache: PackageCache,
  name: string,
  range: string,
): Promise<ResolvedPackage> {
  const metadata = await cache.getMetadata(name)
  if (!metadata) throw new Error(`Package metadata not found in offline cache: ${name}`)

  const version = pickVersion(metadata.distTags, Object.keys(metadata.versions), range)
  const versionMetadata = metadata.versions[version]
  if (!versionMetadata) throw new Error(`Package version not found in offline cache: ${name}@${range}`)

  return {
    name,
    version,
    dependencies: versionMetadata.dependencies ?? {},
    files: versionMetadata.files ?? {},
    ...(versionMetadata.tarballKey ? { tarballKey: versionMetadata.tarballKey } : {}),
  }
}

function pickVersion(
  distTags: Record<string, string> | undefined,
  versions: string[],
  range: string,
): string {
  if (range in (distTags ?? {})) return distTags?.[range] ?? range
  if (versions.includes(range)) return range
  if (range.startsWith("^") || range.startsWith("~")) {
    const exact = range.slice(1)
    if (versions.includes(exact)) return exact

    const compatibleVersion = pickCompatibleVersion(versions, exact, range.startsWith("^"))
    if (compatibleVersion) return compatibleVersion
  }
  if (distTags?.latest) return distTags.latest

  return [...versions].sort().at(-1) ?? range
}

function pickCompatibleVersion(
  versions: string[],
  baseline: string,
  allowMinorAndPatch: boolean,
): string | null {
  const baselineParts = parseVersion(baseline)
  if (!baselineParts) return null

  return versions
    .filter(version => {
      const parts = parseVersion(version)
      if (!parts) return false
      if (parts.major !== baselineParts.major) return false
      if (!allowMinorAndPatch && parts.minor !== baselineParts.minor) return false

      return compareVersions(parts, baselineParts) >= 0
    })
    .sort((left, right) => compareVersions(parseVersion(left)!, parseVersion(right)!))
    .at(-1) ?? null
}

function parseVersion(version: string): { major: number; minor: number; patch: number } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return null

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function compareVersions(
  left: { major: number; minor: number; patch: number },
  right: { major: number; minor: number; patch: number },
): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

function sortedEntries(input: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(input ?? {}).sort(([left], [right]) => left.localeCompare(right))
}