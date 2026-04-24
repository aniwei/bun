import { describe, expect, test } from 'vitest'
import { PreviewController } from '../../../packages/bun-web-client/src'
import { lookup, resolveDoH } from '../../../packages/bun-web-dns/src'
import { createProxyServer } from '../../../packages/bun-web-proxy-server/src'
import { ServiceWorkerHeartbeat } from '../../../packages/bun-web-sw/src'

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

  test('heartbeat recovers after success and marks failures', async () => {
    let call = 0
    const heartbeat = new ServiceWorkerHeartbeat(() => {
      call += 1
      if (call <= 2) return false
      return true
    }, 3000, 1)

    await heartbeat.tick()
    await heartbeat.tick()
    expect(heartbeat.needsRecovery()).toBe(true)

    await heartbeat.tick()
    expect(heartbeat.needsRecovery()).toBe(false)
  })
})
