/**
 * ThreadPool 单元测试：验证 host 侧 pthread 孵化器的 tid 分配、
 * 生命周期、错误路径与能力探测。
 *
 * 测试里不走真实 wasm shared memory —— worker 用 mock 模拟，
 * 只验证 ThreadPool 的编排逻辑。真实 pipe 在 Phase 5.5 T5.5.3
 * demo 里集成。
 */

import { test, expect, describe } from 'bun:test'
import { ThreadPool, threadPoolAvailable, type ThreadWorkerLike } from '../src/thread-pool'

type Listener = (ev: { data: unknown }) => void
type ErrListener = (ev: unknown) => void

/** mock Worker：收到 `thread:start` 后按脚本回复。 */
function makeMockWorker(script: (tid: number, post: (m: unknown) => void) => void): ThreadWorkerLike {
  const msgListeners: Listener[] = []
  const errListeners: ErrListener[] = []
  let terminated = false
  const post = (m: unknown): void => {
    if (terminated) return
    queueMicrotask(() => {
      for (const l of msgListeners) l({ data: m })
    })
  }
  return {
    postMessage(msg: unknown) {
      if (terminated) return
      const m = msg as { type?: string; tid?: number }
      if (m.type === 'thread:start' && typeof m.tid === 'number') {
        queueMicrotask(() => script(m.tid as number, post))
      }
    },
    terminate() {
      terminated = true
    },
    addEventListener(type: 'message' | 'error', listener: Listener | ErrListener): void {
      if (type === 'message') msgListeners.push(listener as Listener)
      else errListeners.push(listener as ErrListener)
    },
  }
}

/** 没有真实 WebAssembly.Memory 的占位：SAB 可用时构造一个最小 shared memory。 */
function makeSharedMemory(): WebAssembly.Memory | undefined {
  if (typeof SharedArrayBuffer === 'undefined') return undefined
  try {
    return new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })
  } catch {
    return undefined
  }
}

const fakeModule = {} as WebAssembly.Module

describe('threadPoolAvailable', () => {
  test('undefined memory → false', () => {
    expect(threadPoolAvailable(undefined)).toBe(false)
  })

  test('non-shared memory → false', () => {
    const mem = new WebAssembly.Memory({ initial: 1, maximum: 1 })
    expect(threadPoolAvailable(mem)).toBe(false)
  })

  test('shared memory → true (when SAB available)', () => {
    const mem = makeSharedMemory()
    if (!mem) return // 环境不支持
    expect(threadPoolAvailable(mem)).toBe(true)
  })
})

describe('ThreadPool — construction', () => {
  test('throws when memory is not shared', () => {
    const mem = new WebAssembly.Memory({ initial: 1, maximum: 1 })
    expect(
      () =>
        new ThreadPool({
          memory: mem,
          module: fakeModule,
          factory: () => makeMockWorker(() => {}),
        }),
    ).toThrow()
  })
})

