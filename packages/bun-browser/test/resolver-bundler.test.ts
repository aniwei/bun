/**
 * Phase 1 T1.1 集成测试：bun_resolve / bun_bundle
 *
 * 加载真实 bun-core.wasm，将多文件项目写入 VFS（snapshot），验证：
 *   - resolve(): 相对路径 + 扩展名探测 + index.* + 裸包 (node_modules)
 *   - bundle(): 多文件 TS → 单一 IIFE JS，能在 vm.Context 中执行并产出预期值
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { buildSnapshot } from "../src/vfs-client";
import { createWasmRuntime, type WasmRuntime } from "../src/wasm";

const WASM_PATH = import.meta.dir + "/../bun-core.wasm";

let wasmModule: WebAssembly.Module;

beforeAll(async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer();
  wasmModule = await WebAssembly.compile(bytes);
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
  const tsTranspiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
  const tsxTranspiler = new Bun.Transpiler({ loader: "tsx", target: "browser" });
  // 测试侧最小 ESM → CJS lowering（仅覆盖测试中使用到的 import/export 形式）。
  // 这模拟了一个真实 host 应当提供的、产出 CJS 的 transpile 钩子。
  const lowerEsmToCjs = (src: string): string =>
    src
      // export function foo(...) { ... }
      .replace(/^export\s+function\s+([a-zA-Z_$][\w$]*)/gm, "function $1")
      .replace(/^export\s+(const|let|var)\s+([a-zA-Z_$][\w$]*)/gm, "$1 $2")
      .replace(/^export\s+default\s+/gm, "module.exports.default = module.exports = ")
      // import X from "spec";
      .replace(
        /^import\s+([a-zA-Z_$][\w$]*)\s+from\s+(['"][^'"]+['"]);?/gm,
        'const $1 = (require($2).default ?? require($2));',
      )
      // import { a, b } from "spec";
      .replace(
        /^import\s+\{([^}]+)\}\s+from\s+(['"][^'"]+['"]);?/gm,
        'const {$1} = require($2);',
      )
      // import * as X from "spec";
      .replace(
        /^import\s+\*\s+as\s+([a-zA-Z_$][\w$]*)\s+from\s+(['"][^'"]+['"]);?/gm,
        'const $1 = require($2);',
      )
      // import "spec";
      .replace(/^import\s+(['"][^'"]+['"]);?/gm, "require($1);");
  const transpile = (src: string, filename: string): string => {
    const t = filename.endsWith(".tsx") ? tsxTranspiler : tsTranspiler;
    let out = t.transformSync(src);
    // 为简单起见，再做一遍 export 收集——此最小 lowering 后，需补全
    // `function foo(){}` / `const x = ...` 的 exports 绑定（按出现顺序）。
    const named: string[] = [];
    for (const m of src.matchAll(/^export\s+(?:function|class)\s+([a-zA-Z_$][\w$]*)/gm)) named.push(m[1]!);
    for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([a-zA-Z_$][\w$]*)/gm)) named.push(m[1]!);
    out = lowerEsmToCjs(out);
    for (const name of named) out += `\nmodule.exports.${name} = ${name};`;
    return out;
  };
  return createWasmRuntime(wasmModule, { evaluator, global: sandbox, transpile });
}

function loadFiles(rt: WasmRuntime, files: { path: string; data: string }[]): void {
  const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (ptr: number, len: number) => number;
  const snapshot = buildSnapshot(files);
  let count = -1;
  rt.withBytes(new Uint8Array(snapshot), (ptr, len) => {
    count = loadFn(ptr, len);
  });
  if (count !== files.length) throw new Error(`vfs_load_snapshot 写入 ${count}/${files.length} 个文件`);
}

describe("bun_resolve", () => {
  test("相对路径 + 扩展名探测 (.ts)", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/app/index.ts", data: "" },
      { path: "/app/foo.ts", data: "export const x = 1;" },
    ]);
    const result = rt.resolve("./foo", "/app/index.ts");
    expect(result.path).toBe("/app/foo.ts");
    expect(result.loader).toBe("ts");
  });

  test("目录 → index.* 探测", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/proj/main.ts", data: "" },
      { path: "/proj/utils/index.ts", data: "export const v = 2;" },
    ]);
    const result = rt.resolve("./utils", "/proj/main.ts");
    expect(result.path).toBe("/proj/utils/index.ts");
    expect(result.loader).toBe("ts");
  });

  test("绝对路径 + .js 直接命中", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [{ path: "/lib/a.js", data: "module.exports=1;" }]);
    const result = rt.resolve("/lib/a.js", "/anywhere/x.ts");
    expect(result).toEqual({ path: "/lib/a.js", loader: "js" });
  });

  test("JSON 文件被识别为 json loader", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/p/main.ts", data: "" },
      { path: "/p/data.json", data: "{}" },
    ]);
    const result = rt.resolve("./data.json", "/p/main.ts");
    expect(result.loader).toBe("json");
  });

  test("缺失模块抛错（错误码 2）", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [{ path: "/x/a.ts", data: "" }]);
    expect(() => rt.resolve("./missing", "/x/a.ts")).toThrow(/module not found/);
  });

  test("裸包：在 from 的祖先 node_modules 中查找", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/proj/src/main.ts", data: "" },
      { path: "/proj/node_modules/leftpad/index.js", data: "module.exports=function(){};" },
    ]);
    const result = rt.resolve("leftpad", "/proj/src/main.ts");
    expect(result.path).toBe("/proj/node_modules/leftpad/index.js");
    expect(result.loader).toBe("js");
  });

  test("空 specifier → 错误码 3", async () => {
    const rt = await makeRuntime();
    expect(() => rt.resolve("", "/a/b.ts")).toThrow(/empty specifier/);
  });
});

describe("bun_bundle", () => {
  test("单文件 TS 入口 → 可执行的 IIFE", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [{ path: "/app/entry.ts", data: "const v: number = 21; module.exports = v * 2;" }]);
    const js = rt.bundle("/app/entry.ts");

    // sanity
    expect(js).toContain("__modules__");
    expect(js).toContain("__require");

    // 在隔离 sandbox 中执行，断言 IIFE 返回入口模块的 module.exports
    const sandbox = createContext({});
    const out = runInContext(js, sandbox, { filename: "/bundle.js" });
    expect(out).toBe(42);
  });

  test("多文件 TS：相对 require + import from", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      {
        path: "/p/entry.ts",
        data: `import { add } from "./math";\nconst sum: number = add(2, 3);\nmodule.exports = sum;`,
      },
      {
        path: "/p/math.ts",
        data: `export function add(a: number, b: number): number { return a + b; }`,
      },
    ]);
    const js = rt.bundle("/p/entry.ts");
    const out = runInContext(js, createContext({}), { filename: "/bundle.js" });
    expect(out).toBe(5);
  });

  test("CommonJS require + 目录 index.ts", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/cjs/entry.js", data: `var u = require("./util");\nmodule.exports = u.greet("Bun");` },
      { path: "/cjs/util/index.ts", data: `export function greet(name) { return "hello " + name; }` },
    ]);
    const js = rt.bundle("/cjs/entry.js");
    const out = runInContext(js, createContext({}), { filename: "/bundle.js" });
    expect(out).toBe("hello Bun");
  });

  test("JSON 模块作为依赖", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/j/entry.ts", data: `import data from "./data.json"; module.exports = data.value;` },
      { path: "/j/data.json", data: `{"value": 99}` },
    ]);
    const js = rt.bundle("/j/entry.ts");
    const out = runInContext(js, createContext({}), { filename: "/bundle.js" });
    expect(out).toBe(99);
  });

  test("入口缺失 → 错误码 2", async () => {
    const rt = await makeRuntime();
    expect(() => rt.bundle("/does/not/exist.ts")).toThrow(/entry not found/);
  });
});
