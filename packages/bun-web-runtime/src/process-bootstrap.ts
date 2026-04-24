import type { Kernel } from '../../bun-web-kernel/src/kernel'

export interface ProcessBootstrapOptions {
  kernel: Kernel
  pid: number
  argv: string[]
  env: Record<string, string>
  cwd: string
  sabBuffer: SharedArrayBuffer | null
}

export async function bootstrapProcessWorker(opts: ProcessBootstrapOptions): Promise<void> {
  const scope = globalThis as typeof globalThis & {
    __BUN_WEB_PROCESS_CONTEXT__?: ProcessBootstrapOptions
  }

  scope.__BUN_WEB_PROCESS_CONTEXT__ = opts
}
