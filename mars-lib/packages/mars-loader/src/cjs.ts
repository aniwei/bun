import { dirname } from "@mars/vfs"

import type { ModuleNamespace } from "./module-record"

export type CommonJsRequire = (specifier: string) => unknown

export function evaluateCommonJsModule(
  path: string,
  code: string,
  require: CommonJsRequire,
  namespace: ModuleNamespace = {},
): ModuleNamespace {
  const module = { exports: namespace as Record<string, unknown> }
  const exportsReference = module.exports

  const evaluator = new Function("exports", "module", "require", "__filename", "__dirname", code)
  evaluator(exportsReference, module, require, path, dirname(path))

  if (module.exports === namespace) return namespace

  if (module.exports && typeof module.exports === "object") {
    Object.defineProperties(namespace, Object.getOwnPropertyDescriptors(module.exports))
    namespace.default = module.exports
    return namespace
  }

  namespace.default = module.exports
  return namespace
}
