/**
 * bun-browser 丰富功能 demo
 *
 * 涵盖：代码执行(eval/run)、TypeScript转译、Bundler、VFS文件系统、
 *       加密&压缩、路径&URL工具、Semver、Lockfile解析
 */

import { createWasmRuntime, type WasmRuntime } from "../src/wasm";
import { buildSnapshot, parseSnapshot } from "../src/vfs-client";
import { installPackages } from "../src/installer";
import { detectThreadCapability } from "../src/thread-capability";
import { createSabRing, SabRingProducer, SabRingConsumer } from "../src/sab-ring";

// ── Runtime ────────────────────────────────────────────────────────────────

let rt: WasmRuntime | null = null;

// ── Status helpers ──────────────────────────────────────────────────────────

const statusDot  = document.getElementById("status-dot")!  as HTMLElement;
const statusText = document.getElementById("status-text")! as HTMLSpanElement;
const wasmSizeEl = document.getElementById("wasm-size")!   as HTMLSpanElement;

function setStatus(text: string, state: "ready" | "busy" | "error" | "loading" = "loading"): void {
  statusText.textContent = text;
  statusDot.className = "status-dot" + (state !== "loading" ? " " + state : "");
}

// ── Tab navigation ──────────────────────────────────────────────────────────

document.querySelectorAll<HTMLElement>(".nav-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    const id = tab.dataset.tab!;
    document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-page").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + id)!.classList.add("active");
  });
});

// ── Output helpers ──────────────────────────────────────────────────────────

function clearOutput(el: HTMLElement): void { el.textContent = ""; }

