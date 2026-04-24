type EventKey = string | symbol
type Listener = (...args: any[]) => void
type ListenerEntry = {
  listener: Listener
  original: Listener
  once: boolean
}

import type { BufferEncoding } from './buffer'

export const captureRejectionSymbol = Symbol.for('nodejs.rejection')

const defaultMaxListeners = 10

type StreamChunk = Uint8Array | string | null

const RuntimeBuffer = globalThis.Buffer

type ReadableOptions = {
  read?: (this: Readable, size?: number) => void
  encoding?: BufferEncoding
  objectMode?: boolean
}

type WritableOptions = {
  objectMode?: boolean
  write?: (this: Writable, chunk: unknown, encoding: BufferEncoding | undefined, callback: (error?: Error | null) => void) => void
  writev?: (this: Writable, chunks: Array<{ chunk: unknown; encoding: BufferEncoding | undefined }>, callback: (error?: Error | null) => void) => void
}

type TransformOptions = ReadableOptions & WritableOptions & {
  transform?: (this: Transform, chunk: unknown, encoding: BufferEncoding | undefined, callback: (error?: Error | null, data?: unknown) => void) => void
}

function normalizeChunk(chunk: unknown, objectMode = false): unknown {
  if (objectMode) {
    return chunk
  }

  if (typeof chunk === 'string') {
    return RuntimeBuffer.from(chunk)
  }

  if (chunk instanceof RuntimeBuffer) {
    return chunk
  }

  if (chunk instanceof Uint8Array) {
    return RuntimeBuffer.from(chunk)
  }

  return RuntimeBuffer.from(String(chunk ?? ''))
}

function chunkEncoding(chunk: unknown, objectMode = false): BufferEncoding | undefined {
  if (objectMode) {
    return undefined
  }
  return undefined
}

function mergeChunks(chunks: unknown[], encoding?: BufferEncoding, objectMode = false): unknown {
  if (objectMode) {
    return chunks.shift()
  }

  const buffers = chunks.map((chunk) => normalizeChunk(chunk, false) as Uint8Array)
  const merged = RuntimeBuffer.concat(buffers)
  if (!encoding) {
    return merged
  }
  return merged.toString(encoding)
}

function validateListener(listener: unknown): asserts listener is Listener {
  if (typeof listener !== 'function') {
    throw new TypeError('The listener argument must be of type function')
  }
}

function toAbortError(): Error & { name: string } {
  const err = new Error('The operation was aborted') as Error & { name: string }
  err.name = 'AbortError'
  return err
}

export class EventEmitter {
  static readonly captureRejectionSymbol = captureRejectionSymbol

  static once(emitter: EventEmitter, event: EventKey, options?: { signal?: AbortSignal }): Promise<unknown[]> {
    return once(emitter, event, options)
  }

  private readonly events = new Map<EventKey, ListenerEntry[]>()
  private maxListenersValue = defaultMaxListeners

  declare addListener: (event: EventKey, listener: Listener) => this
  declare removeListener: (event: EventKey, listener: Listener) => this

  private emitUnhandledError(args: unknown[]): never {
    const first = args[0]
    if (first instanceof Error) {
      throw first
    }
    throw new Error(first === undefined ? 'Unhandled error.' : `Unhandled error. (${String(first)})`)
  }

  on(event: EventKey, listener: Listener): this {
    validateListener(listener)
    if (event !== 'newListener' && this.events.has('newListener')) {
      this.emit('newListener', event, listener)
    }
    const current = this.events.get(event) ?? []
    current.push({ listener, original: listener, once: false })
    this.events.set(event, current)
    return this
  }

  prependListener(event: EventKey, listener: Listener): this {
    validateListener(listener)
    if (event !== 'newListener' && this.events.has('newListener')) {
      this.emit('newListener', event, listener)
    }
    const current = this.events.get(event) ?? []
    current.unshift({ listener, original: listener, once: false })
    this.events.set(event, current)
    return this
  }

