import eventsModule, {
  Duplex,
  EventEmitter,
  PassThrough,
  Readable,
  Stream,
  Transform,
  Writable,
  captureRejectionSymbol,
  getEventListeners,
  getMaxListeners,
  once,
  setMaxListeners,
} from './events-stream'
import path from './path'
import streamPromises, { finished, pipeline } from './stream-promises'
import { createNodeFs } from './fs'
import { createProcess } from './process'
import {
  StringDecoder,
  URL,
  URLSearchParams,
  formatURL,
  parseQueryString,
  parseURL,
  querystring,
  resolveURL,
  stringifyQueryString,
} from './url'
import { fileURLToPath, pathToFileURL } from './url'
import { Buffer } from './buffer'
import { VFS } from '@mars/web-vfs'
import { resolve as resolveSpecifier } from '@mars/web-resolver'

export type RequireFunction = ((specifier: string) => unknown) & {
  resolve(specifier: string): string
  cache: Record<string, unknown>
  register(specifier: string, exportsValue: unknown): void
}

const builtinSpecifiers = new Set<string>([
  'fs',
  'path',
  'url',
  'querystring',
  'string_decoder',
  'events',
  'stream',
  'stream/web',
  'stream/promises',
  'process',
  'module',
  'node:fs',
  'node:path',
  'node:url',
  'node:querystring',
  'node:string_decoder',
  'node:events',
  'node:stream',
  'node:stream/web',
  'node:stream/promises',
  'node:process',
  'node:module',
  'buffer',
  'node:buffer',
])

/** Node.js-compatible list of builtin module names (bare form) */
export const builtinModulesList: string[] = [
  'fs',
  'path',
  'url',
  'querystring',
  'string_decoder',
  'events',
  'stream',
  'buffer',
  'process',
  'module',
]

const _defaultVfs = new VFS()

const builtinModules: Record<string, unknown> = {
  'node:fs': createNodeFs(_defaultVfs),
  'node:path': path,
  'node:url': {
    URL,
    URLSearchParams,
    fileURLToPath,
    pathToFileURL,
    parseURL,
    formatURL,
    resolveURL,
    parseQueryString,
    stringifyQueryString,
    querystring,
    StringDecoder,
  },
  'node:querystring': querystring,
  'node:string_decoder': { StringDecoder },
  'node:events': Object.assign(eventsModule, {
    EventEmitter,
    captureRejectionSymbol,
    getEventListeners,
    getMaxListeners,
    once,
    setMaxListeners,
  }),
  'node:stream': {
    default: Stream,
    Duplex,
    EventEmitter,
    PassThrough,
    Readable,
    Stream,
    Transform,
    Writable,
  },
  'node:stream/web': {
    ReadableStream: globalThis.ReadableStream,
    WritableStream: globalThis.WritableStream,
    TransformStream: globalThis.TransformStream,
    ByteLengthQueuingStrategy: globalThis.ByteLengthQueuingStrategy,
    CountQueuingStrategy: globalThis.CountQueuingStrategy,
    TextDecoderStream: globalThis.TextDecoderStream,
    TextEncoderStream: globalThis.TextEncoderStream,
    CompressionStream: globalThis.CompressionStream,
    DecompressionStream: globalThis.DecompressionStream,
  },
  'node:stream/promises': {
    ...streamPromises,
    finished,
    pipeline,
  },
  'node:process': createProcess({ pid: 1, cwd: '/' }),
  'node:buffer': { Buffer, default: Buffer },
  'node:module': {
    createRequire,
    isBuiltin,
    builtinModules: builtinModulesList,
  },
}

function normalizeSpecifier(specifier: string): string {
  if (specifier.startsWith('node:')) {
    return specifier
  }

  if (builtinSpecifiers.has(specifier)) {
    return `node:${specifier}`
  }

  return specifier
}

function createNotFound(specifier: string): Error & { code: string } {
  const err = new Error(`Cannot find module '${specifier}'`) as Error & { code: string }
  err.code = 'MODULE_NOT_FOUND'
  return err
}

function resolveFromBase(fromFile: string, specifier: string): string {
  if (specifier.startsWith('/')) {
    return path.posix.normalize(specifier)
  }

  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const baseDir = path.posix.dirname(fromFile)
    return path.posix.resolve(baseDir, specifier)
  }

  return specifier
}

const registry = new Map<string, unknown>()
const requireCaches = new Set<Record<string, unknown>>()

export function isBuiltin(specifier: string): boolean {
  return builtinSpecifiers.has(specifier) || builtinSpecifiers.has(normalizeSpecifier(specifier))
}

