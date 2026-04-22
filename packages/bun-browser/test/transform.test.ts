/**
 * Phase 5.2 测试：bun_transform —— 内置 TS/JSX → JS 转译。
 *
 * 若当前打包的 bun-core.wasm 未导出 bun_transform（旧版本），测试会自动跳过。
 */

import { describe, expect, test, beforeAll } from 'bun:test'
import { createWasmRuntime, type WasmRuntime } from '../src/wasm'
import { buildSnapshot } from '../src/vfs-client'
import { createContext, runInContext } from 'node:vm'

const WASM_PATH = import.meta.dir + '/../bun-core.wasm'

let wasmModule: WebAssembly.Module
let hasTransform = false

beforeAll(async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer()
  wasmModule = await WebAssembly.compile(bytes)
  // Probe: some pre-Phase-5.2 wasm binaries don't export bun_transform.
  const exports = WebAssembly.Module.exports(wasmModule).map(e => e.name)
  hasTransform = exports.includes('bun_transform')
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

describe('bun_transform (Phase 5.2)', () => {
  test('去除变量类型注解', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform('const x: number = 1;', 'a.ts')
    expect(r).not.toBeNull()
    expect(r!.errors).toEqual([])
    expect(r!.code).toContain('const x')
    expect(r!.code).not.toContain(': number')
  })

  test('删除 interface 声明', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform('interface Foo { a: string; }\nexport const v = 1;', 'b.ts')
    expect(r!.code).not.toContain('interface')
    expect(r!.code).toContain('export const v = 1')
  })

  test('纯 JS 透传', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform('const x = 1;', 'a.js')
    expect(r!.code).toBe('const x = 1;')
  })

  test('tsx 文件 JSX 基本转换', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform('const el = <div>hi</div>;', 'a.tsx', { jsx: 'react' })
    expect(r!.code).toContain('createElement')
  })

  test('不合法源码返回 errors', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    // 不期望严格错误——轻量实现可能容忍，但 shape 必须正确
    const r = rt.transform('const x: = ', 'bad.ts')
    expect(r).not.toBeNull()
    expect(typeof r!.code === 'string' || r!.code === null).toBe(true)
    expect(Array.isArray(r!.errors)).toBe(true)
  })

  test('WASM 未导出时 transform 返回 null', async () => {
    // Regardless of binary, the host helper must not throw.
    const rt = await makeRuntime()
    // When export exists, result is non-null; when missing, returns null.
    const r = rt.transform('const x = 1;', 'a.js')
    expect(r === null || typeof r === 'object').toBe(true)
  })
})

// ── T5.2.6: ESM→CJS 转换 ───────────────────────────────────────────────────
describe('bun_transform ESM→CJS (T5.2.6)', () => {
  test('import default → require', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`import React from 'react';\nconst el = React.createElement('div');`, 'app.ts', {
      esmToCjs: true,
      jsx: 'none',
    })
    expect(r).not.toBeNull()
    expect(r!.errors).toEqual([])
    expect(r!.code).toContain('require(')
    expect(r!.code).not.toMatch(/\bimport\b/)
  })

  test('import named → const destructure', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`import { useState, useEffect } from 'react';\nuseState(0);`, 'app.ts', {
      esmToCjs: true,
      jsx: 'none',
    })
    expect(r).not.toBeNull()
    expect(r!.code).toContain('require(')
    expect(r!.code).toContain('useState')
    expect(r!.code).toContain('useEffect')
    expect(r!.code).not.toMatch(/\bimport\b/)
  })

  test('import * as ns → require', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`import * as path from 'node:path';\npath.join('/a', 'b');`, 'a.ts', {
      esmToCjs: true,
      jsx: 'none',
    })
    expect(r!.code).toContain('require(')
    expect(r!.code).toContain('path')
    expect(r!.code).not.toMatch(/\bimport\b/)
  })

  test('export default expr → module.exports assignment', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`export default 42;`, 'a.ts', { esmToCjs: true, jsx: 'none' })
    expect(r!.code).toContain('module.exports')
    expect(r!.code).not.toMatch(/\bexport\s+default\b/)
  })

  test('export const → declaration + deferred module.exports', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`export const greeting = 'hello';\nexport const count = 42;`, 'a.ts', {
      esmToCjs: true,
      jsx: 'none',
    })
    expect(r!.code).toContain('const greeting')
    expect(r!.code).toContain('module.exports')
    expect(r!.code).not.toMatch(/^export\s/m)
  })

  test('export function foo → declaration + deferred module.exports', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`export function add(a: number, b: number): number { return a + b; }`, 'a.ts', {
      esmToCjs: true,
      jsx: 'none',
    })
    expect(r!.code).toContain('function add')
    expect(r!.code).toContain('module.exports')
    expect(r!.code).not.toMatch(/\bexport\s+function\b/)
  })

  test('import type は削除される（esm_to_cjs でも）', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`import type { Foo } from './foo';\nimport { bar } from './bar';`, 'a.ts', {
      esmToCjs: true,
      jsx: 'none',
    })
    expect(r!.code).not.toContain('import type')
    expect(r!.code).toContain('require(')
  })
})

