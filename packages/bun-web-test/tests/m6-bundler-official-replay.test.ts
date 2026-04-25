import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  __resetEsbuildWasmForTests,
  __setEsbuildWasmLoaderForTests,
  initEsbuildWasm,
} from '../../../packages/bun-web-bundler/src/esbuild-wasm'
import { build } from '../../../packages/bun-web-bundler/src/build'

function createMockEsbuildWasmModule() {
  const encoder = new TextEncoder()

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
        let code = readFileSync(entry, 'utf8')

        if (typeof options.banner === 'string' && options.banner.length > 0) {
          code = `${options.banner}\n${code}`
        }

        if (typeof options.footer === 'string' && options.footer.length > 0) {
          code = `${code}\n${options.footer}`
        }

        for (const [key, value] of Object.entries(define)) {
          code = code.split(key).join(String(value))
        }

        if (options.minify) {
          code = code
            .replace(/\s+/g, ' ')
            .replace(/\s*([{}();,:=+\-*/<>])\s*/g, '$1')
            .trim()
        }

        outputFiles.push({ path: outputPath, contents: encoder.encode(code) })

        if (options.sourcemap === 'external') {
          const mapPath = `${outputPath}.map`
          outputFiles.push({
            path: mapPath,
            contents: encoder.encode(JSON.stringify({ version: 3, sources: [entry], mappings: '' })),
          })
          metafileOutputs[mapPath] = {
            bytes: outputFiles[outputFiles.length - 1].contents.byteLength,
            imports: [],
            exports: [],
            inputs: {},
          }
        }

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
  __resetEsbuildWasmForTests()
  __setEsbuildWasmLoaderForTests(async () => createMockEsbuildWasmModule() as any)
  await initEsbuildWasm({ worker: false })
})

afterEach(() => {
  __resetEsbuildWasmForTests()
})

