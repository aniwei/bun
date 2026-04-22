/**
 * Phase 1 T1.1 集成测试：bun_lockfile_parse
 *
 * 加载真实 bun-core.wasm，断言摘要 JSON 字段正确。
 */

import { describe, expect, test, beforeAll } from 'bun:test'
import { createWasmRuntime, type WasmRuntime } from '../src/wasm'
import { createContext, runInContext } from 'node:vm'

const WASM_PATH = import.meta.dir + '/../bun-core.wasm'

let wasmModule: WebAssembly.Module

beforeAll(async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer()
  wasmModule = await WebAssembly.compile(bytes)
})

async function makeRuntime(): Promise<WasmRuntime> {
  const sandbox = createContext({
    console,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    TextDecoder,
    JSON,
    Math,
    Object,
    Array,
    Promise,
    Error,
    Symbol,
  })
  const evaluator = (code: string, url: string): unknown =>
    runInContext(`(function(){\n${code}\n})()\n//# sourceURL=${url}`, sandbox, { filename: url })
  return createWasmRuntime(wasmModule, { evaluator, global: sandbox })
}

describe('bun_lockfile_parse', () => {
  test('解析真实 bun.lock（含尾随逗号）', async () => {
    const rt = await makeRuntime()
    const text = await Bun.file(import.meta.dir + '/../bun.lock').text()
    const summary = rt.parseLockfile(text)

    expect(summary.lockfileVersion).toBe(1)
    expect(summary.workspaceCount).toBeGreaterThanOrEqual(1)
    // 实际 lock 至少包含 @types/node / typescript / undici-types
    const names = summary.packages.map(p => p.name)
    expect(names).toContain('@types/node')
    expect(names).toContain('typescript')
    expect(summary.packageCount).toBe(summary.packages.length)
    // 版本字段不应为空
    for (const p of summary.packages) {
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.version.length).toBeGreaterThan(0)
    }
  })

  test('scope 包：正确拆分 @scope/name@version', async () => {
    const rt = await makeRuntime()
    const lockfile = JSON.stringify({
      lockfileVersion: 1,
      workspaces: { '': { name: 'app' } },
      packages: {
        '@types/node': ['@types/node@20.19.39', '', {}, 'sha512-xxx'],
        typescript: ['typescript@6.0.3', '', {}, 'sha512-yyy'],
      },
    })
    const s = rt.parseLockfile(lockfile)
    expect(s.packageCount).toBe(2)
    const types = s.packages.find(p => p.key === '@types/node')
    expect(types?.name).toBe('@types/node')
    expect(types?.version).toBe('20.19.39')
    const ts = s.packages.find(p => p.key === 'typescript')
    expect(ts?.version).toBe('6.0.3')
  })

  test('缺少 lockfileVersion → 报错', async () => {
    const rt = await makeRuntime()
    expect(() => rt.parseLockfile(JSON.stringify({ workspaces: {} }))).toThrow(/lockfileVersion/)
  })

  test('非法 JSON → 报错', async () => {
    const rt = await makeRuntime()
    expect(() => rt.parseLockfile('{not json')).toThrow(/invalid JSON/)
  })

  test('空 packages 对象', async () => {
    const rt = await makeRuntime()
    const s = rt.parseLockfile(JSON.stringify({ lockfileVersion: 1, packages: {} }))
    expect(s.packageCount).toBe(0)
    expect(s.packages).toEqual([])
  })

  test('字符串内含逗号+右括号不被预处理误删', async () => {
    const rt = await makeRuntime()
    // 键名里包含 "," + "}" 片段
    const lockfile = JSON.stringify({
      lockfileVersion: 1,
      packages: {
        'weird,name': ['weird,name@1.0.0', '', {}, 'sha512-zzz'],
      },
    })
    const s = rt.parseLockfile(lockfile)
    expect(s.packages[0].key).toBe('weird,name')
    expect(s.packages[0].version).toBe('1.0.0')
  })
})
