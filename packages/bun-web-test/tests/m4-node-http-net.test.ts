import { describe, expect, test } from 'vitest'
import { createServer, get, request } from '../../../packages/bun-web-node/src/http-net'

describe('M4 node:http-net polyfill baseline', () => {
  test('http get reads response body', async () => {
    const live = Bun.serve({
      port: 0,
      fetch: req => new Response(`hello:${new URL(req.url).pathname}`),
    })

    const body = await new Promise<string>(resolve => {
      get(`http://127.0.0.1:${live.port}/p`, async response => {
        resolve(await response.text())
      })
    })

    expect(body).toBe('hello:/p')
    live.stop(true)
  })

  test('http request supports write/end for POST', async () => {
    const live = Bun.serve({
      port: 0,
      fetch: async req => new Response(await req.text()),
    })

    const body = await new Promise<string>(resolve => {
      const req = request(
        `http://127.0.0.1:${live.port}/post`,
        { method: 'POST' },
        async response => {
          resolve(await response.text())
        },
      )

      req.write('abc')
      req.end('123')
    })

    expect(body).toBe('123')
    live.stop(true)
  })

  test('createServer listen/address/close lifecycle works', async () => {
    const server = createServer(async req => {
      return new Response(`local:${new URL(req.url).pathname}`)
    })

    server.listen(9001)
    expect(server.address()).toEqual({ port: 9001 })

    const response = await server.emitRequest(new Request('http://localhost/ok'))
    expect(await response.text()).toBe('local:/ok')

    server.close()
    expect(server.address()).toBeNull()
  })
})
