import { describe, expect, test } from 'vitest'
import { Kernel } from '../../../packages/bun-web-kernel/src'
import { clearServeRegistry, getServeHandler, serve } from '../../../packages/bun-web-runtime/src/serve'
import {
  createFetchRouter,
  createModuleMessageHandler,
  createModuleRequestRouter,
  createKernelDispatcher,
  createKernelPortResolver,
  detectWorkerScriptModuleType,
  dispatchVirtualRequest,
  EsbuildWorkerScriptProcessor,
  extractVirtualPort,
  installFetchInterceptor,
  installKernelServiceWorkerBridge,
  installModuleMessageBridge,
  installServiceWorkerRuntime,
  installWorkerScriptInterceptor,
  isModuleRequestPath,
  isVirtualBunRequest,
  registerWorkerScript,
  resolveVirtualPid,
  type WorkerScriptStore,
} from '../../../packages/bun-web-sw/src'
import {
  PROCESS_EXECUTOR_WORKER_PATH,
  createRuntimeProcessExecutor,
} from '../../../packages/bun-web-runtime/src/process-executor'

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
    clearServeRegistry()

    const kernel = new Kernel({})
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

    await kernel.shutdown()
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

  test('module request helpers recognize only the module namespace', async () => {
    expect(isModuleRequestPath('/__bun__/modules/pkg/index.js')).toBe(true)
    expect(isModuleRequestPath('/__bun__/modules')).toBe(true)
    expect(isModuleRequestPath('/__bun__/worker/bun-process.js')).toBe(false)

    const router = createModuleRequestRouter({
      async requestModule(message) {
        expect(message.type).toBe('MODULE_REQUEST')
        expect(message.pathname).toBe('/__bun__/modules/pkg/index.js')
        expect(message.method).toBe('GET')

        return {
          type: 'MODULE_RESPONSE',
          requestId: message.requestId,
          status: 200,
          headers: [['X-Module', 'yes']],
          contentType: 'application/javascript',
          buffer: new TextEncoder().encode('export default 42').buffer,
        }
      },
    })

    const response = await router(new Request('http://localhost/__bun__/modules/pkg/index.js'))
    expect(response).not.toBeNull()
    expect(response!.status).toBe(200)
    expect(response!.headers.get('Content-Type')).toBe('application/javascript')
    expect(response!.headers.get('X-Module')).toBe('yes')
    expect(await response!.text()).toBe('export default 42')

    const passthrough = await router(new Request('http://localhost/__bun__/worker/bun-process.js'))
    expect(passthrough).toBeNull()
  })

  test('module request router does not overwrite explicit Content-Type header', async () => {
    const router = createModuleRequestRouter({
      async requestModule(message) {
        return {
          type: 'MODULE_RESPONSE',
          requestId: message.requestId,
          status: 200,
          headers: [
            ['Content-Type', 'text/plain'],
            ['X-Source', 'kernel'],
          ],
          contentType: 'application/javascript',
          buffer: new TextEncoder().encode('plain-body').buffer,
        }
      },
    })

    const response = await router(new Request('http://localhost/__bun__/modules/pkg/content-type.js'))
    expect(response).not.toBeNull()
    expect(response!.headers.get('Content-Type')).toBe('text/plain')
    expect(response!.headers.get('X-Source')).toBe('kernel')
    expect(await response!.text()).toBe('plain-body')
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

describe('A0-5 SW ↔ kernel integration', () => {
  test('createKernelPortResolver delegates to kernel.resolvePort', () => {
    let queriedPort: number | null = null
    const resolver = createKernelPortResolver({
      resolvePort(port) {
        queriedPort = port
        return 42
      },
    })

    expect(resolver.resolvePort(3000)).toBe(42)
    expect(queriedPort).toBe(3000)
  })

  test('extractVirtualPort parses port from path-style URL', () => {
    expect(extractVirtualPort(new URL('http://app.local/__bun__/4500/health'))).toBe(4500)
    expect(extractVirtualPort(new URL('http://app.local/normal/path'))).toBeNull()
    expect(extractVirtualPort(new URL('http://123.bun.local/home'))).toBeNull()
  })

  test('createKernelDispatcher routes path-style request via registry', async () => {
    const registry = {
      getHandler: (port: number) =>
        port === 5000 ? ((_req: Request) => new Response(`handler:${port}`)) : null,
    }
    const pidPortMap = new Map<number, number>()
    const dispatcher = createKernelDispatcher(registry, pidPortMap)

    const response = await dispatcher(99, new Request('http://app.local/__bun__/5000/ping'))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('handler:5000')
  })

  test('createKernelDispatcher routes host-style request via pidPortMap', async () => {
    const registry = {
      getHandler: (port: number) =>
        port === 6000 ? ((_req: Request) => new Response(`host-style:${port}`)) : null,
    }
    const pidPortMap = new Map([[77, 6000]])
    const dispatcher = createKernelDispatcher(registry, pidPortMap)

    const response = await dispatcher(77, new Request('http://77.bun.local/ping'))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('host-style:6000')
  })

  test('createKernelDispatcher returns 502 when no port mapping', async () => {
    const registry = { getHandler: () => null }
    const dispatcher = createKernelDispatcher(registry, new Map())

    const response = await dispatcher(999, new Request('http://999.bun.local/x'))
    expect(response.status).toBe(502)
  })

  test('createKernelDispatcher returns 502 when no handler for port', async () => {
    const registry = { getHandler: () => null }
    const pidPortMap = new Map([[10, 4444]])
    const dispatcher = createKernelDispatcher(registry, pidPortMap)

    const response = await dispatcher(10, new Request('http://10.bun.local/x'))
    expect(response.status).toBe(502)
  })

  test('installKernelServiceWorkerBridge wires kernel port table to SW routing', async () => {
    await Kernel.shutdown()
    clearServeRegistry()

    const kernel = await Kernel.boot({})
    serve({ port: 4801, pid: 801, fetch: (req: Request) => new Response(`ok:${new URL(req.url).pathname}`) }, kernel)

    const listeners = new Map<string, Function[]>()
    const add = (type: string, fn: Function) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    }
    const remove = (type: string, fn: Function) => {
      listeners.set(type, (listeners.get(type) ?? []).filter(f => f !== fn))
    }
    const scope = {
      addEventListener(type: 'fetch' | 'install' | 'activate', fn: Function) { add(type, fn) },
      removeEventListener(type: 'fetch' | 'install' | 'activate', fn: Function) { remove(type, fn) },
      skipWaiting() {},
      clients: { claim() {} },
    }

    const registry = { getHandler: (port: number) => getServeHandler(port) }
    const uninstall = installKernelServiceWorkerBridge(kernel, scope, registry)

    let responsePromise: Promise<Response> | null = null
    listeners.get('fetch')![0]({
      request: new Request('http://app.local/__bun__/4801/health'),
      respondWith(r: Promise<Response> | Response) { responsePromise = Promise.resolve(r) },
    })

    const res = await responsePromise!
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok:/__bun__/4801/health')

    uninstall()
    await Kernel.shutdown()
    clearServeRegistry()
  })

  test('installKernelServiceWorkerBridge tracks portRegistered events for host-style routing', async () => {
    await Kernel.shutdown()
    clearServeRegistry()

    const kernel = await Kernel.boot({})

    const listeners = new Map<string, Function[]>()
    const add = (type: string, fn: Function) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    }
    const scope = {
      addEventListener(type: 'fetch' | 'install' | 'activate', fn: Function) { add(type, fn) },
      removeEventListener() {},
      skipWaiting() {},
      clients: { claim() {} },
    }

    // Register serve handler and then emit portRegistered AFTER installKernelServiceWorkerBridge
    // (simulates runtime registering port after boot)
    const registry = {
      getHandler: (port: number) =>
        port === 4802 ? ((_req: Request) => new Response('from-pid-820')) : null,
    }
    const uninstall = installKernelServiceWorkerBridge(kernel, scope, registry)

    // Simulate runtime calling registerPort which emits portRegistered
    kernel.registerPort(820, 4802)

    let responsePromise: Promise<Response> | null = null
    listeners.get('fetch')![0]({
      request: new Request('http://820.bun.local/check'),
      respondWith(r: Promise<Response> | Response) { responsePromise = Promise.resolve(r) },
    })

    const res = await responsePromise!
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('from-pid-820')

    uninstall()
    await Kernel.shutdown()
    clearServeRegistry()
  })

  test('installKernelServiceWorkerBridge cleanup removes portRegistered subscription', async () => {
    await Kernel.shutdown()

    let listenCount = 0
    const fakeKernel = {
      resolvePort: (_port: number) => null as number | null,
      subscribe(_event: 'portRegistered', _listener: Function) {
        listenCount++
        return () => { listenCount-- }
      },
    }

    const scope = {
      addEventListener() {},
      removeEventListener() {},
    }
    const registry = { getHandler: () => null }

    const uninstall = installKernelServiceWorkerBridge(fakeKernel, scope, registry)
    expect(listenCount).toBe(1)

    uninstall()
    expect(listenCount).toBe(0)
  })

  test('installKernelServiceWorkerBridge can serve worker script before kernel routing', async () => {
    const listeners = new Map<string, Function[]>()
    const add = (type: string, fn: Function) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    }

    const scope = {
      addEventListener(type: 'fetch' | 'install' | 'activate', fn: Function) { add(type, fn) },
      removeEventListener() {},
      skipWaiting() {},
      clients: { claim() {} },
    }

    const kernel = {
      resolvePort: () => null,
      subscribe() {
        return () => {}
      },
    }

    const store: WorkerScriptStore = new Map()
    registerWorkerScript(store, '/__bun__/worker/bun-process.js', 'export default 1')

    const uninstall = installKernelServiceWorkerBridge(
      kernel,
      scope,
      { getHandler: () => null },
      { workerScripts: store },
    )

    let responsePromise: Promise<Response> | null = null
    listeners.get('fetch')![0]({
      request: new Request('http://localhost/__bun__/worker/bun-process.js'),
      respondWith(r: Promise<Response> | Response) { responsePromise = Promise.resolve(r) },
    })

    const res = await responsePromise!
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('export default 1')
    uninstall()
  })

  test('installKernelServiceWorkerBridge routes module namespace before kernel virtual routing', async () => {
    const listeners = new Map<string, Function[]>()
    const add = (type: string, fn: Function) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    }

    const scope = {
      addEventListener(type: 'fetch' | 'install' | 'activate', fn: Function) { add(type, fn) },
      removeEventListener() {},
      skipWaiting() {},
      clients: { claim() {} },
    }

    const kernel = {
      resolvePort: () => 123,
      subscribe() {
        return () => {}
      },
    }

    const uninstall = installKernelServiceWorkerBridge(
      kernel,
      scope,
      {
        getHandler: () => (_req: Request) => new Response('virtual-route-should-not-win'),
      },
      {
        moduleRequestBridge: {
          async requestModule(message) {
            return {
              type: 'MODULE_RESPONSE',
              requestId: message.requestId,
              status: 200,
              headers: [],
              contentType: 'application/javascript',
              buffer: new TextEncoder().encode(`module:${message.pathname}`).buffer,
            }
          },
        },
      },
    )

    let responsePromise: Promise<Response> | null = null
    listeners.get('fetch')![0]({
      request: new Request('http://localhost/__bun__/modules/pkg/index.js'),
      respondWith(r: Promise<Response> | Response) { responsePromise = Promise.resolve(r) },
    })

    const response = await responsePromise!
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('module:/__bun__/modules/pkg/index.js')

    uninstall()
  })

  test('installModuleMessageBridge responds to MODULE_REQUEST via event.source.postMessage', async () => {
    const listeners = new Map<string, Function[]>()
    const add = (type: string, fn: Function) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    }
    const remove = (type: string, fn: Function) => {
      listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry !== fn))
    }

    const scope = {
      addEventListener(type: 'fetch' | 'install' | 'activate' | 'message', fn: Function) {
        add(type, fn)
      },
      removeEventListener(type: 'fetch' | 'install' | 'activate' | 'message', fn: Function) {
        remove(type, fn)
      },
      skipWaiting() {},
      clients: { claim() {} },
    }

    let posted: unknown = null
    let postedTransfer: ArrayBuffer[] | undefined
    const uninstall = installModuleMessageBridge(scope, {
      async requestModule(message) {
        return {
          type: 'MODULE_RESPONSE',
          requestId: message.requestId,
          status: 200,
          headers: [['X-Bridge', 'sw']],
          contentType: 'application/javascript',
          buffer: new TextEncoder().encode('bridge:ok').buffer,
        }
      },
    })

    listeners.get('message')![0]({
      data: {
        type: 'MODULE_REQUEST',
        requestId: 'req-sw-message',
        pathname: '/__bun__/modules/pkg/bridge.js',
        method: 'GET',
        headers: [],
      },
      source: {
        postMessage(message: unknown, transfer?: ArrayBuffer[]) {
          posted = message
          postedTransfer = transfer
        },
      },
    })

    await Promise.resolve()

    expect(posted).not.toBeNull()
    expect((posted as { type: string }).type).toBe('MODULE_RESPONSE')
    expect((posted as { requestId: string }).requestId).toBe('req-sw-message')
    expect((posted as { status: number }).status).toBe(200)
    expect((posted as { headers: Array<[string, string]> }).headers).toEqual([['X-Bridge', 'sw']])
    expect((posted as { contentType: string }).contentType).toBe('application/javascript')
    expect(new TextDecoder().decode((posted as { buffer: ArrayBuffer }).buffer)).toBe('bridge:ok')
    expect(postedTransfer).toHaveLength(1)
    expect(postedTransfer![0]).toBe((posted as { buffer: ArrayBuffer }).buffer)

    uninstall()
    expect(listeners.get('message') ?? []).toHaveLength(0)
  })
})

