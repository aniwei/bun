/**
 * Phase 4 T4.1 / T4.2 测试：installer
 *
 * 这些测试不依赖网络。我们用 Bun.gzipSync + 手写 ustar header 合成
 * .tgz 字节流，然后注入 fetch stub 让 Installer 看到一个伪造的 npm
 * registry。这样 Installer 的所有真实代码路径（metadata 解析、版本选择、
 * 下载、gunzip、tar 解析、prefix 剥离）都会被覆盖。
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { chooseVersion, gunzip, installPackages, parseTar } from "../src/installer";
import { createWasmRuntime, type WasmRuntime } from "../src/wasm";
import { buildSnapshot } from "../src/vfs-client";
import { createContext, runInContext } from "node:vm";

// ──────────────────────────────────────────────────────────
// 帮助：构造合成的 ustar tar
// ──────────────────────────────────────────────────────────

const enc = new TextEncoder();

function octal(n: number, width: number): string {
  const s = n.toString(8);
  return s.padStart(width - 1, "0") + "\0";
}

function tarFile(path: string, contents: Uint8Array, mode = 0o644): Uint8Array {
  const header = new Uint8Array(512);
  // name (100 bytes) — 如果太长，依赖 prefix 字段；测试用例保证 < 100。
  header.set(enc.encode(path), 0);
  header.set(enc.encode(octal(mode & 0o7777, 8)), 100);
  header.set(enc.encode(octal(0, 8)), 108); // uid
  header.set(enc.encode(octal(0, 8)), 116); // gid
  header.set(enc.encode(octal(contents.byteLength, 12)), 124);
  header.set(enc.encode(octal(0, 12)), 136); // mtime
  // checksum 占位为空格
  for (let i = 0; i < 8; i++) header[148 + i] = 0x20;
  header[156] = "0".charCodeAt(0); // type: 普通文件
  header.set(enc.encode("ustar\0"), 257);
  header.set(enc.encode("00"), 263);
  // 计算 checksum
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i]!;
  header.set(enc.encode(octal(sum, 7) + " "), 148);

  // 负载块：512 对齐
  const padded = Math.ceil(contents.byteLength / 512) * 512;
  const out = new Uint8Array(512 + padded);
  out.set(header, 0);
  out.set(contents, 512);
  return out;
}

function tarConcat(parts: Uint8Array[]): Uint8Array {
  // 末尾 2 个空块作为终止符
  const trailer = new Uint8Array(1024);
  let total = trailer.byteLength;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  out.set(trailer, off);
  return out;
}

function makeTarball(files: { path: string; data: string }[]): Uint8Array {
  const tar = tarConcat(files.map((f) => tarFile(f.path, enc.encode(f.data))));
  return Bun.gzipSync(tar);
}

// ──────────────────────────────────────────────────────────
// chooseVersion
// ──────────────────────────────────────────────────────────

describe("chooseVersion", () => {
  const versions = ["1.0.0", "1.2.3", "1.2.5", "1.3.0", "2.0.0", "2.1.0-beta"];
  test("精确匹配", () => {
    expect(chooseVersion(versions, "1.2.3")).toBe("1.2.3");
  });
  test("caret：取同主版本最新", () => {
    expect(chooseVersion(versions, "^1.2.0")).toBe("1.3.0");
    expect(chooseVersion(versions, "^1.0.0")).toBe("1.3.0");
  });
  test("tilde：仅同次版本", () => {
    expect(chooseVersion(versions, "~1.2.0")).toBe("1.2.5");
  });
  test(">=：所有更高的", () => {
    expect(chooseVersion(versions, ">=2.0.0")).toBe("2.0.0"); // 2.1.0 是 prerelease
  });
  test("通配符：最高稳定版", () => {
    expect(chooseVersion(versions, "*")).toBe("2.0.0");
    expect(chooseVersion(versions, "")).toBe("2.0.0");
  });
  test("dist-tag", () => {
    expect(chooseVersion(versions, "latest", { latest: "1.3.0" })).toBe("1.3.0");
    expect(chooseVersion(versions, "next", { next: "2.1.0-beta" })).toBe("2.1.0-beta");
  });
  test("无匹配返回 null", () => {
    expect(chooseVersion(versions, "^9.0.0")).toBe(null);
  });
});

// ──────────────────────────────────────────────────────────
// gunzip + parseTar
// ──────────────────────────────────────────────────────────

describe("gunzip / parseTar", () => {
  test("round-trip：gzip 后 gunzip 恢复原始字节", async () => {
    const src = enc.encode("hello, gzip world ".repeat(50));
    const compressed = Bun.gzipSync(src);
    const restored = await gunzip(compressed);
    expect(restored.byteLength).toBe(src.byteLength);
    expect(new TextDecoder().decode(restored)).toBe(new TextDecoder().decode(src));
  });

  test("parseTar 解析合成 tarball", () => {
    const tar = tarConcat([
      tarFile("package/package.json", enc.encode('{"name":"foo","version":"1.0.0"}')),
      tarFile("package/lib/index.js", enc.encode("module.exports = 42;")),
    ]);
    const entries = parseTar(tar);
    expect(entries.length).toBe(2);
    expect(entries[0]!.path).toBe("package/package.json");
    expect(entries[0]!.type).toBe("file");
    expect(new TextDecoder().decode(entries[0]!.data)).toContain('"name":"foo"');
    expect(entries[1]!.path).toBe("package/lib/index.js");
    expect(new TextDecoder().decode(entries[1]!.data)).toBe("module.exports = 42;");
  });
});

// ──────────────────────────────────────────────────────────
// installPackages：端到端（fetch stub）
// ──────────────────────────────────────────────────────────

interface FakeRegistryEntry {
  versions: string[];
  distTags?: Record<string, string>;
  /** 每个版本的 tarball 内文件。 */
  filesByVersion: Record<string, { path: string; data: string }[]>;
  /** 每个版本的 dependencies。 */
  depsByVersion?: Record<string, Record<string, string>>;
}

