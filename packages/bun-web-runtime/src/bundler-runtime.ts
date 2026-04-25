import { initEsbuildWasm, type InitEsbuildWasmOptions } from '@mars/web-bundler'

export interface RuntimeBundlerInitOptions extends InitEsbuildWasmOptions {}

let runtimeBundlerReady = false
let runtimeBundlerLoading: Promise<void> | null = null

export async function initRuntimeBundler(
  options: RuntimeBundlerInitOptions = {},
): Promise<void> {
  if (runtimeBundlerReady) {
    return
  }

  if (runtimeBundlerLoading) {
    return runtimeBundlerLoading
  }

  runtimeBundlerLoading = initEsbuildWasm(options).then(() => {
    runtimeBundlerReady = true
  })

  try {
    await runtimeBundlerLoading
  } finally {
    runtimeBundlerLoading = null
  }
}

export function isRuntimeBundlerReady(): boolean {
  return runtimeBundlerReady
}

export function __resetRuntimeBundlerForTests(): void {
  runtimeBundlerReady = false
  runtimeBundlerLoading = null
}
