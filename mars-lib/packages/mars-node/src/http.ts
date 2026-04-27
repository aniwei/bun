import { IncomingMessage } from "./incoming-message"
import { ServerResponse } from "./server-response"

import type { MarsKernel } from "@mars/kernel"
import type { Server, ServeOptions } from "@mars/runtime"

export type RequestListener = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>

export interface NodeHttpRuntimeOptions {
  kernel: MarsKernel
  pid?: number
  hostname?: string
}

export class NodeHttpServer {
  readonly #listener: RequestListener
  readonly #options: NodeHttpRuntimeOptions
  readonly #listeners = new Map<string, Set<Function>>()
  #server: Server | null = null

  constructor(listener: RequestListener, options: NodeHttpRuntimeOptions) {
    this.#listener = listener
    this.#options = options
  }

  listen(port = 3000, hostname = this.#options.hostname ?? "mars.localhost", callback?: () => void): this {
    const server = new NodeVirtualServer(port, hostname, this.#listener)
    this.#options.kernel.registerPort(this.#options.pid ?? 1, port, server)
    this.#server = server
    callback?.()
    this.#emit("listening")

    return this
  }

  close(callback?: (error?: Error) => void): this {
    if (this.#server) {
      this.#options.kernel.unregisterPort(this.#server.port)
      this.#server.stop()
      this.#server = null
    }

    callback?.()
    this.#emit("close")
    return this
  }

  address(): { address: string; port: number; family: string } | null {
    if (!this.#server) return null

    return {
      address: this.#server.hostname,
      port: this.#server.port,
      family: "IPv4",
    }
  }

  on(event: "request" | "upgrade" | "listening" | "close" | "error", listener: Function): this {
    const listeners = this.#listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(event, listeners)

    return this
  }

  #emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...args)
    }
  }
}

class NodeVirtualServer implements Server {
  readonly url: URL
  #stopped = false

  constructor(
    readonly port: number,
    readonly hostname: string,
    readonly listener: RequestListener,
  ) {
    this.url = new URL(`http://${hostname}:${port}/`)
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#stopped) return new Response("Server stopped", { status: 503 })

    const incomingMessage = new IncomingMessage(request)
    const serverResponse = new ServerResponse()
    await this.listener(incomingMessage, serverResponse)

    return serverResponse.wait()
  }

  stop(closeActiveConnections = false): void {
    void closeActiveConnections
    this.#stopped = true
  }

  reload(options: Partial<ServeOptions>): void {
    void options
  }

  upgrade(request: Request, options?: unknown): boolean {
    void request
    void options
    return false
  }
}

export function createServer(
  listener: RequestListener,
  options: NodeHttpRuntimeOptions,
): NodeHttpServer {
  return new NodeHttpServer(listener, options)
}