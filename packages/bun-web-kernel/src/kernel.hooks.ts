import type { Kernel } from './kernel'
import type {
  KernelConfig,
  KernelServiceWorkerHookStage,
} from './kernel.types'

export async function publishServiceWorkerRegisterHooks(options: {
  config: KernelConfig
  kernel: Kernel
  serviceWorkerUrl: string
  registered: boolean
  publishRegisterError(payload: {
    stage: KernelServiceWorkerHookStage
    serviceWorkerUrl: string
    error: unknown
  }): Promise<void>
}): Promise<void> {
  for (const hook of options.config.serviceWorkerRegisterHooks ?? []) {
    try {
      await hook({
        kernel: options.kernel,
        serviceWorkerUrl: options.serviceWorkerUrl,
        registered: options.registered,
      })
    } catch (error) {
      await options.publishRegisterError({
        stage: 'service-worker.register',
        serviceWorkerUrl: options.serviceWorkerUrl,
        error,
      })
    }
  }
}

export async function publishServiceWorkerBeforeRegisterHooks(options: {
  config: KernelConfig
  kernel: Kernel
  serviceWorkerUrl: string
  publishRegisterError(payload: {
    stage: KernelServiceWorkerHookStage
    serviceWorkerUrl: string
    error: unknown
  }): Promise<void>
}): Promise<void> {
  for (const hook of options.config.serviceWorkerBeforeRegisterHooks ?? []) {
    try {
      await hook({
        kernel: options.kernel,
        serviceWorkerUrl: options.serviceWorkerUrl,
      })
    } catch (error) {
      await options.publishRegisterError({
        stage: 'service-worker.before-register',
        serviceWorkerUrl: options.serviceWorkerUrl,
        error,
      })
    }
  }
}

export async function publishServiceWorkerRegisterErrorHooks(options: {
  config: KernelConfig
  kernel: Kernel
  serviceWorkerUrl: string
  stage: KernelServiceWorkerHookStage
  error: unknown
}): Promise<void> {
  for (const hook of options.config.serviceWorkerRegisterErrorHooks ?? []) {
    try {
      await hook({
        kernel: options.kernel,
        serviceWorkerUrl: options.serviceWorkerUrl,
        stage: options.stage,
        error: options.error,
      })
    } catch {
      // register.error hooks are observability-only and must never block boot.
    }
  }
}
