import { describe, expect, test } from 'vitest'
import {
  createSecureContext,
  VirtualSocket as NetVirtualSocket,
  WSTunnel,
} from '../../../packages/bun-web-net/src'
import { createProxyServer } from '../../../packages/bun-web-proxy-server/src'

const decoder = new TextDecoder()

describe('M4 net tunnel and socket polyfill', () => {
  test('WSTunnel can exchange bytes on same channel', async () => {
    const left = new WSTunnel({
      tunnelUrl: 'ws://tunnel.local/bridge',
      target: 'service.local:7000',
      proto: 'tcp',
    })
    const right = new WSTunnel({
      tunnelUrl: 'ws://tunnel.local/bridge',
      target: 'service.local:7000',
      proto: 'tcp',
    })

    await Promise.all([left.connect(), right.connect()])

    const payload = new Promise<string>(resolve => {
      const reader = right.readable.getReader()
      void reader.read().then(next => {
        resolve(decoder.decode(next.value))
        reader.releaseLock()
      })
    })

    left.write(new TextEncoder().encode('tunnel-ping'))
    expect(await payload).toBe('tunnel-ping')

    left.close()
    right.close()
  })

  test('VirtualSocket connects and receives data events', async () => {
    const client = new NetVirtualSocket('ws://tunnel.local/socket')
    const server = new WSTunnel({
      tunnelUrl: 'ws://tunnel.local/socket',
      target: '127.0.0.1:8123',
      proto: 'tcp',
    })
    await server.connect()

    const connected = new Promise<void>(resolve => {
      client.addEventListener('connect', () => resolve(), { once: true })
    })

    const data = new Promise<string>(resolve => {
      client.addEventListener('data', event => {
        const chunk = (event as MessageEvent<Uint8Array>).data
        resolve(decoder.decode(chunk))
      }, { once: true })
    })

    client.connect(8123)
    await connected

    server.write(new TextEncoder().encode('socket-ready'))
    expect(await data).toBe('socket-ready')

    client.end()
    server.close()
  })

  test('tls stub exposes options as-is', () => {
    const secure = createSecureContext({ cert: 'cert', key: 'key' })
    expect(secure.options).toEqual({ cert: 'cert', key: 'key' })
  })

  test('proxy tunnel URL interoperates with ws-tunnel protocol normalization', async () => {
    const proxy = createProxyServer({ tunnelURL: 'ws://proxy.local/tunnel' })
    const proxyURL = proxy.buildTunnelURL('db.local:5432', 'tcp')

    const fromProxyURL = new WSTunnel({
      tunnelUrl: proxyURL,
    })

    const direct = new WSTunnel({
      tunnelUrl: 'ws://proxy.local/tunnel',
      target: 'db.local:5432',
      proto: 'tcp',
    })

    await Promise.all([fromProxyURL.connect(), direct.connect()])

    const payload = new Promise<string>(resolve => {
      const reader = direct.readable.getReader()
      void reader.read().then(next => {
        resolve(decoder.decode(next.value))
        reader.releaseLock()
      })
    })

    fromProxyURL.write(new TextEncoder().encode('proxy-bridge'))
    expect(await payload).toBe('proxy-bridge')

    fromProxyURL.close()
    direct.close()
  })
})
