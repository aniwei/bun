import { describe, expect, test } from 'vitest'

import { createRequire, isBuiltin } from '../../../packages/bun-web-node/src/module'
import { Duplex, PassThrough, Readable, Stream, Transform, Writable } from '../../../packages/bun-web-node/src/events-stream'

describe('bun-web M2 node stream bridge smoke', () => {
  test('Readable pipe to Writable works', () => {
    const readable = new Readable({
      read() {
        this.push('Hello World!')
        this.push(null)
      },
    })

    let output = ''
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk)
        callback()
      },
    })

    readable.pipe(writable)
    expect(output).toBe('Hello World!')
  })

  test('Readable read/unshift/setEncoding main path works', () => {
    const readable = new Readable({ read() {} })

    readable.setEncoding('utf8')
    readable.push(new Uint8Array([68, 69, 70]))
    readable.unshift(new Uint8Array([65, 66, 67]))

    expect(readable.read()).toBe('ABCDEF')
  })

  test('Writable write + end main path works', () => {
    const calls: string[] = []
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        calls.push(String(chunk))
        callback()
      },
    })

    writable.write(new Uint8Array([65, 66, 67]))
    writable.end(new Uint8Array([68, 69, 70]))

    expect(calls).toEqual(['ABC', 'DEF'])
  })

  test('PassThrough and Transform expose transformed readable output', () => {
    const pass = new PassThrough()
    pass.write('A')
    pass.end('B')
    expect(String(pass.read())).toBe('AB')

    const transform = new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, String(chunk).toUpperCase())
      },
    })

    transform.end('hello')
    expect(String(transform.read())).toBe('HELLO')
  })

  test('Readable async iterator and builtin registration work', async () => {
    const readable = new Readable({
      read() {
        this.push('Hello ')
        this.push('World!')
        this.push(null)
      },
    })

    const parts: string[] = []
    for await (const chunk of readable) {
      parts.push(String(chunk))
    }

    const require = createRequire('/entry.js')
    const stream = require('stream') as {
      Readable: typeof Readable
      Writable: typeof Writable
      PassThrough: typeof PassThrough
    }

    expect(parts.join('')).toBe('Hello World!')
    expect(isBuiltin('stream')).toBe(true)
    expect(stream.Readable).toBe(Readable)
    expect(stream.Writable).toBe(Writable)
    expect(stream.PassThrough).toBe(PassThrough)
  })

  test('official replay: Readable.toWeb main path works', async () => {
    const readable = new Readable({
      read() {
        this.push('Hello ')
        this.push('World!\n')
        this.push(null)
      },
    })

    const webReadable = Readable.toWeb(readable)
    expect(webReadable).toBeInstanceOf(ReadableStream)

    const text = await new Response(webReadable).text()
    expect(text).toBe('Hello World!\n')
  })

  test('official replay: Readable.fromWeb main path works', async () => {
    const webReadable = new ReadableStream({
      start(controller) {
        controller.enqueue('Hello ')
        controller.enqueue('World!\n')
        controller.close()
      },
    })

    const readable = Readable.fromWeb(webReadable)
    expect(readable).toBeInstanceOf(Readable)

    const chunks: Uint8Array[] = []
    for await (const chunk of readable) {
      chunks.push(chunk as Uint8Array)
    }

    expect(Buffer.concat(chunks).toString()).toBe('Hello World!\n')
  })

  test('official replay: stream constructors stay stable', () => {
    expect(new Stream().constructor).toBe(Stream)
    expect(new Readable({ read() {} }).constructor).toBe(Readable)
    expect(new Writable({}).constructor).toBe(Writable)
    expect(new Duplex({ read() {} }).constructor).toBe(Duplex)
    expect(new Transform({}).constructor).toBe(Transform)
    expect(new PassThrough().constructor).toBe(PassThrough)
  })

  test('official replay: newListener fires before listener is added', () => {
    const stream = new Stream()
    const called: string[] = []

    stream.on('newListener', (event) => {
      if (event === 'foo') {
        called.push('newListener')
        expect(stream.listenerCount('foo')).toBe(0)
      }
    })

    stream.on('foo', () => {
      called.push('foo')
    })

    expect(called).toEqual(['newListener'])
    expect(stream.listenerCount('foo')).toBe(1)
  })

  test('official replay: unhandled error event throws', () => {
    expect(() => {
      const dup = new Duplex({
        read() {
          this.push('Hello World!\n')
          this.push(null)
        },
        write(_chunk, _encoding, callback) {
          callback(new Error('test'))
        },
      })

      dup.emit('error', new Error('test'))
    }).toThrow('test')
  })

  test('official replay: removed listener still runs in same emit tick', () => {
    const stream = new Stream()
    const calls: string[] = []

    const l2 = () => {
      calls.push('l2')
    }

    const l1 = () => {
      calls.push('l1')
      stream.removeListener('x', l2)
    }

    stream.on('x', l1)
    stream.on('x', l2)

    stream.emit('x')

    expect(calls).toEqual(['l1', 'l2'])
    expect(stream.listenerCount('x')).toBe(1)
  })

  test('official replay: prefinish is current tick and finish is next tick', async () => {
    const transform = new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, String(chunk).toUpperCase())
      },
    })

    let prefinishCalled = false
    transform.on('prefinish', () => {
      prefinishCalled = true
    })

    let finishCalled = false
    transform.on('finish', () => {
      finishCalled = true
    })

    transform.end('hi')

    expect(prefinishCalled).toBe(true)
    expect(String(transform.read())).toBe('HI')
    expect(finishCalled).toBe(false)

    await new Promise<void>((resolve) => process.nextTick(resolve))
    expect(finishCalled).toBe(true)
  })

  test('official replay: Readable.toWeb event order matches replay target', async () => {
    const events: string[] = []

    const readable = new Readable({
      read() {
        this.push('Hello ')
        this.push('World!\n')
        this.push(null)
      },
    })

    const originalEmit = readable.emit.bind(readable)
    readable.emit = ((event: string | symbol, ...args: unknown[]) => {
      events.push(String(event))
      return originalEmit(event, ...args)
    }) as typeof readable.emit

    const webReadable = Readable.toWeb(readable)
    const text = await new Response(webReadable).text()

    expect(text).toBe('Hello World!\n')
    expect(events).toEqual(['pause', 'resume', 'data', 'data', 'readable', 'end', 'close'])
  })

  test('official replay subset: readable emits on end with null data', async () => {
    const readable = new Readable({
      read() {
        this.push(null)
      },
    })

    let sawNullReadable = false
    let closeCount = 0

    const closeDone = new Promise<void>((resolve) => {
      readable.on('close', () => {
        closeCount += 1
        resolve()
      })
    })

    const readableDone = new Promise<void>((resolve) => {
      readable.on('readable', () => {
        if (readable.read() === null) {
          sawNullReadable = true
          resolve()
        }
      })
    })

    await Promise.all([readableDone, closeDone])

    expect(sawNullReadable).toBe(true)
    expect(closeCount).toBe(1)
  })
})