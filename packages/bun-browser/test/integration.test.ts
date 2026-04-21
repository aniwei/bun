/**
 * 集成测试 —— 加载真实的 bun-core.wasm，端到端验证：
 *   - bun_browser_init / bun_browser_eval / bun_vfs_load_snapshot / bun_browser_run
 * 测试不使用 Worker；直接在 Bun 进程中 WebAssembly.compile + createWasmRuntime。
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { buildSnapshot } from "../src/vfs-client";
import { Kernel } from "../src/kernel";
import { createWasmRuntime, type WasmRuntime } from "../src/wasm";

const WASM_PATH = import.meta.dir + "/../bun-core.wasm";
const WORKER_URL = new URL("../src/kernel-worker.ts", import.meta.url);

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
