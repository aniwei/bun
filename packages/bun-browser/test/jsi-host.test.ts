/**
 * JsiHost 单元测试 —— 使用真实的 WebAssembly.Memory 但无需 WASM 二进制。
 *
 * 测试目标：验证 jsi-host.ts 中所有 imports() 函数能正确读写 WASM 线性内存，
 * 以及 handle 表的 retain / release / deref 语义。
 */

import { describe, expect, test } from 'bun:test'
import { EXCEPTION_SENTINEL, JsiHost, type JsiImportsTyped, PrintLevel, ReservedHandle, TypeTag } from '../src/jsi-host'

/** 返回类型化的 imports 表，避免 WebAssembly.ModuleImports 的模糊类型。 */
function getImports(host: JsiHost): JsiImportsTyped {
  return host.imports() as unknown as JsiImportsTyped
}

/** 创建一个内存页 (64 KiB) 的 WebAssembly.Memory。 */
function makeMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1 })
}

/** 写字符串到 WASM 内存，返回 (ptr, byteLen)。 */
function writeString(mem: WebAssembly.Memory, str: string, offset = 0x100): [number, number] {
  const bytes = new TextEncoder().encode(str)
  new Uint8Array(mem.buffer).set(bytes, offset)
  return [offset, bytes.byteLength]
}

// ──────────────────────────────────────────────────────────
// 保留 handle 常量
// ──────────────────────────────────────────────────────────

describe('保留 handle', () => {
  test('undefined → ReservedHandle.Undefined (0)', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    expect(imp.jsi_retain(ReservedHandle.Undefined)).toBe(ReservedHandle.Undefined)
  })

  test('null → ReservedHandle.Null (1)', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    expect(imp.jsi_retain(ReservedHandle.Null)).toBe(ReservedHandle.Null)
  })
})

// ──────────────────────────────────────────────────────────
// 值构造
// ──────────────────────────────────────────────────────────

describe('jsi_make_number', () => {
  test('存入 42，typeof = number，to_number = 42', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    const h = imp.jsi_make_number(42)
    expect(h).toBeGreaterThan(ReservedHandle.Global)
    expect(imp.jsi_typeof(h)).toBe(TypeTag.Number)
    expect(imp.jsi_to_number(h)).toBe(42)
  })

  test('负数与浮点不丢失精度', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    const h = imp.jsi_make_number(-Math.PI)
    expect(imp.jsi_to_number(h)).toBe(-Math.PI)
  })
})

describe('jsi_make_string + jsi_string_length + jsi_string_read', () => {
  test('ASCII 字符串往返', () => {
    const mem = makeMemory()
    const [ptr, len] = writeString(mem, 'hello')
    const host = new JsiHost({ memory: mem })
    const imp = getImports(host)
    const h = imp.jsi_make_string(ptr, len)
    expect(imp.jsi_typeof(h)).toBe(TypeTag.String)
    expect(imp.jsi_string_length(h)).toBe(5)

    // 读回
    const outPtr = 0x300
    imp.jsi_string_read(h, outPtr, 5)
    const back = new TextDecoder().decode(new Uint8Array(mem.buffer, outPtr, 5))
    expect(back).toBe('hello')
  })

  test('Unicode (中文) 往返', () => {
    const mem = makeMemory()
    const [ptr, len] = writeString(mem, '你好')
    const host = new JsiHost({ memory: mem })
    const imp = getImports(host)
    const h = imp.jsi_make_string(ptr, len)
    // "你好" 编码为 6 字节 UTF-8
    const byteLen = imp.jsi_string_length(h)
    expect(byteLen).toBe(6)
    const outPtr = 0x300
    imp.jsi_string_read(h, outPtr, byteLen)
    const back = new TextDecoder().decode(new Uint8Array(mem.buffer, outPtr, byteLen))
    expect(back).toBe('你好')
  })
})

describe('jsi_make_object / jsi_make_array', () => {
  test('object typeof = object', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    const h = imp.jsi_make_object()
    expect(imp.jsi_typeof(h)).toBe(TypeTag.Object)
  })

  test('array typeof = array', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    const h = imp.jsi_make_array(3)
    expect(imp.jsi_typeof(h)).toBe(TypeTag.Array)
  })
})

// ──────────────────────────────────────────────────────────
// 属性访问
// ──────────────────────────────────────────────────────────

describe('jsi_set_prop / jsi_get_prop / jsi_has_prop', () => {
  test('set + get + has', () => {
    const mem = makeMemory()
    const host = new JsiHost({ memory: mem })
    const imp = getImports(host)
    const obj = imp.jsi_make_object()
    const val = imp.jsi_make_number(99)
    const [namePtr, nameLen] = writeString(mem, 'score')
    imp.jsi_set_prop(obj, namePtr, nameLen, val)
    const [rPtr, rLen] = writeString(mem, 'score', 0x200)
    const got = imp.jsi_get_prop(obj, rPtr, rLen)
    expect(imp.jsi_to_number(got)).toBe(99)
    expect(imp.jsi_has_prop(obj, rPtr, rLen)).toBe(1)
  })

  test('get 不存在属性 → undefined handle', () => {
    const mem = makeMemory()
    const host = new JsiHost({ memory: mem })
    const imp = getImports(host)
    const obj = imp.jsi_make_object()
    const [p, l] = writeString(mem, 'missing')
    const got = imp.jsi_get_prop(obj, p, l)
    expect(got).toBe(ReservedHandle.Undefined)
  })
})

