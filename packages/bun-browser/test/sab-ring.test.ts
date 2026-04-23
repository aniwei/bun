/**
 * SabRing 单元测试：验证 SPSC 字节 ring 的读写 / 环绕 / 关闭 / 容量语义。
 *
 * 在 Bun 测试环境中 `SharedArrayBuffer` 可用但 `Atomics.wait` 仅在 Worker 内合法；
 * 本测试在主线程运行，因此只覆盖非阻塞 path（`read` / `write` / `close`）。
 * 跨 Worker 的阻塞 path（`readBlocking`）由更上层的 pipe 集成测试覆盖。
 */

import { test, expect, describe } from 'bun:test'
import { createSabRing, SabRingProducer, SabRingConsumer, sabCapability, SAB_RING_HEADER_BYTES } from '../src/sab-ring'

describe('SabRing — capability detection', () => {
  test('sabCapability returns booleans', () => {
    const c = sabCapability()
    expect(typeof c.sab).toBe('boolean')
    expect(typeof c.atomicsWait).toBe('boolean')
  })
})

describe('SabRing — basic SPSC', () => {
  test('capacity < 16 throws', () => {
    expect(() => createSabRing(8)).toThrow(RangeError)
    expect(() => createSabRing(15.5)).toThrow(RangeError)
  })

  test('buffer size == header + capacity', () => {
    const ring = createSabRing(64)
    expect(ring.buffer.byteLength).toBe(SAB_RING_HEADER_BYTES + 64)
    expect(ring.capacity).toBe(64)
  })

  test('write then read returns same bytes', () => {
    const ring = createSabRing(64)
    const p = new SabRingProducer(ring)
    const c = new SabRingConsumer(ring)

    const input = new Uint8Array([1, 2, 3, 4, 5])
    expect(p.write(input)).toBe(5)
    expect(c.readable()).toBe(5)

    const out = new Uint8Array(8)
    expect(c.read(out)).toBe(5)
    expect(Array.from(out.subarray(0, 5))).toEqual([1, 2, 3, 4, 5])
    expect(c.readable()).toBe(0)
  })

  test('empty ring returns 0 bytes', () => {
    const ring = createSabRing(32)
    const c = new SabRingConsumer(ring)
    expect(c.read(new Uint8Array(4))).toBe(0)
    expect(c.readable()).toBe(0)
  })

  test('writable count respects 1-byte reserved slot', () => {
    const ring = createSabRing(16)
    const p = new SabRingProducer(ring)
    // capacity 16 → 最多可用 15 字节
    expect(p.writable()).toBe(15)
    expect(p.write(new Uint8Array(20))).toBe(15)
    expect(p.writable()).toBe(0)
  })
})

describe('SabRing — wrap-around', () => {
  test('write/read straddling the buffer end', () => {
    const ring = createSabRing(16) // usable 15
    const p = new SabRingProducer(ring)
    const c = new SabRingConsumer(ring)

    // 先写 10 字节
    const a = new Uint8Array(10).map((_, i) => i + 1)
    expect(p.write(a)).toBe(10)
    // 读 8 字节 —— tail 前进到 8
    const out1 = new Uint8Array(8)
    expect(c.read(out1)).toBe(8)
    expect(Array.from(out1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    // 再写 12 字节 —— 必须环绕（head 10 → 10+12=22, mod 16 = 6）
    const b = new Uint8Array(12).map((_, i) => 100 + i)
    expect(p.write(b)).toBe(12)

    // 剩余 [9,10,100..111] 共 2+12 = 14 字节可读
    const out2 = new Uint8Array(32)
    expect(c.read(out2)).toBe(14)
    expect(Array.from(out2.subarray(0, 2))).toEqual([9, 10])
    expect(Array.from(out2.subarray(2, 14))).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111])
  })

  test('partial write when ring nearly full', () => {
    const ring = createSabRing(16) // usable 15
    const p = new SabRingProducer(ring)
    const c = new SabRingConsumer(ring)

    expect(p.write(new Uint8Array(10).fill(7))).toBe(10)
    c.read(new Uint8Array(5))
    // head=10, tail=5 → used 5, writable = 15-5 = 10
    expect(p.writable()).toBe(10)
    expect(p.write(new Uint8Array(20).fill(8))).toBe(10)
    expect(p.writable()).toBe(0)
  })
})

describe('SabRing — close semantics', () => {
  test('close() flips flag; subsequent writes still advance (producer policy)', () => {
    const ring = createSabRing(16)
    const p = new SabRingProducer(ring)
    expect(p.isClosed()).toBe(false)
    p.close()
    expect(p.isClosed()).toBe(true)
  })

  test('consumer sees close flag after close', () => {
    const ring = createSabRing(16)
    const p = new SabRingProducer(ring)
    const c = new SabRingConsumer(ring)
    expect(c.isClosed()).toBe(false)
    p.close()
    expect(c.isClosed()).toBe(true)
  })
})

describe('SabRing — non-SAB fallback', () => {
  test('works even when created as plain ArrayBuffer (single-thread)', () => {
    // 直接手工构造一个 plain-ArrayBuffer ring，模拟无 SAB 环境。
    const capacity = 32
    const buffer = new ArrayBuffer(SAB_RING_HEADER_BYTES + capacity)
    const ring = { buffer, capacity }
    const p = new SabRingProducer(ring)
    const c = new SabRingConsumer(ring)

    expect(p.write(new Uint8Array([9, 9, 9]))).toBe(3)
    const out = new Uint8Array(4)
    expect(c.read(out)).toBe(3)
    expect(Array.from(out.subarray(0, 3))).toEqual([9, 9, 9])
  })
})
