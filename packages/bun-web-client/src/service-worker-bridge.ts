import type { Kernel } from '@mars/web-kernel'
import type {
  BunContainerBootOptions,
  BunContainerWorkerScriptProcessor,
  BunContainerWorkerScriptRecord,
} from './client.types'

type KernelPortResolverLike = {
  resolvePort(port: number): number | null
  subscribe(
    event: 'portRegistered',
    listener: (payload: { pid: number; port: number; host: string; protocol: 'http' | 'https' }) => void,
  ): () => void
}

type ServiceWorkerScopeLike = {
  addEventListener(type: 'fetch' | 'install' | 'activate', listener: Function): void
  removeEventListener?(type: 'fetch' | 'install' | 'activate', listener: Function): void
  skipWaiting?(): Promise<void> | void
  clients?: { claim?(): Promise<void> | void }
}

type ServeHandlerRegistryLike = {
  getHandler(port: number): ((request: Request) => Promise<Response> | Response) | null
}

type WorkerScriptStoreLike = Map<string, BunContainerWorkerScriptRecord>

type KernelServiceWorkerBridgeOptionsLike = {
  workerScripts?: WorkerScriptStoreLike
  scriptProcessor?: BunContainerWorkerScriptProcessor
  moduleRequestBridge?: {
    requestModule(message: {
      type: 'MODULE_REQUEST'
      requestId: string
      pathname: string
      method: string
      headers: Array<[string, string]>
    }): Promise<{
      type: 'MODULE_RESPONSE'
      requestId: string
      status: number
      headers: Array<[string, string]>
      contentType?: string
      buffer?: ArrayBuffer
      error?: string
    }>
  }
}

type ServiceWorkerBridgeOptions = Pick<
  BunContainerBootOptions,
  'serviceWorkerScripts' | 'serviceWorkerScriptProcessor' | 'serveHandlerRegistry'
>

function createKernelSwBridge(kernel: Kernel): KernelPortResolverLike {
  return {
    resolvePort(port: number): number | null {
      return kernel.resolvePort(port)
    },
    subscribe(event, listener) {
      return kernel.subscribe(event, listener)
    },
  }
}

function assertValidWorkerScriptPath(pathname: string): void {
  if (!pathname || typeof pathname !== 'string' || !pathname.startsWith('/')) {
    throw new TypeError('[BunContainer.boot] serviceWorkerScripts key must be an absolute pathname')
  }
}

function assertValidWorkerScriptRecord(pathname: string, record: BunContainerWorkerScriptRecord): void {
  if (typeof record === 'string') return

  if (!record || typeof record !== 'object') {
    throw new TypeError(
      `[BunContainer.boot] serviceWorkerScripts[${pathname}] must be a string or descriptor object`,
    )
  }

  if (typeof record.source !== 'string') {
    throw new TypeError(`[BunContainer.boot] serviceWorkerScripts[${pathname}].source must be a string`)
  }
}

function normalizeWorkerScriptStore(
  scripts: Map<string, BunContainerWorkerScriptRecord> | Record<string, BunContainerWorkerScriptRecord> | undefined,
): WorkerScriptStoreLike | undefined {
  if (!scripts) return undefined

  if (scripts instanceof Map) {
    for (const [pathname, record] of scripts.entries()) {
      assertValidWorkerScriptPath(pathname)
      assertValidWorkerScriptRecord(pathname, record)
    }
    return scripts
  }

  const entries = Object.entries(scripts)
  for (const [pathname, record] of entries) {
    assertValidWorkerScriptPath(pathname)
    assertValidWorkerScriptRecord(pathname, record)
  }

  return new Map(entries)
}

function detectServiceWorkerScope(): ServiceWorkerScopeLike | null {
  const maybeScope = globalThis as unknown as {
    addEventListener?: (type: string, listener: Function) => void
    clients?: unknown
    skipWaiting?: unknown
  }

  if (
    typeof maybeScope.addEventListener === 'function' &&
    (typeof maybeScope.skipWaiting === 'function' || typeof maybeScope.clients === 'object')
  ) {
    return maybeScope as unknown as ServiceWorkerScopeLike
  }

  return null
}

