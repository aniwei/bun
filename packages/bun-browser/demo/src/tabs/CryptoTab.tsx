import { useState } from "react";
import { useRuntime } from "../context/RuntimeContext";

export function CryptoTab() {
  const { rt } = useRuntime();

  // Hash
  const [hashInput, setHashInput] = useState("Hello, bun-browser!");
  const [hashAlgo, setHashAlgo] = useState("1");
  const [hashResult, setHashResult] = useState("");

  // Base64
  const [b64Input, setB64Input] = useState("Hello, 世界！🌍");
  const [b64Result, setB64Result] = useState("");

  // Compress
  const [compInput, setCompInput] = useState("The quick brown fox jumps over the lazy dog. 敏捷的棕色狐狸跳过懒狗。");
  const [compFmt, setCompFmt] = useState<"gzip" | "zlib" | "raw">("gzip");
  const [compResult, setCompResult] = useState("");
  const [compInfo, setCompInfo] = useState("");
  const [lastCompressed, setLastCompressed] = useState<Uint8Array | null>(null);

  // SRI
  const [sriData, setSriData] = useState("Hello, bun-browser!");
  const [sriValue, setSriValue] = useState("");
  const [sriResult, setSriResult] = useState({ text: "", color: "" });

  return (
    <div className="crypto-grid">
      {/* ── Hash ── */}
      <div className="crypto-card">
        <h3>🔑 哈希摘要 (SHA-1/256/512/MD5)</h3>
        <div className="row">
          <select value={hashAlgo} onChange={e => setHashAlgo(e.target.value)}>
            <option value="0">SHA-1</option>
            <option value="1">SHA-256</option>
            <option value="2">SHA-512</option>
            <option value="3">SHA-384</option>
            <option value="4">MD5</option>
          </select>
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            const data = new TextEncoder().encode(hashInput);
            const out = rt.hash(Number(hashAlgo) as 0 | 1 | 2 | 3 | 4, data);
            setHashResult(out ? Array.from(out).map(b => b.toString(16).padStart(2, "0")).join("") : "[bun_hash 未导出]");
          }}>计算</button>
        </div>
        <textarea rows={3} value={hashInput} onChange={e => setHashInput(e.target.value)} placeholder="输入要哈希的文本…" />
        <div className="crypto-result">{hashResult}</div>
      </div>

      {/* ── Base64 ── */}
      <div className="crypto-card">
        <h3>📝 Base64 编码 / 解码</h3>
        <div className="row">
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            const out = rt.base64Encode(new TextEncoder().encode(b64Input));
            setB64Result(out !== null ? out : "[bun_base64_encode 未导出]");
          }}>编码</button>
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            try {
              const out = rt.base64Decode(b64Input.trim());
              setB64Result(out !== null ? new TextDecoder().decode(out) : "[bun_base64_decode 未导出]");
            } catch (e) {
              setB64Result(`[error] ${(e as Error).message}`);
            }
          }}>解码</button>
        </div>
        <textarea rows={3} value={b64Input} onChange={e => setB64Input(e.target.value)} placeholder="输入文本或 Base64…" />
        <div className="crypto-result">{b64Result}</div>
      </div>

      {/* ── Deflate/Inflate ── */}
      <div className="crypto-card">
        <h3>🗜 Deflate / Inflate 压缩</h3>
        <div className="row">
          <select value={compFmt} onChange={e => setCompFmt(e.target.value as typeof compFmt)}>
            <option value="gzip">gzip</option>
            <option value="zlib">zlib</option>
            <option value="raw">raw</option>
          </select>
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            const data = new TextEncoder().encode(compInput);
            const out  = rt.deflate(data, compFmt);
            if (!out) { setCompResult("[bun_deflate 未导出]"); return; }
            setLastCompressed(out);
            const ratio = ((1 - out.byteLength / data.byteLength) * 100).toFixed(1);
            setCompResult(`[${compFmt}] ${out.byteLength} bytes — Hex: ` +
              Array.from(out.subarray(0, 16)).map(b => b.toString(16).padStart(2, "0")).join(" ") + "…");
            setCompInfo(`原始 ${data.byteLength}B → 压缩 ${out.byteLength}B (压缩率 ${ratio}%)`);
          }}>压缩</button>
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            const src = lastCompressed ?? new TextEncoder().encode(compInput);
            try {
              const out = rt.inflate(src, compFmt);
              if (!out) { setCompResult("[bun_inflate 未导出]"); return; }
              setCompResult(new TextDecoder().decode(out));
              setCompInfo(`解压后 ${out.byteLength}B`);
            } catch (e) {
              setCompResult(`[error] ${(e as Error).message}`);
            }
          }}>解压</button>
        </div>
        <textarea rows={3} value={compInput} onChange={e => setCompInput(e.target.value)} placeholder="输入要压缩的文本…" />
        <div className="crypto-result">{compResult}</div>
        <div style={{ fontSize: "0.72rem", color: "var(--text-dim)", marginTop: "2px" }}>{compInfo}</div>
      </div>

      {/* ── SRI ── */}
      <div className="crypto-card">
        <h3>✅ SRI 完整性校验</h3>
        <p style={{ fontSize: "0.75rem", color: "var(--text-dim)", lineHeight: 1.5 }}>
          输入原始文本 + SRI 字符串（sha256-… / sha512-… / sha1 hex），校验是否匹配。
        </p>
        <textarea rows={2} value={sriData} onChange={e => setSriData(e.target.value)} placeholder="原始数据…" />
        <input type="text" value={sriValue} onChange={e => setSriValue(e.target.value)}
          placeholder="sha256-..." style={{ width: "100%", marginTop: "4px" }} />
        <div className="row" style={{ marginTop: "4px" }}>
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            const data = new TextEncoder().encode(sriData);
            const hash = rt.hash(1, data);
            if (!hash) { setSriResult({ text: "[bun_hash 未导出]", color: "" }); return; }
            const b64  = rt.base64Encode(hash);
            if (!b64)  { setSriResult({ text: "[bun_base64_encode 未导出]", color: "" }); return; }
            const val = `sha256-${b64}`;
            setSriValue(val);
            setSriResult({ text: `已生成 SRI: ${val}`, color: "" });
          }}>生成 sha256 SRI</button>
          <button disabled={!rt} onClick={() => {
            if (!rt) return;
            const data = new TextEncoder().encode(sriData);
            const res  = rt.integrityVerify(data, sriValue.trim());
            const COLOR = { ok: "var(--green)", fail: "var(--red)", bad: "var(--yellow)" } as const;
            setSriResult({
              text: res === "ok" ? "✓ 完整性校验通过" : res === "fail" ? "✗ 哈希不匹配" : "⚠ SRI 格式错误",
              color: COLOR[res],
            });
          }}>校验</button>
        </div>
        <div className="crypto-result" style={{ color: sriResult.color || undefined }}>{sriResult.text}</div>
      </div>
    </div>
  );
}
