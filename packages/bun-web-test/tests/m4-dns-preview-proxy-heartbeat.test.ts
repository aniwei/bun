import { describe, expect, test } from 'vitest'
import { PreviewController } from '../../../packages/bun-web-client/src'
import { lookup, resolveDoH } from '../../../packages/bun-web-dns/src'
import { createProxyServer } from '../../../packages/bun-web-proxy-server/src'
import { ServiceWorkerHeartbeat } from '../../../packages/bun-web-sw/src'

class MockProxySocket {
  sent: string[] = []
  private readonly listeners = {
    message: new Set<(event?: { data?: Uint8Array | ArrayBuffer | string }) => void>(),
    close: new Set<(event?: { data?: Uint8Array | ArrayBuffer | string }) => void>(),
  }

  send(payload: Uint8Array): void {
    this.sent.push(new TextDecoder().decode(payload))
  }

  close(): void {
    this.emit('close')
  }

  addEventListener(
    type: 'message' | 'close',
    listener: (event?: { data?: Uint8Array | ArrayBuffer | string }) => void,
  ): void {
    this.listeners[type].add(listener)
  }

  removeEventListener(
    type: 'message' | 'close',
    listener: (event?: { data?: Uint8Array | ArrayBuffer | string }) => void,
  ): void {
    this.listeners[type].delete(listener)
  }

  emit(type: 'message' | 'close', event?: { data?: Uint8Array | ArrayBuffer | string }): void {
    for (const listener of this.listeners[type]) {
      listener(event)
    }
  }
}