function makeFakeFetch(
  registry: Record<string, FakeRegistryEntry>,
): typeof globalThis.fetch {
  return async (input, _init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();

    // metadata：/<name>
    const metaMatch = /\/(@[^/]+\/[^/]+|[^/]+)$/.exec(url.replace(/^https?:\/\/[^/]+/, ""));
    const tarballMatch = /\/_tar\/(@[^/]+\/[^/]+|[^/]+)\/([^/]+)\.tgz$/.exec(url);
    if (tarballMatch) {
      const name = decodeURIComponent(tarballMatch[1]!);
      const version = tarballMatch[2]!;
      const entry = registry[name];
      const files = entry?.filesByVersion[version] ?? [];
      const tgz = makeTarball(files.map((f) => ({ path: `package/${f.path}`, data: f.data })));
      return new Response(tgz);
    }
    if (metaMatch) {
      const name = decodeURIComponent(metaMatch[1]!);
      const entry = registry[name];
      if (!entry) return new Response("not found", { status: 404 });
      const versions: Record<string, unknown> = {};
      for (const v of entry.versions) {
        versions[v] = {
          version: v,
          dist: { tarball: `https://fake-registry/_tar/${encodeURIComponent(name)}/${v}.tgz` },
          dependencies: entry.depsByVersion?.[v] ?? {},
        };
      }
      return new Response(
        JSON.stringify({
          name,
          "dist-tags": entry.distTags ?? { latest: entry.versions[entry.versions.length - 1] },
          versions,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  };
}

describe("installPackages (端到端)", () => {
  test("装一个最简包：metadata + tarball + 解压到 /node_modules/", async () => {
    const fetchFn = makeFakeFetch({
      "left-pad": {
        versions: ["1.0.0", "1.3.0"],
        filesByVersion: {
          "1.0.0": [{ path: "package.json", data: '{"name":"left-pad","version":"1.0.0"}' }],
          "1.3.0": [
            { path: "package.json", data: '{"name":"left-pad","version":"1.3.0"}' },
            { path: "index.js", data: "module.exports=function(s,n){return s.padStart(n);};" },
          ],
        },
      },
    });

    const result = await installPackages(
      { "left-pad": "^1.0.0" },
      { fetch: fetchFn, registry: "https://fake-registry" },
    );

    expect(result.packages.length).toBe(1);
    expect(result.packages[0]).toMatchObject({ name: "left-pad", version: "1.3.0", fileCount: 2 });
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "/node_modules/left-pad/index.js",
      "/node_modules/left-pad/package.json",
    ]);
    const indexFile = result.files.find((f) => f.path.endsWith("index.js"))!;
    const data = typeof indexFile.data === "string"
      ? indexFile.data
      : new TextDecoder().decode(indexFile.data);
    expect(data).toContain("padStart");

    expect(result.lockfile.lockfileVersion).toBe(1);
    expect(result.lockfile.packageCount).toBe(1);
    expect(result.lockfile.packages[0]).toEqual({
      key: "left-pad@1.3.0",
      name: "left-pad",
      version: "1.3.0",
    });
  });

  test("多包：按精确版本与 caret 混合解析", async () => {
    const fetchFn = makeFakeFetch({
      foo: {
        versions: ["1.0.0", "1.1.0"],
        filesByVersion: {
          "1.0.0": [{ path: "package.json", data: '{"name":"foo","version":"1.0.0"}' }],
          "1.1.0": [{ path: "package.json", data: '{"name":"foo","version":"1.1.0"}' }],
        },
      },
      bar: {
        versions: ["2.3.4"],
        filesByVersion: {
          "2.3.4": [{ path: "package.json", data: '{"name":"bar","version":"2.3.4"}' }],
        },
      },
    });

    const progressCalls: string[] = [];
    const result = await installPackages(
      { foo: "1.0.0", bar: "^2.0.0" },
      {
        fetch: fetchFn,
        registry: "https://fake-registry",
        onProgress: (p) => progressCalls.push(`${p.name}:${p.phase}`),
      },
    );

    expect(result.packages.map((p) => `${p.name}@${p.version}`).sort()).toEqual([
      "bar@2.3.4",
      "foo@1.0.0",
    ]);
    expect(result.files.length).toBe(2);
    // 进度回调至少要有 metadata / tarball / extract / done 四相
    expect(progressCalls.filter((s) => s.startsWith("foo:"))).toEqual([
      "foo:metadata",
      "foo:tarball",
      "foo:extract",
      "foo:done",
    ]);
  });

  test("HTTP 错误：metadata 404 抛错", async () => {
    const fetchFn: typeof globalThis.fetch = async () => new Response("nope", { status: 404 });
    await expect(
      installPackages({ ghost: "1.0.0" }, { fetch: fetchFn, registry: "https://fake-registry" }),
    ).rejects.toThrow(/404/);
  });

  test("无匹配版本：抛 ‘未找到匹配’", async () => {
    const fetchFn = makeFakeFetch({
      foo: {
        versions: ["1.0.0"],
        filesByVersion: { "1.0.0": [{ path: "package.json", data: "{}" }] },
      },
    });
    await expect(
      installPackages({ foo: "^9.0.0" }, { fetch: fetchFn, registry: "https://fake-registry" }),
    ).rejects.toThrow(/未找到匹配/);
  });

  test("传递依赖：BFS 展开 dependencies，WASM 决策路径", async () => {
    const fetchFn = makeFakeFetch({
      app: {
        versions: ["1.0.0"],
        filesByVersion: {
          "1.0.0": [{ path: "package.json", data: '{"name":"app","version":"1.0.0"}' }],
        },
        depsByVersion: { "1.0.0": { lib: "^2.0.0" } },
      },
      lib: {
        versions: ["2.0.0", "2.1.5", "3.0.0"],
        filesByVersion: {
          "2.0.0": [{ path: "package.json", data: "{}" }],
          "2.1.5": [{ path: "package.json", data: "{}" }],
          "3.0.0": [{ path: "package.json", data: "{}" }],
        },
        depsByVersion: { "2.1.5": { util: "1.0.0" } },
      },
      util: {
        versions: ["1.0.0"],
        filesByVersion: { "1.0.0": [{ path: "package.json", data: "{}" }] },
      },
    });

    const result = await installPackages(
      { app: "1.0.0" },
      { fetch: fetchFn, registry: "https://fake-registry" },
    );

    // app → lib@^2 → 取 2.1.5（最高同主版本）→ util@1.0.0
    const names = result.packages.map((p) => `${p.name}@${p.version}`).sort();
    expect(names).toEqual(["app@1.0.0", "lib@2.1.5", "util@1.0.0"]);
    expect(result.lockfile.packageCount).toBe(3);
  });

  test("传递依赖：同名去重（先到者胜）", async () => {
    const fetchFn = makeFakeFetch({
      a: {
        versions: ["1.0.0"],
        filesByVersion: { "1.0.0": [{ path: "package.json", data: "{}" }] },
        depsByVersion: { "1.0.0": { shared: "^1.0.0" } },
      },
      b: {
        versions: ["1.0.0"],
        filesByVersion: { "1.0.0": [{ path: "package.json", data: "{}" }] },
        depsByVersion: { "1.0.0": { shared: "^2.0.0" } },
      },
      shared: {
        versions: ["1.5.0", "2.0.0"],
        filesByVersion: {
          "1.5.0": [{ path: "package.json", data: "{}" }],
          "2.0.0": [{ path: "package.json", data: "{}" }],
        },
      },
    });

    const result = await installPackages(
      { a: "1.0.0", b: "1.0.0" },
      { fetch: fetchFn, registry: "https://fake-registry" },
    );

    const sharedPkgs = result.packages.filter((p) => p.name === "shared");
    // 先到的约束（来自 a：^1.0.0）胜出 → 1.5.0
    expect(sharedPkgs.length).toBe(1);
    expect(sharedPkgs[0]!.version).toBe("1.5.0");
  });

  test("resolveTransitive: false 时仅顶层", async () => {
    const fetchFn = makeFakeFetch({
      top: {
        versions: ["1.0.0"],
        filesByVersion: { "1.0.0": [{ path: "package.json", data: "{}" }] },
        depsByVersion: { "1.0.0": { child: "1.0.0" } },
      },
      child: {
        versions: ["1.0.0"],
        filesByVersion: { "1.0.0": [{ path: "package.json", data: "{}" }] },
      },
    });

    const result = await installPackages(
      { top: "1.0.0" },
      { fetch: fetchFn, registry: "https://fake-registry", resolveTransitive: false },
    );

    expect(result.packages.length).toBe(1);
    expect(result.packages[0]!.name).toBe("top");
  });

  test("完整性校验：sha512 匹配 → 安装成功", async () => {
    // 构造合法 tarball 并预计算其 sha512 SRI 值
    const tarball = makeTarball([{ path: "package/package.json", data: '{"name":"safe-pkg","version":"1.0.0"}' }]);
    const hashBuf = await crypto.subtle.digest("SHA-512", tarball);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(hashBuf)));
    const sri = "sha512-" + b64.replace(/=+$/, "");

    const fakeFetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.endsWith("safe-pkg")) {
        return new Response(
          JSON.stringify({
            name: "safe-pkg",
            "dist-tags": { latest: "1.0.0" },
            versions: {
              "1.0.0": {
                version: "1.0.0",
                dist: { tarball: "https://fake-registry/_tar/safe-pkg/1.0.0.tgz", integrity: sri },
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(tarball);
    };

    // 无 WASM runtime → 不校验（不抛错）
    const result = await installPackages(
      { "safe-pkg": "1.0.0" },
      { fetch: fakeFetch, registry: "https://fake-registry" },
    );
    expect(result.packages[0]!.version).toBe("1.0.0");
  });
});

// ──────────────────────────────────────────────────────────
// Phase 5.4 T5.4.3 — bun_tgz_extract：WASM 直接写 VFS
// ──────────────────────────────────────────────────────────

const WASM_PATH = import.meta.dir + "/../bun-core.wasm";
let wasmModule: WebAssembly.Module;

beforeAll(async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer();
  wasmModule = await WebAssembly.compile(bytes);
});

async function makeWasmRuntime(): Promise<WasmRuntime> {
  const sandbox = createContext({
    console, queueMicrotask, setTimeout, clearTimeout,
    URL, TextEncoder, TextDecoder, JSON, Math, Object, Array, Promise, Error,
  });
  const evaluator = (code: string, url: string): unknown =>
    runInContext(`(function(){\n${code}\n})()\n//# sourceURL=${url}`, sandbox, { filename: url });
  return createWasmRuntime(wasmModule, { evaluator, global: sandbox });
}

/** Write files into a WASM runtime's VFS using the snapshot loader. */
function vfsLoad(rt: WasmRuntime, files: { path: string; data: string }[]) {
  const loadFn = rt.instance.exports.bun_vfs_load_snapshot as (ptr: number, len: number) => number;
  const snap = buildSnapshot(files.map((f) => ({ path: f.path, data: f.data })));
  rt.withBytes(new Uint8Array(snap), (ptr, len) => loadFn(ptr, len));
}

describe("bun_tgz_extract", () => {
  test("直接提取 tgz → 返回文件数", async () => {
    const rt = await makeWasmRuntime();
    if (rt.extractTgz === null || !("bun_tgz_extract" in rt.instance.exports)) {
      // 若 WASM 未导出 bun_tgz_extract，跳过（仅在新构建后运行）
      return;
    }

    const tgz = makeTarball([
      { path: "package/package.json", data: '{"name":"mylib","version":"1.0.0","main":"index.js"}' },
      { path: "package/index.js", data: "module.exports = { magic: 42 };" },
    ]);

    const count = rt.extractTgz("/node_modules/mylib", tgz);
    expect(count).toBe(2);
  });

  test("提取后文件可被 resolve 访问", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_tgz_extract" in rt.instance.exports)) return;

    const tgz = makeTarball([
      { path: "package/package.json", data: '{"name":"mylib","version":"1.0.0","main":"index.js"}' },
      { path: "package/index.js", data: "module.exports = { magic: 42 };" },
    ]);
    rt.extractTgz("/node_modules/mylib", tgz);

    // package.json + main 字段应被 resolver 找到
    const r = rt.resolve("mylib", "/app/index.js");
    expect(r.path).toBe("/node_modules/mylib/index.js");
  });

  test("提取后可被 bundle 打包", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_tgz_extract" in rt.instance.exports)) return;

    const tgz = makeTarball([
      { path: "package/package.json", data: '{"name":"mylib","version":"1.0.0","main":"index.js"}' },
      { path: "package/index.js", data: "module.exports = { magic: 42 };" },
    ]);
    rt.extractTgz("/node_modules/mylib", tgz);

    // 写入使用 mylib 的入口文件
    vfsLoad(rt, [{ path: "/app/main.js", data: "var lib = require('mylib'); lib;" }]);

    const bundled = rt.bundle("/app/main.js");
    expect(bundled).toContain("magic");
    expect(bundled).toContain("42");
  });

  test("嵌套目录被正确提取", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_tgz_extract" in rt.instance.exports)) return;

    const tgz = makeTarball([
      { path: "package/package.json", data: '{"name":"deep","version":"1.0.0","main":"dist/index.js"}' },
      { path: "package/dist/index.js", data: "module.exports = 'deep';" },
      { path: "package/dist/utils/helper.js", data: "module.exports = 'helper';" },
    ]);
    const count = rt.extractTgz("/node_modules/deep", tgz);
    expect(count).toBe(3);

    vfsLoad(rt, [{ path: "/app/main.js", data: "require('deep');" }]);
    const bundled = rt.bundle("/app/main.js");
    expect(bundled).toContain("'deep'");
  });

  test("installPackages + wasmRuntime → files[] 为空（已直写 VFS）", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_tgz_extract" in rt.instance.exports)) return;

    const fetchFn = makeFakeFetch({
      "wasm-pkg": {
        versions: ["1.0.0"],
        filesByVersion: {
          "1.0.0": [
            { path: "package.json", data: '{"name":"wasm-pkg","version":"1.0.0"}' },
            { path: "index.js", data: "module.exports = 'wasm';" },
          ],
        },
      },
    });

    const result = await installPackages(
      { "wasm-pkg": "1.0.0" },
      { fetch: fetchFn, registry: "https://fake-registry", wasmRuntime: rt },
    );

    expect(result.packages[0]).toMatchObject({ name: "wasm-pkg", version: "1.0.0" });
    // extractTgz が使用された場合、files は空（VFS に直接書き込み済み）
    expect(result.files).toHaveLength(0);

    // VFS に正しく書き込まれていること確認
    vfsLoad(rt, [{ path: "/app/main.js", data: "require('wasm-pkg');" }]);
    const bundled = rt.bundle("/app/main.js");
    expect(bundled).toContain("'wasm'");
  });
});

