import { describe, expect, test } from 'vitest'

import { Readable, Transform, Writable } from '../../../packages/bun-web-node/src/events-stream'
import { createRequire, isBuiltin } from '../../../packages/bun-web-node/src/module'

describe('bun-web M2 node stream/web + stream/promises smoke', () => {
  test('stream/web builtin exports web stream globals', () => {
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

  test('stream/promises finished resolves on writable finish', async () => {
    const require = createRequire('/entry.js')
    const { finished } = require('stream/promises') as {
      finished: (stream: Writable) => Promise<void>
    }

    const readable = new Readable({
      read() {
        this.push('ok')
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
    await finished(writable)
    expect(output).toBe('ok')
  })

  test('stream/promises pipeline connects readable -> transform -> writable', async () => {
    const require = createRequire('/entry.js')
    const { pipeline } = require('stream/promises') as {
      pipeline: (...streams: Array<Readable | Transform | Writable>) => Promise<void>
    }

    const readable = new Readable({
      read() {
        this.push('hello')
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
    expect(output).toBe('HELLO')
  })
})