describe('M4 dns + preview + proxy + heartbeat', () => {
  test('resolveDoH sends query and parses answers', async () => {
    let seenURL = ''
    const response = await resolveDoH('github.com', 'A', {
      fetchFn: async input => {
        seenURL = String(input)
        return new Response(
          JSON.stringify({
            Status: 0,
            Answer: [{ name: 'github.com', type: 1, TTL: 30, data: '140.82.114.4' }],
          }),
          { status: 200, headers: { 'content-type': 'application/dns-json' } },
        )
      },
    })

    expect(seenURL).toContain('name=github.com')
    expect(seenURL).toContain('type=A')
    expect(response.Status).toBe(0)
  })

  test('lookup returns first A record', async () => {
    const ip = await lookup('example.com', {
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            Status: 0,
            Answer: [{ name: 'example.com', type: 1, TTL: 10, data: '93.184.216.34' }],
          }),
          { status: 200, headers: { 'content-type': 'application/dns-json' } },
        ),
    })

    expect(ip).toBe('93.184.216.34')
  })

  test('PreviewController binds and updates iframe URL', () => {
    const controller = new PreviewController()
    const iframe = { src: '' } as unknown as HTMLIFrameElement

    controller.bind(iframe)
    const url = controller.updateFromServerReady({ host: '127.0.0.1', port: 5173 })

    expect(url).toBe('http://127.0.0.1:5173')
    expect(iframe.src).toBe('http://127.0.0.1:5173')
    expect(controller.getCurrentURL()).toBe('http://127.0.0.1:5173')
  })

  test('proxy server throws NotSupportedError without tunnel URL', () => {
    expect(() => createProxyServer({})).toThrow(/required/i)
  })

  test('proxy server builds tunnel URL when configured', () => {
    const proxy = createProxyServer({ tunnelURL: 'wss://proxy.example.test/tunnel' })
    const url = proxy.buildTunnelURL('redis.internal:6379', 'tcp')

    expect(url).toContain('target=redis.internal%3A6379')
    expect(url).toContain('protocol=tcp')
  })

  test('proxy lifecycle and tunnel validation enforce auth + target policy', async () => {
    const proxy = createProxyServer({
      tunnelURL: 'wss://proxy.example.test/tunnel',
      allowedTargets: ['db.internal:', 'redis.internal:'],
      authToken: 'secret',
    })

    expect(proxy.isRunning).toBe(false)

    expect(
      proxy.validateTunnelRequest({
        target: 'db.internal:5432',
        protocol: 'tcp',
        authorization: 'Bearer secret',
      }),
    ).toMatchObject({ ok: false, status: 503 })

    await proxy.start()
    expect(proxy.isRunning).toBe(true)

    expect(
      proxy.validateTunnelRequest({
        target: 'db.internal:5432',
        protocol: 'tcp',
      }),
    ).toMatchObject({ ok: false, status: 401 })

    expect(
      proxy.validateTunnelRequest({
        target: 'api.internal:8443',
        protocol: 'tls',
        authorization: 'Bearer secret',
      }),
    ).toMatchObject({ ok: false, status: 403 })

    expect(
      proxy.validateTunnelRequest({
        target: 'db.internal:5432',
        protocol: 'tls',
        authorization: 'Bearer secret',
      }),
    ).toMatchObject({ ok: true, status: 101, protocol: 'tls' })

    await proxy.stop()
    expect(proxy.isRunning).toBe(false)
  })

  test('proxy buildTunnelURL respects allowlist', () => {
    const proxy = createProxyServer({
      tunnelURL: 'wss://proxy.example.test/tunnel',
      allowedTargets: ['redis.internal:'],
    })

    expect(() => proxy.buildTunnelURL('db.internal:5432', 'tcp')).toThrow(/not allowed/i)
    expect(proxy.buildTunnelURL('redis.internal:6379', 'tcp')).toContain('target=redis.internal%3A6379')
  })

  test('proxy handles Request tunnel upgrade and tracks active sessions', async () => {
    const proxy = createProxyServer({
      tunnelURL: 'wss://proxy.example.test/tunnel',
      allowedTargets: ['db.internal:'],
      authToken: 'secret',
    })

    await proxy.start()

    const denied = proxy.handleTunnelRequest(
      new Request('https://proxy.example.test/tunnel?target=db.internal:5432&protocol=tcp'),
    )
    expect(denied).toMatchObject({ ok: false, status: 401 })
    expect(proxy.activeTunnelCount).toBe(0)

    const accepted = proxy.handleTunnelRequest(
      new Request('https://proxy.example.test/tunnel?target=db.internal:5432&proto=tls', {
        headers: { authorization: 'Bearer secret' },
      }),
    )

    expect(accepted.ok).toBe(true)
    expect(accepted.status).toBe(101)
    expect(accepted.session?.target).toBe('db.internal:5432')
    expect(accepted.session?.protocol).toBe('tls')
    expect(proxy.activeTunnelCount).toBe(1)
    expect(proxy.listTunnels()).toHaveLength(1)

    const closed = proxy.closeTunnel(accepted.session!.id)
    expect(closed).toBe(true)
    expect(proxy.activeTunnelCount).toBe(0)

    await proxy.stop()
  })

  test('proxy stop clears active sessions', async () => {
    const proxy = createProxyServer({
      tunnelURL: 'wss://proxy.example.test/tunnel',
    })

    await proxy.start()
    const accepted = proxy.handleTunnelRequest({ target: 'db.internal:5432', protocol: 'tcp' })
    expect(accepted.ok).toBe(true)
    expect(proxy.activeTunnelCount).toBe(1)

    await proxy.stop()
    expect(proxy.activeTunnelCount).toBe(0)
  })

  test('proxy handleFetch accepts tunnel and exposes session headers', async () => {
    const proxy = createProxyServer({
      tunnelURL: 'wss://proxy.example.test/tunnel',
      allowedTargets: ['db.internal:'],
      authToken: 'secret',
    })
    await proxy.start()

    const response = await proxy.handleFetch(
      new Request('https://proxy.example.test/tunnel?target=db.internal:5432&protocol=tcp', {
        method: 'GET',
        headers: { authorization: 'Bearer secret' },
      }),
      {
        onTunnelOpen: ({ session }) => {
          expect(session.target).toBe('db.internal:5432')
        },
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('x-proxy-target')).toBe('db.internal:5432')
    expect(response.headers.get('x-proxy-protocol')).toBe('tcp')
    expect(response.headers.get('x-proxy-tunnel-id')).toBeTruthy()
    expect(proxy.activeTunnelCount).toBe(1)

    await proxy.stop()
  })

  test('proxy handleFetch rejects method and rolls back tunnel when bootstrap fails', async () => {
    const proxy = createProxyServer({
      tunnelURL: 'wss://proxy.example.test/tunnel',
      allowedTargets: ['db.internal:'],
    })
    await proxy.start()

    const wrongMethod = await proxy.handleFetch(
      new Request('https://proxy.example.test/tunnel?target=db.internal:5432', {
        method: 'POST',
      }),
    )
    expect(wrongMethod.status).toBe(405)

    const bootstrapFailed = await proxy.handleFetch(
      new Request('https://proxy.example.test/tunnel?target=db.internal:5432&protocol=tls', {
        method: 'GET',
      }),
      {
        onTunnelOpen: () => {
          throw new Error('bootstrap failed')
        },
      },
    )

    expect(bootstrapFailed.status).toBe(502)
    expect(await bootstrapFailed.text()).toContain('bootstrap failed')
    expect(proxy.activeTunnelCount).toBe(0)

    await proxy.stop()
  })

  test('proxy handleFetch connects transport and closes on stop', async () => {
    const closed: string[] = []
    const proxy = createProxyServer({
      tunnelURL: 'wss://proxy.example.test/tunnel',
      allowedTargets: ['db.internal:'],
      transport: {
        connect(target, protocol) {
          return {
            close() {
              closed.push(`${target}:${protocol}`)
            },
          }
        },
      },
    })

    await proxy.start()
    const response = await proxy.handleFetch(
      new Request('https://proxy.example.test/tunnel?target=db.internal:5432&protocol=tls', {
        method: 'GET',
      }),
    )

    expect(response.status).toBe(200)
    expect(proxy.activeTunnelCount).toBe(1)

    await proxy.stop()
    expect(proxy.activeTunnelCount).toBe(0)
    expect(closed).toEqual(['db.internal:5432:tls'])
  })

  test('proxy handleFetch rolls back when transport connect fails', async () => {
    const proxy = createProxyServer({
      tunnelURL: 'wss://proxy.example.test/tunnel',
      allowedTargets: ['db.internal:'],
      transport: {
        connect() {
          throw new Error('dial failed')
        },
      },
    })

    await proxy.start()
    const response = await proxy.handleFetch(
      new Request('https://proxy.example.test/tunnel?target=db.internal:5432&protocol=tcp', {
        method: 'GET',
      }),
    )

    expect(response.status).toBe(502)
    expect(await response.text()).toContain('dial failed')
    expect(proxy.activeTunnelCount).toBe(0)

    await proxy.stop()
  })

  test('proxy forwards writeTunnelData to transport connection', async () => {
    const writes: string[] = []
    const proxy = createProxyServer({
      tunnelURL: 'wss://proxy.example.test/tunnel',
      allowedTargets: ['db.internal:'],
      transport: {
        connect() {
          return {
            write(payload) {
              writes.push(new TextDecoder().decode(payload))
            },
            close() {},
          }
        },
      },
    })

    await proxy.start()
    const response = await proxy.handleFetch(
      new Request('https://proxy.example.test/tunnel?target=db.internal:5432&protocol=tcp', {
        method: 'GET',
      }),
    )
    const sessionId = response.headers.get('x-proxy-tunnel-id')
    expect(sessionId).toBeTruthy()

    await proxy.writeTunnelData(sessionId!, new TextEncoder().encode('ping'))
    expect(writes).toEqual(['ping'])

    await proxy.stop()
  })

  test('proxy dispatches inbound transport data to subscribers', async () => {
    let onData: ((payload: Uint8Array) => void) | null = null
    const proxy = createProxyServer({
      tunnelURL: 'wss://proxy.example.test/tunnel',
      allowedTargets: ['db.internal:'],
      transport: {
        connect() {
          return {
            onData(handler) {
              onData = handler
            },
            close() {},
          }
        },
      },
    })

    await proxy.start()
    const response = await proxy.handleFetch(
      new Request('https://proxy.example.test/tunnel?target=db.internal:5432&protocol=tls', {
        method: 'GET',
      }),
    )
    const sessionId = response.headers.get('x-proxy-tunnel-id')
    expect(sessionId).toBeTruthy()

    const received: string[] = []
    const unsubscribe = proxy.subscribeTunnelData(sessionId!, payload => {
      received.push(new TextDecoder().decode(payload))
    })

    onData?.(new TextEncoder().encode('hello-from-remote'))
    expect(received).toEqual(['hello-from-remote'])

    unsubscribe()
    onData?.(new TextEncoder().encode('ignored'))
    expect(received).toEqual(['hello-from-remote'])

    await proxy.stop()
  })

  test('proxy websocket bridge forwards both directions and cleans on close', async () => {
    let pushInbound: ((payload: Uint8Array) => void) | null = null
    const writes: string[] = []

    const proxy = createProxyServer({
      tunnelURL: 'wss://proxy.example.test/tunnel',
      allowedTargets: ['db.internal:'],
      transport: {
        connect() {
          return {
            write(payload) {
              writes.push(new TextDecoder().decode(payload))
            },
            onData(handler) {
              pushInbound = handler
            },
            close() {},
          }
        },
      },
    })

    await proxy.start()
    const response = await proxy.handleFetch(
      new Request('https://proxy.example.test/tunnel?target=db.internal:5432&protocol=tcp', {
        method: 'GET',
      }),
    )

    const sessionId = response.headers.get('x-proxy-tunnel-id')
    expect(sessionId).toBeTruthy()

    const socket = new MockProxySocket()
    const unbind = proxy.bindWebSocket(sessionId!, socket)

    socket.emit('message', { data: 'client-ping' })
    expect(writes).toEqual(['client-ping'])

    pushInbound?.(new TextEncoder().encode('server-pong'))
    expect(socket.sent).toEqual(['server-pong'])

    socket.close()
    expect(proxy.activeTunnelCount).toBe(0)

    unbind()
    await proxy.stop()
  })

  test('proxy runtime adapter starts server and dispatches fetch handler', async () => {
    let dispatch: ((request: Request) => Promise<Response>) | null = null
    let stopped = false

    const proxy = createProxyServer({
      tunnelURL: 'wss://proxy.example.test/tunnel',
      allowedTargets: ['db.internal:'],
      runtime: {
        async start(config) {
          dispatch = config.fetch
          return {
            url: 'http://127.0.0.1:3011/tunnel',
            async stop() {
              stopped = true
            },
          }
        },
      },
    })

    await proxy.start()
    expect(proxy.isRunning).toBe(true)
    expect(proxy.url).toBe('http://127.0.0.1:3011/tunnel')
    expect(dispatch).toBeTruthy()

    const response = await dispatch!(
      new Request('http://127.0.0.1:3011/tunnel?target=db.internal:5432&protocol=tcp', {
        method: 'GET',
      }),
    )

    expect(response.status).toBe(200)
    expect(proxy.activeTunnelCount).toBe(1)

    await proxy.stop()
    expect(stopped).toBe(true)
    expect(proxy.isRunning).toBe(false)
    expect(proxy.url).toBe('wss://proxy.example.test/tunnel')
  })

  test('heartbeat recovers after success and marks failures', async () => {
    let call = 0
    const heartbeat = new ServiceWorkerHeartbeat(() => {
      call += 1
      if (call <= 2) return false
      return true
    }, 3000, 1)

    await heartbeat.tick()
    await heartbeat.tick()
    expect(heartbeat.recovery()).toBe(true)

    await heartbeat.tick()
    expect(heartbeat.recovery()).toBe(false)
  })
})
