/**
 * bun-browser demo — runs directly in the browser via `bun run demo:serve`
 * or after `bun run build:demo`.
 *
 * Architecture: no Worker — WASM runs synchronously in the UI thread.
 * This is fine for a demo; a production integration uses kernel-worker.ts.
 */

import { createWasmRuntime, type WasmRuntime } from "../src/wasm";
import { buildSnapshot } from "../src/vfs-client";

// ── DOM references ─────────────────────────────────────────

const statusEl  = document.getElementById("status")!   as HTMLSpanElement;
const runBtn    = document.getElementById("run")!       as HTMLButtonElement;
const clearBtn  = document.getElementById("clear")!     as HTMLButtonElement;
const modeEl    = document.getElementById("mode")!      as HTMLSelectElement;
const codeEl    = document.getElementById("code")!      as HTMLTextAreaElement;
const outputEl  = document.getElementById("output")!    as HTMLPreElement;

// ── Runtime ───────────────────────────────────────────────

let rt: WasmRuntime | null = null;

function setStatus(text: string, ok = true): void {
  statusEl.textContent = text;
  statusEl.style.color = ok ? "#4ec9b0" : "#f48771";
}

function appendOutput(text: string, kind: "stdout" | "stderr" | "info" | "exit"): void {
  const span = document.createElement("span");
  if (kind === "stderr") span.style.color = "#f48771";
  else if (kind === "info") span.style.color = "#569cd6";
  else if (kind === "exit") span.style.color = "#c586c0";
  span.textContent = text;
  outputEl.appendChild(span);
  outputEl.scrollTop = outputEl.scrollHeight;
}

async function init(): Promise<void> {
  setStatus("加载 bun-core.wasm …");
  try {
    const wasmUrl = new URL("../bun-core.wasm", import.meta.url);
    const module = await WebAssembly.compileStreaming(fetch(wasmUrl));
    rt = await createWasmRuntime(module, {
      onPrint(data, kind) {
        appendOutput(data, kind);
      },
    });
    setStatus("就绪 ✓");
    runBtn.disabled = false;
  } catch (e) {
    setStatus(`初始化失败: ${(e as Error).message}`, false);
  }
}

// ── Run ───────────────────────────────────────────────────

function run(): void {
  if (!rt) return;
  outputEl.textContent = "";
  runBtn.disabled = true;
  setStatus("运行中 …");

  const source = codeEl.value;
  const mode = modeEl.value as "eval" | "run";

  try {
    if (mode === "eval") {
      // Direct eval — no VFS needed, single expression/script
      const evalFn = rt.instance.exports.bun_browser_eval as
        (sp: number, sl: number, fp: number, fl: number) => number;
      let code = -1;
      rt.withString(source, (sp, sl) => {
        rt!.withString("<demo>", (fp, fl) => {
          code = evalFn(sp, sl, fp, fl);
        });
      });
      appendOutput(`\n[exit ${code}]\n`, "exit");
      setStatus(code === 0 ? "完成 ✓" : `退出码 ${code}`, code === 0);
    } else {
      // Run mode — loads as /main.js in VFS, supports require()
      const loadFn = rt.instance.exports.bun_vfs_load_snapshot as
        (ptr: number, len: number) => number;
      const runFn = rt.instance.exports.bun_browser_run as
        (ptr: number, len: number) => number;

      const snapshot = buildSnapshot([{ path: "/main.js", data: source }]);
      rt.withBytes(new Uint8Array(snapshot), (ptr, len) => { loadFn(ptr, len); });

      let exitCode = -1;
      rt.withString("/main.js", (ptr, len) => { exitCode = runFn(ptr, len); });
      appendOutput(`\n[exit ${exitCode}]\n`, "exit");
      setStatus(exitCode === 0 ? "完成 ✓" : `退出码 ${exitCode}`, exitCode === 0);
    }
  } catch (e) {
    appendOutput(`\n[error] ${(e as Error).message}\n`, "stderr");
    setStatus("运行出错", false);
  } finally {
    runBtn.disabled = false;
  }
}

// ── Wire up ───────────────────────────────────────────────

runBtn.addEventListener("click", run);
clearBtn.addEventListener("click", () => { outputEl.textContent = ""; });
codeEl.addEventListener("keydown", (e) => {
  // Ctrl+Enter / Cmd+Enter → Run
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    run();
  }
  // Tab → indent
  if (e.key === "Tab") {
    e.preventDefault();
    const start = codeEl.selectionStart;
    const end = codeEl.selectionEnd;
    codeEl.value = codeEl.value.substring(0, start) + "  " + codeEl.value.substring(end);
    codeEl.selectionStart = codeEl.selectionEnd = start + 2;
  }
});

init();
