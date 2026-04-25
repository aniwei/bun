export type BufferEncoding =
  | 'utf8'
  | 'utf-8'
  | 'base64'
  | 'base64url'
  | 'hex'
  | 'ascii'
  | 'latin1'
  | 'binary'
  | 'ucs2'
  | 'ucs-2'
  | 'utf16le'
  | 'utf-16le'

export const INSPECT_MAX_BYTES = 50
export const kMaxLength = 0x7fffffff

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8')
const latin1Decoder = new TextDecoder('latin1')

function normalizeEncoding(enc?: string | null): BufferEncoding {
  if (!enc) return 'utf8'
  switch (enc.toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return 'utf8'
    case 'base64':
      return 'base64'
    case 'base64url':
      return 'base64url'
    case 'hex':
      return 'hex'
    case 'ascii':
    case 'latin1':
    case 'binary':
      return 'latin1'
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return 'utf16le'
    default:
      return 'utf8'
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function encodeString(str: string, encoding: BufferEncoding): Uint8Array {
  switch (encoding) {
    case 'utf8':
    case 'utf-8':
      return utf8Encoder.encode(str)

    case 'base64':
    case 'base64url':
      return base64ToBytes(str)

    case 'hex': {
      const bytes = new Uint8Array(Math.floor(str.length / 2))
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(str.slice(i * 2, i * 2 + 2), 16)
      }
      return bytes
    }

    case 'ascii':
    case 'latin1':
    case 'binary': {
      const bytes = new Uint8Array(str.length)
      for (let i = 0; i < str.length; i++) {
        bytes[i] = str.charCodeAt(i) & 0xff
      }
      return bytes
    }

    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le': {
      const bytes = new Uint8Array(str.length * 2)
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i)
        bytes[i * 2] = code & 0xff
        bytes[i * 2 + 1] = (code >> 8) & 0xff
      }
      return bytes
    }

    default:
      return utf8Encoder.encode(str)
  }
}

function decodeBytes(bytes: Uint8Array, encoding: BufferEncoding): string {
  switch (encoding) {
    case 'utf8':
    case 'utf-8':
      return utf8Decoder.decode(bytes)

    case 'base64':
      return bytesToBase64(bytes)

    case 'base64url':
      return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

    case 'hex': {
      let result = ''
      for (let i = 0; i < bytes.length; i++) {
        result += bytes[i].toString(16).padStart(2, '0')
      }
      return result
    }

    case 'ascii':
    case 'latin1':
    case 'binary':
      return latin1Decoder.decode(bytes)

    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le': {
      let result = ''
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        result += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8))
      }
      return result
    }

    default:
      return utf8Decoder.decode(bytes)
  }
}

export class Buffer extends Uint8Array {
  // ─── Static methods ────────────────────────────────────────────────────────

  static from(value: string, encoding?: BufferEncoding): Buffer
  static from(value: ArrayBuffer | SharedArrayBuffer, byteOffset?: number, length?: number): Buffer
  static from(value: Uint8Array): Buffer
  static from(arrayLike: ArrayLike<number>): Buffer
  static from<T>(arrayLike: ArrayLike<T>, mapfn: (v: T, k: number) => number, thisArg?: any): Buffer
  static from(elements: Iterable<number>): Buffer
  static from<T>(elements: Iterable<T>, mapfn?: (v: T, k: number) => number, thisArg?: any): Buffer

  static from(
    value:
      | string
      | ArrayBuffer
      | SharedArrayBuffer
      | Uint8Array
      | number[]
      | ArrayLike<number>
      | Iterable<number>,
    encodingOrOffset?: BufferEncoding | number | ((v: any, k: number) => number),
    length?: number,
  ): Buffer {
    if (typeof value === 'string') {
      const encoding = normalizeEncoding(encodingOrOffset as BufferEncoding | undefined)
      const bytes = encodeString(value, encoding)
      const buf = new Buffer(bytes.length)
      buf.set(bytes)
      return buf
    }

    if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
      const offset = typeof encodingOrOffset === 'number' ? encodingOrOffset : 0
      const len = typeof length === 'number' ? length : value.byteLength - offset
      return new Buffer(value, offset, len)
    }

    if (value instanceof Uint8Array) {
      const buf = new Buffer(value.length)
      buf.set(value)
      return buf
    }

    if (Array.isArray(value)) {
      const buf = new Buffer(value.length)
      for (let i = 0; i < value.length; i++) {
        buf[i] = (value as number[])[i] & 0xff
      }
      return buf
    }

