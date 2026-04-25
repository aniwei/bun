import {
  createInitializedTranspiler,
  type BunTranspiler,
  type TranspileOptions,
} from '@mars/web-transpiler'
import type { TranspileCache } from '@mars/web-transpiler'

export interface RuntimeTranspilerInitOptions {
  defaults?: TranspileOptions
  cache?: TranspileCache | null
}

let runtimeTranspiler: BunTranspiler | null = null
let runtimeTranspilerLoading: Promise<BunTranspiler> | null = null

export async function initRuntimeTranspiler(
  options: RuntimeTranspilerInitOptions = {},
): Promise<BunTranspiler> {
  if (runtimeTranspiler) {
    return runtimeTranspiler
  }

  if (runtimeTranspilerLoading) {
    return runtimeTranspilerLoading
  }

  runtimeTranspilerLoading = createInitializedTranspiler({
    defaults: options.defaults,
    cache: options.cache ?? null,
  }).then(transpiler => {
    runtimeTranspiler = transpiler
    return transpiler
  })

  try {
    return await runtimeTranspilerLoading
  } finally {
    runtimeTranspilerLoading = null
  }
}

export function getRuntimeTranspiler(): BunTranspiler {
  if (!runtimeTranspiler) {
    throw new Error('Runtime transpiler is not initialized. Call initRuntimeTranspiler() first.')
  }
  return runtimeTranspiler
}

export function isRuntimeTranspilerReady(): boolean {
  return runtimeTranspiler !== null
}

export function __resetRuntimeTranspilerForTests(): void {
  runtimeTranspiler = null
  runtimeTranspilerLoading = null
}
