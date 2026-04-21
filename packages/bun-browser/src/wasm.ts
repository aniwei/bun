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
  /**
   * Zig 复用步骤 2：调用 `bun_semver_select(versionsJson, range)`。
   *
   * `versionsJson` 是版本字符串 JSON 数组，如 `["1.0.0","2.0.0"]`。
   * `range` 是 semver 范围字符串，如 `"^1.0.0"`。
   * 返回最高匹配版本字符串，或在无匹配时返回 `null`。
   * 使用真实 Zig semver 解析器（src/semver/*）。
   */
  semverSelect(versionsJson: string, range: string): string | null;
  /**
   * 校验 tarball 字节的完整性。
   *
   * `integrity` 是 SRI 字符串（如 `"sha512-<base64>"`）或裸 sha1 hex（40 字符）。
   * 返回：
   *   `"ok"`   — 校验通过（或 integrity 为空 / 未知算法）
   *   `"fail"` — 哈希不匹配
   *   `"bad"`  — integrity 字符串格式错误
   * 若 WASM 不导出该函数，返回 `"ok"`（向后兼容）。
   */
  integrityVerify(data: Uint8Array, integrity: string): "ok" | "fail" | "bad";
  /**
   * Phase 5.1 T5.1.2：计算原始加密摘要。
   *
   * algo: 0=SHA-1(20B), 1=SHA-256(32B), 2=SHA-512(64B), 3=SHA-384(48B), 4=MD5(16B)
   *
   * 返回原始摘要字节（未做 hex/base64 编码）。
   * 若 WASM 不导出 bun_hash，返回 null。
   */
  hash(algo: 0 | 1 | 2 | 3 | 4, data: Uint8Array): Uint8Array | null;
  /**
   * Phase 5.1 T5.1.2：Base64 编码（标准，带 `=` 填充）。
   *
   * 若 WASM 不导出 bun_base64_encode，返回 null。
   */
  base64Encode(data: Uint8Array): string | null;
  /**
   * Phase 5.1 T5.1.2：Base64 解码（兼容带/不带 `=` 填充的输入）。
   *
   * 若 WASM 不导出 bun_base64_decode，返回 null。
   * 输入非法 base64 时抛 Error。
   */
  base64Decode(b64: string): Uint8Array | null;
  /**
   * Phase 5.1 T5.1.3：解压数据。
   *
   * format: `"gzip"` (默认) | `"zlib"` | `"raw"`
   *
   * 若 WASM 不导出 bun_inflate，返回 null。
   * 解压失败时抛 Error。
   */
  inflate(data: Uint8Array, format?: "gzip" | "zlib" | "raw"): Uint8Array | null;
  /**
   * Phase 5.1 T5.1.3：压缩数据。
   *
   * format: `"gzip"` (默认) | `"zlib"` | `"raw"`
   *
   * 若 WASM 不导出 bun_deflate，返回 null。
   * 压缩失败时抛 Error。
   */
  deflate(data: Uint8Array, format?: "gzip" | "zlib" | "raw"): Uint8Array | null;
  /**
   * Phase 5.1 T5.1.1：使用 std.fs.path.resolvePosix 规范化 POSIX 路径。
   *
   * 解析 `.`/`..`，折叠重复 `/`，始终返回绝对路径（以 `/` 开头）。
   * 若 WASM 不导出 bun_path_normalize，返回 null。
   */
  pathNormalize(path: string): string | null;
  /**
   * Phase 5.1 T5.1.1：返回路径的目录部分（最后一个 `/` 之前）。
   *
   * 根路径返回 `"/"`,  无 `/` 的路径返回 `"/"`.
   * 若 WASM 不导出 bun_path_dirname，返回 null。
   */
  pathDirname(path: string): string | null;
  /**
   * Phase 5.1 T5.1.1：拼接两段 POSIX 路径后规范化。
   *
   * `rel` 以 `/` 开头时忽略 `base`，直接规范化 `rel`。
   * 若 WASM 不导出 bun_path_join，返回 null。
   */
  pathJoin(base: string, rel: string): string | null;
  /**
   * Phase 5.1 T5.1.4：使用 std.Uri 解析 URL 字符串。
   *
   * 返回 URL 各组成部分。解析失败时返回 null。
   * 若 WASM 不导出 bun_url_parse，返回 null。
   */
  urlParse(url: string): UrlComponents | null;
  /**
   * Phase 5.2：TS/JSX → JS 内置转译（`bun_transform`）。
   *
   * 输入：原始源码 + 文件名（用于推断 ts/tsx/jsx）+ 可选 JSX 模式。
   * 输出：`{ code, errors }`。`code` 为 null 时 `errors` 非空。
   * 若 WASM 不导出 `bun_transform`，返回 null。
   */
  transform(source: string, filename: string, opts?: TransformOptions): TransformResult | null;
}

