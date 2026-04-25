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
import type { ServerReadyEvent } from '@mars/web-client'

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

  it('boot() wires service-worker bridge when scope is provided and cleans up on shutdown', async () => {
    const listeners = new Map<string, Function[]>()
    const addListener = (type: string, listener: Function) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    }
    const removeListener = (type: string, listener: Function) => {
      listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== listener))
    }

    const container = await BunContainer.boot({
      installServiceWorkerFromKernel: true,
      serviceWorkerScope: {
        addEventListener(type: 'fetch' | 'install' | 'activate', listener: Function) {
          addListener(type, listener)
        },
        removeEventListener(type: 'fetch' | 'install' | 'activate', listener: Function) {
          removeListener(type, listener)
        },
        skipWaiting() {},
        clients: { claim() {} },
      },
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
  })

  it('boot() does not install service-worker bridge when installServiceWorkerFromKernel is false', async () => {
    const listeners = new Map<string, Function[]>()

    const container = await BunContainer.boot({
      installServiceWorkerFromKernel: false,
      serviceWorkerScope: {
        addEventListener(type: 'fetch' | 'install' | 'activate', listener: Function) {
          listeners.set(type, [...(listeners.get(type) ?? []), listener])
        },
        removeEventListener() {},
        skipWaiting() {},
        clients: { claim() {} },
      },
      serveHandlerRegistry: {
        getHandler: () => null,
      },
    })

    expect(listeners.get('fetch') ?? []).toHaveLength(0)
    expect(listeners.get('install') ?? []).toHaveLength(0)
    expect(listeners.get('activate') ?? []).toHaveLength(0)

    await container.shutdown()
  })

  it('boot() passes serviceWorkerScripts to SW bridge for script interception', async () => {
    const listeners = new Map<string, Function[]>()
    const addListener = (type: string, listener: Function) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    }

    const container = await BunContainer.boot({
      installServiceWorkerFromKernel: true,
      serviceWorkerScope: {
        addEventListener(type: 'fetch' | 'install' | 'activate', listener: Function) {
          addListener(type, listener)
        },
        removeEventListener() {},
        skipWaiting() {},
        clients: { claim() {} },
      },
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
  })

  it('boot() applies serviceWorkerScriptProcessor for package-style CJS script', async () => {
    const listeners = new Map<string, Function[]>()
    const addListener = (type: string, listener: Function) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    }

    const container = await BunContainer.boot({
      installServiceWorkerFromKernel: true,
      serviceWorkerScope: {
        addEventListener(type: 'fetch' | 'install' | 'activate', listener: Function) {
          addListener(type, listener)
        },
        removeEventListener() {},
        skipWaiting() {},
        clients: { claim() {} },
      },
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
  })

  it('boot() keeps package-style CJS script unchanged when no processor is provided', async () => {
    const listeners = new Map<string, Function[]>()
    const addListener = (type: string, listener: Function) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    }

    const container = await BunContainer.boot({
      installServiceWorkerFromKernel: true,
      serviceWorkerScope: {
        addEventListener(type: 'fetch' | 'install' | 'activate', listener: Function) {
          addListener(type, listener)
        },
        removeEventListener() {},
        skipWaiting() {},
        clients: { claim() {} },
      },
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
  })

  it('boot() treats moduleFormat=esm as higher priority than packageType=commonjs', async () => {
    const listeners = new Map<string, Function[]>()
    const addListener = (type: string, listener: Function) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    }

    const container = await BunContainer.boot({
      installServiceWorkerFromKernel: true,
      serviceWorkerScope: {
        addEventListener(type: 'fetch' | 'install' | 'activate', listener: Function) {
          addListener(type, listener)
        },
        removeEventListener() {},
        skipWaiting() {},
        clients: { claim() {} },
      },
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
  })

  it('boot() throws stable error when serviceWorkerScripts descriptor source is invalid', async () => {
    await expect(
      BunContainer.boot({
        installServiceWorkerFromKernel: true,
        serviceWorkerScope: {
          addEventListener() {},
          removeEventListener() {},
          skipWaiting() {},
          clients: { claim() {} },
        },
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
  })

  it('boot() throws stable error when serviceWorkerScripts key is not absolute pathname', async () => {
    await expect(
      BunContainer.boot({
        installServiceWorkerFromKernel: true,
        serviceWorkerScope: {
          addEventListener() {},
          removeEventListener() {},
          skipWaiting() {},
          clients: { claim() {} },
        },
        serveHandlerRegistry: {
          getHandler: () => null,
        },
        serviceWorkerScripts: {
          'relative/worker.js': 'export default 1',
        },
      }),
    ).rejects.toThrow('[BunContainer.boot] serviceWorkerScripts key must be an absolute pathname')
  })

  it('boot() validates Map-shaped serviceWorkerScripts keys as absolute pathnames', async () => {
    await expect(
      BunContainer.boot({
        installServiceWorkerFromKernel: true,
        serviceWorkerScope: {
          addEventListener() {},
          removeEventListener() {},
          skipWaiting() {},
          clients: { claim() {} },
        },
        serveHandlerRegistry: {
          getHandler: () => null,
        },
        serviceWorkerScripts: new Map([
          ['not-absolute.js', 'export default 1'],
        ]),
      }),
    ).rejects.toThrow('[BunContainer.boot] serviceWorkerScripts key must be an absolute pathname')
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
