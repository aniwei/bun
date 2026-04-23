import { useState } from "react";
import { useRuntime } from "../context/RuntimeContext";

const SEMVER_RANGES = ["*", "^1.0.0", "^2.0.0", "~1.2.0", ">=2.0.0 <3.0.0", "2.1.0-beta.1", "3.0.0-rc.1", "latest"];

interface MatrixRow { range: string; result: string | null; }

const DEFAULT_LOCKFILE = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "my-app", "dependencies": { "react": "^18.2.0" } }
  },
  "packages": {
    "react@18.2.0": ["react", "18.2.0", { "loose-envify": "^1.1.0" }, "sha512-/3IjMdb2L9QbBdWiW5e3P2/npwMBaU9mHCSCUzNln0ZCYbcfTsGbTJrU/kGemdH2IWmB2ioZ+zkxtmq6g09fGQ=="],
    "loose-envify@1.4.0": ["loose-envify", "1.4.0", { "js-tokens": "^3.0.0 || ^4.0.0" }, "sha512-lyuxPGr/Wfhrlem2CL/UcnUc1zcqKAImBDzukY7Y5F/yQiNdko6+fRLevlw1HgMySw7f8ZWR74wjip2L5s6sQ=="]
  }
}`;

export function SemverTab() {
  const { rt } = useRuntime();

  const [versions, setVersions] = useState('["0.9.0","1.0.0","1.2.3","1.9.9","2.0.0","2.1.0-beta.1","2.1.0","3.0.0-rc.1"]');
  const [matrixRows, setMatrixRows] = useState<MatrixRow[]>([]);

  const [lockfileInput, setLockfileInput] = useState(DEFAULT_LOCKFILE);
  const [lockfileResult, setLockfileResult] = useState({ text: "", isErr: false });

  const runMatrix = () => {
    if (!rt) return;
    let parsed: string[];
    try { parsed = JSON.parse(versions); }
    catch { setMatrixRows([]); return; }
    void parsed; // just validate parse
    const rows: MatrixRow[] = SEMVER_RANGES.map(range => {
      let result: string | null = null;
      try { result = rt.semverSelect(versions, range); } catch {}
      return { range, result };
    });
    setMatrixRows(rows);
  };

  const runLockfile = () => {
    if (!rt) return;
    try {
      const summary = rt.parseLockfile(lockfileInput);
      setLockfileResult({ text: JSON.stringify(summary, null, 2), isErr: false });
    } catch (e) {
      setLockfileResult({ text: `[error] ${(e as Error).message}`, isErr: true });
    }
  };

  return (
    <div className="semver-wrap">
      <div className="tool-group">
        <h3>🏷 Semver 版本选择矩阵</h3>
        <p style={{ fontSize: "0.78rem", color: "var(--text-dim)", marginBottom: "8px" }}>
          给定一组可用版本，针对不同 range 查看 Zig semver 引擎的解析结果。
        </p>
        <div className="row">
          <input type="text" value={versions} onChange={e => setVersions(e.target.value)} style={{ flex: 1 }} placeholder='["1.0.0","2.0.0",…]' />
          <button disabled={!rt} onClick={runMatrix}>运行矩阵</button>
        </div>
        {matrixRows.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem", fontFamily: "var(--font-mono)", marginTop: "8px" }}>
            <thead>
              <tr>
                <th style={{ padding: "4px 8px", color: "var(--text-dim)", borderBottom: "1px solid var(--border)", textAlign: "left" }}>Range</th>
                <th style={{ padding: "4px 8px", color: "var(--text-dim)", borderBottom: "1px solid var(--border)", textAlign: "left" }}>选中版本</th>
              </tr>
            </thead>
            <tbody>
              {matrixRows.map(r => (
                <tr key={r.range}>
                  <td style={{ padding: "3px 8px", color: "var(--yellow)", borderBottom: "1px solid #2a2a2a" }}>{r.range}</td>
                  <td style={{ padding: "3px 8px", borderBottom: "1px solid #2a2a2a" }}>
                    {r.result !== null
                      ? <span className="tag tag-green">{r.result}</span>
                      : <span className="tag tag-red">无匹配</span>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="tool-group" style={{ marginTop: "12px" }}>
        <h3>📋 bun.lock 解析 (parseLockfile)</h3>
        <p style={{ fontSize: "0.78rem", color: "var(--text-dim)", marginBottom: "8px" }}>
          粘贴 bun.lock JSON 文本，Zig 引擎解析包图并返回摘要。
        </p>
        <textarea
          value={lockfileInput}
          onChange={e => setLockfileInput(e.target.value)}
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "3px", padding: "8px", resize: "vertical", minHeight: "120px", outline: "none", width: "100%" }}
          placeholder='{ "lockfileVersion": 1, "packages": { … } }'
        />
        <div className="row" style={{ marginTop: "6px" }}>
          <button disabled={!rt} onClick={runLockfile}>解析</button>
        </div>
        <pre className={`tool-result${lockfileResult.isErr ? " err" : ""}`}
          style={{ whiteSpace: "pre-wrap", minHeight: "60px", marginTop: "6px" }}>
          {lockfileResult.text}
        </pre>
      </div>
    </div>
  );
}
