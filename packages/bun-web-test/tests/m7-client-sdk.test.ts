/**
 * M7-8 — bun-web-client SDK 单元测试
 *
 * 覆盖：
 * - BunContainer.boot / shutdown 生命周期
 * - mount() 写入 fs 并发出 filechange 事件
 * - spawn() 返回 ContainerProcess（包含 pid/kill/waitForExit）
 * - eval() 返回字符串
 * - on('server-ready') / on('process-exit') / on('filechange') 事件
 * - attachTerminal() 返回 TerminalHandle
 * - shutdown 后操作抛出错误
 * - PreviewManager attach / onServerReady / handleReady / detach
 */

import { describe, it, expect } from 'vitest'
import { BunContainer, PreviewManager } from '@mars/web-client'
import { Kernel } from '@mars/web-kernel'
import type { ServerReadyEvent } from '@mars/web-client'

function installMockServiceWorkerGlobalScope() {
  const listeners = new Map<string, Function[]>()
  const target = globalThis as Record<string, unknown>

  const original = {
    addEventListener: target.addEventListener,
    removeEventListener: target.removeEventListener,
    skipWaiting: target.skipWaiting,
    clients: target.clients,
  }

  target.addEventListener = ((type: string, listener: Function) => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener])
  }) as unknown

  target.removeEventListener = ((type: string, listener: Function) => {
    listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== listener))
  }) as unknown

  target.skipWaiting = (() => {}) as unknown
  target.clients = { claim() {} }

  const restore = () => {
    target.addEventListener = original.addEventListener
    target.removeEventListener = original.removeEventListener
    target.skipWaiting = original.skipWaiting
    target.clients = original.clients
  }

  return { listeners, restore }
}

// ── BunContainer – 生命周期 ───────────────────────────────────────────────────

