import type { MarsBridgeEndpoint } from "@mars/bridge"
import type { MarsVFSPatch } from "@mars/vfs"
import type { ServiceWorkerRouter } from "./router"

export interface ServiceWorkerFetchPayload {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface ServiceWorkerFetchResult {
  status: number
  headers: Record<string, string>
  body: string
}

export interface ServiceWorkerVFSPatchPayload {
  patches: MarsVFSPatch[]
}

export interface ServiceWorkerVFSPatchResult {
  ok: boolean
  count: number
}

export interface ServiceWorkerBridgeController {
  fetch(payload: ServiceWorkerFetchPayload): Promise<ServiceWorkerFetchResult>
  patchVFS(payload: ServiceWorkerVFSPatchPayload): Promise<ServiceWorkerVFSPatchResult>
  dispose(): void
}

export interface ServiceWorkerBridgeControllerOptions {
  endpoint: MarsBridgeEndpoint
  router: ServiceWorkerRouter
  ready?: Promise<unknown>
}

export function createServiceWorkerBridgeController(
  options: ServiceWorkerBridgeControllerOptions,
): ServiceWorkerBridgeController {
  const controller = new DefaultServiceWorkerBridgeController(options.router, options.ready)
  const fetchDisposable = options.endpoint.on<ServiceWorkerFetchPayload>(
    "sw.fetch",
    payload => controller.fetch(payload),
  )
  const patchDisposable = options.endpoint.on<ServiceWorkerVFSPatchPayload>(
    "sw.vfs.patch",
    payload => controller.patchVFS(payload),
  )

  return {
    fetch: payload => controller.fetch(payload),
    patchVFS: payload => controller.patchVFS(payload),
    dispose: () => {
      patchDisposable.dispose()
      fetchDisposable.dispose()
    },
  }
}

class DefaultServiceWorkerBridgeController implements ServiceWorkerBridgeController {
  readonly #router: ServiceWorkerRouter
  readonly #ready: Promise<unknown> | undefined

  constructor(router: ServiceWorkerRouter, ready?: Promise<unknown>) {
    this.#router = router
    this.#ready = ready
  }

  async fetch(payload: ServiceWorkerFetchPayload): Promise<ServiceWorkerFetchResult> {
    await this.#ready
    const response = await this.#router.fetch(new Request(payload.url, {
      method: payload.method ?? "GET",
      headers: payload.headers,
      body: payload.body,
    }))

    return serializeResponse(response)
  }

  async patchVFS(payload: ServiceWorkerVFSPatchPayload): Promise<ServiceWorkerVFSPatchResult> {
    await this.#ready
    await this.#router.applyVFSPatches(payload.patches)
    return { ok: true, count: payload.patches.length }
  }

  dispose(): void {}
}

async function serializeResponse(response: Response): Promise<ServiceWorkerFetchResult> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })

  return {
    status: response.status,
    headers,
    body: await response.text(),
  }
}
