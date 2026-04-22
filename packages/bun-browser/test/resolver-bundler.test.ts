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
      // import "spec"; (side-effect) — also handles no-space: import"spec" (Bun transpiler output)
      .replace(/^import\s*(['"][^'"]+['"]);?/gm, "require($1);");
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

// Phase 5.3: package.json main/module/exports + tsconfig paths
describe("Phase 5.3 · package.json resolution", () => {
  test("裸包：package.json main 字段优先", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/app/src/main.ts", data: "" },
      {
        path: "/app/node_modules/leftpad/package.json",
        data: JSON.stringify({ name: "leftpad", main: "./dist/cjs.js" }),
      },
      { path: "/app/node_modules/leftpad/dist/cjs.js", data: "module.exports=function(){};" },
      // also present but should be ignored
      { path: "/app/node_modules/leftpad/index.js", data: "throw new Error('should not pick index');" },
    ]);
    const result = rt.resolve("leftpad", "/app/src/main.ts");
    expect(result.path).toBe("/app/node_modules/leftpad/dist/cjs.js");
  });

  test("裸包：exports['.'] 字符串优先级高于 main", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/app/src/main.ts", data: "" },
      {
        path: "/app/node_modules/mylib/package.json",
        data: JSON.stringify({
          name: "mylib",
          main: "./main.js",
          exports: { ".": "./esm.js" },
        }),
      },
      { path: "/app/node_modules/mylib/main.js", data: "throw new Error('main picked');" },
      { path: "/app/node_modules/mylib/esm.js", data: "module.exports=1;" },
    ]);
    const result = rt.resolve("mylib", "/app/src/main.ts");
    expect(result.path).toBe("/app/node_modules/mylib/esm.js");
  });

  test("裸包：exports['.'] 条件对象 → 选 import", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/app/main.ts", data: "" },
      {
        path: "/app/node_modules/cond/package.json",
        data: JSON.stringify({
          name: "cond",
          exports: { ".": { require: "./cjs.js", import: "./esm.js", default: "./def.js" } },
        }),
      },
      { path: "/app/node_modules/cond/esm.js", data: "module.exports=2;" },
      { path: "/app/node_modules/cond/cjs.js", data: "throw new Error('cjs picked');" },
    ]);
    const result = rt.resolve("cond", "/app/main.ts");
    expect(result.path).toBe("/app/node_modules/cond/esm.js");
  });

  test("裸包：module 字段退化回退", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/app/main.ts", data: "" },
      {
        path: "/app/node_modules/modpkg/package.json",
        data: JSON.stringify({ name: "modpkg", module: "./m.js" }),
      },
      { path: "/app/node_modules/modpkg/m.js", data: "module.exports=3;" },
    ]);
    const result = rt.resolve("modpkg", "/app/main.ts");
    expect(result.path).toBe("/app/node_modules/modpkg/m.js");
  });

  test("裸包子路径：pkg/sub → node_modules/pkg/sub.ts 探测", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/app/main.ts", data: "" },
      {
        path: "/app/node_modules/leftpad/package.json",
        data: JSON.stringify({ name: "leftpad", main: "./index.js" }),
      },
      { path: "/app/node_modules/leftpad/index.js", data: "" },
      { path: "/app/node_modules/leftpad/utils.js", data: "module.exports=42;" },
    ]);
    const result = rt.resolve("leftpad/utils", "/app/main.ts");
    expect(result.path).toBe("/app/node_modules/leftpad/utils.js");
  });

  test("Scoped 包: @scope/name 正确解析", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/app/main.ts", data: "" },
      {
        path: "/app/node_modules/@scope/pkg/package.json",
        data: JSON.stringify({ name: "@scope/pkg", main: "./lib.js" }),
      },
      { path: "/app/node_modules/@scope/pkg/lib.js", data: "module.exports=7;" },
    ]);
    const result = rt.resolve("@scope/pkg", "/app/main.ts");
    expect(result.path).toBe("/app/node_modules/@scope/pkg/lib.js");
  });
});

