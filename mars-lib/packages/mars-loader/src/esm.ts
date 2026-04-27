import type { ModuleNamespace } from "./module-record"

export type EsmRequire = (specifier: string) => unknown
export type EsmDynamicImport = (specifier: string) => Promise<unknown>

export async function evaluateEsmModule(
  path: string,
  code: string,
  require: EsmRequire,
  dynamicImport: EsmDynamicImport,
): Promise<ModuleNamespace> {
  void path
  const evaluator = new Function(
    "exports",
    "require",
    "__mars_dynamic_import",
    `${code}\n\nreturn exports`,
  )
  const exportsObject: ModuleNamespace = {}
  const result = evaluator(exportsObject, require, dynamicImport)

  if (result && typeof result === "object") {
    return result as ModuleNamespace
  }

  return { default: result }
}
