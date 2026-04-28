import { classifyRequest } from "./classify-request"
import { createModuleResponse } from "./module-response"
import { handleWebSocketRoute } from "./websocket-route"
import { applyVFSPatches } from "@mars/vfs"

import type { MarsStats, MarsVFSPatch } from "@mars/vfs"
import type { Pid } from "@mars/kernel"
import type { ModuleResponseOptions } from "./module-response"
import type { RequestKind } from "./classify-request"

export interface ServiceWorkerKernelClient {
  resolvePort(port: number): Promise<Pid | null>
  dispatchToKernel(pid: Pid, request: Request): Promise<Response>
}

export interface ServiceWorkerVFSClient {
  readFile(path: string): Promise<Uint8Array | null>
  stat(path: string): Promise<MarsStats | null>
  contentType(path: string): string
}

export interface ServiceWorkerRuntimeOptions {
  scope?: string
  virtualHosts?: string[]
  kernelClient: ServiceWorkerKernelClient
  vfsClient: ServiceWorkerVFSClient
  moduleClient?: ModuleResponseOptions
  fallback?: "network" | "404"
}

export interface FetchRouteContext {
  request: Request
  url: URL
  kind: RequestKind
}

export class ServiceWorkerRouter {
  readonly #kernelClient: ServiceWorkerKernelClient
  readonly #vfsClient: ServiceWorkerVFSClient
  readonly #moduleClient?: ModuleResponseOptions
  readonly #fallback: "network" | "404"

  constructor(options: ServiceWorkerRuntimeOptions) {
    this.#kernelClient = options.kernelClient
    this.#vfsClient = options.vfsClient
    this.#moduleClient = options.moduleClient
    this.#fallback = options.fallback ?? "404"
  }

  async match(request: Request): Promise<FetchRouteContext | null> {
    const url = new URL(request.url)
    const kind = classifyRequest(url)

    if (kind === "external" && this.#fallback === "network") return null

    return { request, url, kind }
  }

  async handle(context: FetchRouteContext): Promise<Response> {
    if (context.kind === "websocket") return handleWebSocketRoute({ url: context.url, request: context.request })
    if (context.kind === "virtual-server") return this.#handleVirtualServer(context)
    if (context.kind === "module" && this.#moduleClient) return this.#handleModule(context)
    if (context.kind === "vfs-asset" || context.kind === "module") return this.#handleVFSAsset(context)

    return new Response("Not found", { status: 404 })
  }

  async fetch(request: Request): Promise<Response> {
    const context = await this.match(request)
    if (!context) return globalThis.fetch(request)

    return this.handle(context)
  }

  async applyVFSPatches(patches: readonly MarsVFSPatch[]): Promise<void> {
    if (!this.#moduleClient) throw new Error("ServiceWorker module client is not configured")
    await applyVFSPatches(this.#moduleClient.vfs, patches)
  }

  async #handleVirtualServer(context: FetchRouteContext): Promise<Response> {
    const pid = await this.#kernelClient.resolvePort(Number(context.url.port || 80))
    if (pid === null) return new Response("Port not found", { status: 404 })

    return this.#kernelClient.dispatchToKernel(pid, context.request)
  }

  async #handleVFSAsset(context: FetchRouteContext): Promise<Response> {
    const path = decodeURIComponent(
      context.url.pathname.replace(/^\/__mars__\/vfs/, "") || "/workspace/index.html",
    )
    const data = await this.#vfsClient.readFile(path)
    if (!data) return new Response("File not found", { status: 404 })

    const body = new ArrayBuffer(data.byteLength)
    new Uint8Array(body).set(data)

    return new Response(body, {
      headers: {
        "content-type": this.#vfsClient.contentType(path),
      },
    })
  }

  async #handleModule(context: FetchRouteContext): Promise<Response> {
    const moduleClient = this.#moduleClient
    if (!moduleClient) return new Response("Module client not configured", { status: 500 })

    const response = await createModuleResponse(context.url.href, {
      format: "esm",
      ...moduleClient,
    })

    if (response.status === 404 && this.#fallback === "network" && !context.url.pathname.startsWith("/__mars__/module")) {
      return globalThis.fetch(context.request)
    }

    return response
  }
}

export function createServiceWorkerRouter(options: ServiceWorkerRuntimeOptions): ServiceWorkerRouter {
  return new ServiceWorkerRouter(options)
}