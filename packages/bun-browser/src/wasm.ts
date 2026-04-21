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
  /** Forwarded to JsiHost — optional evaluator (e.g. vm.runInContext for Node host). */
  evaluator?: (code: string, url: string) => unknown;
  /** Forwarded to JsiHost — the object that becomes `globalThis` inside WASM (handle 4). */
  global?: object;
}

/** Opaque runtime handle returned by {@link createWasmRuntime}. */
export interface WasmRuntime {
  instance: WebAssembly.Instance;
  host: JsiHost;
  /** Write bytes into WASM linear memory and call fn(ptr, len); frees the buffer after. */
  withBytes(data: Uint8Array, fn: (ptr: number, len: number) => void): void;
  /** Write a UTF-8 string into WASM and call fn(ptr, len); frees after. */
  withString(str: string, fn: (ptr: number, len: number) => void): void;
  /**
   * Phase 1 T1.1：调用 WASM 导出的 `bun_lockfile_parse(text)` 并返回解析结果。
   *
   * 接受 bun.lock 文本内容，返回 `{ lockfileVersion, workspaceCount, packageCount, packages: [...] }`。
   * 若 bun-core.wasm 未导出此函数则抛错。
   */
  parseLockfile(text: string): LockfileSummary;
  /**
   * Phase 1 T1.1：调用 `bun_resolve(specifier, from)`。
   *
   * 返回 `{ path, loader }`，遵循 Node/bun 风格的扩展名与 `index.*` 探测；
   * 若 specifier 为裸包，会在 from 的祖先目录中搜索 `node_modules/<spec>`。
   */
  resolve(specifier: string, from: string): ResolveResult;
  /**
   * Phase 1 T1.1：调用 `bun_bundle(entry)`。
   *
   * 入口必须是 VFS 绝对路径。返回自包含的 IIFE JS 代码，安装 __modules__ 表
   * 并执行入口。扫描的依赖形式：`require("...")` / `import ... from "..."` /
   * `import("...")` / `export ... from "..."`（仅静态字符串 specifier）。
   */
  bundle(entry: string): string;
}

/** Phase 1 T1.1：bun_resolve 返回结构。 */
export interface ResolveResult {
  path: string;
  loader: "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "json";
}