/** Phase 1 T1.1：bun_resolve 返回结构。 */
export interface ResolveResult {
  path: string;
  loader: "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "json";
}

/**
 * Phase 5.2：`transform` 的可选参数。
 *
 * `jsx`:
 *   - `"react"` (默认)：`<div/>` → `React.createElement('div')`
 *   - `"react-jsx"`：React 17+ automatic runtime，顶部自动 `import { jsx, jsxs, Fragment } from 'react/jsx-runtime'`
 *   - `"preserve"`：保留 JSX 原样
 *   - `"none"`：.ts 文件禁用 JSX 处理
 */
export interface TransformOptions {
  jsx?: "react" | "react-jsx" | "preserve" | "none";
}

/** Phase 5.2：`transform` 返回结构。 */
export interface TransformResult {
  code: string | null;
  errors: string[];
}

/** Phase 5.1 T5.1.4：bun_url_parse 返回结构（与 node:url.parse 对齐）。 */
export interface UrlComponents {
  href: string;
  scheme: string;
  protocol: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
  auth: null;
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

  // ── Phase 5.1 shared helpers ──────────────────────────────────────────

  /**
   * Call a WASM export that takes (in_ptr, in_len [, extra_u32]) and returns a
   * u64-packed (out_ptr << 32 | out_len) result pointing to a host_allocs buffer.
   *
   * Returns { ptr, len, free_ } on success, null when the export is missing or
   * the WASM returned packError (ptr === 0).
   *
   * When throwOnError=true and the export EXISTS but returned an error (ptr===0),
   * throws instead of returning null.
   */
  function callPackedRaw(
    fnName: string,
    data: Uint8Array,
    extra: number | undefined,
    throwOnError: boolean,
  ): { ptr: number; len: number; free_: (p: number) => void } | null {
    const exports_ = _instance!.exports as Record<string, unknown>;
    const fn_ = extra === undefined
      ? (exports_[fnName] as ((p: number, l: number) => bigint) | undefined)
      : (exports_[fnName] as ((p: number, l: number, x: number) => bigint) | undefined);
    if (!fn_) return null; // export not present — caller falls back gracefully
    const alloc = exports_.bun_malloc as (n: number) => number;
    const free_ = exports_.bun_free as (ptr: number) => void;
    const iPtr = alloc(Math.max(1, data.byteLength));
    if (iPtr === 0) throw new Error(`bun_malloc returned 0 calling ${fnName}`);
    const mem = () => (_instance!.exports.memory as WebAssembly.Memory).buffer;
    if (data.byteLength > 0)
      new Uint8Array(mem(), iPtr, data.byteLength).set(data);
    let packed: bigint;
    try {
      packed = extra === undefined
        ? (fn_ as (p: number, l: number) => bigint)(iPtr, data.byteLength)
        : (fn_ as (p: number, l: number, x: number) => bigint)(iPtr, data.byteLength, extra);
    } finally {
      free_(iPtr);
    }
    const outPtr = Number(packed >> 32n) >>> 0;
    const outLen = Number(packed & 0xffffffffn) >>> 0;
    if (outPtr === 0) {
      if (throwOnError) throw new Error(`${fnName} failed (error code ${outLen})`);
      return null;
    }
    return { ptr: outPtr, len: outLen, free_ };
  }

