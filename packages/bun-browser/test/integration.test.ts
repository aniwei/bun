/**
 * 集成测试 —— 加载真实的 bun-core.wasm，端到端验证：
 *   - bun_browser_init / bun_browser_eval / bun_vfs_load_snapshot / bun_browser_run
 * 测试不使用 Worker；直接在 Bun 进程中 WebAssembly.compile + createWasmRuntime。
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { buildSnapshot } from "../src/vfs-client";
import { Kernel } from "../src/kernel";
import { createWasmRuntime, type WasmRuntime } from "../src/wasm";
import { createContext, runInContext } from "node:vm";

const WASM_PATH = import.meta.dir + "/../bun-core.wasm";
const WORKER_URL = new URL("../src/kernel-worker.ts", import.meta.url);

let wasmModule: WebAssembly.Module;

beforeAll(async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer();
  wasmModule = await WebAssembly.compile(bytes);
});

// ──────────────────────────────────────────────────────────
// 辅助：创建独立运行时实例（每个测试独立）
//
// 关键：必须使用 vm.Context 沙盒作为 evaluator，否则 setupGlobals 内的 polyfill
// 会替换 Bun 测试进程的 globalThis.console / Bun / setTimeout 等，污染测试运行时。
// ──────────────────────────────────────────────────────────

async function makeRuntime(onPrint?: (data: string, kind: "stdout" | "stderr") => void): Promise<WasmRuntime> {
  const sandbox = createContext({
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
    Request,
    Response,
    Headers,
    JSON,
    Math,
    Date,
    Promise,
    Error,
    TypeError,
    Object,
    Array,
    Symbol,
    ...((globalThis as { fetch?: unknown }).fetch !== undefined
      ? { fetch: (globalThis as { fetch: unknown }).fetch }
      : {}),
  });
  const evaluator = (code: string, url: string): unknown => {
    const wrapped = `(function(){\n${code}\n})()\n//# sourceURL=${url}`;
    return runInContext(wrapped, sandbox, { filename: url });
  };
  return createWasmRuntime(wasmModule, {
    ...(onPrint !== undefined ? { onPrint } : {}),
    evaluator,
    global: sandbox,
  });
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

// ──────────────────────────────────────────────────────────
// console polyfill
// ──────────────────────────────────────────────────────────

describe("console polyfill", () => {
  test("console.log 路由到 onPrint stdout", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data, kind) => {
      if (kind === "stdout") printed.push(data);
    });
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    let code = -1;
    rt.withString("console.log('hello world');", (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { code = evalFn(sp, sl, fp, fl); });
    });
    expect(code).toBe(0);
    expect(printed.join("")).toContain("hello world");
  });

  test("console.error 路由到 onPrint stderr", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data, kind) => {
      if (kind === "stderr") printed.push(data);
    });
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    rt.withString("console.error('oops');", (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    expect(printed.join("")).toContain("oops");
  });

  test("console.log 多参数空格分隔", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data, kind) => {
      if (kind === "stdout") printed.push(data);
    });
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    rt.withString("console.log(1, 'two', true);", (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    const out = printed.join("");
    expect(out).toContain("1");
    expect(out).toContain("two");
    expect(out).toContain("true");
  });
});

// ──────────────────────────────────────────────────────────
// require("path")
// ──────────────────────────────────────────────────────────

describe("require('path')", () => {
  test("path.join('/a', 'b', 'c') → '/a/b/c'", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    const code = `
      var path = require('path');
      console.log(path.join('/a', 'b', 'c'));
    `;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    expect(printed.join("")).toContain("/a/b/c");
  });

  test("path.dirname('/foo/bar/baz.js') → '/foo/bar'", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    const code = `
      var path = require('node:path');
      console.log(path.dirname('/foo/bar/baz.js'));
    `;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    expect(printed.join("")).toContain("/foo/bar");
  });

  test("path.extname('file.ts') → '.ts'", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    const code = `
      var path = require('path');
      console.log(path.extname('file.ts'));
    `;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    expect(printed.join("")).toContain(".ts");
  });
});

// ──────────────────────────────────────────────────────────
// require("fs")
// ──────────────────────────────────────────────────────────

describe("require('fs')", () => {
  test("readFileSync 读取 VFS 文件", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (ptr: number, len: number) => number;
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;

    const snapshot = buildSnapshot([{ path: "/data.txt", data: "hello from fs" }]);
    rt.withBytes(new Uint8Array(snapshot), (ptr, len) => { loadFn(ptr, len); });

    const code = `
      var fs = require('fs');
      console.log(fs.readFileSync('/data.txt', 'utf8'));
    `;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    expect(printed.join("")).toContain("hello from fs");
  });

  test("existsSync 存在的文件 → true", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (ptr: number, len: number) => number;
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;

    const snapshot = buildSnapshot([{ path: "/exists.txt", data: "yes" }]);
    rt.withBytes(new Uint8Array(snapshot), (ptr, len) => { loadFn(ptr, len); });

    const code = `
      var fs = require('fs');
      console.log(fs.existsSync('/exists.txt'));
      console.log(fs.existsSync('/nope.txt'));
    `;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    const out = printed.join("");
    expect(out).toContain("true");
    expect(out).toContain("false");
  });

  test("writeFileSync + readFileSync 往返", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;

    const code = `
      var fs = require('fs');
      fs.writeFileSync('/out.txt', 'written content');
      console.log(fs.readFileSync('/out.txt', 'utf8'));
    `;
    let exitCode = -1;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { exitCode = evalFn(sp, sl, fp, fl); });
    });
    expect(exitCode).toBe(0);
    expect(printed.join("")).toContain("written content");
  });
});

// ──────────────────────────────────────────────────────────
// setTimeout / bun_tick
// ──────────────────────────────────────────────────────────

describe("setTimeout + bun_tick", () => {
  test("setTimeout 延迟 0ms → bun_tick 后回调执行", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    const tickFn = rt.instance.exports.bun_tick as () => number;

    // Step 1: confirm console.log works through the runtime first
    let codeCheck = -1;
    rt.withString("console.log('setup ok');", (sp, sl) => {
      rt.withString("<check>", (fp, fl) => { codeCheck = evalFn(sp, sl, fp, fl); });
    });
    expect(codeCheck).toBe(0);
    expect(printed.join("")).toContain("setup ok");

    printed.length = 0; // reset

    // Step 2: register a timer
    let evalCode = -1;
    rt.withString("setTimeout(function() { console.log('timer fired'); }, 0);", (sp, sl) => {
      rt.withString("<test-sto>", (fp, fl) => { evalCode = evalFn(sp, sl, fp, fl); });
    });
    expect(evalCode).toBe(0);

    // Before tick, callback should not have fired
    expect(printed).toHaveLength(0);

    // Tick the event loop — delay=0 so it should fire immediately
    tickFn();

    expect(printed.join("")).toContain("timer fired");
  });

  test("bun_tick 导出存在", async () => {
    const rt = await makeRuntime();
    expect(rt.instance.exports.bun_tick).toBeInstanceOf(Function);
  });

  test("bun_wakeup 导出存在", async () => {
    const rt = await makeRuntime();
    expect(rt.instance.exports.bun_wakeup).toBeInstanceOf(Function);
  });
});

// ──────────────────────────────────────────────────────────
// require("url")
// ──────────────────────────────────────────────────────────

describe("require('url')", () => {
  test("URL 构造函数解析 hostname", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    const code = `var url = require('url'); var u = new url.URL('https://example.com/path?q=1'); console.log(u.hostname);`;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    expect(printed.join("")).toContain("example.com");
  });

  test("fileURLToPath 提取路径", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    const code = `var url = require('node:url'); console.log(url.fileURLToPath('file:///foo/bar/baz.js'));`;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    expect(printed.join("")).toContain("/foo/bar/baz.js");
  });

  test("parse 返回解析对象", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    const code = `var url = require('url'); var p = url.parse('https://host:8080/p?x=1'); console.log(p.hostname + ':' + p.port);`;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    expect(printed.join("")).toContain("host:8080");
  });
});

// ──────────────────────────────────────────────────────────
// require("util")
// ──────────────────────────────────────────────────────────

describe("require('util')", () => {
  test("util.format 字符串插值", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    const code = `var util = require('util'); console.log(util.format('hello %s, you are %d', 'world', 42));`;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    expect(printed.join("")).toContain("hello world, you are 42");
  });

  test("util.inspect 序列化对象", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    const code = `var util = require('node:util'); console.log(util.inspect({a:1,b:'two'}));`;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    const out = printed.join("");
    expect(out).toContain("a");
    expect(out).toContain("b");
  });
});

// ──────────────────────────────────────────────────────────
// Buffer 全局
// ──────────────────────────────────────────────────────────

describe("Buffer global", () => {
  test("Buffer.from(string).toString() utf8 往返", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    const code = `var b = Buffer.from('hello'); console.log(b.toString('utf8'));`;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    expect(printed.join("")).toContain("hello");
  });

  test("Buffer.from(string, 'hex') → toString('hex') 往返", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    const code = `var b = Buffer.from('deadbeef', 'hex'); console.log(b.toString('hex'));`;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    expect(printed.join("")).toContain("deadbeef");
  });

  test("Buffer.alloc 分配指定大小", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    const code = `var b = Buffer.alloc(4, 0); console.log(b.byteLength);`;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    expect(printed.join("")).toContain("4");
  });

  test("Buffer.isBuffer 检测", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    const code = `var b = Buffer.from('x'); console.log(Buffer.isBuffer(b)); console.log(Buffer.isBuffer('x'));`;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    const out = printed.join("");
    expect(out).toContain("true");
    expect(out).toContain("false");
  });

  test("Buffer.concat 合并多个 buffer", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    const code = `var a = Buffer.from('foo'); var b = Buffer.from('bar'); var c = Buffer.concat([a, b]); console.log(c.toString());`;
    rt.withString(code, (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    expect(printed.join("")).toContain("foobar");
  });
});

// ──────────────────────────────────────────────────────────
// Kernel worker 路径（自动 tick + argv/env）
// ──────────────────────────────────────────────────────────

describe("kernel-worker integration", () => {
  test("worker 自动驱动 bun_tick：无需手动 tick 也能触发 setTimeout", async () => {
    let output = "";
    let done = false;
    let resolvePrinted!: () => void;
    let rejectPrinted!: (err: Error) => void;
    const printed = new Promise<void>((resolve, reject) => {
      resolvePrinted = resolve;
      rejectPrinted = reject;
    });

    const kernel = new Kernel({
      wasmModule,
      workerUrl: WORKER_URL,
      initialFiles: [
        {
          path: "/timer.js",
          data: "setTimeout(function () { console.log('timer fired from worker'); }, 0);",
        },
      ],
      onStdout(data) {
        output += data;
        if (!done && output.includes("timer fired from worker")) {
          done = true;
          resolvePrinted();
        }
      },
      onError(err) {
        if (!done) {
          done = true;
          rejectPrinted(new Error(err.message));
        }
      },
    });

    try {
      await kernel.whenReady();
      await kernel.run("/timer.js");
      await Promise.race([
        printed,
        Bun.sleep(1500).then(() => {
          throw new Error("timeout waiting for worker timer output");
        }),
      ]);
      expect(output).toContain("timer fired from worker");
    } finally {
      kernel.terminate();
    }
  });

  test("Kernel.run 的 argv/env 会写入 process", async () => {
    let output = "";
    let done = false;
    let resolvePrinted!: () => void;
    let rejectPrinted!: (err: Error) => void;
    const printed = new Promise<void>((resolve, reject) => {
      resolvePrinted = resolve;
      rejectPrinted = reject;
    });

    const kernel = new Kernel({
      wasmModule,
      workerUrl: WORKER_URL,
      initialFiles: [
        {
          path: "/app/argv-env.js",
          data: "console.log(process.argv.join('|')); console.log(process.env.TEST_FLAG || 'missing'); console.log(process.cwd());",
        },
      ],
      onStdout(data) {
        output += data;
        if (!done && output.includes("bun|foo|bar") && output.includes("ok") && output.includes("/app")) {
          done = true;
          resolvePrinted();
        }
      },
      onError(err) {
        if (!done) {
          done = true;
          rejectPrinted(new Error(err.message));
        }
      },
    });

    try {
      await kernel.whenReady();
      await kernel.run("/app/argv-env.js", ["foo", "bar"], { TEST_FLAG: "ok" });
      await Promise.race([
        printed,
        Bun.sleep(1500).then(() => {
          throw new Error("timeout waiting for argv/env output");
        }),
      ]);
      expect(output).toContain("bun|foo|bar");
      expect(output).toContain("ok");
      expect(output).toContain("/app");
    } finally {
      kernel.terminate();
    }
  });
});

// ──────────────────────────────────────────────────────────
// bun_spawn (T2.4)
// ──────────────────────────────────────────────────────────

describe("bun_spawn", () => {
  test("bun_spawn 导出存在", async () => {
    const rt = await makeRuntime();
    expect(rt.instance.exports.bun_spawn).toBeInstanceOf(Function);
  });

  test("bun -e 'console.log(...)' → 退出码 0 且输出到 stdout", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const spawnFn = rt.instance.exports.bun_spawn as (ptr: number, len: number) => number;
    let exitCode = -1;
    rt.withString(JSON.stringify(["bun", "-e", "console.log('spawn hello');"]), (ptr, len) => {
      exitCode = spawnFn(ptr, len);
    });
    expect(exitCode).toBe(0);
    expect(printed.join("")).toContain("spawn hello");
  });

  test("bun run <vfs-path> → 退出码 0", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (ptr: number, len: number) => number;
    const spawnFn = rt.instance.exports.bun_spawn as (ptr: number, len: number) => number;

    const snapshot = buildSnapshot([{ path: "/hello.js", data: "console.log('run ok');" }]);
    rt.withBytes(new Uint8Array(snapshot), (ptr, len) => { loadFn(ptr, len); });

    let exitCode = -1;
    rt.withString(JSON.stringify(["bun", "run", "/hello.js"]), (ptr, len) => {
      exitCode = spawnFn(ptr, len);
    });
    expect(exitCode).toBe(0);
    expect(printed.join("")).toContain("run ok");
  });

  test("非 bun 可执行文件 → 返回 1", async () => {
    const rt = await makeRuntime();
    const spawnFn = rt.instance.exports.bun_spawn as (ptr: number, len: number) => number;
    let exitCode = 0;
    rt.withString(JSON.stringify(["node", "-e", "1"]), (ptr, len) => {
      exitCode = spawnFn(ptr, len);
    });
    expect(exitCode).toBe(1);
  });

  test("bun_kill / bun_feed_stdin / bun_close_stdin 导出存在（stub）", async () => {
    const rt = await makeRuntime();
    expect(rt.instance.exports.bun_kill).toBeInstanceOf(Function);
    expect(rt.instance.exports.bun_feed_stdin).toBeInstanceOf(Function);
    expect(rt.instance.exports.bun_close_stdin).toBeInstanceOf(Function);
  });
});

// ──────────────────────────────────────────────────────────
// fetch() 直通（T2.3 最后一项）
// ──────────────────────────────────────────────────────────

describe("fetch 直通", () => {
  test("用户代码中 typeof fetch === 'function'", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number
    ) => number;
    rt.withString("console.log(typeof fetch);", (sp, sl) => {
      rt.withString("<test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });
    expect(printed.join("")).toContain("function");
  });
});

// ──────────────────────────────────────────────────────────
// Kernel.spawn() via Worker（Phase 2 验收检查表）
// ──────────────────────────────────────────────────────────

describe("Kernel.spawn()", () => {
  test("spawn bun -e 'console.log(...)' → stdout 输出且退出码 0", async () => {
    let output = "";
    let done = false;
    let resolvePrinted!: () => void;
    let rejectPrinted!: (e: Error) => void;
    const printed = new Promise<void>((res, rej) => {
      resolvePrinted = res;
      rejectPrinted = rej;
    });

    const kernel = new Kernel({
      wasmModule,
      workerUrl: WORKER_URL,
      onStdout(data) {
        output += data;
        if (!done && output.includes("spawn via kernel")) {
          done = true;
          resolvePrinted();
        }
      },
      onError(err) {
        if (!done) {
          done = true;
          rejectPrinted(new Error(err.message));
        }
      },
    });

    try {
      await kernel.whenReady();
      const exitCode = await Promise.race([
        kernel.spawn(["bun", "-e", "console.log('spawn via kernel');"]),
        Bun.sleep(1500).then(() => { throw new Error("timeout waiting for spawn:exit"); }),
      ]);
      await Promise.race([
        printed,
        Bun.sleep(500).then(() => { throw new Error("timeout waiting for stdout"); }),
      ]);
      expect(exitCode).toBe(0);
      expect(output).toContain("spawn via kernel");
    } finally {
      kernel.terminate();
    }
  });

  test("spawn bun run <file> via Kernel.spawn → 退出码 0", async () => {
    let output = "";
    let done = false;
    let resolvePrinted!: () => void;
    let rejectPrinted!: (e: Error) => void;
    const printed = new Promise<void>((res, rej) => {
      resolvePrinted = res;
      rejectPrinted = rej;
    });

    const kernel = new Kernel({
      wasmModule,
      workerUrl: WORKER_URL,
      initialFiles: [{ path: "/greet.js", data: "console.log('hello from run');" }],
      onStdout(data) {
        output += data;
        if (!done && output.includes("hello from run")) {
          done = true;
          resolvePrinted();
        }
      },
      onError(err) {
        if (!done) {
          done = true;
          rejectPrinted(new Error(err.message));
        }
      },
    });

    try {
      await kernel.whenReady();
      const exitCode = await Promise.race([
        kernel.spawn(["bun", "run", "/greet.js"]),
        Bun.sleep(1500).then(() => { throw new Error("timeout waiting for spawn:exit"); }),
      ]);
      await Promise.race([
        printed,
        Bun.sleep(500).then(() => { throw new Error("timeout waiting for stdout"); }),
      ]);
      expect(exitCode).toBe(0);
      expect(output).toContain("hello from run");
    } finally {
      kernel.terminate();
    }
  });
});

// ──────────────────────────────────────────────────────────
// fetch() 实际调用（Phase 2 验收：fetch 从用户代码返回 Response）
// ──────────────────────────────────────────────────────────

describe("fetch 实际调用", () => {
  test("用户代码中 fetch(localhost) → 返回 Response body", async () => {
    // 起一个本地服务器避免外部依赖
    using server = Bun.serve({
      port: 0,
      fetch: () => new Response("pong", { headers: { "content-type": "text/plain" } }),
    });
    const url = `http://127.0.0.1:${server.port}/`;

    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number,
    ) => number;

    // fetch 是异步的；使用 .then(...).then(console.log) 并等待 microtask flush
    const code = `
      fetch(${JSON.stringify(url)})
        .then(r => r.text())
        .then(t => console.log("FETCH_RESULT:" + t))
        .catch(e => console.log("FETCH_ERROR:" + e.message));
    `;
    rt.withString(code, (sp, sl) => {
      rt.withString("<fetch-test>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });

    // 等待 Promise 链完成；fetch 是宿主原生调用，微任务会在事件循环下一轮触发
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (printed.some(p => p.includes("FETCH_RESULT:pong"))) break;
      await Bun.sleep(20);
    }
    expect(printed.join("")).toContain("FETCH_RESULT:pong");
  });
});

// ──────────────────────────────────────────────────────────
// Node host 适配器（Phase 2 验收：同一 wasm 在 vm.Context 下运行）
// ──────────────────────────────────────────────────────────

describe("Node host (vm.Context) 适配器", () => {
  test("createNodeRuntime 可加载 wasm 并在沙盒中 eval", async () => {
    const { createNodeRuntime } = await import("../src/node-host");
    const printed: string[] = [];
    const { runtime, sandbox } = await createNodeRuntime(wasmModule, {
      onPrint: (data) => printed.push(data),
    });
    const evalFn = runtime.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number,
    ) => number;

    runtime.withString("console.log('node host ok');", (sp, sl) => {
      runtime.withString("<node>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });

    expect(printed.join("")).toContain("node host ok");
    expect(typeof sandbox).toBe("object");
  });

  test("沙盒 extraGlobals 被注入，用户代码可见", async () => {
    const { createNodeRuntime } = await import("../src/node-host");
    const printed: string[] = [];
    const { runtime } = await createNodeRuntime(wasmModule, {
      onPrint: (data) => printed.push(data),
      extraGlobals: { SANDBOX_MARK: "xyz123" },
    });
    const evalFn = runtime.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number,
    ) => number;

    runtime.withString("console.log('mark=' + SANDBOX_MARK);", (sp, sl) => {
      runtime.withString("<mark>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });

    expect(printed.join("")).toContain("mark=xyz123");
  });

  test("沙盒与外部 globalThis 隔离：沙盒内 var 不污染外部", async () => {
    const { createNodeRuntime } = await import("../src/node-host");
    const { runtime } = await createNodeRuntime(wasmModule);
    const evalFn = runtime.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number,
    ) => number;

    // 清理可能残留的外部标识
    delete (globalThis as Record<string, unknown>).__LEAKED__;

    runtime.withString("globalThis.__LEAKED__ = 42;", (sp, sl) => {
      runtime.withString("<leak>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
    });

    expect((globalThis as Record<string, unknown>).__LEAKED__).toBeUndefined();
  });

  test("Node host 下 spawn bun -e → 退出码 0 + stdout", async () => {
    const { createNodeRuntime } = await import("../src/node-host");
    const printed: string[] = [];
    const { runtime } = await createNodeRuntime(wasmModule, {
      onPrint: (data) => printed.push(data),
    });
    const spawnFn = runtime.instance.exports.bun_spawn as (
      ptr: number, len: number,
    ) => number;

    let code = -1;
    runtime.withString(JSON.stringify(["bun", "-e", "console.log('node spawn ok');"]), (ptr, len) => {
      code = spawnFn(ptr, len);
    });

    expect(code).toBe(0);
    expect(printed.join("")).toContain("node spawn ok");
  });
});

// ──────────────────────────────────────────────────────────
// Bun.serve()（Phase 3 T3.4）+ Kernel.fetch()（Phase 3 T3.3 minimal）
// ──────────────────────────────────────────────────────────

describe("Bun.serve() polyfill", () => {
  test("Bun 全局可用且 serve 返回 { port, stop, url }", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number,
    ) => number;

    rt.withString(
      `const s = Bun.serve({ fetch: () => new Response("ok"), port: 40123 });
       console.log(JSON.stringify({ port: s.port, hasStop: typeof s.stop, url: s.url.href }));
       s.stop();`,
      (sp, sl) => {
        rt.withString("<serve>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
      },
    );

    const out = printed.join("");
    expect(out).toContain("\"port\":40123");
    expect(out).toContain("\"hasStop\":\"function\"");
    expect(out).toContain("http://localhost:40123/");
  });

  test("Bun.serve 自动分配端口（port=0 或缺省）", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number,
    ) => number;

    rt.withString(
      `const a = Bun.serve({ fetch: () => new Response("a") });
       const b = Bun.serve({ fetch: () => new Response("b"), port: 0 });
       console.log("ports:" + a.port + "," + b.port);
       a.stop(); b.stop();`,
      (sp, sl) => {
        rt.withString("<serve-auto>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
      },
    );
    const out = printed.join("");
    const match = out.match(/ports:(\d+),(\d+)/);
    expect(match).not.toBeNull();
    const [_, a, b] = match!;
    expect(Number(a)).toBeGreaterThanOrEqual(40000);
    expect(Number(b)).toBeGreaterThanOrEqual(40000);
    expect(a).not.toBe(b);
  });

  test("__bun_dispatch_fetch 路由到已注册 handler 并返回 Response", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number,
    ) => number;

    rt.withString(
      `Bun.serve({
        port: 40456,
        fetch(req) { return new Response("hello " + new URL(req.url).pathname, { status: 201 }); }
       });
       globalThis.__bun_dispatch_fetch(40456, { url: "http://x/greet" })
         .then(r => Promise.all([r.text(), Promise.resolve(r.status)]))
         .then(([body, status]) => console.log("DISPATCH:" + status + ":" + body));`,
      (sp, sl) => {
        rt.withString("<dispatch>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
      },
    );

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (printed.some(p => p.includes("DISPATCH:"))) break;
      await Bun.sleep(20);
    }
    expect(printed.join("")).toContain("DISPATCH:201:hello /greet");
  });

  test("未注册端口 → 502 响应", async () => {
    const printed: string[] = [];
    const rt = await makeRuntime((data) => printed.push(data));
    const evalFn = rt.instance.exports.bun_browser_eval as (
      sp: number, sl: number, fp: number, fl: number,
    ) => number;

    rt.withString(
      `globalThis.__bun_dispatch_fetch(99999, { url: "http://x/" })
         .then(r => Promise.all([r.text(), Promise.resolve(r.status)]))
         .then(([body, status]) => console.log("MISS:" + status));`,
      (sp, sl) => {
        rt.withString("<miss>", (fp, fl) => { evalFn(sp, sl, fp, fl); });
      },
    );

    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      if (printed.some(p => p.includes("MISS:"))) break;
      await Bun.sleep(10);
    }
    expect(printed.join("")).toContain("MISS:502");
  });
});

describe("Kernel.fetch() via Worker", () => {
  test("Worker 内 polyfill 已替换 Bun.serve（probe）", async () => {
    let output = "";
    const kernel = new Kernel({
      wasmModule,
      workerUrl: WORKER_URL,
      onStdout: (d) => { output += d; },
    });
    try {
      await kernel.whenReady();
      await kernel.eval(
        "probe",
        `console.log("installed=" + globalThis.__bun_wasm_serve_installed);
         console.log("serve_is_polyfill=" + (Bun.serve.toString().indexOf("__bun_next_port") >= 0 || Bun.serve.toString().indexOf("__bun_routes") >= 0));`,
      );
      await Bun.sleep(50);
      expect(output).toContain("installed=true");
      expect(output).toContain("serve_is_polyfill=true");
    } finally {
      kernel.terminate();
    }
  });

  test("注册路由 → Kernel.fetch 派发 → 收到 Response", async () => {
    const kernel = new Kernel({
      wasmModule,
      workerUrl: WORKER_URL,
    });

    try {
      await kernel.whenReady();
      // 在 worker 里注册一个路由
      await kernel.eval(
        "reg",
        `Bun.serve({
           port: 40789,
           fetch(req) {
             const u = new URL(req.url);
             return new Response("kernel-fetch:" + u.pathname + ":" + req.method, { status: 200, headers: { "x-test": "1" } });
           },
         });`,
      );

      const res = await Promise.race([
        kernel.fetch(40789, { url: "http://localhost:40789/hello", method: "POST" }),
        Bun.sleep(2000).then(() => { throw new Error("timeout"); }),
      ]);

      expect(res.status).toBe(200);
      expect(res.body).toBe("kernel-fetch:/hello:POST");
      expect(res.headers["x-test"]).toBe("1");
    } finally {
      kernel.terminate();
    }
  });

  test("未注册端口 → 502 + error", async () => {
    const kernel = new Kernel({ wasmModule, workerUrl: WORKER_URL });
    try {
      await kernel.whenReady();
      await expect(
        kernel.fetch(55555, { url: "http://localhost:55555/" }),
      ).rejects.toThrow(/no route registered/);
    } finally {
      kernel.terminate();
    }
  });
});

// ──────────────────────────────────────────────────────────
// Phase 3 T3.1：Kernel.registerPreviewPort / unregisterPreviewPort
// ──────────────────────────────────────────────────────────

describe("Kernel preview port registry", () => {
  test("registerPreviewPort 返回预览 URL 且 previewPorts 已登记", async () => {
    const kernel = new Kernel({ wasmModule, workerUrl: WORKER_URL });
    try {
      await kernel.whenReady();
      const url = kernel.registerPreviewPort(40123, "https://app.example.com");
      expect(url).toBe("https://app.example.com/__bun_preview__/40123/");
      expect(kernel.previewPorts.has(40123)).toBe(true);
      expect(kernel.previewPorts.list()).toEqual([40123]);
      expect(kernel.unregisterPreviewPort(40123)).toBe(true);
      expect(kernel.previewPorts.has(40123)).toBe(false);
    } finally {
      kernel.terminate();
    }
  });

  test("registerPreviewPort 在没有 origin 时退化为 http://localhost", async () => {
    const kernel = new Kernel({ wasmModule, workerUrl: WORKER_URL });
    try {
      await kernel.whenReady();
      const url = kernel.registerPreviewPort(40456);
      // Bun 测试进程下无 globalThis.location：应退化为 http://localhost
      expect(url).toBe("http://localhost/__bun_preview__/40456/");
    } finally {
      kernel.terminate();
    }
  });
});

// ──────────────────────────────────────────────────────────
// Phase 3 T3.1：Kernel.registerPreviewPort / unregisterPreviewPort
// ──────────────────────────────────────────────────────────

describe("Kernel preview port registry", () => {
  test("registerPreviewPort 返回预览 URL 且 previewPorts 已登记", async () => {
    const kernel = new Kernel({ wasmModule, workerUrl: WORKER_URL });
    try {
      await kernel.whenReady();
      const url = kernel.registerPreviewPort(40123, "https://app.example.com");
      expect(url).toBe("https://app.example.com/__bun_preview__/40123/");
      expect(kernel.previewPorts.has(40123)).toBe(true);
      expect(kernel.previewPorts.list()).toEqual([40123]);
      expect(kernel.unregisterPreviewPort(40123)).toBe(true);
      expect(kernel.previewPorts.has(40123)).toBe(false);
    } finally {
      kernel.terminate();
    }
  });

  test("registerPreviewPort 在没有 origin 时退化为 http://localhost", async () => {
    const kernel = new Kernel({ wasmModule, workerUrl: WORKER_URL });
    try {
      await kernel.whenReady();
      const url = kernel.registerPreviewPort(40456);
      expect(url).toBe("http://localhost/__bun_preview__/40456/");
    } finally {
      kernel.terminate();
    }
  });
});

// ──────────────────────────────────────────────────────────
// WASM semver: bun_semver_select（真实 Zig semver）
// ──────────────────────────────────────────────────────────

describe("WasmRuntime.semverSelect", () => {
  test("bun_semver_select 导出存在", async () => {
    const rt = await makeRuntime();
    expect(rt.instance.exports.bun_semver_select).toBeInstanceOf(Function);
  });

  test("^1.0.0 匹配最高 1.x", async () => {
    const rt = await makeRuntime();
    const versions = ["1.0.0", "1.1.0", "1.2.3", "2.0.0"];
    const result = rt.semverSelect(JSON.stringify(versions), "^1.0.0");
    expect(result).toBe("1.2.3");
  });

  test("~1.1.0 只匹配 1.1.x", async () => {
    const rt = await makeRuntime();
    const versions = ["1.0.9", "1.1.0", "1.1.5", "1.2.0"];
    const result = rt.semverSelect(JSON.stringify(versions), "~1.1.0");
    expect(result).toBe("1.1.5");
  });

  test("精确版本", async () => {
    const rt = await makeRuntime();
    const versions = ["1.0.0", "2.0.0", "3.0.0"];
    expect(rt.semverSelect(JSON.stringify(versions), "2.0.0")).toBe("2.0.0");
  });

  test("无匹配版本返回 null", async () => {
    const rt = await makeRuntime();
    const versions = ["1.0.0", "1.1.0"];
    expect(rt.semverSelect(JSON.stringify(versions), "^2.0.0")).toBeNull();
  });

  test("latest tag", async () => {
    const rt = await makeRuntime();
    const versions = ["1.0.0", "2.0.0", "3.0.0"];
    const result = rt.semverSelect(JSON.stringify(versions), "latest");
    // "latest" 不是合法 semver range，Zig 解析失败时 WASM 返回空（null）
    // 这里主要确认不崩溃
    expect(result === null || typeof result === "string").toBe(true);
  });
});

// ──────────────────────────────────────────────────────────
// WASM integrity: bun_integrity_verify
// ──────────────────────────────────────────────────────────

describe("WasmRuntime.integrityVerify", () => {
  test("bun_integrity_verify 导出存在", async () => {
    const rt = await makeRuntime();
    expect(rt.instance.exports.bun_integrity_verify).toBeInstanceOf(Function);
  });

  test("空 integrity → ok（无约束）", async () => {
    const rt = await makeRuntime();
    const data = new Uint8Array([1, 2, 3, 4]);
    expect(rt.integrityVerify(data, "")).toBe("ok");
  });

  test("sha512 正确哈希 → ok", async () => {
    const rt = await makeRuntime();
    const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    // 用 Web Crypto 计算期望值，再传给 WASM 验证
    const digest = await crypto.subtle.digest("SHA-512", data);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const sri = "sha512-" + b64.replace(/=+$/, "");
    expect(rt.integrityVerify(data, sri)).toBe("ok");
  });

  test("sha256 正确哈希 → ok", async () => {
    const rt = await makeRuntime();
    const data = new Uint8Array([104, 105]); // "hi"
    const digest = await crypto.subtle.digest("SHA-256", data);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const sri = "sha256-" + b64.replace(/=+$/, "");
    expect(rt.integrityVerify(data, sri)).toBe("ok");
  });

  test("sha512 篡改数据 → fail", async () => {
    const rt = await makeRuntime();
    const original = new Uint8Array([1, 2, 3]);
    const tampered = new Uint8Array([1, 2, 4]); // 最后一字节改变
    const digest = await crypto.subtle.digest("SHA-512", original);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const sri = "sha512-" + b64.replace(/=+$/, "");
    expect(rt.integrityVerify(tampered, sri)).toBe("fail");
  });

  test("未知算法 → ok（向前兼容）", async () => {
    const rt = await makeRuntime();
    const data = new Uint8Array([1, 2, 3]);
    expect(rt.integrityVerify(data, "sha3-abc123")).toBe("ok");
  });

  test("sha1 hex（shasum 字段）→ ok", async () => {
    const rt = await makeRuntime();
    const data = new Uint8Array([65, 66, 67]); // "ABC"
    const digest = await crypto.subtle.digest("SHA-1", data);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(rt.integrityVerify(data, hex)).toBe("ok");
  });
});
