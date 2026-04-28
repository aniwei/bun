import { upgradeToWebSocket } from "./websocket-pair"

import type { RuntimeContext, ServeOptions, Server, WebSocketHandlerOptions } from "./types"

export class MarsBunServer<T = undefined> implements Server {
  readonly port: number
  readonly hostname: string
  readonly url: URL
  readonly #context: RuntimeContext
  #options: ServeOptions<T>
  #stopped = false

  constructor(context: RuntimeContext, options: ServeOptions<T>) {
    this.#context = context
    this.#options = options
    this.port = this.#context.kernel.allocatePort(options.port ?? 3000)
    this.hostname = options.hostname ?? "mars.localhost"
    this.url = new URL(`http://${this.hostname}:${this.port}/`)

    this.#context.kernel.registerPort(this.#context.pid ?? 1, this.port, this)
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#stopped) return new Response("Server stopped", { status: 503 })

    try {
      return await this.#options.fetch(request, this)
    } catch (error) {
      if (this.#options.error) return this.#options.error(error)

      return new Response(error instanceof Error ? error.message : String(error), { status: 500 })
    }
  }

  stop(closeActiveConnections = false): void {
    void closeActiveConnections
    if (this.#stopped) return

    this.#context.kernel.unregisterPort(this.port)
    this.#stopped = true
  }

  reload(options: Partial<ServeOptions<T>>): void {
    this.#options = { ...this.#options, ...options }
  }

  upgrade(request: Request, options?: { data?: T }): boolean {
    const wsHandler = this.#options.websocket as WebSocketHandlerOptions<T> | undefined
    if (!wsHandler) return false

    const upgradeHeader = request.headers.get("upgrade")
    const isWsUpgrade = upgradeHeader?.toLowerCase() === "websocket"
    if (!isWsUpgrade) return false

    const data = options?.data ?? (undefined as unknown as T)
    upgradeToWebSocket<T>(wsHandler, data)
    return true
  }
}

export function bunServe<T = undefined>(context: RuntimeContext, options: ServeOptions<T>): Server {
  return new MarsBunServer<T>(context, options)
}