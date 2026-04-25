import { describe, expect, test } from 'vitest'
import { Kernel } from '../../../packages/bun-web-kernel/src'
import { PreviewController } from '../../../packages/bun-web-client/src'
import { lookup, resolveDoH } from '../../../packages/bun-web-dns/src'
import { HTTPBridge, bridgeRequest } from '../../../packages/bun-web-net/src'
import { VirtualWebSocket } from '../../../packages/bun-web-net/src'
import { createProxyServer } from '../../../packages/bun-web-proxy-server/src'
import { clearServeRegistry, getServeHandler, serve } from '../../../packages/bun-web-runtime/src/serve'
import { ServiceWorkerHeartbeat, createFetchRouter } from '../../../packages/bun-web-sw/src'
import { createServer, get } from '../../../packages/bun-web-node/src/http-net'

describe('M4 runtime/network integration', () => {
  test('M4-1 + M4-2: virtual route dispatches to Bun.serve handler', async () => {
    await Kernel.shutdown()
    clearServeRegistry()

    const kernel = await Kernel.boot({})
    const app = serve(
      {
        port: 4310,
        pid: 777,
        fetch: request => new Response(`ok:${new URL(request.url).pathname}`),
      },
      kernel,
    )

    expect(kernel.resolvePort(4310)).toBe(777)

    const router = createFetchRouter(
      {
        resolvePort(port) {
          return kernel.resolvePort(port)
        },
      },
      async (pid, request) => {
        expect(pid).toBe(777)
        const handler = getServeHandler(4310)
        expect(handler).not.toBeNull()
        return handler!(request)
      },
    )

    const response = await router(new Request('http://host.test/__bun__/4310/hello'))
    expect(response).not.toBeNull()
    expect(await response!.text()).toBe('ok:/__bun__/4310/hello')

    app.stop()
    expect(kernel.resolvePort(4310)).toBeNull()
    await Kernel.shutdown()
    clearServeRegistry()
  })

  test('M4-2: Bun.serve supports reload', async () => {
    clearServeRegistry()
    const app = serve({
      port: 4311,
      fetch: () => new Response('v1'),
    })

    let res = await app.fetch(new Request('http://example.test/'))
    expect(await res.text()).toBe('v1')

    app.reload({ fetch: () => new Response('v2') })
    res = await app.fetch(new Request('http://example.test/'))
    expect(await res.text()).toBe('v2')

    app.stop()
    clearServeRegistry()
  })

  test('M4-3: HTTP bridge handles request body and stream response', async () => {
    const postResponse = await bridgeRequest(
      new Request('http://example.test/', { method: 'POST', body: 'payload' }),
      async request => new Response(`echo:${await request.text()}`),
    )
    expect(await postResponse.text()).toBe('echo:payload')

    const bridge = new HTTPBridge({
      getServeHandler() {
        return () => {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('stream-'))
              controller.enqueue(new TextEncoder().encode('ok'))
              controller.close()
            },
          })
          return new Response(body)
        }
      },
    })

    const streamed = await bridge.dispatch(3000, new Request('http://example.test/'))
    expect(await streamed.text()).toBe('stream-ok')
  })

  test('M4-4: virtual websocket broadcasts within the same channel', async () => {
    const a = new VirtualWebSocket('ws://room.test/echo')
    const b = new VirtualWebSocket('ws://room.test/echo')

    const message = new Promise<string>(resolve => {
      b.addEventListener('message', event => {
        resolve((event as MessageEvent).data as string)
      })
    })

    a.send('ping')
    expect(await message).toBe('ping')

    a.close()
    b.close()
  })

  test('M4-5: preview controller updates iframe src from server-ready payload', () => {
    const controller = new PreviewController()
    const iframe = { src: '' } as unknown as HTMLIFrameElement
    controller.bind(iframe)

    const next = controller.updateFromServerReady({
      host: '127.0.0.1',
      port: 5173,
      protocol: 'http',
    })

    expect(next).toBe('http://127.0.0.1:5173')
    expect(iframe.src).toBe('http://127.0.0.1:5173')
  })

  test('M4-7: node:http get and createServer basic behavior', async () => {
    const live = Bun.serve({
      port: 0,
      fetch: () => new Response('hello-http'),
    })

    const body = await new Promise<string>(resolve => {
      get(`http://127.0.0.1:${live.port}/`, async response => {
        resolve(await response.text())
      })
    })

    expect(body).toBe('hello-http')
    live.stop(true)

    const localServer = createServer(async request => {
      return new Response(`local:${new URL(request.url).pathname}`)
    })
    localServer.listen(9000)
    const localResponse = await localServer.emitRequest(new Request('http://localhost/test'))
    expect(await localResponse.text()).toBe('local:/test')
    localServer.close()
  })

  test('M4-8: DoH lookup parses response', async () => {
    const fetchFn = async () => {
      return new Response(
        JSON.stringify({
          Status: 0,
          Answer: [{ name: 'github.com', type: 1, TTL: 60, data: '140.82.113.3' }],
        }),
        { status: 200, headers: { 'content-type': 'application/dns-json' } },
      )
    }

    const full = await resolveDoH('github.com', 'A', { fetchFn })
    expect(full.Status).toBe(0)

    const ip = await lookup('github.com', { fetchFn })
    expect(ip).toBe('140.82.113.3')
  })

  test('M4-9: heartbeat enters recovery after consecutive failures', async () => {
    const hb = new ServiceWorkerHeartbeat(() => false, 3000, 1)
    await hb.tick()
    expect(hb.recovery()).toBe(false)
    await hb.tick()
    expect(hb.recovery()).toBe(true)
  })

  test('M4-10: proxy server requires tunnel URL', () => {
    expect(() => createProxyServer({})).toThrow(/required/i)

    const proxy = createProxyServer({ tunnelURL: 'wss://tunnel.example.test/proxy' })
    expect(proxy.buildTunnelURL('postgres.internal:5432')).toContain('target=postgres.internal%3A5432')
  })
})
