import type {
  KernelBootHook,
  KernelInitializerTask,
  KernelServiceWorkerHookStage,
} from './kernel.types'

const FALLBACK_SERVICE_WORKER_URL = '/sw.js'

let cachedDefaultServiceWorkerUrl: string | null = null

export async function resolveKernelServiceWorkerUrl(explicitServiceWorkerUrl?: string): Promise<string> {
  const explicit = explicitServiceWorkerUrl?.trim()
  if (explicit) {
    return explicit
  }

  if (cachedDefaultServiceWorkerUrl) {
    return cachedDefaultServiceWorkerUrl
  }

  const swCandidates = [
    '@mars/web-sw',
    '../../bun-web-sw/src/index.ts',
  ]

  for (const candidate of swCandidates) {
    try {
      const loaded = await import(candidate) as {
        DEFAULT_WEB_SW_SERVICE_WORKER_URL?: string
      }
      const resolved = loaded.DEFAULT_WEB_SW_SERVICE_WORKER_URL?.trim()
      if (resolved) {
        cachedDefaultServiceWorkerUrl = resolved
        return resolved
      }
    } catch {}
  }

  cachedDefaultServiceWorkerUrl = FALLBACK_SERVICE_WORKER_URL
  return cachedDefaultServiceWorkerUrl
}

export function createKernelBootHooksInitializer(options: {
  bootHooks?: KernelBootHook[]
  publishRegisterError(payload: {
    stage: KernelServiceWorkerHookStage
    serviceWorkerUrl: string
    error: unknown
  }): Promise<void>
}): KernelInitializerTask {
  return {
    id: 'kernel-boot-hooks',
    order: 100,
    run: async context => {
      for (const hook of options.bootHooks ?? []) {
        try {
          await hook({
            kernel: context.kernel,
            serviceWorkerUrl: context.serviceWorkerUrl,
          })
        } catch (error) {
          await options.publishRegisterError({
            stage: 'boot',
            serviceWorkerUrl: context.serviceWorkerUrl,
            error,
          })
        }
      }
    },
  }
}
