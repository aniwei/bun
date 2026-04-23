import { useState, useRef } from "react";
import { useRuntime } from "../context/RuntimeContext";
import { WebContainer } from "../../../src/webcontainer";
import type { FileSystemTree } from "../../../src/vfs-client";
import { makeServeStaticScript } from "../../../src/serve-static";

interface OutputLine { text: string; cls?: string; }

function toFileSystemTree(files: Readonly<Record<string, string>>): FileSystemTree {
  const root: FileSystemTree = {};
  for (const [absPath, contents] of Object.entries(files)) {
    const parts = absPath.split("/").filter(Boolean);
    let node: FileSystemTree = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      if (!(seg in node)) node[seg] = { directory: {} };
      const child = node[seg]!;
      if ("directory" in child) node = child.directory;
    }
    const filename = parts[parts.length - 1];
    if (filename) node[filename] = { file: { contents } };
  }
  return root;
}

interface PresetStep {
  /** Label displayed in the terminal before running the step. */
  label: string
  /** Command split into argv (e.g. ["bun", "install", "react@18"]). */
  cmd?: string[]
  /** Inline script passed as `bun -e <script>`. */
  script?: string
}

interface PresetDef {
  label: string
  files: Readonly<Record<string, string>>
  /** Used for single-step presets. */
  cmd: string
  /** When present, overrides `cmd` and runs steps sequentially. */
  steps?: PresetStep[]
}

