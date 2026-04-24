import { describe, expect, test } from 'vitest'
import { Buffer } from '../../../packages/bun-web-node/src/buffer'

describe('Buffer static methods', () => {
  test('Buffer.from(string) utf8', () => {
    const buf = Buffer.from('hello')
    expect(buf.length).toBe(5)
    expect(buf.toString()).toBe('hello')
    expect(Buffer.isBuffer(buf)).toBe(true)
  })

  test('Buffer.from(string, base64)', () => {
    const buf = Buffer.from('aGVsbG8=', 'base64')
    expect(buf.toString()).toBe('hello')
  })

  test('Buffer.from(string, hex)', () => {
    const buf = Buffer.from('68656c6c6f', 'hex')
    expect(buf.toString()).toBe('hello')
  })

  test('Buffer.from(string, latin1)', () => {
    const buf = Buffer.from('hello', 'latin1')
    expect(buf.length).toBe(5)
    expect(buf.toString('latin1')).toBe('hello')
  })

  test('Buffer.from(array)', () => {
    const buf = Buffer.from([104, 101, 108, 108, 111])
    expect(buf.toString()).toBe('hello')
  })

  test('Buffer.from(Uint8Array) copies data', () => {
    const arr = new Uint8Array([104, 101, 108, 108, 111])
    const buf = Buffer.from(arr)
    expect(buf.toString()).toBe('hello')
    arr[0] = 0
    expect(buf[0]).toBe(104)
  })

  test('Buffer.from(ArrayBuffer) shares memory', () => {
    const arr = new Uint8Array([104, 101, 108, 108, 111])
    const buf = Buffer.from(arr.buffer)
    expect(buf.toString()).toBe('hello')
    arr[0] = 0x48
    expect(buf[0]).toBe(0x48)
  })

  test('Buffer.alloc zero-filled', () => {
    const buf = Buffer.alloc(5)
    expect(buf.length).toBe(5)
    for (let i = 0; i < 5; i++) {
      expect(buf[i]).toBe(0)
    }
  })

  test('Buffer.alloc with numeric fill', () => {
    const buf = Buffer.alloc(4, 0x61)
    expect(buf.toString()).toBe('aaaa')
  })

  test('Buffer.alloc with string fill', () => {
    const buf = Buffer.alloc(5, 'ab')
    expect(buf.toString()).toBe('ababa')
  })

  test('Buffer.allocUnsafe returns correct size', () => {
    const buf = Buffer.allocUnsafe(8)
    expect(buf.length).toBe(8)
    expect(Buffer.isBuffer(buf)).toBe(true)
  })

  test('Buffer.concat basic', () => {
    const a = Buffer.from('hello')
    const b = Buffer.from(' world')
    const result = Buffer.concat([a, b])
    expect(result.toString()).toBe('hello world')
  })

  test('Buffer.concat with totalLength truncate', () => {
    const a = Buffer.from('hello world')
    const result = Buffer.concat([a], 5)
    expect(result.toString()).toBe('hello')
  })

  test('Buffer.concat with totalLength pad', () => {
    const a = Buffer.from('hi')
    const result = Buffer.concat([a], 5)
    expect(result.length).toBe(5)
    expect(result[2]).toBe(0)
  })

  test('Buffer.concat empty list', () => {
    const result = Buffer.concat([])
    expect(result.length).toBe(0)
  })

  test('Buffer.isBuffer', () => {
    expect(Buffer.isBuffer(Buffer.from('test'))).toBe(true)
    expect(Buffer.isBuffer(new Uint8Array(5))).toBe(false)
    expect(Buffer.isBuffer('hello')).toBe(false)
    expect(Buffer.isBuffer(null)).toBe(false)
  })

  test('Buffer.compare equal', () => {
    const a = Buffer.from('abc')
    const b = Buffer.from('abc')
    expect(Buffer.compare(a, b)).toBe(0)
  })

  test('Buffer.compare less than', () => {
    expect(Buffer.compare(Buffer.from('abc'), Buffer.from('abd'))).toBe(-1)
  })

  test('Buffer.compare greater than', () => {
    expect(Buffer.compare(Buffer.from('abd'), Buffer.from('abc'))).toBe(1)
  })

  test('Buffer.compare different lengths', () => {
    expect(Buffer.compare(Buffer.from('ab'), Buffer.from('abc'))).toBe(-1)
    expect(Buffer.compare(Buffer.from('abc'), Buffer.from('ab'))).toBe(1)
  })

  test('Buffer.isEncoding', () => {
    expect(Buffer.isEncoding('utf8')).toBe(true)
    expect(Buffer.isEncoding('utf-8')).toBe(true)
    expect(Buffer.isEncoding('base64')).toBe(true)
    expect(Buffer.isEncoding('hex')).toBe(true)
    expect(Buffer.isEncoding('latin1')).toBe(true)
    expect(Buffer.isEncoding('invalid-encoding')).toBe(false)
  })

  test('Buffer.byteLength for string', () => {
    expect(Buffer.byteLength('hello')).toBe(5)
    expect(Buffer.byteLength('héllo')).toBe(6)
  })

  test('Buffer.byteLength for hex string', () => {
    expect(Buffer.byteLength('68656c6c6f', 'hex')).toBe(5)
  })

  test('Buffer.byteLength for ArrayBuffer', () => {
    const ab = new ArrayBuffer(10)
    expect(Buffer.byteLength(ab)).toBe(10)
  })
})

