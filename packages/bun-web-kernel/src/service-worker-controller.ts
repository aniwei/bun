export type KernelServiceWorkerRegistrationConfig = {
  url: string
  options?: RegistrationOptions
}

export type KernelModuleRequestMessage = {
  type: 'MODULE_REQUEST'
  requestId: string
  pathname: string
  method: string
  headers: Array<[string, string]>
}

export type KernelModuleResponseMessage = {
  type: 'MODULE_RESPONSE'
  requestId: string
  status: number
  headers: Array<[string, string]>
  contentType?: string
  buffer?: ArrayBuffer
  error?: string
}

export type KernelModuleRequestProtocolHandler = (
  request: KernelModuleRequestMessage,
) => Promise<KernelModuleResponseMessage> | KernelModuleResponseMessage

export type KernelModuleRequestBridge = {
  requestModule(message: KernelModuleRequestMessage): Promise<KernelModuleResponseMessage>
}

export type KernelModuleRequestTransport = {
  send(message: KernelModuleRequestMessage): void | Promise<void>
}

export type KernelModuleMessage = KernelModuleRequestMessage | KernelModuleResponseMessage

type PendingModuleRequest = {
  resolve: (response: KernelModuleResponseMessage) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout>
}

const DEFAULT_MODULE_REQUEST_TIMEOUT_MS = 5000

function getServiceWorkerContainer(): ServiceWorkerContainer | null {
  const nav = globalThis.navigator as Navigator | undefined
  return nav?.serviceWorker ?? null
}

export class KernelServiceWorkerController {
  private registrationConfig: KernelServiceWorkerRegistrationConfig | null = null
  private moduleRequestHandler: KernelModuleRequestProtocolHandler | null = null
  private moduleRequestTransport: KernelModuleRequestTransport | null = null
  private readonly pendingModuleRequests = new Map<string, PendingModuleRequest>()
  private moduleMessageListener: ((event: MessageEvent<KernelModuleMessage>) => void) | null = null

  dispose(reason = 'Kernel service worker controller disposed'): void {
    const serviceWorker = getServiceWorkerContainer()
    if (serviceWorker && this.moduleMessageListener) {
      serviceWorker.removeEventListener?.('message', this.moduleMessageListener)
    }

    for (const [, pending] of this.pendingModuleRequests) {
      clearTimeout(pending.timeoutId)
      pending.reject(new Error(reason))
    }

    this.pendingModuleRequests.clear()
    this.registrationConfig = null
    this.moduleRequestHandler = null
    this.moduleRequestTransport = null
    this.moduleMessageListener = null
  }

  configure(config: KernelServiceWorkerRegistrationConfig): void {
    this.registrationConfig = {
      url: config.url,
      options: config.options,
    }
  }

  configureModuleRequestHandler(handler: KernelModuleRequestProtocolHandler | null | undefined): void {
    this.moduleRequestHandler = handler ?? null
  }

  configureModuleRequestTransport(transport: KernelModuleRequestTransport | null | undefined): void {
    this.moduleRequestTransport = transport ?? null
  }

  createModuleRequestBridge(options: { timeoutMs?: number } = {}): KernelModuleRequestBridge {
    return {
      requestModule: message => this.dispatchModuleRequest(message, options.timeoutMs),
    }
  }

  createModuleMessageListener(): (event: MessageEvent<KernelModuleMessage> | { data: KernelModuleMessage }) => void {
    return event => {
      void this.handleModuleMessage(event.data)
    }
  }

  installMessageBridge(): (() => void) | null {
    const serviceWorker = getServiceWorkerContainer()
    if (!serviceWorker?.addEventListener) {
      return null
    }

    const listener =
      this.moduleMessageListener ??
      (this.createModuleMessageListener() as (event: MessageEvent<KernelModuleMessage>) => void)
    this.moduleMessageListener = listener
    serviceWorker.addEventListener('message', listener)

    return () => {
      serviceWorker.removeEventListener?.('message', listener)
      if (this.moduleMessageListener === listener) {
        this.moduleMessageListener = null
      }
    }
  }

