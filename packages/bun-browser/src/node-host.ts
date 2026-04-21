/**
 * Node.js host adapter — 使用 `vm.Context` 作为 JSI backend 运行同一份 bun-core.wasm。
 *
 * 对齐 RFC Phase 2 验收：
 *   > "同一 wasm 文件在 Node.js 宿主下也能运行（使用 vm.Context 作为 JSI 后端）"
 *
 * 与浏览器/Worker 环境的区别：
 *   - `jsi_eval` 走 `vm.runInContext`，用户代码执行在独立沙盒里，不污染 Node global
 *   - 沙盒 context 被传给 JsiHost 作为 `global` handle（保留 handle 4），因此 `globalThis`
 *     在 WASM 侧看见的就是沙盒，`typeof fetch`、`setTimeout` 等全部来自该沙盒
 *   - 沙盒默认继承：console / fetch / queueMicrotask / setTimeout / clearTimeout / URL
 *     / TextEncoder / TextDecoder；调用方可通过 `extraGlobals` 注入更多
 */

import { createContext, runInContext } from "node:vm";
import { createWasmRuntime, type WasmRuntime, type WasmRuntimeOptions } from "./wasm";

export interface NodeHostOptions extends WasmRuntimeOptions {
  /** 额外注入到沙盒 context 的全局属性。 */
  extraGlobals?: Record<string, unknown>;
}

/**
 * 在 Node.js 下用 `vm.Context` 作为 JSI backend 实例化 WASM。
 *
 * @param module  已编译的 WebAssembly.Module
 * @param opts    同 {@link WasmRuntimeOptions}，额外支持 `extraGlobals`
 * @returns `{ runtime, sandbox }` — sandbox 是底层的 vm context 对象（用于测试断言）
 */
export async function createNodeRuntime(
  module: WebAssembly.Module,
  opts: NodeHostOptions = {},
): Promise<{ runtime: WasmRuntime; sandbox: object }> {
  const { extraGlobals, ...rest } = opts;

  // 组装沙盒 globals。基础集合选择"浏览器运行时常见 + 纯函数可跨 context 安全共享"的部分。
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
  };
  const sandbox = createContext({ ...baseGlobals, ...(extraGlobals ?? {}) });

  // 用 vm.runInContext 作为 evaluator：用户代码执行在沙盒里，stack frame 保留 sourceURL 归属。
  // 注意：Zig 侧 (`jsi_eval`) 按 "new Function(code)()" 语义编码——允许顶层 `return` 用于回传值。
  // 所以这里必须把 code 包成 IIFE，避免 vm 的脚本级 eval 拒绝顶层 return。
  const evaluator = (code: string, url: string): unknown => {
    const wrapped = `(function(){\n${code}\n})()\n//# sourceURL=${url}`;
    return runInContext(wrapped, sandbox, { filename: url });
  };

  const runtime = await createWasmRuntime(module, { ...rest, evaluator, global: sandbox });

  return { runtime, sandbox };
}