describe('Buffer instance: toString', () => {
  test('hex encoding', () => {
    const buf = Buffer.from('hello')
    expect(buf.toString('hex')).toBe('68656c6c6f')
  })

  test('base64 encoding', () => {
    const buf = Buffer.from('hello')
    expect(buf.toString('base64')).toBe('aGVsbG8=')
  })

  test('base64url encoding', () => {
    const buf = Buffer.from([0xfb, 0xff])
    const b64url = buf.toString('base64url')
    expect(b64url).not.toContain('+')
    expect(b64url).not.toContain('/')
    expect(b64url).not.toContain('=')
  })

  test('toString with range', () => {
    const buf = Buffer.from('hello world')
    expect(buf.toString('utf8', 6, 11)).toBe('world')
  })
})

describe('Buffer instance: comparison', () => {
  test('equals same content', () => {
    const a = Buffer.from('hello')
    const b = Buffer.from('hello')
    expect(a.equals(b)).toBe(true)
  })

  test('equals different content', () => {
    expect(Buffer.from('hello').equals(Buffer.from('world'))).toBe(false)
  })

  test('instance compare', () => {
    const a = Buffer.from('abc')
    const b = Buffer.from('abd')
    expect(a.compare(b)).toBe(-1)
    expect(b.compare(a)).toBe(1)
    expect(a.compare(Buffer.from('abc'))).toBe(0)
  })
})

describe('Buffer instance: copy / fill / search', () => {
  test('copy', () => {
    const src = Buffer.from('hello')
    const dst = Buffer.alloc(10)
    const copied = src.copy(dst, 2)
    expect(copied).toBe(5)
    expect(dst.toString('utf8', 2, 7)).toBe('hello')
  })

  test('fill numeric', () => {
    const buf = Buffer.alloc(5)
    buf.fill(0x41)
    expect(buf.toString()).toBe('AAAAA')
  })

  test('fill with string', () => {
    const buf = Buffer.alloc(6)
    buf.fill('ab')
    expect(buf.toString()).toBe('ababab')
  })

  test('indexOf string', () => {
    const buf = Buffer.from('hello world')
    expect(buf.indexOf('world')).toBe(6)
    expect(buf.indexOf('xyz')).toBe(-1)
  })

  test('indexOf number', () => {
    const buf = Buffer.from('hello')
    expect(buf.indexOf(0x6c)).toBe(2)
  })

  test('includes', () => {
    const buf = Buffer.from('hello world')
    expect(buf.includes('world')).toBe(true)
    expect(buf.includes('xyz')).toBe(false)
  })
})

