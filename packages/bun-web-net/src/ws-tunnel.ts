import { VirtualWebSocket } from './websocket-virtual'

export interface TunnelOptions {
  tunnelUrl: string
  target?: string
  proto?: 'tcp' | 'tls'
  protocol?: 'tcp' | 'tls'
}

function canonicalizeURL(url: URL): string {
  const entries = Array.from(url.searchParams.entries())
  entries.sort((a, b) => {
    const byKey = a[0].localeCompare(b[0])
    if (byKey !== 0) return byKey
    return a[1].localeCompare(b[1])
  })

  url.search = ''
  for (const [key, value] of entries) {
    url.searchParams.append(key, value)
  }

  return url.toString()
}

function buildTunnelChannel(options: TunnelOptions): string {
  const base = new URL(options.tunnelUrl)

  // Normalize legacy proto key to protocol for stable channel identity.
  const legacyProto = base.searchParams.get('proto')
  if (legacyProto && !base.searchParams.get('protocol')) {
    base.searchParams.set('protocol', legacyProto)
  }
  base.searchParams.delete('proto')

  const protocol = options.protocol ?? options.proto ?? (base.searchParams.get('protocol') as 'tcp' | 'tls' | null) ?? 'tcp'
  const target = options.target ?? base.searchParams.get('target')

  if (!target) {
    throw new Error('WSTunnel requires target (via options.target or tunnelUrl query)')
  }

  base.searchParams.set('target', target)
  base.searchParams.set('protocol', protocol)

  return canonicalizeURL(base)
}

function toBinary(payload: Uint8Array): ArrayBuffer {
  return Uint8Array.from(payload).buffer
}

export class WSTunnel {
  private socket: VirtualWebSocket | null = null
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null
  private readonly channel: string

  readonly readable = new ReadableStream<Uint8Array>({
    start: controller => {
      this.controller = controller
    },
    cancel: () => {
      this.close()
    },
  })

  constructor(private readonly options: TunnelOptions) {
    this.channel = buildTunnelChannel(options)
  }

  async connect(): Promise<void> {
    if (this.socket) {
      return
    }

    const socket = new VirtualWebSocket(this.channel)
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.removeEventListener('error', onError)
        resolve()
      }

      const onError = () => {
        socket.removeEventListener('open', onOpen)
        reject(new Error('WSTunnel connect failed'))
      }

      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('error', onError, { once: true })
    })

    socket.addEventListener('message', event => {
      const data = (event as MessageEvent).data
      if (typeof data === 'string') {
        this.controller?.enqueue(new TextEncoder().encode(data))
        return
      }

      if (data instanceof Uint8Array) {
        this.controller?.enqueue(data)
        return
      }

      if (data instanceof ArrayBuffer) {
        this.controller?.enqueue(new Uint8Array(data))
      }
    })

    socket.addEventListener('close', () => {
      this.controller?.close()
      this.controller = null
      this.socket = null
    })
  }

  write(data: Uint8Array): void {
    if (!this.socket || this.socket.readyState !== VirtualWebSocket.OPEN) {
      throw new Error('WSTunnel is not connected')
    }

    this.socket.send(toBinary(data))
  }

  close(): void {
    if (!this.socket) {
      return
    }

    this.socket.close()
    this.socket = null
  }
}
