import { EventEmitter } from './events-stream'
import {
  VirtualSocket as TunnelVirtualSocket,
  createSecureContext as createTunnelSecureContext,
} from '@mars/web-net'

export interface RequestOptions {
  protocol?: 'http:' | 'https:'
  hostname?: string
  host?: string
  port?: number
  path?: string
  method?: string
  headers?: Record<string, string>
}

let configuredTunnelUrl: string | null = null

export function configureNetTunnel(tunnelUrl?: string | null): void {
  configuredTunnelUrl = tunnelUrl ?? null
}

type SocketChunk = string | Uint8Array

function toUint8Array(chunk: SocketChunk): Uint8Array {
  return typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) {
    total += chunk.byteLength
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function nextSocketPort(): number {
  return Math.max(1024, Math.floor(Math.random() * 50_000) + 10_000)
}

export class IncomingMessage {
  constructor(
    readonly statusCode: number,
    readonly statusMessage: string,
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
  private aborted = false
  private readonly bodyChunks: Uint8Array[] = []
  private readonly headers = new Headers()
  private readonly abortController = new AbortController()

  constructor(
    private readonly input: string | URL | RequestOptions,
    private readonly options: RequestOptions,
  ) {
    super()

    for (const [name, value] of Object.entries(options.headers ?? {})) {
      this.headers.set(name, value)
    }
  }

  write(chunk: string | Uint8Array): void {
    if (this.ended) {
      throw new Error('Cannot write after end')
    }

    this.bodyChunks.push(toUint8Array(chunk))
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value)
  }

  getHeader(name: string): string | null {
    return this.headers.get(name)
  }

  removeHeader(name: string): void {
    this.headers.delete(name)
  }

  abort(): void {
    if (this.aborted) {
      return
    }
    this.aborted = true
    this.abortController.abort()
    this.emit('abort')
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
    try {
      const method = this.options.method ?? 'GET'
      const body = method === 'GET' || method === 'HEAD'
        ? undefined
        : Buffer.from(concatChunks(this.bodyChunks))

      const response = await fetch(normalizeURL(this.input), {
        method,
        headers: this.headers,
        body,
        signal: this.abortController.signal,
      })

      const incoming = new IncomingMessage(
        response.status,
        response.statusText,
        response.headers,
        response,
      )
      this.emit('response', incoming)
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error('Request failed'))
    }
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

function withDefaultProtocol(
  input: string | URL | RequestOptions,
  protocol: 'http:' | 'https:',
): string | URL | RequestOptions {
  if (typeof input === 'string' || input instanceof URL) {
    return input
  }

  if (input.protocol) {
    return input
  }

  return {
    ...input,
    protocol,
  }
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

export class VirtualSocket extends EventEmitter {
  private peer: VirtualSocket | null = null
  private ended = false
  readonly localAddress = '127.0.0.1'
  readonly remoteAddress = '127.0.0.1'

  constructor(
    readonly localPort: number,
    readonly remotePort: number,
  ) {
    super()
  }

  attachPeer(peer: VirtualSocket): void {
    this.peer = peer
  }

  write(data: SocketChunk): boolean {
    if (this.ended) {
      return false
    }

    const peer = this.peer
    if (!peer || peer.ended) {
      return false
    }

    const payload = toUint8Array(data)
    queueMicrotask(() => {
      peer.emit('data', payload)
    })
    return true
  }

  end(data?: SocketChunk): void {
    if (data !== undefined) {
      this.write(data)
    }

    if (this.ended) {
      return
    }

    this.ended = true
    const peer = this.peer

    queueMicrotask(() => {
      this.emit('end')
      this.emit('close')
    })

    if (peer && !peer.ended) {
      queueMicrotask(() => {
        peer.emit('end')
      })
    }
  }

  destroy(err?: Error): void {
    if (err) {
      this.emit('error', err)
    }
    this.end()
  }

  pipe<T extends NodeJS.WritableStream>(dest: T): T {
    this.on('data', chunk => {
      dest.write(chunk)
    })

    this.on('end', () => {
      if (typeof dest.end === 'function') {
        dest.end()
      }
    })

    return dest
  }
}

export class TunnelSocketAdapter extends EventEmitter {
  readonly localAddress = '127.0.0.1'
  readonly remoteAddress = '127.0.0.1'
  readonly localPort = 0

  constructor(private readonly socket: TunnelVirtualSocket) {
    super()

    socket.addEventListener('connect', () => {
      this.emit('connect')
    })

    socket.addEventListener('data', event => {
      this.emit('data', (event as MessageEvent<Uint8Array>).data)
    })

    socket.addEventListener('end', () => {
      this.emit('end')
    })

    socket.addEventListener('close', () => {
      this.emit('close')
    })

    socket.addEventListener('error', event => {
      const maybeError = (event as ErrorEvent).error
      this.emit('error', maybeError instanceof Error ? maybeError : new Error('Tunnel socket error'))
    })
  }

  get remotePort(): number {
    return this.socket.remotePort
  }

  write(data: SocketChunk): boolean {
    const payload = data instanceof Uint8Array ? Buffer.from(data) : data
    return this.socket.write(payload)
  }

  end(data?: SocketChunk): void {
    if (data !== undefined) {
      const payload = data instanceof Uint8Array ? Buffer.from(data) : data
      this.socket.end(payload)
      return
    }
    this.socket.end()
  }

  destroy(err?: Error): void {
    this.socket.destroy(err)
  }

  pipe<T extends NodeJS.WritableStream>(dest: T): T {
    this.on('data', chunk => {
      dest.write(chunk)
    })

    this.on('end', () => {
      if (typeof dest.end === 'function') {
        dest.end()
      }
    })

    return dest
  }
}

export class VirtualServer extends EventEmitter {
  private listening = false
  private host = '127.0.0.1'
  private portValue: number | null = null

  constructor(private readonly onConnection?: (socket: VirtualSocket) => void) {
    super()
  }

  listen(
    portOrOptions: number | { port: number; host?: string },
    callback?: () => void,
  ): this {
    const port = typeof portOrOptions === 'number' ? portOrOptions : portOrOptions.port
    const host = typeof portOrOptions === 'number' ? '127.0.0.1' : (portOrOptions.host ?? '127.0.0.1')
    this.listening = true
    this.host = host
    this.portValue = port
    netServerRegistry.set(port, this)
    callback?.()
    this.emit('listening')
    return this
  }

  close(callback?: (err?: Error) => void): this {
    if (this.portValue !== null) {
      netServerRegistry.delete(this.portValue)
    }
    this.listening = false
    this.portValue = null
    callback?.()
    this.emit('close')
    return this
  }

  address(): { port: number; address: string; family: string } | null {
    if (!this.listening || this.portValue === null) {
      return null
    }

    return {
      port: this.portValue,
      address: this.host,
      family: 'IPv4',
    }
  }

  emitConnection(socket: VirtualSocket): void {
    this.onConnection?.(socket)
    this.emit('connection', socket)
  }
}

const netServerRegistry = new Map<number, VirtualServer>()

export function createNetServer(listener?: (socket: VirtualSocket) => void): VirtualServer {
  return new VirtualServer(listener)
}

function establishConnection(port: number): { client: VirtualSocket; server: VirtualSocket } {
  const clientLocalPort = nextSocketPort()
  const serverLocalPort = port

  const client = new VirtualSocket(clientLocalPort, serverLocalPort)
  const server = new VirtualSocket(serverLocalPort, clientLocalPort)

  client.attachPeer(server)
  server.attachPeer(client)

  return { client, server }
}

export function connectNet(
  port: number,
  hostOrCallback?: string | (() => void),
  maybeCallback?: () => void,
  mode: 'tcp' | 'tls' = 'tcp',
): VirtualSocket | TunnelSocketAdapter {
  const host = typeof hostOrCallback === 'string' ? hostOrCallback : '127.0.0.1'
  const callback = typeof hostOrCallback === 'function' ? hostOrCallback : maybeCallback
  const server = netServerRegistry.get(port)

  if (!server && configuredTunnelUrl) {
    const tunnelSocket = new TunnelVirtualSocket(configuredTunnelUrl)
    const adapted = new TunnelSocketAdapter(tunnelSocket)
    adapted.on('connect', () => {
      callback?.()
    })
    if (mode === 'tls') {
      tunnelSocket.connectTLS(port, host)
    } else {
      tunnelSocket.connect(port, host)
    }
    return adapted
  }

  if (!server) {
    throw new Error(`connect ECONNREFUSED 127.0.0.1:${port}`)
  }

  const pair = establishConnection(port)
  queueMicrotask(() => {
    server.emitConnection(pair.server)
    pair.client.emit('connect')
    callback?.()
  })

  return pair.client
}

export function createConnection(
  port: number,
  hostOrCallback?: string | (() => void),
  maybeCallback?: () => void,
): VirtualSocket | TunnelSocketAdapter {
  return connectNet(port, hostOrCallback, maybeCallback)
}

export function connect(
  port: number,
  hostOrCallback?: string | (() => void),
  maybeCallback?: () => void,
): VirtualSocket | TunnelSocketAdapter {
  return connectNet(port, hostOrCallback, maybeCallback)
}

export type SecureContext = {
  options: Record<string, unknown>
}

export function createSecureContext(options: Record<string, unknown> = {}): SecureContext {
  if (configuredTunnelUrl) {
    return createTunnelSecureContext(options)
  }
  return { options }
}

export function tlsConnect(
  port: number,
  hostOrCallback?: string | (() => void),
  maybeCallback?: () => void,
): VirtualSocket | TunnelSocketAdapter {
  const callback = typeof hostOrCallback === 'function' ? hostOrCallback : maybeCallback
  const socket = connectNet(port, hostOrCallback, undefined, 'tls')
  queueMicrotask(() => {
    socket.emit('secureConnect')
    callback?.()
  })
  return socket
}

export const https = {
  request(
    input: string | URL | RequestOptions,
    optionsOrCallback?: RequestOptions | ((response: IncomingMessage) => void),
    maybeCallback?: (response: IncomingMessage) => void,
  ) {
    return request(withDefaultProtocol(input, 'https:'), optionsOrCallback, maybeCallback)
  },
  get(
    input: string | URL | RequestOptions,
    optionsOrCallback?: RequestOptions | ((response: IncomingMessage) => void),
    maybeCallback?: (response: IncomingMessage) => void,
  ) {
    return get(withDefaultProtocol(input, 'https:'), optionsOrCallback, maybeCallback)
  },
  createServer,
}

export type HTTP2Headers = Record<string, string>

class ClientHttp2Stream extends EventEmitter {
  private readonly chunks: Uint8Array[] = []
  private closed = false

  constructor(
    private readonly authority: string,
    private readonly headers: HTTP2Headers,
  ) {
    super()
  }

  write(chunk: SocketChunk): void {
    if (this.closed) {
      throw new Error('Cannot write after stream closed')
    }
    this.chunks.push(toUint8Array(chunk))
  }

  end(chunk?: SocketChunk): void {
    if (chunk !== undefined) {
      this.write(chunk)
    }
    if (this.closed) {
      return
    }
    this.closed = true
    void this.execute()
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.emit('close')
  }

  private async execute(): Promise<void> {
    try {
      const method = this.headers[':method'] ?? 'GET'
      const path = this.headers[':path'] ?? '/'
      const url = `${this.authority}${path}`

      const requestHeaders = new Headers()
      for (const [name, value] of Object.entries(this.headers)) {
        if (!name.startsWith(':')) {
          requestHeaders.set(name, value)
        }
      }

      const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.from(concatChunks(this.chunks))
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body,
      })

      this.emit('response', {
        ':status': String(response.status),
      } as HTTP2Headers)

      const payload = new Uint8Array(await response.arrayBuffer())
      if (payload.byteLength > 0) {
        this.emit('data', payload)
      }
      this.emit('end')
      this.emit('close')
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error('http2 request failed'))
      this.emit('close')
    }
  }
}

class ClientHttp2Session extends EventEmitter {
  private destroyed = false

  constructor(private readonly authority: string) {
    super()
  }

  request(headers: HTTP2Headers = {}): ClientHttp2Stream {
    if (this.destroyed) {
      throw new Error('http2 session destroyed')
    }
    return new ClientHttp2Stream(this.authority, headers)
  }

  close(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.emit('close')
  }

  destroy(error?: Error): void {
    if (error) {
      this.emit('error', error)
    }
    this.close()
  }
}

export const http2 = {
  connect(authority: string): ClientHttp2Session {
    return new ClientHttp2Session(authority)
  },
}

export const net = {
  createServer: createNetServer,
  createConnection,
  connect,
  Socket: VirtualSocket,
  Server: VirtualServer,
}

export const tls = {
  connect: tlsConnect,
  createSecureContext,
}