function appendOut(el: HTMLElement, text: string, cls: "s" | "e" | "i" | "x" | "w" | "" = ""): void {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function setResult(el: HTMLElement, text: string, isErr = false): void {
  el.textContent = text;
  el.classList.toggle("err", isErr);
}

// ── WASM initialisation ─────────────────────────────────────────────────────

async function init(): Promise<void> {
  setStatus("加载 bun-core.wasm…");
  try {
    const wasmUrl = new URL("../bun-core.wasm", import.meta.url);
    const resp    = await fetch(wasmUrl);
    const bytes   = await resp.arrayBuffer();
    wasmSizeEl.textContent = `wasm ${(bytes.byteLength / 1024).toFixed(1)} KB`;
    const module  = await WebAssembly.compile(bytes);
    rt = await createWasmRuntime(module, {
      onPrint(data, kind) {
        // 在代码执行 tab 的输出区拼接文字
        appendOut(execOutput, data, kind === "stderr" ? "e" : "s");
      },
    });
    setStatus("就绪 ✓", "ready");
    enableAll();
    await vfsRefresh();  // 初始化 VFS 文件树
  } catch (e) {
    setStatus(`初始化失败: ${(e as Error).message}`, "error");
  }
}

function enableAll(): void {
  document.querySelectorAll<HTMLButtonElement>("button[disabled]").forEach(b => {
    b.disabled = false;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Tab 1: 代码执行
// ═══════════════════════════════════════════════════════════════════════════

const execCode    = document.getElementById("exec-code")!    as HTMLTextAreaElement;
const execOutput  = document.getElementById("exec-output")!  as HTMLPreElement;
const execRunBtn  = document.getElementById("exec-run")!     as HTMLButtonElement;
const execClear   = document.getElementById("exec-clear")!   as HTMLButtonElement;
const execMode    = document.getElementById("exec-mode")!    as HTMLSelectElement;
const execPreset  = document.getElementById("exec-preset")!  as HTMLSelectElement;
const execExit    = document.getElementById("exec-exit-code")! as HTMLSpanElement;

const EXEC_PRESETS: Record<string, string> = {
  fizzbuzz: `// FizzBuzz 经典题
for (let i = 1; i <= 30; i++) {
  if (i % 15 === 0)     console.log("FizzBuzz");
  else if (i % 3 === 0) console.log("Fizz");
  else if (i % 5 === 0) console.log("Buzz");
  else                  console.log(i);
}`,
  fibonacci: `// 迭代 Fibonacci
function fib(n) {
  let [a, b] = [0n, 1n];
  const result = [];
  for (let i = 0; i < n; i++) {
    result.push(String(a));
    [a, b] = [b, a + b];
  }
  return result;
}
console.log(fib(20).join(", "));`,
  json: `// JSON 处理
const data = {
  users: [
    { id: 1, name: "Alice", score: 92 },
    { id: 2, name: "Bob",   score: 78 },
    { id: 3, name: "Carol", score: 88 },
  ]
};
const top = data.users
  .filter(u => u.score >= 80)
  .sort((a, b) => b.score - a.score);
console.log(JSON.stringify(top, null, 2));`,
  array: `// 数组函数式操作
const words = ["bun","wasm","browser","runtime","javascript","zig","webassembly"];
const result = words
  .filter(w => w.length > 4)
  .map(w => w[0].toUpperCase() + w.slice(1))
  .sort()
  .join(", ");
console.log(result);
console.log("总词数:", words.length, "/ 过滤后:", words.filter(w=>w.length>4).length);`,
  class: `// Class + 原型链
class Animal {
  constructor(name) { this.name = name; }
  speak() { return \`\${this.name} makes a sound.\`; }
}
class Dog extends Animal {
  speak() { return \`\${this.name} barks!\`; }
}
class Cat extends Animal {
  speak() { return \`\${this.name} meows.\`; }
}
const pets = [new Dog("Rex"), new Cat("Whiskers"), new Dog("Buddy")];
pets.forEach(p => console.log(p.constructor.name + ":", p.speak()));`,
  async: `// Generator（模拟异步流）
function* range(start, end, step = 1) {
  for (let i = start; i < end; i += step) yield i;
}
function* map(iter, fn) {
  for (const v of iter) yield fn(v);
}
function* filter(iter, pred) {
  for (const v of iter) if (pred(v)) yield v;
}
const pipeline = filter(map(range(1, 100), x => x * x), x => x % 7 === 0);
for (const v of pipeline) console.log(v);`,
  byteops: `// 字节/Buffer 操作
const text = "Hello, bun-browser 🎉";
const buf  = Buffer.from(text, "utf8");
console.log("原始:", text);
console.log("字节长度:", buf.length);
console.log("Hex 前16B:", buf.subarray(0, 16).toString("hex"));
console.log("Base64:", buf.toString("base64"));

// 二进制拼接
const a = Buffer.from([0xDE, 0xAD]);
const b = Buffer.from([0xBE, 0xEF]);
const c = Buffer.concat([a, b]);
console.log("Concat:", c.toString("hex"));`,
};

execPreset.addEventListener("change", () => {
  const val = execPreset.value;
  if (val && EXEC_PRESETS[val]) execCode.value = EXEC_PRESETS[val]!;
  execPreset.value = "";
});

function runExec(): void {
  if (!rt) return;
  clearOutput(execOutput);
  execRunBtn.disabled = true;
  setStatus("运行中…", "busy");

  const source = execCode.value;
  const mode   = execMode.value as "eval" | "run";

  try {
    let code = -1;
    if (mode === "eval") {
      const evalFn = rt.instance.exports.bun_browser_eval as
        (sp: number, sl: number, fp: number, fl: number) => number;
      rt.withString(source, (sp, sl) => {
        rt!.withString("<demo>", (fp, fl) => { code = evalFn(sp, sl, fp, fl); });
      });
    } else {
      const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
      const runFn  = rt.instance.exports.bun_browser_run as (p: number, l: number) => number;
      const snap   = buildSnapshot([{ path: "/main.js", data: source }]);
      rt.withBytes(new Uint8Array(snap), (p, l) => { loadFn(p, l); });
      rt.withString("/main.js", (p, l) => { code = runFn(p, l); });
    }
    appendOut(execOutput, `\n[exit ${code}]\n`, "x");
    execExit.textContent = code === 0 ? "✓ exit 0" : `✗ exit ${code}`;
    execExit.style.color = code === 0 ? "var(--green)" : "var(--red)";
    setStatus(code === 0 ? "就绪 ✓" : `退出码 ${code}`, code === 0 ? "ready" : "error");
  } catch (e) {
    appendOut(execOutput, `\n[error] ${(e as Error).message}\n`, "e");
    setStatus("运行出错", "error");
  } finally {
    execRunBtn.disabled = false;
  }
}

execRunBtn.addEventListener("click", runExec);
execClear.addEventListener("click", () => { clearOutput(execOutput); execExit.textContent = ""; });
execCode.addEventListener("keydown", handleEditorKey);

// ═══════════════════════════════════════════════════════════════════════════
// Tab 2: TypeScript 转译
// ═══════════════════════════════════════════════════════════════════════════

const tsInput  = document.getElementById("ts-input")!  as HTMLTextAreaElement;
const tsOutput = document.getElementById("ts-output")! as HTMLPreElement;
const tsRunBtn = document.getElementById("ts-run")!    as HTMLButtonElement;
const tsErrors = document.getElementById("ts-errors")! as HTMLSpanElement;
const tsPreset = document.getElementById("ts-preset")! as HTMLSelectElement;

const TS_PRESETS: Record<string, string> = {
  "ts-class": `// TypeScript 泛型 + 类 + 接口
interface Repository<T extends { id: number }> {
  findById(id: number): T | undefined;
  save(item: T): void;
  list(): T[];
}

class InMemoryRepo<T extends { id: number }> implements Repository<T> {
  private store = new Map<number, T>();
  findById(id: number): T | undefined { return this.store.get(id); }
  save(item: T): void { this.store.set(item.id, item); }
  list(): T[] { return [...this.store.values()]; }
}

interface Product { id: number; name: string; price: number; }

const repo = new InMemoryRepo<Product>();
repo.save({ id: 1, name: "Bun", price: 0 });
repo.save({ id: 2, name: "Deno", price: 0 });

const bun = repo.findById(1);
console.log(bun?.name);`,

  "ts-decorator": `// 模拟装饰器模式（TS 3.x legacy）
function log(target: any, key: string, descriptor: PropertyDescriptor) {
  const orig = descriptor.value;
  descriptor.value = function (...args: unknown[]) {
    console.log(\`[log] \${key}(\${args.join(", ")})\`);
    return orig.apply(this, args);
  };
  return descriptor;
}

class Calculator {
  add(a: number, b: number): number { return a + b; }
  mul(a: number, b: number): number { return a * b; }
}

const c = new Calculator();
console.log(c.add(3, 4));
console.log(c.mul(6, 7));`,

  "tsx-react": `// React JSX (转译验证)
import React from "react";

interface Props {
  name: string;
  count?: number;
}

function Counter({ name, count = 0 }: Props) {
  return (
    <div className="counter">
      <h1>Hello, {name}!</h1>
      <p>Count: <strong>{count}</strong></p>
    </div>
  );
}

export default Counter;`,

  "ts-enum": `// Enum + 类型守卫 + 条件类型
enum Direction { Up = "UP", Down = "DOWN", Left = "LEFT", Right = "RIGHT" }

type Opposite<D extends Direction> =
  D extends Direction.Up    ? Direction.Down  :
  D extends Direction.Down  ? Direction.Up    :
  D extends Direction.Left  ? Direction.Right :
  Direction.Left;

function isHorizontal(d: Direction): d is Direction.Left | Direction.Right {
  return d === Direction.Left || d === Direction.Right;
}

const dir = Direction.Up;
console.log(dir, "is horizontal:", isHorizontal(dir));

const dirs = Object.values(Direction);
dirs.forEach(d => console.log(d, "→ horizontal:", isHorizontal(d)));`,
};

tsPreset.addEventListener("change", () => {
  const val = tsPreset.value;
  if (val && TS_PRESETS[val]) tsInput.value = TS_PRESETS[val]!;
  tsPreset.value = "";
});

tsRunBtn.addEventListener("click", () => {
  if (!rt) return;
  const source   = tsInput.value;
  const filename = source.includes("JSX") || source.includes("tsx") ? "demo.tsx" : "demo.ts";
  const result   = rt.transform(source, filename, { jsx: "react" });
  if (!result) {
    tsOutput.textContent = "[bun_transform 未导出]";
    return;
  }
  if (result.errors && result.errors.length > 0) {
    tsErrors.textContent = result.errors.join(" | ");
    tsOutput.textContent = result.code ?? "";
  } else {
    tsErrors.textContent = "";
    tsOutput.textContent = result.code ?? "";
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Tab 3: Bundler
// ═══════════════════════════════════════════════════════════════════════════

const bundleInput  = document.getElementById("bundle-input")!  as HTMLTextAreaElement;
const bundleOutput = document.getElementById("bundle-output")! as HTMLPreElement;
const bundleRunBtn = document.getElementById("bundle-run")!    as HTMLButtonElement;
const bundlePreset = document.getElementById("bundle-preset")! as HTMLSelectElement;

const BUNDLE_CONFIGS: Record<string, { files: Record<string, string>; entry: string; define?: Record<string,string>; external?: string[] }> = {
  "multi-module": {
    entry: "/src/index.js",
    files: {
      "/src/utils.js": `export function add(a, b) { return a + b; }
export function mul(a, b) { return a * b; }
export const PI = 3.14159265358979;`,
      "/src/math.js": `import { add, mul, PI } from "./utils.js";
export function circleArea(r) { return mul(PI, mul(r, r)); }
export function sum(...xs) { return xs.reduce(add, 0); }`,
      "/src/index.js": `import { circleArea, sum } from "./math.js";
import { PI } from "./utils.js";
console.log("π =", PI);
console.log("circle(5) =", circleArea(5).toFixed(4));
console.log("sum(1..10) =", sum(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));`,
    },
  },
  "define": {
    entry: "/app.js",
    define: { "process.env.NODE_ENV": '"production"', "__DEV__": "false", "APP_VERSION": '"1.2.3"' },
    files: {
      "/app.js": `const isDev    = __DEV__;
const env      = process.env.NODE_ENV;
const version  = APP_VERSION;

if (isDev) {
  console.log("[dev] debug tools enabled");
} else {
  console.log("[prod] 精简模式");
}
console.log("env:", env, "version:", version);`,
    },
  },
  "external": {
    entry: "/main.js",
    external: ["react", "react-dom"],
    files: {
      "/main.js": `import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  return React.createElement("h1", null, "Hello bun-browser!");
}

const root = createRoot(document.getElementById("root"));
root.render(React.createElement(App));
console.log("React 版本:", React.version);`,
    },
  },
};

function setBundleDisplay(entry: string, files: Record<string,string>): void {
  const lines: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    lines.push(`// ── ${path} ${"─".repeat(Math.max(0, 44 - path.length))}`);
    lines.push(content);
    lines.push("");
  }
  bundleInput.value = lines.join("\n");
}

bundlePreset.addEventListener("change", () => {
  const cfg = BUNDLE_CONFIGS[bundlePreset.value];
  if (cfg) setBundleDisplay(cfg.entry, cfg.files);
  bundlePreset.value = "";
});

// seed default
setBundleDisplay(BUNDLE_CONFIGS["multi-module"]!.entry, BUNDLE_CONFIGS["multi-module"]!.files);

bundleRunBtn.addEventListener("click", () => {
  if (!rt) return;

  // determine which preset is being shown by checking bundleInput content
  const selectedKey = Object.keys(BUNDLE_CONFIGS).find(k => {
    const cfg = BUNDLE_CONFIGS[k]!;
    return Object.values(cfg.files).some(v => bundleInput.value.includes(v.slice(0, 30)));
  }) ?? "multi-module";

  const cfg = BUNDLE_CONFIGS[selectedKey]!;

  // write files into VFS
  const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
  const files  = Object.entries(cfg.files).map(([path, data]) => ({ path, data }));
  const snap   = buildSnapshot(files);
  rt.withBytes(new Uint8Array(snap), (p, l) => { loadFn(p, l); });

  // call bundle2
  try {
    const out = rt.bundle2({
      entrypoint: cfg.entry,
      ...(cfg.external ? { external: cfg.external } : {}),
      ...(cfg.define   ? { define:   cfg.define }   : {}),
    });
    bundleOutput.textContent = out;
  } catch (e) {
    bundleOutput.textContent = `[error] ${(e as Error).message}`;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Tab 4: VFS 文件系统
// ═══════════════════════════════════════════════════════════════════════════

const vfsTree    = document.getElementById("vfs-tree")!    as HTMLDivElement;
const vfsContent = document.getElementById("vfs-content")! as HTMLPreElement;
const vfsOpenName = document.getElementById("vfs-open-name")! as HTMLSpanElement;
const vfsNewPath  = document.getElementById("vfs-new-path")!  as HTMLInputElement;
const vfsRefreshBtn = document.getElementById("vfs-refresh")! as HTMLButtonElement;
const vfsMkdirBtn   = document.getElementById("vfs-mkdir-btn")! as HTMLButtonElement;
const vfsWriteBtn   = document.getElementById("vfs-write-btn")! as HTMLButtonElement;
const vfsRmBtn      = document.getElementById("vfs-rm-btn")!   as HTMLButtonElement;
const vfsRunBtn     = document.getElementById("vfs-run-btn")!  as HTMLButtonElement;
const vfsExportBtn  = document.getElementById("vfs-export-btn")! as HTMLButtonElement;

let vfsCurrentFile = "";

/** 递ursively list files under a directory from VFS snapshot */
async function vfsRefresh(): Promise<void> {
  if (!rt) return;
  setStatus("刷新 VFS…", "busy");

  try {
    // Dump full VFS snapshot and parse it
    const dumpFn = rt.instance.exports.bun_vfs_dump_snapshot as (() => number) | undefined;
    if (!dumpFn) {
      // fallback: write seed files so tree is non-empty
      await seedVfs();
      vfsTree.textContent = "(bun_vfs_dump_snapshot 未导出，已写入种子文件)";
      setStatus("就绪 ✓", "ready");
      return;
    }

    // call dump then read the result
    const ptr = dumpFn();
    if (!ptr) {
      vfsTree.innerHTML = "<span style='color:var(--text-dim);padding:8px;display:block'>(VFS 为空)</span>";
      setStatus("就绪 ✓", "ready");
      return;
    }

    // read length-prefixed bytes at ptr
    const mem = new DataView((rt.instance.exports.memory as WebAssembly.Memory).buffer);
    const len = mem.getUint32(ptr, true);
    const data = new Uint8Array((rt.instance.exports.memory as WebAssembly.Memory).buffer, ptr + 4, len);
    const files = parseSnapshot(data.buffer.slice(data.byteOffset, data.byteOffset + len));

    renderVfsTree(files.map(f => ({
      path: f.path,
      size: typeof f.data === "string" ? f.data.length : (f.data as Uint8Array).byteLength,
    })));
    setStatus("就绪 ✓", "ready");
  } catch {
    // try with seed approach
    await seedVfs();
    setStatus("就绪 ✓", "ready");
  }
}

async function seedVfs(): Promise<void> {
  if (!rt) return;
  const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number | undefined;
  if (!loadFn) return;

  const files = [
    { path: "/README.md",        data: "# bun-browser VFS demo\n\nVirtual file system running entirely in WebAssembly.\n" },
    { path: "/src/index.js",     data: "const greeting = 'Hello from VFS!';\nconsole.log(greeting);\n" },
    { path: "/src/utils.js",     data: "export const add = (a, b) => a + b;\nexport const PI = 3.14159;\n" },
    { path: "/data/config.json", data: JSON.stringify({ version: "1.0.0", env: "browser", wasm: true }, null, 2) + "\n" },
    { path: "/data/sample.txt",  data: "The quick brown fox jumps over the lazy dog.\n敏捷的棕色狐狸跳过了懒惰的狗。\n" },
  ];

  const snap = buildSnapshot(files);
  rt.withBytes(new Uint8Array(snap), (p, l) => { (loadFn as (p:number,l:number)=>number)(p, l); });

  renderVfsTree(files.map(f => ({ path: f.path, size: (f.data as string).length })));
}

function renderVfsTree(files: { path: string; size: number }[]): void {
  if (files.length === 0) {
    vfsTree.innerHTML = "<span style='color:var(--text-dim);padding:8px;display:block'>(VFS 为空)</span>";
    return;
  }
  vfsTree.innerHTML = "";
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    const el  = document.createElement("div");
    el.className = "vfs-entry";
    const ext = f.path.split(".").pop() ?? "";
    const icon = { js: "JS", ts: "TS", json: "{}",  md: "#", txt: "T", html: "<>", css: "CSS" }[ext] ?? "•";
    el.innerHTML = `<span class="icon">${icon}</span><span class="name">${f.path}</span><span class="size">${f.size}B</span>`;
    el.addEventListener("click", () => openVfsFile(f.path));
    vfsTree.appendChild(el);
  }
}

function openVfsFile(path: string): void {
  if (!rt) return;
  vfsCurrentFile = path;
  vfsOpenName.textContent = path;
  vfsRunBtn.disabled = !path.endsWith(".js");

  const readFn = rt.instance.exports.bun_vfs_read_file as ((p: number, l: number) => bigint) | undefined;
  if (!readFn) {
    vfsContent.textContent = "(bun_vfs_read_file 未导出)";
    return;
  }

  try {
    let packed = 0n;
    rt.withString(path, (pp, pl) => { packed = readFn(pp, pl); });
    const ptr = Number(packed >> 32n);
    const len = Number(packed & 0xffff_ffffn);
    if (ptr === 0 || len === 0) {
      vfsContent.textContent = "(文件不存在或为空)";
      return;
    }
    const mem = (rt.instance.exports.memory as WebAssembly.Memory).buffer;
    const bytes = new Uint8Array(mem, ptr, len).slice();
    const freeFn = rt.instance.exports.bun_free as ((p: number) => void) | undefined;
    freeFn?.(ptr);
    vfsContent.textContent = new TextDecoder().decode(bytes);
  } catch (e) {
    vfsContent.textContent = `(error: ${(e as Error).message})`;
  }
}

vfsRefreshBtn.addEventListener("click", () => vfsRefresh());

vfsMkdirBtn.addEventListener("click", () => {
  const p = vfsNewPath.value.trim();
  if (!p || !rt) return;
  // mkdir: write a .gitkeep file under the directory
  const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
  const keepPath = p.endsWith("/") ? p + ".gitkeep" : p + "/.gitkeep";
  const snap = buildSnapshot([{ path: keepPath, data: "" }]);
  rt.withBytes(new Uint8Array(snap), (pp, l) => { loadFn(pp, l); });
  vfsTree.innerHTML += `<div style="color:var(--green);padding:4px 8px;font-size:0.78rem">✓ mkdir ${p}</div>`;
});

vfsWriteBtn.addEventListener("click", () => {
  const p = vfsNewPath.value.trim();
  if (!p || !rt) return;
  const content = prompt(`写入文件内容 (${p})：`, "console.log('hello from vfs!');");
  if (content === null) return;
  const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
  const snap   = buildSnapshot([{ path: p, data: content }]);
  rt.withBytes(new Uint8Array(snap), (pp, l) => { loadFn(pp, l); });
  vfsTree.innerHTML += `<div style="color:var(--green);padding:4px 8px;font-size:0.78rem">✓ 已写入 ${p} (${content.length}B)</div>`;
});

vfsRmBtn.addEventListener("click", () => {
  alert("rm：仅 Kernel API（含 Worker）完整实现。当前 demo 使用 Direct WASM 模式，暂不支持删除操作。");
});

vfsRunBtn.addEventListener("click", () => {
  if (!rt || !vfsCurrentFile) return;
  const runFn = rt.instance.exports.bun_browser_run as (p: number, l: number) => number;
  clearOutput(execOutput);
  document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".tab-page").forEach(p => p.classList.remove("active"));
  document.querySelector('[data-tab="exec"]')!.classList.add("active");
  document.getElementById("tab-exec")!.classList.add("active");
  let code = -1;
  rt.withString(vfsCurrentFile, (p, l) => { code = runFn(p, l); });
  appendOut(execOutput, `\n[exit ${code}]\n`, "x");
});

vfsExportBtn.addEventListener("click", () => {
  if (!rt) return;
  const res = ["/README.md","/src/index.js","/src/utils.js","/data/config.json","/data/sample.txt"];
  const msg = res.map(p => `  "${p}"`).join(",\n");
  alert(`已挂载的 VFS 文件路径（种子）：\n[\n${msg}\n]\n\n(完整 exportFs 需要 Kernel API + Worker)`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Tab 5: 加密 & 压缩
// ═══════════════════════════════════════════════════════════════════════════

// -- Hash --
const hashInput  = document.getElementById("hash-input")!  as HTMLTextAreaElement;
const hashAlgo   = document.getElementById("hash-algo")!   as HTMLSelectElement;
const hashResult = document.getElementById("hash-result")! as HTMLDivElement;
document.getElementById("hash-run")!.addEventListener("click", () => {
  if (!rt) return;
  const enc  = new TextEncoder();
  const data = enc.encode(hashInput.value);
  const algo = Number(hashAlgo.value) as 0 | 1 | 2 | 3 | 4;
  const out  = rt.hash(algo, data);
  if (!out) { hashResult.textContent = "[bun_hash 未导出]"; return; }
  hashResult.textContent = Array.from(out).map(b => b.toString(16).padStart(2, "0")).join("");
});

// -- Base64 --
const b64Input  = document.getElementById("b64-input")!  as HTMLTextAreaElement;
const b64Result = document.getElementById("b64-result")! as HTMLDivElement;
document.getElementById("b64-encode")!.addEventListener("click", () => {
  if (!rt) return;
  const bytes = new TextEncoder().encode(b64Input.value);
  const out   = rt.base64Encode(bytes);
  b64Result.textContent = out !== null ? out : "[bun_base64_encode 未导出]";
});
document.getElementById("b64-decode")!.addEventListener("click", () => {
  if (!rt) return;
  try {
    const out = rt.base64Decode(b64Input.value.trim());
    b64Result.textContent = out !== null ? new TextDecoder().decode(out) : "[bun_base64_decode 未导出]";
  } catch (e) {
    b64Result.textContent = `[error] ${(e as Error).message}`;
  }
});

// -- Deflate / Inflate --
const compressInput  = document.getElementById("compress-input")!  as HTMLTextAreaElement;
const compressResult = document.getElementById("compress-result")! as HTMLDivElement;
const compressInfo   = document.getElementById("compress-info")!   as HTMLDivElement;
const compressFmt    = document.getElementById("compress-fmt")!    as HTMLSelectElement;

let _lastCompressed: Uint8Array | null = null;

document.getElementById("deflate-run")!.addEventListener("click", () => {
  if (!rt) return;
  const enc  = new TextEncoder();
  const data = enc.encode(compressInput.value);
  const fmt  = compressFmt.value as "gzip" | "zlib" | "raw";
  const out  = rt.deflate(data, fmt);
  if (!out) { compressResult.textContent = "[bun_deflate 未导出]"; return; }
  _lastCompressed = out;
  const ratio = ((1 - out.byteLength / data.byteLength) * 100).toFixed(1);
  compressResult.textContent = `[${fmt}] ${out.byteLength} bytes — Hex: ` +
    Array.from(out.subarray(0, 16)).map(b => b.toString(16).padStart(2, "0")).join(" ") + "…";
  compressInfo.textContent = `原始 ${data.byteLength}B → 压缩 ${out.byteLength}B (压缩率 ${ratio}%)`;
});

document.getElementById("inflate-run")!.addEventListener("click", () => {
  if (!rt) return;
  const fmt = compressFmt.value as "gzip" | "zlib" | "raw";
  const src = _lastCompressed ?? new TextEncoder().encode(compressInput.value);
  try {
    const out = rt.inflate(src, fmt);
    if (!out) { compressResult.textContent = "[bun_inflate 未导出]"; return; }
    compressResult.textContent = new TextDecoder().decode(out);
    compressInfo.textContent = `解压后 ${out.byteLength}B`;
  } catch (e) {
    compressResult.textContent = `[error] ${(e as Error).message}`;
  }
});

// -- SRI Integrity --
const integrityData   = document.getElementById("integrity-data")!   as HTMLTextAreaElement;
const integritySri    = document.getElementById("integrity-sri")!     as HTMLInputElement;
const integrityResult = document.getElementById("integrity-result")!  as HTMLDivElement;

document.getElementById("integrity-gen")!.addEventListener("click", () => {
  if (!rt) return;
  const data = new TextEncoder().encode(integrityData.value);
  const hash = rt.hash(1, data); // SHA-256
  if (!hash) { integrityResult.textContent = "[bun_hash 未导出]"; return; }
  const b64  = rt.base64Encode(hash);
  if (!b64)  { integrityResult.textContent = "[bun_base64_encode 未导出]"; return; }
  integritySri.value = `sha256-${b64}`;
  integrityResult.textContent = `已生成 SRI: sha256-${b64}`;
});

document.getElementById("integrity-verify")!.addEventListener("click", () => {
  if (!rt) return;
  const data = new TextEncoder().encode(integrityData.value);
  const sri  = integritySri.value.trim();
  const res  = rt.integrityVerify(data, sri);
  const COLOR = { ok: "var(--green)", fail: "var(--red)", bad: "var(--yellow)" } as const;
  integrityResult.style.color = COLOR[res];
  integrityResult.textContent = res === "ok" ? "✓ 完整性校验通过" : res === "fail" ? "✗ 哈希不匹配" : "⚠ SRI 格式错误";
});

// ═══════════════════════════════════════════════════════════════════════════
// Tab 6: 路径 & URL
// ═══════════════════════════════════════════════════════════════════════════

document.getElementById("path-run")!.addEventListener("click", () => {
  if (!rt) return;
  const base = (document.getElementById("path-base")! as HTMLInputElement).value;
  const rel  = (document.getElementById("path-rel")!  as HTMLInputElement).value;

  const norm = rt.pathNormalize(base);
  const join = rt.pathJoin(base, rel);
  const dir  = join ? rt.pathDirname(join) : null;

  setResult(document.getElementById("path-normalize")! as HTMLElement, norm !== null ? norm : "[未导出]", norm === null);
  setResult(document.getElementById("path-join")!      as HTMLElement, join !== null ? join : "[未导出]", join === null);
  setResult(document.getElementById("path-dirname")!   as HTMLElement, dir  !== null ? dir  : "[未导出]", dir  === null);
});

document.getElementById("url-run")!.addEventListener("click", () => {
  if (!rt) return;
  const url = (document.getElementById("url-input")! as HTMLInputElement).value;
  const res = rt.urlParse(url);
  const out = document.getElementById("url-result")! as HTMLElement;
  if (!res) { setResult(out, "[bun_url_parse 未导出或解析失败]", true); return; }
  setResult(out, JSON.stringify(res, null, 2));
});

document.getElementById("sv2-run")!.addEventListener("click", () => {
  if (!rt) return;
  const versions = (document.getElementById("sv2-versions")! as HTMLInputElement).value;
  const range    = (document.getElementById("sv2-range")!    as HTMLInputElement).value;
  const out      = document.getElementById("sv2-result")!    as HTMLElement;
  try {
    const result = rt.semverSelect(versions, range);
    setResult(out, result !== null ? `✓ ${result}` : "(无匹配版本)", result === null);
  } catch (e) {
    setResult(out, `[error] ${(e as Error).message}`, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Tab 7: Semver 矩阵 + Lockfile
// ═══════════════════════════════════════════════════════════════════════════

const SEMVER_RANGES = ["*", "^1.0.0", "^2.0.0", "~1.2.0", ">=2.0.0 <3.0.0", "2.1.0-beta.1", "3.0.0-rc.1", "latest"];

document.getElementById("sv-run")!.addEventListener("click", () => {
  if (!rt) return;
  const versionsJson = (document.getElementById("sv-versions")! as HTMLInputElement).value;
  let versions: string[];
  try { versions = JSON.parse(versionsJson); }
  catch { document.getElementById("sv-matrix")!.innerHTML = '<div style="color:var(--red)">JSON 格式错误</div>'; return; }

  const table = document.createElement("table");
  table.style.cssText = "width:100%;border-collapse:collapse;font-size:0.78rem;font-family:var(--font-mono)";

  // header
  const hrow = table.insertRow();
  hrow.insertCell().textContent = "Range";
  (hrow.cells[0] as HTMLElement).style.cssText = "padding:4px 8px;color:var(--text-dim);border-bottom:1px solid var(--border)";
  hrow.insertCell().textContent = "选中版本";
  (hrow.cells[1] as HTMLElement).style.cssText = "padding:4px 8px;color:var(--text-dim);border-bottom:1px solid var(--border)";

  for (const range of SEMVER_RANGES) {
    let result: string | null = null;
    try { result = rt!.semverSelect(versionsJson, range); } catch {}
    const row   = table.insertRow();
    const cellA = row.insertCell();
    const cellB = row.insertCell();
    cellA.textContent = range;
    cellA.style.cssText = "padding:3px 8px;color:var(--yellow);border-bottom:1px solid #2a2a2a";
    if (result !== null) {
      cellB.innerHTML = `<span class="tag tag-green">${result}</span>`;
    } else {
      cellB.innerHTML = `<span class="tag tag-red">无匹配</span>`;
    }
    cellB.style.cssText = "padding:3px 8px;border-bottom:1px solid #2a2a2a";
  }

  document.getElementById("sv-matrix")!.innerHTML = "";
  document.getElementById("sv-matrix")!.appendChild(table);
});

document.getElementById("lockfile-run")!.addEventListener("click", () => {
  if (!rt) return;
  const text = (document.getElementById("lockfile-input")! as HTMLTextAreaElement).value;
  const out  = document.getElementById("lockfile-result")! as HTMLElement;
  try {
    const summary = rt.parseLockfile(text);
    setResult(out, JSON.stringify(summary, null, 2));
  } catch (e) {
    setResult(out, `[error] ${(e as Error).message}`, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Tab 8: 生态验证 — npm / Node.js / Vite / Vite React TypeScript
// ═══════════════════════════════════════════════════════════════════════════

// ── 8A: npm / package.json 依赖解析 ────────────────────────────────────────

// 每个包的 "可用版本" 模拟（真实项目中来自 registry metadata）
const MOCK_REGISTRY: Record<string, string[]> = {
  react:        ["16.14.0","17.0.2","18.0.0","18.1.0","18.2.0","18.3.0"],
  "react-dom":  ["16.14.0","17.0.2","18.0.0","18.1.0","18.2.0","18.3.0"],
  lodash:       ["4.14.0","4.16.0","4.17.0","4.17.15","4.17.21"],
  axios:        ["1.0.0","1.1.0","1.3.0","1.6.0","1.6.7","1.7.0"],
  zod:          ["3.18.0","3.20.0","3.22.0","3.22.4","3.23.0"],
  typescript:   ["4.9.0","5.0.4","5.1.0","5.2.0","5.4.5","5.5.0"],
  vite:         ["4.0.0","4.5.0","5.0.0","5.1.0","5.2.0","5.3.0"],
};

document.getElementById("npm-run")!.addEventListener("click", () => {
  if (!rt) return;
  const npmResult = document.getElementById("npm-result")!;
  const npmBadge  = document.getElementById("npm-badge")! as HTMLElement;

  let pkg: { dependencies?: Record<string,string>; devDependencies?: Record<string,string>; name?: string };
  try {
    pkg = JSON.parse((document.getElementById("npm-pkgjson")! as HTMLTextAreaElement).value);
  } catch (e) {
    npmResult.textContent = `[JSON 解析失败] ${(e as Error).message}`;
    npmResult.classList.add("err");
    return;
  }
  npmResult.classList.remove("err");

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const lines: string[] = [`# ${pkg.name ?? "package"} — 依赖解析结果\n`];
  let okCount = 0;
  let missing = 0;

  for (const [name, range] of Object.entries(allDeps)) {
    const versions = MOCK_REGISTRY[name];
    if (!versions) {
      lines.push(`  ✗ ${name.padEnd(18)} ${range.padEnd(12)} (registry 未收录，真实场景需 fetch)`);
      missing++;
      continue;
    }
    try {
      const selected = rt!.semverSelect(JSON.stringify(versions), range);
      if (selected) {
        lines.push(`  ✓ ${name.padEnd(18)} ${range.padEnd(12)} → ${selected}`);
        okCount++;
      } else {
        lines.push(`  ✗ ${name.padEnd(18)} ${range.padEnd(12)} → (无匹配版本)`);
        missing++;
      }
    } catch {
      lines.push(`  ! ${name.padEnd(18)} ${range.padEnd(12)} → [semver 错误]`);
      missing++;
    }
  }

  lines.push(`\n解析完成: ${okCount} 已解析，${missing} 待 fetch`);
  npmResult.textContent = lines.join("\n");
  npmBadge.style.display = "inline-flex";
  npmBadge.textContent   = `${okCount}/${okCount + missing} resolved`;
});

// ── 8B: Node.js 内置 API 兼容验证 ──────────────────────────────────────────

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

// Pipeline: 读取 → 过滤 → 转换 → 聚合
const INPUT  = [1,2,3,4,5,6,7,8,9,10,11,12];
const result = reduce(
  map(filter(INPUT, x => x % 2 === 0), x => x * x),
  (acc, x) => acc + x,
  0
);
console.log("偶数平方和:", result);

// 模拟分块处理
const CHUNK_SIZE = 4;
for (let i = 0; i < INPUT.length; i += CHUNK_SIZE) {
  const chunk = INPUT.slice(i, i + CHUNK_SIZE);
  console.log("chunk:", JSON.stringify(chunk));
}`,

  util: `// Node.js: util + assert
const util   = require("util");
const assert = require("assert");

// util.format
console.log(util.format("Hello, %s! You are %d years old.", "Bun", 2));
console.log(util.format("Data: %j", { ok: true, version: "1.0" }));

// util.inspect
const obj = { name: "bun", nested: { wasm: true, features: ["eval","run","bundle"] } };
console.log(util.inspect(obj, { depth: 2, colors: false }));

// assert
try {
  assert.strictEqual(1 + 1, 2);
  assert.ok(typeof "bun" === "string");
  assert.deepStrictEqual([1,2,3], [1,2,3]);
  console.log("assert: 全部通过 ✓");
} catch (e) {
  console.error("assert 失败:", e.message);
}`,
};

const nodejsCode    = document.getElementById("nodejs-code")!   as HTMLTextAreaElement;
const nodejsOutput  = document.getElementById("nodejs-output")! as HTMLPreElement;
const nodejsPreset  = document.getElementById("nodejs-preset")! as HTMLSelectElement;
const nodejsExit    = document.getElementById("nodejs-exit")!   as HTMLSpanElement;
const nodejsRunBtn  = document.getElementById("nodejs-run")!    as HTMLButtonElement;
const nodejsClear   = document.getElementById("nodejs-clear")!  as HTMLButtonElement;

function loadNodejsPreset(): void {
  const val = nodejsPreset.value;
  if (NODEJS_PRESETS[val]) nodejsCode.value = NODEJS_PRESETS[val]!;
}
nodejsPreset.addEventListener("change", loadNodejsPreset);
// seed first preset on page load
setTimeout(loadNodejsPreset, 0);

nodejsRunBtn.addEventListener("click", () => {
  if (!rt) return;
  clearOutput(nodejsOutput);
  setStatus("运行中…", "busy");

  // redirect onPrint to nodejs output
  const savedOnPrint = (rt as any)._onPrint;
  (rt as any)._onPrint = (data: string, kind: string) => {
    appendOut(nodejsOutput, data, kind === "stderr" ? "e" : "s");
  };

  const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
  const runFn  = rt.instance.exports.bun_browser_run as (p: number, l: number) => number;
  const snap   = buildSnapshot([{ path: "/nodejs-demo.js", data: nodejsCode.value }]);
  rt.withBytes(new Uint8Array(snap), (p, l) => { loadFn(p, l); });

  let code = -1;
  rt.withString("/nodejs-demo.js", (p, l) => { code = runFn(p, l); });
  appendOut(nodejsOutput, `\n[exit ${code}]\n`, "x");
  nodejsExit.textContent = code === 0 ? "✓ exit 0" : `✗ exit ${code}`;
  nodejsExit.style.color = code === 0 ? "var(--green)" : "var(--red)";
  setStatus(code === 0 ? "就绪 ✓" : `退出码 ${code}`, code === 0 ? "ready" : "error");
  (rt as any)._onPrint = savedOnPrint;
});

nodejsClear.addEventListener("click", () => { clearOutput(nodejsOutput); nodejsExit.textContent = ""; });

// ── 8C: Vite 构建模拟 ────────────────────────────────────────────────────────

const VITE_PRESETS: Record<string, { label: string; files: Record<string,string>; entry: string; define: Record<string,string>; external?: string[] }> = {
  basic: {
    label: "Vite 基础 define 替换",
    entry: "/src/main.js",
    define: {
      "import.meta.env.PROD":       "true",
      "import.meta.env.DEV":        "false",
      "import.meta.env.MODE":       '"production"',
      "import.meta.env.BASE_URL":   '"/"',
      "__VITE_IS_MODERN__":         "true",
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
    define: {
      "__PLUGIN_API_VERSION__": '"3"',
      "process.env.NODE_ENV":   '"production"',
    },
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
    define: {
      "import.meta.env.SSR":  "true",
      "import.meta.env.PROD": "true",
    },
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

const viteInput    = document.getElementById("vite-input")!    as HTMLTextAreaElement;
const viteOutput   = document.getElementById("vite-output")!   as HTMLPreElement;
const vitePreset   = document.getElementById("vite-preset")!   as HTMLSelectElement;
const viteTransBtn = document.getElementById("vite-transform")! as HTMLButtonElement;
const viteBundleBtn= document.getElementById("vite-bundle")!   as HTMLButtonElement;

function loadVitePreset(): void {
  const cfg = VITE_PRESETS[vitePreset.value];
  if (!cfg) return;
  const lines: string[] = [];
  for (const [path, content] of Object.entries(cfg.files)) {
    lines.push(`// ── ${path} ${"─".repeat(Math.max(0, 44 - path.length))}`);
    lines.push(content);
    lines.push("");
  }
  viteInput.value = lines.join("\n");
}
vitePreset.addEventListener("change", loadVitePreset);
setTimeout(loadVitePreset, 0);

viteTransBtn.addEventListener("click", () => {
  if (!rt) return;
  const cfg = VITE_PRESETS[vitePreset.value];
  if (!cfg) return;

  // transform entry file as TS (since Vite uses esbuild under the hood)
  const entryContent = cfg.files[cfg.entry] ?? Object.values(cfg.files).at(-1)!;
  const result = rt.transform(entryContent, cfg.entry.replace(".js", ".ts"), {});
  if (!result) { viteOutput.textContent = "[bun_transform 未导出]"; return; }
  viteOutput.textContent = `// Vite-style transform (${cfg.entry})\n// define: ${JSON.stringify(cfg.define)}\n\n${result.code ?? ""}`;
});

viteBundleBtn.addEventListener("click", () => {
  if (!rt) return;
  const cfg = VITE_PRESETS[vitePreset.value];
  if (!cfg) return;

  const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
  const files  = Object.entries(cfg.files).map(([path, data]) => ({ path, data }));
  const snap   = buildSnapshot(files);
  rt.withBytes(new Uint8Array(snap), (p, l) => { loadFn(p, l); });

  try {
    const out = rt.bundle2({
      entrypoint: cfg.entry,
      define:     cfg.define,
      ...(cfg.external ? { external: cfg.external } : {}),
    });
    viteOutput.textContent = `// Vite bundle output\n// define: ${JSON.stringify(cfg.define)}\n\n${out}`;
  } catch (e) {
    viteOutput.textContent = `[error] ${(e as Error).message}`;
  }
});

// ── 8D: Vite + React + TypeScript 完整项目 ────────────────────────────────

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

const vrtFile       = document.getElementById("vrt-file")!      as HTMLSelectElement;
const vrtOutput     = document.getElementById("vrt-output")!    as HTMLPreElement;
const vrtTransBtn   = document.getElementById("vrt-transform")! as HTMLButtonElement;
const vrtBundleBtn  = document.getElementById("vrt-bundle-all")! as HTMLButtonElement;

vrtTransBtn.addEventListener("click", () => {
  if (!rt) return;
  const filename = vrtFile.value;
  const source   = VRT_FILES[filename];
  if (!source) { vrtOutput.textContent = "[文件不存在]"; return; }

  const result = rt.transform(source, filename, { jsx: "react" });
  if (!result) { vrtOutput.textContent = "[bun_transform 未导出]"; return; }

  const header = `// ── ${filename} (转译结果) ${"─".repeat(Math.max(0, 40 - filename.length))}\n\n`;
  if (result.errors?.length) {
    vrtOutput.textContent = header + `// Errors: ${result.errors.join("; ")}\n\n${result.code ?? ""}`;
  } else {
    vrtOutput.textContent = header + (result.code ?? "");
  }
});

vrtBundleBtn.addEventListener("click", () => {
  if (!rt) return;

  // 1. Write all VRT files to VFS (transformed to JS first using bun_transform)
  const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
  const vfsFiles: { path: string; data: string }[] = [];

  for (const [filename, source] of Object.entries(VRT_FILES)) {
    const result = rt!.transform(source, filename, { jsx: "react" });
    const jsPath = "/vrt/" + filename.replace(/\.tsx?$/, ".js");
    vfsFiles.push({ path: jsPath, data: result?.code ?? source });
  }

  const snap = buildSnapshot(vfsFiles);
  rt.withBytes(new Uint8Array(snap), (p, l) => { loadFn(p, l); });

  // 2. Bundle from /vrt/main.js with React as external
  try {
    const out = rt.bundle2({
      entrypoint: "/vrt/main.js",
      external:   ["react", "react-dom", "react-dom/client"],
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.env.PROD": "true",
      },
    });
    const kb = (out.length / 1024).toFixed(1);
    vrtOutput.textContent =
      `// Vite React TS — Bundle 完成\n` +
      `// 文件数: ${vfsFiles.length}  输出大小: ${kb} KB  externals: react, react-dom\n\n` +
      out;
  } catch (e) {
    vrtOutput.textContent = `[bundle error] ${(e as Error).message}`;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Tab 9: npm 包安装
// ═══════════════════════════════════════════════════════════════════════════

const npmInstallDeps       = document.getElementById("npm-install-deps")!       as HTMLTextAreaElement;
const npmInstallProgress   = document.getElementById("npm-install-progress")!   as HTMLPreElement;
const npmInstallResult     = document.getElementById("npm-install-result")!     as HTMLDivElement;
const npmInstallRunBtn     = document.getElementById("npm-install-run")!        as HTMLButtonElement;
const npmInstallClearBtn   = document.getElementById("npm-install-clear")!      as HTMLButtonElement;
const npmInstallTransitive = document.getElementById("npm-install-transitive")! as HTMLInputElement;

npmInstallClearBtn.addEventListener("click", () => {
  npmInstallProgress.textContent = "";
  npmInstallResult.innerHTML = "";
});

npmInstallRunBtn.addEventListener("click", async () => {
  npmInstallProgress.textContent = "";
  npmInstallResult.innerHTML = "";
  let deps: Record<string, string>;
  try {
    deps = JSON.parse(npmInstallDeps.value.trim());
  } catch {
    npmInstallProgress.textContent = "[错误] 无效的 JSON 依赖格式";
    return;
  }

  npmInstallRunBtn.disabled = true;
  const progressLines: string[] = [];
  const start = Date.now();

  const appendProgress = (line: string) => {
    progressLines.push(line);
    npmInstallProgress.textContent = progressLines.join("\n");
    npmInstallProgress.scrollTop = npmInstallProgress.scrollHeight;
  };

  appendProgress(`⏳ 开始安装 ${Object.keys(deps).length} 个包…`);

  try {
    const opts = {
      resolveTransitive: npmInstallTransitive.checked,
      onProgress(p: { name: string; version?: string; phase: "metadata" | "tarball" | "extract" | "done" }) {
        const phase = { metadata: "📡 获取元数据", tarball: "⬇️  下载 tarball", extract: "📦 解压文件", done: "✅ 完成" }[p.phase] ?? p.phase;
        appendProgress(`  ${phase}  ${p.name}${p.version ? "@" + p.version : ""}`);
      },
      ...(rt ? { wasmRuntime: rt } : {}),
    };
    const result = await installPackages(deps, opts);

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    appendProgress(`\n✅ 安装完成！耗时 ${elapsed}s — ${result.packages.length} 个包 / ${result.files.length} 个文件`);

    // Write to VFS
    if (rt && result.files.length > 0) {
      const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
      const snap = buildSnapshot(result.files);
      rt.withBytes(new Uint8Array(snap), (p, l) => { loadFn(p, l); });
      appendProgress(`📁 已写入 VFS: /node_modules`);
    }

    // Render result
    const pkgRows = result.packages.map(pkg => {
      const depCount = Object.keys(pkg.dependencies).length;
      return `<tr>
        <td style="padding:4px 8px;border-bottom:1px solid var(--border);font-weight:600;">${pkg.name}</td>
        <td style="padding:4px 8px;border-bottom:1px solid var(--border);color:var(--green);">${pkg.version}</td>
        <td style="padding:4px 8px;border-bottom:1px solid var(--border);color:var(--text-dim);">${pkg.fileCount} 文件</td>
        <td style="padding:4px 8px;border-bottom:1px solid var(--border);color:var(--text-dim);">${depCount} 依赖</td>
      </tr>`;
    }).join("");

    npmInstallResult.innerHTML = `
      <div style="margin-bottom:12px;">
        <strong>📦 已安装包 (${result.packages.length})</strong>
        <table style="width:100%;border-collapse:collapse;margin-top:6px;font-size:0.8rem;">
          <thead><tr style="background:var(--surface2);">
            <th style="padding:4px 8px;text-align:left;border-bottom:1px solid var(--border);">名称</th>
            <th style="padding:4px 8px;text-align:left;border-bottom:1px solid var(--border);">版本</th>
            <th style="padding:4px 8px;text-align:left;border-bottom:1px solid var(--border);">文件数</th>
            <th style="padding:4px 8px;text-align:left;border-bottom:1px solid var(--border);">依赖</th>
          </tr></thead>
          <tbody>${pkgRows}</tbody>
        </table>
      </div>
      <div>
        <strong>📋 Lockfile 预览</strong>
        <pre style="overflow-x:auto;white-space:pre-wrap;font-size:0.75rem;background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:8px;margin-top:6px;max-height:250px;overflow-y:auto;">${JSON.stringify(result.lockfile, null, 2)}</pre>
      </div>
    `;
  } catch (e) {
    appendProgress(`\n❌ 安装失败: ${(e as Error).message}`);
  } finally {
    npmInstallRunBtn.disabled = false;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Tab 10: 多线程
// ═══════════════════════════════════════════════════════════════════════════

const threadDetectBtn      = document.getElementById("thread-detect")!      as HTMLButtonElement;
const threadCapabilityGrid = document.getElementById("thread-capability-grid")! as HTMLDivElement;
const sabRingInput         = document.getElementById("sab-ring-input")!     as HTMLInputElement;
const sabRingCapacity      = document.getElementById("sab-ring-capacity")!  as HTMLSelectElement;
const sabRingRunBtn        = document.getElementById("sab-ring-run")!       as HTMLButtonElement;
const sabRingOutput        = document.getElementById("sab-ring-output")!    as HTMLPreElement;

threadDetectBtn.addEventListener("click", () => {
  const cap = detectThreadCapability();
  const items: Array<{ label: string; value: boolean | string; desc: string }> = [
    { label: "crossOriginIsolated",  value: cap.crossOriginIsolated, desc: "COOP + COEP 响应头已就绪" },
    { label: "SharedArrayBuffer",    value: cap.sharedArrayBuffer,   desc: "跨 Worker 共享内存可用" },
    { label: "threadsReady",         value: cap.threadsReady,        desc: "完整 wasm 线程池可用" },
    { label: "inWorker",             value: cap.inWorker,            desc: "当前运行在 Worker 上下文" },
    { label: "Atomics.waitAsync",    value: cap.atomicsWaitAsync,    desc: "主线程异步等待可用" },
    { label: "typeof SharedArrayBuffer", value: typeof SharedArrayBuffer !== "undefined" ? "defined" : "undefined", desc: "全局 SAB 类型" },
    { label: "Atomics.wait",         value: typeof Atomics !== "undefined" && typeof (Atomics as { wait?: unknown }).wait === "function" ? true : false, desc: "Worker 真阻塞等待" },
  ];

  threadCapabilityGrid.innerHTML = items.map(item => {
    const isStr = typeof item.value === "string";
    const ok    = isStr ? true : item.value as boolean;
    const color = isStr ? "var(--blue)" : (ok ? "var(--green)" : "var(--red)");
    const icon  = isStr ? "ℹ️" : (ok ? "✅" : "❌");
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:10px;font-size:0.78rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <code style="color:var(--blue);">${item.label}</code>
        <span style="color:${color};font-size:0.9rem;">${icon} ${item.value}</span>
      </div>
      <div style="color:var(--text-dim);font-size:0.73rem;">${item.desc}</div>
    </div>`;
  }).join("");
});

sabRingRunBtn.addEventListener("click", () => {
  const text     = sabRingInput.value || "Hello, bun-browser!";
  const capacity = parseInt(sabRingCapacity.value, 10);
  const lines: string[] = [];

  try {
    // Create ring
    const handle   = createSabRing(capacity);
    const isSAB    = handle.buffer instanceof SharedArrayBuffer;
    const producer = new SabRingProducer(handle);
    const consumer = new SabRingConsumer(handle);

    lines.push(`📦 缓冲区类型: ${isSAB ? "SharedArrayBuffer ✅" : "ArrayBuffer (SAB 不可用，降级)"}`);
    lines.push(`📏 容量: ${capacity} 字节`);

    // Encode and write
    const encoder = new TextEncoder();
    const bytes   = encoder.encode(text);
    lines.push(`\n✍️  写入 ${bytes.byteLength} 字节: "${text}"`);
    lines.push(`   写前可写字节: ${producer.writable()} / ${capacity - 1}`);

    const written = producer.write(bytes);
    lines.push(`   实际写入: ${written} 字节`);
    lines.push(`   写后可读字节: ${consumer.readable()}`);

    // Read back
    const buf  = new Uint8Array(capacity);
    const read = consumer.read(buf);
    const decoded = new TextDecoder().decode(buf.subarray(0, read));
    lines.push(`\n📖 读取 ${read} 字节: "${decoded}"`);
    lines.push(`   读后可读字节: ${consumer.readable()}`);

    // Integrity check
    const match = decoded === text.substring(0, written > 0 ? written : text.length);
    lines.push(`\n${match ? "✅" : "❌"} 数据完整性: ${match ? "通过" : "不匹配"}`);

    // Multi-write test
    lines.push(`\n🔁 多次写入测试:`);
    const msgs = ["ping", "pong", "bun!"];
    for (const msg of msgs) {
      const b = encoder.encode(msg);
      producer.write(b);
    }
    const allBuf = new Uint8Array(capacity);
    const allRead = consumer.read(allBuf);
    lines.push(`   写入 3 条消息，读回: "${new TextDecoder().decode(allBuf.subarray(0, allRead))}"`);

    // Close
    producer.close();
    lines.push(`\n🔒 生产者关闭，isClosed: ${consumer.isClosed()}`);
  } catch (e) {
    lines.push(`❌ 错误: ${(e as Error).message}`);
  }

  sabRingOutput.textContent = lines.join("\n");
});

// ═══════════════════════════════════════════════════════════════════════════
// Tab 11: Bun API 全览
// ═══════════════════════════════════════════════════════════════════════════

// ── 模块解析 ──────────────────────────────────────────────────────────────
const resolveSpecifierEl = document.getElementById("resolve-specifier")! as HTMLInputElement;
const resolveFromEl      = document.getElementById("resolve-from")!      as HTMLInputElement;
const resolveRunBtn      = document.getElementById("resolve-run")!       as HTMLButtonElement;
const resolveResultEl    = document.getElementById("resolve-result")!    as HTMLPreElement;

resolveRunBtn.addEventListener("click", () => {
  if (!rt) return;
  try {
    const r = rt.resolve(resolveSpecifierEl.value.trim(), resolveFromEl.value.trim());
    resolveResultEl.textContent = JSON.stringify(r, null, 2);
  } catch (e) {
    resolveResultEl.textContent = `[错误] ${(e as Error).message}`;
  }
});

// ── Source Map 查找 ───────────────────────────────────────────────────────
const sourcemapInputEl  = document.getElementById("sourcemap-input")!  as HTMLTextAreaElement;
const sourcemapLineEl   = document.getElementById("sourcemap-line")!   as HTMLInputElement;
const sourcemapColEl    = document.getElementById("sourcemap-col")!    as HTMLInputElement;
const sourcemapRunBtn   = document.getElementById("sourcemap-run")!    as HTMLButtonElement;
const sourcemapResultEl = document.getElementById("sourcemap-result")! as HTMLPreElement;

sourcemapRunBtn.addEventListener("click", () => {
  if (!rt) return;
  try {
    const mapJson = sourcemapInputEl.value.trim();
    const line    = parseInt(sourcemapLineEl.value, 10);
    const col     = parseInt(sourcemapColEl.value, 10);
    const r       = rt.sourcemapLookup(mapJson, line, col);
    if (r) {
      sourcemapResultEl.textContent =
        `源文件: ${r.source ?? "(未知)"}\n行: ${r.line ?? "?"}, 列: ${r.col ?? "?"}\n名称: ${r.name ?? "(无)"}`;
    } else {
      sourcemapResultEl.textContent = "(无结果 — WASM 未导出 bun_sourcemap_lookup 或位置超出范围)";
    }
  } catch (e) {
    sourcemapResultEl.textContent = `[错误] ${(e as Error).message}`;
  }
});

// ── HTML 重写 ─────────────────────────────────────────────────────────────
const htmlRewriteInputEl  = document.getElementById("html-rewrite-input")!  as HTMLTextAreaElement;
const htmlRewritePresetEl = document.getElementById("html-rewrite-preset")! as HTMLSelectElement;
const htmlRewriteRunBtn   = document.getElementById("html-rewrite-run")!    as HTMLButtonElement;
const htmlRewriteResultEl = document.getElementById("html-rewrite-result")! as HTMLPreElement;

htmlRewriteRunBtn.addEventListener("click", () => {
  if (!rt) return;

  type RewriteRule = { selector: string; attr?: string; value?: string; before?: string; after?: string; replace?: string };
  const presets: Record<string, RewriteRule[]> = {
    img:  [{ selector: "img", attr: "src", value: "/cdn/logo.v2.png" }],
    link: [{ selector: "a",  attr: "target", value: "_blank" }],
    both: [
      { selector: "img", attr: "src", value: "/cdn/logo.v2.png" },
      { selector: "a",   attr: "target", value: "_blank" },
    ],
  };

  try {
    const html  = htmlRewriteInputEl.value;
    const rules = presets[htmlRewritePresetEl.value] ?? [];
    const out   = rt.htmlRewrite(html, rules as Parameters<typeof rt.htmlRewrite>[1]);
    if (out !== null) {
      htmlRewriteResultEl.textContent = out;
    } else {
      htmlRewriteResultEl.textContent = "(WASM 未导出 bun_html_rewrite — 需要更新版本的 bun-core.wasm)";
    }
  } catch (e) {
    htmlRewriteResultEl.textContent = `[错误] ${(e as Error).message}`;
  }
});

// ── npm 元数据解析 (parseNpmMetadata) ────────────────────────────────────
const npmMetaInputEl  = document.getElementById("npm-meta-input")!  as HTMLTextAreaElement;
const npmMetaRangeEl  = document.getElementById("npm-meta-range")!  as HTMLInputElement;
const npmMetaRunBtn   = document.getElementById("npm-meta-run")!    as HTMLButtonElement;
const npmMetaResultEl = document.getElementById("npm-meta-result")! as HTMLPreElement;

npmMetaRunBtn.addEventListener("click", () => {
  if (!rt) return;
  try {
    const json  = npmMetaInputEl.value.trim();
    const range = npmMetaRangeEl.value.trim();
    const r     = rt.parseNpmMetadata(json, range);
    if (r) {
      npmMetaResultEl.textContent = JSON.stringify(r, null, 2);
    } else {
      // Fallback: try semverSelect from versions array
      const meta = JSON.parse(json);
      const versions = Object.keys(meta.versions ?? {});
      const selected = rt.semverSelect(JSON.stringify(versions), range);
      npmMetaResultEl.textContent = selected
        ? `(WASM fallback) 选出版本: ${selected}\n所有版本: ${versions.join(", ")}`
        : "(无匹配版本)";
    }
  } catch (e) {
    npmMetaResultEl.textContent = `[错误] ${(e as Error).message}`;
  }
});

// ── Lockfile 序列化 (writeLockfile) ──────────────────────────────────────
const writeLockfileInputEl  = document.getElementById("write-lockfile-input")!  as HTMLTextAreaElement;
const writeLockfileRunBtn   = document.getElementById("write-lockfile-run")!    as HTMLButtonElement;
const writeLockfileResultEl = document.getElementById("write-lockfile-result")! as HTMLPreElement;

writeLockfileRunBtn.addEventListener("click", () => {
  if (!rt) return;
  try {
    const packages: Array<{ key: string; name: string; version: string }> = JSON.parse(writeLockfileInputEl.value.trim());
    const out = rt.writeLockfile({ packages, workspaceCount: 1 });
    if (out !== null) {
      writeLockfileResultEl.textContent = out;
    } else {
      // Fallback: produce minimal JSON
      const fallback = {
        lockfileVersion: 1,
        workspaceCount: 1,
        packageCount: packages.length,
        packages: packages.map(p => ({ key: p.key, name: p.name, version: p.version })),
      };
      writeLockfileResultEl.textContent = "(WASM fallback)\n" + JSON.stringify(fallback, null, 2);
    }
  } catch (e) {
    writeLockfileResultEl.textContent = `[错误] ${(e as Error).message}`;
  }
});

// ── 依赖图解析 (resolveGraph) ────────────────────────────────────────────
const resolveGraphDepsEl   = document.getElementById("resolve-graph-deps")!   as HTMLTextAreaElement;
const resolveGraphRunBtn   = document.getElementById("resolve-graph-run")!    as HTMLButtonElement;
const resolveGraphResultEl = document.getElementById("resolve-graph-result")! as HTMLPreElement;

// Mock metadata for offline resolveGraph demo
const MOCK_METADATA: Record<string, string> = {
  react: JSON.stringify({
    name: "react",
    "dist-tags": { latest: "18.2.0" },
    versions: {
      "18.0.0": { version: "18.0.0", dist: { tarball: "https://registry.npmjs.org/react/-/react-18.0.0.tgz", integrity: "sha512-mock" }, dependencies: { "loose-envify": "^1.1.0" } },
      "18.2.0": { version: "18.2.0", dist: { tarball: "https://registry.npmjs.org/react/-/react-18.2.0.tgz", integrity: "sha512-/3IjMdb" }, dependencies: { "loose-envify": "^1.1.0" } },
    },
  }),
  ms: JSON.stringify({
    name: "ms",
    "dist-tags": { latest: "2.1.3" },
    versions: {
      "2.1.2": { version: "2.1.2", dist: { tarball: "https://registry.npmjs.org/ms/-/ms-2.1.2.tgz", integrity: "sha512-mock" }, dependencies: {} },
      "2.1.3": { version: "2.1.3", dist: { tarball: "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz", integrity: "sha512-mock2" }, dependencies: {} },
    },
  }),
  "loose-envify": JSON.stringify({
    name: "loose-envify",
    "dist-tags": { latest: "1.4.0" },
    versions: {
      "1.4.0": { version: "1.4.0", dist: { tarball: "https://registry.npmjs.org/loose-envify/-/loose-envify-1.4.0.tgz", integrity: "sha512-mock" }, dependencies: { "js-tokens": "^3.0.0 || ^4.0.0" } },
    },
  }),
  "js-tokens": JSON.stringify({
    name: "js-tokens",
    "dist-tags": { latest: "4.0.0" },
    versions: {
      "4.0.0": { version: "4.0.0", dist: { tarball: "https://registry.npmjs.org/js-tokens/-/js-tokens-4.0.0.tgz", integrity: "sha512-mock" }, dependencies: {} },
    },
  }),
};

resolveGraphRunBtn.addEventListener("click", () => {
  if (!rt) return;
  try {
    const deps: Record<string, string> = JSON.parse(resolveGraphDepsEl.value.trim());

    // Only pass metadata for packages we have mocked
    const availableMeta: Record<string, string> = {};
    for (const name of Object.keys(deps)) {
      if (MOCK_METADATA[name]) availableMeta[name] = MOCK_METADATA[name];
    }

    const r = rt.resolveGraph(deps, availableMeta);
    if (r) {
      const lines: string[] = [`✅ 已解析 ${r.resolved.length} 个包:`];
      for (const pkg of r.resolved) {
        const depKeys = Object.keys(pkg.dependencies);
        lines.push(`  📦 ${pkg.name}@${pkg.version}${depKeys.length ? ` → [${depKeys.join(", ")}]` : ""}`);
      }
      if (r.missing.length > 0) {
        lines.push(`\n⚠️  缺失 metadata (需要在线 fetch): ${r.missing.join(", ")}`);
        lines.push(`   (demo 仅缓存了 react / ms / loose-envify / js-tokens 的 metadata)`);
      }
      resolveGraphResultEl.textContent = lines.join("\n");
    } else {
      // Fallback: manual semverSelect per dep
      const lines = ["(WASM resolveGraph 不可用，使用 semverSelect fallback)"];
      for (const [name, range] of Object.entries(deps)) {
        const meta = MOCK_METADATA[name];
        if (meta) {
          const versions = Object.keys(JSON.parse(meta).versions ?? {});
          const ver = rt.semverSelect(JSON.stringify(versions), range);
          lines.push(`  ${name}: ${ver ?? "(未找到)"}`);
        } else {
          lines.push(`  ${name}: (无 metadata)`);
        }
      }
      resolveGraphResultEl.textContent = lines.join("\n");
    }
  } catch (e) {
    resolveGraphResultEl.textContent = `[错误] ${(e as Error).message}`;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════════════

function handleEditorKey(this: HTMLTextAreaElement, e: KeyboardEvent): void {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    runExec();
  }
  if (e.key === "Tab") {
    e.preventDefault();
    const start = this.selectionStart;
    const end   = this.selectionEnd;
    this.value  = this.value.substring(0, start) + "  " + this.value.substring(end);
    this.selectionStart = this.selectionEnd = start + 2;
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

init();