  once(event: EventKey, listener: Listener): this {
    validateListener(listener)
    if (event !== 'newListener' && this.events.has('newListener')) {
      this.emit('newListener', event, listener)
    }
    const wrapped: Listener = (...args: unknown[]) => {
      this.off(event, listener)
      listener(...args)
    }
    const current = this.events.get(event) ?? []
    current.push({ listener: wrapped, original: listener, once: true })
    this.events.set(event, current)
    return this
  }

  prependOnceListener(event: EventKey, listener: Listener): this {
    validateListener(listener)
    if (event !== 'newListener' && this.events.has('newListener')) {
      this.emit('newListener', event, listener)
    }
    const wrapped: Listener = (...args: unknown[]) => {
      this.off(event, listener)
      listener(...args)
    }
    const current = this.events.get(event) ?? []
    current.unshift({ listener: wrapped, original: listener, once: true })
    this.events.set(event, current)
    return this
  }

  off(event: EventKey, listener: Listener): this {
    const current = this.events.get(event)
    if (!current) {
      return this
    }

    const next = current.filter((entry) => entry.original !== listener)
    if (next.length === 0) {
      this.events.delete(event)
    } else {
      this.events.set(event, next)
    }

    return this
  }

  emit(event: EventKey, ...args: unknown[]): boolean {
    const current = this.events.get(event)
    if (!current || current.length === 0) {
      if (event === 'error') {
        this.emitUnhandledError(args)
      }
      return false
    }

    const snapshot = current.slice()
    for (const entry of snapshot) {
      entry.listener(...args)
    }

    return true
  }

  removeAllListeners(event?: EventKey): this {
    if (event !== undefined) {
      this.events.delete(event)
      return this
    }

    this.events.clear()
    return this
  }

  listeners(event: EventKey): Listener[] {
    return (this.events.get(event) ?? []).map((entry) => entry.original)
  }

  listenerCount(event: EventKey): number {
    return this.listeners(event).length
  }

  eventNames(): EventKey[] {
    return Array.from(this.events.keys())
  }

  setMaxListeners(count: number): this {
    this.maxListenersValue = count
    return this
  }

  getMaxListeners(): number {
    return this.maxListenersValue
  }
}

EventEmitter.prototype.addListener = EventEmitter.prototype.on
EventEmitter.prototype.removeListener = EventEmitter.prototype.off

export class Stream extends EventEmitter {}

