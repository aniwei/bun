export interface ProxyServerOptions {
  tunnelURL?: string
  allowedTargets?: string[]
  authToken?: string
  transport?: TunnelTransport
  runtime?: ProxyRuntimeAdapter
  runtimeHandleFetchOptions?: HandleFetchOptions
}

export interface ProxyTunnelSession {
  id: string
  target: string
  protocol: 'tcp' | 'tls'
  openedAt: number
}

export interface TunnelConnection {
  close(): void | Promise<void>
  write?(payload: Uint8Array): void | Promise<void>
  onData?(handler: (payload: Uint8Array) => void): void
}

export interface ProxyWebSocketLike {
  send(payload: Uint8Array): void
  close(): void
  addEventListener(
    type: 'message' | 'close',
    listener: (event?: { data?: Uint8Array | ArrayBuffer | string }) => void,
  ): void
  removeEventListener(
    type: 'message' | 'close',
    listener: (event?: { data?: Uint8Array | ArrayBuffer | string }) => void,
  ): void
}

export interface TunnelTransport {
  connect(target: string, protocol: 'tcp' | 'tls'): TunnelConnection | Promise<TunnelConnection>
}

export interface ProxyRuntimeServer {
  url: string
  stop(): void | Promise<void>
}

export interface ProxyRuntimeAdapter {
  start(config: {
    tunnelURL: string
    fetch: (request: Request) => Promise<Response>
  }): ProxyRuntimeServer | Promise<ProxyRuntimeServer>
}

export interface TunnelBootstrapContext {
  session: ProxyTunnelSession
  request: Request | null
}

export interface HandleFetchOptions {
  onTunnelOpen?: (context: TunnelBootstrapContext) => void | Promise<void>
}

export interface TunnelRequest {
  target: string
  protocol?: 'tcp' | 'tls'
  authorization?: string
}

export interface TunnelValidationResult {
  ok: boolean
  status: number
  protocol?: 'tcp' | 'tls'
  reason?: string
}

export interface TunnelHandleResult {
  ok: boolean
  status: number
  reason?: string
  session?: ProxyTunnelSession
}

export class ProxyServer {
  private running = false
  private readonly allowedTargets: string[]
  private readonly authToken?: string
  private readonly sessions = new Map<string, ProxyTunnelSession>()
  private readonly connections = new Map<string, TunnelConnection>()
  private readonly dataSubscribers = new Map<string, Set<(payload: Uint8Array) => void>>()
  private readonly websocketUnsubscribers = new Map<string, () => void>()
  private readonly transport?: TunnelTransport
  private readonly runtime?: ProxyRuntimeAdapter
  private readonly runtimeHandleFetchOptions: HandleFetchOptions
  private runtimeServer: ProxyRuntimeServer | null = null

  constructor(
    readonly tunnelURL: string,
    options: Pick<ProxyServerOptions, 'allowedTargets' | 'authToken' | 'transport' | 'runtime' | 'runtimeHandleFetchOptions'> = {},
  ) {
    this.allowedTargets = options.allowedTargets ?? []
    this.authToken = options.authToken
    this.transport = options.transport
    this.runtime = options.runtime
    this.runtimeHandleFetchOptions = options.runtimeHandleFetchOptions ?? {}
  }

  get url(): string {
    return this.runtimeServer?.url ?? this.tunnelURL
  }

  get isRunning(): boolean {
    return this.running
  }

  get activeTunnelCount(): number {
    return this.sessions.size
  }

  listTunnels(): ProxyTunnelSession[] {
    return Array.from(this.sessions.values())
  }

  async start(): Promise<void> {
    if (this.running) {
      return
    }

    this.running = true

    if (!this.runtime) {
      return
    }

    try {
      this.runtimeServer = await this.runtime.start({
        tunnelURL: this.tunnelURL,
        fetch: request => this.handleFetch(request, this.runtimeHandleFetchOptions),
      })
    } catch (error) {
      this.running = false
      throw error
    }
  }

