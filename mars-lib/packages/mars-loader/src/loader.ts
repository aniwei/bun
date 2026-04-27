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
  transpiler?: Transpiler
  resolveOptions?: ResolveOptions
}

class MarsModuleLoader implements ModuleLoader {
  readonly #vfs: MarsVFS
  readonly #transpiler: Transpiler
  readonly #resolveOptions?: ResolveOptions
  readonly #records = new Map<string, ModuleRecord>()

  constructor(options: ModuleLoaderOptions) {
    this.#vfs = options.vfs
    this.#transpiler = options.transpiler ?? createTranspiler()
    this.#resolveOptions = options.resolveOptions
  }

  async import(specifier: string, parentUrl = "/workspace/index.ts"): Promise<unknown> {
    const loadedModule = await this.#load(specifier, parentUrl)
    const cachedRecord = this.#records.get(loadedModule.path)
    if (cachedRecord) return cachedRecord.namespace

    const namespace = await this.evaluateModule(loadedModule)

    this.#records.set(loadedModule.path, {
      path: loadedModule.path,
      namespace,
      loadedModule,
    })

    return namespace
  }

  require(specifier: string, parentPath: string): unknown {
    const resolvedPath = this.#resolve(specifier, parentPath)
    if (!resolvedPath) throw new Error(`Cannot resolve module: ${specifier}`)

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

    const transformedCode = moduleFormat === "cjs"
      ? sourceCode
      : transformSourceCode(sourceCode, inferSourceLoader(resolvedPath))
    const namespace = evaluateCommonJsModule(
      resolvedPath,
      transformedCode,
      childSpecifier => this.require(childSpecifier, resolvedPath),
    )

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

    return namespace.default ?? namespace
  }

  async evaluateModule(module: LoadedModule): Promise<ModuleNamespace> {
    if (module.format === "cjs") {
      return evaluateCommonJsModule(
        module.path,
        module.transformed.code,
        specifier => this.require(specifier, module.path),
      )
    }

    if (module.format === "json") {
      const jsonValue = JSON.parse(module.sourceCode)
      return { default: jsonValue }
    }

    return evaluateEsmModule(
      module.path,
      module.transformed.code,
      specifier => this.require(specifier, module.path),
      specifier => this.import(specifier, module.path),
    )
  }

  invalidate(path: string): void {
    this.#records.delete(normalizePath(path))
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

  #readText(path: string): string {
    return String(this.#vfs.readFileSync(path, "utf8"))
  }
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
