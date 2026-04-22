/**
 * atomic-wait 单元测试。
 * 主线程环境下只能走 async / fallback path（Worker-only 同步 path 有专门集成测试覆盖）。
 */

import { test, expect, describe } from 'bun:test'
import { detectAtomicWait, atomicWaitAsync, atomicNotify, atomicWaitSync } from '../src/atomic-wait'

describe('detectAtomicWait', () => {
  test('returns a fully populated capability object', () => {
    const c = detectAtomicWait()
    expect(typeof c.sab).toBe('boolean')
    expect(typeof c.inWorker).toBe('boolean')
    expect(typeof c.sync).toBe('boolean')
    expect(typeof c.async).toBe('boolean')
    // Bun 主线程：sab=true，inWorker=false，sync=false
    expect(c.inWorker).toBe(false)
    expect(c.sync).toBe(false)
  })
})

describe('atomicWaitAsync — main-thread path', () => {
  test("returns 'not-equal' when value already differs", async () => {
    const sab = new SharedArrayBuffer(16)
    const view = new Int32Array(sab)
    view[0] = 42
    const r = await atomicWaitAsync(view, 0, 7 /* expected */, 50)
    expect(r).toBe('not-equal')
  })

  test("returns 'timed-out' when no change within timeout", async () => {
    const sab = new SharedArrayBuffer(16)
    const view = new Int32Array(sab)
    view[0] = 0
    const r = await atomicWaitAsync(view, 0, 0, 30)
    expect(r).toBe('timed-out')
  })

  test("returns 'ok' after another task mutates the slot", async () => {
    const sab = new SharedArrayBuffer(16)
    const view = new Int32Array(sab)
    view[0] = 0

    // 在未来某刻翻转值并唤醒
    setTimeout(() => {
      Atomics.store(view, 0, 1)
      atomicNotify(view, 0)
    }, 10)

    const r = await atomicWaitAsync(view, 0, 0, 500)
    expect(r).toBe('ok')
    expect(view[0]).toBe(1)
  })
})

describe('atomicWaitSync — fallback path (no Worker)', () => {
  test('returns immediately when already not-equal', () => {
    const sab = new SharedArrayBuffer(16)
    const view = new Int32Array(sab)
    view[0] = 5
    const r = atomicWaitSync(view, 0, 0, 1) // expected=0, actual=5
    expect(r).toBe('ok')
  })

  test('times out when stuck and no wait support', () => {
    const sab = new SharedArrayBuffer(16)
    const view = new Int32Array(sab)
    view[0] = 0
    const r = atomicWaitSync(view, 0, 0, 5)
    expect(r).toBe('timed-out')
  })
})

describe('atomicNotify', () => {
  test('returns 0 on non-SAB-waiters slot (no-op)', () => {
    const sab = new SharedArrayBuffer(16)
    const view = new Int32Array(sab)
    expect(atomicNotify(view, 0)).toBe(0)
  })

  test('swallowing error on plain ArrayBuffer', () => {
    const buf = new ArrayBuffer(16)
    const view = new Int32Array(buf)
    expect(atomicNotify(view, 0)).toBe(0)
  })
})
