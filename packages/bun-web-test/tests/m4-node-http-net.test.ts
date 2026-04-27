import { describe, expect, test } from 'vitest'
import {
  configureNetTunnel,
  connect,
  createNetServer,
  createSecureContext,
  createServer,
  get,
  https,
  request,
  tlsConnect,
} from '../../../packages/bun-web-node/src/http-net'
import { WSTunnel } from '../../../packages/bun-web-net/src'

const decoder = new TextDecoder()

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

    expect(body).toBe('abc123')
    live.stop(true)
  })

  test('http request concatenates multiple write chunks', async () => {
    const live = Bun.serve({
      port: 0,
      fetch: async req => new Response(await req.text()),
    })

    const body = await new Promise<string>(resolve => {
      const req = request(
        `http://127.0.0.1:${live.port}/concat`,
        { method: 'POST' },
        async response => {
          resolve(await response.text())
        },
      )

      req.write('ab')
      req.write('cd')
      req.end('ef')
    })

    expect(body).toBe('abcdef')
    live.stop(true)
  })

  test('http request header mutators affect outgoing headers', async () => {
    const live = Bun.serve({
      port: 0,
      fetch: req => {
        const trace = req.headers.get('x-trace')
        const drop = req.headers.get('x-drop')
        return new Response(JSON.stringify({ trace, drop }))
      },
    })

    const result = await new Promise<{ trace: string | null; drop: string | null }>(resolve => {
      const req = request(
        `http://127.0.0.1:${live.port}/headers`,
        { method: 'POST' },
        async response => {
          resolve((await response.json()) as { trace: string | null; drop: string | null })
        },
      )

      req.setHeader('x-trace', 'm4')
      req.setHeader('x-drop', 'remove-me')
      expect(req.getHeader('x-trace')).toBe('m4')
      req.removeHeader('x-drop')
      req.end()
    })

    expect(result).toEqual({ trace: 'm4', drop: null })
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

  test('net createServer/connect can exchange data', async () => {
    const server = createNetServer(socket => {
      socket.on('data', chunk => {
        const text = decoder.decode(chunk as Uint8Array)
        socket.write(`echo:${text}`)
      })
    })

    server.listen(9101)
    expect(server.address()).toEqual({ port: 9101, address: '127.0.0.1', family: 'IPv4' })

    const response = await new Promise<string>(resolve => {
      const client = tlsConnect(9101)
      client.on('data', chunk => {
        resolve(decoder.decode(chunk as Uint8Array))
        client.end()
      })
      client.on('secureConnect', () => {
        client.write('ping')
      })
    })

    expect(response).toBe('echo:ping')
    server.close()
    expect(server.address()).toBeNull()
  })

  test('tls createSecureContext returns stable options object', () => {
    const context = createSecureContext({ ca: 'test-ca', cert: 'cert', key: 'key' })
    expect(context.options).toEqual({ ca: 'test-ca', cert: 'cert', key: 'key' })
  })

  test('connect bridges through configured ws tunnel', async () => {
    configureNetTunnel('ws://bridge.local/ws-tunnel')

    const remote = new WSTunnel({
      tunnelUrl: 'ws://bridge.local/ws-tunnel',
      target: '127.0.0.1:9201',
      proto: 'tcp',
    })
    await remote.connect()

    const remoteReader = remote.readable.getReader()
    const remoteIncoming = remoteReader.read().then(next => decoder.decode(next.value))

    const echoed = new Promise<string>(resolve => {
      const client = connect(9201)
      client.on('connect', () => {
        client.write('bridge-ping')
      })
      client.on('data', chunk => {
        resolve(decoder.decode(chunk as Uint8Array))
        client.end()
      })
    })

    expect(await remoteIncoming).toBe('bridge-ping')
    remote.write(new TextEncoder().encode('bridge-pong'))
    expect(await echoed).toBe('bridge-pong')

    remoteReader.releaseLock()
    remote.close()
    configureNetTunnel(null)
  })

  test('tlsConnect bridges through configured ws tunnel using tls channel', async () => {
    configureNetTunnel('ws://bridge.local/ws-tunnel')

    const remoteTLS = new WSTunnel({
      tunnelUrl: 'ws://bridge.local/ws-tunnel',
      target: '127.0.0.1:9301',
      proto: 'tls',
    })
    await remoteTLS.connect()

    const remoteReader = remoteTLS.readable.getReader()
    const remoteIncoming = remoteReader.read().then(next => decoder.decode(next.value))

    const echoed = new Promise<string>(resolve => {
      const client = tlsConnect(9301)
      client.on('secureConnect', () => {
        client.write('tls-ping')
      })
      client.on('data', chunk => {
        resolve(decoder.decode(chunk as Uint8Array))
        client.end()
      })
    })

    expect(await remoteIncoming).toBe('tls-ping')
    remoteTLS.write(new TextEncoder().encode('tls-pong'))
    expect(await echoed).toBe('tls-pong')

    remoteReader.releaseLock()
    remoteTLS.close()
    configureNetTunnel(null)
  })

  test('https.request applies https protocol for RequestOptions input', async () => {
    const originalFetch = globalThis.fetch
    let seenURL = ''

    globalThis.fetch = (async (input: string | URL | Request) => {
      seenURL = String(input)
      return new Response('ok', { status: 200, statusText: 'OK' })
    }) as typeof fetch

    const body = await new Promise<string>(resolve => {
      const req = https.request(
        { hostname: 'example.test', path: '/secure', method: 'POST' },
        async response => {
          resolve(await response.text())
        },
      )
      req.end('x')
    })

    globalThis.fetch = originalFetch

    expect(seenURL).toBe('https://example.test/secure')
    expect(body).toBe('ok')
  })

  test('request emits error when fetch rejects', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('network-fail')
    }) as typeof fetch

    const message = await new Promise<string>(resolve => {
      const req = request('http://error.test', { method: 'GET' })
      req.on('error', err => {
        resolve((err as Error).message)
      })
      req.end()
    })

    globalThis.fetch = originalFetch
    expect(message).toContain('network-fail')
  })
})
