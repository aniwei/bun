import { MarsCryptoHasher, marsPassword } from "@mars/crypto"
import { createMarsSQL, type MarsSQLFacade } from "@mars/sqlite"
import packageJson from "../../../package.json"

import { createBunFile } from "./bun-file"
import { bunBuild } from "./bun-build"
import { bunServe } from "./bun-serve"
import { bunWrite } from "./bun-write"
import { createRuntimeNodeCoreModules } from "./node-core-modules"
import { detectMarsCapabilities } from "@mars/kernel"
import { createModuleLoader } from "@mars/loader"
import { normalizePath } from "@mars/vfs"

import type {
  MarsBun,
  MarsBunSpawnOptions,
  MarsBunSpawnSyncResult,
  RuntimeContext,
  RuntimeFeatures,
} from "./types"
import type { BuildResult } from "@mars/bundler"

export interface MarsRuntimeContextInstallation {
  readonly bun: MarsBun
  readonly process: MarsProcessGlobal
  readonly require: (specifier: string) => unknown
  dispose(): void
}

export interface MarsProcessGlobal {
  readonly argv: string[]
  readonly env: Record<string, string>
  cwd(): string
}

type RuntimeGlobalScope = typeof globalThis & {
  Bun?: MarsBun
  process?: MarsProcessGlobal
  require?: (specifier: string) => unknown
}
type RuntimeGlobalKey = "Bun" | "process" | "require"

// Feature defaults: sql disabled by default for bundle size optimization; esbuild/swc enabled for runtime transform.
const DEFAULT_RUNTIME_FEATURES: RuntimeFeatures = {
  esbuild: true,
  swc: true,
  sql: false,
}

function resolveRuntimeFeatures(input: RuntimeFeatures | undefined): RuntimeFeatures {
  return {
    ...DEFAULT_RUNTIME_FEATURES,
    ...input,
  }
}

function createDisabledSqlFacade(): MarsSQLFacade {
  const throwDisabled = (): never => {
    throw new Error("Bun.sql runtime feature is disabled. Enable runtimeFeatures.sql to use Bun.sql.")
  }

  const tagged = ((): Promise<never[]> => Promise.reject(new Error("Bun.sql is disabled"))) as unknown as MarsSQLFacade
  
  Object.defineProperties(tagged, {
    db: {
      get: throwDisabled,
      enumerable: true,
    },
    open: {
      value: (): never => throwDisabled(),
      enumerable: true,
    },
  })

  return tagged as MarsSQLFacade
}

function createDisabledBuildFacade(): Promise<BuildResult> {
  return Promise.resolve({
    success: false,
    outputs: [],
    logs: [
      {
        level: "error",
        message: "Bun.build runtime feature is disabled. Enable runtimeFeatures.esbuild to use Bun.build.",
      },
    ],
  })
}

export function createMarsBun(context: RuntimeContext): MarsBun {
  const runtimeFeatures = resolveRuntimeFeatures(context.runtimeFeatures)

  return {
    version: packageJson.version,
    env: context.env ?? {},
    CryptoHasher: MarsCryptoHasher,
    password: marsPassword,
    sql: runtimeFeatures.sql ? createMarsSQL({ vfs: context.vfs }) : createDisabledSqlFacade(),
    file: (path, options) => createBunFile(context, path, options),
    write: (destination, input) => bunWrite(context, destination, input),
    serve: options => bunServe(context, options),
    build: options => runtimeFeatures.esbuild ? bunBuild(context, options) : createDisabledBuildFacade(),
    spawn: options => bunSpawn(context, normalizeSpawnOptions(options)),
    spawnSync: options => bunSpawnSync(context, normalizeSpawnOptions(options)),
    fetch: (input, init) => globalThis.fetch(input, init),
  }
}

export function installBunGlobal(context: RuntimeContext): MarsBun {
  return installMarsRuntimeContext(context).bun
}