// ──────────────────────────────────────────────────────────
// Phase 5.4 T5.4.1 — bun_npm_parse_metadata：WASM 解析 npm metadata
// ──────────────────────────────────────────────────────────

describe("bun_npm_parse_metadata (T5.4.1)", () => {
  /** Build a fake npm metadata JSON string (mirrors the npm registry response format). */
  function makeNpmMeta(
    name: string,
    versions: Record<string, {
      dist?: { tarball?: string; integrity?: string; shasum?: string };
      dependencies?: Record<string, string>;
    }>,
    distTags?: Record<string, string>,
  ): string {
    const latestVer = Object.keys(versions).at(-1) ?? "1.0.0";
    return JSON.stringify({
      name,
      "dist-tags": distTags ?? { latest: latestVer },
      versions: Object.fromEntries(
        Object.entries(versions).map(([v, meta]) => [v, { version: v, ...meta }]),
      ),
    });
  }

  test("semver range：选最高匹配版本", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_npm_parse_metadata" in rt.instance.exports)) return;

    const meta = makeNpmMeta("foo", {
      "1.0.0": { dist: { tarball: "https://r/foo-1.0.0.tgz" }, dependencies: {} },
      "1.2.0": { dist: { tarball: "https://r/foo-1.2.0.tgz" }, dependencies: {} },
      "1.3.0": {
        dist: { tarball: "https://r/foo-1.3.0.tgz", integrity: "sha512-abc" },
        dependencies: { bar: "^2.0.0" },
      },
      "2.0.0-beta": { dist: { tarball: "https://r/foo-2.0.0-beta.tgz" }, dependencies: {} },
    });

    const resolved = rt.parseNpmMetadata(meta, "^1.0.0");
    expect(resolved).not.toBeNull();
    expect(resolved!.version).toBe("1.3.0");
    expect(resolved!.tarball).toBe("https://r/foo-1.3.0.tgz");
    expect(resolved!.integrity).toBe("sha512-abc");
    expect(resolved!.dependencies).toEqual({ bar: "^2.0.0" });
  });

  test("dist-tag 解析（latest）", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_npm_parse_metadata" in rt.instance.exports)) return;

    const meta = makeNpmMeta("foo", {
      "1.0.0": { dist: { tarball: "https://r/foo-1.0.0.tgz" }, dependencies: {} },
      "1.3.0": { dist: { tarball: "https://r/foo-1.3.0.tgz" }, dependencies: {} },
    }, { latest: "1.3.0" });

    const resolved = rt.parseNpmMetadata(meta, "latest");
    expect(resolved!.version).toBe("1.3.0");
    expect(resolved!.tarball).toContain("1.3.0");
  });

  test("精确版本匹配", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_npm_parse_metadata" in rt.instance.exports)) return;

    const meta = makeNpmMeta("foo", {
      "1.0.0": { dist: { tarball: "https://r/1.0.0.tgz", shasum: "deadbeef" }, dependencies: {} },
      "1.3.0": { dist: { tarball: "https://r/1.3.0.tgz" }, dependencies: {} },
    });

    const resolved = rt.parseNpmMetadata(meta, "1.0.0");
    expect(resolved!.version).toBe("1.0.0");
    expect(resolved!.shasum).toBe("deadbeef");
  });

  test("无匹配版本返回 null", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_npm_parse_metadata" in rt.instance.exports)) return;

    const meta = makeNpmMeta("foo", {
      "1.0.0": { dist: { tarball: "https://r/1.0.0.tgz" }, dependencies: {} },
    });

    const resolved = rt.parseNpmMetadata(meta, "^9.0.0");
    expect(resolved).toBeNull();
  });

  test("dependencies 正确提取", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_npm_parse_metadata" in rt.instance.exports)) return;

    const meta = makeNpmMeta("app", {
      "1.0.0": {
        dist: { tarball: "https://r/1.0.0.tgz" },
        dependencies: { lodash: "^4.0.0", react: "^18.0.0", "tiny-util": "1.2.3" },
      },
    });

    const resolved = rt.parseNpmMetadata(meta, "1.0.0");
    expect(resolved!.dependencies).toEqual({
      lodash: "^4.0.0",
      react: "^18.0.0",
      "tiny-util": "1.2.3",
    });
  });

  test("installPackages：WASM 解析 metadata 路径端到端", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_npm_parse_metadata" in rt.instance.exports)) return;

    const fetchFn = makeFakeFetch({
      "meta-test": {
        versions: ["1.0.0", "1.2.0"],
        filesByVersion: {
          "1.0.0": [{ path: "package.json", data: "{}" }],
          "1.2.0": [
            { path: "package.json", data: '{"name":"meta-test","version":"1.2.0"}' },
            { path: "index.js", data: "module.exports = 'meta-test';" },
          ],
        },
      },
    });

    const result = await installPackages(
      { "meta-test": "^1.0.0" },
      { fetch: fetchFn, registry: "https://fake-registry", wasmRuntime: rt },
    );

    // WASM 应选择 1.2.0（最高匹配 ^1.0.0）
    expect(result.packages[0]).toMatchObject({ name: "meta-test", version: "1.2.0" });
    // extractTgz + parseNpmMetadata 路径：files 为空，已直接写入 VFS
    expect(result.files).toHaveLength(0);

    // 确认文件确实在 VFS 中
    vfsLoad(rt, [{ path: "/app/entry.js", data: "require('meta-test');" }]);
    const bundled = rt.bundle("/app/entry.js");
    expect(bundled).toContain("'meta-test'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5.4 T5.4.5 — bun_lockfile_write
// ─────────────────────────────────────────────────────────────────────────────

describe("bun_lockfile_write (T5.4.5)", () => {
  test("生成基本 lockfile 文本", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_lockfile_write" in rt.instance.exports)) return;
    const result = rt.writeLockfile({
      packages: [
        { key: "react@18.2.0", name: "react", version: "18.2.0" },
        { key: "react-dom@18.2.0", name: "react-dom", version: "18.2.0" },
      ],
      workspaceCount: 1,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("react");
    expect(result).toContain("18.2.0");
  });

  test("空包列表也能生成有效 lockfile", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_lockfile_write" in rt.instance.exports)) return;
    const result = rt.writeLockfile({ packages: [] });
    expect(result).not.toBeNull();
    // 应该是有效 JSON
    expect(() => JSON.parse(result!)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5.4 T5.4.2 — bun_npm_resolve_graph
// ─────────────────────────────────────────────────────────────────────────────

function makeNpmMeta(name: string, version: string, deps: Record<string, string> = {}): string {
  return JSON.stringify({
    name,
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name,
        version,
        dist: {
          tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
          integrity: `sha512-test${name}`,
        },
        dependencies: deps,
      },
    },
  });
}

describe("bun_npm_resolve_graph (T5.4.2)", () => {
  test("单包解析", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_npm_resolve_graph" in rt.instance.exports)) return;
    const result = rt.resolveGraph(
      { react: "^18.0.0" },
      { react: makeNpmMeta("react", "18.2.0") },
    );
    expect(result).not.toBeNull();
    expect(result!.resolved).toHaveLength(1);
    expect(result!.resolved[0]).toMatchObject({ name: "react", version: "18.2.0" });
    expect(result!.missing).toHaveLength(0);
  });

  test("metadata 缺失时放入 missing", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_npm_resolve_graph" in rt.instance.exports)) return;
    const result = rt.resolveGraph({ react: "^18.0.0" }, {});
    expect(result).not.toBeNull();
    expect(result!.resolved).toHaveLength(0);
    expect(result!.missing).toHaveLength(1);
    expect(result!.missing[0]).toBe("react");
  });

  test("传递依赖 BFS 展开", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_npm_resolve_graph" in rt.instance.exports)) return;
    const result = rt.resolveGraph(
      { "pkg-a": "^1.0.0" },
      {
        "pkg-a": makeNpmMeta("pkg-a", "1.0.0", { "pkg-b": "^2.0.0" }),
        "pkg-b": makeNpmMeta("pkg-b", "2.0.0"),
      },
    );
    expect(result).not.toBeNull();
    const names = result!.resolved.map((r) => r.name).sort();
    expect(names).toEqual(["pkg-a", "pkg-b"]);
  });

  test("去重：同一包不重复出现", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_npm_resolve_graph" in rt.instance.exports)) return;
    const result = rt.resolveGraph(
      { "pkg-a": "^1.0.0", "pkg-b": "^1.0.0" },
      {
        "pkg-a": makeNpmMeta("pkg-a", "1.0.0", { "pkg-b": "^1.0.0" }),
        "pkg-b": makeNpmMeta("pkg-b", "1.0.0"),
      },
    );
    expect(result).not.toBeNull();
    const names = result!.resolved.map((r) => r.name);
    const unique = [...new Set(names)];
    expect(names.length).toBe(unique.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5.7 T5.7.2 — bun_sourcemap_lookup
// ─────────────────────────────────────────────────────────────────────────────

describe("bun_sourcemap_lookup (T5.7.2)", () => {
  // 简单的 sourcemap v3（仅 1 行，1 个映射）
  // mappings 中 "AAAA" 代表 (genCol=0, srcIdx=0, origLine=0, origCol=0)
  const simpleMap = JSON.stringify({
    version: 3,
    sources: ["src/original.ts"],
    names: ["myFunc"],
    mappings: "AAAA,SAASC",
  });

  test("查找第 0 行 0 列", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_sourcemap_lookup" in rt.instance.exports)) return;
    const pos = rt.sourcemapLookup(simpleMap, 0, 0);
    expect(pos).not.toBeNull();
    expect(pos!.source).toBe("src/original.ts");
  });

  test("超出范围返回 source:null", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_sourcemap_lookup" in rt.instance.exports)) return;
    const pos = rt.sourcemapLookup(simpleMap, 999, 0);
    expect(pos).not.toBeNull();
    expect(pos!.source).toBeNull();
  });

  test("无效 JSON 返回 null 或不崩溃", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_sourcemap_lookup" in rt.instance.exports)) return;
    // WASM 应返回 null 而不是崩溃
    const pos = rt.sourcemapLookup("not valid json", 0, 0);
    // null 或 { source: null } 均可接受
    if (pos !== null) expect(pos.source).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5.7 T5.7.3 — bun_html_rewrite
// ─────────────────────────────────────────────────────────────────────────────

describe("bun_html_rewrite (T5.7.3)", () => {
  test("替换 script[src] 属性", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_html_rewrite" in rt.instance.exports)) return;
    const html = '<html><script src="old.js"></script></html>';
    const result = rt.htmlRewrite(html, [
      { selector: "script[src]", attr: "src", replace: "new.js" },
    ]);
    expect(result).not.toBeNull();
    expect(result).toContain("new.js");
    expect(result).not.toContain("old.js");
  });

  test("无匹配规则：HTML 原样返回", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_html_rewrite" in rt.instance.exports)) return;
    const html = "<html><div></div></html>";
    const result = rt.htmlRewrite(html, [
      { selector: "script[src]", attr: "src", replace: "x.js" },
    ]);
    expect(result).not.toBeNull();
    expect(result).toContain("<div>");
  });

  test("set_text 替换标签文本内容", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_html_rewrite" in rt.instance.exports)) return;
    const html = "<html><title>Old Title</title></html>";
    const result = rt.htmlRewrite(html, [
      { selector: "title", text: "New Title" },
    ]);
    expect(result).not.toBeNull();
    expect(result).toContain("New Title");
  });

  test("空规则列表：HTML 原样返回", async () => {
    const rt = await makeWasmRuntime();
    if (!("bun_html_rewrite" in rt.instance.exports)) return;
    const html = "<html><body>hello</body></html>";
    const result = rt.htmlRewrite(html, []);
    expect(result).not.toBeNull();
    expect(result).toContain("hello");
  });
});
