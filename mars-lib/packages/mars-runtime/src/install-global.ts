import { MarsCryptoHasher, marsPassword } from "@mars/crypto"
import { createMarsSQL } from "@mars/sqlite"
import packageJson from "../../../package.json"

import { createBunFile } from "./bun-file"
import { bunBuild } from "./bun-build"
import { bunServe } from "./bun-serve"
import { bunWrite } from "./bun-write"
import { createModuleLoader } from "@mars/loader"
import { normalizePath } from "@mars/vfs"

import type { MarsBun, MarsBunSpawnOptions, MarsBunSpawnSyncResult, RuntimeContext } from "./types"

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

export function createMarsBun(context: RuntimeContext): MarsBun {
  return {
    version: packageJson.version,
    env: context.env ?? {},
    CryptoHasher: MarsCryptoHasher,
    password: marsPassword,
    sql: createMarsSQL({ vfs: context.vfs }),
    file: (path, options) => createBunFile(context, path, options),
    write: (destination, input) => bunWrite(context, destination, input),
    serve: options => bunServe(context, options),
    build: options => bunBuild(context, options),
    spawn: options => bunSpawn(context, normalizeSpawnOptions(options)),
    spawnSync: options => bunSpawnSync(normalizeSpawnOptions(options)),
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
  const restoreBun = installScopedGlobal(scope, "Bun", marsBun)
  const restoreProcess = installScopedGlobal(scope, "process", processGlobal)
  const restoreRequire = installScopedGlobal(scope, "require", require)

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
): () => void {
  const hadOwnValue = Object.prototype.hasOwnProperty.call(scope, key)
  const descriptor = Object.getOwnPropertyDescriptor(scope, key)

  if (scope === globalThis && descriptor && (key === "Bun" || key === "process")) {
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
    env: { ...(context.env ?? {}) },
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

function bunSpawnSync(options: MarsBunSpawnOptions): MarsBunSpawnSyncResult {
  const message = `Bun.spawnSync is not available in this browser profile: ${options.cmd.join(" ")}`

  return {
    success: false,
    exitCode: 1,
    stdout: new Uint8Array(),
    stderr: new TextEncoder().encode(`${message}\n`),
    error: new Error(message),
  }
}