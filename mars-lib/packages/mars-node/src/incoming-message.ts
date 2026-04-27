export class IncomingMessage {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly request: Request

  constructor(request: Request) {
    const url = new URL(request.url)

    this.request = request
    this.method = request.method
    this.url = `${url.pathname}${url.search}`
    this.headers = Object.fromEntries(request.headers.entries())
  }
}