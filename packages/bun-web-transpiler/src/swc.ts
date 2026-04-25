import { TranspileCache } from './cache'
import { createSimpleSourceMap, inlineSourceMap } from './source-map'
import { WasmModuleLoader } from '@mars/web-shared/wasm-module-loader'
import type { 
  ScanImportResult, 
  TranspileOptions, 
  TranspileResult 
} from './transpiler.types'

type SwcTransformOptions = {
  jsc: {
    parser: {
      syntax: 'typescript' | 'ecmascript'
      tsx?: boolean
      jsx?: boolean
      decorators?: boolean
      dynamicImport: true
    }
    target?: string
    transform?: {
      react?: {
        runtime?: 'automatic' | 'classic'
        pragma?: string
        pragmaFrag?: string
      }
    }
  }
  sourceMaps?: boolean | 'inline'
  filename?: string
}

type SwcWasmLike = {
  transform?: (code: string, options?: SwcTransformOptions) => Promise<string | { code?: string; map?: string }>
  transformSync?: (code: string, options?: SwcTransformOptions) => string | { code?: string; map?: string }
}

const SWC_WASM_CANDIDATES = ['@swc/wasm-web', '@swc/wasm'] as const

type SwcWasmLoader = () => Promise<SwcWasmLike | null>

const defaultSwcWasmLoader: SwcWasmLoader = async () => {
  for (const candidate of SWC_WASM_CANDIDATES) {
    try {
      const loaded = (await import(candidate)) as SwcWasmLike
      if (loaded && (typeof loaded.transform === 'function' || typeof loaded.transformSync === 'function')) {
        return loaded
      }
    } catch {
      // Keep trying other candidates.
    }
  }
  return null
}

const swcWasmRuntime = new WasmModuleLoader<SwcWasmLike>(defaultSwcWasmLoader)

