import type { ModuleNamespace } from "./module-record"

export type EsmRequire = (specifier: string) => unknown
export type EsmDynamicImport = (specifier: string) => Promise<unknown>

export async function evaluateEsmModule(
  path: string,
  code: string,
  require: EsmRequire,
  dynamicImport: EsmDynamicImport,
  namespace: ModuleNamespace = {},
): Promise<ModuleNamespace> {
  void path
  const evaluator = new Function(
    "exports",
    "require",
    "__mars_dynamic_import",
    `${code}\n\nreturn exports`,
  )
  const result = evaluator(namespace, require, dynamicImport)

  if (result === namespace) return namespace

  if (result && typeof result === "object") {
    Object.assign(namespace, result)
    return namespace
  }

  namespace.default = result
  return namespace
}
