import type { FileTree, MarsSerializedFileTree } from "@mars/vfs"

export interface ProcessWorkerBootstrapScriptOptions {
  runtimeImport?: string
  vfsImport?: string
  kernelImport?: string
  cwd?: string
  initialFiles?: FileTree
  initialSnapshot?: MarsSerializedFileTree
  snapshotRoot?: string
  autoRun?: boolean
}

export interface ProcessWorkerBootstrapURLOptions extends ProcessWorkerBootstrapScriptOptions {
  scope?: ProcessWorkerBootstrapURLScope
}

export interface ProcessWorkerBootstrapURLScope {
  Blob: typeof Blob
  URL: {
    createObjectURL(blob: Blob): string
  }
}

export function createProcessWorkerBootstrapScript(
  options: ProcessWorkerBootstrapScriptOptions = {},
): string {
  const runtimeImport = options.runtimeImport ?? "@mars/runtime"
  const vfsImport = options.vfsImport ?? "@mars/vfs"
  const kernelImport = options.kernelImport ?? "@mars/kernel"
  const cwd = options.cwd ?? "/workspace"
  const initialFiles = fileTreeToSource(options.initialFiles ?? {})
  const initialSnapshot = options.initialSnapshot ? JSON.stringify(options.initialSnapshot) : "null"
  const snapshotRoot = options.snapshotRoot ?? cwd
  const autoRun = options.autoRun ?? true

  return [
    `import { installProcessWorkerRuntimeBootstrap } from ${JSON.stringify(runtimeImport)}`,
    `import { createMarsVFS, restoreVFSSnapshot } from ${JSON.stringify(vfsImport)}`,
    `import { createMarsKernel } from ${JSON.stringify(kernelImport)}`,
    "",
    `const vfs = createMarsVFS({ cwd: ${JSON.stringify(cwd)}, initialFiles: ${initialFiles} })`,
    `const initialSnapshot = ${initialSnapshot}`,
    `if (initialSnapshot) await restoreVFSSnapshot(vfs, initialSnapshot, ${JSON.stringify(snapshotRoot)})`,
    "const kernel = createMarsKernel()",
    "",
    "installProcessWorkerRuntimeBootstrap({",
    "  scope: self,",
    "  vfs,",
    "  kernel,",
    `  autoRun: ${JSON.stringify(autoRun)},`,
    "})",
    "",
  ].join("\n")
}

export function createProcessWorkerBootstrapBlobURL(
  options: ProcessWorkerBootstrapURLOptions = {},
): string {
  const scope = options.scope ?? globalThis
  const script = createProcessWorkerBootstrapScript(options)
  const blob = new scope.Blob([script], { type: "text/javascript" })

  return scope.URL.createObjectURL(blob)
}

function fileTreeToSource(tree: FileTree): string {
  const entries = Object.entries(tree).map(([path, value]) => {
    return `${JSON.stringify(path)}: ${fileTreeValueToSource(value)}`
  })

  return `{ ${entries.join(", ")} }`
}

function fileTreeValueToSource(value: string | Uint8Array | FileTree): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (value instanceof Uint8Array) return `new Uint8Array(${JSON.stringify([...value])})`

  return fileTreeToSource(value)
}
