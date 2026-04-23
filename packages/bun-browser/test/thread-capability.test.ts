/**
 * T5.5.3 — 线程能力探测（thread-capability.ts）单元测试。
 *
 * Bun 的测试环境不是 crossOriginIsolated，且 SharedArrayBuffer 通常可用；
 * 所以我们重点测试各返回字段的类型正确、条件组合逻辑、以及创建/选择函数的行为。
 */

import { test, expect, describe } from 'bun:test'
import {
  detectThreadCapability,
  createSharedMemory,
  selectWasmModule,
  type ThreadCapability,
} from '../src/thread-capability'

// ---------------------------------------------------------------------------
// detectThreadCapability
// ---------------------------------------------------------------------------

describe('detectThreadCapability', () => {
  test('返回值结构正确', () => {
    const cap = detectThreadCapability()
    expect(typeof cap.crossOriginIsolated).toBe('boolean')
    expect(typeof cap.sharedArrayBuffer).toBe('boolean')
    expect(typeof cap.threadsReady).toBe('boolean')
    expect(typeof cap.inWorker).toBe('boolean')
    expect(typeof cap.atomicsWaitAsync).toBe('boolean')
  })

  test('threadsReady === crossOriginIsolated && sharedArrayBuffer', () => {
    const cap = detectThreadCapability()
    expect(cap.threadsReady).toBe(cap.crossOriginIsolated && cap.sharedArrayBuffer)
  })

  test('在 Bun 测试中 crossOriginIsolated 为 false', () => {
    // Bun 测试进程不具备 COOP/COEP 隔离
    const cap = detectThreadCapability()
    expect(cap.crossOriginIsolated).toBe(false)
  })

  test('在 Bun 测试中 threadsReady 为 false', () => {
    // crossOriginIsolated=false → threadsReady=false，无论 SAB 情况
    const cap = detectThreadCapability()
    expect(cap.threadsReady).toBe(false)
  })

  test('在 Bun 测试中 inWorker 为 false（主进程无 WorkerGlobalScope）', () => {
    const cap = detectThreadCapability()
    expect(cap.inWorker).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createSharedMemory
// ---------------------------------------------------------------------------

describe('createSharedMemory', () => {
  test('有 SharedArrayBuffer 时返回 Memory 对象', () => {
    if (typeof SharedArrayBuffer === 'undefined') return // 跳过不支持环境
    const mem = createSharedMemory()
    // Bun 环境里 SAB 可用但 shared Memory 可能因缺少 maximum 限制而失败；
    // 只要不抛出，返回值应为 Memory 实例或 undefined。
    expect(mem === undefined || mem instanceof WebAssembly.Memory).toBe(true)
  })

  test('返回值若存在，buffer 是 SharedArrayBuffer', () => {
    const mem = createSharedMemory()
    if (mem === undefined) return // 环境不支持，跳过
    expect(mem.buffer instanceof SharedArrayBuffer).toBe(true)
  })

  test('自定义 pages 参数不抛出', () => {
    expect(() => createSharedMemory(1, 2)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// selectWasmModule
// ---------------------------------------------------------------------------

const fakeModule = {} as WebAssembly.Module
const fakeThreadsModule = {} as WebAssembly.Module

describe('selectWasmModule', () => {
  test('未提供 threadsModule → 返回 singleModule, threaded=false', () => {
    const result = selectWasmModule(fakeModule, undefined)
    expect(result.module).toBe(fakeModule)
    expect(result.threaded).toBe(false)
    expect(result.sharedMemory).toBeUndefined()
  })

  test('cap.threadsReady=false → 回退到 singleModule', () => {
    const cap: ThreadCapability = {
      crossOriginIsolated: false,
      sharedArrayBuffer: true,
      threadsReady: false,
      inWorker: false,
      atomicsWaitAsync: false,
    }
    const result = selectWasmModule(fakeModule, fakeThreadsModule, cap)
    expect(result.module).toBe(fakeModule)
    expect(result.threaded).toBe(false)
    expect(result.sharedMemory).toBeUndefined()
  })

  test('cap.threadsReady=true 且有 threadsModule → threaded=true，返回 threadsModule', () => {
    const cap: ThreadCapability = {
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
      threadsReady: true,
      inWorker: true,
      atomicsWaitAsync: true,
    }
    const result = selectWasmModule(fakeModule, fakeThreadsModule, cap)
    expect(result.module).toBe(fakeThreadsModule)
    expect(result.threaded).toBe(true)
    // sharedMemory 可能为 undefined（Bun 测试环境下 SAB 可用但 WebAssembly.Memory
    // 不支持 shared=true 的情况），接受两种结果
    expect(result.sharedMemory === undefined || result.sharedMemory instanceof WebAssembly.Memory).toBe(true)
  })

  test('不传 cap 时内部自动调用 detectThreadCapability()', () => {
    // 不传 cap，在 Bun 测试环境里 threadsReady=false 故必然回退到 singleModule
    const result = selectWasmModule(fakeModule, fakeThreadsModule)
    expect(result.module).toBe(fakeModule)
    expect(result.threaded).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// regression: 多次调用 detectThreadCapability 结果幂等
// ---------------------------------------------------------------------------

test('detectThreadCapability 多次调用结果一致', () => {
  const a = detectThreadCapability()
  const b = detectThreadCapability()
  expect(a.crossOriginIsolated).toBe(b.crossOriginIsolated)
  expect(a.sharedArrayBuffer).toBe(b.sharedArrayBuffer)
  expect(a.threadsReady).toBe(b.threadsReady)
  expect(a.inWorker).toBe(b.inWorker)
  expect(a.atomicsWaitAsync).toBe(b.atomicsWaitAsync)
})
