import { inferModuleFormat, resolve } from "@mars/resolver"
import { createTranspiler, transformSourceCode } from "@mars/transpiler"
import { normalizePath } from "@mars/vfs"

import { evaluateCommonJsModule } from "./cjs"
import { evaluateEsmModule } from "./esm"

import type { ResolveOptions } from "@mars/resolver"
import type { Loader as SourceLoader, TransformInput, Transpiler } from "@mars/transpiler"
import type { MarsVFS } from "@mars/vfs"
import type { LoadedModule, ModuleNamespace, ModuleRecord } from "./module-record"

export interface ModuleLoader {
  import(specifier: string, parentUrl?: string): Promise<unknown>
  require(specifier: string, parentPath: string): unknown
  evaluateModule(module: LoadedModule): Promise<ModuleNamespace>
  invalidate(path: string): void
}

export interface ModuleLoaderOptions {
  vfs: MarsVFS
  coreModules?: Record<string, unknown>
  transpiler?: Transpiler
  resolveOptions?: ResolveOptions
}

class MarsModuleLoader implements ModuleLoader {
  readonly #vfs: MarsVFS
  readonly #coreModules: Record<string, unknown>
  readonly #transpiler: Transpiler
  readonly #resolveOptions?: ResolveOptions
  readonly #records = new Map<string, ModuleRecord>()
  readonly #importers = new Map<string, Set<string>>()

  constructor(options: ModuleLoaderOptions) {
    this.#vfs = options.vfs
    this.#coreModules = options.coreModules ?? {}
    this.#transpiler = options.transpiler ?? createTranspiler()
    this.#resolveOptions = options.resolveOptions
  }

