/**
 * Phase 5.1 T5.1.2 / T5.1.3 测试：bun_hash / bun_base64_encode / bun_base64_decode / bun_inflate
 *
 * 加载真实 bun-core.wasm，验证新增的纯 Zig stdlib WASM ABIs：
 *   - bun_hash: SHA-1 / SHA-256 / SHA-512 / SHA-384 / MD5
 *   - bun_base64_encode / bun_base64_decode: 与浏览器 btoa/atob 等价
 *   - bun_inflate: gzip 解压（替代 DecompressionStream）
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { createWasmRuntime, type WasmRuntime } from "../src/wasm";
import { createContext, runInContext } from "node:vm";
import { createGzip } from "node:zlib";

const WASM_PATH = import.meta.dir + "/../bun-core.wasm";

let wasmModule: WebAssembly.Module;

beforeAll(async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer();
  wasmModule = await WebAssembly.compile(bytes);
});

async function makeRuntime(): Promise<WasmRuntime> {
  const sandbox = createContext({
    console,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    TextDecoder,
    JSON,
    Math,
    Object,
    Array,
    Promise,
    Error,
    Symbol,
  });
  const evaluator = (code: string, url: string): unknown =>
    runInContext(`(function(){\n${code}\n})()\n//# sourceURL=${url}`, sandbox, { filename: url });
  return createWasmRuntime(wasmModule, { evaluator, global: sandbox });
}

/** gzip a buffer using Node.js's built-in zlib (for test data preparation). */
function nodeGzip(data: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const gz = createGzip();
    gz.on("data", (chunk: Buffer) => chunks.push(chunk));
    gz.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    gz.on("error", reject);
    gz.end(Buffer.from(data));
  });
}

// ── SHA-1 ──────────────────────────────────────────────────────────────────

describe("bun_hash", () => {
  test("SHA-1 of empty string", async () => {
    const rt = await makeRuntime();
    const digest = rt.hash(0, new Uint8Array(0));
    expect(digest).not.toBeNull();
    expect(digest!.byteLength).toBe(20);
    // SHA-1("") = da39a3ee5e6b4b0d3255bfef95601890afd80709
    const hex = Buffer.from(digest!).toString("hex");
    expect(hex).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });

  test("SHA-1 of 'hello'", async () => {
    const rt = await makeRuntime();
    const data = new TextEncoder().encode("hello");
    const digest = rt.hash(0, data)!;
    expect(Buffer.from(digest).toString("hex")).toBe(
      "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d",
    );
  });

  test("SHA-256 of 'hello'", async () => {
    const rt = await makeRuntime();
    const data = new TextEncoder().encode("hello");
    const digest = rt.hash(1, data)!;
    expect(digest.byteLength).toBe(32);
    expect(Buffer.from(digest).toString("hex")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("SHA-512 of 'hello'", async () => {
    const rt = await makeRuntime();
    const data = new TextEncoder().encode("hello");
    const digest = rt.hash(2, data)!;
    expect(digest.byteLength).toBe(64);
    expect(Buffer.from(digest).toString("hex")).toBe(
      "9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca72323c3d99ba5c11d7c7acc6e14b8c5da0c4663475c2e5c3adef46f73bcdec043",
    );
  });

  test("SHA-384 of 'hello'", async () => {
    const rt = await makeRuntime();
    const data = new TextEncoder().encode("hello");
    const digest = rt.hash(3, data)!;
    expect(digest.byteLength).toBe(48);
  });

  test("MD5 of 'hello'", async () => {
    const rt = await makeRuntime();
    const data = new TextEncoder().encode("hello");
    const digest = rt.hash(4, data)!;
    expect(digest.byteLength).toBe(16);
    expect(Buffer.from(digest).toString("hex")).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  test("未知 algo 返回 null", async () => {
    const rt = await makeRuntime();
    const data = new TextEncoder().encode("test");
    // algo=99 未知
    const digest = rt.hash(99 as 0, data);
    expect(digest).toBeNull();
  });
});

// ── Base64 ─────────────────────────────────────────────────────────────────

describe("bun_base64_encode / bun_base64_decode", () => {
  test("encode 空字节数组", async () => {
    const rt = await makeRuntime();
    const result = rt.base64Encode(new Uint8Array(0));
    expect(result).toBe("");
  });

  test("encode 'hello' → btoa 等价", async () => {
    const rt = await makeRuntime();
    const data = new TextEncoder().encode("hello");
    const b64 = rt.base64Encode(data);
    expect(b64).toBe("aGVsbG8=");
  });

  test("decode btoa('hello')", async () => {
    const rt = await makeRuntime();
    const bytes = rt.base64Decode("aGVsbG8=");
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe("hello");
  });

  test("encode/decode roundtrip（二进制数据）", async () => {
    const rt = await makeRuntime();
    const orig = new Uint8Array(256);
    for (let i = 0; i < 256; i++) orig[i] = i;
    const b64 = rt.base64Encode(orig)!;
    const decoded = rt.base64Decode(b64)!;
    expect(decoded).toEqual(orig);
  });

  test("无填充 base64 也能解码", async () => {
    const rt = await makeRuntime();
    // "hello" in base64 without padding: "aGVsbG8"
    const bytes = rt.base64Decode("aGVsbG8");
    expect(new TextDecoder().decode(bytes!)).toBe("hello");
  });
});

// ── bun_inflate ─────────────────────────────────────────────────────────────

describe("bun_inflate", () => {
  test("gzip inflate roundtrip", async () => {
    const rt = await makeRuntime();
    const original = new TextEncoder().encode(
      "Hello, WASM inflate! ".repeat(50),
    );
    const compressed = await nodeGzip(original);
    const decompressed = rt.inflate(compressed, "gzip");
    expect(decompressed).not.toBeNull();
    expect(new TextDecoder().decode(decompressed!)).toBe(
      new TextDecoder().decode(original),
    );
  });

  test("inflating non-gzip data throws", async () => {
    const rt = await makeRuntime();
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    expect(() => rt.inflate(garbage, "gzip")).toThrow();
  });

  test("format 默认为 gzip", async () => {
    const rt = await makeRuntime();
    const original = new TextEncoder().encode("default format test");
    const compressed = await nodeGzip(original);
    const decompressed = rt.inflate(compressed);
    expect(new TextDecoder().decode(decompressed!)).toBe("default format test");
  });
});