export class Readable extends Stream {
  static fromWeb(stream: ReadableStream): Readable {
    const readable = new Readable({ read() {} })
    queueMicrotask(async () => {
      const reader = stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          readable.push(null)
          return
        }
        readable.push(value)
      }
    })
    return readable
  }

  static toWeb(readable: Readable): ReadableStream {
    readable.pause()
    let started = false
    let closed = false

    return new ReadableStream({
      pull(controller) {
        if (started) {
          return
        }

        started = true
        readable.emit('resume')
        readable.on('end', () => {
          if (!closed) {
            closed = true
            controller.close()
          }
        })
        readable.on('error', (error) => {
          if (!closed) {
            closed = true
            controller.error(error)
          }
        })
        readable.on('data', (chunk) => {
          if (!closed) {
            controller.enqueue(chunk)
          }
        })
      },
      cancel() {
        closed = true
      },
    })
  }

  private readonly readableImpl: (size?: number) => void
  private readonly objectMode: boolean
  private queue: unknown[] = []
  private ended = false
  private endedEmitted = false
  private closeEmitted = false
  private flowing = false
  private encoding?: BufferEncoding
  private didCallRead = false

  constructor(options: ReadableOptions = {}) {
    super()
    this.readableImpl = options.read?.bind(this) ?? (() => {})
    this.objectMode = options.objectMode ?? false
    this.encoding = options.encoding
  }

  override on(event: EventKey, listener: Listener): this {
    super.on(event, listener)
    if (event === 'data') {
      this.flowing = true
      this.flushFlowing()
      this.maybeRead()
    } else if (event === 'readable') {
      this.maybeRead()
    }
    return this
  }

  push(chunk: StreamChunk): boolean {
    if (chunk === null) {
      this.ended = true
      // Node emits a final 'readable' on EOF in paused mode.
      this.emit('readable')
      this.maybeFinalize()
      return false
    }

    this.queue.push(normalizeChunk(chunk, this.objectMode))
    if (!this.flowing) {
      this.emit('readable')
    }
    if (this.flowing) {
      this.flushFlowing()
    }
    return true
  }

  unshift(chunk: Exclude<StreamChunk, null>): void {
    this.queue.unshift(normalizeChunk(chunk, this.objectMode))
  }

  read(): unknown {
    this.maybeRead()
    if (this.queue.length === 0) {
      this.maybeFinalize()
      return null
    }

    const out = mergeChunks(this.queue, this.encoding, this.objectMode)
    this.queue = []
    if (this.flowing) {
      this.maybeFinalize()
    }
    return out
  }

  setEncoding(encoding: BufferEncoding): this {
    this.encoding = encoding
    return this
  }

  pipe<T extends Writable>(dest: T): T {
    this.on('end', () => {
      dest.end()
    })
    this.on('data', (chunk) => {
      dest.write(chunk)
    })
    return dest
  }

  pause(): this {
    this.flowing = false
    this.emit('pause')
    return this
  }

  resume(): this {
    this.flowing = true
    this.emit('resume')
    this.flushFlowing()
    this.maybeRead()
    return this
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
    while (true) {
      const current = this.read()
      if (current !== null) {
        yield current
        continue
      }

      if (this.ended) {
        return
      }

      const next = await once(this, 'readable')
      if (next.length === 0 && this.ended) {
        return
      }
    }
  }

  private flushFlowing(): void {
    while (this.flowing && this.queue.length > 0) {
      const chunk = this.objectMode ? this.queue.shift() : mergeChunks([this.queue.shift()], undefined, false)
      this.emit('data', chunk)
    }

    if (this.flowing) {
      this.maybeFinalize()
    }
  }

  private maybeRead(): void {
    if (!this.didCallRead && !this.ended && this.queue.length === 0) {
      this.didCallRead = true
      this.readableImpl()
    }
  }

  private maybeFinalize(): void {
    if (this.ended && this.queue.length === 0 && !this.endedEmitted) {
      this.endedEmitted = true
      this.emit('end')
    }
    if (this.endedEmitted && !this.closeEmitted) {
      this.closeEmitted = true
      this.emit('close')
    }
  }
}

export class Writable extends Stream {
  private readonly objectMode: boolean
  private readonly writeImpl: NonNullable<WritableOptions['write']>
  private readonly writevImpl?: WritableOptions['writev']
  private writing = false
  private ending = false
  private prefinished = false
  private finished = false
  private finishScheduled = false
  private buffered: Array<{ chunk: unknown; encoding: BufferEncoding | undefined }> = []

  constructor(options: WritableOptions = {}) {
    super()
    this.objectMode = options.objectMode ?? false
    this.writeImpl = options.write?.bind(this) ?? ((_, __, callback) => callback())
    this.writevImpl = options.writev?.bind(this)
  }

  write(chunk: unknown, encoding?: BufferEncoding, callback?: (error?: Error | null) => void): boolean {
    const entry = { chunk: normalizeChunk(chunk, this.objectMode), encoding: encoding ?? chunkEncoding(chunk, this.objectMode) }
    if (this.writing) {
      this.buffered.push(entry)
      callback?.()
      return true
    }

    this.writing = true
    this.writeImpl(entry.chunk, entry.encoding, (error) => {
      callback?.(error)
      this.writing = false
      this.flushBuffered()
    })
    return true
  }

  end(chunk?: unknown, encoding?: BufferEncoding, callback?: () => void): this {
    if (chunk !== undefined) {
      this.write(chunk, encoding)
    }
    this.ending = true
    if (callback) {
      this.once('finish', callback)
    }
    this.maybeFinish()
    return this
  }

