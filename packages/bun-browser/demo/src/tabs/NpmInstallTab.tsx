import { useState } from "react";
import { useRuntime } from "../context/RuntimeContext";
import { buildSnapshot } from "../../../src/vfs-client";
import { installPackages } from "../../../src/installer";

const DEFAULT_DEPS = `{
  "react": "^18.2.0",
  "react-dom": "^18.2.0",
  "zod": "^3.22.0"
}`;

interface InstalledPkg {
  name: string;
  version: string;
  fileCount: number;
  size: number;
  deps: string[];
}

export function NpmInstallTab() {
  const { rt } = useRuntime();
  const [depsJson, setDepsJson] = useState(DEFAULT_DEPS);
  const [resolveTransitive, setResolveTransitive] = useState(true);
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [installed, setInstalled] = useState<InstalledPkg[]>([]);
  const [lockfileText, setLockfileText] = useState("");
  const [running, setRunning] = useState(false);

  const addProgress = (msg: string) => setProgressLines(prev => [...prev, msg]);

  const run = async () => {
    if (!rt) return;
    let deps: Record<string, string>;
    try { deps = JSON.parse(depsJson); }
    catch (e) { addProgress(`[JSON 解析失败] ${(e as Error).message}`); return; }

    setRunning(true);
    setProgressLines([]);
    setInstalled([]);
    setLockfileText("");
    addProgress(`> bun install (transitive: ${resolveTransitive})\n`);

    try {
      const result = await installPackages(deps, {
        resolveTransitive,
        onProgress: (msg: string) => addProgress(msg),
        wasmRuntime: rt,
      });

      const pkgs: InstalledPkg[] = (result.packages ?? []).map((p: any) => ({
        name:      p.name ?? "?",
        version:   p.version ?? "?",
        fileCount: p.files?.length ?? 0,
        size:      p.size ?? 0,
        deps:      Object.keys(p.peerDependencies ?? p.dependencies ?? {}),
      }));
      setInstalled(pkgs);

      // Write packages to VFS
      if (pkgs.length > 0) {
        const vfsFiles: { path: string; data: string }[] = [];
        for (const pkg of pkgs) {
          vfsFiles.push({ path: `/node_modules/${pkg.name}/package.json`, data: JSON.stringify({ name: pkg.name, version: pkg.version }, null, 2) });
        }
        const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
        const snap   = buildSnapshot(vfsFiles);
        rt.withBytes(new Uint8Array(snap), (p, l) => { loadFn(p, l); });
        addProgress(`\n✓ 已写入 ${vfsFiles.length} 个包到 VFS (/node_modules/)`);
      }

      // Generate minimal lockfile preview
      const lockfile = {
        lockfileVersion: 1,
        workspaces: { "": { name: "my-app", dependencies: deps } },
        packages: Object.fromEntries(
          pkgs.map(p => [`${p.name}@${p.version}`, [p.name, p.version, Object.fromEntries(p.deps.map(d => [d, "*"])), ""]])
        ),
      };
      setLockfileText(JSON.stringify(lockfile, null, 2));

      addProgress(`\n✅ 安装完成 — ${pkgs.length} 个包`);
    } catch (e) {
      addProgress(`\n[error] ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  const totalSize = installed.reduce((s, p) => s + p.size, 0);

  return (
    <div className="split">
      <div className="panel">
        <div className="panel-head">
          <span className="title">📦 npm install</span>
          <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "0.78rem", cursor: "pointer" }}>
            <input type="checkbox" checked={resolveTransitive} onChange={e => setResolveTransitive(e.target.checked)} />
            递归依赖
          </label>
          <button className="primary" disabled={!rt || running} onClick={run}>
            {running ? "⏳ 安装中…" : "▶ 安装"}
          </button>
        </div>

        <label style={{ fontSize: "0.72rem", color: "var(--text-dim)", padding: "6px 8px 2px" }}>package.json dependencies:</label>
        <textarea
          value={depsJson}
          onChange={e => setDepsJson(e.target.value)}
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "3px", padding: "8px", resize: "vertical", height: "120px", outline: "none", margin: "0 8px 8px", width: "calc(100% - 16px)" }}
          placeholder='{ "react": "^18.2.0" }'
        />

        <div className="panel-head" style={{ marginTop: "4px" }}>
          <span className="title" style={{ fontSize: "0.75rem" }}>安装日志</span>
          <button onClick={() => setProgressLines([])}>清空</button>
        </div>
        <pre className="output" style={{ flex: 1, margin: 0 }}>
          {progressLines.join("\n") || "(日志为空)"}
        </pre>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="title">📋 已安装包 ({installed.length})</span>
          {totalSize > 0 && <span style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}>共 {(totalSize / 1024).toFixed(1)} KB</span>}
        </div>
        {installed.length === 0
          ? <p style={{ color: "var(--text-dim)", padding: "12px 8px", fontSize: "0.82rem" }}>点击「安装」后，包信息将展示在这里。</p>
          : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
              <thead>
                <tr>
                  {["包名","版本","文件数","大小","依赖"].map(h => (
                    <th key={h} style={{ padding: "4px 8px", color: "var(--text-dim)", borderBottom: "1px solid var(--border)", textAlign: "left" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {installed.map((p, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #1e1e1e" }}>
                    <td style={{ padding: "3px 8px", color: "var(--yellow)" }}>{p.name}</td>
                    <td style={{ padding: "3px 8px" }}><span className="tag tag-green">{p.version}</span></td>
                    <td style={{ padding: "3px 8px", color: "var(--text-dim)" }}>{p.fileCount}</td>
                    <td style={{ padding: "3px 8px", color: "var(--text-dim)" }}>{p.size > 0 ? `${(p.size / 1024).toFixed(1)}K` : "-"}</td>
                    <td style={{ padding: "3px 8px", color: "var(--text-dim)" }}>{p.deps.join(", ") || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }

        {lockfileText && (
          <>
            <div className="panel-head" style={{ marginTop: "8px" }}>
              <span className="title" style={{ fontSize: "0.72rem" }}>bun.lock 预览</span>
            </div>
            <pre className="output" style={{ fontSize: "0.7rem", maxHeight: "200px" }}>{lockfileText}</pre>
          </>
        )}
      </div>
    </div>
  );
}
