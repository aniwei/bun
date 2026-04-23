import { useState, useEffect } from "react";
import { useRuntime } from "../context/RuntimeContext";
import { buildSnapshot } from "../../../src/vfs-client";

// ── Mock registry ──────────────────────────────────────────────────────────

const MOCK_REGISTRY: Record<string, string[]> = {
  react:        ["16.14.0","17.0.2","18.0.0","18.1.0","18.2.0","18.3.0"],
  "react-dom":  ["16.14.0","17.0.2","18.0.0","18.1.0","18.2.0","18.3.0"],
  lodash:       ["4.14.0","4.16.0","4.17.0","4.17.15","4.17.21"],
  axios:        ["1.0.0","1.1.0","1.3.0","1.6.0","1.6.7","1.7.0"],
  zod:          ["3.18.0","3.20.0","3.22.0","3.22.4","3.23.0"],
  typescript:   ["4.9.0","5.0.4","5.1.0","5.2.0","5.4.5","5.5.0"],
  vite:         ["4.0.0","4.5.0","5.0.0","5.1.0","5.2.0","5.3.0"],
};

// ── Node.js presets ────────────────────────────────────────────────────────

const NODEJS_PRESETS: Record<string, string> = {
  path: `// Node.js: path 模块
const path = require("path");

console.log(path.join("/home", "user", ".config", "bun"));
console.log(path.resolve("./src", "../lib", "utils.ts"));
console.log(path.dirname("/usr/local/bin/bun"));
console.log(path.extname("main.test.ts"));
console.log(path.basename("/path/to/file.ts", ".ts"));
console.log(path.parse("/home/user/projects/app/index.js"));`,
  buffer: `// Node.js: Buffer 操作
const buf1 = Buffer.from("Hello, Bun!");
const buf2 = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]);

console.log("utf8 :", buf1.toString("utf8"));
console.log("hex  :", buf1.toString("hex"));
console.log("b64  :", buf1.toString("base64"));
console.log("len  :", buf1.length);

const alloc = Buffer.alloc(8, 0xAB);
console.log("alloc:", alloc.toString("hex"));

const concat = Buffer.concat([buf1, buf2]);
console.log("concat len:", concat.length);
console.log("byteLength:", Buffer.byteLength("中文字符", "utf8"));`,
  process: `// Node.js: process / env
console.log("platform :", process.platform);
console.log("arch     :", process.arch);
console.log("version  :", process.version);

process.env.MY_APP_NAME = "bun-browser";
process.env.DEBUG       = "1";

console.log("env.MY_APP_NAME:", process.env.MY_APP_NAME);
console.log("env.DEBUG      :", process.env.DEBUG ?? "unset");
console.log("env.NODE_ENV   :", process.env.NODE_ENV ?? "unset");

console.log("argv:", process.argv.slice(0, 3));
console.log("cwd :", process.cwd?.() ?? "(no cwd)");`,
  events: `// Node.js: EventEmitter
const { EventEmitter } = require("events");

class DataStream extends EventEmitter {
  push(chunk) {
    this.emit("data", chunk);
    if (chunk === null) this.emit("end");
  }
}

const stream = new DataStream();
const chunks = [];

stream.on("data",  chunk  => { chunks.push(chunk); console.log("data:", chunk); });
stream.on("end",   ()     => console.log("end — total chunks:", chunks.length));
stream.on("error", err    => console.error("error:", err.message));

stream.push("hello");
stream.push(" ");
stream.push("world");
stream.push(null);`,
  stream: `// Node.js: Transform stream 模式（手动实现）
function map(arr, fn) { return arr.map(fn); }
function filter(arr, fn) { return arr.filter(fn); }
function reduce(arr, fn, init) { return arr.reduce(fn, init); }

const INPUT  = [1,2,3,4,5,6,7,8,9,10,11,12];
const result = reduce(
  map(filter(INPUT, x => x % 2 === 0), x => x * x),
  (acc, x) => acc + x,
  0
);
console.log("偶数平方和:", result);

const CHUNK_SIZE = 4;
for (let i = 0; i < INPUT.length; i += CHUNK_SIZE) {
  const chunk = INPUT.slice(i, i + CHUNK_SIZE);
  console.log("chunk:", JSON.stringify(chunk));
}`,
  util: `// Node.js: util + assert
const util   = require("util");
const assert = require("assert");

console.log(util.format("Hello, %s! You are %d years old.", "Bun", 2));
console.log(util.format("Data: %j", { ok: true, version: "1.0" }));

const obj = { name: "bun", nested: { wasm: true, features: ["eval","run","bundle"] } };
console.log(util.inspect(obj, { depth: 2, colors: false }));

try {
  assert.strictEqual(1 + 1, 2);
  assert.ok(typeof "bun" === "string");
  assert.deepStrictEqual([1,2,3], [1,2,3]);
  console.log("assert: 全部通过 ✓");
} catch (e) {
  console.error("assert 失败:", e.message);
}`,
};

