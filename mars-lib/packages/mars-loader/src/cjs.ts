import type { ModuleNamespace } from "./module-record"

export type CommonJsRequire = (specifier: string) => unknown

export function evaluateCommonJsModule(
  path: string,
  code: string,
  require: CommonJsRequire,
): ModuleNamespace {
  const module = { exports: {} as Record<string, unknown> }
  const exportsReference = module.exports

  const evaluator = new Function("exports", "module", "require", "__filename", "__dirname", code)
  evaluator(exportsReference, module, require, path, "/")

  if (module.exports && typeof module.exports === "object") {
    return {
      default: module.exports,
      ...module.exports,
    }
  }

  return {
    default: module.exports,
  }
}