describe('Buffer instance: subarray / slice', () => {
  test('subarray shares memory', () => {
    const buf = Buffer.from('hello')
    const sub = buf.subarray(1, 4)
    expect(Buffer.isBuffer(sub)).toBe(true)
    expect(sub.toString()).toBe('ell')
    sub[0] = 0x45
    expect(buf[1]).toBe(0x45)
  })

  test('slice shares memory (alias for subarray)', () => {
    const buf = Buffer.from([1, 2, 3, 4])
    const s = buf.slice(1, 3)
    expect(Buffer.isBuffer(s)).toBe(true)
    expect(s[0]).toBe(2)
    s[0] = 99
    expect(buf[1]).toBe(99)
  })

  test('toJSON', () => {
    const buf = Buffer.from([1, 2, 3])
    const json = buf.toJSON()
    expect(json.type).toBe('Buffer')
    expect(json.data).toEqual([1, 2, 3])
  })
})

describe('Buffer instance: integer read/write', () => {
  test('UInt8', () => {
    const buf = Buffer.alloc(2)
    buf.writeUInt8(255, 0)
    buf.writeUInt8(0, 1)
    expect(buf.readUInt8(0)).toBe(255)
    expect(buf.readUInt8(1)).toBe(0)
  })

  test('Int8 negative', () => {
    const buf = Buffer.alloc(1)
    buf.writeInt8(-1, 0)
    expect(buf.readInt8(0)).toBe(-1)
  })

  test('UInt16LE round-trip', () => {
    const buf = Buffer.alloc(2)
    buf.writeUInt16LE(0x1234)
    expect(buf.readUInt16LE()).toBe(0x1234)
    expect(buf[0]).toBe(0x34)
    expect(buf[1]).toBe(0x12)
  })

  test('UInt16BE round-trip', () => {
    const buf = Buffer.alloc(2)
    buf.writeUInt16BE(0x1234)
    expect(buf.readUInt16BE()).toBe(0x1234)
    expect(buf[0]).toBe(0x12)
    expect(buf[1]).toBe(0x34)
  })

  test('UInt32LE round-trip', () => {
    const buf = Buffer.alloc(4)
    buf.writeUInt32LE(0xdeadbeef)
    expect(buf.readUInt32LE()).toBe(0xdeadbeef)
  })

  test('UInt32BE round-trip', () => {
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(0xdeadbeef)
    expect(buf.readUInt32BE()).toBe(0xdeadbeef)
  })

  test('Int32 signed negative', () => {
    const buf = Buffer.alloc(4)
    buf.writeInt32LE(-1)
    expect(buf.readInt32LE()).toBe(-1)
  })
})

describe('Buffer instance: float/double read/write', () => {
  test('FloatLE round-trip', () => {
    const buf = Buffer.alloc(4)
    buf.writeFloatLE(3.14)
    expect(buf.readFloatLE()).toBeCloseTo(3.14, 5)
  })

  test('FloatBE round-trip', () => {
    const buf = Buffer.alloc(4)
    buf.writeFloatBE(3.14)
    expect(buf.readFloatBE()).toBeCloseTo(3.14, 5)
  })

  test('DoubleLE round-trip', () => {
    const buf = Buffer.alloc(8)
    buf.writeDoubleLE(Math.PI)
    expect(buf.readDoubleLE()).toBeCloseTo(Math.PI, 10)
  })

  test('DoubleBE round-trip', () => {
    const buf = Buffer.alloc(8)
    buf.writeDoubleBE(Math.E)
    expect(buf.readDoubleBE()).toBeCloseTo(Math.E, 10)
  })
})