/** Phase 1 T1.1 返回结构。 */
export interface LockfileSummary {
  lockfileVersion: number;
  workspaceCount: number;
  packageCount: number;
  packages: Array<{ key: string; name: string; version: string }>;
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
  const { onPrint, transpile, evaluator, global } = opts;
  let _instance: WebAssembly.Instance | undefined;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const host = new JsiHost({
    ...(onPrint
      ? { onPrint: (data: string, level: PrintLevel) => onPrint(data, level === PrintLevel.Stderr ? "stderr" : "stdout") }
      : {}),
    ...(transpile !== undefined ? { transpile } : {}),
    ...(evaluator !== undefined ? { evaluator } : {}),
    ...(global !== undefined ? { global } : {}),
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

    parseLockfile(text: string): LockfileSummary {
      const exports_ = _instance!.exports as Record<string, unknown>;
      const parseFn = exports_.bun_lockfile_parse as
        | ((ptr: number, len: number) => bigint)
        | undefined;
      const free_ = exports_.bun_free as (ptr: number) => void;
      if (!parseFn) throw new Error("bun-core.wasm does not export bun_lockfile_parse");
      const mem = () => (_instance!.exports.memory as WebAssembly.Memory).buffer;
      const bytes = enc.encode(text);
      const alloc = _instance!.exports.bun_malloc as (n: number) => number;
      const inputPtr = alloc(bytes.byteLength);
      if (inputPtr === 0) throw new Error("bun_malloc returned null");
      new Uint8Array(mem(), inputPtr, bytes.byteLength).set(bytes);
      let packed: bigint;
      try {
        packed = parseFn(inputPtr, bytes.byteLength);
      } finally {
        free_(inputPtr);
      }
      const outPtr = Number(packed >> 32n) >>> 0;
      const outLen = Number(packed & 0xffffffffn) >>> 0;
      if (outPtr === 0) {
        const codes: Record<number, string> = { 1: "OOM", 2: "invalid JSON", 3: "missing lockfileVersion" };
        throw new Error(`bun_lockfile_parse failed: ${codes[outLen] ?? `code=${outLen}`}`);
      }
      try {
        const view = new Uint8Array(mem(), outPtr, outLen);
        const json = dec.decode(view);
        return JSON.parse(json) as LockfileSummary;
      } finally {
        free_(outPtr);
      }
    },

    resolve(specifier: string, from: string): ResolveResult {
      const exports_ = _instance!.exports as Record<string, unknown>;
      const resolveFn = exports_.bun_resolve as
        | ((sp: number, sl: number, fp: number, fl: number) => bigint)
        | undefined;
      const alloc = exports_.bun_malloc as (n: number) => number;
      const free_ = exports_.bun_free as (ptr: number) => void;
      if (!resolveFn) throw new Error("bun-core.wasm does not export bun_resolve");
      const mem = () => (_instance!.exports.memory as WebAssembly.Memory).buffer;
      const sbytes = enc.encode(specifier);
      const fbytes = enc.encode(from);
      const sPtr = alloc(Math.max(1, sbytes.byteLength));
      const fPtr = alloc(Math.max(1, fbytes.byteLength));
      if (sPtr === 0 || fPtr === 0) throw new Error("bun_malloc returned null");
      if (sbytes.byteLength > 0)
        new Uint8Array(mem(), sPtr, sbytes.byteLength).set(sbytes);
      if (fbytes.byteLength > 0)
        new Uint8Array(mem(), fPtr, fbytes.byteLength).set(fbytes);
      let packed: bigint;
      try {
        packed = resolveFn(sPtr, sbytes.byteLength, fPtr, fbytes.byteLength);
      } finally {
        free_(sPtr);
        free_(fPtr);
      }
      const outPtr = Number(packed >> 32n) >>> 0;
      const outLen = Number(packed & 0xffffffffn) >>> 0;
      if (outPtr === 0) {
        const codes: Record<number, string> = {
          1: "OOM",
          2: "module not found",
          3: "empty specifier",
          4: "bare package not resolvable",
        };
        throw new Error(`bun_resolve(${specifier}) failed: ${codes[outLen] ?? `code=${outLen}`}`);
      }
      try {
        const json = dec.decode(new Uint8Array(mem(), outPtr, outLen));
        return JSON.parse(json) as ResolveResult;
      } finally {
        free_(outPtr);
      }
    },

    bundle(entry: string): string {
      const exports_ = _instance!.exports as Record<string, unknown>;
      const bundleFn = exports_.bun_bundle as
        | ((p: number, l: number) => bigint)
        | undefined;
      const alloc = exports_.bun_malloc as (n: number) => number;
      const free_ = exports_.bun_free as (ptr: number) => void;
      if (!bundleFn) throw new Error("bun-core.wasm does not export bun_bundle");
      const mem = () => (_instance!.exports.memory as WebAssembly.Memory).buffer;
      const bytes = enc.encode(entry);
      const ptr = alloc(Math.max(1, bytes.byteLength));
      if (ptr === 0) throw new Error("bun_malloc returned null");
      if (bytes.byteLength > 0)
        new Uint8Array(mem(), ptr, bytes.byteLength).set(bytes);
      let packed: bigint;
      try {
        packed = bundleFn(ptr, bytes.byteLength);
      } finally {
        free_(ptr);
      }
      const outPtr = Number(packed >> 32n) >>> 0;
      const outLen = Number(packed & 0xffffffffn) >>> 0;
      if (outPtr === 0) {
        const codes: Record<number, string> = {
          1: "OOM",
          2: "entry not found",
          3: "module graph too deep",
          4: "transpile failed",
        };
        throw new Error(`bun_bundle(${entry}) failed: ${codes[outLen] ?? `code=${outLen}`}`);
      }
      try {
        return dec.decode(new Uint8Array(mem(), outPtr, outLen));
      } finally {
        free_(outPtr);
      }
    },
  };

  return rt;
}
