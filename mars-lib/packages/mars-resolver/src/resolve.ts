import { basename, dirname, normalizePath } from "@mars/vfs"

import { resolveExports, resolveImports } from "./exports"
import { parsePackageJson, pickBrowserMapTarget, pickPackageEntry } from "./package-json"
import { createTsconfigPathResolver } from "./tsconfig-paths"

import type { ResolveOptions } from "./types"

const defaultExtensions = [".ts", ".tsx", ".js", ".jsx", ".json"]
const defaultConditions = ["browser", "import", "default"]

class EmptyResolverFileSystem {
  existsSync(path: string): boolean {
    void path
    return false
  }

  readFileSync(path: string): string | null {
    void path
    return null
  }
}

export function resolve(
  specifier: string,
  importingFile: string,
  options: ResolveOptions = {},
): string | null {
  const fileSystem = options.fileSystem ?? new EmptyResolverFileSystem()
  const conditions = options.conditions ?? defaultConditions
  const extensions = options.extensions ?? defaultExtensions

  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
    return resolvePathLikeSpecifier(specifier, importingFile, extensions, fileSystem)
  }

  if (specifier.startsWith("#")) {
    return resolveImportSpecifier(specifier, importingFile, conditions, extensions, fileSystem)
  }

  const tsconfigPath = resolveTsconfigPathSpecifier(
    specifier,
    extensions,
    fileSystem,
    options.tsconfigPaths,
  )
  if (tsconfigPath) return tsconfigPath

  return resolvePackageSpecifier(specifier, importingFile, conditions, extensions, fileSystem)
}

function resolveTsconfigPathSpecifier(
  specifier: string,
  extensions: string[],
  fileSystem: ResolveOptions["fileSystem"],
  tsconfigPaths: ResolveOptions["tsconfigPaths"],
): string | null {
  if (!tsconfigPaths) return null

  const pathResolver = createTsconfigPathResolver(tsconfigPaths)
  const candidates = pathResolver.resolve(specifier)

  if (tsconfigPaths.baseUrl) {
    candidates.push(normalizePath(specifier, tsconfigPaths.baseUrl))
  }

  for (const candidate of candidates) {
    const resolvedPath = resolveWithExtensions(candidate, extensions, fileSystem)
    if (resolvedPath) return resolvedPath
  }

  return null
}

function resolvePathLikeSpecifier(
  specifier: string,
  importingFile: string,
  extensions: string[],
  fileSystem: ResolveOptions["fileSystem"],
): string | null {
  const baseDirectory = dirname(importingFile)
  const candidatePath = specifier.startsWith("/")
    ? normalizePath(specifier)
    : normalizePath(specifier, baseDirectory)

  return resolveWithExtensions(candidatePath, extensions, fileSystem)
}

function resolvePackageSpecifier(
  specifier: string,
  importingFile: string,
  conditions: string[],
  extensions: string[],
  fileSystem: ResolveOptions["fileSystem"],
): string | null {
  const parsedSpecifier = parsePackageSpecifier(specifier)
  let cursor = dirname(importingFile)

  while (true) {
    const packageDirectory = normalizePath(`node_modules/${parsedSpecifier.packageName}`, cursor)
    const packageJsonPath = normalizePath("package.json", packageDirectory)
    const packageJsonContent = fileSystem?.readFileSync(packageJsonPath) ?? null
    const packageJson = parsePackageJson(packageJsonContent)

    if (packageJson) {
      const exportedPath = resolveExports(
        packageJson.exports,
        parsedSpecifier.subpath,
        conditions,
      )
      if (exportedPath) {
        const browserTarget = pickBrowserMapTarget(packageJson, exportedPath)
          ?? pickBrowserMapTarget(packageJson, parsedSpecifier.subpath)
        if (browserTarget === false) return null

        const resolvedExport = resolveWithExtensions(
          normalizePath(browserTarget ?? exportedPath, packageDirectory),
          extensions,
          fileSystem,
        )
        if (resolvedExport) return resolvedExport
      }

      if (parsedSpecifier.subpath !== ".") {
        const browserTarget = pickBrowserMapTarget(packageJson, parsedSpecifier.subpath)
        if (browserTarget === false) return null

        const resolvedSubpath = resolveWithExtensions(
          normalizePath((browserTarget ?? parsedSpecifier.subpath).replace(/^\.\//, ""), packageDirectory),
          extensions,
          fileSystem,
        )
        if (resolvedSubpath) return resolvedSubpath
      }

      const packageEntry = pickPackageEntry(packageJson, conditions)
      if (packageEntry) {
        const browserTarget = pickBrowserMapTarget(packageJson, packageEntry)
        if (browserTarget === false) return null

        const resolvedEntry = resolveWithExtensions(
          normalizePath(browserTarget ?? packageEntry, packageDirectory),
          extensions,
          fileSystem,
        )
        if (resolvedEntry) return resolvedEntry
      }

      const fallbackIndex = resolveWithExtensions(
        normalizePath("index", packageDirectory),
        extensions,
        fileSystem,
      )
      if (fallbackIndex) return fallbackIndex
    }

    if (cursor === "/") break
    cursor = dirname(cursor)
  }

  return null
}

function resolveImportSpecifier(
  specifier: string,
  importingFile: string,
  conditions: string[],
  extensions: string[],
  fileSystem: ResolveOptions["fileSystem"],
): string | null {
  let cursor = dirname(importingFile)

  while (true) {
    const packageJsonPath = normalizePath("package.json", cursor)
    const packageJsonContent = fileSystem?.readFileSync(packageJsonPath) ?? null
    const packageJson = parsePackageJson(packageJsonContent)
    const importedPath = resolveImports(packageJson?.imports, specifier, conditions)

    if (importedPath) {
      return resolveWithExtensions(normalizePath(importedPath, cursor), extensions, fileSystem)
    }

    if (cursor === "/") break
    cursor = dirname(cursor)
  }

  return null
}

function parsePackageSpecifier(specifier: string): { packageName: string; subpath: string } {
  const parts = specifier.split("/")
  const packageName = specifier.startsWith("@")
    ? `${parts[0]}/${parts[1]}`
    : parts[0]
  const subpathParts = parts.slice(packageName.startsWith("@") ? 2 : 1)

  return {
    packageName,
    subpath: subpathParts.length ? `./${subpathParts.join("/")}` : ".",
  }
}

function resolveWithExtensions(
  candidatePath: string,
  extensions: string[],
  fileSystem: ResolveOptions["fileSystem"],
): string | null {
  if (fileSystem?.existsSync(candidatePath)) return candidatePath

  for (const extension of extensions) {
    const extensionCandidate = `${candidatePath}${extension}`
    if (fileSystem?.existsSync(extensionCandidate)) return extensionCandidate
  }

  const directoryIndexBase = normalizePath("index", candidatePath)
  for (const extension of extensions) {
    const directoryIndexCandidate = `${directoryIndexBase}${extension}`
    if (fileSystem?.existsSync(directoryIndexCandidate)) return directoryIndexCandidate
  }

  return null
}

export function inferModuleFormat(path: string): "esm" | "cjs" | "json" | "wasm" | "asset" {
  if (path.endsWith(".json")) return "json"
  if (path.endsWith(".wasm")) return "wasm"
  if (path.endsWith(".cjs")) return "cjs"
  if (path.endsWith(".mjs")) return "esm"
  if (path.endsWith(".js") || path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".jsx")) {
    return "esm"
  }

  void basename
  return "asset"
}
