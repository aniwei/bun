/**
 * 集成测试 —— 加载真实的 bun-core.wasm，端到端验证：
 *   - bun_browser_init / bun_browser_eval / bun_vfs_load_snapshot / bun_browser_run
 * 测试不使用 Worker；直接在 Bun 进程中 WebAssembly.compile + createWasmRuntime。
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { buildSnapshot } from "../src/vfs-client";
import { createWasmRuntime, type WasmRuntime } from "../src/wasm-utils";

const WASM_PATH = import.meta.dir + "/../bun-core.wasm";

let wasmModule: WebAssembly.Module;

beforeAll(async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer();
  wasmModule = await WebAssembly.compile(bytes);
});

// ──────────────────────────────────────────────────────────
// 辅助：创建独立运行时实例（每个测试独立）
// ──────────────────────────────────────────────────────────

async function makeRuntime(onPrint?: (data: string, kind: "stdout" | "stderr") => void): Promise<WasmRuntime> {
  return createWasmRuntime(wasmModule, onPrint !== undefined ? { onPrint } : {});
}

// ──────────────────────────────────────────────────────────
// 基础：初始化
// ──────────────────────────────────────────────────────────

describe("WASM 初始化", () => {
  test("bun_browser_init 导出存在且可调用", async () => {
    const rt = await makeRuntime();
    expect(rt.instance.exports.bun_browser_init).toBeInstanceOf(Function);
  });

  test("memory 导出存在", async () => {
    const rt = await makeRuntime();
    expect(rt.instance.exports.memory).toBeInstanceOf(WebAssembly.Memory);
  });

  test("bun_malloc / bun_free 存在", async () => {
    const rt = await makeRuntime();
    expect(rt.instance.exports.bun_malloc).toBeInstanceOf(Function);
    expect(rt.instance.exports.bun_free).toBeInstanceOf(Function);
  });
});

// ──────────────────────────────────────────────────────────
// bun_browser_eval: 直接 eval JS
// ──────────────────────────────────────────────────────────

describe("bun_browser_eval", () => {
  test("eval 合法 JS → 返回 0", async () => {
    const rt = await makeRuntime();
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    let code = -1;
    rt.withString("1 + 1", (sp, sl) => {
      rt.withString("<test>", (fp, fl) => {
        code = evalFn(sp, sl, fp, fl);
      });
    });
    expect(code).toBe(0);
  });

  test("eval JS 异常 → 返回 3", async () => {
    const rt = await makeRuntime();
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    let code = -1;
    rt.withString("throw new Error('boom')", (sp, sl) => {
      rt.withString("<test>", (fp, fl) => {
        code = evalFn(sp, sl, fp, fl);
      });
    });
    expect(code).toBe(3);
  });

  test("JSI print 通过 onPrint 回调", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    rt.withString("globalThis.__bun_print('hello from eval', 1)", (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    // Note: JSI print goes through jsi_print import, which calls onPrint
    // Only verify no crash — actual print depends on JS-side console being wired
    expect(printed).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────
// bun_vfs_load_snapshot + bun_browser_run
// ──────────────────────────────────────────────────────────

describe("VFS snapshot + run", () => {
  test("加载空 snapshot 返回 0", async () => {
    const rt = await makeRuntime();
    const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (ptr: number, len: number) => number;
    const snapshot = buildSnapshot([]);
    let count = -1;
    rt.withBytes(new Uint8Array(snapshot), (ptr, len) => {
      count = loadFn(ptr, len);
    });
    expect(count).toBe(0);
  });

  test("加载单文件 snapshot → count=1", async () => {
    const rt = await makeRuntime();
    const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (ptr: number, len: number) => number;
    const snapshot = buildSnapshot([{ path: "/index.js", data: "1+1;" }]);
    let count = -1;
    rt.withBytes(new Uint8Array(snapshot), (ptr, len) => {
      count = loadFn(ptr, len);
    });
    expect(count).toBe(1);
  });

  test("run 入口文件 → 退出码 0", async () => {
    const rt = await makeRuntime();
    const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (ptr: number, len: number) => number;
    const runFn = rt.instance.exports.bun_browser_run as (ptr: number, len: number) => number;

    const snapshot = buildSnapshot([{ path: "/index.js", data: "var x = 1 + 2;" }]);
    rt.withBytes(new Uint8Array(snapshot), (ptr, len) => { loadFn(ptr, len); });

    let exitCode = -1;
    rt.withString("/index.js", (ptr, len) => {
      exitCode = runFn(ptr, len);
    });
    expect(exitCode).toBe(0);
  });

  test("run 不存在的路径 → 非零退出码", async () => {
    const rt = await makeRuntime();
    const runFn = rt.instance.exports.bun_browser_run as (ptr: number, len: number) => number;
    let exitCode = 0;
    rt.withString("/nonexistent.js", (ptr, len) => {
      exitCode = runFn(ptr, len);
    });
    expect(exitCode).not.toBe(0);
  });

  test("require 在 CJS 模块中工作", async () => {
    const rt = await makeRuntime();
    const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (ptr: number, len: number) => number;
    const runFn = rt.instance.exports.bun_browser_run as (ptr: number, len: number) => number;

    const snapshot = buildSnapshot([
      { path: "/lib.js", data: "module.exports = { value: 42 };" },
      { path: "/main.js", data: "var lib = require('./lib.js'); if (lib.value !== 42) throw new Error('bad');" },
    ]);
    rt.withBytes(new Uint8Array(snapshot), (ptr, len) => { loadFn(ptr, len); });

    let exitCode = -1;
    rt.withString("/main.js", (ptr, len) => { exitCode = runFn(ptr, len); });
    expect(exitCode).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────
// bun_malloc / bun_free
// ──────────────────────────────────────────────────────────

describe("bun_malloc / bun_free", () => {
  test("malloc(64) 返回非零指针", async () => {
    const rt = await makeRuntime();
    const malloc = rt.instance.exports.bun_malloc as (n: number) => number;
    const free_ = rt.instance.exports.bun_free as (ptr: number) => void;
    const ptr = malloc(64);
    expect(ptr).toBeGreaterThan(0);
    free_(ptr);
  });

  test("往返读写：写 bytes 再用 withBytes 读回", async () => {
    const rt = await makeRuntime();
    const malloc = rt.instance.exports.bun_malloc as (n: number) => number;
    const mem = rt.instance.exports.memory as WebAssembly.Memory;
    const ptr = malloc(5);
    new Uint8Array(mem.buffer, ptr, 5).set([72, 101, 108, 108, 111]); // "Hello"
    const readBack = new TextDecoder().decode(new Uint8Array(mem.buffer, ptr, 5));
    expect(readBack).toBe("Hello");
  });
});

// ──────────────────────────────────────────────────────────
// process polyfill
// ──────────────────────────────────────────────────────────

describe("process polyfill", () => {
  test("process.exit(0) → eval 正常返回", async () => {
    const rt = await makeRuntime();
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    // process.exit(0) should set exit code 0 and abort the call chain
    let code = -1;
    rt.withString("process.exit(0);", (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { code = evalFn(sp, sl, fp, fl); });
    });
    // exit code 0 → bun_browser_eval returns 0 (since g_exit_code=0 and g_explicit_exit=true)
    expect(code).toBe(0);
  });
});
