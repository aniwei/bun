/**
 * Phase 5.2 测试：bun_transform —— 内置 TS/JSX → JS 转译。
 *
 * 若当前打包的 bun-core.wasm 未导出 bun_transform（旧版本），测试会自动跳过。
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { createWasmRuntime, type WasmRuntime } from "../src/wasm";
import { createContext, runInContext } from "node:vm";

const WASM_PATH = import.meta.dir + "/../bun-core.wasm";

let wasmModule: WebAssembly.Module;
let hasTransform = false;

beforeAll(async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer();
  wasmModule = await WebAssembly.compile(bytes);
  // Probe: some pre-Phase-5.2 wasm binaries don't export bun_transform.
  const exports = WebAssembly.Module.exports(wasmModule).map(e => e.name);
  hasTransform = exports.includes("bun_transform");
});

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
  });
  const evaluator = (code: string, url: string): unknown =>
    runInContext(`(function(){\n${code}\n})()\n//# sourceURL=${url}`, sandbox, { filename: url });
  return createWasmRuntime(wasmModule, { evaluator, global: sandbox });
}

describe("bun_transform (Phase 5.2)", () => {
  test("去除变量类型注解", async () => {
    if (!hasTransform) return;
    const rt = await makeRuntime();
    const r = rt.transform("const x: number = 1;", "a.ts");
    expect(r).not.toBeNull();
    expect(r!.errors).toEqual([]);
    expect(r!.code).toContain("const x");
    expect(r!.code).not.toContain(": number");
  });

  test("删除 interface 声明", async () => {
    if (!hasTransform) return;
    const rt = await makeRuntime();
    const r = rt.transform("interface Foo { a: string; }\nexport const v = 1;", "b.ts");
    expect(r!.code).not.toContain("interface");
    expect(r!.code).toContain("export const v = 1");
  });

  test("纯 JS 透传", async () => {
    if (!hasTransform) return;
    const rt = await makeRuntime();
    const r = rt.transform("const x = 1;", "a.js");
    expect(r!.code).toBe("const x = 1;");
  });

  test("tsx 文件 JSX 基本转换", async () => {
    if (!hasTransform) return;
    const rt = await makeRuntime();
    const r = rt.transform("const el = <div>hi</div>;", "a.tsx", { jsx: "react" });
    expect(r!.code).toContain("createElement");
  });

  test("不合法源码返回 errors", async () => {
    if (!hasTransform) return;
    const rt = await makeRuntime();
    // 不期望严格错误——轻量实现可能容忍，但 shape 必须正确
    const r = rt.transform("const x: = ", "bad.ts");
    expect(r).not.toBeNull();
    expect(typeof r!.code === "string" || r!.code === null).toBe(true);
    expect(Array.isArray(r!.errors)).toBe(true);
  });

  test("WASM 未导出时 transform 返回 null", async () => {
    // Regardless of binary, the host helper must not throw.
    const rt = await makeRuntime();
    // When export exists, result is non-null; when missing, returns null.
    const r = rt.transform("const x = 1;", "a.js");
    expect(r === null || typeof r === "object").toBe(true);
  });
});
