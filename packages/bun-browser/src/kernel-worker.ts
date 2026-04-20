/**
 * Kernel worker 入口 —— 在专用 Web Worker 里拉起 bun-core.wasm + JSI Host。
 *
 * 注意：此文件假定运行在 Web Worker 上下文（`self` 为 `DedicatedWorkerGlobalScope`）。
 * 浏览器端需通过 `new Worker(new URL("./kernel-worker.ts", import.meta.url), { type: "module" })` 加载。
 */

import { PROTOCOL_VERSION, type HostRequest, type KernelEvent } from "./protocol";
import { createWasmRuntime, type WasmRuntime } from "./wasm-utils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const self: any;

function post(event: KernelEvent, transfer: Transferable[] = []): void {
  self.postMessage(event, transfer);
}

let rt: WasmRuntime | undefined;

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
        rt = await createWasmRuntime(msg.wasmModule, {
          onPrint: (data, kind) => post({ kind, data }),
        });
        post({ kind: "handshake:ack", protocolVersion: PROTOCOL_VERSION, engine: "browser" });

        if (msg.vfsSnapshot) {
          const loader = rt.instance.exports.bun_vfs_load_snapshot as
            | ((ptr: number, len: number) => number)
            | undefined;
          if (loader) {
            rt.withBytes(new Uint8Array(msg.vfsSnapshot), (ptr, len) => loader(ptr, len));
          }
        }

        post({ kind: "ready" });

        if (msg.entry) {
          const runner = rt.instance.exports.bun_browser_run as
            | ((entryPtr: number, entryLen: number) => number)
            | undefined;
          if (runner) {
            rt.withString(msg.entry, (ptr, len) => {
              const code = runner(ptr, len);
              post({ kind: "exit", code });
            });
          }
        }
        break;
      }

      case "run": {
        if (!rt) throw new Error("not initialized");
        const runner = rt.instance.exports.bun_browser_run as
          | ((entryPtr: number, entryLen: number) => number)
          | undefined;
        if (!runner) throw new Error("bun_browser_run export missing");
        rt.withString(msg.entry, (ptr, len) => {
          const code = runner(ptr, len);
          post({ kind: "exit", code });
        });
        break;
      }

      case "vfs:snapshot": {
        if (!rt) throw new Error("not initialized");
        const loader = rt.instance.exports.bun_vfs_load_snapshot as
          | ((ptr: number, len: number) => number)
          | undefined;
        if (loader) {
          rt.withBytes(new Uint8Array(msg.snapshot), (ptr, len) => loader(ptr, len));
        }
        break;
      }

      case "eval": {
        if (!rt) throw new Error("not initialized");
        const evalFn = rt.instance.exports.bun_browser_eval as
          | ((srcPtr: number, srcLen: number, filePtr: number, fileLen: number) => number)
          | undefined;
        if (!evalFn) throw new Error("bun_browser_eval export missing");
        let evalErr: string | undefined;
        rt.withString(msg.source, (srcPtr, srcLen) => {
          rt!.withString(msg.filename ?? "<eval>", (filePtr, fileLen) => {
            const code = evalFn(srcPtr, srcLen, filePtr, fileLen);
            if (code !== 0) evalErr = `eval returned exit code ${code}`;
          });
        });
        post({ kind: "eval:result", id: msg.id, error: evalErr });
        break;
      }

      case "stop": {
        post({ kind: "exit", code: msg.code ?? 130 });
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

