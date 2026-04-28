import { MarsCryptoHasher, marsPassword } from "@mars/crypto"
import { createMarsSQL, type MarsSQLFacade } from "@mars/sqlite"
import packageJson from "../../../package.json"

import { createBunFile } from "./bun-file"
import { bunBuild } from "./bun-build"
import { bunServe } from "./bun-serve"
import { bunWrite } from "./bun-write"
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
  const moduleLoader = createModuleLoader({ vfs: context.vfs })
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
    const result = runBuiltinSyncCommand(executable, args)
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

function runBuiltinSyncCommand(executable: string, args: string[]): MarsBunSpawnSyncResult | null {
  const enc = new TextEncoder()

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
      stdout: enc.encode("/\n"),
      stderr: new Uint8Array(),
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
    // cat with no args or args that are not real file paths: return empty output rather than blocking.
    return {
      success: true,
      exitCode: 0,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    }
  }

  return null
}