  private dispatchModuleRequest(
    request: KernelModuleRequestMessage,
    timeoutMs = DEFAULT_MODULE_REQUEST_TIMEOUT_MS,
  ): Promise<KernelModuleResponseMessage> {
    return new Promise((resolve, reject) => {
      if (this.pendingModuleRequests.has(request.requestId)) {
        reject(new Error(`Duplicate module request id: ${request.requestId}`))
        return
      }

      const timeoutId = setTimeout(() => {
        if (!this.pendingModuleRequests.has(request.requestId)) {
          return
        }

        this.pendingModuleRequests.delete(request.requestId)
        reject(new Error(`Module request timed out: ${request.pathname}`))
      }, timeoutMs)

      this.pendingModuleRequests.set(request.requestId, {
        resolve,
        reject,
        timeoutId,
      })

      const transport = this.resolveModuleRequestTransport()
      if (transport) {
        Promise.resolve(transport.send(request)).catch(error => {
          const pending = this.pendingModuleRequests.get(request.requestId)
          if (!pending) {
            return
          }

          clearTimeout(pending.timeoutId)
          this.pendingModuleRequests.delete(request.requestId)
          pending.reject(error instanceof Error ? error : new Error(String(error)))
        })
        return
      }

      queueMicrotask(() => {
        void this.receiveModuleRequest(request)
      })
    })
  }

  private resolveModuleRequestTransport(): KernelModuleRequestTransport | null {
    if (this.moduleRequestTransport) {
      return this.moduleRequestTransport
    }

    return {
      send: message => {
        const ok = this.postMessageToActive(message)
        if (!ok) {
          throw new Error('No active service worker controller available for module request transport')
        }
      },
    }
  }

  async handleModuleMessage(message: KernelModuleMessage): Promise<boolean> {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return false
    }

    if (message.type === 'MODULE_REQUEST') {
      await this.receiveModuleRequest(message)
      return true
    }

    if (message.type === 'MODULE_RESPONSE') {
      this.receiveModuleResponse(message)
      return true
    }

    return false
  }

  async receiveModuleRequest(request: KernelModuleRequestMessage): Promise<void> {
    const handler = this.moduleRequestHandler
    if (!handler) {
      this.receiveModuleResponse({
        type: 'MODULE_RESPONSE',
        requestId: request.requestId,
        status: 404,
        headers: [],
        error: `Kernel module request handler not found for ${request.pathname}`,
      })
      return
    }

    try {
      const response = await handler(request)
      this.receiveModuleResponse(response)
    } catch (error) {
      this.receiveModuleResponse({
        type: 'MODULE_RESPONSE',
        requestId: request.requestId,
        status: 500,
        headers: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  receiveModuleResponse(response: KernelModuleResponseMessage): void {
    const pending = this.pendingModuleRequests.get(response.requestId)
    if (!pending) {
      return
    }

    clearTimeout(pending.timeoutId)
    this.pendingModuleRequests.delete(response.requestId)
    pending.resolve(response)
  }

  async register(): Promise<ServiceWorkerRegistration | null> {
    const serviceWorker = getServiceWorkerContainer()
    const config = this.registrationConfig

    if (!serviceWorker || !config || typeof window === 'undefined') {
      return null
    }

    const registration = await serviceWorker.register(config.url, config.options)
    await serviceWorker.ready
    return registration
  }

  async unregister(): Promise<boolean> {
    const registration = await this.getRegistration()
    if (!registration) {
      return false
    }

    return registration.unregister()
  }

  async getRegistration(): Promise<ServiceWorkerRegistration | null> {
    const serviceWorker = getServiceWorkerContainer()
    if (!serviceWorker || !this.registrationConfig) {
      return null
    }

    if (typeof serviceWorker.getRegistration === 'function') {
      return (await serviceWorker.getRegistration()) ?? null
    }

    return null
  }

  async getRegistrations(): Promise<ServiceWorkerRegistration[]> {
    const serviceWorker = getServiceWorkerContainer()
    if (!serviceWorker) {
      return []
    }

    if (typeof serviceWorker.getRegistrations === 'function') {
      return Array.from(await serviceWorker.getRegistrations())
    }

    const registration = await this.getRegistration()
    return registration ? [registration] : []
  }

  postMessageToActive(message: unknown, transfer?: Transferable[]): boolean {
    void transfer

    const serviceWorker = getServiceWorkerContainer()
    const active = serviceWorker?.controller
    if (!active) {
      return false
    }

    if (transfer && transfer.length > 0) {
      active.postMessage(message, transfer)
      return true
    }

    active.postMessage(message)
    return true
  }
}
