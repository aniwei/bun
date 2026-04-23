import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { createWasmRuntime, type WasmRuntime } from "../../../src/wasm";

// ── types ──────────────────────────────────────────────────────────────────

export type StatusState = "loading" | "ready" | "busy" | "error";

export interface RuntimeCtx {
  rt: WasmRuntime | null;
  status: StatusState;
  statusText: string;
  wasmSizeKb: string;
  setStatus: (text: string, state?: StatusState) => void;
  /** Ref to exec-tab output lines so VFS "run file" can redirect output. */
  execOutputLines: OutputLine[];
  appendExecOutput: (text: string, cls: OutputLine["cls"]) => void;
  clearExecOutput: () => void;
}

export interface OutputLine {
  id: number;
  text: string;
  cls: "s" | "e" | "i" | "x" | "w" | "";
}

// ── context ────────────────────────────────────────────────────────────────

const Ctx = createContext<RuntimeCtx | null>(null);

export function useRuntime(): RuntimeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useRuntime must be used inside RuntimeProvider");
  return ctx;
}

// ── provider ───────────────────────────────────────────────────────────────

let _lineId = 0;

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [rt, setRt] = useState<WasmRuntime | null>(null);
  const [status, setStatusState] = useState<StatusState>("loading");
  const [statusText, setStatusText] = useState("初始化中…");
  const [wasmSizeKb, setWasmSizeKb] = useState("—");
  const [execOutputLines, setExecOutputLines] = useState<OutputLine[]>([]);

  const setStatus = useCallback((text: string, state: StatusState = "loading") => {
    setStatusText(text);
    setStatusState(state);
  }, []);

  const appendExecOutput = useCallback((text: string, cls: OutputLine["cls"]) => {
    setExecOutputLines(prev => [...prev, { id: _lineId++, text, cls }]);
  }, []);

  const clearExecOutput = useCallback(() => setExecOutputLines([]), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus("加载 bun-core.wasm…");
      try {
        const resp = await fetch("/bun-core.wasm");
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching bun-core.wasm`);
        const cl = resp.headers.get("content-length");
        if (cl) setWasmSizeKb(`wasm ${(parseInt(cl) / 1024).toFixed(1)} KB`);
        const module = await WebAssembly.compileStreaming(resp);
        if (cancelled) return;
        const runtime = await createWasmRuntime(module, {
          onPrint(data, kind) {
            setExecOutputLines(prev => [
              ...prev,
              { id: _lineId++, text: data, cls: kind === "stderr" ? "e" : "s" },
            ]);
          },
        });
        if (cancelled) return;
        setRt(runtime);
        setStatus("就绪 ✓", "ready");
      } catch (e) {
        if (!cancelled) setStatus(`初始化失败: ${(e as Error).message}`, "error");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <Ctx.Provider value={{ rt, status, statusText, wasmSizeKb, setStatus, execOutputLines, appendExecOutput, clearExecOutput }}>
      {children}
    </Ctx.Provider>
  );
}
