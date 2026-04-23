import { useState, useEffect, useCallback } from "react";
import { useRuntime } from "../context/RuntimeContext";
import { buildSnapshot } from "../../../src/vfs-client";

interface BundleConfig {
  entry: string;
  files: Record<string, string>;
  define?: Record<string, string>;
  external?: string[];
}

const BUNDLE_CONFIGS: Record<string, BundleConfig> = {
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

function configToDisplay(cfg: BundleConfig): string {
  const lines: string[] = [];
  for (const [path, content] of Object.entries(cfg.files)) {
    lines.push(`// ── ${path} ${"─".repeat(Math.max(0, 44 - path.length))}`);
    lines.push(content);
    lines.push("");
  }
  return lines.join("\n");
}

export function BundlerTab() {
  const { rt } = useRuntime();
  const [presetKey, setPresetKey] = useState("multi-module");
  const [inputText, setInputText] = useState(() => configToDisplay(BUNDLE_CONFIGS["multi-module"]!));
  const [output, setOutput] = useState("");

  useEffect(() => {
    const cfg = BUNDLE_CONFIGS[presetKey];
    if (cfg) setInputText(configToDisplay(cfg));
  }, [presetKey]);

  const runBundle = useCallback(() => {
    if (!rt) return;
    const cfg = BUNDLE_CONFIGS[presetKey];
    if (!cfg) return;
    const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
    const files  = Object.entries(cfg.files).map(([path, data]) => ({ path, data }));
    const snap   = buildSnapshot(files);
    rt.withBytes(new Uint8Array(snap), (p, l) => { loadFn(p, l); });
    try {
      const out = rt.bundle2({
        entrypoint: cfg.entry,
        ...(cfg.external ? { external: cfg.external } : {}),
        ...(cfg.define   ? { define:   cfg.define }   : {}),
      });
      setOutput(out);
    } catch (e) {
      setOutput(`[error] ${(e as Error).message}`);
    }
  }, [rt, presetKey]);

  return (
    <div className="split">
      <div className="panel">
        <div className="panel-head">
          <span className="title">入口文件 (VFS)</span>
          <div className="row">
            <select value={presetKey} onChange={e => setPresetKey(e.target.value)}>
              <option value="multi-module">多模块</option>
              <option value="define">define 替换</option>
              <option value="external">external 依赖</option>
            </select>
            <button className="primary" disabled={!rt} onClick={runBundle}>📦 打包</button>
          </div>
        </div>
        <textarea className="editor" spellCheck={false} value={inputText} onChange={e => setInputText(e.target.value)} />
      </div>
      <div className="panel">
        <div className="panel-head"><span className="title">Bundle 输出 (IIFE)</span></div>
        <pre className="output">{output}</pre>
      </div>
    </div>
  );
}