// ──────────────────────────────────────────────────────────
// 数组索引
// ──────────────────────────────────────────────────────────

describe('jsi_set_index / jsi_get_index', () => {
  test('设置索引再读回', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    const arr = imp.jsi_make_array(2)
    const v = imp.jsi_make_number(7)
    imp.jsi_set_index(arr, 0, v)
    const got = imp.jsi_get_index(arr, 0)
    expect(imp.jsi_to_number(got)).toBe(7)
  })
})

// ──────────────────────────────────────────────────────────
// retain / release
// ──────────────────────────────────────────────────────────

describe('jsi_retain / jsi_release', () => {
  test('retain 为同一值分配新的独立 handle', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    const h = imp.jsi_make_number(1)
    const retained = imp.jsi_retain(h)

    expect(retained).not.toBe(h)
    expect(imp.jsi_to_number(h)).toBe(1)
    expect(imp.jsi_to_number(retained)).toBe(1)

    // 原 handle 释放后，retain 的副本仍应可用
    imp.jsi_release(h)
    expect(imp.jsi_to_number(retained)).toBe(1)
  })

  test('release 后 handle 回收, 下次 make 可复用', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    const h = imp.jsi_make_number(1)
    const nextBefore = imp.jsi_make_number(2) // h 还未释放时 nextBefore > h
    imp.jsi_release(nextBefore)
    imp.jsi_release(h)
    // 复用 free list：下一个 make 应复用释放的槽位之一
    const reused = imp.jsi_make_number(3)
    // 只需验证 reused 是合法 handle（不再 crash）
    expect(imp.jsi_to_number(reused)).toBe(3)
  })
})

// ──────────────────────────────────────────────────────────
// to_boolean
// ──────────────────────────────────────────────────────────

