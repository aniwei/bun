import { createModuleLoader } from "@mars/loader"
import { normalizePath } from "@mars/vfs"

import { installMarsRuntimeContext } from "./install-global"

import type { RuntimeContext } from "./types"

export interface RunEntryOptions {
  cwd?: string
}

export async function runEntryScript(
  context: RuntimeContext,
  entry: string,
  options: RunEntryOptions = {},
): Promise<unknown> {
  const moduleLoader = createModuleLoader({
    vfs: context.vfs,
  })
  const baseDirectory = options.cwd ?? context.vfs.cwd()
  const entryPath = normalizePath(entry, baseDirectory)

  const runtimeContext = installMarsRuntimeContext({ ...context, forceGlobals: true })
  const restoreConsole = installConsoleBridge(context)

  try {
    return await moduleLoader.import(entryPath, entryPath)
  } finally {
    restoreConsole()
    runtimeContext.dispose()
  }
}

function installConsoleBridge(context: RuntimeContext): () => void {
  if (!context.pid) return () => {}

  const scope = context.scope ?? globalThis
  const originalConsole = scope.console
  const consoleBridge = Object.assign(Object.create(originalConsole), {
    log: (...args: unknown[]) => {
      context.kernel.writeStdio(context.pid as number, 1, `${formatConsoleArgs(args)}\n`)
    },
    error: (...args: unknown[]) => {
      context.kernel.writeStdio(context.pid as number, 2, `${formatConsoleArgs(args)}\n`)
    },
    warn: (...args: unknown[]) => {
      context.kernel.writeStdio(context.pid as number, 2, `${formatConsoleArgs(args)}\n`)
    },
  }) as Console

  scope.console = consoleBridge

  return () => {
    scope.console = originalConsole
  }
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map(formatConsoleArg).join(" ")
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.stack ?? value.message

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
