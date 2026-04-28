import { createServer } from "node:http"

export const nodeHttpRequestPath = "/api/users?active=1"
export const nodeHttpHeaderName = "x-mars-node-http"
export const nodeHttpHeaderValue = "playground"
export const nodeHttpExpectedMethod = "POST"
export const nodeHttpRequestBody = "hello node http"

export function createNodeHttpPlaygroundServer() {
  return createServer(async (request, response) => {
    const body = await request.request.text()

    response.writeHead(201, {
      "content-type": "application/json; charset=utf-8",
      "x-mars-handler": "node-http",
    })
    response.end(JSON.stringify({
      method: request.method,
      url: request.url,
      header: request.headers[nodeHttpHeaderName],
      body,
    }))
  })
}