const PRESETS: Record<string, PresetDef> = {
  hello: {
    label: "Hello World",
    files: {
      "/index.js": `console.log("Hello from bun-browser WebContainer!");
console.log("Node version:", process.version);
console.log("Platform:", process.platform);
const sum = [1,2,3,4,5].reduce((a,b)=>a+b,0);
console.log("Sum 1..5 =", sum);`,
    },
    cmd: "bun run /index.js",
  },
  server: {
    label: "HTTP Server (Bun.serve)",
    files: {
      "/server.ts": `const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/hello") {
      return Response.json({ message: "Hello from bun-browser!", ts: Date.now() });
    }
    if (url.pathname === "/api/echo") {
      return new Response(JSON.stringify({ method: req.method, url: req.url }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("<h1>bun WebContainer server</h1>", { headers: { "Content-Type": "text/html" } });
  },
});

console.log("Server running at", server.url.toString());`,
    },
    cmd: "bun run /server.ts",
  },
  pkg: {
    label: "package.json + 模块",
    files: {
      "/pkg/package.json":  `{ "name": "demo", "type": "module", "main": "index.js" }`,
      "/pkg/utils.js":      `export const sum  = (...args) => args.reduce((a,b)=>a+b,0);\nexport const mean = (...args) => sum(...args) / args.length;\nexport const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi, v));`,
      "/pkg/index.js":      `import { sum, mean, clamp } from "./utils.js";\n\nconst nums = [1,5,3,8,2,9,4,7,6];\nconsole.log("sum  :", sum(...nums));\nconsole.log("mean :", mean(...nums).toFixed(2));\nconsole.log("clamp:", clamp(15, 0, 10));`,
    },
    cmd: "bun run /pkg/index.js",
  },
  multi: {
    label: "多文件 TypeScript",
    files: {
      "/app/types.ts":      `export interface Task { id: number; title: string; done: boolean; }\nexport type TaskList = Task[];`,
      "/app/tasks.ts":      `import type { Task, TaskList } from "./types.ts";\n\nconst tasks: TaskList = [\n  { id:1, title:"研究 bun-browser",   done:true  },\n  { id:2, title:"编写 WASM 绑定",     done:true  },\n  { id:3, title:"运行 Vite React TS", done:false },\n  { id:4, title:"发布到 npm",         done:false },\n];\n\nexport const done    = tasks.filter(t =>  t.done);\nexport const pending = tasks.filter(t => !t.done);\nexport const all     = tasks;`,
      "/app/main.ts":       `import { done, pending, all } from "./tasks.ts";\n\nconsole.log("全部任务:");\nfor (const t of all) console.log(\`  [\${t.done?"✓":" "}] \${t.title}\`);\nconsole.log(\`\nSummary: \${done.length} 完成, \${pending.length} 待完成\`);`,
    },
    cmd: "bun run /app/main.ts",
  },
  vite: {
    label: "bun build + 静态预览（React TS）",
    files: {
      "/app/package.json": `{\n  "name": "bun-react-demo",\n  "type": "module",\n  "dependencies": { "react": "^18.3.0", "react-dom": "^18.3.0" }\n}`,
      "/app/src/App.ts": `import React from "react";\n\nexport function App() {\n  return React.createElement(\n    "div",\n    { style: { fontFamily: "sans-serif", padding: "2rem", maxWidth: "480px", margin: "0 auto" } },\n    React.createElement("h1", null, "\u{1F680} bun-browser + React"),\n    React.createElement("p", null, "Running React " + React.version + " in WebAssembly Bun!"),\n    React.createElement("p", { style: { color: "#666", fontSize: "0.85rem" } },\n      "\u2705 bun install \u2192 bun build \u2192 Bun.serve \u2192 SW \u9884\u89c8"\n    )\n  );\n}`,
      "/app/src/main.ts": `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport { App } from "./App.ts";\n\nconst root = document.getElementById("root");\nif (root) createRoot(root).render(React.createElement(App, null));`,
      "/app/index.html": `<!DOCTYPE html>\n<html lang="zh">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>bun-browser React Demo</title>\n</head>\n<body>\n  <div id="root">\u52a0\u8f7d\u4e2d...</div>\n  <script type="module" src="./main.js"></script>\n</body>\n</html>`,
    },
    cmd: "", // overridden by steps below
    steps: [
      {
        label: "bun install react@18 react-dom@18",
        cmd: ["bun", "install", "--cwd", "/app"],
      },
      {
        label: "bun build /app/src/main.ts --outdir /app/dist --target browser",
        cmd: ["bun", "build", "/app/src/main.ts", "--outdir", "/app/dist", "--target", "browser"],
      },
      {
        label: "Bun.serve 静态托管 /app/dist/ → port 3000",
        script: makeServeStaticScript({ distDir: "/app/dist", port: 3000 }),
      },
    ],
  },
  express: {
    label: "Express Hello World（node:http shim）",
    files: {
      "/app/package.json": `{
  "name": "bun-express-demo",
  "type": "commonjs",
  "dependencies": { "express": "^4.21.2" }
}`,
      "/app/express-fallback.js": `const http = require("http");

function collectBody(req, done) {
  const chunks = [];
  req.on("data", (chunk) => {
    if (typeof chunk === "string") chunks.push(new TextEncoder().encode(chunk));
    else if (chunk instanceof Uint8Array) chunks.push(chunk);
    else if (ArrayBuffer.isView(chunk)) chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    else chunks.push(new TextEncoder().encode(String(chunk)));
  });
  req.on("end", () => {
    if (chunks.length === 0) return done("");
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    done(new TextDecoder().decode(out));
  });
}

function expressFallback() {
  const middleware = [];
  const routes = [];

  const app = function(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    req.path = url.pathname;
    req.query = Object.fromEntries(url.searchParams.entries());

    res.status = function(code) { this.statusCode = code; return this; };
    res.set = function(name, value) { this.setHeader(name, value); return this; };
    res.send = function(body) {
      if (body == null) body = "";
      if (typeof body === "object" && !ArrayBuffer.isView(body)) return this.json(body);
      if (!this.getHeader("content-type")) this.setHeader("content-type", "text/plain; charset=utf-8");
      this.end(body);
      return this;
    };
    res.json = function(obj) {
      this.setHeader("content-type", "application/json; charset=utf-8");
      this.end(JSON.stringify(obj));
      return this;
    };

    const method = (req.method || "GET").toUpperCase();
    const runRoute = () => {
      const hit = routes.find(r => r.method === method && r.path === req.path);
      if (!hit) return res.status(404).send("Not Found");
      return hit.handler(req, res);
    };

    let i = 0;
    const next = () => {
      const fn = middleware[i++];
      if (!fn) return runRoute();
      return fn(req, res, next);
    };
    return next();
  };

  app.use = function(fn) { middleware.push(fn); return app; };
  app.get = function(path, handler) { routes.push({ method: "GET", path, handler }); return app; };
  app.post = function(path, handler) { routes.push({ method: "POST", path, handler }); return app; };
  app.listen = function(port, cb) { return http.createServer(app).listen(port, cb); };

  return app;
}

expressFallback.text = function() {
  return function(req, _res, next) {
    collectBody(req, body => {
      req.body = body;
      next();
    });
  };
};

module.exports = expressFallback;
`,
      "/app/server.js": `let express = require("express");
if (typeof express !== "function") {
  console.warn("[t5.17.4] express install unavailable, fallback to local shim");
  express = require("./express-fallback.js");
} else {
  console.log("[t5.17.4] express loaded from node_modules");
}

const app = express();

function readTextBody(req, done) {
  const chunks = [];
  req.on("data", (chunk) => {
    if (typeof chunk === "string") chunks.push(new TextEncoder().encode(chunk));
    else if (chunk instanceof Uint8Array) chunks.push(chunk);
    else if (ArrayBuffer.isView(chunk)) chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    else chunks.push(new TextEncoder().encode(String(chunk)));
  });
  req.on("end", () => {
    if (chunks.length === 0) return done("");
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    done(new TextDecoder().decode(out));
  });
}

app.get("/", (_req, res) => {
  res.send("Hello World from Express in bun-browser!");
});

app.get("/api/hello", (req, res) => {
  res.json({ framework: "express", ok: true, method: req.method, url: req.url });
});

app.post("/api/echo", (req, res) => {
  readTextBody(req, (body) => {
    res.json({ echo: body, method: req.method, url: req.url });
  });
});

const port = 3000;
app.listen(port, () => {
  console.log("Express demo listening on http://localhost:" + port);
  console.log("Try GET /api/hello and POST /api/echo");
});
`,
    },
    cmd: "", // overridden by steps below
    steps: [
      {
        label: "bun install --cwd /app express@4（best effort）",
        cmd: ["bun", "install", "--cwd", "/app", "express@4"],
      },
      {
        label: "bun run /app/server.js",
        cmd: ["bun", "run", "/app/server.js"],
      },
    ],
  },
};

