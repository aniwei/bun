export interface BuildOptions {
  entrypoints: string[]
  outdir?: string
  outfile?: string
  format?: 'esm' | 'cjs' | 'iife'
  target?: 'browser' | 'node' | 'bun'
  minify?: boolean
  sourcemap?: 'none' | 'inline' | 'external'
  external?: string[]
  define?: Record<string, string>
}

export interface BuildLog {
  level: 'error' | 'warning' | 'info' | 'debug' | 'verbose'
  message: string
}

export interface BuildResult {
  success: boolean
  outputs: string[]
  logs: BuildLog[]
}

export async function build(options: BuildOptions): Promise<BuildResult> {
  const result = await Bun.build({
    entrypoints: options.entrypoints,
    outdir: options.outdir,
    format: options.format,
    target: options.target,
    minify: options.minify,
    sourcemap: options.sourcemap === 'none' ? undefined : options.sourcemap,
    external: options.external,
    define: options.define,
  })

  const outputs = result.outputs.map(file => file.path)
  const logs: BuildLog[] = result.logs.map(log => ({
    level: log.level,
    message: log.message,
  }))

  return {
    success: result.success,
    outputs,
    logs,
  }
}
