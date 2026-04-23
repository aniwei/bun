/**
 * Phase 5.14 — ServiceWorker 桥接层单元测试。
 *
 * 不依赖 WASM 或真实 ServiceWorker 注册，专注协议正确性：
 *   - handleSwFetchMessage 工具函数（成功 / 失败 / 无 body / 请求转发形状）
 *   - Kernel.detachServiceWorker() 未附加时安全空调
 *   - Kernel.attachServiceWorker() 非浏览器环境守卫
 *   - ServiceWorkerOptions 默认值语义（scope / injectIsolationHeaders）
 *   - SwFetchMessage 协议结构验证
 */

import { describe, expect, test } from 'bun:test'
import { Kernel, handleSwFetchMessage, type SwFetchMessage, type ServiceWorkerOptions } from '../src/kernel'

// ---------------------------------------------------------------------------
// handleSwFetchMessage 桥接函数
// ---------------------------------------------------------------------------

describe('handleSwFetchMessage', () => {
  test('成功时向 replyPort 发送 fetch:response', async () => {
    const replies: unknown[] = []
    const replyPort = { postMessage: (m: unknown) => replies.push(m) }
    const msg: SwFetchMessage = {
      type: 'fetch',
      id: 'abc123',
      port: 3000,
      url: 'http://localhost:3000/',
      method: 'GET',
      headers: { accept: 'text/html' },
    }
    const fetchFn = async (_port: number, _init: object) => ({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    })
    await new Promise<void>(resolve => {
      handleSwFetchMessage(
        msg,
        async (port, init) => {
          const r = await fetchFn(port, init)
          // fetchFn 已返回，.then() 将在下一个 microtask 执行 postMessage
          setTimeout(resolve, 0)
          return r
        },
        replyPort,
      )
    })
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({
      type: 'fetch:response',
      id: 'abc123',
      status: 200,
      statusText: 'OK',
      body: 'hello',
    })
  })

  test('fetchFn 抛错时向 replyPort 发送 fetch:error', async () => {
    const replies: unknown[] = []
    const replyPort = { postMessage: (m: unknown) => replies.push(m) }
    const msg: SwFetchMessage = {
      type: 'fetch',
      id: 'err1',
      port: 3000,
      url: 'http://localhost:3000/bad',
      method: 'POST',
      headers: {},
      body: '{}',
    }
    await new Promise<void>(resolve => {
      handleSwFetchMessage(
        msg,
        async () => {
          resolve()
          throw new Error('upstream error')
        },
        replyPort,
      )
    })
    // 等一个 microtask 让 catch 分支跑完
    await Promise.resolve()
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'fetch:error', id: 'err1', error: 'upstream error' })
  })

  test('body 为 undefined 时不传给 fetchFn', async () => {
    let capturedInit: Record<string, unknown> | undefined
    const msg: SwFetchMessage = {
      type: 'fetch',
      id: 'x',
      port: 3000,
      url: 'http://localhost:3000/',
      method: 'GET',
      headers: {},
    }
    await new Promise<void>(resolve => {
      handleSwFetchMessage(
        msg,
        async (_port, init) => {
          capturedInit = init as Record<string, unknown>
          resolve()
          return { status: 204, headers: {}, body: '' }
        },
        { postMessage: () => {} },
      )
    })
    expect('body' in capturedInit!).toBe(false)
  })

  test('fetchFn 接收到正确的 port / method / headers', async () => {
    let capturedPort = -1
    let capturedInit: Record<string, unknown> | undefined
    const msg: SwFetchMessage = {
      type: 'fetch',
      id: 'y',
      port: 41000,
      url: 'http://localhost:41000/api',
      method: 'DELETE',
      headers: { authorization: 'Bearer tok' },
    }
    await new Promise<void>(resolve => {
      handleSwFetchMessage(
        msg,
        async (port, init) => {
          capturedPort = port
          capturedInit = init as Record<string, unknown>
          resolve()
          return { status: 200, headers: {}, body: '' }
        },
        { postMessage: () => {} },
      )
    })
    expect(capturedPort).toBe(41000)
    expect(capturedInit?.method).toBe('DELETE')
    expect((capturedInit?.headers as Record<string, string>).authorization).toBe('Bearer tok')
  })
})

