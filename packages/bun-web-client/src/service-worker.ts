import { Subscription, type Events } from '@mars/web-shared'
import type { Kernel } from '@mars/web-kernel'

type ServiceWorkerBridgeOptions = {
  scope?: string
}

export class ServiceWorkerBridge extends Subscription<Events> {
  private readonly kernel: Kernel

  constructor(kernal: Kernel) {
    super()

    this.kernel = kernal
  }

  async register(scope?: string): Promise<void> {
    await navigator.serviceWorker.register('@mars/web-sw', { scope })
    navigator.serviceWorker.controller?.addEventListener('message', this.onMessage as EventListener)
  }

  private onMessage = (_event: MessageEvent): void => {
    // noop placeholder: old bridge path is retained only for compatibility.
  }

  postMessage(_message: unknown, _transfer?: Transferable[]): void {
    void this.kernel
  }
}

export function createServiceWorkerBridge(
  kernel: Kernel,
  serviceWorkerUrl: string,
  options: ServiceWorkerBridgeOptions,
): ServiceWorkerBridge {
  void serviceWorkerUrl
  void options
  return new ServiceWorkerBridge(kernel)
}