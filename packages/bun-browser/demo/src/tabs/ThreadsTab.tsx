import { useState } from "react";
import { useRuntime } from "../context/RuntimeContext";
import { detectThreadCapability } from "../../../src/thread-capability";
import { createSabRing, SabRingProducer, SabRingConsumer } from "../../../src/sab-ring";

interface CapabilityItem { name: string; value: string; ok: boolean; }

export function ThreadsTab() {
  const { rt } = useRuntime();

  const [capabilities, setCapabilities] = useState<CapabilityItem[]>([]);
  const [capDetected, setCapDetected] = useState(false);

  const [ringMsg, setRingMsg] = useState("Hello from SAB Ring Buffer!");
  const [ringCapacity, setRingCapacity] = useState("64");
  const [ringResult, setRingResult] = useState<string[]>([]);

  const detect = async () => {
    try {
      const cap = await detectThreadCapability();
      const items: CapabilityItem[] = [
        { name: "SharedArrayBuffer",  value: typeof SharedArrayBuffer !== "undefined" ? "可用" : "不可用", ok: typeof SharedArrayBuffer !== "undefined" },
        { name: "跨域隔离 (crossOriginIsolated)", value: crossOriginIsolated ? "✓ 已启用" : "✗ 未启用", ok: crossOriginIsolated },
        { name: "SharedWorker",       value: typeof SharedWorker !== "undefined"  ? "支持" : "不支持", ok: typeof SharedWorker !== "undefined" },
        { name: "Worker",             value: typeof Worker !== "undefined"        ? "支持" : "不支持", ok: typeof Worker !== "undefined" },
        { name: "Atomics",            value: typeof Atomics !== "undefined"       ? "支持" : "不支持", ok: typeof Atomics !== "undefined" },
        { name: "WebAssembly.Memory shared", value: (() => { try { new WebAssembly.Memory({ initial: 1, shared: true, maximum: 2 }); return "支持"; } catch { return "不支持"; } })(), ok: (() => { try { new WebAssembly.Memory({ initial: 1, shared: true, maximum: 2 }); return true; } catch { return false; } })() },
        { name: "多线程 (Bun-browser)",  value: cap.threads  ? "支持" : "不支持", ok: !!cap.threads },
        { name: "WASM SIMD",          value: cap.simd       ? "支持" : "不支持", ok: !!cap.simd },
        { name: "WASM Exceptions",    value: cap.exceptions ? "支持" : "不支持", ok: !!cap.exceptions },
      ];
      setCapabilities(items);
      setCapDetected(true);
    } catch (e) {
      setCapabilities([{ name: "检测失败", value: (e as Error).message, ok: false }]);
      setCapDetected(true);
    }
  };

  const runRingDemo = () => {
    const capacity = parseInt(ringCapacity, 10) || 64;
    const lines: string[] = [];
    try {
      const ring     = createSabRing(capacity);
      const producer = new SabRingProducer(ring);
      const consumer = new SabRingConsumer(ring);

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const encoded = encoder.encode(ringMsg);

      const chunks = Math.ceil(encoded.byteLength / (capacity / 4));
      lines.push(`Ring buffer 容量: ${capacity} bytes`);
      lines.push(`消息: "${ringMsg}" (${encoded.byteLength}B → ${chunks} 个 chunk)`);
      lines.push("");

      const chunkSize = Math.floor(capacity / 4);
      let written = 0; let chunk = 0;
      while (written < encoded.byteLength) {
        const slice = encoded.subarray(written, written + chunkSize);
        const ok    = producer.write(slice);
        lines.push(`  [Producer] 写入 chunk #${chunk} (${slice.byteLength}B): ${ok ? "✓ 成功" : "✗ 写入失败（ring 满）"}`);
        if (!ok) break;
        written += slice.byteLength; chunk++;
      }

      lines.push("");
      const readChunks: Uint8Array[] = [];
      for (let i = 0; i < chunk; i++) {
        const data = consumer.read();
        if (!data) { lines.push(`  [Consumer] 读取 chunk #${i}: ✗ 失败（ring 空）`); continue; }
        readChunks.push(data);
        lines.push(`  [Consumer] 读取 chunk #${i} (${data.byteLength}B): ✓ 成功`);
      }

      const combined = new Uint8Array(readChunks.reduce((sum, c) => sum + c.byteLength, 0));
      let offset = 0;
      for (const c of readChunks) { combined.set(c, offset); offset += c.byteLength; }

      const decoded = decoder.decode(combined);
      const match   = decoded === ringMsg;
      lines.push("");
      lines.push(`重组后消息: "${decoded}"`);
      lines.push(`完整性校验: ${match ? "✓ 一致" : "✗ 不一致"}`);
      lines.push(`Ring 使用率峰值: ${((written / capacity) * 100).toFixed(1)}%`);
    } catch (e) {
      lines.push(`[error] ${(e as Error).message}`);
    }
    setRingResult(lines);
  };

  return (
    <div className="semver-wrap">
      {/* ── Capability Detection ── */}
      <div className="tool-group">
        <h3>🔍 线程 & SharedArrayBuffer 能力检测</h3>
        <p style={{ fontSize: "0.78rem", color: "var(--text-dim)", marginBottom: "8px" }}>
          调用 <code>detectThreadCapability()</code> 检测当前环境对多线程特性的支持情况。
          需要 COEP/COOP 响应头以启用 <code>SharedArrayBuffer</code>。
        </p>
        <div className="row">
          <button onClick={detect}>🔍 检测环境</button>
          {capDetected && <button onClick={() => { setCapabilities([]); setCapDetected(false); }}>清空</button>}
        </div>
        {capabilities.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px", marginTop: "8px" }}>
            {capabilities.map((c, i) => (
              <div key={i} style={{ background: c.ok ? "rgba(114,187,100,0.08)" : "rgba(220,50,50,0.08)", borderRadius: "4px", padding: "6px 10px", border: `1px solid ${c.ok ? "var(--green)" : "var(--red)"}22` }}>
                <div style={{ fontSize: "0.7rem", color: "var(--text-dim)" }}>{c.name}</div>
                <div style={{ fontSize: "0.82rem", color: c.ok ? "var(--green)" : "var(--red)", fontWeight: 600, marginTop: "2px" }}>{c.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── SAB Ring Buffer ── */}
      <div className="tool-group" style={{ marginTop: "12px" }}>
        <h3>💬 SAB Ring Buffer 演示</h3>
        <p style={{ fontSize: "0.78rem", color: "var(--text-dim)", marginBottom: "8px" }}>
          使用 <code>createSabRing</code> + <code>SabRingProducer</code> / <code>SabRingConsumer</code> 进行消息分块写入和读取，并校验完整性。
        </p>
        <div className="row">
          <input type="text" value={ringMsg} onChange={e => setRingMsg(e.target.value)} style={{ flex: 1 }} placeholder="要写入的消息…" />
          <select value={ringCapacity} onChange={e => setRingCapacity(e.target.value)}>
            <option value="32">32B</option>
            <option value="64">64B</option>
            <option value="128">128B</option>
            <option value="256">256B</option>
            <option value="512">512B</option>
          </select>
          <button onClick={runRingDemo}>▶ 运行</button>
        </div>
        {ringResult.length > 0 && (
          <pre style={{ background: "var(--bg-alt)", borderRadius: "4px", padding: "10px 12px", marginTop: "8px", fontSize: "0.77rem", color: "var(--text)", whiteSpace: "pre-wrap" }}>
            {ringResult.join("\n")}
          </pre>
        )}
      </div>

      {/* ── Info Panel ── */}
      <div className="tool-group" style={{ marginTop: "12px" }}>
        <h3>ℹ️ 为什么需要 COEP / COOP 响应头？</h3>
        <p style={{ fontSize: "0.78rem", color: "var(--text-dim)", lineHeight: 1.8 }}>
          <code>SharedArrayBuffer</code> 和 <code>Atomics.wait</code> 要求页面处于跨域隔离模式（<em>cross-origin isolated</em>）。
          这需要服务器在响应中包含以下两个 HTTP 头：
        </p>
        <pre style={{ background: "var(--bg-alt)", borderRadius: "4px", padding: "10px 12px", fontSize: "0.77rem", color: "var(--text)", marginTop: "8px" }}>
{`Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp`}
        </pre>
        <p style={{ fontSize: "0.78rem", color: "var(--text-dim)", lineHeight: 1.8, marginTop: "8px" }}>
          bun-browser 的 Vite 开发服务器通过自定义 plugin 自动添加这两个头，
          因此在 <code>http://localhost:4000</code> 上运行时 <code>crossOriginIsolated === true</code>，
          SAB Ring Buffer 和多线程 WASM 均可正常工作。
        </p>
      </div>
    </div>
  );
}
