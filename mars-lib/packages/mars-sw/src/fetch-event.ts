import type { Disposable } from "@mars/bridge"
import type { ServiceWorkerRouter } from "./router"

export interface MarsServiceWorkerFetchEvent {
  readonly request: Request
  respondWith(response: Response | Promise<Response>): void
}

export interface MarsServiceWorkerScope {
  addEventListener(type: "fetch", listener: (event: MarsServiceWorkerFetchEvent) => void): void
  removeEventListener(type: "fetch", listener: (event: MarsServiceWorkerFetchEvent) => void): void
}

export interface ServiceWorkerFetchHandlerOptions {
  ready?: Promise<unknown>
}

export function createServiceWorkerFetchHandler(
  router: ServiceWorkerRouter,
  options: ServiceWorkerFetchHandlerOptions = {},
): (event: MarsServiceWorkerFetchEvent) => void {
  return event => {
    event.respondWith((async () => {
      await options.ready
      return router.fetch(event.request)
    })())
  }
}

export function installServiceWorkerFetchHandler(
  scope: MarsServiceWorkerScope,
  router: ServiceWorkerRouter,
  options: ServiceWorkerFetchHandlerOptions = {},
): Disposable {
  const listener = createServiceWorkerFetchHandler(router, options)
  scope.addEventListener("fetch", listener)

  return {
    dispose: () => {
      scope.removeEventListener("fetch", listener)
    },
  }
}
