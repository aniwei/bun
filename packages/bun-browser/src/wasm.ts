/**
 * Shared helpers for instantiating and interacting with bun-core.wasm.
 *
 * Used by both kernel-worker.ts (Worker environment) and integration tests
 * (Node.js / Bun environment).
 */

import { JsiHost, PrintLevel } from "./jsi-host";

export type StdKind = "stdout" | "stderr";

/** Options for createWasmRuntime. */
export interface WasmRuntimeOptions {
  /** Called when the WASM binary calls console.log / print to stdout or stderr. */
  onPrint?: (data: string, kind: StdKind) => void;
  /** Forwarded to JsiHost — optional transpile callback. */
  transpile?: (src: string, filename: string) => string;
}

/** Opaque runtime handle returned by {@link createWasmRuntime}. */
export interface WasmRuntime {
  instance: WebAssembly.Instance;
  host: JsiHost;
  /** Write bytes into WASM linear memory and call fn(ptr, len); frees the buffer after. */
  withBytes(data: Uint8Array, fn: (ptr: number, len: number) => void): void;
  /** Write a UTF-8 string into WASM and call fn(ptr, len); frees after. */
  withString(str: string, fn: (ptr: number, len: number) => void): void;
}

/**
 * Instantiate a compiled bun-core WebAssembly module and return a usable runtime.
 *
 * @param module  A pre-compiled WebAssembly.Module (obtained via WebAssembly.compile).
 * @param opts    Optional callbacks for print output and TypeScript transpilation.
 */
export async function createWasmRuntime(
  module: WebAssembly.Module,
  opts: WasmRuntimeOptions = {},
): Promise<WasmRuntime> {
  const { onPrint, transpile } = opts;
  let _instance: WebAssembly.Instance | undefined;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const host = new JsiHost({
    ...(onPrint
      ? { onPrint: (data: string, level: PrintLevel) => onPrint(data, level === PrintLevel.Stderr ? "stderr" : "stdout") }
      : {}),
    ...(transpile !== undefined ? { transpile } : {}),
  });

  /** Build the minimal WASI shim that routes fd_write to onPrint. */
  function makeWasiShim() {
    const getMem = () => {
      const m = _instance?.exports.memory as WebAssembly.Memory | undefined;
      if (!m) throw new Error("wasm memory unavailable");
      return m;
    };
    return {
      fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number): number => {
        const mem = getMem();
        const view = new DataView(mem.buffer);
        const bytes = new Uint8Array(mem.buffer);
        let total = 0;
        const parts: string[] = [];
        for (let i = 0; i < iovsLen; i++) {
          const p = iovs + i * 8;
          const ptr = view.getUint32(p, true);
          const len = view.getUint32(p + 4, true);
          parts.push(dec.decode(bytes.subarray(ptr, ptr + len)));
          total += len;
        }
        view.setUint32(nwritten, total, true);
        const kind = fd === 2 ? "stderr" : "stdout";
        onPrint?.(parts.join(""), kind);
        return 0;
      },
      proc_exit: (code: number): never => {
        throw Object.assign(new Error(`proc_exit(${code})`), { wasmExitCode: code });
      },
    };
  }

  const wasmImports: WebAssembly.Imports = {
    jsi: host.imports(),
    wasi_snapshot_preview1: makeWasiShim(),
    env: {
      jsi_now_ms: (): bigint => BigInt(Date.now()),
    },
  };

  _instance = (await WebAssembly.instantiate(
    module,
    wasmImports,
  )) as unknown as WebAssembly.Instance;

  host.bind(_instance);

  // Call bun_browser_init (preferred) or _start if present.
  const initFn = _instance.exports.bun_browser_init as (() => void) | undefined;
  const startFn = _instance.exports._start as (() => void) | undefined;
  if (initFn) initFn();
  else if (startFn) startFn();

  const rt: WasmRuntime = {
    instance: _instance,
    host,

    withBytes(data: Uint8Array, fn: (ptr: number, len: number) => void): void {
      const alloc = _instance!.exports.bun_malloc as (n: number) => number;
      const free_ = _instance!.exports.bun_free as (ptr: number) => void;
      const ptr = alloc(data.byteLength);
      if (ptr === 0) throw new Error("bun_malloc returned null");
      new Uint8Array((_instance!.exports.memory as WebAssembly.Memory).buffer, ptr, data.byteLength).set(data);
      try {
        fn(ptr, data.byteLength);
      } finally {
        free_(ptr);
      }
    },

    withString(str: string, fn: (ptr: number, len: number) => void): void {
      this.withBytes(enc.encode(str), fn);
    },
  };

  return rt;
}
