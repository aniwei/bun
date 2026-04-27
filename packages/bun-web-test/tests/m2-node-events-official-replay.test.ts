import { describe, expect, test } from 'vitest'
import EventEmitter, {
  captureRejectionSymbol,
  once as onceEvent,
  getEventListeners,
  getMaxListeners,
  setMaxListeners,
} from '../../../packages/bun-web-node/src/events-stream'

describe('bun-web official node:events replay', () => {
  test('official replay: captureRejectionSymbol export matches EventEmitter static', () => {
    expect(captureRejectionSymbol).toBeDefined()
    expect(EventEmitter.captureRejectionSymbol).toBe(captureRejectionSymbol)
  })

  test('official replay: EventEmitter constructor and basic API', () => {
    const emitter = new EventEmitter()
    expect(emitter).toBeDefined()
    expect(typeof emitter.on).toBe('function')
    expect(typeof emitter.once).toBe('function')
    expect(typeof emitter.emit).toBe('function')
    expect(typeof emitter.off).toBe('function')
    expect(typeof emitter.removeListener).toBe('function')
    expect(typeof emitter.addListener).toBe('function')
  })

  test('official replay: EventEmitter.on() listener registration', () => {
    const emitter = new EventEmitter()
    let called = 0

    emitter.on('test', () => {
      called++
    })

    emitter.emit('test')
    expect(called).toBe(1)

    emitter.emit('test')
    expect(called).toBe(2)
  })

  test('official replay: EventEmitter.once() single listener', async () => {
    const emitter = new EventEmitter()
    let called = 0

    emitter.once('test', () => {
      called++
    })

    emitter.emit('test')
    expect(called).toBe(1)

    emitter.emit('test')
    expect(called).toBe(1) // should not be called again
  })

  test('official replay: EventEmitter.off() / removeListener() removal', () => {
    const emitter = new EventEmitter()
    let called = 0

    const handler = () => {
      called++
    }

    emitter.on('test', handler)
    emitter.emit('test')
    expect(called).toBe(1)

    emitter.off('test', handler)
    emitter.emit('test')
    expect(called).toBe(1) // not called after removal
  })

  test('official replay: EventEmitter.listeners() / listenerCount()', () => {
    const emitter = new EventEmitter()
    const handler1 = () => {}
    const handler2 = () => {}

    expect(emitter.listenerCount('test')).toBe(0)

    emitter.on('test', handler1)
    expect(emitter.listenerCount('test')).toBe(1)

    emitter.on('test', handler2)
    expect(emitter.listenerCount('test')).toBe(2)

    const listeners = emitter.listeners('test')
    expect(listeners.length).toBe(2)
  })

  test('official replay: EventEmitter.addListener() / removeListener() alias', () => {
    const emitter = new EventEmitter()
    let called = 0

    const handler = () => {
      called++
    }

    emitter.addListener('test', handler)
    emitter.emit('test')
    expect(called).toBe(1)

    emitter.removeListener('test', handler)
    emitter.emit('test')
    expect(called).toBe(1)
  })

  test('official replay: EventEmitter.removeAllListeners()', () => {
    const emitter = new EventEmitter()
    let called1 = 0
    let called2 = 0

    emitter.on('test1', () => {
      called1++
    })

    emitter.on('test2', () => {
      called2++
    })

    emitter.removeAllListeners()
    emitter.emit('test1')
    emitter.emit('test2')

    expect(called1).toBe(0)
    expect(called2).toBe(0)
  })

  test('official replay: EventEmitter.emit() with arguments', () => {
    const emitter = new EventEmitter()
    let received: unknown[] = []

    emitter.on('test', (a, b, c) => {
      received = [a, b, c]
    })

    emitter.emit('test', 1, 2, 3)
    expect(received).toEqual([1, 2, 3])
  })

  test('official replay: EventEmitter.prependListener()', () => {
    const emitter = new EventEmitter()
    const calls: number[] = []

    emitter.on('test', () => {
      calls.push(2)
    })

    emitter.prependListener('test', () => {
      calls.push(1)
    })

    emitter.emit('test')
    expect(calls).toEqual([1, 2])
  })

  test('official replay: EventEmitter.prependOnceListener()', () => {
    const emitter = new EventEmitter()
    const calls: number[] = []

    emitter.on('test', () => {
      calls.push(2)
    })

    emitter.prependOnceListener('test', () => {
      calls.push(1)
    })

    emitter.emit('test')
    expect(calls).toEqual([1, 2])

    calls.length = 0
    emitter.emit('test')
    expect(calls).toEqual([2]) // prepended once listener was removed
  })

  test('official replay: getEventListeners() function', () => {
    const emitter = new EventEmitter()

    expect(getEventListeners(emitter, 'test').length).toBe(0)

    emitter.on('test', () => {})
    expect(getEventListeners(emitter, 'test').length).toBe(1)

    emitter.on('test', () => {})
    expect(getEventListeners(emitter, 'test').length).toBe(2)
  })

  test('official replay: getMaxListeners() / setMaxListeners()', () => {
    const emitter = new EventEmitter()

    // default max listeners
    const defaultMax = getMaxListeners(emitter)
    expect(defaultMax).toBeGreaterThan(0)

    // set max listeners
    setMaxListeners(5, emitter)
    expect(getMaxListeners(emitter)).toBe(5)
  })

  test('official replay: EventEmitter.maxListeners property', () => {
    const emitter = new EventEmitter()

    expect(emitter.getMaxListeners()).toBeGreaterThan(0)

    emitter.setMaxListeners(10)
    expect(emitter.getMaxListeners()).toBe(10)
  })

  test('official replay: EventEmitter.eventNames()', () => {
    const emitter = new EventEmitter()
    const sym = Symbol('evt')

    expect(emitter.eventNames()).toEqual([])

    emitter.on('test1', () => {})
    emitter.on(sym, () => {})

    const names = emitter.eventNames()
    expect(names).toContain('test1')
    expect(names).toContain(sym)
    expect(names.length).toBe(2)

    emitter.removeAllListeners()
    expect(emitter.eventNames()).toEqual([])
  })

  test('official replay: EventEmitter.once() with EventEmitter.once()', async () => {
    const emitter = new EventEmitter()

    const promise = onceEvent(emitter, 'test')
    emitter.emit('test', 1, 2, 3)

    const result = await promise
    expect(result).toEqual([1, 2, 3])
  })

  test('official replay: EventEmitter.once() supports abort signal', async () => {
    const emitter = new EventEmitter()
    const controller = new AbortController()

    const promise = onceEvent(emitter, 'test', { signal: controller.signal })
    controller.abort()

    await expect(promise).rejects.toThrow('aborted')
  })

  test('official replay: EventEmitter.once() rejects when signal is already aborted', async () => {
    const emitter = new EventEmitter()
    const controller = new AbortController()
    controller.abort()

    const promise = onceEvent(emitter, 'test', { signal: controller.signal })
    await expect(promise).rejects.toThrow('aborted')
    expect(emitter.listenerCount('test')).toBe(0)
  })

  test('official replay: EventEmitter.once() removes listener after resolve', async () => {
    const emitter = new EventEmitter()
    const promise = onceEvent(emitter, 'test')

    expect(emitter.listenerCount('test')).toBe(1)
    emitter.emit('test', 'ok')
    await promise

    expect(emitter.listenerCount('test')).toBe(0)
  })

  test('official replay: EventEmitter multiple handlers in order', () => {
    const emitter = new EventEmitter()
    const calls: number[] = []

    emitter.on('test', () => calls.push(1))
    emitter.on('test', () => calls.push(2))
    emitter.on('test', () => calls.push(3))

    emitter.emit('test')
    expect(calls).toEqual([1, 2, 3])
  })

  test('official replay: EventEmitter listener removal during emit', () => {
    const emitter = new EventEmitter()
    const calls: number[] = []

    const handler = () => {
      calls.push(1)
      emitter.off('test', handler)
    }

    emitter.on('test', handler)
    emitter.on('test', () => calls.push(2))

    emitter.emit('test')
    expect(calls).toEqual([1, 2])

    calls.length = 0
    emitter.emit('test')
    expect(calls).toEqual([2])
  })

  test('official replay: EventEmitter.removeAllListeners(event) only clears that event', () => {
    const emitter = new EventEmitter()
    let a = 0
    let b = 0

    emitter.on('a', () => {
      a++
    })
    emitter.on('b', () => {
      b++
    })

    emitter.removeAllListeners('a')
    emitter.emit('a')
    emitter.emit('b')

    expect(a).toBe(0)
    expect(b).toBe(1)
    expect(emitter.eventNames()).toEqual(['b'])
  })

  test('official replay: setMaxListeners applies to multiple emitters', () => {
    const a = new EventEmitter()
    const b = new EventEmitter()

    setMaxListeners(3, a, b)

    expect(getMaxListeners(a)).toBe(3)
    expect(getMaxListeners(b)).toBe(3)
  })
})
