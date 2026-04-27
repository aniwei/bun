import type { MarsBridgeEndpoint } from "@mars/bridge"
import type { Pid } from "@mars/kernel"
import type { ServiceWorkerKernelClient } from "./router"

export interface BridgeKernelClientOptions {
  endpoint: MarsBridgeEndpoint
}

export interface SerializedMarsRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

export interface SerializedMarsResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export function createBridgeServiceWorkerKernelClient(
  options: BridgeKernelClientOptions,
): ServiceWorkerKernelClient {
  return {
    resolvePort: async port => {
      const response = await options.endpoint.request(
        "kernel.resolvePort",
        { port },
        { target: "kernel" },
      ) as { pid: Pid | null }

      return response.pid
    },
    dispatchToKernel: async (pid, request) => {
      const response = await options.endpoint.request(
        "server.request",
        {
          pid,
          request: await serializeMarsRequest(request),
        },
        { target: "kernel" },
      ) as SerializedMarsResponse

      return deserializeMarsResponse(response)
    },
  }
}

export async function serializeMarsRequest(request: Request): Promise<SerializedMarsRequest> {
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headers[key] = value
  })

  return {
    url: request.url,
    method: request.method,
    headers,
    ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.text() }),
  }
}

export async function serializeMarsResponse(response: Response): Promise<SerializedMarsResponse> {
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

export function deserializeMarsResponse(response: SerializedMarsResponse): Response {
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  })
}

export function deserializeMarsRequest(request: SerializedMarsRequest): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  })
}