  /** Convenience wrapper: returns a Uint8Array copy, or null if not available. */
  function callPacked1x(
    fnName: string,
    data: Uint8Array,
    extra: number | undefined,
    throwOnError: boolean,
  ): Uint8Array | null {
    const r = callPackedRaw(fnName, data, extra, throwOnError);
    if (!r) return null;
    const mem = (_instance!.exports.memory as WebAssembly.Memory).buffer;
    try {
      return new Uint8Array(mem, r.ptr, r.len).slice();
    } finally {
      r.free_(r.ptr);
    }
  }

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

    integrityVerify(data: Uint8Array, integrity: string): "ok" | "fail" | "bad" {
      const exports_ = _instance!.exports as Record<string, unknown>;
      const verifyFn = exports_.bun_integrity_verify as
        | ((dp: number, dl: number, ip: number, il: number) => number)
        | undefined;
      if (!verifyFn) return "ok"; // forward-compatible: treat missing as pass
      const alloc = exports_.bun_malloc as (n: number) => number;
      const free_ = exports_.bun_free as (ptr: number) => void;
      const mem = () => (_instance!.exports.memory as WebAssembly.Memory).buffer;
      const ibytes = enc.encode(integrity);
      const dPtr = alloc(Math.max(1, data.byteLength));
      const iPtr = alloc(Math.max(1, ibytes.byteLength));
      if (dPtr === 0 || iPtr === 0) return "ok";
      if (data.byteLength > 0)
        new Uint8Array(mem(), dPtr, data.byteLength).set(data);
      if (ibytes.byteLength > 0)
        new Uint8Array(mem(), iPtr, ibytes.byteLength).set(ibytes);
      let code: number;
      try {
        code = verifyFn(dPtr, data.byteLength, iPtr, ibytes.byteLength);
      } finally {
        free_(dPtr);
        free_(iPtr);
      }
      if (code === 0) return "ok";
      if (code === 1) return "fail";
      return "bad";
    },

    semverSelect(versionsJson: string, range: string): string | null {
      const exports_ = _instance!.exports as Record<string, unknown>;
      const selectFn = exports_.bun_semver_select as
        | ((vp: number, vl: number, rp: number, rl: number) => bigint)
        | undefined;
      const alloc = exports_.bun_malloc as (n: number) => number;
      const free_ = exports_.bun_free as (ptr: number) => void;
      if (!selectFn) return null; // WASM not built with semver support
      const mem = () => (_instance!.exports.memory as WebAssembly.Memory).buffer;
      const vbytes = enc.encode(versionsJson);
      const rbytes = enc.encode(range);
      const vPtr = alloc(Math.max(1, vbytes.byteLength));
      const rPtr = alloc(Math.max(1, rbytes.byteLength));
      if (vPtr === 0 || rPtr === 0) return null;
      if (vbytes.byteLength > 0)
        new Uint8Array(mem(), vPtr, vbytes.byteLength).set(vbytes);
      if (rbytes.byteLength > 0)
        new Uint8Array(mem(), rPtr, rbytes.byteLength).set(rbytes);
      let packed: bigint;
      try {
        packed = selectFn(vPtr, vbytes.byteLength, rPtr, rbytes.byteLength);
      } finally {
        free_(vPtr);
        free_(rPtr);
      }
      const outPtr = Number(packed >> 32n) >>> 0;
      const outLen = Number(packed & 0xffffffffn) >>> 0;
      if (outPtr === 0) return null;
      try {
        return dec.decode(new Uint8Array(mem(), outPtr, outLen));
      } finally {
        free_(outPtr);
      }
    },

    hash(algo: 0 | 1 | 2 | 3 | 4, data: Uint8Array): Uint8Array | null {
      return callPacked1x("bun_hash", data, algo, /* throwOnError */ false) as Uint8Array | null;
    },

    base64Encode(data: Uint8Array): string | null {
      if (data.byteLength === 0) return "";
      const r = callPackedRaw("bun_base64_encode", data, undefined, false);
      if (!r) return null;
      if (r.len === 0) { r.free_(r.ptr); return ""; }
      const mem = (_instance!.exports.memory as WebAssembly.Memory).buffer;
      try {
        return dec.decode(new Uint8Array(mem, r.ptr, r.len));
      } finally {
        r.free_(r.ptr);
      }
    },

