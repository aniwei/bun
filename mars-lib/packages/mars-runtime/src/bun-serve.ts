import type { RuntimeContext, ServeOptions, Server } from "./types"

export class MarsBunServer implements Server {
  readonly port: number
  readonly hostname: string
  readonly url: URL
  readonly #context: RuntimeContext
  #options: ServeOptions
  #stopped = false

  constructor(context: RuntimeContext, options: ServeOptions) {
    this.#context = context
    this.#options = options
    this.port = options.port ?? 3000
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

  reload(options: Partial<ServeOptions>): void {
    this.#options = { ...this.#options, ...options }
  }

  upgrade(request: Request, options?: unknown): boolean {
    void request
    void options
    return false
  }
}

export function bunServe(context: RuntimeContext, options: ServeOptions): Server {
  return new MarsBunServer(context, options)
}