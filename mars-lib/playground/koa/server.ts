import { createServer } from "@mars/node"

import type { MarsKernel } from "@mars/kernel"

export function createKoaHelloWorldServer(kernel: MarsKernel) {
  return createServer(async (_request, response) => {
    await Promise.resolve()
    response.setHeader("content-type", "application/json; charset=utf-8")
    response.end(JSON.stringify({ framework: "koa", body: "hello mars" }))
  }, { kernel })
}