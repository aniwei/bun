import type { BuildOptions, BuildResult, Plugin } from 'esbuild-wasm'
import { WasmModuleLoader } from '@mars/web-shared/wasm-module-loader'

type EsbuildWasmLike = {
  initialize(options: {
    wasmURL?: string
    wasmModule?: WebAssembly.Module
    worker?: boolean
  }): Promise<void>
  build(options: BuildOptions): Promise<BuildResult>
  stop?: () => void
  context?: unknown
}

type EsbuildWasmLoader = () => Promise<EsbuildWasmLike | null>

const defaultLoader: EsbuildWasmLoader = async () => {
  const loaded = (await import('esbuild-wasm')) as EsbuildWasmLike
  return loaded
}

const esbuildWasmRuntime = new WasmModuleLoader<EsbuildWasmLike>(defaultLoader)
let esbuildWasmReady = false

export interface InitEsbuildWasmOptions {
  wasmURL?: string
  wasmModule?: WebAssembly.Module
  worker?: boolean
}

type GlobalEsbuildWasmInitOptions = {
  wasmURL?: string
  wasmModule?: WebAssembly.Module
  worker?: boolean
}

const ESBUILD_WASM_GLOBAL_INIT_KEY = '__BUN_WEB_ESBUILD_WASM__'

function isBrowserLikeRuntime(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function isDuplicateInitializeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Cannot call "initialize" more than once')
}

function isWasmOptionRejectedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('"wasmURL" option only works in the browser') ||
    message.includes('"wasmModule" option only works in the browser')
  )
}

function isWorkerUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('Worker is not defined') ||
    message.includes('worker is not defined') ||
    message.includes('Failed to construct \"Worker\"') ||
    message.includes('Cannot construct worker')
  )
}

async function initializeWithHandledDuplicate(
  loaded: EsbuildWasmLike,
  options: InitEsbuildWasmOptions,
): Promise<void> {
  try {
    await loaded.initialize(options)
  } catch (error) {
    if (!isDuplicateInitializeError(error)) {
      throw error
    }
  }
}

export function resolveEsbuildWasmInitOptions(options: InitEsbuildWasmOptions = {}): InitEsbuildWasmOptions {
  const globalOptions =
    (globalThis as Record<string, unknown>)[ESBUILD_WASM_GLOBAL_INIT_KEY] as
      | GlobalEsbuildWasmInitOptions
      | undefined

  const worker =
    options.worker ??
    globalOptions?.worker ??
    isBrowserLikeRuntime()

  return {
    wasmURL: options.wasmURL ?? globalOptions?.wasmURL,
    wasmModule: options.wasmModule ?? globalOptions?.wasmModule,
    worker,
  }
}

async function loadEsbuildWasmModule(): Promise<EsbuildWasmLike | null> {
  return esbuildWasmRuntime.load()
}

export async function initEsbuildWasm(options: InitEsbuildWasmOptions = {}): Promise<void> {
  if (esbuildWasmReady) {
    return
  }

  const resolvedOptions = resolveEsbuildWasmInitOptions(options)

  const loaded = await loadEsbuildWasmModule()
  if (!loaded) {
    throw new Error('Failed to load esbuild-wasm module')
  }

  const worker = resolvedOptions.worker ?? false
  const hasWasmInput = Boolean(resolvedOptions.wasmURL || resolvedOptions.wasmModule)

  if (!hasWasmInput) {
    try {
      await initializeWithHandledDuplicate(loaded, { worker })
    } catch (error) {
      if (!(worker && isWorkerUnavailableError(error))) {
        throw error
      }

      await initializeWithHandledDuplicate(loaded, { worker: false })
    }
    esbuildWasmReady = true
    return
  }

  try {
    await initializeWithHandledDuplicate(loaded, {
      wasmURL: resolvedOptions.wasmURL,
      wasmModule: resolvedOptions.wasmModule,
      worker,
    })
  } catch (error) {
    if (worker && isWorkerUnavailableError(error)) {
      await initializeWithHandledDuplicate(loaded, {
        wasmURL: resolvedOptions.wasmURL,
        wasmModule: resolvedOptions.wasmModule,
        worker: false,
      })
    } else {
      if (!isWasmOptionRejectedError(error)) {
        throw error
      }

      try {
        await initializeWithHandledDuplicate(loaded, { worker })
      } catch (fallbackError) {
        if (!(worker && isWorkerUnavailableError(fallbackError))) {
          throw fallbackError
        }

        await initializeWithHandledDuplicate(loaded, { worker: false })
      }
    }
  }

  esbuildWasmReady = true
}

export function isEsbuildWasmReady(): boolean {
  return esbuildWasmReady
}

export async function getEsbuildWasmBuild(): Promise<(options: BuildOptions) => Promise<BuildResult>> {
  if (!esbuildWasmReady) {
    throw new Error('esbuild-wasm is not initialized; call initEsbuildWasm() first')
  }

  const loaded = await loadEsbuildWasmModule()
  if (!loaded) {
    throw new Error('esbuild-wasm is not initialized; call initEsbuildWasm() first')
  }

  return loaded.build.bind(loaded)
}

export function __setEsbuildWasmLoaderForTests(loader: EsbuildWasmLoader): void {
  esbuildWasmRuntime.setFactory(loader)
  esbuildWasmReady = false
}

export function __resetEsbuildWasmForTests(): void {
  esbuildWasmRuntime.resetFactory()
  esbuildWasmReady = false
}

export type { Plugin }