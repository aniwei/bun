/**
 * WorkerPool 单元测试：用同线程的 "fake worker" 实现，不引入 mock/spyon。
 *
 * 每个 fake worker 拿到 `{ jobId, input }` 后，按 input 里的指令做真实计算，
 * 然后通过保存的 message listener 回调 `{ jobId, ok, output }`。
 * 真正验证调度行为（并发度、背压、FIFO）而不是桩代码。
 */

import { test, expect } from 'bun:test'
import { WorkerPool, type WorkerLike } from '../src/worker-pool'

type JobInput = { kind: 'echo'; value: number } | { kind: 'throw'; message: string }

interface FakeWorker extends WorkerLike {
  /** 观察用：该 worker 处理过的 jobId 列表。 */
  processedJobs: string[]
  /** 当前正在处理但尚未回复的 jobId。 */
  inflightJobId?: string
  /** 触发回复（模拟异步完成）。 */
  reply(): void
}

function makeFakeWorkerFactory(): { factory: () => FakeWorker; workers: FakeWorker[] } {
  const workers: FakeWorker[] = []
  const factory = (): FakeWorker => {
    const messageListeners: ((ev: { data: unknown }) => void)[] = []
    // 用队列而非单槽，避免在 listener 回调内再次 postMessage 时覆盖 _pendingReply。
    const pendingReplies: (() => void)[] = []
    const w: FakeWorker = {
      processedJobs: [],
      postMessage(msg: unknown): void {
        const m = msg as { jobId: string; input: JobInput }
        w.inflightJobId = m.jobId
        pendingReplies.push(() => {
          w.processedJobs.push(m.jobId)
          if (m.input.kind === 'throw') {
            for (const l of messageListeners) l({ data: { jobId: m.jobId, ok: false, error: m.input.message } })
          } else {
            for (const l of messageListeners) l({ data: { jobId: m.jobId, ok: true, output: m.input.value * 2 } })
          }
        })
      },
      terminate(): void {
        // noop
      },
      addEventListener(
        type: 'message' | 'error',
        listener: ((ev: { data: unknown }) => void) | ((ev: unknown) => void),
      ): void {
        if (type === 'message') messageListeners.push(listener as (ev: { data: unknown }) => void)
      },
      removeEventListener(): void {
        // noop
      },
      reply(): void {
        const next = pendingReplies.shift()
        if (!next) return
        next()
        // listener→onWorkerMessage→drain 可能又触发 postMessage，把新的 reply 入队；
        // 该 reply 留给后续 .reply() 调用。
        if (pendingReplies.length === 0) w.inflightJobId = undefined
      },
    }
    workers.push(w)
    return w
  }
  return { factory, workers }
}

test('WorkerPool: 并发度等于 size，超出的任务排队等待', async () => {
  const { factory, workers } = makeFakeWorkerFactory()
  const pool = new WorkerPool<JobInput, number>({ size: 2, factory })

  // 提交 4 个任务；只有前 2 个会立刻派给 worker，剩下 2 个排队
  const p1 = pool.submit({ kind: 'echo', value: 1 })
  const p2 = pool.submit({ kind: 'echo', value: 2 })
  const p3 = pool.submit({ kind: 'echo', value: 3 })
  const p4 = pool.submit({ kind: 'echo', value: 4 })

  expect(pool.workerCount).toBe(2)
  // 两个 worker 都 busy
  expect(workers.every(w => w.inflightJobId !== undefined)).toBe(true)
  // 排队长度 = 2（= 总数 4 - 池大小 2）
  expect(pool.pendingCount).toBe(2)

  // 让第一批 worker 回复，后续 2 个任务才会被派出
  workers[0]!.reply()
  workers[1]!.reply()
  const [a, b] = await Promise.all([p1, p2])
  expect(a).toBe(2)
  expect(b).toBe(4)

  // 第二批也由同样的 2 个 worker 处理（FIFO + 复用）
  workers[0]!.reply()
  workers[1]!.reply()
  const [c, d] = await Promise.all([p3, p4])
  expect(c).toBe(6)
  expect(d).toBe(8)

  pool.terminate()
})

test('WorkerPool: worker 报错时 submit 拒绝', async () => {
  const { factory, workers } = makeFakeWorkerFactory()
  const pool = new WorkerPool<JobInput, number>({ size: 1, factory })

  const p = pool.submit({ kind: 'throw', message: 'boom' })
  workers[0]!.reply()
  await expect(p).rejects.toThrow('boom')

  pool.terminate()
})

test('WorkerPool: map 并行保持输出顺序', async () => {
  const { factory, workers } = makeFakeWorkerFactory()
  const pool = new WorkerPool<JobInput, number>({ size: 3, factory })

  const inputs = [10, 20, 30, 40, 50]
  const promise = pool.map(inputs, v => ({ input: { kind: 'echo', value: v } as JobInput }))

  // 3 个 worker 各拿一个 job
  expect(workers.filter(w => w.inflightJobId !== undefined).length).toBe(3)

  // 轮流让所有 worker 回复，直到整个 map 完成
  while (workers.some(w => w.inflightJobId !== undefined)) {
    for (const w of workers) {
      if (w.inflightJobId !== undefined) w.reply()
    }
  }

  const out = await promise
  expect(out).toEqual([20, 40, 60, 80, 100])

  // 验证任务确实分散到多个 worker 处理（池并非退化成串行）
  const distinctWorkersUsed = workers.filter(w => w.processedJobs.length > 0).length
  expect(distinctWorkersUsed).toBeGreaterThanOrEqual(2)

  pool.terminate()
})

test('WorkerPool: terminate 后 submit 拒绝', async () => {
  const { factory } = makeFakeWorkerFactory()
  const pool = new WorkerPool<JobInput, number>({ size: 1, factory })
  pool.terminate()
  await expect(pool.submit({ kind: 'echo', value: 1 })).rejects.toThrow('terminated')
})

test('WorkerPool: terminate 拒绝所有 pending', async () => {
  const { factory, workers } = makeFakeWorkerFactory()
  const pool = new WorkerPool<JobInput, number>({ size: 1, factory })

  const p1 = pool.submit({ kind: 'echo', value: 1 }) // 正在处理
  const p2 = pool.submit({ kind: 'echo', value: 2 }) // 排队中
  expect(workers[0]!.inflightJobId).toBeDefined()
  expect(pool.pendingCount).toBe(1)

  pool.terminate()

  await expect(p1).rejects.toThrow('terminated')
  await expect(p2).rejects.toThrow('terminated')
})
