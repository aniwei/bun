import { describe, expect, test } from 'vitest'

import { Readable, Stream, Transform, Writable } from '../../../packages/bun-web-node/src/events-stream'
import { createRequire, isBuiltin } from '../../../packages/bun-web-node/src/module'

describe('bun-web official node:stream replay', () => {
  test('official replay: stream builtin exports core constructors', () => {
    const require = createRequire('/entry.js')
    const stream = require('stream') as {
      Readable: typeof Readable
      Writable: typeof Writable
      Transform: typeof Transform
    }

    expect(isBuiltin('stream')).toBe(true)
    expect(stream.Readable).toBe(Readable)
    expect(stream.Writable).toBe(Writable)
    expect(stream.Transform).toBe(Transform)
  })

  test('official replay: stream/web exports browser stream globals', () => {
    const require = createRequire('/entry.js')
    const web = require('stream/web') as {
      ReadableStream: typeof ReadableStream
      WritableStream: typeof WritableStream
      TransformStream: typeof TransformStream
    }

    expect(isBuiltin('stream/web')).toBe(true)
    expect(web.ReadableStream).toBe(globalThis.ReadableStream)
    expect(web.WritableStream).toBe(globalThis.WritableStream)
    expect(web.TransformStream).toBe(globalThis.TransformStream)
  })

  test('official replay: newListener fires before listener is added', () => {
    const stream = new Stream()
    const calls: string[] = []

    stream.on('newListener', (event) => {
      if (event === 'foo') {
        calls.push('newListener')
        expect(stream.listenerCount('foo')).toBe(0)
      }
    })

    stream.on('foo', () => {
      calls.push('foo')
    })

    expect(calls).toEqual(['newListener'])
    expect(stream.listenerCount('foo')).toBe(1)
  })

  test('official replay: Readable.toWeb consumes readable source', async () => {
    const readable = new Readable({
      read() {
        this.push('hello ')
        this.push('stream')
        this.push(null)
      },
    })

    const webReadable = Readable.toWeb(readable)
    const text = await new Response(webReadable).text()
    expect(text).toBe('hello stream')
  })

  test('official replay: Readable.fromWeb bridges to node readable', async () => {
    const webReadable = new ReadableStream({
      start(controller) {
        controller.enqueue('A')
        controller.enqueue('B')
        controller.close()
      },
    })

    const readable = Readable.fromWeb(webReadable)
    const chunks: string[] = []
    for await (const chunk of readable) {
      chunks.push(String(chunk))
    }

    expect(chunks.join('')).toBe('AB')
  })

  test('official replay: Readable async iterator yields merged chunks', async () => {
    const readable = new Readable({
      read() {
        this.push('Hello ')
        this.push('World')
        this.push(null)
      },
    })

    const out: string[] = []
    for await (const chunk of readable) {
      out.push(String(chunk))
    }

    expect(out.join('')).toBe('Hello World')
  })

  test('official replay: stream/promises pipeline transforms chunks', async () => {
    const require = createRequire('/entry.js')
    const { pipeline } = require('stream/promises') as {
      pipeline: (...streams: Array<Readable | Transform | Writable>) => Promise<void>
    }

    const readable = new Readable({
      read() {
        this.push('abc')
        this.push(null)
      },
    })

    const transform = new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, String(chunk).toUpperCase())
      },
    })

    let output = ''
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk)
        callback()
      },
    })

    await pipeline(readable, transform, writable)
    expect(output).toBe('ABC')
  })

  test('official replay: stream/promises finished resolves on finish', async () => {
    const require = createRequire('/entry.js')
    const { finished } = require('stream/promises') as {
      finished: (stream: Writable) => Promise<void>
    }

    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })

    const done = finished(writable)
    writable.end('x')
    await done
  })

  test('official replay: stream/promises finished resolves immediately for already-finished writable', async () => {
    const require = createRequire('/entry.js')
    const { finished } = require('stream/promises') as {
      finished: (stream: Writable) => Promise<void>
    }

    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })

    writable.end('x')
    await finished(writable)
  })

  test('official replay: stream/promises finished rejects on error', async () => {
    const require = createRequire('/entry.js')
    const { finished } = require('stream/promises') as {
      finished: (stream: Writable) => Promise<void>
    }

    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })

    const done = finished(writable)
    queueMicrotask(() => {
      writable.emit('error', new Error('boom'))
    })

    await expect(done).rejects.toThrow('boom')
  })

  test('official replay: stream/promises finished resolves on readable end', async () => {
    const require = createRequire('/entry.js')
    const { finished } = require('stream/promises') as {
      finished: (stream: Readable) => Promise<void>
    }

    const readable = new Readable({
      read() {
        this.push('done')
        this.push(null)
      },
    })

    const chunks: string[] = []
    readable.on('data', (chunk) => {
      chunks.push(String(chunk))
    })

    await finished(readable)
    expect(chunks.join('')).toBe('done')
  })

  test('official replay: stream/promises finished resolves immediately for already-ended readable', async () => {
    const require = createRequire('/entry.js')
    const { finished } = require('stream/promises') as {
      finished: (stream: Readable) => Promise<void>
    }

    const readable = new Readable({
      read() {
        this.push(null)
      },
    })

    readable.resume()
    await finished(readable)
  })

  test('official replay: stream/promises finished rejects on readable error', async () => {
    const require = createRequire('/entry.js')
    const { finished } = require('stream/promises') as {
      finished: (stream: Readable) => Promise<void>
    }

    const readable = new Readable({ read() {} })
    const done = finished(readable)

    queueMicrotask(() => {
      readable.emit('error', new Error('readable-boom'))
    })

    await expect(done).rejects.toThrow('readable-boom')
  })

  test('official replay: pipeline requires at least two streams', async () => {
    const require = createRequire('/entry.js')
    const { pipeline } = require('stream/promises') as {
      pipeline: (...streams: unknown[]) => Promise<void>
    }

    await expect(pipeline()).rejects.toThrow('pipeline requires at least 2 streams')
  })

  test('official replay: pipeline works with readable -> writable', async () => {
    const require = createRequire('/entry.js')
    const { pipeline } = require('stream/promises') as {
      pipeline: (...streams: Array<Readable | Writable>) => Promise<void>
    }

    const readable = new Readable({
      read() {
        this.push('xy')
        this.push('z')
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

    await pipeline(readable, writable)
    expect(output).toBe('xyz')
  })

  test('official replay: prefinish happens before finish', async () => {
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })

    const events: string[] = []
    writable.on('prefinish', () => events.push('prefinish'))
    writable.on('finish', () => events.push('finish'))

    writable.end('ok')
    await Promise.resolve()

    expect(events).toEqual(['prefinish', 'finish'])
  })

  test('official replay: unhandled error event throws', () => {
    expect(() => {
      const writable = new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
      })

      writable.emit('error', new Error('test-error'))
    }).toThrow('test-error')
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

  test('official replay: readable emits final readable before close on EOF', async () => {
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
