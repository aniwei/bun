import { useState } from "react";
import { useRuntime } from "../context/RuntimeContext";
import { buildSnapshot } from "../../../src/vfs-client";

const SAMPLE_SOURCEMAP = JSON.stringify({
  version: 3,
  sources: ["src/index.ts"],
  mappings: "AAAA,MAAM,CAAC,GAAG,CAAC;AACX,OAAO,CAAC,GAAG,CAAC,CAAC,CAAC;",
  sourcesContent: ["const x = 1;\nconsole.log(x);\n"],
}, null, 2);

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>My App</title>
  <script src="https://cdn.example.com/old-lib.js"></script>
  <link rel="stylesheet" href="/styles/main.css">
</head>
<body>
  <div id="app">
    <img src="http://unsafe.example.com/img.png" alt="img">
    <a href="http://old.example.com/page">旧链接</a>
  </div>
  <script src="/dist/app.js"></script>
</body>
</html>`;

const SAMPLE_NPM_META = JSON.stringify({
  name: "react",
  "dist-tags": { latest: "18.3.0", next: "19.0.0-rc.0" },
  versions: {
    "18.0.0": { version: "18.0.0", dist: { tarball: "https://registry.npmjs.org/react/-/react-18.0.0.tgz" } },
    "18.2.0": { version: "18.2.0", dist: { tarball: "https://registry.npmjs.org/react/-/react-18.2.0.tgz" } },
    "18.3.0": { version: "18.3.0", dist: { tarball: "https://registry.npmjs.org/react/-/react-18.3.0.tgz" } },
    "19.0.0-rc.0": { version: "19.0.0-rc.0", dist: { tarball: "https://registry.npmjs.org/react/-/react-19.0.0-rc.0.tgz" } },
  },
}, null, 2);

const SAMPLE_LOCKFILE_PKGS = `[
  { "name": "react",     "version": "18.2.0", "tarball": "https://registry.npmjs.org/react/-/react-18.2.0.tgz",     "dependencies": { "loose-envify": "^1.1.0" } },
  { "name": "react-dom", "version": "18.2.0", "tarball": "https://registry.npmjs.org/react-dom/-/react-dom-18.2.0.tgz", "dependencies": { "react": "^18.2.0", "scheduler": "^0.23.0" } }
]`;

const SAMPLE_RESOLVE_GRAPH_DEPS = `{
  "react":       "^18.2.0",
  "react-dom":   "^18.2.0",
  "zod":         "^3.22.0",
  "lodash":      "^4.17.21",
  "non-existent-pkg": "^1.0.0"
}`;

export function BunApiTab() {
  const { rt } = useRuntime();

  const [resolveSpec, setResolveSpec]   = useState("react");
  const [resolveFrom, setResolveFrom]   = useState("/node_modules");
  const [resolveResult, setResolveResult] = useState("");

  const [smapJson, setSmapJson]   = useState(SAMPLE_SOURCEMAP);
  const [smapLine, setSmapLine]   = useState("1");
  const [smapCol, setSmapCol]     = useState("8");
  const [smapResult, setSmapResult] = useState("");

  const [htmlInput, setHtmlInput]   = useState(SAMPLE_HTML);
  const [htmlRules, setHtmlRules]   = useState(`[
  { "selector": "script", "attr": "src", "from": "https://cdn.example.com/old-lib.js", "to": "/vendor/old-lib.js" },
  { "selector": "img",    "attr": "src", "from": "http://unsafe.example.com/",         "to": "/assets/imgs/" },
  { "selector": "a",      "attr": "href","from": "http://old.example.com/",             "to": "https://new.example.com/" }
]`);
  const [htmlResult, setHtmlResult] = useState("");

  const [npmMeta, setNpmMeta]   = useState(SAMPLE_NPM_META);
  const [npmRange, setNpmRange] = useState("^18.2.0");
  const [npmResult, setNpmResult] = useState("");

  const [lockfilePkgs, setLockfilePkgs] = useState(SAMPLE_LOCKFILE_PKGS);
  const [lockfileResult, setLockfileResult] = useState("");

  const [graphDeps, setGraphDeps]   = useState(SAMPLE_RESOLVE_GRAPH_DEPS);
  const [graphResult, setGraphResult] = useState("");

  return (
    <div className="eco-grid">
      {/* 1 — Module Resolve */}
      <div className="eco-card">
        <h3>📁 模块路径解析 (resolve)</h3>
        <p className="desc">模拟 <code>Bun.resolve(specifier, from)</code>，通过 Zig 解析器在 VFS 中查找模块入口。</p>
        <div className="row">
          <input type="text" value={resolveSpec} onChange={e => setResolveSpec(e.target.value)} style={{ flex: 2 }} placeholder="specifier" />
          <input type="text" value={resolveFrom} onChange={e => setResolveFrom(e.target.value)} style={{ flex: 3 }} placeholder="from (dir)" />
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            // write a stub package.json so resolve can find it
            const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
            const snap   = buildSnapshot([
              { path: `/node_modules/${resolveSpec}/package.json`, data: JSON.stringify({ name: resolveSpec, main: "index.js" }) },
              { path: `/node_modules/${resolveSpec}/index.js`,     data: `// stub for ${resolveSpec}\nexports.default = {};` },
            ]);
            rt.withBytes(new Uint8Array(snap), (p, l) => { loadFn(p, l); });
            const result = rt.resolve(resolveSpec, resolveFrom);
            setResolveResult(JSON.stringify(result, null, 2) ?? "[rt.resolve 未导出]");
          }}>解析</button>
        </div>
        <pre className="eco-result">{resolveResult}</pre>
      </div>

      {/* 2 — Source Map Lookup */}
      <div className="eco-card">
        <h3>🗺 Source Map 映射 (sourcemapLookup)</h3>
        <p className="desc">给定 Source Map JSON 及编译后坐标 (line, col)，反查原始源码位置。</p>
        <textarea value={smapJson} onChange={e => setSmapJson(e.target.value)} rows={4} />
        <div className="row" style={{ marginTop: "6px" }}>
          <input type="number" value={smapLine} onChange={e => setSmapLine(e.target.value)} placeholder="line" style={{ width: "60px" }} />
          <input type="number" value={smapCol}  onChange={e => setSmapCol(e.target.value)}  placeholder="col"  style={{ width: "60px" }} />
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            const result = rt.sourcemapLookup(smapJson, parseInt(smapLine, 10), parseInt(smapCol, 10));
            setSmapResult(JSON.stringify(result, null, 2) ?? "[rt.sourcemapLookup 未导出]");
          }}>查询</button>
        </div>
        <pre className="eco-result">{smapResult}</pre>
      </div>

      {/* 3 — HTML Rewrite */}
      <div className="eco-card">
        <h3>✏️ HTML 重写 (htmlRewrite)</h3>
        <p className="desc">类似 Cloudflare HTMLRewriter：通过 CSS 选择器 + 属性规则批量替换 HTML 文档中的 URL。</p>
        <textarea value={htmlInput}  onChange={e => setHtmlInput(e.target.value)}  rows={4} placeholder="HTML 源码…" />
        <textarea value={htmlRules}  onChange={e => setHtmlRules(e.target.value)}  rows={4} placeholder="重写规则 JSON…" style={{ marginTop: "4px" }} />
        <div className="row" style={{ marginTop: "6px" }}>
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            let rules: unknown;
            try { rules = JSON.parse(htmlRules); } catch (e) { setHtmlResult(`[JSON error] ${(e as Error).message}`); return; }
            const result = rt.htmlRewrite(htmlInput, rules as any);
            setHtmlResult(result ?? "[rt.htmlRewrite 未导出]");
          }}>重写</button>
        </div>
        <pre className="eco-result" style={{ whiteSpace: "pre-wrap" }}>{htmlResult}</pre>
      </div>

      {/* 4 — npm Metadata */}
      <div className="eco-card">
        <h3>📦 npm 元数据解析 (parseNpmMetadata)</h3>
        <p className="desc">解析 npm registry 响应（<code>/{"{"}package{"}"}</code>），结合 semver range 筛选最优版本及 tarball URL。</p>
        <textarea value={npmMeta}  onChange={e => setNpmMeta(e.target.value)}   rows={4} placeholder="npm metadata JSON…" />
        <div className="row" style={{ marginTop: "6px" }}>
          <input type="text" value={npmRange} onChange={e => setNpmRange(e.target.value)} style={{ flex: 1 }} placeholder="semver range" />
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            const result = rt.parseNpmMetadata(npmMeta, npmRange);
            setNpmResult(JSON.stringify(result, null, 2) ?? "[rt.parseNpmMetadata 未导出]");
          }}>解析</button>
        </div>
        <pre className="eco-result">{npmResult}</pre>
      </div>

      {/* 5 — Write Lockfile */}
      <div className="eco-card">
        <h3>🔒 生成 bun.lock (writeLockfile)</h3>
        <p className="desc">传入已解析的包列表，由 Zig 引擎生成标准 bun.lock JSON 文件内容。</p>
        <textarea value={lockfilePkgs} onChange={e => setLockfilePkgs(e.target.value)} rows={5} placeholder="包数组 JSON…" />
        <div className="row" style={{ marginTop: "6px" }}>
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            let pkgs: unknown;
            try { pkgs = JSON.parse(lockfilePkgs); } catch (e) { setLockfileResult(`[JSON error] ${(e as Error).message}`); return; }
            const result = rt.writeLockfile(pkgs as any);
            setLockfileResult(result ?? "[rt.writeLockfile 未导出]");
          }}>生成</button>
        </div>
        <pre className="eco-result">{lockfileResult}</pre>
      </div>

      {/* 6 — Resolve Graph */}
      <div className="eco-card">
        <h3>🕸 依赖图解析 (resolveGraph)</h3>
        <p className="desc">给定依赖声明，Zig 解析器构建完整依赖图，返回已解析版本列表和缺失包列表。</p>
        <textarea value={graphDeps} onChange={e => setGraphDeps(e.target.value)} rows={5} placeholder="依赖 JSON…" />
        <div className="row" style={{ marginTop: "6px" }}>
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            let deps: unknown;
            try { deps = JSON.parse(graphDeps); } catch (e) { setGraphResult(`[JSON error] ${(e as Error).message}`); return; }
            const result = rt.resolveGraph(deps as any);
            setGraphResult(JSON.stringify(result, null, 2) ?? "[rt.resolveGraph 未导出]");
          }}>解析</button>
        </div>
        <pre className="eco-result">{graphResult}</pre>
      </div>
    </div>
  );
}
