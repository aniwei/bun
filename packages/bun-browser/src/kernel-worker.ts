/**
 * Kernel worker 入口 —— 在专用 Web Worker 里拉起 bun-core.wasm + JSI Host。
 *
 * 注意：此文件假定运行在 Web Worker 上下文（`self` 为 `DedicatedWorkerGlobalScope`）。
 * 浏览器端需通过 `new Worker(new URL("./kernel-worker.ts", import.meta.url), { type: "module" })` 加载。
 */

import { JsiHost, PrintLevel } from "./jsi-host";
import { PROTOCOL_VERSION, type HostRequest, type KernelEvent } from "./protocol";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const self: any;

const host = new JsiHost({
  global: self,
  onPrint: (data, level) => writeStd(level === PrintLevel.Stderr ? "stderr" : "stdout", data),
});
let instance: WebAssembly.Instance | undefined;
let exitCode: number | undefined;

function post(event: KernelEvent, transfer: Transferable[] = []): void {
  self.postMessage(event, transfer);
}

function writeStd(kind: "stdout" | "stderr", data: string): void {
  post({ kind, data });
}

/** 构造 WASI 最小兼容的环境（仅提供 fd_write → stdout/stderr）。 */
function makeWasiShim() {
  const decoder = new TextDecoder();
  const mem = (): Uint8Array => {
    const m = instance?.exports.memory as WebAssembly.Memory | undefined;
    if (!m) throw new Error("wasm memory unavailable");
    return new Uint8Array(m.buffer);
  };
  const view = (): DataView => {
    const m = instance?.exports.memory as WebAssembly.Memory | undefined;
    if (!m) throw new Error("wasm memory unavailable");
    return new DataView(m.buffer);
  };
  return {
    fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number): number => {
      const v = view();
      const b = mem();
      let total = 0;
      const parts: string[] = [];
      for (let i = 0; i < iovsLen; i++) {
        const p = iovs + i * 8;
        const ptr = v.getUint32(p, true);
        const len = v.getUint32(p + 4, true);
        parts.push(decoder.decode(b.subarray(ptr, ptr + len)));
        total += len;
      }
      v.setUint32(nwritten, total, true);
      const kind = fd === 2 ? "stderr" : "stdout";
      writeStd(kind as "stdout" | "stderr", parts.join(""));
      return 0;
    },
    proc_exit: (code: number): never => {
      exitCode = code;
      post({ kind: "exit", code });
      throw new Error(`wasi proc_exit(${code})`);
    },
    // 其他 WASI 调用暂未实现 —— 请依赖 Zig 侧 `sys_wasm` + JSI 替代。
  };
}

async function instantiate(module: WebAssembly.Module): Promise<void> {
  const imports: WebAssembly.Imports = {
    jsi: host.imports(),
    wasi_snapshot_preview1: makeWasiShim(),
    env: {
      // 时钟回调：由 Zig 侧通过 `extern "env" fn jsi_now_ms() u64` 读取。
      jsi_now_ms: (): bigint => BigInt(Date.now()),
    },
  };
  // 当 module 是 WebAssembly.Module 时， instantiate 返回 Instance。
  instance = (await WebAssembly.instantiate(module, imports)) as unknown as WebAssembly.Instance;
  host.bind(instance);

  const startFn = instance.exports._start as (() => void) | undefined;
  const initFn = instance.exports.bun_browser_init as (() => void) | undefined;
  if (initFn) initFn();
  else if (startFn) startFn();
}
/**
 * 将字节写入 WASM 内存，调用 fn，然后释放内存。
 * @param data 内容
 * @param fn   接收 (ptr, len) 的 WASM 导出
 */
function withWasmBytes(data: Uint8Array, fn: (ptr: number, len: number) => void): void {
  const alloc = instance!.exports.bun_malloc as (n: number) => number;
  const free = instance!.exports.bun_free as (ptr: number) => void;
  const ptr = alloc(data.byteLength);
  new Uint8Array((instance!.exports.memory as WebAssembly.Memory).buffer, ptr, data.byteLength).set(
    data,
  );
  try {
    fn(ptr, data.byteLength);
  } finally {
    free(ptr);
  }
}
self.addEventListener("message", async (ev: MessageEvent<HostRequest>) => {
  const msg = ev.data;
  try {
    switch (msg.kind) {
      case "handshake": {
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error(
            `Protocol version mismatch: host=${msg.protocolVersion}, kernel=${PROTOCOL_VERSION}`,
          );
        }
        await instantiate(msg.wasmModule);
        post({ kind: "handshake:ack", protocolVersion: PROTOCOL_VERSION, engine: "browser" });

        if (msg.vfsSnapshot) {
          const loader = instance?.exports.bun_vfs_load_snapshot as
            | ((ptr: number, len: number) => number)
            | undefined;
          if (loader) {
            withWasmBytes(new Uint8Array(msg.vfsSnapshot), (ptr, len) => loader(ptr, len));
          }
        }

        post({ kind: "ready" });

        // 自动运行入口文件（如果 handshake 带有 entry）
        if (msg.entry) {
          const runner = instance?.exports.bun_browser_run as
            | ((entryPtr: number, entryLen: number) => number)
            | undefined;
          if (runner) {
            const entryBytes = new TextEncoder().encode(msg.entry);
            withWasmBytes(entryBytes, (ptr, len) => {
              const code = runner(ptr, len);
              post({ kind: "exit", code });
            });
          }
        }
        break;
      }

      case "run": {
        const runner = instance?.exports.bun_browser_run as
          | ((entryPtr: number, entryLen: number) => number)
          | undefined;
        if (!runner) throw new Error("bun_browser_run export missing");
        const entryBytes = new TextEncoder().encode(msg.entry);
        withWasmBytes(entryBytes, (ptr, len) => {
          const code = runner(ptr, len);
          post({ kind: "exit", code });
        });
        break;
      }

      case "vfs:snapshot": {
        const loader = instance?.exports.bun_vfs_load_snapshot as
          | ((ptr: number, len: number) => number)
          | undefined;
        if (loader) {
          withWasmBytes(new Uint8Array(msg.snapshot), (ptr, len) => loader(ptr, len));
        }
        break;
      }

      case "eval": {
        const evalFn = instance?.exports.bun_browser_eval as
          | ((srcPtr: number, srcLen: number, filePtr: number, fileLen: number) => number)
          | undefined;
        if (!evalFn) throw new Error("bun_browser_eval export missing");
        const enc = new TextEncoder();
        const srcBytes = enc.encode(msg.source);
        const fileBytes = enc.encode(msg.filename ?? "<eval>");
        let evalErr: string | undefined;
        withWasmBytes(srcBytes, (srcPtr, srcLen) => {
          withWasmBytes(fileBytes, (filePtr, fileLen) => {
            const code = evalFn(srcPtr, srcLen, filePtr, fileLen);
            if (code !== 0) evalErr = `eval returned exit code ${code}`;
          });
        });
        post({ kind: "eval:result", id: msg.id, error: evalErr });
        break;
      }

      case "stop": {
        post({ kind: "exit", code: msg.code ?? 130 });
        // 在 Worker 内直接退出，调用方会 terminate()。
        break;
      }

      default:
        break;
    }
  } catch (e) {
    const err = e as Error;
    post({ kind: "error", message: err.message, stack: err.stack });
  }
});

void exitCode;