describe("Phase 5.3 · tsconfig paths", () => {
  test("通配符别名 @/* → ./src/*", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      {
        path: "/proj/tsconfig.json",
        data: JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: { "@/*": ["./src/*"] },
          },
        }),
      },
      { path: "/proj/src/main.ts", data: "" },
      { path: "/proj/src/utils/helpers.ts", data: "export const v = 10;" },
    ]);
    const result = rt.resolve("@/utils/helpers", "/proj/src/main.ts");
    expect(result.path).toBe("/proj/src/utils/helpers.ts");
    expect(result.loader).toBe("ts");
  });

  test("字面别名: utils → ./src/utils/index.ts", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      {
        path: "/proj/tsconfig.json",
        data: JSON.stringify({
          compilerOptions: {
            paths: { "utils": ["./src/utils/index.ts"] },
          },
        }),
      },
      { path: "/proj/src/main.ts", data: "" },
      { path: "/proj/src/utils/index.ts", data: "export const v = 5;" },
    ]);
    const result = rt.resolve("utils", "/proj/src/main.ts");
    expect(result.path).toBe("/proj/src/utils/index.ts");
  });

  test("tsconfig.json 向上查找（src/main.ts 使用项目根 tsconfig）", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      {
        path: "/workspace/proj/tsconfig.json",
        data: JSON.stringify({
          compilerOptions: { paths: { "#lib/*": ["./packages/lib/src/*"] } },
        }),
      },
      { path: "/workspace/proj/apps/web/main.ts", data: "" },
      { path: "/workspace/proj/packages/lib/src/a.ts", data: "export const v=1;" },
    ]);
    const result = rt.resolve("#lib/a", "/workspace/proj/apps/web/main.ts");
    expect(result.path).toBe("/workspace/proj/packages/lib/src/a.ts");
  });

  test("Bundler 集成：@/* 别名在打包时生效", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      {
        path: "/proj/tsconfig.json",
        data: JSON.stringify({
          compilerOptions: { paths: { "@/*": ["./src/*"] } },
        }),
      },
      {
        path: "/proj/src/entry.ts",
        data: `import { v } from "@/math";\nmodule.exports = v * 2;`,
      },
      { path: "/proj/src/math.ts", data: `export const v = 21;` },
    ]);
    const js = rt.bundle("/proj/src/entry.ts");
    const out = runInContext(js, createContext({}), { filename: "/bundle.js" });
    expect(out).toBe(42);
  });

  test("tsconfig paths 未匹配 → fallback 到 node_modules", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      {
        path: "/proj/tsconfig.json",
        data: JSON.stringify({
          compilerOptions: { paths: { "@/*": ["./src/*"] } },
        }),
      },
      { path: "/proj/src/main.ts", data: "" },
      {
        path: "/proj/node_modules/lodash/package.json",
        data: JSON.stringify({ name: "lodash", main: "./index.js" }),
      },
      { path: "/proj/node_modules/lodash/index.js", data: "module.exports={};" },
    ]);
    const result = rt.resolve("lodash", "/proj/src/main.ts");
    expect(result.path).toBe("/proj/node_modules/lodash/index.js");
  });

  test("exports 子路径通配符: ./features/* → ./dist/features/*.js", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/app/main.ts", data: "" },
      {
        path: "/app/node_modules/wlib/package.json",
        data: JSON.stringify({
          name: "wlib",
          exports: { "./features/*": "./dist/features/*.js" },
        }),
      },
      { path: "/app/node_modules/wlib/dist/features/alpha.js", data: "module.exports='alpha';" },
    ]);
    const result = rt.resolve("wlib/features/alpha", "/app/main.ts");
    expect(result.path).toBe("/app/node_modules/wlib/dist/features/alpha.js");
  });

  test("tsconfig extends: 子配置继承父 paths", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      {
        path: "/repo/tsconfig.base.json",
        data: JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: { "@shared/*": ["./packages/shared/src/*"] },
          },
        }),
      },
      {
        path: "/repo/apps/web/tsconfig.json",
        data: JSON.stringify({
          extends: "../../tsconfig.base.json",
          compilerOptions: {},
        }),
      },
      { path: "/repo/apps/web/main.ts", data: "" },
      { path: "/repo/packages/shared/src/util.ts", data: "export const v=1;" },
    ]);
    const result = rt.resolve("@shared/util", "/repo/apps/web/main.ts");
    expect(result.path).toBe("/repo/packages/shared/src/util.ts");
  });
});

