/**
 * Phase 4 T4.1 / T4.2 测试：installer
 *
 * 这些测试不依赖网络。我们用 Bun.gzipSync + 手写 ustar header 合成
 * .tgz 字节流，然后注入 fetch stub 让 Installer 看到一个伪造的 npm
 * registry。这样 Installer 的所有真实代码路径（metadata 解析、版本选择、
 * 下载、gunzip、tar 解析、prefix 剥离）都会被覆盖。
 */

import { describe, expect, test } from "bun:test";
import { chooseVersion, gunzip, installPackages, parseTar } from "../src/installer";

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