  async stop(): Promise<void> {
    if (!this.running && !this.runtimeServer) {
      return
    }

    this.running = false
    for (const connection of this.connections.values()) {
      await connection.close()
    }
    this.connections.clear()
    this.dataSubscribers.clear()
    for (const dispose of this.websocketUnsubscribers.values()) {
      dispose()
    }
    this.websocketUnsubscribers.clear()
    this.sessions.clear()

    if (this.runtimeServer) {
      await this.runtimeServer.stop()
      this.runtimeServer = null
    }
  }

  async handleFetch(request: Request, options: HandleFetchOptions = {}): Promise<Response> {
    if (request.method.toUpperCase() !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const result = this.handleTunnelRequest(request)
    if (!result.ok || !result.session) {
      return new Response(result.reason ?? 'Tunnel request rejected', {
        status: result.status,
      })
    }

    if (this.transport) {
      try {
        const connection = await this.transport.connect(result.session.target, result.session.protocol)
        this.connections.set(result.session.id, connection)
        this.attachDataForwarding(result.session.id, connection)
      } catch (error) {
        this.closeTunnel(result.session.id)
        const message = error instanceof Error ? error.message : 'Tunnel transport connect failed'
        return new Response(message, { status: 502 })
      }
    }

    if (options.onTunnelOpen) {
      try {
        await options.onTunnelOpen({
          session: result.session,
          request,
        })
      } catch (error) {
        this.closeTunnel(result.session.id)
        const message = error instanceof Error ? error.message : 'Tunnel bootstrap failed'
        return new Response(message, { status: 502 })
      }
    }

    const response = new Response('Tunnel Accepted', {
      status: 200,
      headers: {
        'x-proxy-tunnel-id': result.session.id,
        'x-proxy-target': result.session.target,
        'x-proxy-protocol': result.session.protocol,
      },
    })
    return response
  }

  handleTunnelRequest(input: Request | TunnelRequest): TunnelHandleResult {
    const parsed = input instanceof Request ? this.parseRequest(input) : input
    const validation = this.validateTunnelRequest(parsed)
    if (!validation.ok) {
      return {
        ok: false,
        status: validation.status,
        reason: validation.reason,
      }
    }

    const session = this.openTunnel(parsed.target, validation.protocol ?? 'tcp')
    return {
      ok: true,
      status: 101,
      session,
    }
  }

  closeTunnel(sessionId: string): boolean {
    const wsDispose = this.websocketUnsubscribers.get(sessionId)
    if (wsDispose) {
      wsDispose()
      this.websocketUnsubscribers.delete(sessionId)
    }

    const connection = this.connections.get(sessionId)
    if (connection) {
      void connection.close()
      this.connections.delete(sessionId)
    }
    this.dataSubscribers.delete(sessionId)

    return this.sessions.delete(sessionId)
  }

  bindWebSocket(sessionId: string, socket: ProxyWebSocketLike): () => void {
    const connection = this.connections.get(sessionId)
    if (!connection) {
      throw createNotSupportedError('Tunnel session does not exist')
    }

    const writeToTunnel = async (payload: Uint8Array): Promise<void> => {
      if (!connection.write) {
        return
      }
      await connection.write(payload)
    }

    const onMessage = (event?: { data?: Uint8Array | ArrayBuffer | string }): void => {
      if (!event || event.data == null) {
        return
      }

      const payload = toUint8Array(event.data)
      if (!payload) {
        return
      }

      void writeToTunnel(payload)
    }

    const onClose = (): void => {
      this.closeTunnel(sessionId)
    }

    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', onClose)

    const unsubscribeData = this.subscribeTunnelData(sessionId, payload => {
      socket.send(payload)
    })

    const cleanup = (): void => {
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)
      unsubscribeData()
    }

    this.websocketUnsubscribers.get(sessionId)?.()
    this.websocketUnsubscribers.set(sessionId, cleanup)

    return cleanup
  }

  async writeTunnelData(sessionId: string, payload: Uint8Array): Promise<void> {
    const connection = this.connections.get(sessionId)
    if (!connection) {
      throw createNotSupportedError('Tunnel session does not exist')
    }

    if (!connection.write) {
      throw createNotSupportedError('Tunnel transport does not support writing')
    }

    await connection.write(payload)
  }