describe('jsi_to_boolean', () => {
  test('0 → falsy', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    expect(imp.jsi_to_boolean(imp.jsi_make_number(0))).toBe(0)
  })

  test('1 → truthy', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    expect(imp.jsi_to_boolean(imp.jsi_make_number(1))).toBe(1)
  })

  test('true handle → 1', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    expect(imp.jsi_to_boolean(ReservedHandle.True)).toBe(1)
  })

  test('false handle → 0', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    expect(imp.jsi_to_boolean(ReservedHandle.False)).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────
// jsi_print
// ──────────────────────────────────────────────────────────

describe('jsi_print', () => {
  test('level=1 → stdout 回调', () => {
    const mem = makeMemory()
    const printed: Array<{ data: string; level: PrintLevel }> = []
    const host = new JsiHost({ memory: mem, onPrint: (d, l) => printed.push({ data: d, level: l }) })
    const imp = getImports(host)
    const [ptr, len] = writeString(mem, 'hello stdout')
    imp.jsi_print(ptr, len, PrintLevel.Stdout)
    expect(printed).toHaveLength(1)
    expect(printed[0]!.data).toBe('hello stdout')
    expect(printed[0]!.level).toBe(PrintLevel.Stdout)
  })

  test('level=2 → stderr 回调', () => {
    const mem = makeMemory()
    const printed: Array<{ data: string; level: PrintLevel }> = []
    const host = new JsiHost({ memory: mem, onPrint: (d, l) => printed.push({ data: d, level: l }) })
    const imp = getImports(host)
    const [ptr, len] = writeString(mem, 'ERROR!', 0x200)
    imp.jsi_print(ptr, len, PrintLevel.Stderr)
    expect(printed[0]!.level).toBe(PrintLevel.Stderr)
  })
})

// ──────────────────────────────────────────────────────────
// jsi_transpile 默认 identity
// ──────────────────────────────────────────────────────────

describe('jsi_transpile (default = identity)', () => {
  test('未提供 transpile 选项 → 原文返回', () => {
    const mem = makeMemory()
    const host = new JsiHost({ memory: mem })
    const imp = getImports(host)
    const src = 'const x: number = 1;'
    const [sPtr, sLen] = writeString(mem, src)
    const [fPtr, fLen] = writeString(mem, 'index.ts', 0x200)
    const h = imp.jsi_transpile(sPtr, sLen, fPtr, fLen)
    expect(h).not.toBe(EXCEPTION_SENTINEL)
    const byteLen = imp.jsi_string_length(h)
    const outPtr = 0x400
    imp.jsi_string_read(h, outPtr, byteLen)
    const back = new TextDecoder().decode(new Uint8Array(mem.buffer, outPtr, byteLen))
    expect(back).toBe(src) // identity
  })

  test('提供 transpile 回调 → 转换后字符串', () => {
    const mem = makeMemory()
    const host = new JsiHost({
      memory: mem,
      transpile: src => src.replace(/const (\w+): \w+/g, 'const $1'),
    })
    const imp = getImports(host)
    const src = 'const x: number = 1;'
    const [sPtr, sLen] = writeString(mem, src)
    const [fPtr, fLen] = writeString(mem, 'app.ts', 0x200)
    const h = imp.jsi_transpile(sPtr, sLen, fPtr, fLen)
    const byteLen = imp.jsi_string_length(h)
    const outPtr = 0x400
    imp.jsi_string_read(h, outPtr, byteLen)
    const back = new TextDecoder().decode(new Uint8Array(mem.buffer, outPtr, byteLen))
    expect(back).toBe('const x = 1;')
  })
})

// ──────────────────────────────────────────────────────────
// jsi_call
// ──────────────────────────────────────────────────────────

describe('jsi_call', () => {
  test('调用 JS 函数并传递参数', () => {
    const mem = makeMemory()
    const host = new JsiHost({ memory: mem })
    const imp = getImports(host)
    // 构造一个 JS 函数 handle
    const fn = (a: number, b: number) => a + b
    const fnHandle = host.retain(fn)
    // 参数 handle：2 个数字
    const h1 = imp.jsi_make_number(3)
    const h2 = imp.jsi_make_number(4)
    // 写 argv 到 mem（u32 小端）
    const argvPtr = 0x300
    const view = new DataView(mem.buffer)
    view.setUint32(argvPtr, h1, true)
    view.setUint32(argvPtr + 4, h2, true)
    const thisH = ReservedHandle.Global
    const result = imp.jsi_call(fnHandle, thisH, argvPtr, 2)
    expect(result).not.toBe(EXCEPTION_SENTINEL)
    expect(imp.jsi_to_number(result)).toBe(7)
  })
})

// ──────────────────────────────────────────────────────────
// Phase 5.5 — wasm-threads + SAB imports
// ──────────────────────────────────────────────────────────

describe('Phase 5.5 — thread / atomics imports', () => {
  test('jsi_thread_self returns configured threadId (default 0)', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    expect(imp.jsi_thread_self()).toBe(0)
  })

  test('jsi_thread_self reflects injected threadId', () => {
    const host = new JsiHost({ memory: makeMemory(), threadId: 7 })
    const imp = getImports(host)
    expect(imp.jsi_thread_self()).toBe(7)
  })

  test('jsi_thread_spawn returns 0 when no spawner injected', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    expect(imp.jsi_thread_spawn(0)).toBe(0)
  })

  test('jsi_thread_spawn delegates to injected spawner and returns tid', () => {
    let nextTid = 1
    const captured: number[] = []
    const host = new JsiHost({
      memory: makeMemory(),
      spawnThread: arg => {
        captured.push(arg)
        return nextTid++
      },
    })
    const imp = getImports(host)
    expect(imp.jsi_thread_spawn(42)).toBe(1)
    expect(imp.jsi_thread_spawn(99)).toBe(2)
    expect(captured).toEqual([42, 99])
  })

  test('jsi_thread_capability bit0 (SAB) reflects environment', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    const bits = imp.jsi_thread_capability()
    // Bun 运行时 SAB 可用 → bit0 置位
    expect((bits & 1) !== 0).toBe(true)
    // 主线程：bit1 (Atomics.wait sync) 不置位
    expect((bits & 2) === 0).toBe(true)
  })

  test('jsi_thread_capability bit2 reflects spawner presence', () => {
    const h0 = new JsiHost({ memory: makeMemory() })
    expect((getImports(h0).jsi_thread_capability() & 4) === 0).toBe(true)
    const h1 = new JsiHost({ memory: makeMemory(), spawnThread: () => 1 })
    expect((getImports(h1).jsi_thread_capability() & 4) !== 0).toBe(true)
  })

  test('jsi_atomic_wait returns 1 (not-equal) when value differs', () => {
    // 使用 SAB-backed WebAssembly.Memory 需要 shared=true，但 Bun 版本可能不支持；
    // 这里用普通 memory 测试「非 SAB」分支：值相同 → 2(timed-out)，不同 → 1(not-equal)
    const mem = makeMemory()
    const host = new JsiHost({ memory: mem })
    const imp = getImports(host)
    // 在 ptr=0x40 写入 Int32 = 99
    new DataView(mem.buffer).setInt32(0x40, 99, true)
    expect(imp.jsi_atomic_wait(0x40, 7 /* expected */, 10)).toBe(1)
  })

  test('jsi_atomic_wait returns 2 (timed-out) when value matches on non-SAB mem', () => {
    const mem = makeMemory()
    const host = new JsiHost({ memory: mem })
    const imp = getImports(host)
    new DataView(mem.buffer).setInt32(0x40, 5, true)
    expect(imp.jsi_atomic_wait(0x40, 5, 10)).toBe(2)
  })

  test('jsi_atomic_notify is a no-op on non-SAB memory', () => {
    const host = new JsiHost({ memory: makeMemory() })
    const imp = getImports(host)
    expect(imp.jsi_atomic_notify(0x40, 1)).toBe(0)
  })
})
