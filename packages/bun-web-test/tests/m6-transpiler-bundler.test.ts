import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { TranspileCache } from '../../../packages/bun-web-transpiler/src/cache'
import {
  __resetEsbuildWasmForTests,
  __setEsbuildWasmLoaderForTests,
  initEsbuildWasm,
  isEsbuildWasmReady,
  resolveEsbuildWasmInitOptions,
} from '../../../packages/bun-web-bundler/src/esbuild-wasm'
import { bootstrapProcessWorker } from '../../../packages/bun-web-runtime/src/process-bootstrap'
import {
  __resetRuntimeBundlerForTests,
  initRuntimeBundler,
  isRuntimeBundlerReady,
} from '../../../packages/bun-web-runtime/src/bundler-runtime'
import {
  __resetRuntimeTranspilerForTests,
  initRuntimeTranspiler,
  isRuntimeTranspilerReady as isRuntimeTranspilerReadyFromRuntime,
} from '../../../packages/bun-web-runtime/src/transpiler-runtime'
import {
  __resetSwcWasmForTests,
  __setSwcWasmLoaderForTests,
  BunTranspiler,
  createInitializedTranspiler,
  initSwcWasm,
  isSwcWasmReady,
  WebTranspiler,
  scanImports,
} from '../../../packages/bun-web-transpiler/src/swc'
import { build } from '../../../packages/bun-web-bundler/src/build'
import { stableSnapshot } from './snapshot-utils'