    const mapfn = typeof encodingOrOffset === 'function' ? encodingOrOffset : undefined
    const arr = mapfn
      ? Array.from(value as ArrayLike<number> | Iterable<number>, mapfn)
      : Array.from(value as ArrayLike<number> | Iterable<number>)
    const buf = new Buffer(arr.length)
    for (let i = 0; i < arr.length; i++) {
      buf[i] = arr[i] & 0xff
    }
    return buf
  }

  static alloc(size: number, fill?: string | number | Buffer, encoding?: BufferEncoding): Buffer {
    const buf = new Buffer(size)
    if (fill !== undefined) {
      buf.fill(fill, 0, size, encoding)
    }
    return buf
  }

  static allocUnsafe(size: number): Buffer {
    return new Buffer(size)
  }

  static allocUnsafeSlow(size: number): Buffer {
    return new Buffer(size)
  }

  static concat(list: Uint8Array[], totalLength?: number): Buffer {
    const len = totalLength ?? list.reduce((sum, b) => sum + b.length, 0)
    const result = new Buffer(len)
    let offset = 0
    for (const b of list) {
      const copyLen = Math.min(b.length, len - offset)
      result.set(b.subarray(0, copyLen), offset)
      offset += copyLen
      if (offset >= len) break
    }
    return result
  }

  static isBuffer(obj: unknown): obj is Buffer {
    return obj instanceof Buffer
  }

  static compare(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
    const minLen = Math.min(a.length, b.length)
    for (let i = 0; i < minLen; i++) {
      if (a[i] < b[i]) return -1
      if (a[i] > b[i]) return 1
    }
    if (a.length < b.length) return -1
    if (a.length > b.length) return 1
    return 0
  }

  static isEncoding(encoding: string): boolean {
    return normalizeEncoding(encoding) !== 'utf8' || encoding.toLowerCase() === 'utf8' || encoding.toLowerCase() === 'utf-8'
  }

  static byteLength(value: string | Buffer | ArrayBuffer | Uint8Array, encoding?: BufferEncoding): number {
    if (typeof value === 'string') {
      const enc = normalizeEncoding(encoding)
      return encodeString(value, enc).length
    }
    if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
      return value.byteLength
    }
    return (value as Uint8Array).byteLength
  }

  // ─── Instance methods ──────────────────────────────────────────────────────

  toString(encoding?: BufferEncoding | string, start?: number, end?: number): string {
    const enc = normalizeEncoding(encoding as BufferEncoding | undefined)
    const from = start ?? 0
    const to = end ?? this.length
    return decodeBytes(this.subarray(from, to), enc)
  }

  copy(target: Buffer, targetStart?: number, sourceStart?: number, sourceEnd?: number): number {
    const ts = targetStart ?? 0
    const ss = sourceStart ?? 0
    const se = sourceEnd ?? this.length
    const len = Math.min(se - ss, target.length - ts)
    if (len <= 0) return 0
    target.set(this.subarray(ss, ss + len), ts)
    return len
  }

  equals(other: Uint8Array): boolean {
    return Buffer.compare(this, other) === 0
  }

  compare(
    other: Uint8Array,
    targetStart?: number,
    targetEnd?: number,
    sourceStart?: number,
    sourceEnd?: number,
  ): -1 | 0 | 1 {
    const ts = targetStart ?? 0
    const te = targetEnd ?? other.length
    const ss = sourceStart ?? 0
    const se = sourceEnd ?? this.length
    return Buffer.compare(this.subarray(ss, se), other.subarray(ts, te))
  }

  fill(
    value: string | number | Uint8Array,
    offset?: number,
    end?: number,
    encoding?: BufferEncoding,
  ): this {
    const from = offset ?? 0
    const to = end ?? this.length

    if (typeof value === 'number') {
      for (let i = from; i < to; i++) {
        this[i] = value & 0xff
      }
      return this
    }

    if (typeof value === 'string') {
      const enc = normalizeEncoding(encoding)
      const bytes = encodeString(value, enc)
      if (bytes.length === 0) return this
      for (let i = from; i < to; i++) {
        this[i] = bytes[(i - from) % bytes.length]
      }
      return this
    }

    // Uint8Array / Buffer
    if (value.length === 0) return this
    for (let i = from; i < to; i++) {
      this[i] = value[(i - from) % value.length]
    }
    return this
  }

  indexOf(
    value: string | number | Uint8Array,
    byteOffset?: number,
    encoding?: BufferEncoding,
  ): number {
    const start = byteOffset ?? 0

    if (typeof value === 'number') {
      const v = value & 0xff
      for (let i = start; i < this.length; i++) {
        if (this[i] === v) return i
      }
      return -1
    }

    const needle =
      typeof value === 'string' ? encodeString(value, normalizeEncoding(encoding)) : value

    if (needle.length === 0) return start

    outer: for (let i = start; i <= this.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (this[i + j] !== needle[j]) continue outer
      }
      return i
    }
    return -1
  }

  includes(
    value: string | number | Uint8Array,
    byteOffset?: number,
    encoding?: BufferEncoding,
  ): boolean {
    return this.indexOf(value, byteOffset, encoding) !== -1
  }

  subarray(start?: number, end?: number): Buffer {
    const sub = super.subarray(start, end)
    Object.setPrototypeOf(sub, Buffer.prototype)
    return sub as Buffer
  }

  slice(start?: number, end?: number): Buffer {
    return this.subarray(start, end)
  }

  toJSON(): { type: 'Buffer'; data: number[] } {
    return { type: 'Buffer', data: Array.from(this) }
  }

  // ─── Read methods ──────────────────────────────────────────────────────────

  readUInt8(offset = 0): number {
    return this[offset]
  }

  readInt8(offset = 0): number {
    const val = this[offset]
    return val >= 128 ? val - 256 : val
  }

  readUInt16LE(offset = 0): number {
    return this[offset] | (this[offset + 1] << 8)
  }

  readUInt16BE(offset = 0): number {
    return (this[offset] << 8) | this[offset + 1]
  }

  readInt16LE(offset = 0): number {
    const val = this.readUInt16LE(offset)
    return val >= 0x8000 ? val - 0x10000 : val
  }

  readInt16BE(offset = 0): number {
    const val = this.readUInt16BE(offset)
    return val >= 0x8000 ? val - 0x10000 : val
  }

  readUInt32LE(offset = 0): number {
    return (
      ((this[offset] |
        (this[offset + 1] << 8) |
        (this[offset + 2] << 16) |
        (this[offset + 3] << 24)) >>>
        0)
    )
  }

  readUInt32BE(offset = 0): number {
    return (
      ((this[offset] << 24) |
        (this[offset + 1] << 16) |
        (this[offset + 2] << 8) |
        this[offset + 3]) >>>
      0
    )
  }

  readInt32LE(offset = 0): number {
    return (
      this[offset] |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16) |
      (this[offset + 3] << 24)
    )
  }

  readInt32BE(offset = 0): number {
    return (
      (this[offset] << 24) |
      (this[offset + 1] << 16) |
      (this[offset + 2] << 8) |
      this[offset + 3]
    )
  }

  readFloatLE(offset = 0): number {
    return new DataView(this.buffer, this.byteOffset).getFloat32(offset, true)
  }

  readFloatBE(offset = 0): number {
    return new DataView(this.buffer, this.byteOffset).getFloat32(offset, false)
  }

  readDoubleLE(offset = 0): number {
    return new DataView(this.buffer, this.byteOffset).getFloat64(offset, true)
  }

  readDoubleBE(offset = 0): number {
    return new DataView(this.buffer, this.byteOffset).getFloat64(offset, false)
  }

  // ─── Write methods ─────────────────────────────────────────────────────────

  writeUInt8(value: number, offset = 0): number {
    this[offset] = value & 0xff
    return offset + 1
  }

  writeInt8(value: number, offset = 0): number {
    this[offset] = value < 0 ? value + 256 : value & 0xff
    return offset + 1
  }

  writeUInt16LE(value: number, offset = 0): number {
    this[offset] = value & 0xff
    this[offset + 1] = (value >> 8) & 0xff
    return offset + 2
  }

  writeUInt16BE(value: number, offset = 0): number {
    this[offset] = (value >> 8) & 0xff
    this[offset + 1] = value & 0xff
    return offset + 2
  }

  writeInt16LE(value: number, offset = 0): number {
    return this.writeUInt16LE(value < 0 ? value + 0x10000 : value, offset)
  }

  writeInt16BE(value: number, offset = 0): number {
    return this.writeUInt16BE(value < 0 ? value + 0x10000 : value, offset)
  }

  writeUInt32LE(value: number, offset = 0): number {
    this[offset] = value & 0xff
    this[offset + 1] = (value >> 8) & 0xff
    this[offset + 2] = (value >> 16) & 0xff
    this[offset + 3] = (value >>> 24) & 0xff
    return offset + 4
  }

  writeUInt32BE(value: number, offset = 0): number {
    this[offset] = (value >>> 24) & 0xff
    this[offset + 1] = (value >> 16) & 0xff
    this[offset + 2] = (value >> 8) & 0xff
    this[offset + 3] = value & 0xff
    return offset + 4
  }

  writeInt32LE(value: number, offset = 0): number {
    return this.writeUInt32LE(value >>> 0, offset)
  }

  writeInt32BE(value: number, offset = 0): number {
    return this.writeUInt32BE(value >>> 0, offset)
  }

  writeFloatLE(value: number, offset = 0): number {
    new DataView(this.buffer, this.byteOffset).setFloat32(offset, value, true)
    return offset + 4
  }

  writeFloatBE(value: number, offset = 0): number {
    new DataView(this.buffer, this.byteOffset).setFloat32(offset, value, false)
    return offset + 4
  }

  writeDoubleLE(value: number, offset = 0): number {
    new DataView(this.buffer, this.byteOffset).setFloat64(offset, value, true)
    return offset + 8
  }

  writeDoubleBE(value: number, offset = 0): number {
    new DataView(this.buffer, this.byteOffset).setFloat64(offset, value, false)
    return offset + 8
  }
}
