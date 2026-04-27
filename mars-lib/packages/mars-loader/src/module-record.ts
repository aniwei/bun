import type { TransformResult } from "@mars/transpiler"

export type ModuleFormat = "esm" | "cjs" | "json" | "wasm" | "asset"

export interface LoadedModule {
  path: string
  format: ModuleFormat
  sourceCode: string
  transformed: TransformResult
}

export type ModuleNamespace = Record<string, unknown>

export interface ModuleRecord {
  path: string
  namespace: ModuleNamespace
  loadedModule: LoadedModule
}
