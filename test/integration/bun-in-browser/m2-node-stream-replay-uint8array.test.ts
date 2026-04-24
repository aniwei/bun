import { beforeEach, describe, expect, test } from 'bun:test'

import { Readable, Writable } from '../../../packages/bun-web-node/src/events-stream'

describe('bun-web M2 stream official replay (uint8array subset)', () => {
  const ABC = new Uint8Array([0x41, 0x42, 0x43])
  const DEF = new Uint8Array([0x44, 0x45, 0x46])
  const GHI = new Uint8Array([0x47, 0x48, 0x49])

  let called: number[]

  function logCall<T extends (...args: any[]) => any>(fn: T, id: number): T {
    return function (this: unknown, ...args: Parameters<T>) {
      called[id] = (called[id] || 0) + 1
      return fn.apply(this, args)
    } as T
  }

  beforeEach(() => {
    called = []
  })

  test('Writable simple operations (Buffer conversion) replay', () => {
    let n = 0
    const writable = new Writable({
      write: logCall((chunk, encoding, cb) => {
        expect(chunk instanceof Buffer).toBe(true)
        expect(encoding).toBe('buffer')

        if (n++ === 0) {
          expect(String(chunk)).toBe('ABC')
        } else {
          expect(String(chunk)).toBe('DEF')
        }

        cb()
      }, 0),
    })

    writable.write(ABC)
    writable.end(DEF)

    expect(called).toEqual([2])
  })

  test('Writable objectMode keeps Uint8Array replay', () => {
    const writable = new Writable({
      objectMode: true,
      write: logCall((chunk, encoding, cb) => {
        expect(chunk instanceof Buffer).toBe(false)
        expect(chunk instanceof Uint8Array).toBe(true)
        expect(chunk).toStrictEqual(ABC)
        expect(encoding).toBeUndefined()
        cb()
      }, 0),
    })

    writable.end(ABC)
    expect(called).toEqual([1])
  })

  test('Writable writev batching replay', () => {
    let callback!: () => void

    const writable = new Writable({
      write: logCall((chunk, encoding, cb) => {
        expect(chunk instanceof Buffer).toBe(true)
        expect(encoding).toBe('buffer')
        expect(String(chunk)).toBe('ABC')
        callback = cb
      }, 0),
      writev: logCall((chunks, cb) => {
        expect(chunks.length).toBe(2)
        expect(chunks[0].encoding).toBe('buffer')
        expect(chunks[1].encoding).toBe('buffer')
        expect(String(chunks[0].chunk) + String(chunks[1].chunk)).toBe('DEFGHI')
        cb()
      }, 1),
    })

    writable.write(ABC)
    writable.write(DEF)
    writable.end(GHI)
    callback()

    expect(called).toEqual([1, 1])
  })

  test('Readable push/unshift replay', () => {
    const readable = new Readable({ read() {} })

    readable.push(DEF)
    readable.unshift(ABC)

    const out = readable.read()
    expect(out instanceof Buffer).toBe(true)
    expect(Array.from(out as Buffer)).toEqual(Array.from(ABC).concat(Array.from(DEF)))
  })

  test('Readable setEncoding replay', () => {
    const readable = new Readable({ read() {} })

    readable.setEncoding('utf8')
    readable.push(DEF)
    readable.unshift(ABC)

    expect(readable.read()).toBe('ABCDEF')
  })
})
