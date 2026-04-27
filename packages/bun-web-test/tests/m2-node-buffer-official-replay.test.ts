import { describe, expect, test } from 'vitest'
import { Buffer } from '../../../packages/bun-web-node/src/buffer'

describe('bun-web official node:buffer replay', () => {
  test('official replay: Buffer.from() semantic subset', () => {
    // string encoding
    const utf8Buf = Buffer.from('hello world', 'utf8')
    expect(utf8Buf.length).toBe(11)
    expect(utf8Buf.toString('utf8')).toBe('hello world')

    // array-like
    const arrBuf = Buffer.from([1, 2, 3])
    expect(arrBuf.length).toBe(3)
    expect(arrBuf[0]).toBe(1)
    expect(arrBuf[1]).toBe(2)
    expect(arrBuf[2]).toBe(3)

    // buffer copy
    const buf1 = Buffer.from('abc')
    const buf2 = Buffer.from(buf1)
    expect(buf2.toString()).toBe('abc')
    buf2[0] = 120 // 'x'
    expect(buf1[0]).toBe(97) // 'a' - separate copy
    expect(buf2[0]).toBe(120) // 'x'

    // base64
    const b64 = Buffer.from('aGVsbG8=', 'base64')
    expect(b64.toString('utf8')).toBe('hello')

    // hex
    const hex = Buffer.from('48656c6c6f', 'hex')
    expect(hex.toString('utf8')).toBe('Hello')
  })

  test('official replay: Buffer.alloc() semantic subset', () => {
    // basic allocation
    const buf = Buffer.alloc(5)
    expect(buf.length).toBe(5)
    expect(buf[0]).toBe(0) // zero-filled by default
    expect(buf[4]).toBe(0)

    // with fill value
    const filledBuf = Buffer.alloc(3, 'a')
    expect(filledBuf.toString()).toBe('aaa')

    // with fill number
    const numFilledBuf = Buffer.alloc(3, 65) // ASCII 'A'
    expect(numFilledBuf.toString()).toBe('AAA')
  })

  test('official replay: Buffer.isBuffer() check', () => {
    const buf = Buffer.from('test')
    const str = 'test'
    const obj = { data: 'test' }

    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(Buffer.isBuffer(str)).toBe(false)
    expect(Buffer.isBuffer(obj)).toBe(false)
    expect(Buffer.isBuffer(null)).toBe(false)
    expect(Buffer.isBuffer(undefined)).toBe(false)
  })

  test('official replay: Buffer.concat() semantic subset', () => {
    const buf1 = Buffer.from('Hello')
    const buf2 = Buffer.from(' ')
    const buf3 = Buffer.from('World')

    const concatenated = Buffer.concat([buf1, buf2, buf3])
    expect(concatenated.toString()).toBe('Hello World')
    expect(concatenated.length).toBe(11)

    // with total length
    const concatWithLen = Buffer.concat([buf1, buf2, buf3], 11)
    expect(concatWithLen.toString()).toBe('Hello World')

    // truncate if total length is smaller
    const truncated = Buffer.concat([buf1, buf2, buf3], 8)
    expect(truncated.toString()).toBe('Hello Wo')
    expect(truncated.length).toBe(8)
  })

  test('official replay: Buffer.compare() semantic subset', () => {
    const buf1 = Buffer.from('abc')
    const buf2 = Buffer.from('abd')
    const buf3 = Buffer.from('abc')

    expect(Buffer.compare(buf1, buf2)).toBe(-1) // buf1 < buf2
    expect(Buffer.compare(buf2, buf1)).toBe(1) // buf2 > buf1
    expect(Buffer.compare(buf1, buf3)).toBe(0) // buf1 === buf3
  })

  test('official replay: Buffer instance toString() encoding', () => {
    const buf = Buffer.from('Hello')

    // utf8 (default)
    expect(buf.toString()).toBe('Hello')
    expect(buf.toString('utf8')).toBe('Hello')

    // base64
    const b64Buf = Buffer.from('hello world')
    expect(b64Buf.toString('base64')).toBe('aGVsbG8gd29ybGQ=')

    // hex
    const hexBuf = Buffer.from('Hello')
    expect(hexBuf.toString('hex')).toBe('48656c6c6f')

    // with offset and length
    const sub = buf.toString('utf8', 1, 4)
    expect(sub).toBe('ell')
  })

  test('official replay: Buffer.isEncoding() check', () => {
    expect(Buffer.isEncoding('utf8')).toBe(true)
    expect(Buffer.isEncoding('utf-8')).toBe(true)
    expect(Buffer.isEncoding('base64')).toBe(true)
    expect(Buffer.isEncoding('hex')).toBe(true)
    expect(Buffer.isEncoding('ascii')).toBe(true)
    expect(Buffer.isEncoding('invalid')).toBe(false)
    expect(Buffer.isEncoding('unknown')).toBe(false)
  })

  test('official replay: Buffer instance byteLength()', () => {
    expect(Buffer.byteLength('hello')).toBe(5)
    expect(Buffer.byteLength('hello', 'utf8')).toBe(5)

    // multi-byte chars
    expect(Buffer.byteLength('é')).toBe(2) // utf-8 encoded
    expect(Buffer.byteLength('你好')).toBe(6) // 2 Chinese chars * 3 bytes each

    // base64 decoding
    const base64Str = 'aGVsbG8='
    expect(Buffer.byteLength(base64Str, 'base64')).toBe(5)
  })

  test('official replay: Buffer instance copy() semantic subset', () => {
    const buf1 = Buffer.from('this is a buffer')
    const buf2 = Buffer.alloc(8)

    // copy portion of buf1 to buf2
    buf1.copy(buf2, 0, 0, 4)
    expect(buf2.toString()).toBe('this\x00\x00\x00\x00')

    // copy with offset
    const buf3 = Buffer.alloc(8)
    buf1.copy(buf3, 2, 0, 6)
    expect(buf3.toString('utf8', 2, 8)).toBe('this i')
  })

  test('official replay: Buffer instance equals() semantic subset', () => {
    const buf1 = Buffer.from('ABC')
    const buf2 = Buffer.from('ABC')
    const buf3 = Buffer.from('ABCD')

    expect(buf1.equals(buf2)).toBe(true)
    expect(buf1.equals(buf3)).toBe(false)
    expect(buf3.equals(buf1)).toBe(false)
  })

  test('official replay: Buffer instance fill() semantic subset', () => {
    const buf = Buffer.alloc(5)

    buf.fill('a')
    expect(buf.toString()).toBe('aaaaa')

    buf.fill('b', 1)
    expect(buf.toString()).toBe('abbbb')

    buf.fill('c', 1, 3)
    expect(buf.toString()).toBe('accbb')

    // number fill
    const buf2 = Buffer.alloc(3)
    buf2.fill(65) // ASCII 'A'
    expect(buf2.toString()).toBe('AAA')
  })

  test('official replay: Buffer instance indexOf() semantic subset', () => {
    const buf = Buffer.from('this is a buffer')

    // find string
    expect(buf.indexOf('is')).toBe(2)
    expect(buf.indexOf('is', 3)).toBe(5) // search from offset 3

    // find buffer
    const searchBuf = Buffer.from('buffer')
    expect(buf.indexOf(searchBuf)).toBe(10)

    // find byte
    expect(buf.indexOf(105)).toBe(2) // 'i' = 105

    // not found
    expect(buf.indexOf('xyz')).toBe(-1)
  })

  test('official replay: Buffer instance includes() semantic subset', () => {
    const buf = Buffer.from('hello')

    expect(buf.includes('hell')).toBe(true)
    expect(buf.includes('hello')).toBe(true)
    expect(buf.includes('xyz')).toBe(false)

    expect(buf.includes(104)).toBe(true) // 'h' = 104
    expect(buf.includes(120)).toBe(false) // 'x' = 120

    const searchBuf = Buffer.from('llo')
    expect(buf.includes(searchBuf)).toBe(true)
  })

  test('official replay: Buffer instance slice() semantic subset', () => {
    const buf = Buffer.from('hello world')

    // simple slice
    const slice1 = buf.slice(0, 5)
    expect(slice1.toString()).toBe('hello')

    // slice with negative indices
    const slice2 = buf.slice(-5)
    expect(slice2.toString()).toBe('world')

    // slice from offset
    const slice3 = buf.slice(6)
    expect(slice3.toString()).toBe('world')

    // empty slice
    const slice4 = buf.slice(5, 5)
    expect(slice4.length).toBe(0)
  })
})
