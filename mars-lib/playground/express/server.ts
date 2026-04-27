import { createServer } from "@mars/node"

import type { MarsKernel } from "@mars/kernel"

export function createExpressHelloWorldServer(kernel: MarsKernel) {
  return createServer((request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8")
    response.end(JSON.stringify({ framework: "express", method: request.method, url: request.url }))
  }, { kernel })
}