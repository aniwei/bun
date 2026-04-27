import { describe, expect, test } from 'vitest'
import { AsyncLocalStorage, createHook, executionAsyncId, triggerAsyncId } from '../../../packages/bun-web-node/src/async_hooks'
import { MessageChannel, Worker, isMainThread, markAsUntransferable, parentPort, threadId, workerData } from '../../../packages/bun-web-node/src/worker_threads'

describe('M5 worker_threads and async_hooks polyfills', () => {
  test('async_hooks AsyncLocalStorage run and bind keep scoped values', () => {
    const storage = new AsyncLocalStorage<{ requestId: string }>()

    const value = storage.run({ requestId: 'req-1' }, () => {
      const bound = storage.bind(() => storage.getStore()?.requestId)
      return bound()
    })

    expect(value).toBe('req-1')
    expect(storage.getStore()).toBeUndefined()

    const hook = createHook().enable()
    expect(executionAsyncId()).toBe(1)
    expect(triggerAsyncId()).toBe(1)
    hook.disable()
    expect(executionAsyncId()).toBe(0)
  })

  test('worker_threads exports message channel and runtime metadata', async () => {
    expect(isMainThread).toBe(true)
    expect(parentPort).toBeNull()
    expect(threadId).toBe(0)
    expect(workerData).toBeNull()
    markAsUntransferable({})

    const { port1, port2 } = new MessageChannel()
    const payload = await new Promise<string>(resolve => {
      port1.onmessage = event => resolve(String(event.data))
      port2.postMessage('hello-m5')
    })

    expect(payload).toBe('hello-m5')
  })

  test('Worker wrapper can be constructed when Worker API exists', () => {
    if (typeof globalThis.Worker !== 'function') {
      expect(() => new Worker('worker.js')).toThrow('Worker API is not available in this runtime')
      return
    }

    const script = 'self.onmessage = e => self.postMessage(e.data)'
    const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }))
    const worker = new Worker(url)
    worker.terminate()
    URL.revokeObjectURL(url)
  })
})
