/**
 * T5.6.1 ProcessManager 单元测试。
 *
 * ProcessManager 本身不关心 WASM 细节 —— 它负责：
 *  1. 通过 workerFactory 创建 Worker
 *  2. 发送 `spawn:init` 消息（把 module + vfsSnapshots + argv/env/cwd 传进去）
 *  3. 中继 spawn:stdout / spawn:stderr 到回调
 *  4. 在收到 spawn:exit 后 resolve 退出码
 *  5. 在 Worker error 事件时 reject
 *
 * 测试里用 mock Worker（通过 workerFactory 注入，不污染 globalThis.Worker）验证以上行为。
 */

import { test, expect, describe } from 'bun:test'
import { ProcessManager, type ProcessSpawnOptions } from '../src/process-manager'

// ---------------------------------------------------------------------------
// Mock Worker
// ---------------------------------------------------------------------------

type MessageListener = (ev: { data: unknown }) => void
type ErrorListener = (ev: ErrorEvent) => void

class MockWorker {
  private msgListeners: MessageListener[] = []
  private errListeners: ErrorListener[] = []
  terminated = false
  receivedMessages: unknown[] = []

  addEventListener(type: 'message' | 'error', l: MessageListener | ErrorListener): void {
    if (type === 'message') this.msgListeners.push(l as MessageListener)
    else this.errListeners.push(l as ErrorListener)
  }

  postMessage(msg: unknown): void {
    this.receivedMessages.push(msg)
  }

  terminate(): void {
    this.terminated = true
  }

  /** 模拟 Worker 发送消息回 ProcessManager。 */
  simulateMessage(data: unknown): void {
    const ev = { data }
    for (const l of this.msgListeners) l(ev)
  }

  /** 模拟 Worker error 事件。 */
  simulateError(message: string): void {
    const ev = new ErrorEvent('error', { message })
    for (const l of this.errListeners) l(ev)
  }
}

const fakeModule = {} as WebAssembly.Module

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 每次调用都返回一个新 MockWorker，并把它存到 `created` 数组尾部。 */
function makeFactory(created: MockWorker[]): () => Worker {
  return () => {
    const w = new MockWorker()
    created.push(w)
    return w as unknown as Worker
  }
}

function makeManager(opts?: { initialSnapshot?: ArrayBuffer }): { pm: ProcessManager; workers: MockWorker[] } {
  const workers: MockWorker[] = []
  const pm = new ProcessManager({
    workerUrl: 'fake://spawn-worker.js',
    module: fakeModule,
    workerFactory: makeFactory(workers),
    ...opts,
  })
  return { pm, workers }
}

