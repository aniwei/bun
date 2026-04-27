import { createMarsBridgeEndpoint, createMarsPostMessageBridgeTransport } from "@mars/bridge"
import { createServiceWorkerBridgeController } from "./bridge-controller"
import { installServiceWorkerFetchHandler } from "./fetch-event"

import type { Disposable, MarsBridgeEndpoint, MarsMessage } from "@mars/bridge"
import type { ServiceWorkerBridgeController } from "./bridge-controller"
import type { MarsServiceWorkerFetchEvent } from "./fetch-event"
import type { ServiceWorkerRouter } from "./router"

export interface MarsServiceWorkerMessageEvent {
  readonly data: unknown
  readonly ports?: readonly MessagePort[]
}

export interface MarsServiceWorkerBootstrapScope {
  addEventListener(type: "fetch", listener: (event: MarsServiceWorkerFetchEvent) => void): void
  addEventListener(type: "message", listener: (event: MarsServiceWorkerMessageEvent) => void): void
  removeEventListener(type: "fetch", listener: (event: MarsServiceWorkerFetchEvent) => void): void
  removeEventListener(type: "message", listener: (event: MarsServiceWorkerMessageEvent) => void): void
}

export interface ServiceWorkerClientBridge {
  readonly endpoint: MarsBridgeEndpoint
  readonly controller: ServiceWorkerBridgeController
  readonly port: MessagePort
  close(): void
}

export interface ServiceWorkerBootstrap {
  readonly clients: readonly ServiceWorkerClientBridge[]
  dispose(): void
}

export interface ServiceWorkerBootstrapOptions {
  scope: MarsServiceWorkerBootstrapScope
  router: ServiceWorkerRouter
  ready?: Promise<unknown>
}

export function installServiceWorkerBootstrap(
  options: ServiceWorkerBootstrapOptions,
): ServiceWorkerBootstrap {
  return new DefaultServiceWorkerBootstrap(options)
}

class DefaultServiceWorkerBootstrap implements ServiceWorkerBootstrap {
  readonly #scope: MarsServiceWorkerBootstrapScope
  readonly #router: ServiceWorkerRouter
  readonly #ready: Promise<unknown> | undefined
  readonly #clients = new Set<ServiceWorkerClientBridge>()
  readonly #fetchDisposable: Disposable
  readonly #messageListener = (event: MarsServiceWorkerMessageEvent) => {
    this.#handleMessage(event)
  }

  constructor(options: ServiceWorkerBootstrapOptions) {
    this.#scope = options.scope
    this.#router = options.router
    this.#ready = options.ready
    this.#fetchDisposable = installServiceWorkerFetchHandler(this.#scope, this.#router, { ready: this.#ready })
    this.#scope.addEventListener("message", this.#messageListener)
  }

  get clients(): readonly ServiceWorkerClientBridge[] {
    return [...this.#clients]
  }

  dispose(): void {
    this.#scope.removeEventListener("message", this.#messageListener)
    this.#fetchDisposable.dispose()

    for (const client of this.#clients) client.close()
    this.#clients.clear()
  }

  #handleMessage(event: MarsServiceWorkerMessageEvent): void {
    const message = event.data as Partial<MarsMessage> | undefined
    if (!message || message.type !== "sw.connect" || message.target !== "sw") return

    const port = event.ports?.[0]
    if (!port) throw new Error("Mars ServiceWorker connect message did not include a MessagePort")

    const endpoint = createMarsBridgeEndpoint({
      source: "sw",
      target: "client",
      transport: createMarsPostMessageBridgeTransport(port),
    })
    const controller = createServiceWorkerBridgeController({
      endpoint,
      router: this.#router,
      ready: this.#ready,
    })
    const client: ServiceWorkerClientBridge = {
      endpoint,
      controller,
      port,
      close: () => {
        controller.dispose()
        endpoint.close()
        port.close()
        this.#clients.delete(client)
      },
    }

    this.#clients.add(client)
  }
}