describe('BunContainer – lifecycle', () => {
  it('boot() returns a ready container', async () => {
    const container = await BunContainer.boot()
    expect(container.status).toBe('ready')
    await container.shutdown()
  })

  it('boot() with initial files mounts them', async () => {
    const container = await BunContainer.boot({
      files: { '/index.ts': 'console.log("hello")' },
    })
    expect(container.fs.get('/index.ts')).toBe('console.log("hello")')
    await container.shutdown()
  })

  it('shutdown() sets status to disposed', async () => {
    const container = await BunContainer.boot()
    await container.shutdown()
    expect(container.status).toBe('disposed')
  })

  it('method calls after shutdown throw', async () => {
    const container = await BunContainer.boot()
    await container.shutdown()
    await expect(container.mount({ '/x.ts': 'x' })).rejects.toThrow('disposed')
  })

  it('boot() wires service-worker bridge when running in service worker scope and cleans up on shutdown', async () => {
    const { listeners, restore } = installMockServiceWorkerGlobalScope()

    try {
      const container = await BunContainer.boot({
        serveHandlerRegistry: {
          getHandler: () => null,
        },
      })

      expect((listeners.get('fetch') ?? []).length).toBeGreaterThan(0)
      expect((listeners.get('install') ?? []).length).toBeGreaterThan(0)
      expect((listeners.get('activate') ?? []).length).toBeGreaterThan(0)

      await container.shutdown()

      expect(listeners.get('fetch') ?? []).toHaveLength(0)
      expect(listeners.get('install') ?? []).toHaveLength(0)
      expect(listeners.get('activate') ?? []).toHaveLength(0)
    } finally {
      restore()
    }
  })

  it('boot() registers service worker from main thread when serviceWorkerUrl is provided', async () => {
    const originalNavigator = globalThis.navigator
    const originalWindow = (globalThis as Record<string, unknown>).window
    const originalSkipWaiting = (globalThis as Record<string, unknown>).skipWaiting
    const originalClients = (globalThis as Record<string, unknown>).clients
    const registerCalls: Array<{ url: string; options?: RegistrationOptions }> = []

    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
    })

    Object.defineProperty(globalThis, 'skipWaiting', {
      value: undefined,
      configurable: true,
    })
    Object.defineProperty(globalThis, 'clients', {
      value: undefined,
      configurable: true,
    })

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          register: async (url: string, options?: RegistrationOptions) => {
            registerCalls.push({ url, options })
            return {} as ServiceWorkerRegistration
          },
          ready: Promise.resolve({} as ServiceWorkerRegistration),
        },
      },
      configurable: true,
    })

    try {
      const container = await BunContainer.boot({
        serviceWorkerUrl: '/sw.js',
        serviceWorkerRegisterOptions: { scope: '/' },
      })

      expect(registerCalls).toHaveLength(1)
      expect(registerCalls[0]?.url).toBe('/sw.js')
      expect(registerCalls[0]?.options).toEqual({ scope: '/' })

      await container.shutdown()
    } finally {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'skipWaiting', {
        value: originalSkipWaiting,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'clients', {
        value: originalClients,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      })
    }
  })

  it('boot() runs boot, before-register, register, and register-hook in order', async () => {
    const originalNavigator = globalThis.navigator
    const originalWindow = (globalThis as Record<string, unknown>).window
    const originalSkipWaiting = (globalThis as Record<string, unknown>).skipWaiting
    const originalClients = (globalThis as Record<string, unknown>).clients
    const order: string[] = []

    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
    })

    Object.defineProperty(globalThis, 'skipWaiting', {
      value: undefined,
      configurable: true,
    })
    Object.defineProperty(globalThis, 'clients', {
      value: undefined,
      configurable: true,
    })

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          register: async (_url: string, _options?: RegistrationOptions) => {
            order.push('register-call')
            return {} as ServiceWorkerRegistration
          },
          ready: Promise.resolve({} as ServiceWorkerRegistration),
        },
      },
      configurable: true,
    })

    try {
      const container = await BunContainer.boot({
        serviceWorkerUrl: '/sw.js',
        hooks: {
          boot: [() => order.push('boot-hook')],
          serviceWorkerBeforeRegister: [() => order.push('sw-before-register-hook')],
          serviceWorkerRegister: [() => order.push('sw-register-hook')],
        },
      })

      expect(order).toEqual([
        'boot-hook',
        'sw-before-register-hook',
        'register-call',
        'sw-register-hook',
      ])

      await container.shutdown()
    } finally {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'skipWaiting', {
        value: originalSkipWaiting,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'clients', {
        value: originalClients,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      })
    }
  })

  it('boot() continues when lifecycle hooks throw and publishes register.error hook', async () => {
    const originalNavigator = globalThis.navigator
    const originalWindow = (globalThis as Record<string, unknown>).window
    const originalSkipWaiting = (globalThis as Record<string, unknown>).skipWaiting
    const originalClients = (globalThis as Record<string, unknown>).clients
    const stages: string[] = []

    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
    })

    Object.defineProperty(globalThis, 'skipWaiting', {
      value: undefined,
      configurable: true,
    })
    Object.defineProperty(globalThis, 'clients', {
      value: undefined,
      configurable: true,
    })

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          register: async () => ({} as ServiceWorkerRegistration),
          ready: Promise.resolve({} as ServiceWorkerRegistration),
        },
      },
      configurable: true,
    })

    try {
      const container = await BunContainer.boot({
        serviceWorkerUrl: '/sw.js',
        hooks: {
          boot: [() => { throw new Error('boot hook failure') }],
          serviceWorkerBeforeRegister: [() => { throw new Error('before register hook failure') }],
          serviceWorkerRegister: [() => { throw new Error('register hook failure') }],
          serviceWorkerRegisterError: [payload => stages.push(payload.stage)],
        },
      })

      expect(container.status).toBe('ready')
      expect(stages).toEqual([
        'boot',
        'service-worker.before-register',
        'service-worker.register',
      ])

      await container.shutdown()
    } finally {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'skipWaiting', {
        value: originalSkipWaiting,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'clients', {
        value: originalClients,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      })
    }
  })

  it('boot() publishes service-worker.register.error hook when registration fails', async () => {
    const originalNavigator = globalThis.navigator
    const originalWindow = (globalThis as Record<string, unknown>).window
    const originalSkipWaiting = (globalThis as Record<string, unknown>).skipWaiting
    const originalClients = (globalThis as Record<string, unknown>).clients
    const errors: Array<{ stage: string; message: string }> = []

    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
    })

    Object.defineProperty(globalThis, 'skipWaiting', {
      value: undefined,
      configurable: true,
    })
    Object.defineProperty(globalThis, 'clients', {
      value: undefined,
      configurable: true,
    })

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          register: async () => {
            throw new Error('register boom')
          },
          ready: Promise.resolve({} as ServiceWorkerRegistration),
        },
      },
      configurable: true,
    })

    try {
      const container = await BunContainer.boot({
        serviceWorkerUrl: '/sw.js',
        hooks: {
          serviceWorkerRegisterError: [payload => {
            errors.push({
              stage: payload.stage,
              message: payload.error instanceof Error ? payload.error.message : String(payload.error),
            })
          }],
        },
      })

      expect(container.status).toBe('ready')
      expect(errors).toHaveLength(1)
      expect(errors[0]?.stage).toBe('service-worker.register')
      expect(errors[0]?.message).toContain('register boom')

      await container.shutdown()
    } finally {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'skipWaiting', {
        value: originalSkipWaiting,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'clients', {
        value: originalClients,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      })
    }
  })

  it('boot() exposes kernel.serviceWorker controller', async () => {
    const container = await BunContainer.boot()

    expect(container._kernel.serviceWorker).toBeDefined()
    expect(typeof container._kernel.serviceWorker.register).toBe('function')
    expect(typeof container._kernel.serviceWorker.unregister).toBe('function')

    await container.shutdown()
  })

  it('boot() routes module namespace requests through kernel moduleRequestHandler', async () => {
    const { listeners, restore } = installMockServiceWorkerGlobalScope()

    try {
      const container = await BunContainer.boot({
        serveHandlerRegistry: {
          getHandler: () => null,
        },
        moduleRequestHandler: async request => ({
          requestId: request.requestId,
          status: 200,
          headers: [['X-Module-Path', request.pathname]],
          contentType: 'application/javascript',
          buffer: new TextEncoder().encode('export const answer = 42').buffer,
        }),
      })

      let responsePromise: Promise<Response> | null = null
      listeners.get('fetch')![0]({
        request: new Request('http://localhost/__bun__/modules/pkg/index.js'),
        respondWith(response: Promise<Response> | Response) {
          responsePromise = Promise.resolve(response)
        },
      })

      const response = await responsePromise!
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('application/javascript')
      expect(response.headers.get('X-Module-Path')).toBe('/__bun__/modules/pkg/index.js')
      expect(await response.text()).toBe('export const answer = 42')

      await container.shutdown()
    } finally {
      restore()
    }
  })

  it('kernel.serviceWorker module request bridge preserves requestId and wraps handler errors', async () => {
    const container = await BunContainer.boot({
      moduleRequestHandler: async request => {
        if (request.pathname.endsWith('/fail.js')) {
          throw new Error('module boom')
        }

        return {
          requestId: request.requestId,
          status: 200,
          headers: [],
          contentType: 'application/javascript',
          buffer: new TextEncoder().encode(`ok:${request.pathname}`).buffer,
        }
      },
    })

    const bridge = Kernel.instance.serviceWorker.createModuleRequestBridge({ timeoutMs: 100 })

    const ok = await bridge.requestModule({
      type: 'MODULE_REQUEST',
      requestId: 'req-ok',
      pathname: '/__bun__/modules/pkg/ok.js',
      method: 'GET',
      headers: [],
    })

    expect(ok.type).toBe('MODULE_RESPONSE')
    expect(ok.requestId).toBe('req-ok')
    expect(ok.status).toBe(200)
    expect(new TextDecoder().decode(ok.buffer!)).toBe('ok:/__bun__/modules/pkg/ok.js')

    const failure = await bridge.requestModule({
      type: 'MODULE_REQUEST',
      requestId: 'req-fail',
      pathname: '/__bun__/modules/pkg/fail.js',
      method: 'GET',
      headers: [],
    })

    expect(failure.type).toBe('MODULE_RESPONSE')
    expect(failure.requestId).toBe('req-fail')
    expect(failure.status).toBe(500)
    expect(failure.error).toContain('module boom')

    await container.shutdown()
  })

  it('kernel.serviceWorker module request bridge resolves through configured transport', async () => {
    const container = await BunContainer.boot()
    const controller = container._kernel.serviceWorker

    controller.configureModuleRequestTransport({
      send(message) {
        queueMicrotask(() => {
          controller.receiveModuleResponse({
            type: 'MODULE_RESPONSE',
            requestId: message.requestId,
            status: 200,
            headers: [['X-Transport', 'yes']],
            contentType: 'application/javascript',
            buffer: new TextEncoder().encode(`transport:${message.pathname}`).buffer,
          })
        })
      },
    })

    const bridge = controller.createModuleRequestBridge({ timeoutMs: 100 })
    const response = await bridge.requestModule({
      type: 'MODULE_REQUEST',
      requestId: 'req-transport',
      pathname: '/__bun__/modules/pkg/transport.js',
      method: 'GET',
      headers: [],
    })

    expect(response.requestId).toBe('req-transport')
    expect(response.status).toBe(200)
    expect(response.headers).toEqual([['X-Transport', 'yes']])
    expect(new TextDecoder().decode(response.buffer!)).toBe('transport:/__bun__/modules/pkg/transport.js')

    controller.configureModuleRequestTransport(null)
    await container.shutdown()
  })

  it('kernel.serviceWorker module message listener handles MODULE_RESPONSE payloads', async () => {
    const container = await BunContainer.boot()
    const controller = container._kernel.serviceWorker
    const listener = controller.createModuleMessageListener()

    controller.configureModuleRequestTransport({
      send(message) {
        queueMicrotask(() => {
          listener({
            data: {
              type: 'MODULE_RESPONSE',
              requestId: message.requestId,
              status: 200,
              headers: [],
              contentType: 'application/javascript',
              buffer: new TextEncoder().encode('listener:ok').buffer,
            },
          })
        })
      },
    })

    const bridge = controller.createModuleRequestBridge({ timeoutMs: 100 })
    const response = await bridge.requestModule({
      type: 'MODULE_REQUEST',
      requestId: 'req-listener',
      pathname: '/__bun__/modules/pkg/listener.js',
      method: 'GET',
      headers: [],
    })

    expect(response.requestId).toBe('req-listener')
    expect(new TextDecoder().decode(response.buffer!)).toBe('listener:ok')

    controller.configureModuleRequestTransport(null)
    await container.shutdown()
  })

  it('kernel.serviceWorker module request bridge falls back to postMessageToActive transport', async () => {
    const originalNavigator = globalThis.navigator
    const posted: unknown[] = []

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          controller: {
            postMessage(message: unknown) {
              posted.push(message)
              queueMicrotask(() => {
                container._kernel.serviceWorker.receiveModuleResponse({
                  type: 'MODULE_RESPONSE',
                  requestId: (message as { requestId: string }).requestId,
                  status: 200,
                  headers: [],
                  contentType: 'application/javascript',
                  buffer: new TextEncoder().encode('postmessage:ok').buffer,
                })
              })
            },
          },
        },
      },
      configurable: true,
    })

    try {
      const container = await BunContainer.boot()
      const bridge = container._kernel.serviceWorker.createModuleRequestBridge({ timeoutMs: 100 })

      const response = await bridge.requestModule({
        type: 'MODULE_REQUEST',
        requestId: 'req-postmessage',
        pathname: '/__bun__/modules/pkg/postmessage.js',
        method: 'GET',
        headers: [['X-Test', '1']],
      })

      expect(posted).toHaveLength(1)
      expect((posted[0] as { type: string }).type).toBe('MODULE_REQUEST')
      expect(response.requestId).toBe('req-postmessage')
      expect(new TextDecoder().decode(response.buffer!)).toBe('postmessage:ok')

      await container.shutdown()
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      })
    }
  })

  it('kernel.serviceWorker module request bridge rejects when no active controller is available', async () => {
    const originalNavigator = globalThis.navigator

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          controller: null,
        },
      },
      configurable: true,
    })

    try {
      const container = await BunContainer.boot()
      const bridge = container._kernel.serviceWorker.createModuleRequestBridge({ timeoutMs: 100 })

      await expect(
        bridge.requestModule({
          type: 'MODULE_REQUEST',
          requestId: 'req-no-controller',
          pathname: '/__bun__/modules/pkg/no-controller.js',
          method: 'GET',
          headers: [],
        }),
      ).rejects.toThrow('No active service worker controller available for module request transport')

      await container.shutdown()
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      })
    }
  })

  it('kernel.serviceWorker module request bridge rejects duplicate in-flight request ids', async () => {
    const container = await BunContainer.boot()
    const controller = container._kernel.serviceWorker

    controller.configureModuleRequestTransport({
      send() {
        return new Promise(() => {})
      },
    })

    const bridge = controller.createModuleRequestBridge({ timeoutMs: 1000 })
    const first = bridge.requestModule({
      type: 'MODULE_REQUEST',
      requestId: 'req-duplicate',
      pathname: '/__bun__/modules/pkg/first.js',
      method: 'GET',
      headers: [],
    })

    await expect(
      bridge.requestModule({
        type: 'MODULE_REQUEST',
        requestId: 'req-duplicate',
        pathname: '/__bun__/modules/pkg/second.js',
        method: 'GET',
        headers: [],
      }),
    ).rejects.toThrow('Duplicate module request id: req-duplicate')

    controller.receiveModuleResponse({
      type: 'MODULE_RESPONSE',
      requestId: 'req-duplicate',
      status: 200,
      headers: [],
    })
    await first

    controller.configureModuleRequestTransport(null)
    await container.shutdown()
  })

  it('kernel.serviceWorker module request bridge rejects on transport timeout', async () => {
    const container = await BunContainer.boot()
    const controller = container._kernel.serviceWorker

    controller.configureModuleRequestTransport({
      send() {
        return new Promise(() => {})
      },
    })

    const bridge = controller.createModuleRequestBridge({ timeoutMs: 10 })

    await expect(
      bridge.requestModule({
        type: 'MODULE_REQUEST',
        requestId: 'req-timeout',
        pathname: '/__bun__/modules/pkg/timeout.js',
        method: 'GET',
        headers: [],
      }),
    ).rejects.toThrow('Module request timed out: /__bun__/modules/pkg/timeout.js')

    controller.configureModuleRequestTransport(null)
    await container.shutdown()
  })

  it('kernel shutdown rejects pending module requests immediately', async () => {
    const container = await BunContainer.boot()
    const controller = Kernel.instance.serviceWorker

    controller.configureModuleRequestTransport({
      send() {
        return new Promise(() => {})
      },
    })

    const bridge = controller.createModuleRequestBridge({ timeoutMs: 1000 })
    const pending = bridge.requestModule({
      type: 'MODULE_REQUEST',
      requestId: 'req-shutdown-pending',
      pathname: '/__bun__/modules/pkg/pending.js',
      method: 'GET',
      headers: [],
    })

    await container.shutdown()

    await expect(pending).rejects.toThrow('Kernel service worker controller disposed')
  })

  it('boot() installs and removes navigator.serviceWorker message listener on main thread', async () => {
    const originalNavigator = globalThis.navigator
    const originalWindow = (globalThis as Record<string, unknown>).window
    const originalSkipWaiting = (globalThis as Record<string, unknown>).skipWaiting
    const originalClients = (globalThis as Record<string, unknown>).clients
    const listeners = new Map<string, Function[]>()

    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
    })

    Object.defineProperty(globalThis, 'skipWaiting', {
      value: undefined,
      configurable: true,
    })
    Object.defineProperty(globalThis, 'clients', {
      value: undefined,
      configurable: true,
    })

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          addEventListener(type: string, listener: Function) {
            listeners.set(type, [...(listeners.get(type) ?? []), listener])
          },
          removeEventListener(type: string, listener: Function) {
            listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== listener))
          },
          controller: {
            postMessage() {},
          },
          register: async () => ({} as ServiceWorkerRegistration),
          ready: Promise.resolve({} as ServiceWorkerRegistration),
        },
      },
      configurable: true,
    })

    try {
      const container = await BunContainer.boot({
        moduleRequestHandler: async request => ({
          requestId: request.requestId,
          status: 200,
          headers: [],
        }),
      })

      expect((listeners.get('message') ?? []).length).toBe(1)

      await container.shutdown()

      expect(listeners.get('message') ?? []).toHaveLength(0)
    } finally {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'skipWaiting', {
        value: originalSkipWaiting,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'clients', {
        value: originalClients,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      })
    }
  })

  it('boot() registers service worker with web-sw package default URL when serviceWorkerUrl is not provided', async () => {
    const originalNavigator = globalThis.navigator
    const originalWindow = (globalThis as Record<string, unknown>).window
    const originalSkipWaiting = (globalThis as Record<string, unknown>).skipWaiting
    const originalClients = (globalThis as Record<string, unknown>).clients
    const registerCalls: Array<{ url: string; options?: RegistrationOptions }> = []

    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
    })

    Object.defineProperty(globalThis, 'skipWaiting', {
      value: undefined,
      configurable: true,
    })
    Object.defineProperty(globalThis, 'clients', {
      value: undefined,
      configurable: true,
    })

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          register: async (url: string, options?: RegistrationOptions) => {
            registerCalls.push({ url, options })
            return {} as ServiceWorkerRegistration
          },
          ready: Promise.resolve({} as ServiceWorkerRegistration),
        },
      },
      configurable: true,
    })

    try {
      const container = await BunContainer.boot()

      expect(registerCalls).toHaveLength(1)
      expect(registerCalls[0]?.url).toBe('/@mars/web-sw/sw.js')
      expect(registerCalls[0]?.options).toBeUndefined()

      await container.shutdown()
    } finally {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'skipWaiting', {
        value: originalSkipWaiting,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'clients', {
        value: originalClients,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      })
    }
  })

  it('boot() passes serviceWorkerScripts to SW bridge for script interception', async () => {
    const { listeners, restore } = installMockServiceWorkerGlobalScope()

    try {
      const container = await BunContainer.boot({
        serveHandlerRegistry: {
          getHandler: () => null,
        },
        serviceWorkerScripts: {
          '/__bun__/worker/custom.js': 'export default 42',
        },
      })

      let responsePromise: Promise<Response> | null = null
      listeners.get('fetch')![0]({
        request: new Request('http://localhost/__bun__/worker/custom.js'),
        respondWith(response: Promise<Response> | Response) {
          responsePromise = Promise.resolve(response)
        },
      })

      const response = await responsePromise!
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('export default 42')

      await container.shutdown()
    } finally {
      restore()
    }
  })

  it('boot() applies serviceWorkerScriptProcessor for package-style CJS script', async () => {
    const { listeners, restore } = installMockServiceWorkerGlobalScope()

    try {
      const container = await BunContainer.boot({
        serveHandlerRegistry: {
          getHandler: () => null,
        },
        serviceWorkerScripts: {
          '/__bun__/worker/pkg.js': {
            source: 'module.exports = 7',
            packageName: 'pkg',
            packageType: 'commonjs',
          },
        },
        serviceWorkerScriptProcessor: {
          async process(input) {
            if (input.detectedModuleType === 'cjs') {
              return {
                source: `export default (${JSON.stringify(input.descriptor.source)})`,
                contentType: 'text/javascript',
              }
            }

            return {
              source: input.descriptor.source,
              contentType: 'text/javascript',
            }
          },
        },
      })

      let responsePromise: Promise<Response> | null = null
      listeners.get('fetch')![0]({
        request: new Request('http://localhost/__bun__/worker/pkg.js'),
        respondWith(response: Promise<Response> | Response) {
          responsePromise = Promise.resolve(response)
        },
      })

      const response = await responsePromise!
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('module.exports = 7')

      await container.shutdown()
    } finally {
      restore()
    }
  })

  it('boot() keeps package-style CJS script unchanged when no processor is provided', async () => {
    const { listeners, restore } = installMockServiceWorkerGlobalScope()

    try {
      const container = await BunContainer.boot({
        serveHandlerRegistry: {
          getHandler: () => null,
        },
        serviceWorkerScripts: {
          '/__bun__/worker/raw-cjs.js': {
            source: 'module.exports = 9',
            packageName: 'raw',
            packageType: 'commonjs',
          },
        },
      })

      let responsePromise: Promise<Response> | null = null
      listeners.get('fetch')![0]({
        request: new Request('http://localhost/__bun__/worker/raw-cjs.js'),
        respondWith(response: Promise<Response> | Response) {
          responsePromise = Promise.resolve(response)
        },
      })

      const response = await responsePromise!
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('module.exports = 9')

      await container.shutdown()
    } finally {
      restore()
    }
  })

  it('boot() treats moduleFormat=esm as higher priority than packageType=commonjs', async () => {
    const { listeners, restore } = installMockServiceWorkerGlobalScope()

    try {
      const container = await BunContainer.boot({
        serveHandlerRegistry: {
          getHandler: () => null,
        },
        serviceWorkerScripts: {
          '/__bun__/worker/force-esm.js': {
            source: 'module.exports = 11',
            packageName: 'force-esm',
            packageType: 'commonjs',
            moduleFormat: 'esm',
          },
        },
        serviceWorkerScriptProcessor: {
          process(input) {
            return {
              source: `//detected:${input.detectedModuleType}\n${input.descriptor.source}`,
              contentType: 'text/javascript',
            }
          },
        },
      })

      let responsePromise: Promise<Response> | null = null
      listeners.get('fetch')![0]({
        request: new Request('http://localhost/__bun__/worker/force-esm.js'),
        respondWith(response: Promise<Response> | Response) {
          responsePromise = Promise.resolve(response)
        },
      })

      const response = await responsePromise!
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('//detected:esm')

      await container.shutdown()
    } finally {
      restore()
    }
  })

  it('boot() throws stable error when serviceWorkerScripts descriptor source is invalid', async () => {
    const { restore } = installMockServiceWorkerGlobalScope()
    try {
      await expect(
        BunContainer.boot({
          serveHandlerRegistry: {
            getHandler: () => null,
          },
          serviceWorkerScripts: {
            '/__bun__/worker/invalid.js': {
              source: 123 as unknown as string,
            },
          },
        }),
      ).rejects.toThrow('[BunContainer.boot] serviceWorkerScripts[/__bun__/worker/invalid.js].source must be a string')
    } finally {
      restore()
    }
  })

  it('boot() throws stable error when serviceWorkerScripts key is not absolute pathname', async () => {
    const { restore } = installMockServiceWorkerGlobalScope()
    try {
      await expect(
        BunContainer.boot({
          serveHandlerRegistry: {
            getHandler: () => null,
          },
          serviceWorkerScripts: {
            'relative/worker.js': 'export default 1',
          },
        }),
      ).rejects.toThrow('[BunContainer.boot] serviceWorkerScripts key must be an absolute pathname')
    } finally {
      restore()
    }
  })

  it('boot() validates Map-shaped serviceWorkerScripts keys as absolute pathnames', async () => {
    const { restore } = installMockServiceWorkerGlobalScope()
    try {
      await expect(
        BunContainer.boot({
          serveHandlerRegistry: {
            getHandler: () => null,
          },
          serviceWorkerScripts: new Map([
            ['not-absolute.js', 'export default 1'],
          ]),
        }),
      ).rejects.toThrow('[BunContainer.boot] serviceWorkerScripts key must be an absolute pathname')
    } finally {
      restore()
    }
  })
})