  private flushBuffered(): void {
    if (this.buffered.length === 0) {
      this.maybeFinish()
      return
    }

    if (this.writevImpl && this.buffered.length > 1) {
      const chunks = this.buffered.splice(0, this.buffered.length)
      this.writing = true
      this.writevImpl(chunks, () => {
        this.writing = false
        this.flushBuffered()
      })
      return
    }

    const next = this.buffered.shift()
    if (!next) {
      return
    }
    this.writing = true
    this.writeImpl(next.chunk, next.encoding, () => {
      this.writing = false
      this.flushBuffered()
    })
  }

  private maybeFinish(): void {
    if (!this.ending || this.writing || this.buffered.length !== 0 || this.finished) {
      return
    }

    if (!this.prefinished) {
      this.prefinished = true
      this.emit('prefinish')
    }

    if (this.finishScheduled) {
      return
    }

    this.finishScheduled = true
    queueMicrotask(() => {
      this.finishScheduled = false
      if (!this.ending || this.writing || this.buffered.length !== 0 || this.finished) {
        return
      }
      this.finished = true
      this.emit('finish')
    })
  }
}

export class Duplex extends Readable {
  private readonly writableSide: Writable

  constructor(options: ReadableOptions & WritableOptions = {}) {
    super(options)
    this.writableSide = new Writable(options)
  }

  write(chunk: unknown, encoding?: BufferEncoding, callback?: (error?: Error | null) => void): boolean {
    return this.writableSide.write(chunk, encoding, callback)
  }

  end(chunk?: unknown, encoding?: BufferEncoding, callback?: () => void): this {
    this.writableSide.on('prefinish', () => this.emit('prefinish'))
    this.writableSide.on('finish', () => this.emit('finish'))
    this.writableSide.end(chunk, encoding, callback)
    return this
  }
}

export class Transform extends Duplex {
  private readonly transformImpl: NonNullable<TransformOptions['transform']>

  constructor(options: TransformOptions = {}) {
    super({ ...options, write: undefined, writev: undefined })
    this.transformImpl =
      options.transform?.bind(this) ??
      ((chunk, _encoding, callback) => {
        callback(null, chunk)
      })
  }

  override write(chunk: unknown, encoding?: BufferEncoding, callback?: (error?: Error | null) => void): boolean {
    const normalized = normalizeChunk(chunk, false)
    this.transformImpl(normalized, encoding ?? chunkEncoding(chunk, false), (error, data) => {
      if (!error && data !== undefined) {
        this.push(data as StreamChunk)
      }
      callback?.(error)
    })
    return true
  }

  override end(chunk?: unknown, encoding?: BufferEncoding, callback?: () => void): this {
    if (chunk !== undefined) {
      this.write(chunk, encoding)
    }
    this.emit('prefinish')
    this.push(null)
    queueMicrotask(() => {
      this.emit('finish')
      callback?.()
    })
    return this
  }
}

export class PassThrough extends Transform {
  constructor(options: TransformOptions = {}) {
    super({
      ...options,
      transform(chunk, _encoding, callback) {
        callback(null, chunk)
      },
    })
  }
}

export function getEventListeners(emitter: EventEmitter, event: EventKey): Listener[] {
  return emitter.listeners(event)
}

export function getMaxListeners(emitter: EventEmitter): number {
  return emitter.getMaxListeners()
}

export function setMaxListeners(count: number, ...emitters: EventEmitter[]): void {
  for (const emitter of emitters) {
    emitter.setMaxListeners(count)
  }
}

export function once(emitter: EventEmitter, event: EventKey, options?: { signal?: AbortSignal }): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(toAbortError())
      return
    }

    const handler = (...args: unknown[]) => {
      options?.signal?.removeEventListener('abort', onAbort)
      resolve(args)
    }

    const onAbort = () => {
      emitter.off(event, handler)
      reject(toAbortError())
    }

    emitter.once(event, handler)
    options?.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const eventsModule = Object.assign(EventEmitter, {
  EventEmitter,
  Duplex,
  PassThrough,
  Readable,
  Stream,
  Transform,
  Writable,
  default: EventEmitter,
  captureRejectionSymbol,
  getEventListeners,
  getMaxListeners,
  once,
  setMaxListeners,
})

export default eventsModule