    base64Decode(b64: string): Uint8Array | null {
      return callPacked1x("bun_base64_decode", enc.encode(b64), undefined, /* throwOnError */ true) as Uint8Array | null;
    },

    inflate(data: Uint8Array, format: "gzip" | "zlib" | "raw" = "gzip"): Uint8Array | null {
      const fmtCode = { gzip: 0, zlib: 1, raw: 2 }[format] ?? 0;
      return callPacked1x("bun_inflate", data, fmtCode, /* throwOnError */ true) as Uint8Array | null;
    },

    deflate(data: Uint8Array, format: "gzip" | "zlib" | "raw" = "gzip"): Uint8Array | null {
      const fmtCode = { gzip: 0, zlib: 1, raw: 2 }[format] ?? 0;
      return callPacked1x("bun_deflate", data, fmtCode, /* throwOnError */ true) as Uint8Array | null;
    },

    // ── Phase 5.1 T5.1.1 — path ABIs ───────────────────────────────────────

    pathNormalize(path: string): string | null {
      const r = callPackedRaw("bun_path_normalize", enc.encode(path), undefined, false);
      if (!r) return null;
      const mem = (_instance!.exports.memory as WebAssembly.Memory).buffer;
      try { return dec.decode(new Uint8Array(mem, r.ptr, r.len)); } finally { r.free_(r.ptr); }
    },

    pathDirname(path: string): string | null {
      const r = callPackedRaw("bun_path_dirname", enc.encode(path), undefined, false);
      if (!r) return null;
      const mem = (_instance!.exports.memory as WebAssembly.Memory).buffer;
      try { return dec.decode(new Uint8Array(mem, r.ptr, r.len)); } finally { r.free_(r.ptr); }
    },

    pathJoin(base: string, rel: string): string | null {
      // Pack: [base_len: u32 LE][base bytes][rel bytes]
      const baseBytes = enc.encode(base);
      const relBytes = enc.encode(rel);
      const buf = new Uint8Array(4 + baseBytes.byteLength + relBytes.byteLength);
      new DataView(buf.buffer).setUint32(0, baseBytes.byteLength, /* littleEndian */ true);
      buf.set(baseBytes, 4);
      buf.set(relBytes, 4 + baseBytes.byteLength);
      const r = callPackedRaw("bun_path_join", buf, undefined, false);
      if (!r) return null;
      const mem = (_instance!.exports.memory as WebAssembly.Memory).buffer;
      try { return dec.decode(new Uint8Array(mem, r.ptr, r.len)); } finally { r.free_(r.ptr); }
    },

    // ── Phase 5.1 T5.1.4 — URL parsing via WASM export ─────────────────────

    urlParse(url: string): import("./wasm").UrlComponents | null {
      const r = callPackedRaw("bun_url_parse", enc.encode(url), undefined, false);
      if (!r) return null;
      const mem = (_instance!.exports.memory as WebAssembly.Memory).buffer;
      try {
        const json = dec.decode(new Uint8Array(mem, r.ptr, r.len));
        return JSON.parse(json) as import("./wasm").UrlComponents;
      } finally {
        r.free_(r.ptr);
      }
    },

    // ── Phase 5.2 — TS/JSX transform via WASM export ───────────────────────

    transform(source: string, filename: string, opts?: TransformOptions): TransformResult | null {
      const exports_ = _instance!.exports as Record<string, unknown>;
      if (!exports_.bun_transform) return null;
      const payload = enc.encode(
        JSON.stringify({
          code: source,
          filename,
          jsx: opts?.jsx ?? "react",
        }),
      );
      const r = callPackedRaw("bun_transform", payload, undefined, false);
      if (!r) return { code: null, errors: ["bun_transform returned error"] };
      const mem = (_instance!.exports.memory as WebAssembly.Memory).buffer;
      try {
        const json = dec.decode(new Uint8Array(mem, r.ptr, r.len));
        const parsed = JSON.parse(json) as TransformResult;
        return parsed;
      } finally {
        r.free_(r.ptr);
      }
    },
  };

  return rt;
}
