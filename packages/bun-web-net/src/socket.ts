import { WSTunnel } from './ws-tunnel'

function toBytes(data: Buffer | string): Uint8Array {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data)
  }

  return new Uint8Array(data)
}

export class VirtualSocket extends EventTarget {
  private tunnel: WSTunnel | null = null
  private writerClosed = false
  readonly remoteAddress = '127.0.0.1'
  remotePort = 0

  constructor(private readonly tunnelUrl?: string) {
    super()
  }

  connect(port: number, host = '127.0.0.1', cb?: () => void): this {
    return this.openTunnel(port, host, 'tcp', cb)
  }

  connectTLS(port: number, host = '127.0.0.1', cb?: () => void): this {
    return this.openTunnel(port, host, 'tls', cb)
  }

  private openTunnel(
    port: number,
    host: string,
    proto: 'tcp' | 'tls',
    cb?: () => void,
  ): this {
    if (!this.tunnelUrl) {
      throw new Error('VirtualSocket requires tunnelUrl')
    }

    this.remotePort = port
    const target = `${host}:${port}`
    this.tunnel = new WSTunnel({
      tunnelUrl: this.tunnelUrl,
      target,
      proto,
    })

    void this.tunnel.connect().then(async () => {
      this.dispatchEvent(new Event('connect'))
      cb?.()

      const stream = this.tunnel?.readable
      if (!stream) return

      const reader = stream.getReader()
      while (true) {
        const next = await reader.read()
        if (next.done) {
          break
        }

        this.dispatchEvent(new MessageEvent('data', { data: next.value }))
      }

      this.dispatchEvent(new Event('end'))
    }).catch(error => {
      this.dispatchEvent(new ErrorEvent('error', { error }))
    })

    return this
  }

  write(data: Buffer | string, _encoding?: BufferEncoding, cb?: (err?: Error) => void): boolean {
    if (!this.tunnel || this.writerClosed) {
      const err = new Error('Socket is not connected')
      cb?.(err)
      this.dispatchEvent(new ErrorEvent('error', { error: err }))
      return false
    }

    try {
      this.tunnel.write(toBytes(data))
      cb?.()
      return true
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Socket write failed')
      cb?.(err)
      this.dispatchEvent(new ErrorEvent('error', { error: err }))
      return false
    }
  }

  end(data?: Buffer | string): this {
    if (data !== undefined) {
      this.write(data)
    }

    this.writerClosed = true
    this.tunnel?.close()
    this.dispatchEvent(new Event('close'))
    return this
  }

  destroy(err?: Error): this {
    if (err) {
      this.dispatchEvent(new ErrorEvent('error', { error: err }))
    }
    return this.end()
  }

  pipe<T extends NodeJS.WritableStream>(dest: T): T {
    this.addEventListener('data', event => {
      dest.write((event as MessageEvent<Uint8Array>).data)
    })

    this.addEventListener('end', () => {
      if (typeof dest.end === 'function') {
        dest.end()
      }
    })

    return dest
  }
}
