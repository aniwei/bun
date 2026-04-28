import { dirname, isFileTreeSymlink, normalizePath } from "@mars/vfs"

import type { FileTree, MarsVFS } from "@mars/vfs"
import type { InstallLockfile, InstallPlan, ResolvedPackage } from "./types"

export async function writeNodeModules(vfs: MarsVFS, plan: InstallPlan): Promise<void> {
  const nodeModulesPath = normalizePath("node_modules", plan.cwd)
  await vfs.mkdir(nodeModulesPath, { recursive: true })

  for (const pkg of plan.packages) {
    await writePackage(vfs, nodeModulesPath, pkg)
  }

  await writePackageBins(vfs, nodeModulesPath, plan.packages)

  if (plan.lockfile) {
    const marsLockfileText = `${JSON.stringify(plan.lockfile, null, 2)}\n`
    const bunLockfileText = `${stringifyBunLockfile(createBunLockfile(plan.lockfile))}\n`
    await vfs.writeFile(normalizePath("mars-lock.json", plan.cwd), marsLockfileText)
    await vfs.writeFile(normalizePath("bun.lock", plan.cwd), bunLockfileText)
  }
}

function createBunLockfile(lockfile: InstallLockfile) {
  return {
    lockfileVersion: 1,
    configVersion: 1,
    workspaces: {
      "": {
        ...(lockfile.root.name ? { name: lockfile.root.name } : {}),
        ...withNonEmptyRecord("dependencies", lockfile.root.dependencies),
        ...withNonEmptyRecord("devDependencies", lockfile.root.devDependencies),
        ...withNonEmptyRecord("optionalDependencies", lockfile.root.optionalDependencies),
        ...withNonEmptyRecord("peerDependencies", lockfile.root.peerDependencies),
      },
    },
    packages: Object.fromEntries(
      Object.entries(lockfile.entries)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, entry]) => {
          const metadata = {
            ...withNonEmptyRecord("dependencies", entry.dependencies),
            ...withNonEmptyRecord("optionalDependencies", entry.optionalDependencies),
            ...withNonEmptyRecord("peerDependencies", entry.peerDependencies),
            ...(entry.workspace ? { workspace: entry.workspace } : {}),
          }

          const packageTuple: unknown[] = [
            `${name}@${entry.version}`,
            "",
            metadata,
            ...(entry.tarball ? [entry.tarball] : []),
          ]

          return [name, packageTuple]
        }),
    ),
  }
}

function stringifyBunLockfile(lockfile: ReturnType<typeof createBunLockfile>): string {
  const workspaceEntries = Object.entries(lockfile.workspaces)
  const packageEntries = Object.entries(lockfile.packages)

  return [
    "{",
    `  ${JSON.stringify("lockfileVersion")}: ${JSON.stringify(lockfile.lockfileVersion)},`,
    `  ${JSON.stringify("configVersion")}: ${JSON.stringify(lockfile.configVersion)},`,
    `  ${JSON.stringify("workspaces")}: {`,
    ...workspaceEntries.map(([name, value], index) => {
      const suffix = index === workspaceEntries.length - 1 ? "" : ","
      return `    ${JSON.stringify(name)}: ${formatObjectMultiline(value, 4)}${suffix}`
    }),
    "  },",
    `  ${JSON.stringify("packages")}: {`,
    ...packageEntries.map(([name, value], index) => {
      const suffix = index === packageEntries.length - 1 ? "" : ","
      return `    ${JSON.stringify(name)}: ${formatTuple(value)}${suffix}`
    }),
    "  }",
    "}",
  ].join("\n")
}

function formatTuple(value: unknown): string {
  if (!Array.isArray(value)) return JSON.stringify(value)

  return `[${value.map(formatInlineValue).join(", ")}]`
}

function formatInlineValue(value: unknown): string {
  if (isPlainObject(value)) return formatObjectInline(value)
  return JSON.stringify(value)
}

function formatObjectInline(value: Record<string, unknown>): string {
  const entries = Object.entries(value)
  if (entries.length === 0) return "{}"

  return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${formatInlineValue(item)}`).join(", ")} }`
}

function formatObjectMultiline(value: Record<string, unknown>, indentSize: number): string {
  const entries = Object.entries(value)
  if (entries.length === 0) return "{}"

  const indent = " ".repeat(indentSize)
  const childIndent = " ".repeat(indentSize + 2)
  return [
    "{",
    ...entries.map(([key, item], index) => {
      const suffix = index === entries.length - 1 ? "" : ","
      return `${childIndent}${JSON.stringify(key)}: ${formatNestedValue(item, indentSize + 2)}${suffix}`
    }),
    `${indent}}`,
  ].join("\n")
}