// Phase 5.3 T5.3.1i: Node builtin mapping
describe("Phase 5.3 · T5.3.1i node builtin mapping", () => {
  test("node:fs → virtual builtin path", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [{ path: "/app/main.ts", data: "" }]);
    const result = rt.resolve("node:fs", "/app/main.ts");
    expect(result.path).toBe("<builtin:node:fs>");
    expect(result.loader).toBe("js");
  });

  test("bare 'fs' → virtual builtin path (同 node:fs)", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [{ path: "/app/main.ts", data: "" }]);
    const result = rt.resolve("fs", "/app/main.ts");
    expect(result.path).toBe("<builtin:node:fs>");
    expect(result.loader).toBe("js");
  });

  test("node:path → virtual builtin path", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [{ path: "/app/main.ts", data: "" }]);
    const result = rt.resolve("node:path", "/app/main.ts");
    expect(result.path).toBe("<builtin:node:path>");
    expect(result.loader).toBe("js");
  });

  test("bare 'path' → virtual builtin path", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [{ path: "/app/main.ts", data: "" }]);
    const result = rt.resolve("path", "/app/main.ts");
    expect(result.path).toBe("<builtin:node:path>");
    expect(result.loader).toBe("js");
  });

  test("events → virtual builtin path", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [{ path: "/app/main.ts", data: "" }]);
    const result = rt.resolve("events", "/app/main.ts");
    expect(result.path).toBe("<builtin:node:events>");
    expect(result.loader).toBe("js");
  });

  test("node: prefix 的任意模块 → virtual builtin path", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [{ path: "/app/main.ts", data: "" }]);
    const result = rt.resolve("node:worker_threads", "/app/main.ts");
    expect(result.path).toBe("<builtin:node:worker_threads>");
    expect(result.loader).toBe("js");
  });

  test("Bundler: import from 'path' 内联 polyfill — join 可用", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      {
        path: "/app/entry.ts",
        data: `import path from 'path';\nmodule.exports = path.join('/a', 'b');`,
      },
    ]);
    const js = rt.bundle("/app/entry.ts");
    const out = runInContext(js, createContext({}), { filename: "/bundle.js" });
    expect(out).toBe("/a/b");
  });

  test("Bundler: import from 'node:fs' 不崩溃 (stub/delegate)", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      {
        path: "/app/entry.ts",
        data: `import fs from 'node:fs';\nmodule.exports = typeof fs === 'object' ? 'ok' : 'fail';`,
      },
    ]);
    // 必须不抛出；结果可以是委托对象或空 stub 对象
    const js = rt.bundle("/app/entry.ts");
    expect(js).toContain("__modules__");
    const sandbox = createContext({ globalThis: { require: undefined } });
    const out = runInContext(js, sandbox, { filename: "/bundle.js" });
    expect(out).toBe("ok");
  });

  test("Bundler: node builtin 不会把 node_modules/fs 误识别", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/app/entry.ts", data: `import 'fs';\nmodule.exports = 1;` },
      // 即使 VFS 里有同名包，也应走 builtin 路径
      { path: "/app/node_modules/fs/index.js", data: "throw new Error('should not use nm/fs');" },
    ]);
    // 不应抛出 "should not use nm/fs"
    const js = rt.bundle("/app/entry.ts");
    expect(js).toContain("<builtin:node:fs>");
    const sandbox = createContext({ globalThis: { require: undefined } });
    const out = runInContext(js, sandbox, { filename: "/bundle.js" });
    expect(out).toBe(1);
  });
});

