import { EventEmitter } from "./core"

export class IncomingMessage extends EventEmitter {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly request: Request
  httpVersion = "1.1"
  httpVersionMajor = 1
  httpVersionMinor = 1
  socket = {}
  connection = this.socket
  complete = true
  destroyed = false
  readableEnded = true

  constructor(request: Request) {
    super()
    const url = new URL(request.url)

    this.request = request
    this.method = request.method
    this.url = `${url.pathname}${url.search}`
    this.headers = Object.fromEntries(request.headers.entries())
  }

  pipe<T>(destination: T): T {
    return destination
  }

  unpipe(): this {
    return this
  }

  resume(): this {
    return this
  }
}