  subscribeTunnelData(sessionId: string, handler: (payload: Uint8Array) => void): () => void {
    let subscribers = this.dataSubscribers.get(sessionId)
    if (!subscribers) {
      subscribers = new Set()
      this.dataSubscribers.set(sessionId, subscribers)
    }
    subscribers.add(handler)

    return () => {
      const current = this.dataSubscribers.get(sessionId)
      if (!current) {
        return
      }
      current.delete(handler)
      if (current.size === 0) {
        this.dataSubscribers.delete(sessionId)
      }
    }
  }

  validateTunnelRequest(request: TunnelRequest): TunnelValidationResult {
    if (!this.running) {
      return { ok: false, status: 503, reason: 'Proxy server is not running' }
    }

    if (!this.isAuthorized(request.authorization)) {
      return { ok: false, status: 401, reason: 'Unauthorized tunnel request' }
    }

    if (!this.isAllowedTarget(request.target)) {
      return { ok: false, status: 403, reason: 'Target is not allowed' }
    }

    return {
      ok: true,
      status: 101,
      protocol: request.protocol ?? 'tcp',
    }
  }

  buildTunnelURL(target: string, protocol = 'tcp'): string {
    if (!this.isAllowedTarget(target)) {
      throw createNotSupportedError('Target is not allowed by proxy policy')
    }

    const url = new URL(this.tunnelURL)
    url.searchParams.set('target', target)
    url.searchParams.set('protocol', protocol)
    return url.toString()
  }

  private isAllowedTarget(target: string): boolean {
    if (this.allowedTargets.length === 0) {
      return true
    }

    return this.allowedTargets.some(prefix => target.startsWith(prefix))
  }

  private isAuthorized(authorization?: string): boolean {
    if (!this.authToken) {
      return true
    }

    if (!authorization) {
      return false
    }

    const expected = `Bearer ${this.authToken}`
    return authorization.trim() === expected
  }

  private parseRequest(request: Request): TunnelRequest {
    const url = new URL(request.url)
    const target = url.searchParams.get('target') ?? ''
    const protocolValue =
      (url.searchParams.get('protocol') ?? url.searchParams.get('proto') ?? 'tcp').toLowerCase() === 'tls'
        ? 'tls'
        : 'tcp'

    return {
      target,
      protocol: protocolValue,
      authorization: request.headers.get('authorization') ?? undefined,
    }
  }

  private openTunnel(target: string, protocol: 'tcp' | 'tls'): ProxyTunnelSession {
    const session: ProxyTunnelSession = {
      id: `tunnel_${Date.now()}_${this.sessions.size + 1}`,
      target,
      protocol,
      openedAt: Date.now(),
    }
    this.sessions.set(session.id, session)
    return session
  }

  private attachDataForwarding(sessionId: string, connection: TunnelConnection): void {
    if (!connection.onData) {
      return
    }

    connection.onData(payload => {
      const subscribers = this.dataSubscribers.get(sessionId)
      if (!subscribers || subscribers.size === 0) {
        return
      }

      for (const subscriber of subscribers) {
        subscriber(payload)
      }
    })
  }
}

function toUint8Array(data: Uint8Array | ArrayBuffer | string): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }

  if (typeof data === 'string') {
    return new TextEncoder().encode(data)
  }

  return null
}

function createNotSupportedError(message: string): Error {
  const error = new Error(message)
  error.name = 'NotSupportedError'
  return error
}

export function createProxyServer(options: ProxyServerOptions): ProxyServer {
  if (!options.tunnelURL) {
    throw createNotSupportedError('Proxy tunnel URL is required in M4')
  }

  return new ProxyServer(options.tunnelURL, {
    allowedTargets: options.allowedTargets,
    authToken: options.authToken,
    transport: options.transport,
    runtime: options.runtime,
    runtimeHandleFetchOptions: options.runtimeHandleFetchOptions,
  })
}
