import { describe, expect, test } from 'vitest'
import { Kernel } from '../../../packages/bun-web-kernel/src'
import { clearServeRegistry, getServeHandler, serve } from '../../../packages/bun-web-runtime/src/serve'
import { createFetchRouter, dispatchVirtualRequest, isVirtualBunRequest, resolveVirtualPid } from '../../../packages/bun-web-sw/src'

describe('M4 serve + service worker routing', () => {
  test('recognizes virtual hostname and path forms', () => {
    const hostStyle = new URL('http://123.bun.local/home')
    const pathStyle = new URL('http://app.local/__bun__/3000/home')
    const normal = new URL('http://app.local/home')

    expect(isVirtualBunRequest(hostStyle)).toBe(true)
    expect(isVirtualBunRequest(pathStyle)).toBe(true)
    expect(isVirtualBunRequest(normal)).toBe(false)
  })

  test('resolveVirtualPid resolves host-style pid directly', () => {
    const pid = resolveVirtualPid(new URL('http://456.bun.local/'))
    expect(pid).toBe(456)
  })

  test('resolveVirtualPid resolves path-style via resolver', () => {
    const pid = resolveVirtualPid(new URL('http://host/__bun__/8123/x'), {
      resolvePort(port) {
        expect(port).toBe(8123)
        return 900
      },
    })
    expect(pid).toBe(900)
  })

  test('dispatchVirtualRequest returns 404 when no route mapping', async () => {
    const response = await dispatchVirtualRequest(
      new Request('http://host/__bun__/1/nope'),
      { resolvePort: () => null },
      async () => new Response('unexpected'),
    )

    expect(response.status).toBe(404)
    expect(await response.text()).toContain('not found')
  })

  test('serve register/reload/stop lifecycle works with kernel port table', async () => {
    await Kernel.shutdown()
    clearServeRegistry()

    const kernel = await Kernel.boot({})
    const app = serve(
      {
        port: 4401,
        pid: 901,
        fetch: () => new Response('v1'),
      },
      kernel,
    )

    expect(kernel.resolvePort(4401)).toBe(901)
    expect(app.url).toBe('http://127.0.0.1:4401')

    app.reload({ hostname: '0.0.0.0', fetch: () => new Response('v2') })
    expect(app.url).toBe('http://0.0.0.0:4401')
    expect(await (await app.fetch(new Request('http://x/'))).text()).toBe('v2')

    app.stop()
    expect(kernel.resolvePort(4401)).toBeNull()

    await Kernel.shutdown()
    clearServeRegistry()
  })

  test('fetch router returns null for non-virtual requests', async () => {
    const router = createFetchRouter(
      { resolvePort: () => 1 },
      async () => new Response('ok'),
    )

    const response = await router(new Request('http://example.com/'))
    expect(response).toBeNull()
  })

  test('fetch router dispatches to matched serve handler', async () => {
    await Kernel.shutdown()
    clearServeRegistry()

    const kernel = await Kernel.boot({})
    serve(
      {
        port: 4402,
        pid: 902,
        fetch: req => new Response(`hit:${new URL(req.url).pathname}`),
      },
      kernel,
    )

    const router = createFetchRouter(
      { resolvePort: port => kernel.resolvePort(port) },
      async (_pid, request) => {
        const handler = getServeHandler(4402)
        return handler!(request)
      },
    )

    const res = await router(new Request('http://host/__bun__/4402/ping'))
    expect(res).not.toBeNull()
    expect(await res!.text()).toBe('hit:/__bun__/4402/ping')

    clearServeRegistry()
    await Kernel.shutdown()
  })
})
