/**
 * Node.js host adapter — 使用 `vm.Context` 作为 JSI backend 运行 bun-core.wasm。
 *
 * 与浏览器环境的区别：
 *   - `jsi_eval` 走 `vm.runInContext`，用户代码在独立沙盒里执行，不污染 Node global。
 *   - 沙盒 context 被传给 JsiHost 作为 `global` handle，`globalThis` 在 WASM 侧看见的就是沙盒。
 *   - 沙盒默认继承：console / fetch / queueMicrotask / setTimeout / clearTimeout / URL / TextEncoder / TextDecoder。
 */

import { createContext, runInContext } from 'node:vm'
import { createWasmRuntime, type WasmRuntime, type WasmRuntimeOptions } from './wasm'

export interface NodeHostOptions extends WasmRuntimeOptions {
  /** 额外注入到沙盒 context 的全局属性。 */
  extraGlobals?: Record<string, unknown>
}

/**
 * 在 Node.js 下用 `vm.Context` 作为 JSI backend 实例化 WASM。
 *
 * @returns `{ runtime, sandbox }` — sandbox 是底层 vm context 对象（用于测试断言）
 */
export async function createNodeRuntime(
  module: WebAssembly.Module,
  opts: NodeHostOptions = {},
): Promise<{ runtime: WasmRuntime; sandbox: object }> {
  const { extraGlobals, ...rest } = opts

  // 组装沙盒 globals。
  const baseGlobals: Record<string, unknown> = {
    console,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    JSON,
    Math,
    Date,
    // fetch 在 Node 18+ 是全局；动态读取避免在旧 Node 下硬报错
    ...((globalThis as { fetch?: unknown }).fetch !== undefined
      ? { fetch: (globalThis as { fetch: unknown }).fetch }
      : {}),
  }
  const sandbox = createContext({ ...baseGlobals, ...(extraGlobals ?? {}) })

  // 用 vm.runInContext 作为 evaluator，代码包成 IIFE（允许顶层 return）。
  const evaluator = (code: string, url: string): unknown => {
    const wrapped = `(function(){\n${code}\n})()\n//# sourceURL=${url}`
    return runInContext(wrapped, sandbox, { filename: url })
  }

  const runtime = await createWasmRuntime(module, { ...rest, evaluator, global: sandbox })

  return { runtime, sandbox }
}
