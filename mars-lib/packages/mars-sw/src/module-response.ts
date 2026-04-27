import { resolve } from "@mars/resolver"
import { createTranspiler } from "@mars/transpiler"
import { normalizePath } from "@mars/vfs"

import type { ResolveOptions } from "@mars/resolver"
import type { Loader, Transpiler } from "@mars/transpiler"
import type { MarsVFS } from "@mars/vfs"

export interface ModuleResponseOptions {
  vfs: MarsVFS
  root?: string
  transpiler?: Transpiler
  resolveOptions?: ResolveOptions
  define?: Record<string, string>
  alias?: Record<string, string>
}

export async function createModuleResponse(
  url: string,
  options: ModuleResponseOptions,
): Promise<Response> {
  const root = options.root ?? "/workspace"
  const modulePath = modulePathFromUrl(url, root, options.alias)
  const resolvedPath = resolve(modulePath, normalizePath("index.ts", root), {
    ...options.resolveOptions,
    fileSystem: {
      existsSync: path => options.vfs.existsSync(path),
      readFileSync: path => options.vfs.existsSync(path)
        ? String(options.vfs.readFileSync(path, "utf8"))
        : null,
    },
  }) ?? modulePath

  if (!options.vfs.existsSync(resolvedPath)) {
    return new Response("Module not found", { status: 404 })
  }

  const sourceCode = String(await options.vfs.readFile(resolvedPath, "utf8"))
  const transpiler = options.transpiler ?? createTranspiler()
  const transformed = await transpiler.transform({
    path: resolvedPath,
    code: sourceCode,
    loader: inferLoader(resolvedPath),
    target: "browser",
    define: options.define,
  })

  return new Response(transformed.code, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "x-mars-module-path": resolvedPath,
      "x-mars-imports": JSON.stringify(transformed.imports.map(record => record.path)),
    },
  })
}

export function modulePathFromUrl(
  url: string,
  root = "/workspace",
  alias: Record<string, string> = {},
): string {
  const parsedUrl = new URL(url, "http://mars.localhost")
  const requestPath = decodeURIComponent(parsedUrl.pathname).replace(/^\/+/, "")
  const aliasedPath = resolveAliasPath(requestPath, alias)

  return aliasedPath ?? normalizePath(requestPath, root)
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