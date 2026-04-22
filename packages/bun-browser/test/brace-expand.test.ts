/**
 * T5.10.3 测试：bun_brace_expand —— ASCII brace 展开。
 *
 * 若当前打包的 bun-core.wasm 未导出 bun_brace_expand（旧版本），测试会自动跳过。
 */

import { describe, expect, test, beforeAll } from 'bun:test'
import { createWasmRuntime, type WasmRuntime } from '../src/wasm'
import { createContext, runInContext } from 'node:vm'

const WASM_PATH = import.meta.dir + '/../bun-core.wasm'

let wasmModule: WebAssembly.Module
let hasBraceExpand = false

beforeAll(async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer()
  wasmModule = await WebAssembly.compile(bytes)
  const exports = WebAssembly.Module.exports(wasmModule).map(e => e.name)
  hasBraceExpand = exports.includes('bun_brace_expand')
})

async function makeRuntime(): Promise<WasmRuntime> {
  const sandbox = createContext({
    console,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    performance,
  })
  return createWasmRuntime(wasmModule, {
    evaluator: (code, url) => runInContext(code, sandbox, { filename: url }),
    onPrint: (_msg, kind) => {
      if (kind === 'stderr') process.stderr.write(_msg)
    },
  })
}

describe('bun_brace_expand', () => {
  test('导出存在', () => {
    expect(hasBraceExpand).toBe(true)
  })

  test('简单 comma-separated 展开', async () => {
    if (!hasBraceExpand) return
    const rt = await makeRuntime()
    const result = rt.braceExpand('{a,b,c}')
    expect(result).toEqual(['a', 'b', 'c'])
  })

  test('前缀 + brace group', async () => {
    if (!hasBraceExpand) return
    const rt = await makeRuntime()
    const result = rt.braceExpand('foo{a,b}bar')
    expect(result).toEqual(['fooabar', 'foobbar'])
  })

  test('多个 brace groups', async () => {
    if (!hasBraceExpand) return
    const rt = await makeRuntime()
    const result = rt.braceExpand('{a,b}{1,2}')
    expect(result).toEqual(['a1', 'a2', 'b1', 'b2'])
  })

  test('嵌套 brace groups', async () => {
    if (!hasBraceExpand) return
    const rt = await makeRuntime()
    const result = rt.braceExpand('{a,{b,c}}')
    expect(result).toEqual(['a', 'b', 'c'])
  })

  test('无 brace — 原样返回', async () => {
    if (!hasBraceExpand) return
    const rt = await makeRuntime()
    const result = rt.braceExpand('hello')
    expect(result).toEqual(['hello'])
  })

  test('单元素 brace — 原样返回（无逗号）', async () => {
    if (!hasBraceExpand) return
    const rt = await makeRuntime()
    const result = rt.braceExpand('{only}')
    expect(result).toEqual(['{only}'])
  })

  test('空输入', async () => {
    if (!hasBraceExpand) return
    const rt = await makeRuntime()
    const result = rt.braceExpand('')
    expect(result).toEqual([''])
  })

  test('路径 glob 风格', async () => {
    if (!hasBraceExpand) return
    const rt = await makeRuntime()
    const result = rt.braceExpand('src/{index,main}.{ts,js}')
    expect(result).toEqual(['src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js'])
  })
})
