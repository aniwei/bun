import type { BunWebLockfile, LockfilePackageEntry } from './lockfile'

export type LayoutPackageNode = {
  packageKey: string
  name: string
  version: string
  dependencies: Record<string, string>
}

export type LayoutGraph = Record<string, LayoutPackageNode>

export type LayoutPlanEntry = {
  packageKey: string
  installPath: string
}

export type DependencyLink = {
  fromPackageKey: string
  dependencyName: string
  toInstallPath: string
}

export type NodeModulesLayoutPlan = {
  entries: LayoutPlanEntry[]
  links: DependencyLink[]
}

function normalizePath(path: string): string {
  if (!path.startsWith('/')) return `/${path}`
  return path
}

function parentContainerPath(packageInstallPath: string): string {
  return `${packageInstallPath}/node_modules`
}

function collectContainerChain(parentContainer: string): string[] {
  const containers = new Set<string>()
  let current = normalizePath(parentContainer)

  while (true) {
    containers.add(current)
    if (current === '/node_modules') {
      break
    }

    const marker = '/node_modules/'
    const idx = current.lastIndexOf(marker)
    if (idx <= 0) {
      containers.add('/node_modules')
      break
    }

    current = `${current.slice(0, idx)}${marker.slice(0, -1)}`
  }

  return Array.from(containers).sort((a, b) => a.length - b.length)
}

function sortedKeys(input: Record<string, unknown>): string[] {
  return Object.keys(input).sort()
}

function getInstallPath(container: string, packageName: string): string {
  return `${container}/${packageName}`
}

function resolveDependencyKey(
  packageName: string,
  spec: string,
  graph: LayoutGraph,
): string {
  const directKey = `${packageName}@${spec}`
  const direct = graph[directKey]
  if (direct && direct.name === packageName) {
    return directKey
  }

  const byExactVersion = sortedKeys(graph)
    .map(key => graph[key])
    .find(node => node.name === packageName && node.version === spec)
  if (byExactVersion) {
    return byExactVersion.packageKey
  }

  const byName = sortedKeys(graph)
    .map(key => graph[key])
    .filter(node => node.name === packageName)

  if (byName.length === 1) {
    return byName[0].packageKey
  }

  if (byName.length === 0) {
    throw new Error(`Dependency '${packageName}' not found in layout graph`)
  }

  throw new Error(
    `Dependency '${packageName}' with spec '${spec}' is ambiguous in layout graph`,
  )
}

function resolveInstallPath(
  dependencyKey: string,
  dependencyName: string,
  parentContainer: string,
  installedByPath: Map<string, string>,
): { installPath: string; installed: boolean } {
  const containers = collectContainerChain(parentContainer)

  for (const container of containers) {
    const candidatePath = getInstallPath(container, dependencyName)
    const existing = installedByPath.get(candidatePath)
    if (existing === dependencyKey) {
      return { installPath: candidatePath, installed: false }
    }
  }

  // Hoist to the highest container without collision.
  let targetPath = getInstallPath(parentContainer, dependencyName)
  for (const container of containers) {
    const candidatePath = getInstallPath(container, dependencyName)
    const existing = installedByPath.get(candidatePath)
    if (!existing) {
      targetPath = candidatePath
      break
    }
  }

  return { installPath: targetPath, installed: true }
}

function validateRootPackageKeys(rootPackageKeys: string[], graph: LayoutGraph): void {
  if (rootPackageKeys.length === 0) {
    throw new TypeError('rootPackageKeys must not be empty')
  }

  for (const packageKey of rootPackageKeys) {
    if (!graph[packageKey]) {
      throw new Error(`Unknown root package key: ${packageKey}`)
    }
  }
}

export function buildLayoutGraphFromLockfile(lockfile: BunWebLockfile): LayoutGraph {
  const graph: LayoutGraph = {}

  for (const packageKey of Object.keys(lockfile.packages).sort()) {
    const entry = lockfile.packages[packageKey]
    graph[packageKey] = {
      packageKey,
      name: entry.name,
      version: entry.version,
      dependencies: {
        ...(entry.dependencies ?? {}),
      },
    }
  }

  return graph
}

export function resolveRootPackageKeys(
  lockfile: BunWebLockfile,
  rootDependencies: Record<string, string>,
): string[] {
  const graph = buildLayoutGraphFromLockfile(lockfile)
  return sortedKeys(rootDependencies).map(packageName => {
    const spec = rootDependencies[packageName]
    return resolveDependencyKey(packageName, spec, graph)
  })
}

export function planNodeModulesLayout(
  graph: LayoutGraph,
  rootPackageKeys: string[],
): NodeModulesLayoutPlan {
  validateRootPackageKeys(rootPackageKeys, graph)

  const installedByPath = new Map<string, string>()
  const links: DependencyLink[] = []
  const visited = new Set<string>()

  function visit(packageKey: string, installPath: string): void {
    const visitKey = `${packageKey}@@${installPath}`
    if (visited.has(visitKey)) {
      return
    }
    visited.add(visitKey)

    const node = graph[packageKey]
    const dependencies = sortedKeys(node.dependencies)

    for (const dependencyName of dependencies) {
      const dependencySpec = node.dependencies[dependencyName]
      const dependencyKey = resolveDependencyKey(dependencyName, dependencySpec, graph)
      const parentContainer = parentContainerPath(installPath)
      const resolution = resolveInstallPath(
        dependencyKey,
        dependencyName,
        parentContainer,
        installedByPath,
      )

      if (resolution.installed) {
        installedByPath.set(resolution.installPath, dependencyKey)
      }

      links.push({
        fromPackageKey: packageKey,
        dependencyName,
        toInstallPath: resolution.installPath,
      })

      visit(dependencyKey, resolution.installPath)
    }
  }

  for (const rootPackageKey of [...rootPackageKeys].sort()) {
    const rootNode = graph[rootPackageKey]
    const rootPath = `/node_modules/${rootNode.name}`
    const existing = installedByPath.get(rootPath)
    if (existing && existing !== rootPackageKey) {
      throw new Error(`Root install path collision at '${rootPath}'`)
    }
    installedByPath.set(rootPath, rootPackageKey)
    visit(rootPackageKey, rootPath)
  }

  const entries: LayoutPlanEntry[] = Array.from(installedByPath.entries())
    .map(([installPath, packageKey]) => ({ installPath, packageKey }))
    .sort((a, b) => a.installPath.localeCompare(b.installPath))

  return {
    entries,
    links: links.sort((a, b) => {
      const byFrom = a.fromPackageKey.localeCompare(b.fromPackageKey)
      if (byFrom !== 0) return byFrom
      const byName = a.dependencyName.localeCompare(b.dependencyName)
      if (byName !== 0) return byName
      return a.toInstallPath.localeCompare(b.toInstallPath)
    }),
  }
}

export function planNodeModulesLayoutFromLockfile(
  lockfile: BunWebLockfile,
  rootDependencies: Record<string, string>,
): NodeModulesLayoutPlan {
  const graph = buildLayoutGraphFromLockfile(lockfile)
  const rootPackageKeys = resolveRootPackageKeys(lockfile, rootDependencies)
  return planNodeModulesLayout(graph, rootPackageKeys)
}

export function createLockfilePackageEntry(
  packageKey: string,
  entry: LockfilePackageEntry,
): LayoutPackageNode {
  return {
    packageKey,
    name: entry.name,
    version: entry.version,
    dependencies: {
      ...(entry.dependencies ?? {}),
    },
  }
}