function formatNestedValue(value: unknown, indentSize: number): string {
  if (!isPlainObject(value)) return formatInlineValue(value)
  return formatObjectMultiline(value, indentSize)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function sortRecord(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  )
}

function withNonEmptyRecord(key: string, input: Record<string, string>): Record<string, Record<string, string>> {
  if (Object.keys(input).length === 0) return {}
  return { [key]: sortRecord(input) }
}

async function writePackage(
  vfs: MarsVFS,
  nodeModulesPath: string,
  pkg: ResolvedPackage,
): Promise<void> {
  const packageRoot = normalizePath(pkg.installPath ?? pkg.name, nodeModulesPath)
  if (pkg.workspacePath) {
    await writeWorkspacePackage(vfs, packageRoot, pkg)
    return
  }

  await vfs.mkdir(packageRoot, { recursive: true })
  await vfs.writeFile(
    normalizePath("package.json", packageRoot),
    `${JSON.stringify(packageJsonFor(pkg), null, 2)}\n`,
  )
  await restoreFiles(vfs, pkg.files, packageRoot)
}

async function writeWorkspacePackage(
  vfs: MarsVFS,
  packageRoot: string,
  pkg: ResolvedPackage,
): Promise<void> {
  if (!pkg.workspacePath) return

  const workspacePath = normalizePath(pkg.workspacePath)
  if (!await pathExists(vfs, workspacePath)) {
    await vfs.mkdir(workspacePath, { recursive: true })
    await restoreFiles(vfs, pkg.files, workspacePath)
  }

  const packageJsonPath = normalizePath("package.json", workspacePath)
  if (!await fileExists(vfs, packageJsonPath)) {
    await vfs.writeFile(packageJsonPath, `${JSON.stringify(packageJsonFor(pkg), null, 2)}\n`)
  }

  await vfs.mkdir(dirname(packageRoot), { recursive: true })
  if (await linkExists(vfs, packageRoot)) return

  await vfs.symlink(workspacePath, packageRoot)
}

async function restoreFiles(vfs: MarsVFS, tree: FileTree, root: string): Promise<void> {
  for (const [name, value] of Object.entries(tree)) {
    const targetPath = normalizePath(name, root)

    if (typeof value === "string" || value instanceof Uint8Array) {
      await vfs.writeFile(targetPath, value)
      continue
    }

    if (isFileTreeSymlink(value)) {
      await vfs.symlink(value.target, targetPath)
      continue
    }

    await vfs.mkdir(targetPath, { recursive: true })
    await restoreFiles(vfs, value, targetPath)
  }
}

function packageJsonFor(pkg: ResolvedPackage) {
  return {
    name: pkg.name,
    version: pkg.version,
    main: "index.js",
    module: "index.js",
    dependencies: pkg.dependencies,
    optionalDependencies: pkg.optionalDependencies,
    peerDependencies: pkg.peerDependencies,
    peerDependenciesMeta: pkg.peerDependenciesMeta,
    scripts: pkg.scripts,
    bin: pkg.bin,
  }
}

async function writePackageBins(
  vfs: MarsVFS,
  nodeModulesPath: string,
  packages: ResolvedPackage[],
): Promise<void> {
  const binPath = normalizePath(".bin", nodeModulesPath)

  for (const pkg of packages) {
    for (const [binName, target] of Object.entries(pkg.bin)) {
      const targetPath = normalizePath(target, normalizePath(pkg.name, nodeModulesPath))
      if (!await fileExists(vfs, targetPath)) continue

      await vfs.mkdir(binPath, { recursive: true })
      await vfs.writeFile(normalizePath(binName, binPath), `bun run ${targetPath}\n`)
    }
  }
}

async function fileExists(vfs: MarsVFS, path: string): Promise<boolean> {
  try {
    const stats = await vfs.stat(path)
    return stats.isFile()
  } catch {
    return false
  }
}

async function pathExists(vfs: MarsVFS, path: string): Promise<boolean> {
  try {
    await vfs.stat(path)
    return true
  } catch {
    return false
  }
}

async function linkExists(vfs: MarsVFS, path: string): Promise<boolean> {
  try {
    const stats = await vfs.lstat(path)
    return stats.isSymbolicLink()
  } catch {
    return false
  }
}