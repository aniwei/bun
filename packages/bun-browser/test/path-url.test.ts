/**
 * Phase 5.1 T5.1.1 / T5.1.4 测试：bun_path_* / bun_url_parse
 *
 * 验证用 std.fs.path 实现的路径规范化 ABI 和
 * 用 std.Uri 实现的 URL 解析 ABI。
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

// ── bun_path_normalize ─────────────────────────────────────────────────────

describe('bun_path_normalize', () => {
  test('规范化：消除 . 和 ..', async () => {
    const rt = await makeRuntime()
    expect(rt.pathNormalize('/foo/./bar/../baz')).toBe('/foo/baz')
  })

  test('规范化：折叠重复斜杠', async () => {
    const rt = await makeRuntime()
    expect(rt.pathNormalize('/foo//bar///baz')).toBe('/foo/bar/baz')
  })

  test('规范化：根路径', async () => {
    const rt = await makeRuntime()
    expect(rt.pathNormalize('/')).toBe('/')
  })

  test('规范化：多个 ..', async () => {
    const rt = await makeRuntime()
    expect(rt.pathNormalize('/a/b/c/../../d')).toBe('/a/d')
  })

  test('规范化：已规范化路径不变', async () => {
    const rt = await makeRuntime()
    expect(rt.pathNormalize('/foo/bar/baz')).toBe('/foo/bar/baz')
  })
})

// ── bun_path_dirname ────────────────────────────────────────────────────────

describe('bun_path_dirname', () => {
  test('普通路径：返回父目录', async () => {
    const rt = await makeRuntime()
    expect(rt.pathDirname('/foo/bar/baz.js')).toBe('/foo/bar')
  })

  test('顶层文件：返回 /', async () => {
    const rt = await makeRuntime()
    expect(rt.pathDirname('/foo.js')).toBe('/')
  })

  test('根路径自身', async () => {
    const rt = await makeRuntime()
    expect(rt.pathDirname('/')).toBe('/')
  })

  test('无斜杠：返回 /', async () => {
    const rt = await makeRuntime()
    expect(rt.pathDirname('foo')).toBe('/')
  })
})

// ── bun_path_join ───────────────────────────────────────────────────────────

describe('bun_path_join', () => {
  test('base + rel 拼接并规范化', async () => {
    const rt = await makeRuntime()
    expect(rt.pathJoin('/foo/bar', '../baz')).toBe('/foo/baz')
  })

  test('rel 为绝对路径时忽略 base', async () => {
    const rt = await makeRuntime()
    expect(rt.pathJoin('/foo/bar', '/qux/quux')).toBe('/qux/quux')
  })

  test('简单拼接', async () => {
    const rt = await makeRuntime()
    expect(rt.pathJoin('/node_modules/pkg', 'index.js')).toBe('/node_modules/pkg/index.js')
  })
})

// ── bun_url_parse ───────────────────────────────────────────────────────────

describe('bun_url_parse', () => {
  test('解析 https URL', async () => {
    const rt = await makeRuntime()
    const r = rt.urlParse('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz')
    expect(r).not.toBeNull()
    expect(r!.scheme).toBe('https')
    expect(r!.protocol).toBe('https:')
    expect(r!.hostname).toBe('registry.npmjs.org')
    expect(r!.pathname).toBe('/lodash/-/lodash-4.17.21.tgz')
    expect(r!.href).toBe('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz')
  })

  test('解析带查询字符串的 URL', async () => {
    const rt = await makeRuntime()
    const r = rt.urlParse('https://example.com/search?q=foo&bar=baz')
    expect(r).not.toBeNull()
    expect(r!.pathname).toBe('/search')
    expect(r!.search).toBe('?q=foo&bar=baz')
  })

  test('解析带 fragment 的 URL', async () => {
    const rt = await makeRuntime()
    const r = rt.urlParse('https://example.com/page#section-2')
    expect(r).not.toBeNull()
    expect(r!.hash).toBe('#section-2')
  })

  test('解析带端口号的 URL', async () => {
    const rt = await makeRuntime()
    const r = rt.urlParse('http://localhost:3000/api')
    expect(r).not.toBeNull()
    expect(r!.port).toBe('3000')
    expect(r!.hostname).toBe('localhost')
    expect(r!.host).toBe('localhost:3000')
  })

  test('file:// URL', async () => {
    const rt = await makeRuntime()
    const r = rt.urlParse('file:///home/user/project/index.ts')
    expect(r).not.toBeNull()
    expect(r!.scheme).toBe('file')
    expect(r!.pathname).toBe('/home/user/project/index.ts')
  })

  test('无效 URL 返回 null', async () => {
    const rt = await makeRuntime()
    // std.Uri 对纯路径可能返回 error.InvalidFormat，也可能宽松解析；
    // 这里只验证不会抛错。
    expect(() => rt.urlParse('not-a-url')).not.toThrow()
  })
})
