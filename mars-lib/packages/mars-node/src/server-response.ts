import { EventEmitter } from "./core"

export class ServerResponse extends EventEmitter {
  statusCode = 200
  statusMessage = "OK"
  readonly #headers = new Headers()
  readonly #chunks: Uint8Array[] = []
  #ended = false
  #resolveFinished!: (response: Response) => void
  readonly #finished = new Promise<Response>(resolve => {
    this.#resolveFinished = resolve
  })

  get headersSent(): boolean {
    return this.#ended
  }

  get finished(): boolean {
    return this.#ended
  }

  get writableEnded(): boolean {
    return this.#ended
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.#headers.set(name, Array.isArray(value) ? value.join(", ") : String(value))
    return this
  }

  getHeader(name: string): string | null {
    return this.#headers.get(name)
  }

  getHeaders(): Record<string, string> {
    return Object.fromEntries(this.#headers.entries())
  }

  removeHeader(name: string): this {
    this.#headers.delete(name)
    return this
  }

  writeHead(statusCode: number, headers?: Record<string, string | number>): this {
    this.statusCode = statusCode
    for (const [name, value] of Object.entries(headers ?? {})) {
      this.setHeader(name, value)
    }

    return this
  }

  write(chunk: string | Uint8Array): boolean {
    this.#chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk)
    return true
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined) this.write(chunk)
    if (this.#ended) return this

    this.#ended = true
  this.emit("finish")
  this.emit("close")
    this.#resolveFinished(this.toResponse())
    return this
  }

  send(body: string | Uint8Array | object): this {
    if (typeof body === "object" && !(body instanceof Uint8Array)) {
      this.setHeader("content-type", "application/json; charset=utf-8")
      return this.end(JSON.stringify(body))
    }

    return this.end(body)
  }

  wait(): Promise<Response> {
    return this.#finished
  }

  toResponse(): Response {
    const byteLength = this.#chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    const body = new Uint8Array(byteLength)
    let offset = 0

    for (const chunk of this.#chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }

    if (!this.#headers.has("content-type")) {
      this.#headers.set("content-type", "text/plain; charset=utf-8")
    }

    return new Response(body, {
      status: this.statusCode,
      headers: this.#headers,
    })
  }
}