// ── Vite presets ───────────────────────────────────────────────────────────

interface VitePreset { label: string; entry: string; files: Record<string,string>; define: Record<string,string>; external?: string[] }

const VITE_PRESETS: Record<string, VitePreset> = {
  basic: {
    label: "Vite 基础 define 替换",
    entry: "/src/main.js",
    define: {
      "import.meta.env.PROD":     "true",
      "import.meta.env.DEV":      "false",
      "import.meta.env.MODE":     '"production"',
      "import.meta.env.BASE_URL": '"/"',
      "__VITE_IS_MODERN__":       "true",
    },
    files: {
      "/src/config.js": `export const DEBUG  = import.meta.env.DEV;
export const BASE   = import.meta.env.BASE_URL;
export const MODE   = import.meta.env.MODE;`,
      "/src/main.js": `import { DEBUG, BASE, MODE } from "./config.js";

if (__VITE_IS_MODERN__) {
  console.log("Modern browser build");
}

console.log("prod   :", import.meta.env.PROD);
console.log("dev    :", DEBUG);
console.log("mode   :", MODE);
console.log("base   :", BASE);`,
    },
  },
  plugin: {
    label: "Vite 插件系统模拟",
    entry: "/src/index.js",
    define: { "__PLUGIN_API_VERSION__": '"3"', "process.env.NODE_ENV": '"production"' },
    files: {
      "/src/plugin-api.js": `export function definePlugin(opts) {
  return { name: opts.name, version: __PLUGIN_API_VERSION__, ...opts };
}

export function applyPlugins(plugins, ctx) {
  return plugins.reduce((c, p) => {
    if (p.transform) return { ...c, code: p.transform(c.code, ctx) };
    return c;
  }, ctx);
}`,
      "/src/index.js": `import { definePlugin, applyPlugins } from "./plugin-api.js";

const replacePlugin = definePlugin({
  name: "replace",
  transform(code) {
    return code.replace(/__APP_VERSION__/g, "1.0.0");
  },
});

const stripPlugin = definePlugin({
  name: "strip-debug",
  transform(code) {
    return code.replace(/console\\.debug\\([^)]*\\);?/g, "");
  },
});

const result = applyPlugins([replacePlugin, stripPlugin], {
  code: "const v = '__APP_VERSION__'; console.debug('removed'); console.log(v);",
  filename: "app.js",
});

console.log("env:", process.env.NODE_ENV);
console.log("result:", result.code);`,
    },
  },
  ssr: {
    label: "Vite SSR 模式 (ESM→CJS)",
    entry: "/server/app.js",
    define: { "import.meta.env.SSR": "true", "import.meta.env.PROD": "true" },
    external: ["node:http", "node:fs", "node:path"],
    files: {
      "/server/router.js": `export function createRouter(routes) {
  return function handle(url) {
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url === pattern || url.startsWith(pattern + "/")) {
        return handler(url);
      }
    }
    return { status: 404, body: "Not Found" };
  };
}`,
      "/server/app.js": `import { createRouter } from "./router.js";

const isSSR = import.meta.env.SSR;
console.log("SSR mode:", isSSR);

const router = createRouter({
  "/":    (url) => ({ status: 200, body: "<html>Home</html>" }),
  "/api": (url) => ({ status: 200, body: JSON.stringify({ ok: true }) }),
});

console.log(JSON.stringify(router("/")));
console.log(JSON.stringify(router("/api/users")));
console.log(JSON.stringify(router("/unknown")));`,
    },
  },
};

// ── VRT files ──────────────────────────────────────────────────────────────