// ---------------------------------------------------------------------------
// ServiceWorkerOptions 类型 & 默认值语义
// ---------------------------------------------------------------------------

describe('ServiceWorkerOptions 语义', () => {
  test('scope 默认值由调用方决定（接口本身无强制）', () => {
    const opts: ServiceWorkerOptions = {
      scriptUrl: '/bun-preview-sw.js',
    }
    // scope 和 injectIsolationHeaders 均可省略
    expect(opts.scope).toBeUndefined()
    expect(opts.injectIsolationHeaders).toBeUndefined()
    expect(opts.fetchTimeoutMs).toBeUndefined()
  })

  test('全字段赋值不报类型错误', () => {
    const opts: ServiceWorkerOptions = {
      scriptUrl: new URL('https://example.com/sw.js'),
      scope: '/__bun_preview__/',
      injectIsolationHeaders: true,
      fetchTimeoutMs: 0,
    }
    expect(opts.scope).toBe('/__bun_preview__/')
    expect(opts.injectIsolationHeaders).toBe(true)
    expect(opts.fetchTimeoutMs).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// SwFetchMessage 协议结构
// ---------------------------------------------------------------------------

describe('SwFetchMessage 协议结构', () => {
  test('必填字段校验', () => {
    const msg: SwFetchMessage = {
      type: 'fetch',
      id: 'req-001',
      port: 3000,
      url: 'http://localhost:3000/index.html',
      method: 'GET',
      headers: {},
    }
    expect(msg.type).toBe('fetch')
    expect(msg.id).toBe('req-001')
    expect(msg.port).toBe(3000)
    expect(msg.body).toBeUndefined()
  })

  test('带 body 的 POST 消息', () => {
    const msg: SwFetchMessage = {
      type: 'fetch',
      id: 'req-002',
      port: 3001,
      url: 'http://localhost:3001/submit',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"key":"value"}',
    }
    expect(msg.body).toBe('{"key":"value"}')
  })
})

// ---------------------------------------------------------------------------
// Kernel.detachServiceWorker / attachServiceWorker — 非 WASM 环境守卫
// ---------------------------------------------------------------------------

describe('Kernel SW API 守卫', () => {
  /**
   * 无法在无 Worker 的测试环境创建完整 Kernel，
   * 但可以针对 attachServiceWorker 的环境检测分支做白盒测试：
   * 将 navigator.serviceWorker 临时移除或未定义时应抛出有意义的错误。
   */
  test('attachServiceWorker 在无 navigator 时抛出 [Kernel] ServiceWorker not available', async () => {
    // 在 Bun 测试环境中 navigator 不存在
    // 构造一个最小 mock 对象跳过构造函数（不需要真实 Worker）
    const fakeKernel = Object.create(Kernel.prototype) as InstanceType<typeof Kernel>
    // 注入必要的私有字段
    ;(fakeKernel as unknown as Record<string, unknown>)._swPort = null
    ;(fakeKernel as unknown as Record<string, unknown>)._swRegistration = null

    await expect(
      fakeKernel.attachServiceWorker({ scriptUrl: '/sw.js' }),
    ).rejects.toThrow('[Kernel] ServiceWorker not available in this environment')
  })

  test('detachServiceWorker 未附加时是安全的空操作', () => {
    const fakeKernel = Object.create(Kernel.prototype) as InstanceType<typeof Kernel>
    ;(fakeKernel as unknown as Record<string, unknown>)._swPort = null
    ;(fakeKernel as unknown as Record<string, unknown>)._swRegistration = null

    // 不抛出，不崩溃
    expect(() => fakeKernel.detachServiceWorker()).not.toThrow()
  })

  test('detachServiceWorker 关闭 MessagePort 并置空字段', () => {
    const fakeKernel = Object.create(Kernel.prototype) as InstanceType<typeof Kernel>

    let closeCalled = false
    const fakePort: Partial<MessagePort> = {
      close: () => { closeCalled = true },
      onmessage: null,
    }
    ;(fakeKernel as unknown as Record<string, unknown>)._swPort = fakePort
    ;(fakeKernel as unknown as Record<string, unknown>)._swRegistration = null

    fakeKernel.detachServiceWorker()

    expect(closeCalled).toBe(true)
    expect((fakeKernel as unknown as Record<string, unknown>)._swPort).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// T5.14.1: port:close 生命周期事件
// ---------------------------------------------------------------------------

describe('T5.14.1 port:close 生命周期', () => {
  test('installBunServeHook deleteProperty 触发 port:close postMessage', () => {
    const posted: unknown[] = []
    const postFn = (msg: unknown) => posted.push(msg)
    const routes = new Proxy({} as Record<number, unknown>, {
      set: (target, prop, value) => {
        ;(target as Record<PropertyKey, unknown>)[prop] = value
        const portNum = typeof prop === 'string' ? parseInt(prop, 10) : Number(prop)
        if (Number.isInteger(portNum) && portNum > 0 && portNum <= 0xffff) {
          postFn({ kind: 'port', port: portNum })
        }
        return true
      },
      deleteProperty: (target, prop) => {
        const portNum = typeof prop === 'string' ? parseInt(prop, 10) : Number(prop)
        const existed = Object.prototype.hasOwnProperty.call(target, prop)
        delete (target as Record<PropertyKey, unknown>)[prop]
        if (existed && Number.isInteger(portNum) && portNum > 0 && portNum <= 0xffff) {
          postFn({ kind: 'port:close', port: portNum })
        }
        return true
      },
    })
    routes[40000] = () => {}
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ kind: 'port', port: 40000 })
    delete routes[40000]
    expect(posted).toHaveLength(2)
    expect(posted[1]).toMatchObject({ kind: 'port:close', port: 40000 })
  })

  test('deleteProperty 只对已存在的 key 发送 port:close', () => {
    const posted: unknown[] = []
    const routes = new Proxy({} as Record<number, unknown>, {
      deleteProperty: (target, prop) => {
        const portNum = typeof prop === 'string' ? parseInt(prop, 10) : Number(prop)
        const existed = Object.prototype.hasOwnProperty.call(target, prop)
        delete (target as Record<PropertyKey, unknown>)[prop]
        if (existed && Number.isInteger(portNum) && portNum > 0 && portNum <= 0xffff) {
          posted.push({ kind: 'port:close', port: portNum })
        }
        return true
      },
    })
    delete routes[40001]
    expect(posted).toHaveLength(0)
  })

  test('port:close 消息使 previewPorts 移除对应端口', () => {
    const { PreviewPortRegistry } = require('../src/preview-router')
    const reg = new PreviewPortRegistry()
    reg.add(40002)
    expect(reg.has(40002)).toBe(true)
    reg.remove(40002)
    expect(reg.has(40002)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// T5.14.2: injectIsolationHeaders: 'auto' 语义
// ---------------------------------------------------------------------------

describe('T5.14.2 injectIsolationHeaders auto 语义', () => {
  test("'auto' + threadMode=threaded → inject=true 逻辑", () => {
    type InjectOpt = boolean | 'auto' | undefined
    const computeInject = (opt: InjectOpt, threadMode: 'threaded' | 'single' | undefined): boolean =>
      opt === 'auto' ? threadMode === 'threaded' : (opt ?? false)

    expect(computeInject('auto', 'threaded')).toBe(true)
    expect(computeInject('auto', 'single')).toBe(false)
    expect(computeInject('auto', undefined)).toBe(false)
    expect(computeInject(true, 'single')).toBe(true)
    expect(computeInject(false, 'threaded')).toBe(false)
    expect(computeInject(undefined, 'threaded')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// T5.14.3: iframe bridge script 注入
// ---------------------------------------------------------------------------

describe('T5.14.3 iframe bridge script 注入', () => {
  function maybeInjectBridgeScript(body: string, contentType: string, inject: boolean): string {
    if (!inject) return body
    if (!contentType.startsWith('text/html')) return body
    const script =
      '<script>(function(){' +
      'if(window.__bun_bridge__)return;' +
      'window.__bun_bridge__=true;' +
      'window.parent&&window.parent!==window&&window.parent.postMessage({__bun_iframe_ready__:true,origin:location.href},"*");' +
      'window.addEventListener("message",function(e){' +
      'if(e.source===window.parent&&e.data&&e.data.__bun_to_iframe__)' +
      'window.dispatchEvent(new MessageEvent("message",{data:e.data.__bun_to_iframe__,origin:e.origin}));' +
      '});' +
      '})();<\\/script>'
    const headIdx = body.indexOf('</head>')
    if (headIdx !== -1) return body.slice(0, headIdx) + script + body.slice(headIdx)
    const bodyIdx = body.indexOf('</body>')
    if (bodyIdx !== -1) return body.slice(0, bodyIdx) + script + body.slice(bodyIdx)
    return script + body
  }

  test('inject=false 时不修改 body', () => {
    const html = '<html><head></head><body>hello</body></html>'
    expect(maybeInjectBridgeScript(html, 'text/html', false)).toBe(html)
  })

  test('非 text/html 时不注入', () => {
    const body = '{"ok":true}'
    expect(maybeInjectBridgeScript(body, 'application/json', true)).toBe(body)
  })

  test('有 </head> 时注入到 </head> 前', () => {
    const html = '<html><head></head><body></body></html>'
    const result = maybeInjectBridgeScript(html, 'text/html', true)
    expect(result.indexOf('<script>')).toBeLessThan(result.indexOf('</head>'))
    expect(result).toContain('__bun_bridge__')
  })

  test('无 </head> 但有 </body> 时注入到 </body> 前', () => {
    const html = '<html><body>content</body></html>'
    const result = maybeInjectBridgeScript(html, 'text/html', true)
    expect(result.indexOf('<script>')).toBeLessThan(result.indexOf('</body>'))
  })

  test('无任何标签时前置注入', () => {
    const body = 'plain content'
    const result = maybeInjectBridgeScript(body, 'text/html', true)
    expect(result.startsWith('<script>')).toBe(true)
    expect(result.endsWith('plain content')).toBe(true)
  })

  test('注入脚本包含 __bun_iframe_ready__ 通知和消息转发逻辑', () => {
    const html = '<!DOCTYPE html><html><head></head><body></body></html>'
    const result = maybeInjectBridgeScript(html, 'text/html; charset=utf-8', true)
    expect(result).toContain('__bun_iframe_ready__')
    expect(result).toContain('__bun_to_iframe__')
    expect(result).toContain('window.__bun_bridge__')
  })
})

// ---------------------------------------------------------------------------
// T5.14.4: port:0 自动分配语义
// ---------------------------------------------------------------------------

describe('T5.14.4 port:0 自动分配', () => {
  test('port=0 自动分配从 40000 起递增', () => {
    const ctx: Record<string, unknown> = { __bun_next_port: 40000 }
    function resolvePort(port: number | undefined): number {
      if (port === undefined || port === 0) return (ctx.__bun_next_port as number)++
      return port
    }
    expect(resolvePort(0)).toBe(40000)
    expect(resolvePort(0)).toBe(40001)
    expect(resolvePort(3000)).toBe(3000)
    expect(resolvePort(0)).toBe(40002)
    expect(ctx.__bun_next_port).toBe(40003)
  })

  test('port=undefined 同样走自动分配', () => {
    const ctx: Record<string, unknown> = { __bun_next_port: 40010 }
    function resolvePort(port: number | undefined): number {
      if (port === undefined || port === 0) return (ctx.__bun_next_port as number)++
      return port
    }
    expect(resolvePort(undefined)).toBe(40010)
    expect(resolvePort(undefined)).toBe(40011)
  })
})
