import { createMarsBridgeEndpoint, createMarsPostMessageBridgeTransport } from "@mars/bridge"

import type { MarsBridgeEndpoint, MarsMessage } from "@mars/bridge"

export interface MarsServiceWorkerContainer {
  readonly controller?: MarsServiceWorkerController | null
  readonly ready?: Promise<MarsServiceWorkerRegistration>
  register(scriptURL: string | URL, options?: MarsServiceWorkerRegistrationOptions): Promise<MarsServiceWorkerRegistration>
}

export interface MarsServiceWorkerRegistration {
  readonly active?: MarsServiceWorkerController | null
  readonly installing?: MarsServiceWorkerController | null
  readonly waiting?: MarsServiceWorkerController | null
  unregister(): Promise<boolean>
}

export interface MarsServiceWorkerController {
  postMessage(message: unknown, transfer?: Transferable[]): void
}

export interface MarsServiceWorkerRegistrationOptions {
  scope?: string
  type?: WorkerType
  updateViaCache?: ServiceWorkerUpdateViaCache
}

export interface MarsServiceWorkerClientOptions {
  scriptURL: string | URL
  scope?: string
  type?: WorkerType
  updateViaCache?: ServiceWorkerUpdateViaCache
  container?: MarsServiceWorkerContainer
  waitUntilReady?: boolean
  createMessageChannel?: () => MessageChannel
}

export interface MarsServiceWorkerClient {
  readonly scriptURL: string | URL
  readonly registration: MarsServiceWorkerRegistration
  readonly endpoint: MarsBridgeEndpoint
  readonly channel: MessageChannel
  readonly ready: boolean
  unregister(): Promise<boolean>
  close(): void
}

export async function registerMarsServiceWorker(
  options: MarsServiceWorkerClientOptions,
): Promise<MarsServiceWorkerClient> {
  const container = options.container ?? defaultServiceWorkerContainer()
  const registration = await container.register(options.scriptURL, {
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.type ? { type: options.type } : {}),
    ...(options.updateViaCache ? { updateViaCache: options.updateViaCache } : {}),
  })
  const readyRegistration = options.waitUntilReady === false
    ? registration
    : await (container.ready ?? Promise.resolve(registration))
  const channel = options.createMessageChannel?.() ?? new MessageChannel()
  const endpoint = createMarsBridgeEndpoint({
    source: "client",
    target: "sw",
    transport: createMarsPostMessageBridgeTransport(channel.port1),
  })
  const controller = readyRegistration.active ?? container.controller
  if (!controller) throw new Error("Mars ServiceWorker registered but no active controller is available")

  controller.postMessage(createConnectMessage(options.scriptURL), [channel.port2])

  return {
    scriptURL: options.scriptURL,
    registration: readyRegistration,
    endpoint,
    channel,
    ready: true,
    unregister: () => readyRegistration.unregister(),
    close: () => {
      endpoint.close()
      channel.port1.close()
      channel.port2.close()
    },
  }
}

function defaultServiceWorkerContainer(): MarsServiceWorkerContainer {
  const serviceWorker = globalThis.navigator?.serviceWorker
  if (!serviceWorker) throw new Error("navigator.serviceWorker is not available in this browser profile")

  return serviceWorker
}

function createConnectMessage(scriptURL: string | URL): MarsMessage<{ scriptURL: string }> {
  return {
    id: `mars-sw-connect-${Date.now()}`,
    type: "sw.connect",
    source: "client",
    target: "sw",
    payload: {
      scriptURL: String(scriptURL),
    },
  }
}
