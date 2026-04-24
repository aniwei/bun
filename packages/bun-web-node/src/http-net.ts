import { EventEmitter } from './events-stream'

export interface RequestOptions {
  protocol?: 'http:' | 'https:'
  hostname?: string
  host?: string
  port?: number
  path?: string
  method?: string
  headers?: Record<string, string>
}

export class IncomingMessage {
  constructor(
    readonly statusCode: number,
    readonly headers: Headers,
    private readonly response: Response,
  ) {}

  async text(): Promise<string> {
    return this.response.text()
  }

  async json<T = unknown>(): Promise<T> {
    return (await this.response.json()) as T
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.response.arrayBuffer()
  }
}

function normalizeURL(input: string | URL | RequestOptions): string {
  if (typeof input === 'string') {
    return input
  }

  if (input instanceof URL) {
    return input.toString()
  }

  const protocol = input.protocol ?? 'http:'
  const host = input.host ?? input.hostname ?? '127.0.0.1'
  const path = input.path ?? '/'
  if (input.port) {
    return `${protocol}//${host}:${input.port}${path}`
  }
  return `${protocol}//${host}${path}`
}

class ClientRequest extends EventEmitter {
  private ended = false
  private body: string | Uint8Array | null = null

  constructor(
    private readonly input: string | URL | RequestOptions,
    private readonly options: RequestOptions,
  ) {
    super()
  }

  write(chunk: string | Uint8Array): void {
    if (this.ended) {
      throw new Error('Cannot write after end')
    }
    this.body = chunk
  }

  end(chunk?: string | Uint8Array): void {
    if (chunk !== undefined) {
      this.write(chunk)
    }

    if (this.ended) {
      return
    }

    this.ended = true
    void this.execute()
  }

  private async execute(): Promise<void> {
    const method = this.options.method ?? 'GET'
    const response = await fetch(normalizeURL(this.input), {
      method,
      headers: this.options.headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : (this.body as BodyInit | null),
    })

    const incoming = new IncomingMessage(response.status, response.headers, response)
    this.emit('response', incoming)
  }
}

export function request(
  input: string | URL | RequestOptions,
  optionsOrCallback?: RequestOptions | ((response: IncomingMessage) => void),
  maybeCallback?: (response: IncomingMessage) => void,
): ClientRequest {
  const options = typeof optionsOrCallback === 'function' ? {} : (optionsOrCallback ?? {})
  const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback

  const req = new ClientRequest(input, options)
  if (callback) {
    req.on('response', callback)
  }
  return req
}

export function get(
  input: string | URL | RequestOptions,
  optionsOrCallback?: RequestOptions | ((response: IncomingMessage) => void),
  maybeCallback?: (response: IncomingMessage) => void,
): ClientRequest {
  const options = typeof optionsOrCallback === 'function' ? {} : (optionsOrCallback ?? {})
  const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback

  const req = request(input, { ...options, method: 'GET' }, callback)
  req.end()
  return req
}

export type ServerRequestHandler = (request: Request) => Response | Promise<Response>

export class HTTPServer {
  private listening = false
  private portValue: number | null = null

  constructor(private readonly handler: ServerRequestHandler) {}

  listen(port: number, callback?: () => void): this {
    this.listening = true
    this.portValue = port
    callback?.()
    return this
  }

  close(callback?: () => void): this {
    this.listening = false
    this.portValue = null
    callback?.()
    return this
  }

  address(): { port: number } | null {
    if (!this.listening || this.portValue === null) {
      return null
    }
    return { port: this.portValue }
  }

  async emitRequest(request: Request): Promise<Response> {
    return this.handler(request)
  }
}

export function createServer(handler: ServerRequestHandler): HTTPServer {
  return new HTTPServer(handler)
}