async function registerServiceWorkerFromMainThread(kernel: Kernel, serviceWorkerUrl: string): Promise<boolean> {
  kernel.configureServiceWorker({ url: serviceWorkerUrl })
  try {
    await kernel.publishServiceWorkerBeforeRegister(serviceWorkerUrl)
    await kernel.serviceWorker.register()
    return true
  } catch (error) {
    await kernel.publishServiceWorkerRegisterError({
      stage: 'service-worker.register',
      serviceWorkerUrl,
      error,
    })
    console.warn(
      `[BunContainer] Failed to register service worker at "${serviceWorkerUrl}": ${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
}

function installMainThreadServiceWorkerMessageBridge(kernel: Kernel): (() => void) | null {
  return kernel.serviceWorker.installMessageBridge()
}

export async function createServiceWorkerBridge(
  kernel: Kernel,
  serviceWorkerUrl: string,
  options: ServiceWorkerBridgeOptions,
): Promise<{ uninstall: (() => void) | null; registered: boolean }> {
  const scope = detectServiceWorkerScope()
  if (!scope) {
    const registered = await registerServiceWorkerFromMainThread(kernel, serviceWorkerUrl)
    const uninstallMessageBridge = installMainThreadServiceWorkerMessageBridge(kernel)
    return {
      uninstall: uninstallMessageBridge,
      registered,
    }
  }

  let installKernelServiceWorkerBridgeFn:
    | ((
      kernelBridge: KernelPortResolverLike,
      target: ServiceWorkerScopeLike,
      handlerRegistry: ServeHandlerRegistryLike,
      options?: KernelServiceWorkerBridgeOptionsLike,
    ) => () => void)
    | null = null

  const swCandidates = [
    '@mars/web-sw',
    '../../bun-web-sw/src/index.ts',
  ]

  for (const candidate of swCandidates) {
    try {
      const loaded = await import(candidate) as {
        installKernelServiceWorkerBridge?: (
          kernelBridge: KernelPortResolverLike,
          target: ServiceWorkerScopeLike,
          handlerRegistry: ServeHandlerRegistryLike,
          options?: KernelServiceWorkerBridgeOptionsLike,
        ) => () => void
      }
      if (typeof loaded.installKernelServiceWorkerBridge === 'function') {
        installKernelServiceWorkerBridgeFn = loaded.installKernelServiceWorkerBridge
        break
      }
    } catch {}
  }

  if (!installKernelServiceWorkerBridgeFn) {
    return {
      uninstall: null,
      registered: false,
    }
  }

  let handlerRegistry = options.serveHandlerRegistry as ServeHandlerRegistryLike | undefined
  if (!handlerRegistry) {
    const runtimeCandidates = [
      '@mars/web-runtime',
      '../../bun-web-runtime/src/index.ts',
    ]

    for (const candidate of runtimeCandidates) {
      try {
        const loaded = await import(candidate) as {
          getServeHandler?: (port: number) => ((request: Request) => Promise<Response> | Response) | null
        }
        if (typeof loaded.getServeHandler === 'function') {
          handlerRegistry = {
            getHandler: port => loaded.getServeHandler?.(port) ?? null,
          }
          break
        }
      } catch {}
    }
  }

  if (!handlerRegistry) {
    return {
      uninstall: null,
      registered: false,
    }
  }

  return {
    uninstall: installKernelServiceWorkerBridgeFn(
      createKernelSwBridge(kernel),
      scope,
      handlerRegistry,
      {
        moduleRequestBridge: kernel.serviceWorker.createModuleRequestBridge(),
        workerScripts: normalizeWorkerScriptStore(options.serviceWorkerScripts),
        scriptProcessor: options.serviceWorkerScriptProcessor,
      },
    ),
    registered: false,
  }
}
