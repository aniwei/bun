import { basename, dirname, normalizePath } from "@mars/vfs"

const eventListeners = new WeakMap<object, Map<string | symbol, Set<(...args: unknown[]) => void>>>()

function listenersFor(emitter: object): Map<string | symbol, Set<(...args: unknown[]) => void>> {
  const listeners = eventListeners.get(emitter) ?? new Map()
  eventListeners.set(emitter, listeners)
  return listeners
}

export class EventEmitter {

  on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    const emitterListeners = listenersFor(this)
    const listeners = emitterListeners.get(event) ?? new Set()
    listeners.add(listener)
    emitterListeners.set(event, listeners)
    return this
  }

  addListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return this.on(event, listener)
  }

  once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    const onceListener = (...args: unknown[]) => {
      this.removeListener(event, onceListener)
      listener(...args)
    }

    return this.on(event, onceListener)
  }

  removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    listenersFor(this).get(event)?.delete(listener)
    return this
  }

  off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return this.removeListener(event, listener)
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const listeners = [...(listenersFor(this).get(event) ?? [])]
    for (const listener of listeners) listener.apply(this, args)
    return listeners.length > 0
  }

  listeners(event: string | symbol): Array<(...args: unknown[]) => void> {
    return [...(listenersFor(this).get(event) ?? [])]
  }

  listenerCount(event: string | symbol): number {
    return listenersFor(this).get(event)?.size ?? 0
  }
}

export const events = Object.assign(EventEmitter, {
  EventEmitter,
  default: EventEmitter,
})