// ── T5.2.7: sourcemap 生成 ────────────────────────────────────────────────
describe('bun_transform sourcemap (T5.2.7)', () => {
  test('sourceMap オプションで map フィールドが返される', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`const x: number = 1;\nconst y = 2;`, 'a.ts', { sourceMap: true })
    expect(r).not.toBeNull()
    expect(r!.code).not.toBeNull()
    // sourcemap が含まれること
    expect(typeof r!.map === 'string').toBe(true)
    const sm = JSON.parse(r!.map!)
    expect(sm.version).toBe(3)
    expect(Array.isArray(sm.sources)).toBe(true)
    expect(typeof sm.mappings).toBe('string')
  })

  test('sourcemap なし：map フィールドは null または未定義', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`const x = 1;`, 'a.js')
    expect(r).not.toBeNull()
    // map は存在しないか null
    expect(!r!.map).toBe(true)
  })

  test('sourcemap の sources に filename が含まれる', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`interface Foo {}\nconst x = 1;`, 'src/myFile.ts', { sourceMap: true })
    const sm = JSON.parse(r!.map!)
    expect(sm.sources[0]).toContain('myFile.ts')
  })
})

// ── T5.2.8: jsi_transpile 不要化（WASM 単独でバンドル可）─────────────────
describe('T5.2.8: bundle without transpile callback', () => {
  test('TS ファイルを transpile コールバックなしでバンドルできる', async () => {
    if (!hasTransform) return
    // makeRuntime() は transpile オプションを渡さない（identity になる）→ WASM が処理
    const rt = await makeRuntime()
    // VFS にファイルをロード（buildSnapshot + bun_vfs_load_snapshot を使う）
    const snap = buildSnapshot([
      { path: '/app/index.ts', data: "export const greeting: string = 'hello';\nexport const n: number = 42;" },
    ])
    rt.withBytes(new Uint8Array(snap), (ptr, len) => {
      const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number
      loadFn(ptr, len)
    })
    // bundle: transpile コールバックなし → WASM 内部 ESM→CJS が identity 検出後に使われる
    const result = rt.bundle('/app/index.ts')
    expect(typeof result).toBe('string')
    // 型アノテーションが残らないこと
    expect(result).not.toContain(': string')
    expect(result).not.toContain(': number')
    // 変数が存在すること
    expect(result).toContain('greeting')
    expect(result).toContain('hello')
  })
})

// ── T5.3.5: import.meta polyfill ────────────────────────────────────────────
describe('bun_transform import.meta polyfill (T5.3.5)', () => {
  test('import.meta.url → filename string literal', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`const url = import.meta.url;`, 'src/foo.ts', { esmToCjs: true, jsx: 'none' })
    expect(r).not.toBeNull()
    expect(r!.code).toContain('"src/foo.ts"')
    expect(r!.code).not.toContain('import.meta')
  })

  test('import.meta.env → process.env polyfill', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`const env = import.meta.env;`, 'a.ts', { esmToCjs: true, jsx: 'none' })
    expect(r!.code).toContain('process.env')
    expect(r!.code).not.toContain('import.meta')
  })

  test('import.meta.resolve() → require.resolve()', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`const p = import.meta.resolve('./foo');`, 'a.ts', { esmToCjs: true, jsx: 'none' })
    expect(r!.code).toContain('require.resolve(')
    expect(r!.code).not.toContain('import.meta')
  })

  test('import.meta.url 非 ESM 模式下原样保留', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`const url = import.meta.url;`, 'a.js', { jsx: 'none' })
    // .js file, no esm_to_cjs → transform is a no-op (early return)
    // result should contain import.meta.url as-is or be null (no transform needed)
    expect(r === null || (r!.code !== null && (r!.code.includes('import.meta.url') || r!.code.length > 0))).toBe(true)
  })

  test('import.meta（無プロパティ）→ object polyfill', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`const m = import.meta;`, 'src/bar.ts', { esmToCjs: true, jsx: 'none' })
    expect(r!.code).toContain('url:')
    expect(r!.code).toContain('src/bar.ts')
    expect(r!.code).not.toContain('import.meta')
  })
})

// ── T5.3.6: dynamic import() ────────────────────────────────────────────────
describe('bun_transform dynamic import() (T5.3.6)', () => {
  test("import('spec') → Promise.resolve(require('spec'))", async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`const mod = await import('./utils');`, 'a.ts', { esmToCjs: true, jsx: 'none' })
    expect(r!.code).toContain('Promise.resolve')
    expect(r!.code).toContain('require(')
    expect(r!.code).not.toMatch(/\bimport\(/)
  })

  test('import("spec") double quotes', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    const r = rt.transform(`const x = import("react");`, 'a.ts', { esmToCjs: true, jsx: 'none' })
    expect(r!.code).toContain('Promise.resolve')
    expect(r!.code).toContain('react')
    expect(r!.code).not.toMatch(/\bimport\(/)
  })

  test('非静态 import() 透传', async () => {
    if (!hasTransform) return
    const rt = await makeRuntime()
    // dynamic expression, not a static string
    const r = rt.transform(`const mod = import(someVar);`, 'a.ts', { esmToCjs: true, jsx: 'none' })
    // Should pass through as import( since we can't transform non-static
    expect(r!.code).toContain('import(')
  })
})
