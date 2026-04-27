import { describe, expect, test } from 'vitest'
import { HTTPBridge, VirtualWebSocket } from '../../../packages/bun-web-net/src'

describe('M4 HTTP bridge + virtual websocket', () => {
  test('HTTPBridge returns 404 when handler is missing', async () => {
    const bridge = new HTTPBridge({ getServeHandler: () => null })
    const response = await bridge.dispatch(9999, new Request('http://example.test/'))
    expect(response.status).toBe(404)
  })

  test('HTTPBridge converts handler throw to 500', async () => {
    const bridge = new HTTPBridge({
      getServeHandler() {
        return () => {
          throw new Error('bridge crash')
        }
      },
    })

    const response = await bridge.dispatch(1234, new Request('http://example.test/'))
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('bridge crash')
  })

  test('VirtualWebSocket open/message/close flow works', async () => {
    const sender = new VirtualWebSocket('ws://room.test/channel')
    const receiver = new VirtualWebSocket('ws://room.test/channel')

    const opened = new Promise<void>(resolve => {
      let count = 0
      const mark = () => {
        count += 1
        if (count === 2) resolve()
      }
      sender.addEventListener('open', mark)
      receiver.addEventListener('open', mark)
    })
    await opened

    const payload = new Promise<string>(resolve => {
      receiver.addEventListener('message', event => {
        resolve((event as MessageEvent).data as string)
      })
    })

    sender.send('hello-ws')
    expect(await payload).toBe('hello-ws')

    const closed = new Promise<void>(resolve => {
      receiver.addEventListener('close', () => resolve())
    })

    sender.close()
    receiver.close()
    await closed

    expect(sender.readyState).toBe(VirtualWebSocket.CLOSED)
    expect(receiver.readyState).toBe(VirtualWebSocket.CLOSED)
  })
})
