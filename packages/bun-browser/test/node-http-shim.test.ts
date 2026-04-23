/**
 * T5.17 单元测试：node:http createServer shim
 *
 * 直接加载 src/js/browser-polyfills/http.js 进行集成测试：
 *   T5.17.1 — createServer(handler) 委托到 Bun.serve
 *   T5.17.2 — IncomingMessage body 流（on('data'/'end')）
 *   T5.17.3 — ServerResponse 写入累积与 deferred Response 解析
 *
 * 测试在 Bun 原生运行时中直接执行，利用真实的 Bun.serve 验证端到端路由。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

// 直接 require polyfill 源文件（CJS 格式）
// 注意：在 Bun 原生运行时中，Bun.serve 是真实实现，正好可以验证委托逻辑。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require('../../../src/js/browser-polyfills/http.js') as {
  createServer: (handler: (req: any, res: any) => void) => {
    listen(port: number, cb?: () => void): any
    close(cb?: () => void): any
    address(): { port: number; family: string; address: string } | null
  }
  IncomingMessage: new (...args: any[]) => any
  ServerResponse: new (resolve?: (r: Response) => void) => any
  STATUS_CODES: Record<number, string>
  METHODS: string[]
  request: (opts: any, cb?: any) => any
}

// ---------------------------------------------------------------------------
// T5.17.3 ServerResponse 写入累积
// ---------------------------------------------------------------------------

describe('T5.17.3 ServerResponse 写入累积', () => {
  test('write() 累积 string chunk', () => {
    let resolved: Response | undefined
    const res = new http.ServerResponse((r: Response) => { resolved = r })
    res.write('hello ')
    res.write('world')
    res.end()
    expect(resolved).toBeDefined()
    expect(resolved!.status).toBe(200)
  })

  test('end() 传入 chunk 也被累积', async () => {
    let resolved: Response | undefined
    const res = new http.ServerResponse((r: Response) => { resolved = r })
    res.end('final')
    expect(resolved).toBeDefined()
    const text = await resolved!.text()
    expect(text).toBe('final')
  })

  test('write(Buffer/Uint8Array) chunk 累积', async () => {
    let resolved: Response | undefined
    const res = new http.ServerResponse((r: Response) => { resolved = r })
    res.write(new TextEncoder().encode('bin'))
    res.end()
    expect(resolved).toBeDefined()
    const text = await resolved!.text()
    expect(text).toBe('bin')
  })

  test('writeHead() 设置状态码与自定义 header', async () => {
    let resolved: Response | undefined
    const res = new http.ServerResponse((r: Response) => { resolved = r })
    res.writeHead(201, { 'x-custom': 'yes' })
    res.end('created')
    expect(resolved!.status).toBe(201)
    expect(resolved!.headers.get('x-custom')).toBe('yes')
  })

  test('setHeader/getHeader/removeHeader 可用', () => {
    const res = new http.ServerResponse()
    res.setHeader('Content-Type', 'text/html')
    expect(res.getHeader('content-type')).toBe('text/html')
    res.removeHeader('content-type')
    expect(res.getHeader('content-type')).toBeUndefined()
  })

  test('end() 触发 finish 事件', () => {
    let fired = false
    const res = new http.ServerResponse()
    res.on('finish', () => { fired = true })
    res.end()
    expect(fired).toBe(true)
  })

  test('finished / headersSent 在 end() 后为 true', () => {
    const res = new http.ServerResponse()
    expect(res.finished).toBe(false)
    expect(res.headersSent).toBe(false)
    res.end()
    expect(res.finished).toBe(true)
    expect(res.headersSent).toBe(true)
  })

  test('content-length header 自动计算', async () => {
    let resolved: Response | undefined
    const res = new http.ServerResponse((r: Response) => { resolved = r })
    res.end('hello')
    const cl = resolved!.headers.get('content-length')
    expect(cl).toBe('5')
  })
})

// ---------------------------------------------------------------------------
// T5.17.2 IncomingMessage
// ---------------------------------------------------------------------------

describe('T5.17.2 IncomingMessage', () => {
  test('从 Request 对象构造：url/method/headers', () => {
    const req = new Request('http://localhost:3000/api/test?q=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    const msg = new http.IncomingMessage(req)
    expect(msg.url).toBe('/api/test?q=1')
    expect(msg.method).toBe('POST')
    expect(msg.headers['content-type']).toBe('application/json')
  })

  test('向后兼容：从 (url, method, headers) 构造', () => {
    const msg = new http.IncomingMessage('/old', 'GET', { host: 'example.com' })
    expect(msg.url).toBe('/old')
    expect(msg.method).toBe('GET')
    expect(msg.headers.host).toBe('example.com')
  })

  test('on("end") 对无 body 的请求立即触发', async () => {
    const req = new Request('http://localhost:3000/')
    const msg = new http.IncomingMessage(req)
    const ended = new Promise<void>(resolve => { msg.on('end', resolve) })
    await expect(ended).resolves.toBeUndefined()
  })

  test('on("data") + on("end") 读取 body', async () => {
    const body = 'hello body'
    const req = new Request('http://localhost:3000/', {
      method: 'POST',
      body,
    })
    const msg = new http.IncomingMessage(req)
    const chunks: Uint8Array[] = []
    await new Promise<void>(resolve => {
      msg.on('data', (c: Uint8Array) => chunks.push(c))
      msg.on('end', resolve)
    })
    const combined = new TextDecoder().decode(
      chunks.reduce((acc, c) => {
        const merged = new Uint8Array(acc.byteLength + c.byteLength)
        merged.set(acc)
        merged.set(c, acc.byteLength)
        return merged
      }, new Uint8Array(0)),
    )
    expect(combined).toBe(body)
  })

  test('pipe() 将 body 流转到 ServerResponse', async () => {
    const body = 'piped content'
    const req = new Request('http://localhost:3000/', { method: 'POST', body })
    const msg = new http.IncomingMessage(req)
    let resolved: Response | undefined
    const res = new http.ServerResponse((r: Response) => { resolved = r })
    msg.pipe(res)
    // Wait for end event to trigger res.end()
    await new Promise<void>(resolve => { msg.on('end', () => setTimeout(resolve, 10)) })
    // res.end() called by pipe
    if (!res.finished) res.end()
    expect(resolved).toBeDefined()
    const text = await resolved!.text()
    expect(text).toBe(body)
  })
})

// ---------------------------------------------------------------------------
// T5.17.1 createServer → Bun.serve 委托（端到端）
// ---------------------------------------------------------------------------

describe('T5.17.1 createServer 端到端', () => {
  let server: ReturnType<typeof http.createServer>
  let port: number

  beforeAll(async () => {
    server = http.createServer((req: any, res: any) => {
      if (req.method === 'GET' && req.url === '/hello') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('Hello, World!')
      } else if (req.method === 'POST' && req.url === '/echo') {
        const chunks: Uint8Array[] = []
        req.on('data', (c: Uint8Array) => chunks.push(c))
        req.on('end', () => {
          const body = chunks.reduce((acc, c) => {
            const m = new Uint8Array(acc.byteLength + c.byteLength)
            m.set(acc); m.set(c, acc.byteLength)
            return m
          }, new Uint8Array(0))
          res.writeHead(200, { 'content-type': 'application/octet-stream' })
          res.end(body)
        })
      } else {
        res.writeHead(404)
        res.end('not found')
      }
    })
    await new Promise<void>(resolve => { server.listen(0, resolve) })
    port = server.address()!.port
  })

  afterAll(() => { server.close() })

  test('GET /hello → 200 Hello, World!', async () => {
    const resp = await fetch(`http://localhost:${port}/hello`)
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe('Hello, World!')
  })

  test('POST /echo → body 回显', async () => {
    const resp = await fetch(`http://localhost:${port}/echo`, {
      method: 'POST',
      body: 'test payload',
    })
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe('test payload')
  })

  test('未知路由 → 404', async () => {
    const resp = await fetch(`http://localhost:${port}/unknown`)
    expect(resp.status).toBe(404)
  })

  test('address() 返回真实端口', () => {
    const addr = server.address()
    expect(addr).not.toBeNull()
    expect(addr!.port).toBeGreaterThan(0)
    expect(addr!.family).toBe('IPv4')
  })
})

// ---------------------------------------------------------------------------
// STATUS_CODES / METHODS
// ---------------------------------------------------------------------------

describe('T5.17 http 模块导出', () => {
  test('STATUS_CODES 包含常用状态码', () => {
    expect(http.STATUS_CODES[200]).toBe('OK')
    expect(http.STATUS_CODES[404]).toBe('Not Found')
    expect(http.STATUS_CODES[500]).toBe('Internal Server Error')
  })

  test('METHODS 包含 GET/POST/PUT/DELETE', () => {
    expect(http.METHODS).toContain('GET')
    expect(http.METHODS).toContain('POST')
    expect(http.METHODS).toContain('PUT')
    expect(http.METHODS).toContain('DELETE')
  })
})