// ─── Worker script interception (SW-served worker files) ─────────────────────

describe('Worker script interception via SW', () => {
  function makeFetchTarget() {
    const listeners: Array<(event: { request: Request; respondWith(r: Response | Promise<Response>): void }) => void> = []
    return {
      target: {
        addEventListener(_type: 'fetch', listener: (event: { request: Request; respondWith(r: Response | Promise<Response>): void }) => void) {
          listeners.push(listener)
        },
        removeEventListener(_type: 'fetch', listener: (event: { request: Request; respondWith(r: Response | Promise<Response>): void }) => void) {
          const idx = listeners.indexOf(listener)
          if (idx >= 0) listeners.splice(idx, 1)
        },
      },
      async dispatch(url: string): Promise<Response | null> {
        return new Promise(resolve => {
          let responded = false
          const event = {
            request: new Request(url),
            respondWith(r: Response | Promise<Response>) {
              responded = true
              Promise.resolve(r).then(res => resolve(res))
            },
          }
          if (listeners.length === 0) {
            resolve(null)
            return
          }
          for (const l of listeners) l(event)
          // If no listener called respondWith synchronously, resolve null
          if (!responded) resolve(null)
        })
      },
      listenerCount: () => listeners.length,
    }
  }

  test('registerWorkerScript inserts source into store', () => {
    const store: WorkerScriptStore = new Map()
    registerWorkerScript(store, '/__bun__/worker/bun-process.js', 'self.onmessage = () => {}')
    expect(store.get('/__bun__/worker/bun-process.js')).toBe('self.onmessage = () => {}')
  })

  test('installWorkerScriptInterceptor serves registered script as text/javascript', async () => {
    const store: WorkerScriptStore = new Map()
    registerWorkerScript(store, '/__bun__/worker/bun-process.js', 'const x = 1')

    const { target, dispatch } = makeFetchTarget()
    const uninstall = installWorkerScriptInterceptor(store, target)

    const res = await dispatch('http://localhost/__bun__/worker/bun-process.js')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    expect(res!.headers.get('Content-Type')).toBe('text/javascript')
    expect(await res!.text()).toBe('const x = 1')

    uninstall()
  })

  test('installWorkerScriptInterceptor ignores unregistered paths', async () => {
    const store: WorkerScriptStore = new Map()
    registerWorkerScript(store, '/__bun__/worker/bun-process.js', 'x')

    const { target, dispatch } = makeFetchTarget()
    installWorkerScriptInterceptor(store, target)

    const res = await dispatch('http://localhost/__bun__/worker/other.js')
    // no listener responded → null
    expect(res).toBeNull()
  })

  test('installWorkerScriptInterceptor cleanup removes fetch listener', () => {
    const store: WorkerScriptStore = new Map()
    const { target, listenerCount } = makeFetchTarget()
    const uninstall = installWorkerScriptInterceptor(store, target)
    expect(listenerCount()).toBe(1)
    uninstall()
    expect(listenerCount()).toBe(0)
  })

  test('detectWorkerScriptModuleType resolves package and extension rules', () => {
    expect(
      detectWorkerScriptModuleType('/__bun__/worker/pkg.js', {
        source: 'module.exports = 1',
        packageName: 'pkg',
        packageType: 'commonjs',
      }),
    ).toBe('cjs')

    expect(
      detectWorkerScriptModuleType('/__bun__/worker/pkg.mjs', {
        source: 'export default 1',
      }),
    ).toBe('esm')

    expect(
      detectWorkerScriptModuleType('/__bun__/worker/pkg.js', {
        source: 'export default 1',
        packageType: 'module',
      }),
    ).toBe('esm')

    expect(
      detectWorkerScriptModuleType('/__bun__/worker/pkg.cjs', {
        source: 'export default 1',
        packageType: 'module',
      }),
    ).toBe('cjs')

    expect(
      detectWorkerScriptModuleType('/__bun__/worker/pkg.js', {
        source: 'module.exports = 1',
        packageType: 'module',
        moduleFormat: 'cjs',
      }),
    ).toBe('cjs')

    expect(
      detectWorkerScriptModuleType('/__bun__/worker/pkg.js', {
        source: 'module.exports = 1',
        packageType: 'commonjs',
        moduleFormat: 'esm',
      }),
    ).toBe('esm')
  })

  test('EsbuildWorkerScriptProcessor converts cjs source via provided transformer', async () => {
    const processor = new EsbuildWorkerScriptProcessor({
      cjsToEsmTransform: async source => `export default (${JSON.stringify(source)})`,
    })

    const result = await processor.process({
      pathname: '/__bun__/worker/pkg.js',
      descriptor: {
        source: 'module.exports = 1',
        packageName: 'pkg',
        packageType: 'commonjs',
      },
      detectedModuleType: 'cjs',
    })

    expect(result.source).toContain('module.exports = 1')
    expect(result.contentType).toBe('text/javascript')
  })

  test('installWorkerScriptInterceptor uses processor output for cjs package script', async () => {
    const store: WorkerScriptStore = new Map()
    registerWorkerScript(
      store,
      '/__bun__/worker/pkg.js',
      'module.exports = 1',
      { packageName: 'pkg', packageType: 'commonjs' },
    )

    const processor = new EsbuildWorkerScriptProcessor({
      cjsToEsmTransform: async source => `export default (${JSON.stringify(source)})`,
    })

    const { target, dispatch } = makeFetchTarget()
    const uninstall = installWorkerScriptInterceptor(store, target, { processor })

    const res = await dispatch('http://localhost/__bun__/worker/pkg.js')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    expect(await res!.text()).toContain('module.exports = 1')

    uninstall()
  })

  test('installWorkerScriptInterceptor returns original cjs source without processor', async () => {
    const store: WorkerScriptStore = new Map()
    registerWorkerScript(
      store,
      '/__bun__/worker/raw-cjs.js',
      'module.exports = 9',
      { packageName: 'raw', packageType: 'commonjs' },
    )

    const { target, dispatch } = makeFetchTarget()
    const uninstall = installWorkerScriptInterceptor(store, target)

    const res = await dispatch('http://localhost/__bun__/worker/raw-cjs.js')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    expect(await res!.text()).toBe('module.exports = 9')

    uninstall()
  })

  test('PROCESS_EXECUTOR_WORKER_PATH is the canonical virtual path', () => {
    expect(PROCESS_EXECUTOR_WORKER_PATH).toBe('/__bun__/worker/bun-process.js')
  })

  test('createRuntimeProcessExecutor returns unknown-command 127 for non-bun argv', async () => {
    const executor = createRuntimeProcessExecutor()
    const result = await executor({
      argv: ['node', 'index.js'],
      cwd: '/',
      env: {},
      stdin: '',
      readMountedFile: () => null,
    })
    expect(result.exitCode).toBe(127)
    expect(result.stderr).toContain('node')
  })

  test('createRuntimeProcessExecutor(workerUrl) uses supplied URL', async () => {
    // Passing a non-existent URL; should fail gracefully with exit 1
    const executor = createRuntimeProcessExecutor({
      workerUrl: 'file:///nonexistent-worker-path.js',
    })
    const result = await executor({
      argv: ['bun', 'run', '/script.ts'],
      cwd: '/',
      env: {},
      stdin: '',
      readMountedFile: (path: string) => (path === '/script.ts' ? 'console.log("hi")' : null),
    })
    // Worker fails to load → exit 1 with error message
    expect(result.exitCode).toBe(1)
  })
})