const VRT_FILES: Record<string, string> = {
  "App.tsx": `import React, { useState } from "react";
import { useCounter } from "./hooks/useCounter";
import type { Theme } from "./types";

interface AppProps {
  title?: string;
  theme?: Theme;
}

export function App({ title = "Bun Browser", theme = "dark" }: AppProps) {
  const { count, increment, decrement, reset } = useCounter(0);
  const [log, setLog] = useState<string[]>([]);

  const addLog = (msg: string) => setLog(prev => [...prev.slice(-4), msg]);

  return (
    <div className={\`app theme-\${theme}\`}>
      <h1>{title}</h1>
      <p>Powered by bun-core.wasm</p>
      <div className="counter">
        <button onClick={() => { decrement(); addLog(\`dec → \${count - 1}\`); }}>−</button>
        <span>{count}</span>
        <button onClick={() => { increment(); addLog(\`inc → \${count + 1}\`); }}>+</button>
        <button onClick={() => { reset();     addLog("reset → 0"); }}>reset</button>
      </div>
      <ul>{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
    </div>
  );
}`,
  "hooks/useCounter.ts": `import { useState, useCallback } from "react";

export interface CounterActions {
  count: number;
  increment: () => void;
  decrement: () => void;
  reset: () => void;
  set: (n: number) => void;
}

export function useCounter(initial = 0): CounterActions {
  const [count, setCount] = useState<number>(initial);

  const increment = useCallback(() => setCount(c => c + 1), []);
  const decrement = useCallback(() => setCount(c => c - 1), []);
  const reset     = useCallback(() => setCount(initial),    [initial]);
  const set       = useCallback((n: number) => setCount(n), []);

  return { count, increment, decrement, reset, set };
}`,
  "main.tsx": `import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { Theme } from "./types";

const theme: Theme = (document.documentElement.dataset.theme as Theme) ?? "dark";

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <App title="bun-browser Demo" theme={theme} />
  </React.StrictMode>
);`,
  "types.ts": `export type Theme = "dark" | "light" | "system";

export interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user" | "guest";
  createdAt: Date;
}

export interface ApiResponse<T> {
  data: T;
  error: string | null;
  status: number;
  timestamp: number;
}

export type AsyncState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error";   error: Error };`,
};

// ── Component ──────────────────────────────────────────────────────────────