// ─── Phase 5.3 T5.3.3: bun_bundle2 (externals + define) ─────────────────────
describe("Phase 5.3 · T5.3.3 bun_bundle2 (externals + define)", () => {
  test("externals: 外部包不被打包进 bundle，改用 globalThis.require 委托", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      {
        path: "/app/entry.ts",
        data: `import React from 'react';\nmodule.exports = typeof React;`,
      },
      // 即使 VFS 里有 react，也不应被打包
      { path: "/app/node_modules/react/index.js", data: `module.exports = { version: '18' };` },
    ]);
    const js = rt.bundle2({ entrypoint: "/app/entry.ts", external: ["react"] });
    // bundle 里不应含有 node_modules/react 的源码路径
    expect(js).not.toContain("node_modules/react");
    // 应含有 globalThis.require 的委托
    expect(js).toContain("globalThis.require");
    // 用真实 require 委托跑起来
    const fakeReact = { version: "external" };
    const sandbox = createContext({ globalThis: { require: () => fakeReact } });
    const out = runInContext(js, sandbox, { filename: "/bundle.js" });
    expect(out).toBe("object");
  });

  test("define: process.env.NODE_ENV 替换为字面量 production", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      {
        path: "/app/entry.ts",
        data: `module.exports = process.env.NODE_ENV;`,
      },
    ]);
    const js = rt.bundle2({
      entrypoint: "/app/entry.ts",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    // 源码中 process.env.NODE_ENV 已被替换掉
    expect(js).not.toContain("process.env.NODE_ENV");
    expect(js).toContain('"production"');
    const sandbox = createContext({});
    const out = runInContext(js, sandbox, { filename: "/bundle.js" });
    expect(out).toBe("production");
  });

  test("externals + define 组合", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      {
        path: "/app/entry.ts",
        data: `import React from 'react';\nmodule.exports = [typeof React, process.env.NODE_ENV];`,
      },
      { path: "/app/node_modules/react/index.js", data: `module.exports = {};` },
    ]);
    const js = rt.bundle2({
      entrypoint: "/app/entry.ts",
      external: ["react"],
      define: { "process.env.NODE_ENV": '"test"' },
    });
    expect(js).toContain("globalThis.require");
    expect(js).not.toContain("process.env.NODE_ENV");
    const fakeReact = {};
    const sandbox = createContext({ globalThis: { require: () => fakeReact } });
    const out = runInContext(js, sandbox, { filename: "/bundle.js" }) as [string, string];
    expect(out[0]).toBe("object");
    expect(out[1]).toBe("test");
  });

  test("无 externals/define 时，bundle2 等价于 bundle", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/app/entry.ts", data: `module.exports = 42;` },
    ]);
    const a = rt.bundle("/app/entry.ts");
    const b = rt.bundle2({ entrypoint: "/app/entry.ts" });
    // 两者应产出相同结果（功能等价，不一定字节完全相同）
    const sandbox = createContext({});
    const outA = runInContext(a, sandbox, { filename: "/bundle-a.js" });
    const sandboxB = createContext({});
    const outB = runInContext(b, sandboxB, { filename: "/bundle-b.js" });
    expect(outA).toBe(42);
    expect(outB).toBe(42);
  });

  test("entrypoint 不存在时 bundle2 抛出 entry not found", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, []);
    expect(() => rt.bundle2({ entrypoint: "/no/such/file.ts" })).toThrow("entry not found");
  });
});

// ── T5.3.7: __filename / __dirname injection ────────────────────────────────
describe("Phase 5.3 · T5.3.7 __filename/__dirname injection", () => {
  test("bundle output injects __filename var per module", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/app/index.js", data: "module.exports = __filename;" },
    ]);
    const code = rt.bundle("/app/index.js");
    // __filename= must appear in the bundle
    expect(code).toContain("__filename=");
    // Execute and check value
    const sandbox = createContext({});
    const result = runInContext(code, sandbox, { filename: "/bundle.js" });
    expect(result).toBe("/app/index.js");
  });

  test("__dirname equals directory of the module", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/app/sub/mod.js", data: "module.exports = __dirname;" },
    ]);
    const code = rt.bundle("/app/sub/mod.js");
    expect(code).toContain("__dirname=");
    const sandbox = createContext({});
    const result = runInContext(code, sandbox, { filename: "/bundle.js" });
    expect(result).toBe("/app/sub");
  });

  test("multi-module bundle: each module gets own __filename", async () => {
    const rt = await makeRuntime();
    loadFiles(rt, [
      { path: "/app/index.js", data: `const util = require('./util.js'); module.exports = [__filename, util];` },
      { path: "/app/util.js", data: "module.exports = __filename;" },
    ]);
    const code = rt.bundle("/app/index.js");
    const sandbox = createContext({});
    const result = runInContext(code, sandbox, { filename: "/bundle.js" }) as string[];
    expect(result[0]).toBe("/app/index.js");
    expect(result[1]).toBe("/app/util.js");
  });
});