function createMockEsbuildWasmModule() {
  const encoder = new TextEncoder()

  const resolveImportPath = (fromFile: string, specifier: string): string => {
    const base = join(dirname(fromFile), specifier)
    if (extname(base)) {
      return base
    }

    return `${base}.ts`
  }

  const inlineModuleGraph = (filePath: string, seen: Set<string>): string => {
    if (seen.has(filePath)) {
      return ''
    }

    seen.add(filePath)
    const source = readFileSync(filePath, 'utf8')
    const importRe = /import\s+(?:[^'"\n]+?\s+from\s+)?['"]([^'"]+)['"];?/g

    let inlinedDeps = ''
    for (const match of source.matchAll(importRe)) {
      const specifier = match[1]
      if (!specifier.startsWith('.')) {
        continue
      }
      inlinedDeps += `${inlineModuleGraph(resolveImportPath(filePath, specifier), seen)}\n`
    }

    const withoutImports = source.replace(importRe, '')
    return `${inlinedDeps}${withoutImports}`
  }

  return {
    async initialize() {},
    async build(options: any) {
      const entryPoints: string[] = options.entryPoints ?? []
      const outdir: string = options.outdir ?? dirname(entryPoints[0] ?? process.cwd())
      const define = options.define ?? {}

      const outputFiles: Array<{ path: string; contents: Uint8Array }> = []
      const metafileOutputs: Record<string, any> = {}

      for (const entry of entryPoints) {
        const outputPath = join(outdir, `${basename(entry, extname(entry))}.js`)
        let code = inlineModuleGraph(entry, new Set<string>())

        for (const [key, value] of Object.entries(define)) {
          code = code.split(key).join(String(value))
        }

        outputFiles.push({ path: outputPath, contents: encoder.encode(code) })
        metafileOutputs[outputPath] = {
          bytes: outputFiles[outputFiles.length - 1].contents.byteLength,
          entryPoint: entry,
          imports: [],
          exports: [],
          inputs: {},
        }
      }

      if (options.splitting && entryPoints.length > 1) {
        const chunkPath = join(outdir, 'chunk-shared.js')
        const chunkCode = 'export const __chunk_shared = 1\n'
        outputFiles.push({ path: chunkPath, contents: encoder.encode(chunkCode) })
        metafileOutputs[chunkPath] = {
          bytes: outputFiles[outputFiles.length - 1].contents.byteLength,
          imports: [],
          exports: ['__chunk_shared'],
          inputs: {},
        }
      }

      return {
        outputFiles,
        warnings: [],
        metafile: {
          inputs: {},
          outputs: metafileOutputs,
        },
      }
    },
  }
}

beforeEach(async () => {
  __resetSwcWasmForTests()
  __resetRuntimeTranspilerForTests()
  __resetRuntimeBundlerForTests()
  __resetEsbuildWasmForTests()
  __setEsbuildWasmLoaderForTests(async () => createMockEsbuildWasmModule() as any)
  __setSwcWasmLoaderForTests(async () => ({
    async transform(code: string) {
      return { code }
    },
    transformSync(code: string) {
      return { code }
    },
  }))
  await initSwcWasm()
  await initEsbuildWasm({ worker: false })
})

afterEach(() => {
  __resetSwcWasmForTests()
  __resetRuntimeTranspilerForTests()
  __resetRuntimeBundlerForTests()
  __resetEsbuildWasmForTests()
})

describe('M6 transpiler and bundler baseline', () => {
  test('transpiler transforms TypeScript and scans imports', () => {
    const transpiler = new WebTranspiler()
    const source = "import { x } from './x'; const fn = (value: number): number => value + 1; export { fn }"

    const output = transpiler.transform(source, { loader: 'ts' })
    const imports = scanImports(source)

    expect(output).toContain('value + 1')
    expect(imports).toEqual([{ path: './x', kind: 'import' }])
  })

  test('BunTranspiler exposes transformAsync and scan compatibility API', async () => {
    const transpiler = new BunTranspiler()
    const source = "import foo from 'foo'; const data = require('bar'); export async function run() { return import('baz') }"

    const transformed = await transpiler.transformAsync(source, { loader: 'ts' })
    const scanned = transpiler.scan(source)
    const imports = transpiler.scanImports(source)

    expect(transformed.code).toContain('require')
    expect(transformed.imports).toEqual(['foo', 'bar', 'baz'])
    expect(scanned.imports).toEqual([
      { path: 'foo', kind: 'import' },
      { path: 'bar', kind: 'require' },
    ])
    expect(imports).toEqual(['foo', 'bar', 'baz'])
  })

  test('TranspileCache provides sync get and async set/clear baseline', async () => {
    const cache = await TranspileCache.open({
      dbName: `m6-transpile-cache-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    })

    await cache.clear()

    expect(cache.get('content', 'opts')).toBeNull()

    await cache.set('content', 'opts', {
      code: 'console.log(1)',
      imports: ['a'],
      map: '{"version":3}',
    })

    expect(cache.get('content', 'opts')).toEqual({
      code: 'console.log(1)',
      imports: ['a'],
      map: '{"version":3}',
    })

    await cache.clear()
    expect(cache.get('content', 'opts')).toBeNull()
  })

  test('BunTranspiler emits inline source map when sourceMaps is inline', async () => {
    const transpiler = new BunTranspiler()
    const source = 'const value: number = 1\nconsole.log(value)'

    const transformed = await transpiler.transformAsync(source, {
      loader: 'ts',
      sourceMaps: 'inline',
    })

    expect(transformed.map).toContain('"version":3')
    expect(transformed.code).toContain('sourceMappingURL=data:application/json;base64,')
  })

  test('BunTranspiler cache key is stable for equivalent options with different key order', async () => {
    const cache = await TranspileCache.open({
      dbName: `m6-transpile-cache-stable-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    })
    await cache.clear()

    let transformCalls = 0
    __setSwcWasmLoaderForTests(async () => ({
      async transform(code: string) {
        transformCalls += 1
        return { code: `/*${transformCalls}*/${code}` }
      },
    }))
    await initSwcWasm()

    const transpiler = new BunTranspiler({}, cache)
    const source = 'const value: number = 1\nconsole.log(value)'

    const first = await transpiler.transformAsync(source, {
      loader: 'ts',
      target: 'browser',
      sourceMaps: 'inline',
    })
    const second = await transpiler.transformAsync(source, {
      sourceMaps: 'inline',
      target: 'browser',
      loader: 'ts',
    })

    expect(transformCalls).toBe(1)
    expect(second.code).toBe(first.code)
  })

  test('WebTranspiler transformAsync prefers injected swc-wasm path', async () => {
    __setSwcWasmLoaderForTests(async () => ({
      async transform(code: string) {
        return { code: `/*swc*/${code}` }
      },
    }))

    const transpiler = new WebTranspiler()
    const transformed = await transpiler.transformAsync('const value: number = 1', { loader: 'ts' })

    expect(transformed.code.startsWith('/*swc*/')).toBe(true)
  })

  test('WebTranspiler transform prefers injected swc-wasm sync path when available', async () => {
    __setSwcWasmLoaderForTests(async () => ({
      transformSync(code: string) {
        return { code: `/*swc-sync*/${code}` }
      },
    }))
    await initSwcWasm()

    const transpiler = new WebTranspiler()
    const transformed = transpiler.transform('const value: number = 1', { loader: 'ts' })

    expect(transformed.startsWith('/*swc-sync*/')).toBe(true)
  })

  test('WebTranspiler throws when swc-wasm is unavailable', async () => {
    __resetSwcWasmForTests()
    __setSwcWasmLoaderForTests(async () => null)
    const transpiler = new WebTranspiler()

    expect(() => transpiler.transform('const value: number = 1', { loader: 'ts' })).toThrow(
      /swc-wasm is required/i,
    )

    await expect(transpiler.transformAsync('const value: number = 1', { loader: 'ts' })).rejects.toThrow(
      /swc-wasm is required/i,
    )
  })

  test('initSwcWasm marks runtime ready when loader succeeds', async () => {
    __setSwcWasmLoaderForTests(async () => ({
      async transform(code: string) {
        return { code }
      },
    }))

    expect(isSwcWasmReady()).toBe(false)
    await initSwcWasm()
    expect(isSwcWasmReady()).toBe(true)
  })

  test('createInitializedTranspiler initializes swc and returns sync-ready transpiler', async () => {
    __resetSwcWasmForTests()
    __setSwcWasmLoaderForTests(async () => ({
      transformSync(code: string) {
        return { code: `/*init*/${code}` }
      },
    }))

    const transpiler = await createInitializedTranspiler({
      defaults: { loader: 'ts' },
    })

    expect(isSwcWasmReady()).toBe(true)
    const out = transpiler.transform('const value: number = 1')
    expect(out.startsWith('/*init*/')).toBe(true)
  })

  test('initRuntimeTranspiler reuses singleton instance across calls', async () => {
    let loadCount = 0
    __resetSwcWasmForTests()
    __resetRuntimeTranspilerForTests()
    __setSwcWasmLoaderForTests(async () => {
      loadCount += 1
      return {
        async transform(code: string) {
          return { code }
        },
      }
    })

    const a = await initRuntimeTranspiler()
    const b = await initRuntimeTranspiler()

    expect(a).toBe(b)
    expect(loadCount).toBe(1)
    expect(isRuntimeTranspilerReadyFromRuntime()).toBe(true)
  })

  test('bootstrapProcessWorker can initialize runtime transpiler during startup', async () => {
    __resetSwcWasmForTests()
    __resetRuntimeTranspilerForTests()
    __setSwcWasmLoaderForTests(async () => ({
      async transform(code: string) {
        return { code }
      },
    }))

    await bootstrapProcessWorker({
      kernel: { vfs: null } as any,
      pid: 4242,
      argv: ['bun', 'run', 'main.ts'],
      env: {},
      cwd: '/',
      sabBuffer: null,
      initializeTranspiler: true,
    })

    expect(isRuntimeTranspilerReadyFromRuntime()).toBe(true)
    expect((globalThis as Record<string, unknown>).__BUN_WEB_TRANSPILER_READY__).toBe(true)
  })

  test('bootstrapProcessWorker can initialize runtime transpiler via initializer selection', async () => {
    __resetSwcWasmForTests()
    __resetRuntimeTranspilerForTests()
    __setSwcWasmLoaderForTests(async () => ({
      async transform(code: string) {
        return { code }
      },
    }))

    await bootstrapProcessWorker({
      kernel: { vfs: null } as any,
      pid: 4343,
      argv: ['bun', 'run', 'selected.ts'],
      env: {},
      cwd: '/',
      sabBuffer: null,
      initializeTranspiler: false,
      bootstrapInitializers: ['runtime-transpiler-init'],
    })

    expect(isRuntimeTranspilerReadyFromRuntime()).toBe(true)
    expect((globalThis as Record<string, unknown>).__BUN_WEB_TRANSPILER_READY__).toBe(true)
  })

  test('bootstrapProcessWorker can initialize runtime bundler during startup', async () => {
    __resetRuntimeBundlerForTests()
    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => createMockEsbuildWasmModule() as any)

    await bootstrapProcessWorker({
      kernel: { vfs: null } as any,
      pid: 4444,
      argv: ['bun', 'run', 'bundle.ts'],
      env: {},
      cwd: '/',
      sabBuffer: null,
      initializeBundler: true,
      bundlerInit: { worker: false },
    })

    expect(isRuntimeBundlerReady()).toBe(true)
    expect((globalThis as Record<string, unknown>).__BUN_WEB_BUNDLER_READY__).toBe(true)
  })

  test('bootstrapProcessWorker can initialize runtime bundler via initializer selection', async () => {
    __resetRuntimeBundlerForTests()
    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => createMockEsbuildWasmModule() as any)

    await bootstrapProcessWorker({
      kernel: { vfs: null } as any,
      pid: 4545,
      argv: ['bun', 'run', 'bundle-selected.ts'],
      env: {},
      cwd: '/',
      sabBuffer: null,
      initializeBundler: false,
      bootstrapInitializers: ['runtime-bundler-init'],
      bundlerInit: { worker: false },
    })

    expect(isRuntimeBundlerReady()).toBe(true)
    expect((globalThis as Record<string, unknown>).__BUN_WEB_BUNDLER_READY__).toBe(true)
  })

  test('initRuntimeBundler uses browser default worker=true when no explicit options', async () => {
    __resetRuntimeBundlerForTests()
    __resetEsbuildWasmForTests()

    const initializeCalls: Array<{ wasmURL?: string; wasmModule?: WebAssembly.Module; worker?: boolean }> = []
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize(options) {
        initializeCalls.push(options)
      },
      async build() {
        return {
          outputFiles: [],
          warnings: [],
          metafile: { inputs: {}, outputs: {} },
        } as any
      },
    }))

    const globals = globalThis as Record<string, unknown>
    const prevWindow = globals.window
    const prevDocument = globals.document
    const prevInit = globals.__BUN_WEB_ESBUILD_WASM__

    globals.window = {}
    globals.document = {}
    delete globals.__BUN_WEB_ESBUILD_WASM__

    try {
      await initRuntimeBundler()
      expect(isRuntimeBundlerReady()).toBe(true)
      expect(initializeCalls).toEqual([{ worker: true }])
    } finally {
      globals.window = prevWindow
      globals.document = prevDocument
      globals.__BUN_WEB_ESBUILD_WASM__ = prevInit
      __resetRuntimeBundlerForTests()
      __resetEsbuildWasmForTests()
      __setEsbuildWasmLoaderForTests(async () => createMockEsbuildWasmModule() as any)
      await initEsbuildWasm({ worker: false })
    }
  })

  test('bootstrapProcessWorker passes bundlerInit worker override over global worker=true', async () => {
    __resetRuntimeBundlerForTests()
    __resetEsbuildWasmForTests()

    const initializeCalls: Array<{ wasmURL?: string; wasmModule?: WebAssembly.Module; worker?: boolean }> = []
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize(options) {
        initializeCalls.push(options)
      },
      async build() {
        return {
          outputFiles: [],
          warnings: [],
          metafile: { inputs: {}, outputs: {} },
        } as any
      },
    }))

    const globals = globalThis as Record<string, unknown>
    const prevWindow = globals.window
    const prevDocument = globals.document
    const prevInit = globals.__BUN_WEB_ESBUILD_WASM__

    globals.window = {}
    globals.document = {}
    globals.__BUN_WEB_ESBUILD_WASM__ = {
      wasmURL: 'https://example.com/global-worker.wasm',
      worker: true,
    }

    try {
      await bootstrapProcessWorker({
        kernel: { vfs: null } as any,
        pid: 4646,
        argv: ['bun', 'run', 'bundle-worker-override.ts'],
        env: {},
        cwd: '/',
        sabBuffer: null,
        initializeBundler: true,
        bundlerInit: { worker: false },
      })

      expect(isRuntimeBundlerReady()).toBe(true)
      expect(initializeCalls).toEqual([
        {
          wasmURL: 'https://example.com/global-worker.wasm',
          wasmModule: undefined,
          worker: false,
        },
      ])
    } finally {
      globals.window = prevWindow
      globals.document = prevDocument
      globals.__BUN_WEB_ESBUILD_WASM__ = prevInit
      __resetRuntimeBundlerForTests()
      __resetEsbuildWasmForTests()
      __setEsbuildWasmLoaderForTests(async () => createMockEsbuildWasmModule() as any)
      await initEsbuildWasm({ worker: false })
    }
  })

  test('bundler build produces bundled output file', async () => {
    const root = join(tmpdir(), `m6-bundler-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const entry = join(root, 'index.ts')
    const helper = join(root, 'helper.ts')
    const outdir = join(root, 'dist')

    writeFileSync(helper, 'export const answer = 42')
    writeFileSync(entry, "import { answer } from './helper'; console.log(answer)")

    const result = await build({
      entrypoints: [entry],
      outdir,
      target: 'browser',
      format: 'esm',
      minify: false,
      metafile: true,
    })

    expect(result.success).toBe(true)
    expect(result.outputs.length).toBeGreaterThan(0)
    expect(result.artifacts.length).toBe(result.outputs.length)

    const firstArtifact = result.artifacts[0]
    expect(firstArtifact.path).toBe(result.outputs[0])
    expect(firstArtifact.kind).toBe('entry-point')
    expect(firstArtifact.loader.length).toBeGreaterThan(0)
    expect(firstArtifact.bytes).toBeGreaterThan(0)
    expect(result.metafile).toBeDefined()

    const firstOutput = result.outputs[0]
    const content = readFileSync(firstOutput, 'utf8')
    expect(content).toContain('42')

    rmSync(root, { recursive: true, force: true })
  })

  test('bundler requires explicit esbuild-wasm initialization', async () => {
    __resetEsbuildWasmForTests()

    const root = join(tmpdir(), `m6-bundler-init-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })
    const entry = join(root, 'index.ts')
    const outdir = join(root, 'dist')
    writeFileSync(entry, 'console.log(1)')

    await expect(
      build({
        entrypoints: [entry],
        outdir,
        target: 'browser',
        format: 'esm',
      }),
    ).rejects.toThrow(/esbuild-wasm is not initialized/i)

    __setEsbuildWasmLoaderForTests(async () => createMockEsbuildWasmModule() as any)
    await initEsbuildWasm({ worker: false })
    rmSync(root, { recursive: true, force: true })
  })

  test('esbuild-wasm init can consume browser global config and default worker=true', async () => {
    __resetEsbuildWasmForTests()

    const initializeCalls: Array<{ wasmURL?: string; wasmModule?: WebAssembly.Module; worker?: boolean }> = []
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize(options) {
        initializeCalls.push(options)
      },
      async build() {
        return {
          outputFiles: [],
          warnings: [],
          metafile: { inputs: {}, outputs: {} },
        } as any
      },
    }))

    const globals = globalThis as Record<string, unknown>
    const prevWindow = globals.window
    const prevDocument = globals.document
    const prevInit = globals.__BUN_WEB_ESBUILD_WASM__

    globals.window = {}
    globals.document = {}
    globals.__BUN_WEB_ESBUILD_WASM__ = {
      wasmURL: 'https://example.com/esbuild.wasm',
    }

    try {
      const resolved = resolveEsbuildWasmInitOptions()
      expect(resolved.wasmURL).toBe('https://example.com/esbuild.wasm')
      expect(resolved.worker).toBe(true)

      await initEsbuildWasm()
      expect(initializeCalls).toHaveLength(1)
      expect(initializeCalls[0]).toEqual({
        wasmURL: 'https://example.com/esbuild.wasm',
        wasmModule: undefined,
        worker: true,
      })
    } finally {
      globals.window = prevWindow
      globals.document = prevDocument
      globals.__BUN_WEB_ESBUILD_WASM__ = prevInit
      __resetEsbuildWasmForTests()
      __setEsbuildWasmLoaderForTests(async () => createMockEsbuildWasmModule() as any)
      await initEsbuildWasm({ worker: false })
    }
  })

  test('resolveEsbuildWasmInitOptions defaults worker=false in non-browser runtime', () => {
    const globals = globalThis as Record<string, unknown>
    const prevWindow = globals.window
    const prevDocument = globals.document
    const prevInit = globals.__BUN_WEB_ESBUILD_WASM__

    delete globals.window
    delete globals.document
    delete globals.__BUN_WEB_ESBUILD_WASM__

    try {
      const resolved = resolveEsbuildWasmInitOptions()
      expect(resolved.worker).toBe(false)
      expect(resolved.wasmURL).toBeUndefined()
      expect(resolved.wasmModule).toBeUndefined()
    } finally {
      globals.window = prevWindow
      globals.document = prevDocument
      globals.__BUN_WEB_ESBUILD_WASM__ = prevInit
    }
  })

  test('resolveEsbuildWasmInitOptions prefers explicit worker over global config', () => {
    const globals = globalThis as Record<string, unknown>
    const prevWindow = globals.window
    const prevDocument = globals.document
    const prevInit = globals.__BUN_WEB_ESBUILD_WASM__

    globals.window = {}
    globals.document = {}
    globals.__BUN_WEB_ESBUILD_WASM__ = {
      wasmURL: 'https://example.com/from-global.wasm',
      worker: true,
    }

    try {
      const resolved = resolveEsbuildWasmInitOptions({
        wasmURL: 'https://example.com/from-explicit.wasm',
        worker: false,
      })

      expect(resolved).toEqual({
        wasmURL: 'https://example.com/from-explicit.wasm',
        wasmModule: undefined,
        worker: false,
      })
    } finally {
      globals.window = prevWindow
      globals.document = prevDocument
      globals.__BUN_WEB_ESBUILD_WASM__ = prevInit
    }
  })

  test('initEsbuildWasm falls back to worker-only initialize when wasmURL is rejected', async () => {
    __resetEsbuildWasmForTests()

    const initializeCalls: Array<{ wasmURL?: string; wasmModule?: WebAssembly.Module; worker?: boolean }> = []
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize(options) {
        initializeCalls.push(options)
        if (options.wasmURL) {
          throw new Error('"wasmURL" option only works in the browser')
        }
      },
      async build() {
        return {
          outputFiles: [],
          warnings: [],
          metafile: { inputs: {}, outputs: {} },
        } as any
      },
    }))

    await initEsbuildWasm({ wasmURL: 'https://example.com/wasm.wasm', worker: true })

    expect(initializeCalls).toEqual([
      { wasmURL: 'https://example.com/wasm.wasm', wasmModule: undefined, worker: true },
      { worker: true },
    ])
    expect(isEsbuildWasmReady()).toBe(true)

    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => createMockEsbuildWasmModule() as any)
    await initEsbuildWasm({ worker: false })
  })

  test('initEsbuildWasm treats duplicate initialize error as ready state', async () => {
    __resetEsbuildWasmForTests()

    let initializeCallCount = 0
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize() {
        initializeCallCount += 1
        throw new Error('Cannot call "initialize" more than once')
      },
      async build() {
        return {
          outputFiles: [],
          warnings: [],
          metafile: { inputs: {}, outputs: {} },
        } as any
      },
    }))

    await expect(initEsbuildWasm({ worker: false })).resolves.toBeUndefined()
    expect(isEsbuildWasmReady()).toBe(true)

    // ready short-circuit: second init should not call initialize again
    await expect(initEsbuildWasm({ worker: true })).resolves.toBeUndefined()
    expect(initializeCallCount).toBe(1)

    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => createMockEsbuildWasmModule() as any)
    await initEsbuildWasm({ worker: false })
  })

  test('initEsbuildWasm falls back to worker=false when worker is unavailable', async () => {
    __resetEsbuildWasmForTests()

    const initializeCalls: Array<{ wasmURL?: string; wasmModule?: WebAssembly.Module; worker?: boolean }> = []
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize(options) {
        initializeCalls.push(options)
        if (options.worker) {
          throw new Error('Worker is not defined')
        }
      },
      async build() {
        return {
          outputFiles: [],
          warnings: [],
          metafile: { inputs: {}, outputs: {} },
        } as any
      },
    }))

    await initEsbuildWasm({ worker: true })

    expect(initializeCalls).toEqual([{ worker: true }, { worker: false }])
    expect(isEsbuildWasmReady()).toBe(true)

    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => createMockEsbuildWasmModule() as any)
    await initEsbuildWasm({ worker: false })
  })

  test('initEsbuildWasm keeps wasmURL when downgrading worker=true to worker=false', async () => {
    __resetEsbuildWasmForTests()

    const initializeCalls: Array<{ wasmURL?: string; wasmModule?: WebAssembly.Module; worker?: boolean }> = []
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize(options) {
        initializeCalls.push(options)
        if (options.worker) {
          throw new Error('Failed to construct "Worker"')
        }
      },
      async build() {
        return {
          outputFiles: [],
          warnings: [],
          metafile: { inputs: {}, outputs: {} },
        } as any
      },
    }))

    await initEsbuildWasm({ wasmURL: 'https://example.com/esbuild.wasm', worker: true })

    expect(initializeCalls).toEqual([
      {
        wasmURL: 'https://example.com/esbuild.wasm',
        wasmModule: undefined,
        worker: true,
      },
      {
        wasmURL: 'https://example.com/esbuild.wasm',
        wasmModule: undefined,
        worker: false,
      },
    ])
    expect(isEsbuildWasmReady()).toBe(true)

    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => createMockEsbuildWasmModule() as any)
    await initEsbuildWasm({ worker: false })
  })

  test('bundler plugins run lifecycle hooks and respect target matching', async () => {
    const root = join(tmpdir(), `m6-bundler-plugin-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const entry = join(root, 'index.ts')
    const outdir = join(root, 'dist')
    writeFileSync(entry, 'console.log(__PLUGIN_FLAG__)')

    const lifecycleCalls: string[] = []

    const result = await build({
      entrypoints: [entry],
      outdir,
      target: 'browser',
      format: 'esm',
      plugins: [
        {
          name: 'apply-browser-define',
          target: 'browser',
          beforeBuild({ options }) {
            lifecycleCalls.push('before-browser')
            options.define = {
              ...(options.define ?? {}),
              __PLUGIN_FLAG__: JSON.stringify('plugin-ok'),
            }
          },
          afterBuild() {
            lifecycleCalls.push('after-browser')
          },
        },
        {
          name: 'skip-node-plugin',
          target: 'node',
          beforeBuild() {
            lifecycleCalls.push('before-node')
          },
          afterBuild() {
            lifecycleCalls.push('after-node')
          },
        },
      ],
    })

    expect(result.success).toBe(true)
    expect(lifecycleCalls).toEqual(['before-browser', 'after-browser'])

    const firstOutput = result.outputs[0]
    const content = readFileSync(firstOutput, 'utf8')
    expect(content).toContain('plugin-ok')

    rmSync(root, { recursive: true, force: true })
  })

  test('bundler can emit chunk merge metadata summary for split outputs', async () => {
    const root = join(tmpdir(), `m6-bundler-merge-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const shared = join(root, 'shared.ts')
    const entryA = join(root, 'a.ts')
    const entryB = join(root, 'b.ts')
    const outdir = join(root, 'dist')

    writeFileSync(shared, 'export const shared = 7')
    writeFileSync(entryA, "import { shared } from './shared'; console.log('a', shared)")
    writeFileSync(entryB, "import { shared } from './shared'; console.log('b', shared)")

    const result = await build({
      entrypoints: [entryA, entryB],
      outdir,
      target: 'browser',
      format: 'esm',
      splitting: true,
      chunkMerge: 'metadata',
    })

    expect(result.success).toBe(true)
    expect(result.outputs.length).toBeGreaterThan(1)
    expect(result.chunkMerge).not.toBeNull()
    expect(result.chunkMerge?.mode).toBe('metadata')
    expect(result.chunkMerge?.entryPointCount).toBe(2)
    expect(result.chunkMerge?.omittedChunkCount).toBe(0)
    expect(result.chunkMerge?.totalBytes).toBeGreaterThan(0)
    expect(result.chunkMerge?.paths.length).toBeGreaterThan(1)

    expect(
      stableSnapshot({
        mode: result.chunkMerge?.mode,
        entryPointCount: result.chunkMerge?.entryPointCount,
        chunkCount: result.chunkMerge?.chunkCount,
        omittedChunkCount: result.chunkMerge?.omittedChunkCount,
      }),
    ).toMatchInlineSnapshot(`
      "{
        \"chunkCount\": 1,
        \"entryPointCount\": 2,
        \"mode\": \"metadata\",
        \"omittedChunkCount\": 0
      }"
    `)

    rmSync(root, { recursive: true, force: true })
  })

  test('bundler chunkMerge entry-only strategy keeps entry paths and reports omitted chunks', async () => {
    const root = join(tmpdir(), `m6-bundler-merge-entry-only-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const shared = join(root, 'shared.ts')
    const entryA = join(root, 'a.ts')
    const entryB = join(root, 'b.ts')
    const outdir = join(root, 'dist')

    writeFileSync(shared, 'export const shared = 7')
    writeFileSync(entryA, "import { shared } from './shared'; console.log('a', shared)")
    writeFileSync(entryB, "import { shared } from './shared'; console.log('b', shared)")

    const result = await build({
      entrypoints: [entryA, entryB],
      outdir,
      target: 'browser',
      format: 'esm',
      splitting: true,
      chunkMerge: 'entry-only',
    })

    expect(result.success).toBe(true)
    expect(result.chunkMerge).not.toBeNull()
    expect(result.chunkMerge?.mode).toBe('entry-only')
    expect(result.chunkMerge?.entryPointCount).toBe(2)
    expect(result.chunkMerge?.chunkCount).toBeGreaterThan(0)
    expect(result.chunkMerge?.omittedChunkCount).toBe(result.chunkMerge?.chunkCount)
    expect(result.chunkMerge?.paths.every(path => path.endsWith('/a.js') || path.endsWith('/b.js'))).toBe(true)

    rmSync(root, { recursive: true, force: true })
  })

  test('bundler chunkMerge size-buckets strategy reports bucketed size summary', async () => {
    const root = join(tmpdir(), `m6-bundler-merge-size-buckets-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const shared = join(root, 'shared.ts')
    const entryA = join(root, 'a.ts')
    const entryB = join(root, 'b.ts')
    const outdir = join(root, 'dist')

    writeFileSync(shared, 'export const shared = 7')
    writeFileSync(entryA, "import { shared } from './shared'; console.log('a', shared)")
    writeFileSync(entryB, "import { shared } from './shared'; console.log('b', shared)")

    const result = await build({
      entrypoints: [entryA, entryB],
      outdir,
      target: 'browser',
      format: 'esm',
      splitting: true,
      chunkMerge: 'size-buckets',
    })

    expect(result.success).toBe(true)
    expect(result.chunkMerge).not.toBeNull()
    expect(result.chunkMerge?.mode).toBe('size-buckets')
    expect(result.chunkMerge?.sizeBuckets).toBeDefined()
    expect(result.chunkMerge?.sizeBuckets?.length).toBe(4)

    const mergedCount = (result.chunkMerge?.entryPointCount ?? 0) + (result.chunkMerge?.chunkCount ?? 0)
    const bucketCount = result.chunkMerge?.sizeBuckets?.reduce((acc, bucket) => acc + bucket.count, 0)
    const bucketBytes = result.chunkMerge?.sizeBuckets?.reduce((acc, bucket) => acc + bucket.totalBytes, 0)

    expect(bucketCount).toBe(mergedCount)
    expect(bucketBytes).toBe(result.chunkMerge?.totalBytes)

    rmSync(root, { recursive: true, force: true })
  })
})