// ── BunContainer – mount ──────────────────────────────────────────────────────

describe('BunContainer – mount', () => {
  it('mount() adds files to fs', async () => {
    const container = await BunContainer.boot()
    await container.mount({ '/a.ts': 'const a = 1', '/b.ts': 'const b = 2' })

    expect(container.fs.get('/a.ts')).toBe('const a = 1')
    expect(container.fs.get('/b.ts')).toBe('const b = 2')
    await container.shutdown()
  })

  it('mount() emits filechange events', async () => {
    const container = await BunContainer.boot()
    const changes: string[] = []
    container.on('filechange', e => changes.push(e.path))

    await container.mount({ '/x.ts': 'x', '/y.ts': 'y' })
    expect(changes).toContain('/x.ts')
    expect(changes).toContain('/y.ts')
    await container.shutdown()
  })

  it('mount() accepts Uint8Array content', async () => {
    const container = await BunContainer.boot()
    const data = new Uint8Array([1, 2, 3])
    await container.mount({ '/binary': data })
    expect(container.fs.get('/binary')).toBeInstanceOf(Uint8Array)
    await container.shutdown()
  })
})

// ── BunContainer – spawn ──────────────────────────────────────────────────────

describe('BunContainer – spawn', () => {
  it('spawn() returns a ContainerProcess with pid', async () => {
    const container = await BunContainer.boot()
    const proc = await container.spawn({ argv: ['echo', 'hello'] })

    expect(typeof proc.pid).toBe('number')
    expect(proc.pid).toBeGreaterThan(0)
    await container.shutdown()
  })

  it('kill() resolves waitForExit and emits process-exit', async () => {
    const container = await BunContainer.boot()
    const exits: number[] = []
    container.on('process-exit', e => exits.push(e.pid))

    const proc = await container.spawn({ argv: ['sleep', '10'] })
    proc.kill(9)

    const code = await proc.waitForExit()
    expect(typeof code).toBe('number')
    expect(exits).toContain(proc.pid)
    await container.shutdown()
  })

  it('spawn() has stdout and stderr readable streams', async () => {
    const container = await BunContainer.boot()
    const proc = await container.spawn({ argv: ['echo', 'hello'] })

    expect(proc.stdout).toBeInstanceOf(ReadableStream)
    expect(proc.stderr).toBeInstanceOf(ReadableStream)
    await container.shutdown()
  })

  it('boot() injected processExecutor drives spawn stdio and exit code', async () => {
    const container = await BunContainer.boot({
      processExecutor: async request => ({
        exitCode: 23,
        stdout: `injected:${request.argv.join(' ')}\n`,
        stderr: '',
      }),
    })

    const proc = await container.spawn({ argv: ['sdk-custom-cmd', 'from-sdk'] })
    const reader = proc.stdout.getReader()
    const chunks: Uint8Array[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }

    const size = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
    const merged = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }

    expect(new TextDecoder().decode(merged)).toBe('injected:sdk-custom-cmd from-sdk\n')
    expect(await proc.waitForExit()).toBe(23)
    await container.shutdown()
  })

  it('boot() workerUrl overrides default runtime process executor worker script URL', async () => {
    const container = await BunContainer.boot({
      workerUrl: 'file:///nonexistent-worker-path.js',
    })

    await container.mount({
      '/script.ts': 'console.log("hello-from-script")',
    })

    const proc = await container.spawn({ argv: ['bun', 'run', '/script.ts'] })
    const reader = proc.stderr.getReader()
    const chunks: Uint8Array[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }

    const size = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
    const merged = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }

    const stderr = new TextDecoder().decode(merged)
    expect(stderr).toContain('bun worker execution failed')
    expect(await proc.waitForExit()).toBe(1)

    await container.shutdown()
  })
})

