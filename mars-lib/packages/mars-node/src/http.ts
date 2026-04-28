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

export interface NodeHttpCompatModule {
  createServer(listener: RequestListener): NodeHttpServer
  IncomingMessage: typeof IncomingMessage
  METHODS: string[]
  ServerResponse: typeof ServerResponse
  STATUS_CODES: Record<number, string>
}

export const METHODS = [
  "ACL",
  "BIND",
  "CHECKOUT",
  "CONNECT",
  "COPY",
  "DELETE",
  "GET",
  "HEAD",
  "LINK",
  "LOCK",
  "M-SEARCH",
  "MERGE",
  "MKACTIVITY",
  "MKCALENDAR",
  "MKCOL",
  "MOVE",
  "NOTIFY",
  "OPTIONS",
  "PATCH",
  "POST",
  "PROPFIND",
  "PROPPATCH",
  "PURGE",
  "PUT",
  "REBIND",
  "REPORT",
  "SEARCH",
  "SOURCE",
  "SUBSCRIBE",
  "TRACE",
  "UNBIND",
  "UNLINK",
  "UNLOCK",
  "UNSUBSCRIBE",
]

export const STATUS_CODES: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  500: "Internal Server Error",
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

  listen(port = 3000, hostnameOrCallback: string | (() => void) = this.#options.hostname ?? "mars.localhost", callback?: () => void): this {
    const hostname = typeof hostnameOrCallback === "string"
      ? hostnameOrCallback
      : this.#options.hostname ?? "mars.localhost"
    const onListening = typeof hostnameOrCallback === "function" ? hostnameOrCallback : callback
    const assignedPort = this.#options.kernel.allocatePort(port)
    const server = new NodeVirtualServer(assignedPort, hostname, this.#listener, (event, ...args) => this.#emit(event, ...args))
    this.#options.kernel.registerPort(this.#options.pid ?? 1, assignedPort, server)
    this.#server = server
    onListening?.()
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
    readonly emit: (event: "request", request: IncomingMessage, response: ServerResponse) => void,
  ) {
    this.url = new URL(`http://${hostname}:${port}/`)
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#stopped) return new Response("Server stopped", { status: 503 })

    const incomingMessage = new IncomingMessage(request)
    const serverResponse = new ServerResponse()
    this.emit("request", incomingMessage, serverResponse)
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

export function createNodeHttpModule(options: NodeHttpRuntimeOptions): NodeHttpCompatModule {
  return {
    createServer: listener => createServer(listener, options),
    IncomingMessage,
    METHODS,
    ServerResponse,
    STATUS_CODES,
  }
}