  async import(specifier: string, parentUrl = "/workspace/index.ts"): Promise<unknown> {
    const coreModule = this.#resolveCoreModule(specifier)
    if (coreModule !== undefined) return namespaceForCoreModule(coreModule)

    const loadedModule = await this.#load(specifier, parentUrl)
    this.#trackImporter(parentUrl, loadedModule.path)
    const cachedRecord = this.#records.get(loadedModule.path)
    if (cachedRecord) return cachedRecord.namespace

    const namespace: ModuleNamespace = {}
    this.#records.set(loadedModule.path, {
      path: loadedModule.path,
      namespace,
      loadedModule,
    })

    await this.evaluateModule(loadedModule, namespace)

    return namespace
  }

  require(specifier: string, parentPath: string): unknown {
    const coreModule = this.#resolveCoreModule(specifier)
    if (coreModule !== undefined) return coreModule

    const resolvedPath = this.#resolve(specifier, parentPath)
    if (!resolvedPath) throw new Error(`Cannot resolve module: ${specifier}`)
    this.#trackImporter(parentPath, resolvedPath)

    const cachedRecord = this.#records.get(resolvedPath)
    if (cachedRecord) return cachedRecord.namespace.default ?? cachedRecord.namespace

    const sourceCode = this.#readText(resolvedPath)
    const moduleFormat = inferModuleFormat(resolvedPath)
    if (moduleFormat === "json") {
      const jsonValue = JSON.parse(sourceCode)
      const namespace = { default: jsonValue }

      this.#records.set(resolvedPath, {
        path: resolvedPath,
        namespace,
        loadedModule: {
          path: resolvedPath,
          format: moduleFormat,
          sourceCode,
          transformed: {
            code: sourceCode,
            imports: [],
            diagnostics: [],
          },
        },
      })

      return jsonValue
    }

    const transformedCode = moduleFormat === "cjs" || resolvedPath.endsWith(".js")
      ? sourceCode
      : transformSourceCode(sourceCode, inferSourceLoader(resolvedPath))
    const namespace: ModuleNamespace = {}
    this.#records.set(resolvedPath, {
      path: resolvedPath,
      namespace,
      loadedModule: {
        path: resolvedPath,
        format: moduleFormat,
        sourceCode,
        transformed: {
          code: transformedCode,
          imports: [],
          diagnostics: [],
        },
      },
    })

    evaluateCommonJsModule(
      resolvedPath,
      transformedCode,
      childSpecifier => this.require(childSpecifier, resolvedPath),
      namespace,
    )

    return namespace.default ?? namespace
  }

  async evaluateModule(module: LoadedModule, namespace: ModuleNamespace = {}): Promise<ModuleNamespace> {
    if (module.format === "cjs") {
      return evaluateCommonJsModule(
        module.path,
        module.transformed.code,
        specifier => this.require(specifier, module.path),
        namespace,
      )
    }

    if (module.format === "json") {
      const jsonValue = JSON.parse(module.sourceCode)
      namespace.default = jsonValue
      return namespace
    }

    return evaluateEsmModule(
      module.path,
      module.transformed.code,
      specifier => this.require(specifier, module.path),
      specifier => this.import(specifier, module.path),
      namespace,
    )
  }

  invalidate(path: string): void {
    this.#invalidateRecord(normalizePath(path), new Set())
  }

  #trackImporter(parentPath: string, childPath: string): void {
    const normalizedParent = normalizePath(parentPath)
    const normalizedChild = normalizePath(childPath)
    if (normalizedParent === normalizedChild) return
    if (!this.#records.has(normalizedParent)) return

    const importers = this.#importers.get(normalizedChild) ?? new Set<string>()
    importers.add(normalizedParent)
    this.#importers.set(normalizedChild, importers)
  }

  #invalidateRecord(path: string, visited: Set<string>): void {
    if (visited.has(path)) return
    visited.add(path)

    const importers = this.#importers.get(path) ?? new Set<string>()
    this.#records.delete(path)
    this.#importers.delete(path)

    for (const importerPath of importers) {
      this.#invalidateRecord(importerPath, visited)
    }

    for (const importerSet of this.#importers.values()) {
      importerSet.delete(path)
    }
  }

  async #load(specifier: string, parentPath: string): Promise<LoadedModule> {
    const resolvedPath = this.#resolve(specifier, parentPath)
    if (!resolvedPath) throw new Error(`Cannot resolve module: ${specifier}`)

    const sourceCode = this.#readText(resolvedPath)
    const sourceLoader = inferSourceLoader(resolvedPath)
    const transformed = await this.#transpiler.transform({
      path: resolvedPath,
      code: sourceCode,
      loader: sourceLoader,
      target: "browser",
    } satisfies TransformInput)

    return {
      path: resolvedPath,
      format: inferModuleFormat(resolvedPath),
      sourceCode,
      transformed,
    }
  }

  #resolve(specifier: string, parentPath: string): string | null {
    return resolve(specifier, parentPath, {
      ...this.#resolveOptions,
      fileSystem: {
        existsSync: path => this.#vfs.existsSync(path),
        readFileSync: path => this.#vfs.existsSync(path)
          ? String(this.#vfs.readFileSync(path, "utf8"))
          : null,
      },
    })
  }

  #resolveCoreModule(specifier: string): unknown {
    if (Object.prototype.hasOwnProperty.call(this.#coreModules, specifier)) {
      return this.#coreModules[specifier]
    }

    return undefined
  }

  #readText(path: string): string {
    return String(this.#vfs.readFileSync(path, "utf8"))
  }
}

function namespaceForCoreModule(coreModule: unknown): unknown {
  if (!coreModule || typeof coreModule !== "object") return { default: coreModule }

  const namespace = { ...(coreModule as Record<string, unknown>) }
  if (!("default" in namespace)) namespace.default = coreModule
  return namespace
}

export function createModuleLoader(options: ModuleLoaderOptions): ModuleLoader {
  return new MarsModuleLoader(options)
}

function inferSourceLoader(path: string): SourceLoader {
  if (path.endsWith(".tsx")) return "tsx"
  if (path.endsWith(".ts")) return "ts"
  if (path.endsWith(".jsx")) return "jsx"
  if (path.endsWith(".json")) return "json"

  return "js"
}