export const path = {
  sep: "/",
  delimiter: ":",
  basename,
  dirname,
  extname(value: string): string {
    const name = basename(value)
    const index = name.lastIndexOf(".")
    return index > 0 ? name.slice(index) : ""
  },
  join(...parts: string[]): string {
    return normalizePath(parts.join("/"), "/")
  },
  normalize(value: string): string {
    return normalizePath(value, value.startsWith("/") ? "/" : "/workspace").replace(/^\/workspace\//, "")
  },
  resolve(...parts: string[]): string {
    return normalizePath(parts.join("/"), "/")
  },
  isAbsolute(value: string): boolean {
    return value.startsWith("/")
  },
}

export const url = {
  URL,
  URLSearchParams,
  parse(value: string): Record<string, unknown> {
    const parsed = new URL(value, "http://mars.localhost")
    return {
      protocol: parsed.protocol,
      slashes: value.includes("//"),
      auth: parsed.username ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}` : null,
      host: parsed.host,
      port: parsed.port,
      hostname: parsed.hostname,
      hash: parsed.hash,
      search: parsed.search,
      query: parsed.search.startsWith("?") ? parsed.search.slice(1) : parsed.search,
      pathname: parsed.pathname,
      path: `${parsed.pathname}${parsed.search}`,
      href: parsed.href,
    }
  },
}

export const util = {
  inherits(constructor: Function, superConstructor: Function): void {
    Object.setPrototypeOf(constructor.prototype, (superConstructor?.prototype ?? EventEmitter.prototype) as object)
  },
  inspect(value: unknown): string {
    if (typeof value === "string") return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  },
  format(format: unknown, ...args: unknown[]): string {
    if (typeof format !== "string") return [format, ...args].map(String).join(" ")
    let index = 0
    const output = format.replace(/%[sdj%]/g, token => {
      if (token === "%%") return "%"
      const value = args[index++]
      if (token === "%j") return JSON.stringify(value)
      return String(value)
    })
    return [output, ...args.slice(index).map(String)].join(" ")
  },
  deprecate<T extends Function>(fn: T): T {
    return fn
  },
  promisify<T extends Function>(fn: T): (...args: unknown[]) => Promise<unknown> {
    return (...args: unknown[]) => new Promise((resolve, reject) => {
      fn(...args, (error: unknown, value: unknown) => error ? reject(error) : resolve(value))
    })
  },
}

export const fs = {
  stat(path: string, callback: (error: Error | null, stats?: unknown) => void): void {
    callback(new Error(`fs.stat is not available in Mars browser runtime: ${path}`))
  },
  createReadStream(path: string): never {
    throw new Error(`fs.createReadStream is not available in Mars browser runtime: ${path}`)
  },
}

export class Stream extends EventEmitter {}
export class Readable extends Stream {}
export class Writable extends Stream {}
export class Duplex extends Stream {}
export class Transform extends Duplex {}
export class PassThrough extends Transform {}

export const stream = Object.assign(Stream, {
  Stream,
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  default: Stream,
})

export const zlib = {
  createBrotliCompress(): Transform {
    return new Transform()
  },
  createBrotliDecompress(): Transform {
    return new Transform()
  },
  createDeflate(): Transform {
    return new Transform()
  },
  createGunzip(): Transform {
    return new Transform()
  },
  createGzip(): Transform {
    return new Transform()
  },
  createInflate(): Transform {
    return new Transform()
  },
}

export function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message)
}

assert.ok = assert
assert.equal = (actual: unknown, expected: unknown, message?: string) => {
  if (actual != expected) throw new Error(message ?? `Expected ${actual} == ${expected}`)
}
assert.strictEqual = (actual: unknown, expected: unknown, message?: string) => {
  if (actual !== expected) throw new Error(message ?? `Expected ${actual} === ${expected}`)
}

type MarsBufferConstructor = typeof Uint8Array & {
  from(value: string | ArrayBuffer | ArrayBufferView): Uint8Array
  alloc(size: number): Uint8Array
  isBuffer(value: unknown): value is Uint8Array
  byteLength(value: string | Uint8Array): number
  concat(chunks: Uint8Array[]): Uint8Array
}

const NativeBuffer = (globalThis as typeof globalThis & { Buffer?: MarsBufferConstructor }).Buffer

export const Buffer: MarsBufferConstructor = NativeBuffer ?? class MarsBuffer extends Uint8Array {
  static from(arrayLike: ArrayLike<number>): Uint8Array<ArrayBuffer>
  static from<T>(arrayLike: ArrayLike<T>, mapfn: (value: T, index: number) => number, thisArg?: unknown): Uint8Array<ArrayBuffer>
  static from(elements: Iterable<number>): Uint8Array<ArrayBuffer>
  static from<T>(elements: Iterable<T>, mapfn?: (value: T, index: number) => number, thisArg?: unknown): Uint8Array<ArrayBuffer>
  static from(value: string | ArrayBuffer | ArrayBufferView): Uint8Array
  static from(value: unknown, mapfn?: (value: unknown, index: number) => number, thisArg?: unknown): Uint8Array {
    if (typeof value === "string") return new TextEncoder().encode(value)
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    return Uint8Array.from(value as Iterable<unknown>, mapfn as (value: unknown, index: number) => number, thisArg)
  }

  static alloc(size: number): Uint8Array {
    return new Uint8Array(size)
  }

  static isBuffer(value: unknown): value is Uint8Array {
    return value instanceof Uint8Array
  }

  static byteLength(value: string | Uint8Array): number {
    return typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength
  }

  static concat(chunks: Uint8Array[]): Uint8Array {
    const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    const output = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      output.set(chunk, offset)
      offset += chunk.byteLength
    }
    return output
  }
} as MarsBufferConstructor

export const buffer = { Buffer }

export const querystring = {
  parse(value: string): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(value).entries())
  },
  stringify(value: Record<string, string>): string {
    return new URLSearchParams(value).toString()
  },
}

export class StringDecoder {
  write(value: Uint8Array): string {
    return new TextDecoder().decode(value)
  }

  end(value?: Uint8Array): string {
    return value ? this.write(value) : ""
  }
}

export const stringDecoder = { StringDecoder }

export const net = {
  isIP(): 0 | 4 | 6 {
    return 0
  },
}
