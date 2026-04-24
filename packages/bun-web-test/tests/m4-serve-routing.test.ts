import { describe, expect, test } from 'vitest'
import { Kernel } from '../../../packages/bun-web-kernel/src'
import { clearServeRegistry, getServeHandler, serve } from '../../../packages/bun-web-runtime/src/serve'
import {
  createFetchRouter,
  dispatchVirtualRequest,
  installFetchInterceptor,
  installServiceWorkerRuntime,
  isVirtualBunRequest,
  resolveVirtualPid,
} from '../../../packages/bun-web-sw/src'

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

  test('installFetchInterceptor intercepts virtual requests and responds via router', async () => {
    let registered: ((event: { request: Request; respondWith(response: Promise<Response> | Response): void }) => void) | null = null

    const scope = {
      addEventListener(_type: 'fetch', listener: (event: { request: Request; respondWith(response: Promise<Response> | Response): void }) => void) {
        registered = listener
      },
      removeEventListener(_type: 'fetch', listener: (event: { request: Request; respondWith(response: Promise<Response> | Response): void }) => void) {
        if (registered === listener) {
          registered = null
        }
      },
    }

    const uninstall = installFetchInterceptor(
      scope,
      {
        resolvePort(port) {
          return port === 7000 ? 88 : null
        },
      },
      async (pid, request) => new Response(`pid:${pid};path:${new URL(request.url).pathname}`),
    )

    let responsePromise: Promise<Response> | null = null
    registered!({
      request: new Request('http://app.local/__bun__/7000/hello'),
      respondWith(response) {
        responsePromise = Promise.resolve(response)
      },
    })

    expect(responsePromise).not.toBeNull()
    const response = await responsePromise!
    expect(await response.text()).toBe('pid:88;path:/__bun__/7000/hello')

    uninstall()
    expect(registered).toBeNull()
  })

  test('installFetchInterceptor falls back to fetch for non-virtual requests', async () => {
    const originalFetch = globalThis.fetch
    try {
      const passthroughFetch = (async () => new Response('passthrough-ok')) as unknown as typeof fetch
      globalThis.fetch = passthroughFetch

      let registered: ((event: { request: Request; respondWith(response: Promise<Response> | Response): void }) => void) | null = null
      const scope = {
        addEventListener(_type: 'fetch', listener: (event: { request: Request; respondWith(response: Promise<Response> | Response): void }) => void) {
          registered = listener
        },
      }

      installFetchInterceptor(
        scope,
        { resolvePort: () => null },
        async () => new Response('virtual-only'),
      )

      let responsePromise: Promise<Response> | null = null
      registered!({
        request: new Request('http://example.com/non-virtual'),
        respondWith(response) {
          responsePromise = Promise.resolve(response)
        },
      })

      const response = await responsePromise!
      expect(await response.text()).toBe('passthrough-ok')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('installServiceWorkerRuntime wires install/activate/fetch listeners', async () => {
    const listeners = new Map<string, Function[]>()
    const add = (type: string, listener: Function) => {
      const bucket = listeners.get(type) ?? []
      bucket.push(listener)
      listeners.set(type, bucket)
    }
    const remove = (type: string, listener: Function) => {
      const bucket = listeners.get(type) ?? []
      listeners.set(type, bucket.filter(entry => entry !== listener))
    }

    let skipped = false
    let claimed = false
    const scope = {
      addEventListener(type: 'fetch' | 'install' | 'activate', listener: Function) {
        add(type, listener)
      },
      removeEventListener(type: 'fetch' | 'install' | 'activate', listener: Function) {
        remove(type, listener)
      },
      skipWaiting() {
        skipped = true
      },
      clients: {
        claim() {
          claimed = true
        },
      },
    }

    const uninstall = installServiceWorkerRuntime(
      scope,
      { resolvePort: port => (port === 7001 ? 99 : null) },
      async (pid, request) => new Response(`pid:${pid};url:${new URL(request.url).pathname}`),
    )

    const installEvent = {
      waitUntil: (promise: Promise<unknown>) => promise,
    }
    await listeners.get('install')![0](installEvent)
    expect(skipped).toBe(true)

    const activateEvent = {
      waitUntil: (promise: Promise<unknown>) => promise,
    }
    await listeners.get('activate')![0](activateEvent)
    expect(claimed).toBe(true)

    let responsePromise: Promise<Response> | null = null
    listeners.get('fetch')![0]({
      request: new Request('http://local/__bun__/7001/ok'),
      respondWith(response: Promise<Response> | Response) {
        responsePromise = Promise.resolve(response)
      },
    })
    expect(await (await responsePromise!).text()).toBe('pid:99;url:/__bun__/7001/ok')

    uninstall()
    expect(listeners.get('fetch') ?? []).toHaveLength(0)
    expect(listeners.get('install') ?? []).toHaveLength(0)
    expect(listeners.get('activate') ?? []).toHaveLength(0)
  })
})
