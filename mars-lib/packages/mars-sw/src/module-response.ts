import { resolve } from "@mars/resolver"
import { createTranspiler } from "@mars/transpiler"
import { normalizePath } from "@mars/vfs"

import type { ResolveOptions } from "@mars/resolver"
import type { ImportRecord, Loader, Transpiler } from "@mars/transpiler"
import type { MarsVFS } from "@mars/vfs"

export interface ModuleResponseOptions {
  vfs: MarsVFS
  root?: string
  transpiler?: Transpiler
  resolveOptions?: ResolveOptions
  define?: Record<string, string>
  alias?: Record<string, string>
  format?: "commonjs" | "esm"
}

interface ResolvedModuleImport extends ImportRecord {
  resolvedPath: string
  url: string
}

export async function createModuleResponse(
  url: string,
  options: ModuleResponseOptions,
): Promise<Response> {
  const root = options.root ?? "/workspace"
  const modulePath = modulePathFromUrl(url, root, options.alias)
  const resolveOptions = createModuleResolveOptions(options)
  const resolvedPath = resolve(modulePath, normalizePath("index.ts", root), resolveOptions) ?? modulePath

  if (!options.vfs.existsSync(resolvedPath)) {
    return new Response("Module not found", { status: 404 })
  }

  const sourceCode = String(await options.vfs.readFile(resolvedPath, "utf8"))
  const transpiler = options.transpiler ?? createTranspiler()
  const loader = inferLoader(resolvedPath)
  const format = options.format ?? "commonjs"
  const transformed = await transpiler.transform({
    path: resolvedPath,
    code: sourceCode,
    loader,
    target: "browser",
    format,
    define: options.define,
  })
  const resolvedImports = resolveModuleImports(transformed.imports, resolvedPath, resolveOptions)
  const code = format === "esm"
    ? rewriteModuleImportSpecifiers(transformed.code, resolvedImports)
    : transformed.code

  return new Response(code, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "x-mars-module-path": resolvedPath,
      "x-mars-imports": JSON.stringify(resolvedImports.map(record => record.resolvedPath)),
      "x-mars-module-urls": JSON.stringify(resolvedImports.map(record => record.url)),
    },
  })
}

export function modulePathFromUrl(
  url: string,
  root = "/workspace",
  alias: Record<string, string> = {},
): string {
  const parsedUrl = new URL(url, "http://mars.localhost")
  const pathParam = parsedUrl.searchParams.get("path")
  if (pathParam) return normalizePath(pathParam)

  const moduleRequestPath = parsedUrl.pathname.startsWith("/__mars__/module/")
    ? parsedUrl.pathname.slice("/__mars__/module/".length)
    : parsedUrl.pathname
  const requestPath = decodeURIComponent(moduleRequestPath).replace(/^\/+/, "")
  const aliasedPath = resolveAliasPath(requestPath, alias)

  return aliasedPath ?? normalizePath(requestPath, root)
}

export function moduleUrlFromPath(path: string): string {
  return `/__mars__/module?path=${encodeURIComponent(normalizePath(path))}`
}

function createModuleResolveOptions(options: ModuleResponseOptions): ResolveOptions {
  return {
    ...options.resolveOptions,
    fileSystem: {
      existsSync: path => options.vfs.existsSync(path),
      readFileSync: path => options.vfs.existsSync(path)
        ? String(options.vfs.readFileSync(path, "utf8"))
        : null,
    },
  }
}

function resolveModuleImports(
  imports: ImportRecord[],
  resolvedPath: string,
  resolveOptions: ResolveOptions,
): ResolvedModuleImport[] {
  const resolvedImports: ResolvedModuleImport[] = []
  const seen = new Set<string>()

  for (const importRecord of imports) {
    const importedPath = resolve(importRecord.path, resolvedPath, resolveOptions)
    if (!importedPath) continue

    const key = `${importRecord.path}:${importedPath}`
    if (seen.has(key)) continue
    seen.add(key)

    resolvedImports.push({
      ...importRecord,
      resolvedPath: importedPath,
      url: moduleUrlFromPath(importedPath),
    })
  }

  return resolvedImports
}

function rewriteModuleImportSpecifiers(
  code: string,
  imports: ResolvedModuleImport[],
): string {
  let rewrittenCode = code
  const importsBySpecifier = new Map<string, string>()

  for (const importRecord of imports) {
    importsBySpecifier.set(importRecord.path, importRecord.url)
  }

  const replaceSpecifier = (specifier: string) => importsBySpecifier.get(specifier) ?? specifier

  rewrittenCode = rewrittenCode.replace(
    /(from\s*["'])([^"']+)(["'])/g,
    (_source, prefix: string, specifier: string, suffix: string) => {
      return `${prefix}${replaceSpecifier(specifier)}${suffix}`
    },
  )

  rewrittenCode = rewrittenCode.replace(
    /(import\s*["'])([^"']+)(["'])/g,
    (_source, prefix: string, specifier: string, suffix: string) => {
      return `${prefix}${replaceSpecifier(specifier)}${suffix}`
    },
  )

  return rewrittenCode.replace(
    /(import\(\s*["'])([^"']+)(["']\s*\))/g,
    (_source, prefix: string, specifier: string, suffix: string) => {
      return `${prefix}${replaceSpecifier(specifier)}${suffix}`
    },
  )
}

function resolveAliasPath(
  requestPath: string,
  alias: Record<string, string>,
): string | null {
  const orderedAliases = Object.entries(alias)
    .sort(([left], [right]) => right.length - left.length)

  for (const [aliasName, replacement] of orderedAliases) {
    if (requestPath === aliasName) return normalizePath(replacement)
    if (!requestPath.startsWith(`${aliasName}/`)) continue

    return normalizePath(requestPath.slice(aliasName.length + 1), replacement)
  }

  return null
}

function inferLoader(path: string): Loader {
  if (path.endsWith(".tsx")) return "tsx"
  if (path.endsWith(".ts")) return "ts"
  if (path.endsWith(".jsx")) return "jsx"
  if (path.endsWith(".json")) return "json"

  return "js"
}