// ── BunContainer – eval ───────────────────────────────────────────────────────

describe('BunContainer – eval', () => {
  it('eval() returns a string (stub)', async () => {
    const container = await BunContainer.boot()
    const result = await container.eval('console.log("hi")')
    expect(typeof result).toBe('string')
    await container.shutdown()
  })
})

// ── BunContainer – attachTerminal ─────────────────────────────────────────────

describe('BunContainer – attachTerminal', () => {
  it('attachTerminal() returns a TerminalHandle with expected methods', async () => {
    const container = await BunContainer.boot()
    const terminal = container.attachTerminal()

    expect(typeof terminal.attach).toBe('function')
    expect(typeof terminal.write).toBe('function')
    expect(typeof terminal.dispose).toBe('function')

    // stub 方法不应抛出
    expect(() => terminal.write('test')).not.toThrow()
    expect(() => terminal.dispose()).not.toThrow()
    await container.shutdown()
  })
})

// ── BunContainer – event subscription ────────────────────────────────────────

describe('BunContainer – event subscription', () => {
  it('on() returns an unsubscribe function', async () => {
    const container = await BunContainer.boot()
    const received: string[] = []
    const unsub = container.on('filechange', e => received.push(e.path))

    await container.mount({ '/a.ts': 'a' })
    expect(received).toContain('/a.ts')

    unsub()
    await container.mount({ '/b.ts': 'b' })
    expect(received).not.toContain('/b.ts')
    await container.shutdown()
  })

  it('server-ready event is received by listener', async () => {
    const container = await BunContainer.boot()
    const events: ServerReadyEvent[] = []
    container.on('server-ready', e => events.push(e))

    await container.mount({
      '/serve-sdk.ts': `
        Bun.serve({
          port: 9443,
          hostname: '127.0.0.1',
          tls: true,
          fetch() {
            return new Response('ok')
          },
        })
        console.log('ready')
      `,
    })

    const proc = await container.spawn({ argv: ['bun', 'run', '/serve-sdk.ts'] })
    expect(await proc.waitForExit()).toBe(0)

    expect(events).toContainEqual({
      url: 'https://127.0.0.1:9443',
      host: '127.0.0.1',
      port: 9443,
      protocol: 'https',
    })
    await container.shutdown()
  })
})

