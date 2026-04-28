import { preloadEsbuildWasm } from "@mars/bundler"
import { preloadSQLiteWasm } from "@mars/sqlite"
import { preloadSwcWasm, setSwcWasmEnabled } from "@mars/transpiler"

import type { RuntimeFeatures } from "@mars/runtime"
import type { HookRegistry } from "./hooks"

export const DEFAULT_RUNTIME_FEATURES: RuntimeFeatures = {
  esbuild: true,
  swc: true,
  sql: false,
}

export function resolveRuntimeFeatures(
  input: Partial<RuntimeFeatures> | undefined,
): RuntimeFeatures {
  return {
    ...DEFAULT_RUNTIME_FEATURES,
    ...input,
  }
}

export function registerRuntimeFeatureHooks(
  hooks: HookRegistry,
  features: RuntimeFeatures,
): void {
  hooks.on("features.load.start", "runtime.feature.esbuild", async () => {
    if (!features.esbuild) return
    await preloadEsbuildWasm()
  }, 10)

  hooks.on("features.load.start", "runtime.feature.swc", async () => {
    setSwcWasmEnabled(features.swc)
    if (!features.swc) return
    await preloadSwcWasm()
  }, 20)

  hooks.on("features.load.start", "runtime.feature.sql", async () => {
    if (!features.sql) return
    await preloadSQLiteWasm()
  }, 30)
}
