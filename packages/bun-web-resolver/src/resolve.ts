/**
 * bun-web-resolver: resolve.ts
 *
 * Node.js-compatible module resolution for bun-in-browser environments.
 * Supports:
 *  - Relative / absolute specifiers
 *  - Bare package specifiers with node_modules walk-up
 *  - package.json `exports` field (conditional exports, subpath patterns)
 *  - package.json `imports` field (#-prefixed internal specifiers)
 *  - Extension fallback and directory index resolution
 */

export interface ResolverFs {
  existsSync(path: string): boolean
  readFileSync(path: string): string | null
}

export interface ResolveOptions {
  /** Condition names, in priority order. Defaults to ['browser', 'import', 'default'] */
  conditions?: string[]
  /** Extension search order for extensionless imports. Defaults to ['.ts','.tsx','.js','.jsx','.json'] */
  extensions?: string[]
  /** Filesystem abstraction (defaults to a no-op that always returns null/false) */
  fs?: ResolverFs
}

interface PackageJson {
  name?: string
  main?: string
  module?: string
  exports?: ExportsField
  imports?: ImportsField
  [key: string]: unknown
}

interface ExportsObject {
  [key: string]: ExportsValue | undefined
}

type ExportsValue = string | ExportsObject | ExportsValue[] | null
type ExportsField = string | ExportsObject
type ImportsField = Record<string, ExportsValue>

const DEFAULT_CONDITIONS = ['browser', 'import', 'default']
const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json']

const NULL_FS: ResolverFs = {
  existsSync: () => false,
  readFileSync: () => null,
}

// ────────────────────────────────────────────────────────────────────────────
// POSIX path helpers (no dependency on node:path)
// ────────────────────────────────────────────────────────────────────────────

function posixDirname(p: string): string {
  const idx = p.lastIndexOf('/')
  if (idx <= 0) return '/'
  return p.slice(0, idx)
}

function posixJoin(...parts: string[]): string {
  return posixNormalize(parts.join('/'))
}

function posixNormalize(p: string): string {
  const abs = p.startsWith('/')
  const segments = p.split('/').filter(Boolean)
  const resolved: string[] = []
  for (const seg of segments) {
    if (seg === '..') {
      resolved.pop()
    } else if (seg !== '.') {
      resolved.push(seg)
    }
  }
  return (abs ? '/' : '') + resolved.join('/') || '/'
}

function posixResolve(base: string, rel: string): string {
  if (rel.startsWith('/')) return posixNormalize(rel)
  return posixNormalize(posixJoin(posixDirname(base), rel))
}

// ────────────────────────────────────────────────────────────────────────────
// Package name extraction
// ────────────────────────────────────────────────────────────────────────────

function parsePackageSpecifier(specifier: string): { name: string; subpath: string } {
  const isScoped = specifier.startsWith('@')
  const parts = specifier.split('/')
  const name = isScoped ? `${parts[0]}/${parts[1]}` : parts[0]
  const rest = isScoped ? parts.slice(2) : parts.slice(1)
  const subpath = rest.length > 0 ? `./${rest.join('/')}` : '.'
  return { name, subpath }
}

// ────────────────────────────────────────────────────────────────────────────
// package.json helpers
// ────────────────────────────────────────────────────────────────────────────

