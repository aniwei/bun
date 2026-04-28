import { createServer } from "http"

import type { IncomingMessage, Server as NodeHttpServer, ServerResponse } from "http"

export const koaProfilePath = "/profile?name=mars"
export const koaEchoPath = "/echo"
export const koaRequestBody = "hello koa"
export const koaTraceHeader = "x-mars-koa"
export const koaTraceHeaderValue = "onion"

export interface KoaPlaygroundContext {
  request: IncomingMessage
  response: ServerResponse
  method: string
  url: string
  path: string
  query: URLSearchParams
  headers: Record<string, string>
  status: number
  body: string | Uint8Array | object | null
  set(name: string, value: string): void
}

type KoaNext = () => Promise<void>
type KoaMiddleware = (context: KoaPlaygroundContext, next: KoaNext) => void | Promise<void>

export interface KoaPlaygroundApp {
  use(handler: KoaMiddleware): this
  listen(port?: number, callback?: () => void): NodeHttpServer
}

export function createKoaPlaygroundApp(): KoaPlaygroundApp {
  const middlewares: KoaMiddleware[] = []

  const app: KoaPlaygroundApp = {
    use(handler) {
      middlewares.push(handler)
      return this
    },
    listen(port = 3002, callback) {
      return createServer(async (request, response) => {
        const url = new URL(`http://mars.localhost${request.url}`)
        const context: KoaPlaygroundContext = {
          request,
          response,
          method: request.method,
          url: request.url,
          path: url.pathname,
          query: url.searchParams,
          headers: request.headers,
          status: 200,
          body: null,
          set(name, value) {
            response.setHeader(name, value)
          },
        }
        let index = -1
        const dispatch = async (nextIndex: number): Promise<void> => {
          if (nextIndex <= index) throw new Error("next() called multiple times")
          index = nextIndex
          const layer = middlewares[nextIndex]
          if (!layer) return
          await layer(context, () => dispatch(nextIndex + 1))
        }

        await dispatch(0)
        response.statusCode = context.status
        if (context.body === null) {
          response.writeHead(404, { "content-type": "application/json; charset=utf-8" })
          response.end(JSON.stringify({ error: "not found" }))
          return
        }

        response.send(context.body)
      }).listen(port, callback)
    },
  }

  app.use(async (context, next) => {
    context.set(koaTraceHeader, koaTraceHeaderValue)
    await next()
    context.set("x-mars-koa-after", "returned")
  })

  app.use(async (context, next) => {
    if (context.method === "GET" && context.path === "/profile") {
      context.body = {
        framework: "koa",
        route: "profile.show",
        name: context.query.get("name"),
        middleware: koaTraceHeaderValue,
      }
      return
    }

    await next()
  })

  app.use(async context => {
    if (context.method === "POST" && context.path === "/echo") {
      context.status = 202
      context.body = {
        framework: "koa",
        route: "echo.create",
        body: await context.request.request.text(),
      }
    }
  })

  return app
}

export function createKoaHelloWorldServer(): NodeHttpServer {
  return createKoaPlaygroundApp().listen(3002)
}