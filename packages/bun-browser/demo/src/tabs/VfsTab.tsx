import { useState, useEffect, useCallback } from "react";
import { useRuntime } from "../context/RuntimeContext";
import { buildSnapshot, parseSnapshot } from "../../../src/vfs-client";

interface VfsEntry { path: string; size: number; }

const SEED_FILES = [
  { path: "/README.md",        data: "# bun-browser VFS demo\n\nVirtual file system running entirely in WebAssembly.\n" },
  { path: "/src/index.js",     data: "const greeting = 'Hello from VFS!';\nconsole.log(greeting);\n" },
  { path: "/src/utils.js",     data: "export const add = (a, b) => a + b;\nexport const PI = 3.14159;\n" },
  { path: "/data/config.json", data: JSON.stringify({ version: "1.0.0", env: "browser", wasm: true }, null, 2) + "\n" },
  { path: "/data/sample.txt",  data: "The quick brown fox jumps over the lazy dog.\n敏捷的棕色狐狸跳过了懒惰的狗。\n" },
];

const EXT_ICON: Record<string, string> = { js: "JS", ts: "TS", json: "{}", md: "#", txt: "T", html: "<>", css: "CSS" };

export function VfsTab({ onNavigateToExec }: { onNavigateToExec: () => void }) {
  const { rt, setStatus, appendExecOutput, clearExecOutput } = useRuntime();
  const [entries, setEntries] = useState<VfsEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [newPath, setNewPath] = useState("");
  const [log, setLog] = useState<string[]>([]);

  const addLog = (msg: string) => setLog(prev => [...prev, msg]);

  const refresh = useCallback(async () => {
    if (!rt) return;
    setStatus("刷新 VFS…", "busy");
    try {
      const dumpFn = rt.instance.exports.bun_vfs_dump_snapshot as (() => number) | undefined;
      if (!dumpFn) {
        // fallback: seed VFS
        const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
        const snap = buildSnapshot(SEED_FILES);
        rt.withBytes(new Uint8Array(snap), (p, l) => { loadFn(p, l); });
        setEntries(SEED_FILES.map(f => ({ path: f.path, size: f.data.length })));
        setStatus("就绪 ✓", "ready");
        return;
      }
      const ptr = dumpFn();
      if (!ptr) { setEntries([]); setStatus("就绪 ✓", "ready"); return; }
      const mem = new DataView((rt.instance.exports.memory as WebAssembly.Memory).buffer);
      const len = mem.getUint32(ptr, true);
      const data = new Uint8Array((rt.instance.exports.memory as WebAssembly.Memory).buffer, ptr + 4, len);
      const files = parseSnapshot(data.buffer.slice(data.byteOffset, data.byteOffset + len));
      setEntries(files.map(f => ({
        path: f.path,
        size: typeof f.data === "string" ? f.data.length : (f.data as Uint8Array).byteLength,
      })));
      setStatus("就绪 ✓", "ready");
    } catch {
      const loadFn = rt.instance.exports.bun_vfs_load_snapshot as ((p: number, l: number) => number) | undefined;
      if (loadFn) {
        const snap = buildSnapshot(SEED_FILES);
        rt.withBytes(new Uint8Array(snap), (p, l) => { loadFn(p, l); });
        setEntries(SEED_FILES.map(f => ({ path: f.path, size: f.data.length })));
      }
      setStatus("就绪 ✓", "ready");
    }
  }, [rt, setStatus]);

  useEffect(() => { if (rt) refresh(); }, [rt]);

  const openFile = useCallback((path: string) => {
    if (!rt) return;
    setSelectedFile(path);
    const readFn = rt.instance.exports.bun_vfs_read_file as ((p: number, l: number) => bigint) | undefined;
    if (!readFn) { setFileContent("(bun_vfs_read_file 未导出)"); return; }
    try {
      let packed = 0n;
      rt.withString(path, (pp, pl) => { packed = readFn(pp, pl); });
      const ptr = Number(packed >> 32n);
      const len = Number(packed & 0xffff_ffffn);
      if (ptr === 0 || len === 0) { setFileContent("(文件不存在或为空)"); return; }
      const mem = (rt.instance.exports.memory as WebAssembly.Memory).buffer;
      const bytes = new Uint8Array(mem, ptr, len).slice();
      const freeFn = rt.instance.exports.bun_free as ((p: number) => void) | undefined;
      freeFn?.(ptr);
      setFileContent(new TextDecoder().decode(bytes));
    } catch (e) {
      setFileContent(`(error: ${(e as Error).message})`);
    }
  }, [rt]);

  const mkdir = () => {
    const p = newPath.trim();
    if (!p || !rt) return;
    const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
    const keepPath = p.endsWith("/") ? p + ".gitkeep" : p + "/.gitkeep";
    const snap = buildSnapshot([{ path: keepPath, data: "" }]);
    rt.withBytes(new Uint8Array(snap), (pp, l) => { loadFn(pp, l); });
    addLog(`✓ mkdir ${p}`);
  };

  const writeFile = () => {
    const p = newPath.trim();
    if (!p || !rt) return;
    const content = prompt(`写入文件内容 (${p})：`, "console.log('hello from vfs!');");
    if (content === null) return;
    const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (p: number, l: number) => number;
    const snap   = buildSnapshot([{ path: p, data: content }]);
    rt.withBytes(new Uint8Array(snap), (pp, l) => { loadFn(pp, l); });
    addLog(`✓ 已写入 ${p} (${content.length}B)`);
  };

  const runFile = () => {
    if (!rt || !selectedFile) return;
    const runFn = rt.instance.exports.bun_browser_run as (p: number, l: number) => number;
    clearExecOutput();
    let code = -1;
    rt.withString(selectedFile, (p, l) => { code = runFn(p, l); });
    appendExecOutput(`\n[exit ${code}]\n`, "x");
    onNavigateToExec();
  };

  const exportFs = () => {
    const res = SEED_FILES.map(f => f.path);
    const msg = res.map(p => `  "${p}"`).join(",\n");
    alert(`已挂载的 VFS 文件路径（种子）：\n[\n${msg}\n]\n\n(完整 exportFs 需要 Kernel API + Worker)`);
  };

  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));

  return (
    <div className="split">
      <div className="panel">
        <div className="panel-head">
          <span className="title">VFS 文件树</span>
          <button disabled={!rt} onClick={refresh}>↻ 刷新</button>
          <button disabled={!rt} onClick={exportFs}>⤓ 导出快照</button>
        </div>
        <div className="vfs-wrap">
          {sorted.length === 0
            ? <span style={{ color: "var(--text-dim)", padding: "8px", display: "block" }}>(VFS 为空)</span>
            : sorted.map(f => {
                const ext = f.path.split(".").pop() ?? "";
                const icon = EXT_ICON[ext] ?? "•";
                return (
                  <div key={f.path} className="vfs-entry" onClick={() => openFile(f.path)}>
                    <span className="icon">{icon}</span>
                    <span className="name">{f.path}</span>
                    <span className="size">{f.size}B</span>
                  </div>
                );
              })
          }
          {log.map((l, i) => <div key={i} style={{ color: "var(--green)", padding: "4px 8px", fontSize: "0.78rem" }}>{l}</div>)}
        </div>
        <div className="vfs-actions">
          <input type="text" id="vfs-new-path" placeholder="/path/to/file.js"
            value={newPath} onChange={e => setNewPath(e.target.value)} />
          <button disabled={!rt} onClick={mkdir}>mkdir</button>
          <button disabled={!rt} onClick={writeFile}>写文件</button>
          <button disabled={!rt} onClick={() => alert("rm：仅 Kernel API（含 Worker）完整实现。")}>rm</button>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <span className="title">{selectedFile || "选择文件查看"}</span>
          <button disabled={!rt || !selectedFile.endsWith(".js")} onClick={runFile}>▶ 执行此文件</button>
        </div>
        <pre className="output">{fileContent}</pre>
      </div>
    </div>
  );
}
