import { createServer } from "@mars/node"

import type { MarsKernel } from "@mars/kernel"
import type { IncomingMessage, NodeHttpServer, ServerResponse } from "@mars/node"

export const expressUsersPath = "/users?active=1"
export const expressCreatePath = "/users"
export const expressRequestBody = JSON.stringify({ name: "Ada", role: "admin" })
export const expressTraceHeader = "x-mars-express"
export const expressTraceHeaderValue = "middleware"

type ExpressNext = () => Promise<void>
type ExpressMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: ExpressNext,
) => void | Promise<void>

interface ExpressRoute {
  method: string
  path: string
  handler: ExpressMiddleware
}

export interface ExpressPlaygroundApp {
  use(handler: ExpressMiddleware): this
  get(path: string, handler: ExpressMiddleware): this
  post(path: string, handler: ExpressMiddleware): this
  listen(port?: number, callback?: () => void): NodeHttpServer
}

export function createExpressPlaygroundApp(kernel: MarsKernel): ExpressPlaygroundApp {
  const middlewares: ExpressMiddleware[] = []
  const routes: ExpressRoute[] = []

  const app: ExpressPlaygroundApp = {
    use(handler) {
      middlewares.push(handler)
      return this
    },
    get(path, handler) {
      routes.push({ method: "GET", path, handler })
      return this
    },
    post(path, handler) {
      routes.push({ method: "POST", path, handler })
      return this
    },
    listen(port = 3001, callback) {
      return createServer(async (request, response) => {
        const url = new URL(`http://mars.localhost${request.url}`)
        const route = routes.find(candidate => {
          return candidate.method === request.method && candidate.path === url.pathname
        })
        const stack = route ? [...middlewares, route.handler] : [...middlewares, notFound]
        let index = -1
        const dispatch = async (nextIndex: number): Promise<void> => {
          if (nextIndex <= index) throw new Error("next() called multiple times")
          index = nextIndex
          const layer = stack[nextIndex]
          if (!layer) return
          await layer(request, response, () => dispatch(nextIndex + 1))
        }

        await dispatch(0)
      }, { kernel }).listen(port, callback)
    },
  }

  app.use(async (_request, response, next) => {
    response.setHeader(expressTraceHeader, expressTraceHeaderValue)
    await next()
  })

  app.get("/users", (request, response) => {
    const url = new URL(`http://mars.localhost${request.url}`)
    response.send({
      framework: "express",
      route: "users.index",
      method: request.method,
      active: url.searchParams.get("active"),
      middleware: expressTraceHeaderValue,
    })
  })

  app.post("/users", async (request, response) => {
    response.writeHead(201, { "content-type": "application/json; charset=utf-8" })
    response.end(JSON.stringify({
      framework: "express",
      route: "users.create",
      method: request.method,
      body: JSON.parse(await request.request.text()) as unknown,
    }))
  })

  return app
}

export function createExpressHelloWorldServer(kernel: MarsKernel): NodeHttpServer {
  return createExpressPlaygroundApp(kernel).listen(3001)
}

function notFound(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(404, { "content-type": "application/json; charset=utf-8" })
  response.end(JSON.stringify({ error: "not found" }))
}