import { EventEmitter } from './events-stream'

export const isMainThread = true
export const threadId = 0
export const workerData = null

export const MessageChannelImpl = globalThis.MessageChannel
export const MessagePortImpl = globalThis.MessagePort

export class Worker extends EventEmitter {
  private readonly inner: InstanceType<typeof globalThis.Worker>

  constructor(filename: string | URL, options?: WorkerOptions) {
    super()
    if (typeof globalThis.Worker !== 'function') {
      throw new Error('Worker API is not available in this runtime')
    }

    const url = filename instanceof URL ? filename.toString() : String(filename)
    this.inner = new globalThis.Worker(url, options)

    this.inner.onmessage = event => {
      this.emit('message', event.data)
    }

    this.inner.onerror = event => {
      this.emit('error', event)
    }
  }

  postMessage(value: unknown, transfer?: Transferable[]): void {
    this.inner.postMessage(value, transfer ?? [])
  }

  terminate(): number {
    this.inner.terminate()
    this.emit('exit', 0)
    return 0
  }
}

export const parentPort: MessagePort | null = null

export function markAsUntransferable(_object: unknown): void {}

export const MessageChannel = MessageChannelImpl
export const MessagePort = MessagePortImpl
