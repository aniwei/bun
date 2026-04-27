declare module '@mars/web-net' {
  export class VirtualSocket extends EventTarget {
    constructor(tunnelUrl?: string)
    readonly remoteAddress: string
    remotePort: number
    connect(port: number, host?: string, cb?: () => void): this
    connectTLS(port: number, host?: string, cb?: () => void): this
    write(data: Buffer | string, encoding?: BufferEncoding, cb?: (err?: Error) => void): boolean
    end(data?: Buffer | string): this
    destroy(err?: Error): this
    pipe<T extends NodeJS.WritableStream>(dest: T): T
  }

  export type SecureContext = {
    options: Record<string, unknown>
  }

  export function createSecureContext(options?: Record<string, unknown>): SecureContext
}