describe('ThreadPool — spawn / exit', () => {
  test('spawn returns monotonic tid starting at 1, main=0 reserved', async () => {
    const mem = makeSharedMemory()
    if (!mem) return
    const pool = new ThreadPool({
      memory: mem,
      module: fakeModule,
      factory: () => makeMockWorker((tid, post) => post({ type: 'thread:exit', tid, code: 0 })),
    })
    const t1 = pool.spawn(42)
    const t2 = pool.spawn(43)
    expect(t1).toBe(1)
    expect(t2).toBe(2)
    const c1 = await pool.join(t1)
    const c2 = await pool.join(t2)
    expect(c1).toBe(0)
    expect(c2).toBe(0)
    expect(pool.activeCount).toBe(0)
    expect(pool.totalSpawned).toBe(2)
    pool.terminate()
  })

  test('onExit callback fires with tid + code', async () => {
    const mem = makeSharedMemory()
    if (!mem) return
    const exits: Array<[number, number]> = []
    const pool = new ThreadPool({
      memory: mem,
      module: fakeModule,
      factory: () => makeMockWorker((tid, post) => post({ type: 'thread:exit', tid, code: 7 })),
      onExit: (tid, code) => exits.push([tid, code]),
    })
    const tid = pool.spawn(0)
    await pool.join(tid)
    expect(exits).toEqual([[tid, 7]])
    pool.terminate()
  })

  test('spawn after terminate returns 0', () => {
    const mem = makeSharedMemory()
    if (!mem) return
    const pool = new ThreadPool({
      memory: mem,
      module: fakeModule,
      factory: () => makeMockWorker(() => {}),
    })
    pool.terminate()
    expect(pool.spawn(1)).toBe(0)
  })

  test('maxThreads caps concurrent spawn', () => {
    const mem = makeSharedMemory()
    if (!mem) return
    const pool = new ThreadPool({
      memory: mem,
      module: fakeModule,
      factory: () => makeMockWorker(() => {}), // 从不退出 → 保持 busy
      maxThreads: 2,
    })
    expect(pool.spawn(1)).toBe(1)
    expect(pool.spawn(2)).toBe(2)
    expect(pool.spawn(3)).toBe(0) // 超出
    pool.terminate()
  })

  test('after all threads exit, cap is freed', async () => {
    const mem = makeSharedMemory()
    if (!mem) return
    const pool = new ThreadPool({
      memory: mem,
      module: fakeModule,
      factory: () => makeMockWorker((tid, post) => post({ type: 'thread:exit', tid, code: 0 })),
      maxThreads: 1,
    })
    const a = pool.spawn(1)
    await pool.join(a)
    const b = pool.spawn(2)
    expect(b).toBeGreaterThan(0)
    await pool.join(b)
    pool.terminate()
  })
})

describe('ThreadPool — error path', () => {
  test('worker posts thread:error → onError fires + onExit(-1)', async () => {
    const mem = makeSharedMemory()
    if (!mem) return
    const errs: Array<[number, string]> = []
    const exits: Array<[number, number]> = []
    const pool = new ThreadPool({
      memory: mem,
      module: fakeModule,
      factory: () => makeMockWorker((tid, post) => post({ type: 'thread:error', tid, message: 'boom' })),
      onError: (tid, msg) => errs.push([tid, msg]),
      onExit: (tid, code) => exits.push([tid, code]),
    })
    const tid = pool.spawn(0)
    const code = await pool.join(tid)
    expect(code).toBe(-1)
    expect(errs).toEqual([[tid, 'boom']])
    expect(exits).toEqual([[tid, -1]])
    pool.terminate()
  })

  test('postMessage throwing during start → spawn returns 0', () => {
    const mem = makeSharedMemory()
    if (!mem) return
    const pool = new ThreadPool({
      memory: mem,
      module: fakeModule,
      factory: () => ({
        postMessage() {
          throw new Error('post-fail')
        },
        terminate() {},
        addEventListener() {},
      }),
    })
    // tid 还是分配出去了，但发消息失败 → failThread → spawn 返回 0
    expect(pool.spawn(0)).toBe(0)
    pool.terminate()
  })
})

describe('ThreadPool — join semantics', () => {
  test('join on unknown tid resolves with 0', async () => {
    const mem = makeSharedMemory()
    if (!mem) return
    const pool = new ThreadPool({
      memory: mem,
      module: fakeModule,
      factory: () => makeMockWorker(() => {}),
    })
    const code = await pool.join(9999)
    expect(code).toBe(0)
    pool.terminate()
  })

  test('multiple joiners on the same tid all resolve', async () => {
    const mem = makeSharedMemory()
    if (!mem) return
    const pool = new ThreadPool({
      memory: mem,
      module: fakeModule,
      factory: () => makeMockWorker((tid, post) => post({ type: 'thread:exit', tid, code: 5 })),
    })
    const tid = pool.spawn(0)
    const [a, b, c] = await Promise.all([pool.join(tid), pool.join(tid), pool.join(tid)])
    expect(a).toBe(5)
    expect(b).toBe(5)
    expect(c).toBe(5)
    pool.terminate()
  })

  test('terminate resolves outstanding joiners with -1', async () => {
    const mem = makeSharedMemory()
    if (!mem) return
    const pool = new ThreadPool({
      memory: mem,
      module: fakeModule,
      factory: () => makeMockWorker(() => {}), // 从不退出
    })
    const tid = pool.spawn(0)
    const joinP = pool.join(tid)
    pool.terminate()
    expect(await joinP).toBe(-1)
  })
})
