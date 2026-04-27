import { createMarsBridgeEndpoint, createMarsPostMessageBridgeTransport } from "@mars/bridge"
import { createKernelWorkerController } from "./kernel-worker-controller"

import type { MarsBridgeEndpoint, MarsMessage } from "@mars/bridge"
import type { MarsKernel } from "./kernel"
import type { KernelWorkerController } from "./kernel-worker-controller"
import type { MarsProcessWorkerFactory } from "./process-worker-factory"

export interface KernelWorkerMessageEvent {
  readonly data: unknown
  readonly ports?: readonly MessagePort[]
}

export interface KernelWorkerBootstrapScope {
  addEventListener(type: "message", listener: (event: KernelWorkerMessageEvent) => void): void
  removeEventListener(type: "message", listener: (event: KernelWorkerMessageEvent) => void): void
}

export interface KernelWorkerClientBridge {
  readonly endpoint: MarsBridgeEndpoint
  readonly controller: KernelWorkerController
  readonly port: MessagePort
  close(): void
}

export interface KernelWorkerBootstrap {
  readonly clients: readonly KernelWorkerClientBridge[]
  dispose(): void
}

export interface KernelWorkerBootstrapOptions {
  scope: KernelWorkerBootstrapScope
  kernel: MarsKernel
  processWorkerFactory?: MarsProcessWorkerFactory
}

export function installKernelWorkerBootstrap(
  options: KernelWorkerBootstrapOptions,
): KernelWorkerBootstrap {
  return new DefaultKernelWorkerBootstrap(options)
}

class DefaultKernelWorkerBootstrap implements KernelWorkerBootstrap {
  readonly #scope: KernelWorkerBootstrapScope
  readonly #kernel: MarsKernel
  readonly #processWorkerFactory: MarsProcessWorkerFactory | undefined
  readonly #clients = new Set<KernelWorkerClientBridge>()
  readonly #messageListener = (event: KernelWorkerMessageEvent) => {
    this.#handleMessage(event)
  }

  constructor(options: KernelWorkerBootstrapOptions) {
    this.#scope = options.scope
    this.#kernel = options.kernel
    this.#processWorkerFactory = options.processWorkerFactory
    this.#scope.addEventListener("message", this.#messageListener)
  }

  get clients(): readonly KernelWorkerClientBridge[] {
    return [...this.#clients]
  }

  dispose(): void {
    this.#scope.removeEventListener("message", this.#messageListener)

    for (const client of this.#clients) client.close()
    this.#clients.clear()
  }

  #handleMessage(event: KernelWorkerMessageEvent): void {
    const message = event.data as Partial<MarsMessage> | undefined
    if (!message || message.type !== "kernel.connect" || message.target !== "kernel") return

    const port = event.ports?.[0]
    if (!port) throw new Error("Mars Kernel Worker connect message did not include a MessagePort")

    const endpoint = createMarsBridgeEndpoint({
      source: "kernel",
      target: "client",
      transport: createMarsPostMessageBridgeTransport(port),
    })
    const controller = createKernelWorkerController({
      endpoint,
      kernel: this.#kernel,
      processWorkerFactory: this.#processWorkerFactory,
    })
    const client: KernelWorkerClientBridge = {
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