export function installMarsRuntimeContext(context: RuntimeContext): MarsRuntimeContextInstallation {
  const marsBun = createMarsBun(context)
  const scope = (context.scope ?? globalThis) as RuntimeGlobalScope
  const moduleLoader = createModuleLoader({
    vfs: context.vfs,
    coreModules: createRuntimeNodeCoreModules(context),
  })
  const processGlobal = createMarsProcessGlobal(context)
  const requireParent = normalizePath("__mars_context__.js", context.cwd ?? context.vfs.cwd())
  const require = (specifier: string) => moduleLoader.require(specifier, requireParent)
  const restoreBun = installScopedGlobal(scope, "Bun", marsBun, context.forceGlobals)
  const restoreProcess = installScopedGlobal(scope, "process", processGlobal, context.forceGlobals)
  const restoreRequire = installScopedGlobal(scope, "require", require, context.forceGlobals)

  return {
    bun: marsBun,
    process: processGlobal,
    require,
    dispose: () => {
      restoreRequire()
      restoreProcess()
      restoreBun()
    },
  }
}

function installScopedGlobal(
  scope: RuntimeGlobalScope,
  key: RuntimeGlobalKey,
  value: unknown,
  force = false,
): () => void {
  const hadOwnValue = Object.prototype.hasOwnProperty.call(scope, key)
  const descriptor = Object.getOwnPropertyDescriptor(scope, key)

  if (!force && scope === globalThis && descriptor && (key === "Bun" || key === "process")) {
    return () => {}
  }

  if (!descriptor) {
    Object.defineProperty(scope, key, {
      configurable: true,
      writable: true,
      value,
    })

    return () => {
      delete scope[key]
    }
  }

  if (descriptor.writable) {
    const previousValue = scope[key]
    Object.assign(scope, { [key]: value })

    return () => {
      if (hadOwnValue) Object.assign(scope, { [key]: previousValue })
      else delete scope[key]
    }
  }

  if (descriptor.configurable) {
    Object.defineProperty(scope, key, {
      configurable: true,
      writable: true,
      value,
    })

    return () => {
      Object.defineProperty(scope, key, descriptor)
    }
  }

  return () => {}
}

function createMarsProcessGlobal(context: RuntimeContext): MarsProcessGlobal {
  const cwd = context.cwd ?? context.vfs.cwd()

  return {
    argv: [...(context.argv ?? [])],
    env: { ...context.env },
    cwd: () => cwd,
  }
}

function normalizeSpawnOptions(options: MarsBunSpawnOptions | string[]): MarsBunSpawnOptions {
  return Array.isArray(options) ? { cmd: options } : options
}

function bunSpawn(context: RuntimeContext, options: MarsBunSpawnOptions) {
  if (context.spawn) return context.spawn(options)

  return context.kernel.spawn({
    argv: options.cmd,
    cwd: options.cwd ?? context.vfs.cwd(),
    env: options.env ?? context.env,
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
    kind: "worker",
  })
}

function bunSpawnSync(context: RuntimeContext, options: MarsBunSpawnOptions): MarsBunSpawnSyncResult {
  if (context.spawnSync) return context.spawnSync(options)

  const capabilities = detectMarsCapabilities(context.scope ?? globalThis)
  const command = options.cmd.join(" ")
  if (capabilities.sharedArrayBuffer && capabilities.atomicsWait) {
    const [executable = "", ...args] = options.cmd
    const result = runBuiltinSyncCommand(executable, args, context, options)
    if (result !== null) return result

    const message = `Bun.spawnSync SAB profile detected but sync executor is currently available only for built-in commands: ${command}`
    return {
      success: false,
      exitCode: 1,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode(`${message}\n`),
      error: new Error(message),
    }
  }

  const message = `Bun.spawnSync requires SharedArrayBuffer + Atomics.wait and is not available for: ${command}`

  return {
    success: false,
    exitCode: 1,
    stdout: new Uint8Array(),
    stderr: new TextEncoder().encode(`${message}\n`),
    error: new Error(message),
  }
}