const IMPORT_RE = /import\s+(?:[^'"()]*?from\s+)?['\"]([^'\"]+)['\"]/g
const REQUIRE_RE = /require\(\s*['\"]([^'\"]+)['\"]\s*\)/g
const DYNAMIC_IMPORT_RE = /import\(\s*['\"]([^'\"]+)['\"]\s*\)/g

function stableHash(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))

  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`)
    .join(',')}}`
}

async function loadSwcWasm(): Promise<SwcWasmLike | null> {
  const loaded = await swcWasmRuntime.load()
  if (loaded && (typeof loaded.transform === 'function' || typeof loaded.transformSync === 'function')) {
    return loaded
  }

  return null
}

function getLoadedSwcWasm(): SwcWasmLike | null {
  return swcWasmRuntime.getLoaded()
}

function toSwcOptions(options: TranspileOptions): SwcTransformOptions {
  const loader = options.loader ?? 'ts'
  const parserSyntax: 'typescript' | 'ecmascript' =
    loader === 'ts' || loader === 'tsx' ? 'typescript' : 'ecmascript'
  const parser = {
    syntax: parserSyntax,
    tsx: loader === 'tsx',
    jsx: loader === 'jsx',
    decorators: options.decorators,
    dynamicImport: true as const,
  }

  const reactRuntime =
    options.jsx === 'react-jsx'
      ? 'automatic'
      : options.jsx === 'react'
        ? 'classic'
        : undefined

  const target = options.target === 'browser' ? 'es2022' : options.target === 'node' ? 'es2021' : undefined

  return {
    jsc: {
      parser,
      target,
      transform:
        reactRuntime || options.jsxFactory || options.jsxFragment
          ? {
              react: {
                runtime: reactRuntime,
                pragma: options.jsxFactory,
                pragmaFrag: options.jsxFragment,
              },
            }
          : undefined,
    },
    sourceMaps: options.sourceMaps,
    filename: 'input.ts',
  }
}

function normalizeSwcResult(result: string | { code?: string; map?: string }): TranspileResult {
  if (typeof result === 'string') {
    return { code: result, imports: [] }
  }

  return {
    code: result.code ?? '',
    map: result.map,
    imports: [],
  }
}

function createSwcUnavailableError(): Error {
  return new Error(
    'swc-wasm is required in browser runtime; no Bun.Transpiler/fallback path is available',
  )
}

function transpileWithSwcSync(code: string, options: TranspileOptions): TranspileResult {
  const swc = getLoadedSwcWasm()
  if (!swc) {
    throw createSwcUnavailableError()
  }

  if (typeof swc.transformSync === 'function') {
    return normalizeSwcResult(swc.transformSync(code, toSwcOptions(options)))
  }

  throw new Error('swc-wasm sync transform is unavailable; use transformAsync or provide transformSync')
}

async function transpileWithSwcAsync(code: string, options: TranspileOptions): Promise<TranspileResult> {
  const swc = await loadSwcWasm()
  if (!swc) {
    throw createSwcUnavailableError()
  }

  if (typeof swc.transform === 'function') {
    const result = await swc.transform(code, toSwcOptions(options))
    return normalizeSwcResult(result)
  }

  if (typeof swc.transformSync === 'function') {
    return normalizeSwcResult(swc.transformSync(code, toSwcOptions(options)))
  }

  throw createSwcUnavailableError()
}

export class WebTranspiler {
  transform(code: string, options: TranspileOptions = {}): string {
    return this.transformResult(code, options).code
  }

  transformResult(code: string, options: TranspileOptions = {}): TranspileResult {
    const swcResult = transpileWithSwcSync(code, options)

    return {
      ...swcResult,
      imports: this.scanImports(code),
    }
  }

  async transformAsync(code: string, options: TranspileOptions = {}): Promise<TranspileResult> {
    const swcResult = await transpileWithSwcAsync(code, options)

    return {
      ...swcResult,
      imports: this.scanImports(code),
    }
  }

  scan(code: string): { imports: Array<{ path: string; kind: 'import' | 'require' }> } {
    const imports = this.scanImportEntries(code)
      .filter(item => item.kind !== 'dynamic-import')
      .map(item => ({ path: item.path, kind: item.kind as 'import' | 'require' }))

    return { imports }
  }

  scanImportEntries(code: string): ScanImportResult[] {
    const out: ScanImportResult[] = []

    for (const match of code.matchAll(IMPORT_RE)) {
      out.push({ path: match[1], kind: 'import' })
    }
    for (const match of code.matchAll(REQUIRE_RE)) {
      out.push({ path: match[1], kind: 'require' })
    }
    for (const match of code.matchAll(DYNAMIC_IMPORT_RE)) {
      out.push({ path: match[1], kind: 'dynamic-import' })
    }

    return out
  }

  scanImports(code: string): string[] {
    return this.scanImportEntries(code).map(item => item.path)
  }
}

export class BunTranspiler extends WebTranspiler {
  constructor(
    private readonly defaults: TranspileOptions = {},
    private readonly cache: TranspileCache | null = null,
  ) {
    super()
  }

  transformResult(code: string, options: TranspileOptions = {}): TranspileResult {
    const merged = { ...this.defaults, ...options }
    const contentHash = stableHash(code)
    const optsHash = stableHash(stableSerialize(merged))

    const cached = this.cache?.get(contentHash, optsHash)
    if (cached) {
      return cached
    }

    let result = super.transformResult(code, merged)
    if (merged.sourceMaps) {
      const map = result.map ?? createSimpleSourceMap(code)
      result = {
        ...result,
        map,
        code: merged.sourceMaps === 'inline' ? inlineSourceMap(result.code, map) : result.code,
      }
    }

    void this.cache?.set(contentHash, optsHash, result)
    return result
  }

  async transformAsync(code: string, options: TranspileOptions = {}): Promise<TranspileResult> {
    const merged = { ...this.defaults, ...options }
    const contentHash = stableHash(code)
    const optsHash = stableHash(stableSerialize(merged))

    const cached = this.cache?.get(contentHash, optsHash)
    if (cached) {
      return cached
    }

    let result = await super.transformAsync(code, merged)
    if (merged.sourceMaps) {
      const map = result.map ?? createSimpleSourceMap(code)
      result = {
        ...result,
        map,
        code: merged.sourceMaps === 'inline' ? inlineSourceMap(result.code, map) : result.code,
      }
    }

    await this.cache?.set(contentHash, optsHash, result)
    return result
  }
}

export function createTranspiler(): WebTranspiler {
  return new WebTranspiler()
}

export async function createInitializedTranspiler(
  options: {
    defaults?: TranspileOptions
    cache?: TranspileCache | null
  } = {},
): Promise<BunTranspiler> {
  await initSwcWasm()
  return new BunTranspiler(options.defaults ?? {}, options.cache ?? null)
}

export function scanImports(code: string): ScanImportResult[] {
  return createTranspiler().scanImportEntries(code)
}

export function __resetSwcWasmForTests(): void {
  swcWasmRuntime.clear()
}

export function __setSwcWasmLoaderForTests(loader: SwcWasmLoader): void {
  swcWasmRuntime.setFactory(loader)
}

export async function initSwcWasm(): Promise<void> {
  const loaded = await loadSwcWasm()
  if (!loaded) {
    throw createSwcUnavailableError()
  }
}

export function isSwcWasmReady(): boolean {
  return swcWasmRuntime.getLoaded() !== null
}