export function register(specifier: string, exportsValue: unknown): void {
  registry.set(specifier, exportsValue)

  const normalized = normalizeSpecifier(specifier)
  for (const cache of requireCaches) {
    delete cache[specifier]
    delete cache[normalized]
  }
}

export function createRequire(_fromFile = '/'): RequireFunction {
  const fromFile = _fromFile
  const cache: Record<string, unknown> = {}
  requireCaches.add(cache)

  const requireFn = ((specifier: string): unknown => {
    const resolvedSpecifier = resolveFromBase(fromFile, specifier)
    const normalized = normalizeSpecifier(resolvedSpecifier)

    if (cache[resolvedSpecifier] !== undefined) {
      return cache[resolvedSpecifier]
    }

    if (cache[normalized] !== undefined) {
      return cache[normalized]
    }

    if (registry.has(resolvedSpecifier)) {
      const value = registry.get(resolvedSpecifier)
      cache[resolvedSpecifier] = value
      return value
    }

    if (registry.has(normalized)) {
      const value = registry.get(normalized)
      cache[normalized] = value
      return value
    }

    if (isBuiltin(normalized) && builtinModules[normalized] !== undefined) {
      const value = builtinModules[normalized]
      cache[normalized] = value
      return value
    }

    throw createNotFound(specifier)
  }) as RequireFunction

  requireFn.resolve = (specifier: string): string => {
    const resolvedSpecifier = resolveFromBase(fromFile, specifier)

    if (registry.has(resolvedSpecifier)) {
      return resolvedSpecifier
    }

    const normalized = normalizeSpecifier(resolvedSpecifier)
    if (registry.has(normalized)) {
      return normalized
    }

    if (isBuiltin(normalized)) {
      return normalized
    }

    throw createNotFound(specifier)
  }

  requireFn.cache = cache
  requireFn.register = (specifier: string, exportsValue: unknown): void => {
    register(specifier, exportsValue)
  }

  return requireFn
}

/**
 * Create a `require()` function backed by a VFS for node_modules resolution.
 * When a bare specifier is not in the registry or builtins, the VFS is used
 * to walk node_modules and load the module source via `@mars/web-resolver`.
 *
 * @param fromFile - Absolute path of the importing file
 * @param vfs      - VFS instance to resolve and read node_modules from
 */
export function createRequireWithVfs(fromFile: string, vfs: VFS): RequireFunction {
  const baseRequire = createRequire(fromFile)

  const fsAdapter = {
    existsSync: (p: string) => vfs.existsSync(p),
    readFileSync: (p: string): string | null => {
      try {
        return vfs.readFileSync(p).toString('utf8')
      } catch {
        return null
      }
    },
  }

  const requireFn = ((specifier: string): unknown => {
    // Delegate to base for builtins and registered modules
    try {
      return baseRequire(specifier)
    } catch (baseErr) {
      const err = baseErr as Error & { code?: string }
      if (err.code !== 'MODULE_NOT_FOUND') {
        throw baseErr
      }
    }

    // Attempt VFS-backed resolver for node_modules
    const resolved = resolveSpecifier(specifier, fromFile, { fs: fsAdapter })
    if (!resolved) {
      throw createNotFound(specifier)
    }

    // Check registry first (allows hot-replace of VFS modules)
    if (baseRequire.cache[resolved] !== undefined) {
      return baseRequire.cache[resolved]
    }

    // Load and evaluate CJS source from VFS
    const source = fsAdapter.readFileSync(resolved)
    if (!source) {
      throw createNotFound(specifier)
    }

    const moduleObj = { exports: {} as Record<string, unknown> }
    const childRequire = createRequireWithVfs(resolved, vfs)
    // eslint-disable-next-line no-new-func
    const fn = new Function('module', 'exports', 'require', '__filename', '__dirname', source)
    fn(
      moduleObj,
      moduleObj.exports,
      childRequire,
      resolved,
      resolved.slice(0, resolved.lastIndexOf('/')),
    )

    baseRequire.cache[resolved] = moduleObj.exports
    return moduleObj.exports
  }) as RequireFunction

  requireFn.resolve = (specifier: string): string => {
    try {
      return baseRequire.resolve(specifier)
    } catch {
      const resolved = resolveSpecifier(specifier, fromFile, { fs: fsAdapter })
      if (!resolved) {
        throw createNotFound(specifier)
      }
      return resolved
    }
  }

  requireFn.cache = baseRequire.cache
  requireFn.register = baseRequire.register

  return requireFn
}