describe('bun-web M6 bundler official replay', () => {
  test('official replay: define replaces compile-time constants in output', async () => {
    const root = join(tmpdir(), `m6-bundler-replay-define-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const entry = join(root, 'index.ts')
    const outdir = join(root, 'dist')
    writeFileSync(entry, 'console.log(__BUILD_TARGET__)\n')

    const result = await build({
      entrypoints: [entry],
      outdir,
      target: 'browser',
      format: 'esm',
      define: {
        __BUILD_TARGET__: '"browser"',
      },
      metafile: true,
    })

    expect(result.success).toBe(true)
    expect(result.outputs.length).toBe(1)

    const content = readFileSync(result.outputs[0], 'utf8')
    expect(content).toContain('"browser"')
    expect(content).not.toContain('__BUILD_TARGET__')

    rmSync(root, { recursive: true, force: true })
  })

  test('official replay: splitting + metadata mode reports entry/chunk summary', async () => {
    const root = join(tmpdir(), `m6-bundler-replay-splitting-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const entryA = join(root, 'a.ts')
    const entryB = join(root, 'b.ts')
    const outdir = join(root, 'dist')

    writeFileSync(entryA, 'export const a = 1\n')
    writeFileSync(entryB, 'export const b = 2\n')

    const result = await build({
      entrypoints: [entryA, entryB],
      outdir,
      target: 'browser',
      format: 'esm',
      splitting: true,
      chunkMerge: 'metadata',
    })

    expect(result.success).toBe(true)
    expect(result.chunkMerge).not.toBeNull()
    expect(result.chunkMerge?.mode).toBe('metadata')
    expect(result.chunkMerge?.entryPointCount).toBe(2)
    expect(result.chunkMerge?.chunkCount).toBe(1)
    expect(result.chunkMerge?.omittedChunkCount).toBe(0)

    rmSync(root, { recursive: true, force: true })
  })

  test('official replay: entry-only mode omits chunk paths and reports omitted count', async () => {
    const root = join(tmpdir(), `m6-bundler-replay-entry-only-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const entryA = join(root, 'a.ts')
    const entryB = join(root, 'b.ts')
    const outdir = join(root, 'dist')

    writeFileSync(entryA, 'export const a = 1\n')
    writeFileSync(entryB, 'export const b = 2\n')

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
    expect(result.chunkMerge?.chunkCount).toBe(1)
    expect(result.chunkMerge?.omittedChunkCount).toBe(1)
    expect(result.chunkMerge?.paths.every(path => path.endsWith('/a.js') || path.endsWith('/b.js'))).toBe(true)

    rmSync(root, { recursive: true, force: true })
  })

  test('official replay: size-buckets mode reports four bucket summaries', async () => {
    const root = join(tmpdir(), `m6-bundler-replay-size-buckets-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const entryA = join(root, 'a.ts')
    const entryB = join(root, 'b.ts')
    const outdir = join(root, 'dist')

    writeFileSync(entryA, 'export const a = 1\n')
    writeFileSync(entryB, 'export const b = 2\n')

    const result = await build({
      entrypoints: [entryA, entryB],
      outdir,
      target: 'browser',
      format: 'esm',
      splitting: true,
      chunkMerge: 'size-buckets',
    })

    expect(result.success).toBe(true)
    expect(result.chunkMerge?.mode).toBe('size-buckets')
    expect(result.chunkMerge?.sizeBuckets).toBeDefined()
    expect(result.chunkMerge?.sizeBuckets?.length).toBe(4)

    const totalByBucket = result.chunkMerge?.sizeBuckets?.reduce((acc, item) => acc + item.totalBytes, 0)
    expect(totalByBucket).toBe(result.chunkMerge?.totalBytes)

    rmSync(root, { recursive: true, force: true })
  })

  test('official replay: plugin lifecycle hooks execute and respect target filtering', async () => {
    const root = join(tmpdir(), `m6-bundler-replay-plugin-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const entry = join(root, 'index.ts')
    const outdir = join(root, 'dist')
    writeFileSync(entry, 'console.log(__PLUGIN_VALUE__)\n')

    const calls: string[] = []
    const result = await build({
      entrypoints: [entry],
      outdir,
      target: 'browser',
      format: 'esm',
      plugins: [
        {
          name: 'browser-plugin',
          target: 'browser',
          beforeBuild({ options }) {
            calls.push('before-browser')
            options.define = {
              ...(options.define ?? {}),
              __PLUGIN_VALUE__: '"from-plugin"',
            }
          },
          afterBuild() {
            calls.push('after-browser')
          },
        },
        {
          name: 'node-only-plugin',
          target: 'node',
          beforeBuild() {
            calls.push('before-node')
          },
          afterBuild() {
            calls.push('after-node')
          },
        },
      ],
    })

    expect(result.success).toBe(true)
    expect(calls).toEqual(['before-browser', 'after-browser'])

    const content = readFileSync(result.outputs[0], 'utf8')
    expect(content).toContain('"from-plugin"')
    expect(content).not.toContain('__PLUGIN_VALUE__')

    rmSync(root, { recursive: true, force: true })
  })

  test('official replay: sourcemap external emits map artifact linkage', async () => {
    const root = join(tmpdir(), `m6-bundler-replay-sourcemap-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const entry = join(root, 'index.ts')
    const outdir = join(root, 'dist')
    writeFileSync(entry, 'console.log("map")\n')

    const result = await build({
      entrypoints: [entry],
      outdir,
      target: 'browser',
      format: 'esm',
      sourcemap: 'external',
    })

    expect(result.success).toBe(true)
    expect(result.outputs.some(path => path.endsWith('.map'))).toBe(true)

    const jsArtifact = result.artifacts.find(item => item.path.endsWith('/index.js'))
    expect(jsArtifact?.sourcemapPath).toBeTruthy()
    expect(jsArtifact?.sourcemapPath?.endsWith('.map')).toBe(true)

    rmSync(root, { recursive: true, force: true })
  })

  test('official replay: external keeps bare module import unbundled', async () => {
    const root = join(tmpdir(), `m6-bundler-replay-external-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const entry = join(root, 'index.ts')
    const outdir = join(root, 'dist')
    writeFileSync(entry, 'import lodash from "lodash"\nconsole.log(typeof lodash)\n')

    const result = await build({
      entrypoints: [entry],
      outdir,
      target: 'browser',
      format: 'esm',
      external: ['lodash'],
    })

    expect(result.success).toBe(true)
    const content = readFileSync(result.outputs[0], 'utf8')
    expect(content).toContain('import lodash from "lodash"')

    rmSync(root, { recursive: true, force: true })
  })

  test('official replay: minify shrinks output and preserves transformed define values', async () => {
    const root = join(tmpdir(), `m6-bundler-replay-minify-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const entry = join(root, 'index.ts')
    const outdir = join(root, 'dist')
    writeFileSync(entry, 'if (__PROD__) { console.log(  "hello"  ) }\n')

    const normal = await build({
      entrypoints: [entry],
      outdir: join(outdir, 'normal'),
      target: 'browser',
      format: 'esm',
      define: { __PROD__: 'true' },
      minify: false,
    })

    const minified = await build({
      entrypoints: [entry],
      outdir: join(outdir, 'minified'),
      target: 'browser',
      format: 'esm',
      define: { __PROD__: 'true' },
      minify: true,
    })

    expect(normal.success).toBe(true)
    expect(minified.success).toBe(true)

    const normalContent = readFileSync(normal.outputs[0], 'utf8')
    const minifiedContent = readFileSync(minified.outputs[0], 'utf8')

    expect(minifiedContent.length).toBeLessThan(normalContent.length)
    expect(minifiedContent).toContain('if(true){console.log("hello")}')

    rmSync(root, { recursive: true, force: true })
  })

  test('official replay: metafile option exposes outputs map', async () => {
    const root = join(tmpdir(), `m6-bundler-replay-metafile-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const entry = join(root, 'index.ts')
    const outdir = join(root, 'dist')
    writeFileSync(entry, 'export const version = 1\n')

    const result = await build({
      entrypoints: [entry],
      outdir,
      target: 'browser',
      format: 'esm',
      metafile: true,
    })

    expect(result.success).toBe(true)
    expect(result.metafile).toBeDefined()

    const outputs = (result.metafile as { outputs?: Record<string, unknown> }).outputs
    expect(outputs).toBeDefined()
    expect(Object.keys(outputs ?? {}).length).toBeGreaterThan(0)

    rmSync(root, { recursive: true, force: true })
  })

  test('official replay: banner/footer are injected into output text', async () => {
    const root = join(tmpdir(), `m6-bundler-replay-banner-footer-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const entry = join(root, 'index.ts')
    const outdir = join(root, 'dist')
    writeFileSync(entry, 'console.log("body")\n')

    const result = await build({
      entrypoints: [entry],
      outdir,
      target: 'browser',
      format: 'esm',
      banner: '// replay-banner',
      footer: '// replay-footer',
    })

    expect(result.success).toBe(true)
    const content = readFileSync(result.outputs[0], 'utf8')
    expect(content.startsWith('// replay-banner')).toBe(true)
    expect(content.trimEnd().endsWith('// replay-footer')).toBe(true)

    rmSync(root, { recursive: true, force: true })
  })

  test('official replay: warning logs are surfaced from bundler backend', async () => {
    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize() {},
      async build() {
        return {
          outputFiles: [],
          warnings: [{ text: 'replay-warning: unused import' }],
          metafile: { inputs: {}, outputs: {} },
        }
      },
    }) as any)
    await initEsbuildWasm({ worker: false })

    const result = await build({
      entrypoints: ['virtual-entry.ts'],
      outdir: '/tmp/replay-warning-out',
      target: 'browser',
      format: 'esm',
    })

    expect(result.success).toBe(true)
    expect(result.logs).toEqual([
      {
        level: 'warning',
        message: 'replay-warning: unused import',
      },
    ])
  })

  test('official replay: target maps to backend platform semantics', async () => {
    const seenPlatforms: string[] = []

    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize() {},
      async build(options: any) {
        seenPlatforms.push(String(options.platform))
        return {
          outputFiles: [],
          warnings: [],
          metafile: { inputs: {}, outputs: {} },
        }
      },
    }) as any)
    await initEsbuildWasm({ worker: false })

    await build({ entrypoints: ['virtual-a.ts'], outdir: '/tmp/replay-platform-a', target: 'browser', format: 'esm' })
    await build({ entrypoints: ['virtual-b.ts'], outdir: '/tmp/replay-platform-b', target: 'node', format: 'esm' })
    await build({ entrypoints: ['virtual-c.ts'], outdir: '/tmp/replay-platform-c', target: 'bun', format: 'esm' })

    expect(seenPlatforms).toEqual(['browser', 'node', 'browser'])
  })

  test('official replay: chunkMerge off keeps summary null even with splitting enabled', async () => {
    const root = join(tmpdir(), `m6-bundler-replay-chunk-off-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(root, { recursive: true })

    const entryA = join(root, 'a.ts')
    const entryB = join(root, 'b.ts')
    const outdir = join(root, 'dist')

    writeFileSync(entryA, 'export const a = 1\n')
    writeFileSync(entryB, 'export const b = 2\n')

    const result = await build({
      entrypoints: [entryA, entryB],
      outdir,
      target: 'browser',
      format: 'esm',
      splitting: true,
      chunkMerge: 'off',
    })

    expect(result.success).toBe(true)
    expect(result.chunkMerge).toBeNull()
    expect(result.outputs.length).toBeGreaterThanOrEqual(2)

    rmSync(root, { recursive: true, force: true })
  })

  test('official replay: plugin setup hook is forwarded to backend plugin list', async () => {
    const seenPluginNames: string[][] = []

    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize() {},
      async build(options: any) {
        const names = Array.isArray(options.plugins)
          ? options.plugins.map((plugin: { name?: string }) => plugin.name ?? '')
          : []
        seenPluginNames.push(names)
        return {
          outputFiles: [],
          warnings: [],
          metafile: { inputs: {}, outputs: {} },
        }
      },
    }) as any)
    await initEsbuildWasm({ worker: false })

    const calls: string[] = []
    await build({
      entrypoints: ['virtual-plugin-setup.ts'],
      outdir: '/tmp/replay-plugin-setup-out',
      target: 'browser',
      format: 'esm',
      plugins: [
        {
          name: 'setup-forwarded',
          setup() {
            calls.push('setup-registered')
          },
        },
      ],
    })

    expect(seenPluginNames).toEqual([['setup-forwarded']])
    // mock backend不会执行setup，这里只验证透传注册
    expect(calls).toEqual([])
  })

  test('official replay: unspecified target maps to neutral platform', async () => {
    const seenPlatforms: string[] = []

    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize() {},
      async build(options: any) {
        seenPlatforms.push(String(options.platform))
        return {
          outputFiles: [],
          warnings: [],
          metafile: { inputs: {}, outputs: {} },
        }
      },
    }) as any)
    await initEsbuildWasm({ worker: false })

    await build({
      entrypoints: ['virtual-neutral.ts'],
      outdir: '/tmp/replay-neutral-out',
      format: 'esm',
    })

    expect(seenPlatforms).toEqual(['neutral'])
  })

  test('official replay: size-buckets classifies boundary sizes deterministically', async () => {
    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize() {},
      async build() {
        const outdir = '/tmp/replay-size-boundary'
        const make = (size: number) => new Uint8Array(size)
        return {
          outputFiles: [
            { path: `${outdir}/a.js`, contents: make(1023) },
            { path: `${outdir}/b.js`, contents: make(1024) },
            { path: `${outdir}/c.js`, contents: make(10 * 1024) },
            { path: `${outdir}/d.js`, contents: make(100 * 1024) },
          ],
          warnings: [],
          metafile: {
            inputs: {},
            outputs: {
              [`${outdir}/a.js`]: { bytes: 1023, entryPoint: 'a.ts', imports: [], exports: [], inputs: {} },
              [`${outdir}/b.js`]: { bytes: 1024, entryPoint: 'b.ts', imports: [], exports: [], inputs: {} },
              [`${outdir}/c.js`]: { bytes: 10 * 1024, entryPoint: 'c.ts', imports: [], exports: [], inputs: {} },
              [`${outdir}/d.js`]: { bytes: 100 * 1024, entryPoint: 'd.ts', imports: [], exports: [], inputs: {} },
            },
          },
        }
      },
    }) as any)
    await initEsbuildWasm({ worker: false })

    const result = await build({
      entrypoints: ['virtual-a.ts', 'virtual-b.ts', 'virtual-c.ts', 'virtual-d.ts'],
      outdir: '/tmp/replay-size-boundary',
      target: 'browser',
      format: 'esm',
      chunkMerge: 'size-buckets',
    })

    expect(result.success).toBe(true)
    expect(result.chunkMerge?.mode).toBe('size-buckets')
    expect(result.chunkMerge?.sizeBuckets?.map(item => ({ label: item.label, count: item.count }))).toEqual([
      { label: 'tiny', count: 1 },
      { label: 'small', count: 1 },
      { label: 'medium', count: 1 },
      { label: 'large', count: 1 },
    ])
  })

  test('official replay: metadata summary paths are sorted deterministically', async () => {
    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize() {},
      async build() {
        const outdir = '/tmp/replay-sorted-paths'
        return {
          outputFiles: [
            { path: `${outdir}/z.js`, contents: new Uint8Array([1]) },
            { path: `${outdir}/a.js`, contents: new Uint8Array([2]) },
            { path: `${outdir}/m.js`, contents: new Uint8Array([3]) },
          ],
          warnings: [],
          metafile: {
            inputs: {},
            outputs: {
              [`${outdir}/z.js`]: { bytes: 1, entryPoint: 'z.ts', imports: [], exports: [], inputs: {} },
              [`${outdir}/a.js`]: { bytes: 1, entryPoint: 'a.ts', imports: [], exports: [], inputs: {} },
              [`${outdir}/m.js`]: { bytes: 1, imports: [], exports: [], inputs: {} },
            },
          },
        }
      },
    }) as any)
    await initEsbuildWasm({ worker: false })

    const result = await build({
      entrypoints: ['virtual-sorted.ts'],
      outdir: '/tmp/replay-sorted-paths',
      target: 'browser',
      format: 'esm',
      chunkMerge: 'metadata',
    })

    expect(result.success).toBe(true)
    expect(result.chunkMerge?.paths).toEqual([
      '/tmp/replay-sorted-paths/a.js',
      '/tmp/replay-sorted-paths/m.js',
      '/tmp/replay-sorted-paths/z.js',
    ])
  })

  test('official replay: metadata summary is null when outputs contain only non-mergeable artifacts', async () => {
    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize() {},
      async build() {
        return {
          outputFiles: [
            { path: '/tmp/replay-non-mergeable/index.map', contents: new Uint8Array([1, 2, 3]) },
            { path: '/tmp/replay-non-mergeable/asset.bin', contents: new Uint8Array([4, 5]) },
          ],
          warnings: [],
          metafile: {
            inputs: {},
            outputs: {
              '/tmp/replay-non-mergeable/index.map': { bytes: 3, imports: [], exports: [], inputs: {} },
              '/tmp/replay-non-mergeable/asset.bin': { bytes: 2, imports: [], exports: [], inputs: {} },
            },
          },
        }
      },
    }) as any)
    await initEsbuildWasm({ worker: false })

    const result = await build({
      entrypoints: ['virtual-non-mergeable.ts'],
      outdir: '/tmp/replay-non-mergeable',
      target: 'browser',
      format: 'esm',
      chunkMerge: 'metadata',
    })

    expect(result.success).toBe(true)
    expect(result.chunkMerge).toBeNull()
  })

  test('official replay: outfile path is forwarded and used as single output', async () => {
    const seenOutfiles: Array<string | undefined> = []

    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize() {},
      async build(options: any) {
        seenOutfiles.push(options.outfile)
        const outfile = options.outfile ?? '/tmp/replay-outfile/default.js'
        return {
          outputFiles: [
            { path: outfile, contents: new TextEncoder().encode('console.log("outfile")\n') },
          ],
          warnings: [],
          metafile: {
            inputs: {},
            outputs: {
              [outfile]: { bytes: 23, entryPoint: 'virtual-outfile.ts', imports: [], exports: [], inputs: {} },
            },
          },
        }
      },
    }) as any)
    await initEsbuildWasm({ worker: false })

    const outfile = '/tmp/replay-outfile/final.js'
    const result = await build({
      entrypoints: ['virtual-outfile.ts'],
      outfile,
      target: 'browser',
      format: 'esm',
    })

    expect(seenOutfiles).toEqual([outfile])
    expect(result.success).toBe(true)
    expect(result.outputs).toEqual([outfile])
    expect(result.artifacts[0]?.path).toBe(outfile)
  })

  test('official replay: sourcemap none maps to backend false and no map linkage', async () => {
    const seenSourcemap: unknown[] = []

    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize() {},
      async build(options: any) {
        seenSourcemap.push(options.sourcemap)
        const outdir = '/tmp/replay-sourcemap-none'
        return {
          outputFiles: [
            { path: `${outdir}/index.js`, contents: new TextEncoder().encode('console.log("none")\n') },
          ],
          warnings: [],
          metafile: {
            inputs: {},
            outputs: {
              [`${outdir}/index.js`]: { bytes: 20, entryPoint: 'virtual-none.ts', imports: [], exports: [], inputs: {} },
            },
          },
        }
      },
    }) as any)
    await initEsbuildWasm({ worker: false })

    const result = await build({
      entrypoints: ['virtual-none.ts'],
      outdir: '/tmp/replay-sourcemap-none',
      target: 'browser',
      format: 'esm',
      sourcemap: 'none',
    })

    expect(seenSourcemap).toEqual([false])
    expect(result.success).toBe(true)
    expect(result.outputs.some(path => path.endsWith('.map'))).toBe(false)
    expect(result.artifacts[0]?.sourcemapPath).toBeNull()
  })

  test('official replay: sourcemap inline is forwarded to backend as inline', async () => {
    const seenSourcemap: unknown[] = []

    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize() {},
      async build(options: any) {
        seenSourcemap.push(options.sourcemap)
        const outdir = '/tmp/replay-sourcemap-inline'
        return {
          outputFiles: [
            { path: `${outdir}/index.js`, contents: new TextEncoder().encode('console.log("inline")\n') },
          ],
          warnings: [],
          metafile: {
            inputs: {},
            outputs: {
              [`${outdir}/index.js`]: { bytes: 22, entryPoint: 'virtual-inline.ts', imports: [], exports: [], inputs: {} },
            },
          },
        }
      },
    }) as any)
    await initEsbuildWasm({ worker: false })

    const result = await build({
      entrypoints: ['virtual-inline.ts'],
      outdir: '/tmp/replay-sourcemap-inline',
      target: 'browser',
      format: 'esm',
      sourcemap: 'inline',
    })

    expect(seenSourcemap).toEqual(['inline'])
    expect(result.success).toBe(true)
  })

  test('official replay: backend build failure is propagated as rejected error', async () => {
    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize() {},
      async build() {
        throw new Error('replay-build-failed: unresolved import')
      },
    }) as any)
    await initEsbuildWasm({ worker: false })

    await expect(
      build({
        entrypoints: ['virtual-build-failure.ts'],
        outdir: '/tmp/replay-build-failure',
        target: 'browser',
        format: 'esm',
      }),
    ).rejects.toThrow('replay-build-failed: unresolved import')
  })

  test('official replay: warning logs preserve backend emission order', async () => {
    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize() {},
      async build() {
        return {
          outputFiles: [
            { path: '/tmp/replay-warning-order/index.js', contents: new TextEncoder().encode('console.log(1)\n') },
          ],
          warnings: [
            { text: 'replay-warning-1: first' },
            { text: 'replay-warning-2: second' },
          ],
          metafile: {
            inputs: {},
            outputs: {
              '/tmp/replay-warning-order/index.js': {
                bytes: 15,
                entryPoint: 'virtual-warning-order.ts',
                imports: [],
                exports: [],
                inputs: {},
              },
            },
          },
        }
      },
    }) as any)
    await initEsbuildWasm({ worker: false })

    const result = await build({
      entrypoints: ['virtual-warning-order.ts'],
      outdir: '/tmp/replay-warning-order',
      target: 'browser',
      format: 'esm',
    })

    expect(result.success).toBe(true)
    expect(result.logs).toEqual([
      { level: 'warning', message: 'replay-warning-1: first' },
      { level: 'warning', message: 'replay-warning-2: second' },
    ])
  })

  test('official replay: metafile is hidden when option is not enabled', async () => {
    __resetEsbuildWasmForTests()
    __setEsbuildWasmLoaderForTests(async () => ({
      async initialize() {},
      async build() {
        return {
          outputFiles: [
            { path: '/tmp/replay-metafile-toggle/index.js', contents: new TextEncoder().encode('console.log(2)\n') },
          ],
          warnings: [],
          metafile: {
            inputs: {},
            outputs: {
              '/tmp/replay-metafile-toggle/index.js': {
                bytes: 15,
                entryPoint: 'virtual-metafile-toggle.ts',
                imports: [],
                exports: [],
                inputs: {},
              },
            },
          },
        }
      },
    }) as any)
    await initEsbuildWasm({ worker: false })

    const hidden = await build({
      entrypoints: ['virtual-metafile-toggle.ts'],
      outdir: '/tmp/replay-metafile-toggle',
      target: 'browser',
      format: 'esm',
    })

    const visible = await build({
      entrypoints: ['virtual-metafile-toggle.ts'],
      outdir: '/tmp/replay-metafile-toggle-visible',
      target: 'browser',
      format: 'esm',
      metafile: true,
    })

    expect(hidden.success).toBe(true)
    expect(hidden.metafile).toBeUndefined()
    expect(visible.success).toBe(true)
    expect(visible.metafile).toBeDefined()
  })
})
