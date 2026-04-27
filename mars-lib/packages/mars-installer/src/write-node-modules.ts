import { normalizePath } from "@mars/vfs"

import type { FileTree, MarsVFS } from "@mars/vfs"
import type { InstallPlan, ResolvedPackage } from "./types"

export async function writeNodeModules(vfs: MarsVFS, plan: InstallPlan): Promise<void> {
  const nodeModulesPath = normalizePath("node_modules", plan.cwd)
  await vfs.mkdir(nodeModulesPath, { recursive: true })

  for (const pkg of plan.packages) {
    await writePackage(vfs, nodeModulesPath, pkg)
  }

  if (plan.lockfile) {
    await vfs.writeFile(
      normalizePath("mars-lock.json", plan.cwd),
      `${JSON.stringify(plan.lockfile, null, 2)}\n`,
    )
  }
}

async function writePackage(
  vfs: MarsVFS,
  nodeModulesPath: string,
  pkg: ResolvedPackage,
): Promise<void> {
  const packageRoot = normalizePath(pkg.name, nodeModulesPath)
  await vfs.mkdir(packageRoot, { recursive: true })
  await vfs.writeFile(
    normalizePath("package.json", packageRoot),
    `${JSON.stringify(packageJsonFor(pkg), null, 2)}\n`,
  )
  await restoreFiles(vfs, pkg.files, packageRoot)
}

async function restoreFiles(vfs: MarsVFS, tree: FileTree, root: string): Promise<void> {
  for (const [name, value] of Object.entries(tree)) {
    const targetPath = normalizePath(name, root)

    if (typeof value === "string" || value instanceof Uint8Array) {
      await vfs.writeFile(targetPath, value)
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
  }
}