function defaultSpawnOpts(overrides?: Partial<ProcessSpawnOptions>): ProcessSpawnOptions {
  return {
    id: 'test-id',
    argv: ['bun', 'run', '/index.js'],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests — spawn:exit
// ---------------------------------------------------------------------------

describe('ProcessManager.spawn — exit', () => {
  test('resolves with exit code 0 on spawn:exit', async () => {
    const { pm, workers } = makeManager()
    const spawnPromise = pm.spawn(defaultSpawnOpts())

    expect(workers).toHaveLength(1)
    const w = workers[0]

    queueMicrotask(() => w.simulateMessage({ type: 'spawn:exit', code: 0 }))

    expect(await spawnPromise).toBe(0)
    expect(w.terminated).toBe(true)
  })

  test('resolves with non-zero exit code', async () => {
    const { pm, workers } = makeManager()
    const p = pm.spawn(defaultSpawnOpts())
    queueMicrotask(() => workers[0].simulateMessage({ type: 'spawn:exit', code: 42 }))
    expect(await p).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// Tests — stdout / stderr relay
// ---------------------------------------------------------------------------

describe('ProcessManager.spawn — output relay', () => {
  test('stdout messages are forwarded to onStdout callback', async () => {
    const chunks: string[] = []
    const { pm, workers } = makeManager()
    const p = pm.spawn(defaultSpawnOpts({ onStdout: d => chunks.push(d) }))

    queueMicrotask(() => {
      workers[0].simulateMessage({ type: 'spawn:stdout', data: 'hello ' })
      workers[0].simulateMessage({ type: 'spawn:stdout', data: 'world\n' })
      workers[0].simulateMessage({ type: 'spawn:exit', code: 0 })
    })

    await p
    expect(chunks).toEqual(['hello ', 'world\n'])
  })

  test('stderr messages are forwarded to onStderr callback', async () => {
    const chunks: string[] = []
    const { pm, workers } = makeManager()
    const p = pm.spawn(defaultSpawnOpts({ onStderr: d => chunks.push(d) }))

    queueMicrotask(() => {
      workers[0].simulateMessage({ type: 'spawn:stderr', data: 'error!\n' })
      workers[0].simulateMessage({ type: 'spawn:exit', code: 1 })
    })

    await p
    expect(chunks).toEqual(['error!\n'])
  })

  test('spawn:error forwards message to onStderr then exit resolves', async () => {
    const errChunks: string[] = []
    const { pm, workers } = makeManager()
    const p = pm.spawn(defaultSpawnOpts({ onStderr: d => errChunks.push(d) }))

    queueMicrotask(() => {
      workers[0].simulateMessage({ type: 'spawn:error', message: 'module load failed' })
      workers[0].simulateMessage({ type: 'spawn:exit', code: 1 })
    })

    const code = await p
    expect(code).toBe(1)
    expect(errChunks.some(c => c.includes('module load failed'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests — Worker error → reject
// ---------------------------------------------------------------------------

describe('ProcessManager.spawn — Worker error', () => {
  test('rejects when Worker fires error event', async () => {
    const { pm, workers } = makeManager()
    const p = pm.spawn(defaultSpawnOpts())

    queueMicrotask(() => workers[0].simulateError('worker crashed'))

    await expect(p).rejects.toThrow('worker crashed')
    expect(workers[0].terminated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests — spawn:init payload
// ---------------------------------------------------------------------------

describe('ProcessManager.spawn — init message payload', () => {
  test('sends spawn:init with correct module and argv', () => {
    const { pm, workers } = makeManager()
    void pm.spawn(defaultSpawnOpts({ argv: ['bun', '-e', "console.log('hi')"] }))
    expect(workers).toHaveLength(1)
    const msg = workers[0].receivedMessages[0] as { type: string; module: unknown; argv: string[] }
    expect(msg.type).toBe('spawn:init')
    expect(msg.module).toBe(fakeModule)
    expect(msg.argv).toEqual(['bun', '-e', "console.log('hi')"])
  })

  test('spawn:init includes env and cwd when provided', () => {
    const { pm, workers } = makeManager()
    void pm.spawn(defaultSpawnOpts({ env: { NODE_ENV: 'test' }, cwd: '/app' }))
    const msg = workers[0].receivedMessages[0] as { env?: Record<string, string>; cwd?: string }
    expect(msg.env).toEqual({ NODE_ENV: 'test' })
    expect(msg.cwd).toBe('/app')
  })

  test('spawn:init includes vfsSnapshots from initialSnapshot', () => {
    const snap = new ArrayBuffer(8)
    const { pm, workers } = makeManager({ initialSnapshot: snap })
    void pm.spawn(defaultSpawnOpts())
    const msg = workers[0].receivedMessages[0] as { vfsSnapshots: ArrayBuffer[] }
    expect(msg.vfsSnapshots).toHaveLength(1)
  })

  test('trackVfsSnapshot adds snapshot to subsequent spawns', () => {
    const { pm, workers } = makeManager()
    const snap1 = new ArrayBuffer(4)
    const snap2 = new ArrayBuffer(8)
    pm.trackVfsSnapshot(snap1)
    pm.trackVfsSnapshot(snap2)
    void pm.spawn(defaultSpawnOpts())
    const msg = workers[0].receivedMessages[0] as { vfsSnapshots: ArrayBuffer[] }
    expect(msg.vfsSnapshots).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Tests — concurrent
// ---------------------------------------------------------------------------

describe('ProcessManager.spawn — concurrent', () => {
  test('two concurrent spawns each get their own Worker', async () => {
    const { pm, workers } = makeManager()
    const p1 = pm.spawn(defaultSpawnOpts({ id: 'a' }))
    const p2 = pm.spawn(defaultSpawnOpts({ id: 'b' }))

    expect(workers).toHaveLength(2)

    queueMicrotask(() => {
      workers[0].simulateMessage({ type: 'spawn:exit', code: 0 })
      workers[1].simulateMessage({ type: 'spawn:exit', code: 5 })
    })

    const [c1, c2] = await Promise.all([p1, p2])
    expect(c1).toBe(0)
    expect(c2).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Tests — extraSnapshots (T5.6.1 live VFS dump)
// ---------------------------------------------------------------------------

describe('ProcessManager.spawn — extraSnapshots', () => {
  test('extraSnapshots are appended after pendingSnapshots in spawn:init', () => {
    const tracked = new ArrayBuffer(4)
    const extra = new ArrayBuffer(8)
    const { pm, workers } = makeManager({ initialSnapshot: tracked })

    void pm.spawn(defaultSpawnOpts({ extraSnapshots: [extra] }))

    const msg = workers[0].receivedMessages[0] as { vfsSnapshots: ArrayBuffer[] }
    expect(msg.vfsSnapshots).toHaveLength(2)
    // 顺序：tracked 在前，extra 在后
    expect(msg.vfsSnapshots[0]).toBe(tracked)
    expect(msg.vfsSnapshots[1]).toBe(extra)
  })

  test('extraSnapshots from two spawns are independent (tracked list unchanged)', () => {
    const tracked = new ArrayBuffer(4)
    const { pm, workers } = makeManager({ initialSnapshot: tracked })

    const extra1 = new ArrayBuffer(10)
    void pm.spawn(defaultSpawnOpts({ id: 's1', extraSnapshots: [extra1] }))

    void pm.spawn(defaultSpawnOpts({ id: 's2' }))

    // 第一次 spawn 有 2 个快照
    const msg1 = workers[0].receivedMessages[0] as { vfsSnapshots: ArrayBuffer[] }
    expect(msg1.vfsSnapshots).toHaveLength(2)

    // 第二次 spawn 只有 1 个（tracked），extra1 不应泄漏到下次 spawn
    const msg2 = workers[1].receivedMessages[0] as { vfsSnapshots: ArrayBuffer[] }
    expect(msg2.vfsSnapshots).toHaveLength(1)
  })

  test('spawn without extraSnapshots still works normally', () => {
    const { pm, workers } = makeManager()
    void pm.spawn(defaultSpawnOpts())
    const msg = workers[0].receivedMessages[0] as { vfsSnapshots: ArrayBuffer[] }
    expect(msg.vfsSnapshots).toHaveLength(0)
  })
})