// ── PreviewManager ────────────────────────────────────────────────────────────

describe('PreviewManager', () => {
  it('handleReady updates currentURL', () => {
    const pm = new PreviewManager()
    pm.handleReady({ url: 'http://localhost:3000', host: 'localhost', port: 3000, protocol: 'http' })
    expect(pm.getCurrentURL()).toBe('http://localhost:3000')
  })

  it('onServerReady callback is called on handleReady', () => {
    const pm = new PreviewManager()
    const received: ServerReadyEvent[] = []
    pm.onServerReady(e => received.push(e))

    pm.handleReady({ url: 'http://localhost:8080', host: 'localhost', port: 8080, protocol: 'http' })
    expect(received).toHaveLength(1)
    expect(received[0]!.port).toBe(8080)
  })

  it('onServerReady fires immediately if event already occurred', () => {
    const pm = new PreviewManager()
    pm.handleReady({ url: 'http://localhost:5173', host: 'localhost', port: 5173, protocol: 'http' })

    const received: ServerReadyEvent[] = []
    pm.onServerReady(e => received.push(e))

    expect(received).toHaveLength(1)
    expect(received[0]!.port).toBe(5173)
  })

  it('onServerReady returns unsubscribe function', () => {
    const pm = new PreviewManager()
    const received: ServerReadyEvent[] = []
    const unsub = pm.onServerReady(e => received.push(e))

    pm.handleReady({ url: 'http://localhost:3000', host: 'localhost', port: 3000, protocol: 'http' })
    expect(received).toHaveLength(1)

    unsub()
    pm.handleReady({ url: 'http://localhost:4000', host: 'localhost', port: 4000, protocol: 'http' })
    expect(received).toHaveLength(1) // 未增加
  })

  it('detach removes iframe reference', () => {
    const pm = new PreviewManager()
    pm.detach()
    // detach 后 handleReady 不应 throw
    expect(() =>
      pm.handleReady({ url: 'http://localhost:3000', host: 'localhost', port: 3000, protocol: 'http' })
    ).not.toThrow()
  })

  it('getCurrentURL is null before any handleReady', () => {
    const pm = new PreviewManager()
    expect(pm.getCurrentURL()).toBeNull()
  })
})
