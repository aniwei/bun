import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChunkMergeSummary, type ChunkMergeSummary } from './chunk-merger'
import { getEsbuildWasmBuild } from './esbuild-wasm'
import { createPluginExecutionPlan, type WebBuildPlugin } from './plugin-adapter'

export interface BuildOptions {
  entrypoints: string[]
  outdir?: string
  outfile?: string
  format?: 'esm' | 'cjs' | 'iife'
  target?: 'browser' | 'node' | 'bun'
  minify?: boolean
  banner?: string
  footer?: string
  splitting?: boolean
  sourcemap?: 'none' | 'inline' | 'external'
  external?: string[]
  define?: Record<string, string>
  metafile?: boolean
  chunkMerge?: 'off' | 'metadata' | 'entry-only' | 'size-buckets'
  plugins?: WebBuildPlugin[]
}

export interface BuildLog {
  level: 'error' | 'warning' | 'info' | 'debug' | 'verbose'
  message: string
}

export interface BuildResult {
  success: boolean
  outputs: string[]
  artifacts: BuildArtifactSummary[]
  chunkMerge: ChunkMergeSummary | null
  logs: BuildLog[]
  metafile?: unknown
}

export interface BuildArtifactSummary {
  path: string
  kind: 'entry-point' | 'chunk' | 'asset' | 'sourcemap' | 'bytecode'
  loader: string
  hash: string | null
  bytes: number
  sourcemapPath: string | null
}

function normalizeOutputPath(path: string): string {
  return path.startsWith('file://') ? fileURLToPath(path) : path
}

function inferLoaderFromPath(path: string): string {
  const ext = extname(path).toLowerCase()
  switch (ext) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'js'
    case '.ts':
      return 'ts'
    case '.css':
      return 'css'
    case '.json':
      return 'json'
    case '.map':
      return 'file'
    default:
      return 'file'
  }
}

function inferKindFromPath(
  path: string,
  entryPointByOutputPath: Map<string, boolean>,
): 'entry-point' | 'chunk' | 'asset' | 'sourcemap' | 'bytecode' {
  if (path.endsWith('.map')) {
    return 'sourcemap'
  }

  if (entryPointByOutputPath.has(path)) {
    return 'entry-point'
  }

  const loader = inferLoaderFromPath(path)
  if (loader === 'js' || loader === 'css') {
    return 'chunk'
  }

  return 'asset'
}

function mapPlatform(target: BuildOptions['target']): 'browser' | 'node' | 'neutral' {
  if (target === 'node') {
    return 'node'
  }

  if (target === 'browser' || target === 'bun') {
    return 'browser'
  }

  return 'neutral'
}

function mapSourcemap(sourcemap: BuildOptions['sourcemap']): boolean | 'inline' | 'external' {
  if (sourcemap === 'none' || sourcemap === undefined) {
    return false
  }

  if (sourcemap === 'inline' || sourcemap === 'external') {
    return sourcemap
  }

  return false
}

export async function build(options: BuildOptions): Promise<BuildResult> {
  const pluginPlan = createPluginExecutionPlan(options.plugins, options.target)

  for (const hook of pluginPlan.beforeBuildHooks) {
    await hook({ options })
  }

  const esbuildBuild = await getEsbuildWasmBuild()
  const alwaysCollectMetafile = true
  const buildResultRaw = await esbuildBuild({
    entryPoints: options.entrypoints,
    outdir: options.outdir,
    outfile: options.outfile,
    format: options.format,
    platform: mapPlatform(options.target),
    bundle: true,
    splitting: options.splitting,
    minify: options.minify,
    banner: options.banner,
    footer: options.footer,
    sourcemap: mapSourcemap(options.sourcemap),
    external: options.external,
    define: options.define,
    plugins: pluginPlan.esbuildPlugins,
    metafile: alwaysCollectMetafile,
    write: false,
  })

  const outputFiles = buildResultRaw.outputFiles ?? []
  const outputPathSet = new Set(outputFiles.map(file => normalizeOutputPath(file.path)))

  const entryPointByOutputPath = new Map<string, boolean>()
  if (buildResultRaw.metafile) {
    for (const [path, info] of Object.entries(buildResultRaw.metafile.outputs)) {
      if (info.entryPoint) {
        entryPointByOutputPath.set(normalizeOutputPath(path), true)
      }
    }
  }

  for (const outputFile of outputFiles) {
    const path = normalizeOutputPath(outputFile.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, outputFile.contents)
  }

  const outputs = outputFiles.map(file => normalizeOutputPath(file.path))
  const artifacts: BuildArtifactSummary[] = outputFiles.map(file => {
    const path = normalizeOutputPath(file.path)
    const kind = inferKindFromPath(path, entryPointByOutputPath)
    const sourcemapPath = outputPathSet.has(`${path}.map`) ? `${path}.map` : null

    return {
      path,
      kind,
      loader: inferLoaderFromPath(path),
      hash: null,
      bytes: file.contents.byteLength,
      sourcemapPath,
    }
  })

  const logs: BuildLog[] = [
    ...(buildResultRaw.warnings ?? []).map(log => ({
      level: 'warning' as const,
      message: log.text,
    })),
  ]

  const chunkMerge =
    options.chunkMerge && options.chunkMerge !== 'off'
      ? createChunkMergeSummary(artifacts, options.chunkMerge)
      : null

  const buildResult: BuildResult = {
    success: true,
    outputs,
    artifacts,
    chunkMerge,
    logs,
    metafile: options.metafile ? buildResultRaw.metafile : undefined,
  }

  for (const hook of pluginPlan.afterBuildHooks) {
    await hook({ options, result: buildResult })
  }

  return buildResult
}