function runBuiltinSyncCommand(
  executable: string,
  args: string[],
  context: RuntimeContext,
  options: MarsBunSpawnOptions,
): MarsBunSpawnSyncResult | null {
  const enc = new TextEncoder()
  const cwd = options.cwd ?? context.cwd ?? context.vfs.cwd()

  if (executable === "echo") {
    return {
      success: true,
      exitCode: 0,
      stdout: enc.encode(`${args.join(" ")}\n`),
      stderr: new Uint8Array(),
    }
  }

  if (executable === "true") {
    return { success: true, exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }
  }

  if (executable === "false") {
    return {
      success: false,
      exitCode: 1,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    }
  }

  if (executable === "pwd") {
    return {
      success: true,
      exitCode: 0,
      stdout: enc.encode(`${cwd}\n`),
      stderr: new Uint8Array(),
    }
  }

  if (executable === "ls") {
    try {
      const target = normalizePath(args[0] ?? ".", cwd)
      const entries = context.vfs.readdirSync(target) as string[]

      return {
        success: true,
        exitCode: 0,
        stdout: enc.encode(entries.length ? `${entries.join("\n")}\n` : ""),
        stderr: new Uint8Array(),
      }
    } catch (error) {
      return failedSyncCommand(`ls: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  if (executable === "printf") {
    const formatted = args.join("")
    return {
      success: true,
      exitCode: 0,
      stdout: enc.encode(formatted),
      stderr: new Uint8Array(),
    }
  }

  if (executable === "cat") {
    if (args.length === 0) {
      if (typeof options.stdin === "string") {
        return {
          success: true,
          exitCode: 0,
          stdout: enc.encode(options.stdin),
          stderr: new Uint8Array(),
        }
      }

      if (options.stdin) {
        return failedSyncCommand("cat: ReadableStream stdin is not available in Bun.spawnSync browser context\n")
      }

      return {
        success: true,
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      }
    }

    try {
      const output = args
        .map(path => context.vfs.readFileSync(normalizePath(path, cwd), "utf8"))
        .join("")

      return {
        success: true,
        exitCode: 0,
        stdout: enc.encode(output),
        stderr: new Uint8Array(),
      }
    } catch (error) {
      return failedSyncCommand(`cat: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  if (executable === "grep") {
    return runSyncGrep(args, context, cwd)
  }

  if (executable === "mkdir") {
    try {
      const recursive = args.includes("-p")
      const paths = args.filter(value => value !== "-p")
      for (const path of paths) {
        context.vfs.mkdirSync(normalizePath(path, cwd), { recursive })
      }

      return {
        success: true,
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      }
    } catch (error) {
      return failedSyncCommand(`mkdir: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  if (executable === "rm") {
    try {
      const paths = args.filter(value => value !== "-r" && value !== "-rf")
      for (const path of paths) {
        context.vfs.unlinkSync(normalizePath(path, cwd))
      }

      return {
        success: true,
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      }
    } catch (error) {
      return failedSyncCommand(`rm: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  return null
}

function runSyncGrep(args: string[], context: RuntimeContext, cwd: string): MarsBunSpawnSyncResult {
  const recursive = args.includes("-R") || args.includes("-r")
  const filteredArgs = args.filter(value => value !== "-R" && value !== "-r")
  const pattern = filteredArgs[0]
  if (!pattern) return failedSyncCommand("grep: missing pattern\n")

  try {
    const root = normalizePath(filteredArgs[1] ?? ".", cwd)
    const files = recursive ? collectSyncGrepFiles(context, root) : [root]
    const matches: string[] = []

    for (const file of files) {
      const text = context.vfs.readFileSync(file, "utf8") as string
      const lines = text.split("\n")

      for (const [index, line] of lines.entries()) {
        if (line.includes(pattern)) matches.push(`${file}:${index + 1}:${line}`)
      }
    }

    return {
      success: matches.length > 0,
      exitCode: matches.length > 0 ? 0 : 1,
      stdout: new TextEncoder().encode(matches.length ? `${matches.join("\n")}\n` : ""),
      stderr: new Uint8Array(),
    }
  } catch (error) {
    return failedSyncCommand(`grep: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

function collectSyncGrepFiles(context: RuntimeContext, root: string): string[] {
  const stats = context.vfs.statSync(root)
  if (stats.isFile()) return [root]

  const files: string[] = []
  for (const entry of context.vfs.readdirSync(root) as string[]) {
    files.push(...collectSyncGrepFiles(context, normalizePath(entry, root)))
  }

  return files
}

function failedSyncCommand(message: string): MarsBunSpawnSyncResult {
  return {
    success: false,
    exitCode: 1,
    stdout: new Uint8Array(),
    stderr: new TextEncoder().encode(message),
    error: new Error(message.trim()),
  }
}