function readPackageJson(dir: string, fs: ResolverFs): PackageJson | null {
  const content = fs.readFileSync(posixJoin(dir, 'package.json'))
  if (!content) return null
  try {
    return JSON.parse(content) as PackageJson
  } catch {
    return null
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Exports / imports field resolution
// (implements Node.js PACKAGE_EXPORTS_RESOLVE algorithm)
// ────────────────────────────────────────────────────────────────────────────

function resolveCondition(value: ExportsValue | undefined, conditions: string[]): string | null {
  if (value === null) return null
  if (value === undefined) return null
  if (typeof value === 'string') return value

  if (Array.isArray(value)) {
    for (const item of value) {
      const result = resolveCondition(item, conditions)
      if (result !== null) return result
    }
    return null
  }

  // Object: try each condition in priority order
  if (typeof value === 'object') {
    for (const cond of conditions) {
      if (cond in value) {
        const result = resolveCondition(value[cond], conditions)
        if (result !== null) return result
      }
    }
    // Try 'default' last if not already in conditions
    if (!conditions.includes('default') && 'default' in value) {
      const result = resolveCondition(value['default'], conditions)
      if (result !== null) return result
    }
  }

  return null
}

/**
 * Resolve a subpath against an `exports` field.
 * @param exports - the package.json `exports` value
 * @param subpath - e.g. "." or "./utils"
 * @param conditions - active condition names
 * @returns a relative path string like "./dist/index.js", or null
 */
export function resolveExports(
  exports: ExportsField,
  subpath: string,
  conditions: string[],
): string | null {
  // Shorthand: exports is a string or conditions object — only valid for "."
  if (typeof exports === 'string') {
    if (subpath === '.') return exports
    return null
  }

  if (typeof exports === 'object' && !Array.isArray(exports)) {
    // Determine if exports is a conditions map (all keys are conditions) or a subpath map
    const keys = Object.keys(exports)
    const isConditionsMap = keys.length > 0 && !keys[0].startsWith('.')

    if (isConditionsMap) {
      // Treat as conditions map for "."
      if (subpath === '.') {
        return resolveCondition(exports as ExportsObject, conditions)
      }
      return null
    }

    // Subpath map: try exact match first, then pattern match
    const exactValue = (exports as Record<string, ExportsValue>)[subpath]
    if (exactValue !== undefined) {
      return resolveCondition(exactValue, conditions)
    }

    // Pattern matching: keys with '*'
    for (const key of keys) {
      if (!key.includes('*')) continue
      const [prefix, suffix] = key.split('*', 2)
      if (subpath.startsWith(prefix) && subpath.endsWith(suffix ?? '')) {
        const patternMatch = subpath.slice(prefix.length, subpath.length - (suffix?.length ?? 0))
        const value = (exports as Record<string, ExportsValue>)[key]
        const resolved = resolveCondition(value, conditions)
        if (resolved !== null) {
          return resolved.replace(/\*/g, patternMatch)
        }
      }
    }
  }

  return null
}

/**
 * Resolve a `#`-prefixed import specifier against an `imports` field.
 */
export function resolveImports(
  imports: ImportsField,
  specifier: string,
  conditions: string[],
): string | null {
  const exact = imports[specifier]
  if (exact !== undefined) {
    return resolveCondition(exact, conditions)
  }

  // Pattern matching
  for (const key of Object.keys(imports)) {
    if (!key.includes('*')) continue
    const [prefix, suffix] = key.split('*', 2)
    if (specifier.startsWith(prefix) && specifier.endsWith(suffix ?? '')) {
      const patternMatch = specifier.slice(prefix.length, specifier.length - (suffix?.length ?? 0))
      const resolved = resolveCondition(imports[key], conditions)
      if (resolved !== null) {
        return resolved.replace(/\*/g, patternMatch)
      }
    }
  }

  return null
}

// ────────────────────────────────────────────────────────────────────────────
// File existence helpers
// ────────────────────────────────────────────────────────────────────────────

function tryFile(path: string, fs: ResolverFs): string | null {
  return fs.existsSync(path) ? path : null
}

function tryExtensions(base: string, extensions: string[], fs: ResolverFs): string | null {
  for (const ext of extensions) {
    const candidate = base + ext
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function tryDirectoryIndex(dir: string, extensions: string[], fs: ResolverFs): string | null {
  return tryExtensions(posixJoin(dir, 'index'), extensions, fs)
}

function resolveFilePath(
  path: string,
  extensions: string[],
  fs: ResolverFs,
): string | null {
  // Exact match
  const exact = tryFile(path, fs)
  if (exact) return exact

  // With extension fallback
  const withExt = tryExtensions(path, extensions, fs)
  if (withExt) return withExt

  // Directory index
  return tryDirectoryIndex(path, extensions, fs)
}

// ────────────────────────────────────────────────────────────────────────────
// node_modules walk-up
// ────────────────────────────────────────────────────────────────────────────

function* walkNodeModules(fromFile: string): Generator<string> {
  let dir = posixDirname(fromFile)
  const seen = new Set<string>()
  while (!seen.has(dir)) {
    seen.add(dir)
    yield posixJoin(dir, 'node_modules')
    const parent = posixDirname(dir)
    if (parent === dir) break
    dir = parent
  }
}

function resolvePackage(
  name: string,
  subpath: string,
  fromFile: string,
  conditions: string[],
  extensions: string[],
  fs: ResolverFs,
): string | null {
  for (const nmDir of walkNodeModules(fromFile)) {
    const pkgDir = posixJoin(nmDir, name)
    const pkgJson = readPackageJson(pkgDir, fs)

    if (!pkgJson && !fs.existsSync(pkgDir)) continue

    // Try exports field first
    if (pkgJson?.exports !== undefined) {
      const exportResolved = resolveExports(pkgJson.exports, subpath, conditions)
      if (exportResolved !== null) {
        const absolute = posixResolve(posixJoin(pkgDir, 'package.json'), exportResolved)
        return resolveFilePath(absolute, extensions, fs)
      }
      // If exports exists but doesn't match the subpath, it's an error per Node spec
      return null
    }

    // No exports field: fall back to main/module for ".", or direct subpath
    if (subpath === '.') {
      const mainField = pkgJson?.module ?? pkgJson?.main
      if (mainField) {
        const absolute = posixJoin(pkgDir, mainField)
        const resolved = resolveFilePath(absolute, extensions, fs)
        if (resolved) return resolved
      }
      // Try package directory index
      return tryDirectoryIndex(pkgDir, extensions, fs)
    }

    // Subpath without exports: direct file access
    const absolute = posixJoin(pkgDir, subpath)
    return resolveFilePath(absolute, extensions, fs)
  }

  return null
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a module specifier to an absolute path.
 *
 * @param specifier - The import specifier (relative, absolute, bare, or `#`-prefixed)
 * @param fromFile  - Absolute path of the importing file
 * @param options   - Optional resolver configuration
 * @returns Resolved absolute path, or `null` if not found
 */
export function resolve(
  specifier: string,
  fromFile: string,
  options: ResolveOptions = {},
): string | null {
  const fs = options.fs ?? NULL_FS
  const conditions = options.conditions ?? DEFAULT_CONDITIONS
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS

  // Relative or absolute specifier
  if (specifier.startsWith('/') || specifier.startsWith('./') || specifier.startsWith('../')) {
    const absolute = posixResolve(fromFile, specifier)
    return resolveFilePath(absolute, extensions, fs)
  }

  // `#`-prefixed imports field specifier
  if (specifier.startsWith('#')) {
    // Walk up to find the enclosing package.json
    let dir = posixDirname(fromFile)
    const seen = new Set<string>()
    while (!seen.has(dir)) {
      seen.add(dir)
      const pkgJson = readPackageJson(dir, fs)
      if (pkgJson?.imports) {
        const rel = resolveImports(pkgJson.imports, specifier, conditions)
        if (rel !== null) {
          const absolute = posixResolve(posixJoin(dir, 'package.json'), rel)
          return resolveFilePath(absolute, extensions, fs)
        }
      }
      const parent = posixDirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  }

  // Bare package specifier
  const { name, subpath } = parsePackageSpecifier(specifier)
  return resolvePackage(name, subpath, fromFile, conditions, extensions, fs)
}