type PresetKey = keyof typeof PRESETS;

/**
 * Run a sequence of steps (cmd or script) inside a WebContainer.
 * Returns true if all steps succeed, false if any step fails.
 */
async function runSteps(
  wc: WebContainer,
  steps: PresetStep[],
  log: (text: string, cls?: string) => void,
): Promise<boolean> {
  for (const step of steps) {
    log(`\n▶ ${step.label}\n`);
    try {
      let proc;
      if (step.script !== undefined) {
        proc = await wc.spawn("bun", ["-e", step.script]);
      } else if (step.cmd && step.cmd.length > 0) {
        const [prog, ...args] = step.cmd;
        proc = await wc.spawn(prog!, args);
      } else {
        continue;
      }
      const exitCode = await proc.exit;
      log(`[exit ${exitCode}]\n`, exitCode === 0 ? "s" : "e");
      if (exitCode !== 0) return false;
    } catch (e) {
      log(`[error] ${(e as Error).message}\n`, "e");
      return false;
    }
  }
  return true;
}

export function WebContainerTab() {
  const { rt } = useRuntime();
  const [preset, setPreset]                 = useState<PresetKey>("hello");
  const [containerRef, setContainerRef]     = useState<WebContainer | null>(null);
  const [output, setOutput]                 = useState<OutputLine[]>([]);
  const [booted, setBooted]                 = useState(false);
  const [running, setRunning]               = useState(false);
  const [useSwPreview, setUseSwPreview]     = useState(false);
  const [previewUrls, setPreviewUrls]       = useState<string[]>([]);

  const [fsPath, setFsPath]     = useState("/index.js");
  const [fsWrite, setFsWrite]   = useState("");
  const [fsResult, setFsResult] = useState("");

  const [httpPath, setHttpPath]         = useState("/api/hello");
  const [httpMethod, setHttpMethod]     = useState("GET");
  const [httpBody, setHttpBody]         = useState("");
  const [httpHeaders, setHttpHeaders]   = useState('{ "Accept": "application/json" }');
  const [httpResult, setHttpResult]     = useState("");

  const addOutput = (text: string, cls?: string) => setOutput(prev => [...prev, { text, cls }]);

  const boot = async () => {
    if (!rt) return;
    setRunning(true);
    addOutput(`> bun-browser WebContainer boot (preset: ${preset})…\n`);
    try {
      const cfg = PRESETS[preset];
      const wc  = await WebContainer.boot({
        wasmModule: rt,
        onStdout: t => addOutput(t, "s"),
        onStderr: t => addOutput(t, "e"),
        ...(useSwPreview ? {
          serviceWorker: {
            scriptUrl: "/bun-preview-sw.js",
            // scope 默认为 '/__bun_preview__/'，此处省略
            // Vite dev server 已逆COOP/COEP，无需 SW 再注入
            injectIsolationHeaders: false,
            // 0 = 无超时（适合 SSE / 长轮询场景）
            fetchTimeoutMs: 0,
          },
        } : {}),
      });
      await wc.mount(toFileSystemTree(cfg.files));

      // 监听 Bun.serve() 启动事件，获取预览 URL
      if (useSwPreview) {
        wc.kernel.on("port", (ev: { port: number }) => {
          const url = `${window.location.origin}/__bun_preview__/${ev.port}/`;
          setPreviewUrls(prev => [
            ...prev.filter(u => !u.includes(`/${ev.port}/`)),
            url,
          ]);
          addOutput(`\u2728 预览 URL (SW): ${url}\n`, "s");
        });
      }

      setContainerRef(wc);
      setBooted(true);
      addOutput(
        `✓ WebContainer 已启动，文件已挂载${
          useSwPreview ? "（ServiceWorker 已附加，运行 server 预设后可用预览 URL）" : ""
        }\n`,
        "s",
      );
    } catch (e) {
      addOutput(`[error] ${(e as Error).message}\n`, "e");
    } finally {
      setRunning(false);
    }
  };

  const teardown = () => {
    containerRef?.teardown?.();
    setContainerRef(null);
    setBooted(false);
    setPreviewUrls([]);
    addOutput(`> WebContainer 已关闭\n`);
  };

  const spawn = async () => {
    if (!containerRef) return;
    const cfg = PRESETS[preset];
    setRunning(true);
    try {
      if (cfg.steps && cfg.steps.length > 0) {
        await runSteps(containerRef, cfg.steps, addOutput);
      } else {
        const parts = cfg.cmd.split(" ");
        const prog  = parts[0]!;
        const args  = parts.slice(1);
    addOutput(`\n$ ${cfg.cmd}\n`);
      const proc = await containerRef.spawn(prog, args);
      const exitCode = await proc.exit;
      addOutput(`[exit ${exitCode}]\n`, exitCode === 0 ? "s" : "e");
      }
    } catch (e) {
      addOutput(`[error] ${(e as Error).message}\n`, "e");
    } finally {
      setRunning(false);
    }
  };

  const readFile = async () => {
    if (!containerRef) return;
    try {
      const data = await containerRef.fs.readFile(fsPath, "utf-8");
      setFsResult(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch (e) {
      setFsResult(`[error] ${(e as Error).message}`);
    }
  };

  const readdir = async () => {
    if (!containerRef) return;
    try {
      const entries = await containerRef.fs.readdir(fsPath);
      setFsResult(entries.join("\n"));
    } catch (e) {
      setFsResult(`[error] ${(e as Error).message}`);
    }
  };

  const stat = async () => {
    if (!containerRef) return;
    try {
      const info = await containerRef.fs.stat(fsPath);
      setFsResult(JSON.stringify(info, null, 2));
    } catch (e) {
      setFsResult(`[error] ${(e as Error).message}`);
    }
  };

  const writeFile = async () => {
    if (!containerRef) return;
    try {
      await containerRef.fs.writeFile(fsPath, fsWrite);
      setFsResult(`✓ 已写入 ${fsPath} (${fsWrite.length}B)`);
    } catch (e) {
      setFsResult(`[error] ${(e as Error).message}`);
    }
  };

  const sendHttp = async () => {
    if (!containerRef) return;
    try {
      const ports = containerRef.kernel.previewPorts.list();
      if (ports.length === 0) {
        throw new Error("未检测到 Bun.serve 端口。请先运行 server 或 express 预设。");
      }
      const port = ports[ports.length - 1]!;

      let headers: Record<string, string> = {};
      try { headers = JSON.parse(httpHeaders); } catch {}

      const url = /^https?:\/\//.test(httpPath)
        ? httpPath
        : `http://localhost:${port}${httpPath.startsWith("/") ? httpPath : "/" + httpPath}`;

      const res = await containerRef.kernel.fetch(port, {
        url,
        method: httpMethod,
        headers,
        ...(httpBody ? { body: httpBody } : {}),
      });

      setHttpResult(
        `HTTP/1.1 ${res.status} ${res.statusText ?? ""}\n${JSON.stringify(res.headers, null, 2)}\n\n${res.body}`,
      );
    } catch (e) {
      setHttpResult(`[error] ${(e as Error).message}`);
    }
  };

  return (
    <div className="split" style={{ alignItems: "stretch" }}>
      {/* Left: controls */}
      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "0" }}>
        {/* Lifecycle */}
        <div className="tool-group">
          <div className="panel-head" style={{ padding: "0 0 6px" }}>
            <span className="title" style={{ fontSize: "0.8rem" }}>🚀 容器生命周期</span>
            {booted && <span className="tag tag-green" style={{ fontSize: "0.68rem" }}>运行中</span>}
          </div>
          <div className="row">
            <select value={preset} onChange={e => { if (!booted) setPreset(e.target.value as PresetKey); }}>
              {(Object.keys(PRESETS) as PresetKey[]).map(k => (
                <option key={k} value={k}>{PRESETS[k].label}</option>
              ))}
            </select>
            <button disabled={!rt || booted || running} onClick={boot}>⚡ Boot</button>
            <button disabled={!booted || running}       onClick={spawn}>▶ Run</button>
            <button disabled={!booted}                  onClick={teardown}>⏹ 关闭</button>
          </div>
          <div className="row" style={{ marginTop: "6px", alignItems: "center", gap: "6px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.76rem", cursor: booted ? "not-allowed" : "pointer", opacity: booted ? 0.5 : 1 }}>
              <input
                type="checkbox"
                checked={useSwPreview}
                disabled={booted}
                onChange={e => setUseSwPreview(e.target.checked)}
              />
              🔌 附加预览 ServiceWorker
            </label>
            <span style={{ fontSize: "0.68rem", color: "var(--text-dim)" }}>
              {useSwPreview ? "SW 拦截 /__bun_preview__/* → Kernel" : "HTTP 请求直连 Kernel（默认）"}
            </span>
          </div>
        </div>

        {/* FS */}
        <div className="tool-group" style={{ marginTop: "10px" }}>
          <h4 style={{ fontSize: "0.78rem", color: "var(--text-dim)", margin: "0 0 6px" }}>📂 文件系统操作</h4>
          <div className="row">
            <input type="text" value={fsPath} onChange={e => setFsPath(e.target.value)} style={{ flex: 1 }} placeholder="/path/to/file" />
            <button disabled={!booted} onClick={readFile}>readFile</button>
            <button disabled={!booted} onClick={readdir}>readdir</button>
            <button disabled={!booted} onClick={stat}>stat</button>
          </div>
          <textarea rows={3} value={fsWrite} onChange={e => setFsWrite(e.target.value)} placeholder="写入内容（可选）…" style={{ marginTop: "4px", width: "100%" }} />
          <div className="row" style={{ marginTop: "4px" }}>
            <button disabled={!booted} onClick={writeFile}>writeFile</button>
          </div>
          {fsResult && <pre className="tool-result" style={{ marginTop: "6px", whiteSpace: "pre-wrap" }}>{fsResult}</pre>}
        </div>

        {/* SW 预览 URL（仅在 useSwPreview 时显示） */}
        {useSwPreview && (
          <div className="tool-group" style={{ marginTop: "10px" }}>
            <h4 style={{ fontSize: "0.78rem", color: "var(--text-dim)", margin: "0 0 6px" }}>🌐 ServiceWorker 预览 URL</h4>
            {!booted ? (
              <span style={{ fontSize: "0.74rem", color: "var(--text-dim)" }}>Boot 后自动获取…</span>
            ) : previewUrls.length === 0 ? (
              <span style={{ fontSize: "0.74rem", color: "var(--text-dim)" }}>等待 Bun.serve() 启动（点击 ▶ Run 运行 server / express 预设）…</span>
            ) : (
              previewUrls.map(url => (
                <div key={url} style={{ marginBottom: "4px" }}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: "0.75rem", wordBreak: "break-all" }}
                  >
                    {url}
                  </a>
                  <span style={{ marginLeft: "6px", fontSize: "0.68rem", color: "var(--text-dim)" }}>
                    (新标签页打开，由 SW 拦截并转发)
                  </span>
                </div>
              ))
            )}
          </div>
        )}

        {/* HTTP */}
        <div className="tool-group" style={{ marginTop: "10px" }}>
          <h4 style={{ fontSize: "0.78rem", color: "var(--text-dim)", margin: "0 0 6px" }}>🌐 HTTP 请求测试</h4>
          <div className="row">
            <select value={httpMethod} onChange={e => setHttpMethod(e.target.value)}>
              <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option>
            </select>
            <input type="text" value={httpPath} onChange={e => setHttpPath(e.target.value)} style={{ flex: 1 }} placeholder="/api/…" />
          </div>
          <input type="text" value={httpHeaders} onChange={e => setHttpHeaders(e.target.value)} style={{ width: "100%", marginTop: "4px" }} placeholder='{"Accept": "application/json"}' />
          {(httpMethod === "POST" || httpMethod === "PUT") && (
            <textarea rows={2} value={httpBody} onChange={e => setHttpBody(e.target.value)} style={{ marginTop: "4px", width: "100%" }} placeholder="请求体…" />
          )}
          <div className="row" style={{ marginTop: "4px" }}>
            <button disabled={!booted} onClick={sendHttp}>发送请求</button>
            <button onClick={() => { setHttpResult(""); }}>清空</button>
          </div>
          {httpResult && <pre className="tool-result" style={{ marginTop: "6px", whiteSpace: "pre-wrap", fontSize: "0.72rem" }}>{httpResult}</pre>}
        </div>
      </div>

      {/* Right: terminal output */}
      <div className="panel">
        <div className="panel-head">
          <span className="title">终端输出</span>
          <button onClick={() => setOutput([])}>清空</button>
        </div>
        <pre className="output" style={{ flex: 1 }}>
          {output.length === 0
            ? <span style={{ color: "var(--text-dim)" }}>点击「Boot」启动 WebContainer…</span>
            : output.map((l, i) => <span key={i} className={l.cls || undefined}>{l.text}</span>)
          }
        </pre>
      </div>
    </div>
  );
}
