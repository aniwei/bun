import { describe, expect, test } from 'bun:test'

import EventEmitter, {
  captureRejectionSymbol,
  getEventListeners,
  getMaxListeners,
  once,
  setMaxListeners,
} from '../../../packages/bun-web-node/src/events-stream'
import { createRequire, isBuiltin } from '../../../packages/bun-web-node/src/module'

describe('bun-web M2 node events bridge smoke', () => {
  test('EventEmitter on/off/emit works', () => {
    const emitter = new EventEmitter()
    const calls: number[] = []
    const listener = (value: number) => {
      calls.push(value)
    }

    emitter.on('data', listener)
    expect(emitter.emit('data', 1)).toBe(true)
    emitter.off('data', listener)
    expect(emitter.emit('data', 2)).toBe(false)
    expect(calls).toEqual([1])
  })

  test('once and prependOnceListener preserve single-fire order', () => {
    const emitter = new EventEmitter()
    const order: number[] = []

    emitter.on('tick', () => order.push(1))
    emitter.prependOnceListener('tick', () => order.push(0))
    emitter.once('tick', () => order.push(2))

    emitter.emit('tick')
    emitter.emit('tick')

    expect(order).toEqual([0, 1, 2, 1])
    expect(emitter.listenerCount('tick')).toBe(1)
  })

  test('once helper resolves values and respects abort signal', async () => {
    const emitter = new EventEmitter()
    const controller = new AbortController()

    const resolved = once(emitter, 'done')
    emitter.emit('done', 1, 5)
    expect(await resolved).toEqual([1, 5])

    const aborted = once(emitter, 'never', { signal: controller.signal })
    controller.abort()
    await expect(aborted).rejects.toHaveProperty('name', 'AbortError')
  })

  test('official replay: once helper removes listener after resolve', async () => {
    const emitter = new EventEmitter()
    process.nextTick(() => {
      emitter.emit('hey', 1)
    })

    const promise = once(emitter, 'hey')
    expect(emitter.listenerCount('hey')).toBe(1)
    await promise
    expect(emitter.listenerCount('hey')).toBe(0)
  })

  test('official replay: addListener/removeListener are on/off aliases', () => {
    expect(EventEmitter.prototype.addListener).toBe(EventEmitter.prototype.on)
    expect(EventEmitter.prototype.removeListener).toBe(EventEmitter.prototype.off)
  })

  test('official replay: newListener fires before adding listener', () => {
    const emitter = new EventEmitter()
    const order: string[] = []

    emitter.on('newListener', (event) => {
      if (event === 'foo') {
        order.push('newListener')
        expect(emitter.listenerCount('foo')).toBe(0)
      }
    })

    emitter.on('foo', () => {
      order.push('foo')
    })

    expect(order).toEqual(['newListener'])
    expect(emitter.listenerCount('foo')).toBe(1)
  })

  test('official replay: prependListener in callback takes effect next emit', () => {
    const emitter = new EventEmitter()
    const order: number[] = []

    emitter.on('foo', () => {
      order.push(1)
    })

    emitter.once('foo', () => {
      emitter.prependListener('foo', () => {
        order.push(2)
      })
    })

    emitter.on('foo', () => {
      order.push(3)
    })

    emitter.emit('foo')
    expect(order).toEqual([1, 3])

    emitter.emit('foo')
    expect(order).toEqual([1, 3, 2, 1, 3])
  })

  test('official replay: addListener in callback takes effect next emit', () => {
    const emitter = new EventEmitter()
    const order: number[] = []

    emitter.on('foo', () => {
      order.push(1)
    })

    emitter.once('foo', () => {
      emitter.addListener('foo', () => {
        order.push(2)
      })
    })

    emitter.on('foo', () => {
      order.push(3)
    })

    emitter.emit('foo')
    expect(order).toEqual([1, 3])

    emitter.emit('foo')
    expect(order).toEqual([1, 3, 1, 3, 2])
  })

  test('listener inspection and max listeners helpers work', () => {
    const emitter = new EventEmitter()
    const first = () => {}
    const second = () => {}

    emitter.prependListener('evt', first)
    emitter.on('evt', second)

    expect(getEventListeners(emitter, 'evt')).toEqual([first, second])
    expect(getMaxListeners(emitter)).toBe(10)

    setMaxListeners(42, emitter)
    expect(getMaxListeners(emitter)).toBe(42)
  })

  test('exports captureRejectionSymbol and module builtin registration', () => {
    const require = createRequire('/index.js')
    const events = require('events') as typeof EventEmitter & {
      EventEmitter: typeof EventEmitter
      captureRejectionSymbol: symbol
      once: typeof once
    }

    expect(isBuiltin('events')).toBe(true)
    expect(events.EventEmitter).toBe(EventEmitter)
    expect(events.captureRejectionSymbol).toBe(captureRejectionSymbol)
    expect(typeof events.once).toBe('function')
  })
})