export function EcosystemTab() {
  const { rt, setStatus } = useRuntime();

  // npm
  const [npmPkgJson, setNpmPkgJson] = useState(`{
  "name": "my-app",
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "lodash": "^4.17.0",
    "axios": "^1.6.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vite": "^5.0.0"
  }
}`);
  const [npmResult, setNpmResult]   = useState({ text: "", isErr: false });
  const [npmBadge, setNpmBadge]     = useState("");

  // Node.js
  const [nodejsPreset, setNodejsPreset] = useState("path");
  const [nodejsCode, setNodejsCode]     = useState(NODEJS_PRESETS["path"]!);
  const [nodejsOutput, setNodejsOutput] = useState<Array<{ text: string; cls: string }>>([]);
  const [nodejsExit, setNodejsExit]     = useState<number | null>(null);

  // Vite
  const [vitePreset, setVitePreset] = useState("basic");
  const [viteInput, setViteInput]   = useState(() => {
    const cfg = VITE_PRESETS["basic"]!;
    return Object.entries(cfg.files).map(([p, c]) =>
      `// ── ${p} ${"─".repeat(Math.max(0, 44 - p.length))}\n${c}\n`
    ).join("\n");
  });
  const [viteOutput, setViteOutput] = useState("");

  // VRT
  const [vrtFile, setVrtFile]     = useState("App.tsx");
  const [vrtOutput, setVrtOutput] = useState("");

  useEffect(() => {
    const cfg = VITE_PRESETS[vitePreset];
    if (!cfg) return;
    setViteInput(Object.entries(cfg.files).map(([p, c]) =>
      `// ── ${p} ${"─".repeat(Math.max(0, 44 - p.length))}\n${c}\n`
    ).join("\n"));
    setViteOutput("");
  }, [vitePreset]);

  const runNpm = () => {
    if (!rt) return;
    let pkg: { dependencies?: Record<string,string>; devDependencies?: Record<string,string>; name?: string };
    try { pkg = JSON.parse(npmPkgJson); }
    catch (e) { setNpmResult({ text: `[JSON 解析失败] ${(e as Error).message}`, isErr: true }); return; }
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const lines: string[] = [`# ${pkg.name ?? "package"} — 依赖解析结果\n`];
    let okCount = 0; let missing = 0;
    for (const [name, range] of Object.entries(allDeps)) {
      const versions = MOCK_REGISTRY[name];
      if (!versions) { lines.push(`  ✗ ${name.padEnd(18)} ${range.padEnd(12)} (registry 未收录)`); missing++; continue; }
      try {
        const selected = rt.semverSelect(JSON.stringify(versions), range);
        if (selected) { lines.push(`  ✓ ${name.padEnd(18)} ${range.padEnd(12)} → ${selected}`); okCount++; }
        else { lines.push(`  ✗ ${name.padEnd(18)} ${range.padEnd(12)} → (无匹配版本)`); missing++; }
      } catch { lines.push(`  ! ${name.padEnd(18)} ${range.padEnd(12)} → [semver 错误]`); missing++; }
    }
    lines.push(`\n解析完成: ${okCount} 已解析，${missing} 待 fetch`);
    setNpmResult({ text: lines.join("\n"), isErr: false });
    setNpmBadge(`${okCount}/${okCount + missing} resolved`);
  };

  const runNodejs = () => {
    if (!rt) return;
    const lines: Array<{ text: string; cls: string }> = [];
    setStatus("运行中…", "busy");
    const saved = (rt as any)._onPrint;
    (rt as any)._onPrint = (data: string, kind: string) => {
      lines.push({ text: data, cls: kind === "stderr" ? "e" : "s" });
    };
    const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
    const runFn  = rt.instance.exports.bun_browser_run as (p: number, l: number) => number;
    const { buildSnapshot } = require("../../../src/vfs-client");
    const snap = buildSnapshot([{ path: "/nodejs-demo.js", data: nodejsCode }]);
    rt.withBytes(new Uint8Array(snap), (p: number, l: number) => { loadFn(p, l); });
    let code = -1;
    rt.withString("/nodejs-demo.js", (p: number, l: number) => { code = runFn(p, l); });
    lines.push({ text: `\n[exit ${code}]\n`, cls: "x" });
    setNodejsOutput(lines);
    setNodejsExit(code);
    setStatus(code === 0 ? "就绪 ✓" : `退出码 ${code}`, code === 0 ? "ready" : "error");
    (rt as any)._onPrint = saved;
  };

  const runViteTransform = () => {
    if (!rt) return;
    const cfg = VITE_PRESETS[vitePreset];
    if (!cfg) return;
    const entryContent = cfg.files[cfg.entry] ?? Object.values(cfg.files).at(-1)!;
    const result = rt.transform(entryContent, cfg.entry.replace(".js", ".ts"), {});
    if (!result) { setViteOutput("[bun_transform 未导出]"); return; }
    setViteOutput(`// Vite-style transform (${cfg.entry})\n// define: ${JSON.stringify(cfg.define)}\n\n${result.code ?? ""}`);
  };

  const runViteBundle = () => {
    if (!rt) return;
    const cfg = VITE_PRESETS[vitePreset];
    if (!cfg) return;
    const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
    const files  = Object.entries(cfg.files).map(([path, data]) => ({ path, data }));
    const snap   = buildSnapshot(files);
    rt.withBytes(new Uint8Array(snap), (p, l) => { loadFn(p, l); });
    try {
      const out = rt.bundle2({ entrypoint: cfg.entry, define: cfg.define, ...(cfg.external ? { external: cfg.external } : {}) });
      setViteOutput(`// Vite bundle output\n// define: ${JSON.stringify(cfg.define)}\n\n${out}`);
    } catch (e) {
      setViteOutput(`[error] ${(e as Error).message}`);
    }
  };

  const runVrtTransform = () => {
    if (!rt) return;
    const source = VRT_FILES[vrtFile];
    if (!source) { setVrtOutput("[文件不存在]"); return; }
    const result = rt.transform(source, vrtFile, { jsx: "react" });
    if (!result) { setVrtOutput("[bun_transform 未导出]"); return; }
    const header = `// ── ${vrtFile} (转译结果) ${"─".repeat(Math.max(0, 40 - vrtFile.length))}\n\n`;
    setVrtOutput(header + (result.errors?.length ? `// Errors: ${result.errors.join("; ")}\n\n` : "") + (result.code ?? ""));
  };

  const runVrtBundleAll = () => {
    if (!rt) return;
    const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
    const vfsFiles: { path: string; data: string }[] = [];
    for (const [filename, source] of Object.entries(VRT_FILES)) {
      const result = rt.transform(source, filename, { jsx: "react" });
      const jsPath = "/vrt/" + filename.replace(/\.tsx?$/, ".js");
      vfsFiles.push({ path: jsPath, data: result?.code ?? source });
    }
    const snap = buildSnapshot(vfsFiles);
    rt.withBytes(new Uint8Array(snap), (p, l) => { loadFn(p, l); });
    try {
      const out = rt.bundle2({
        entrypoint: "/vrt/main.js",
        external:   ["react", "react-dom", "react-dom/client"],
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.PROD": "true" },
      });
      const kb = (out.length / 1024).toFixed(1);
      setVrtOutput(`// Vite React TS — Bundle 完成\n// 文件数: ${vfsFiles.length}  输出大小: ${kb} KB  externals: react, react-dom\n\n${out}`);
    } catch (e) {
      setVrtOutput(`[bundle error] ${(e as Error).message}`);
    }
  };

  return (
    <div className="eco-grid">
      {/* npm */}
      <div className="eco-card">
        <h3>📦 npm · package.json 依赖解析</h3>
        <p className="desc">模拟 <code>bun install</code> 解析流程：从 package.json 提取依赖，通过 Zig semver 引擎为每个 dep 选出最优版本。</p>
        <textarea value={npmPkgJson} onChange={e => setNpmPkgJson(e.target.value)} rows={6} />
        <div className="row">
          <button disabled={!rt} onClick={runNpm}>🔍 解析依赖</button>
          {npmBadge && <span className="eco-badge">{npmBadge}</span>}
        </div>
        <div className={`eco-result${npmResult.isErr ? " err" : ""}`}>{npmResult.text}</div>
      </div>

      {/* Node.js */}
      <div className="eco-card">
        <h3>🟢 Node.js · 内置 API 兼容验证</h3>
        <p className="desc">在 bun-core.wasm 中运行使用 Node.js 内置 API 的代码：<code>path</code>、<code>Buffer</code>、<code>process</code> 等。</p>
        <select value={nodejsPreset} onChange={e => { setNodejsPreset(e.target.value); setNodejsCode(NODEJS_PRESETS[e.target.value] ?? ""); }}>
          <option value="path">path 模块</option>
          <option value="buffer">Buffer 操作</option>
          <option value="process">process / env</option>
          <option value="events">EventEmitter</option>
          <option value="stream">Stream Transform</option>
          <option value="util">util / assert</option>
        </select>
        <textarea className="editor" rows={8} spellCheck={false} value={nodejsCode} onChange={e => setNodejsCode(e.target.value)} />
        <div className="row">
          <button className="primary" disabled={!rt} onClick={runNodejs}>▶ 验证</button>
          <button onClick={() => { setNodejsOutput([]); setNodejsExit(null); }}>清空</button>
          {nodejsExit !== null && (
            <span style={{ fontSize: "0.75rem", color: nodejsExit === 0 ? "var(--green)" : "var(--red)" }}>
              {nodejsExit === 0 ? "✓ exit 0" : `✗ exit ${nodejsExit}`}
            </span>
          )}
        </div>
        <pre className="eco-result">
          {nodejsOutput.map((l, i) => <span key={i} className={l.cls || undefined}>{l.text}</span>)}
        </pre>
      </div>

      {/* Vite */}
      <div className="eco-card">
        <h3>⚡ Vite · 配置 & 构建模拟</h3>
        <p className="desc">模拟 Vite 生产构建：<code>define</code> 替换 <code>import.meta.env.*</code>，Tree-shaking，生成 IIFE bundle。</p>
        <select value={vitePreset} onChange={e => setVitePreset(e.target.value)}>
          <option value="basic">基础 define 替换</option>
          <option value="plugin">插件系统模拟</option>
          <option value="ssr">SSR 模式 (CJS)</option>
        </select>
        <textarea className="editor" rows={8} spellCheck={false} value={viteInput} onChange={e => setViteInput(e.target.value)} />
        <div className="row">
          <button disabled={!rt} onClick={runViteTransform}>⚡ 转译</button>
          <button disabled={!rt} onClick={runViteBundle}>📦 Bundle</button>
        </div>
        <pre className="eco-result">{viteOutput}</pre>
      </div>

      {/* VRT */}
      <div className="eco-card">
        <h3>⚛️ Vite + React + TypeScript 项目</h3>
        <p className="desc">完整 Vite React TS 项目写入 VFS：<code>App.tsx</code>、<code>hooks/useCounter.ts</code>、<code>main.tsx</code>。依次转译所有 TS/TSX 文件，再 bundle 为一个 IIFE。</p>
        <div className="row" style={{ flexWrap: "nowrap", gap: "4px" }}>
          <select value={vrtFile} onChange={e => setVrtFile(e.target.value)} style={{ flex: 1 }}>
            {Object.keys(VRT_FILES).map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          <button disabled={!rt} onClick={runVrtTransform}>⚡ 转译所选</button>
          <button disabled={!rt} onClick={runVrtBundleAll}>📦 Bundle 全部</button>
        </div>
        <pre className="eco-result">{vrtOutput}</pre>
      </div>
    </div>
  );
}
