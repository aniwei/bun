import { useState } from "react";
import { useRuntime } from "../context/RuntimeContext";

export function PathUrlTab() {
  const { rt } = useRuntime();

  const [pathBase, setPathBase]   = useState("/home/user/../user/projects");
  const [pathRel, setPathRel]     = useState("./src/../lib/utils.ts");
  const [pathNorm, setPathNorm]   = useState("");
  const [pathJoin, setPathJoin]   = useState("");
  const [pathDir, setPathDir]     = useState("");

  const [urlInput, setUrlInput]   = useState("https://user:pass@registry.example.com:8080/pkg/foo?version=1.0&tag=latest#readme");
  const [urlResult, setUrlResult] = useState({ text: "", isErr: false });

  const [sv2Versions, setSv2Versions] = useState('["1.0.0","1.2.3","2.0.0","2.1.0-beta.1","3.0.0"]');
  const [sv2Range, setSv2Range]       = useState("^2.0.0");
  const [sv2Result, setSv2Result]     = useState({ text: "", isErr: false });

  return (
    <div className="tool-form">
      {/* ── Path ── */}
      <div className="tool-group">
        <h3>📁 路径工具 (pathNormalize / pathJoin / pathDirname)</h3>
        <div className="row">
          <input type="text" value={pathBase} onChange={e => setPathBase(e.target.value)} style={{ flex: 1 }} placeholder="base path" />
          <input type="text" value={pathRel}  onChange={e => setPathRel(e.target.value)}  style={{ flex: 1 }} placeholder="rel path (pathJoin)" />
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            const norm = rt.pathNormalize(pathBase);
            const join = rt.pathJoin(pathBase, pathRel);
            const dir  = join ? rt.pathDirname(join) : null;
            setPathNorm(norm ?? "[未导出]");
            setPathJoin(join ?? "[未导出]");
            setPathDir(dir ?? "[未导出]");
          }}>计算</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "4px", alignItems: "center", fontSize: "0.82rem" }}>
          <span style={{ color: "var(--text-dim)" }}>normalize(base)</span>
          <div className="tool-result">{pathNorm}</div>
          <span style={{ color: "var(--text-dim)" }}>join(base, rel)</span>
          <div className="tool-result">{pathJoin}</div>
          <span style={{ color: "var(--text-dim)" }}>dirname(join)</span>
          <div className="tool-result">{pathDir}</div>
        </div>
      </div>

      {/* ── URL ── */}
      <div className="tool-group">
        <h3>🌐 URL 解析 (urlParse)</h3>
        <div className="row">
          <input type="text" value={urlInput} onChange={e => setUrlInput(e.target.value)} style={{ flex: 1 }} placeholder="URL…" />
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            const res = rt.urlParse(urlInput);
            if (!res) { setUrlResult({ text: "[bun_url_parse 未导出或解析失败]", isErr: true }); return; }
            setUrlResult({ text: JSON.stringify(res, null, 2), isErr: false });
          }}>解析</button>
        </div>
        <pre className={`tool-result${urlResult.isErr ? " err" : ""}`} style={{ whiteSpace: "pre", minHeight: "80px" }}>
          {urlResult.text}
        </pre>
      </div>

      {/* ── Semver Quick ── */}
      <div className="tool-group">
        <h3>🔢 Semver 选择 (semverSelect)</h3>
        <div className="row">
          <input type="text" value={sv2Versions} onChange={e => setSv2Versions(e.target.value)} style={{ flex: 2 }} placeholder='["1.0.0","2.0.0"]' />
          <input type="text" value={sv2Range}    onChange={e => setSv2Range(e.target.value)}    style={{ flex: 1 }} placeholder="range" />
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            try {
              const result = rt.semverSelect(sv2Versions, sv2Range);
              setSv2Result({ text: result !== null ? `✓ ${result}` : "(无匹配版本)", isErr: result === null });
            } catch (e) {
              setSv2Result({ text: `[error] ${(e as Error).message}`, isErr: true });
            }
          }}>选择</button>
        </div>
        <div className={`tool-result${sv2Result.isErr ? " err" : ""}`}>{sv2Result.text}</div>
      </div>
    </div>
  );
}
