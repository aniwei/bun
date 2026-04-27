export type ServeHandler = (request: Request) => Response | Promise<Response>

export interface HTTPBridgeOptions {
  getServeHandler(port: number): ServeHandler | null
}

export function notFound(message = 'Virtual server not found'): Response {
  return new Response(message, { status: 404 })
}

export class HTTPBridge {
  constructor(private readonly options: HTTPBridgeOptions) {}

  async dispatch(port: number, request: Request): Promise<Response> {
    const handler = this.options.getServeHandler(port)
    if (!handler) {
      return notFound()
    }

    try {
      return await handler(request)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown bridge error'
      return new Response(message, { status: 500 })
    }
  }
}

export async function bridgeRequest(
  request: Request,
  handler: ServeHandler,
): Promise<Response> {
  try {
    return await handler(request)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown bridge error'
    return new Response(message, { status: 500 })
  }
}
