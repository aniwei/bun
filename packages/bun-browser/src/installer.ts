/**
 * Phase 4 T4.1 / T4.2 —— Browser-side npm installer.
 *
 * 设计取舍：
 * - 不在 WASM 端实现，因为 src/install/ 强依赖 AsyncHTTP / 本地文件系统。
 * - 走宿主 fetch() 直连 npm registry：metadata 与 tarball 端点都已开启 CORS。
 * - 解压用 DecompressionStream("gzip") + 内联的 ustar parser，避免引入
 *   libarchive WASM（按 RFC 注记，T4.2 的 libarchive 路径推迟到 Phase 5 再做）。
 *
 * 本模块输出的 `installPackages()` 返回一份 VfsFile[]，可以直接给
 * `buildSnapshot()` 写入 WASM VFS（由 `Kernel.installPackages()` 完成）。
 */

import type { VfsFile } from "./vfs-client.js";
import type { WasmRuntime } from "./wasm.js";

/** semver 范围 → 解析后的版本号（JS 子集备用；主路已改为调用 WASM bun_semver_select）。 */
export type SemverRange = string;

/** 安装单包的进度回调。 */
export interface InstallProgress {
  name: string;
  version?: string;
  phase: "metadata" | "tarball" | "extract" | "done";
}

export interface InstallerOptions {
  /** 默认 https://registry.npmjs.org */
  registry?: string;
  /** 注入 fetch 实现（用于测试 / Service Worker 代理）。 */
  fetch?: typeof globalThis.fetch;
  /** 注入 DecompressionStream（用于环境检测；测试可注入纯 JS 实现）。 */
  decompressionStream?: typeof DecompressionStream;
  /** 解压前缀，默认 "/node_modules" */
  installRoot?: string;
  /** 进度回调。 */
  onProgress?: (p: InstallProgress) => void;
  /**
   * 可选：已实例化的 WasmRuntime。
   * 若提供，`chooseVersion` 将通过 WASM 的真实 Zig semver（`bun_semver_select`）
   * 执行，而非内联的 JS 子集。
   */
  wasmRuntime?: WasmRuntime;
  /**
   * 是否递归解析 package.json 里的 dependencies（传递依赖）。
   * 缺省 true。关闭后仅安装顶层 deps 表列出的包。
   * 注意：peerDependencies / optionalDependencies 目前不展开。
   */
  resolveTransitive?: boolean;
}

export interface InstalledPackage {
  name: string;
  version: string;
  /** 该包贡献的 VFS 文件数。 */
  fileCount: number;
  /** package.json 中的 dependencies（原样回传，便于上层做依赖图扁平化）。 */
  dependencies: Record<string, string>;
}

export interface InstallResult {
  /** 解压后将写入 VFS 的文件列表（`/node_modules/<name>/...`）。 */
  files: VfsFile[];
  /** 实际安装的包及其版本。 */
  packages: InstalledPackage[];
  /** 简化版 lockfile JSON（与 `bun_lockfile_parse` 输出格式对齐）。 */
  lockfile: {
    lockfileVersion: 1;
    workspaceCount: 1;
    packageCount: number;
    packages: { key: string; name: string; version: string }[];
  };
}

/**
 * Phase 4：解析 dependencies 表。
 *
 * 传递依赖：采用 BFS 逐层展开，所有 semver 决策都走 WASM 真 Zig semver
 * （若 `opts.wasmRuntime` 提供）。已解析到某 `name@version` 的包不会重复安装；
 * 若同一 `name` 因不同约束解析出不同版本，按“先到者胜”（与 npm 顶层哨兵一致）。
 *
 * `resolveTransitive` 缺省 true；设为 false 时退化为仅顶层。
 */
export async function installPackages(
  deps: Record<string, SemverRange>,
  opts: InstallerOptions = {},
): Promise<InstallResult> {
  const installer = new Installer(opts);
  const resolveTransitive = opts.resolveTransitive !== false;
  const installed: InstalledPackage[] = [];
  const files: VfsFile[] = [];
  /** 已安装过的包名（去重 key：name）。同名只装一个版本。 */
  const seen = new Set<string>();
  /** BFS 队列：待安装的 [name, range] 对。 */
  const queue: Array<[string, SemverRange]> = Object.entries(deps);

  while (queue.length > 0) {
    const [name, range] = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);

    const r = await installer.installOne(name, range);
    installed.push({
      name: r.name,
      version: r.version,
      fileCount: r.files.length,
      dependencies: r.dependencies,
    });
    files.push(...r.files);

    if (resolveTransitive) {
      for (const [childName, childRange] of Object.entries(r.dependencies)) {
        if (!seen.has(childName)) queue.push([childName, childRange]);
      }
    }
  }

  return {
    files,
    packages: installed,
    lockfile: {
      lockfileVersion: 1,
      workspaceCount: 1,
      packageCount: installed.length,
      packages: installed.map((p) => ({
        key: p.name + "@" + p.version,
        name: p.name,
        version: p.version,
      })),
    },
  };
}

class Installer {
  private readonly registry: string;
  private readonly fetchFn: typeof globalThis.fetch;
  /** May be undefined when wasmRuntime.inflate is available as a fallback. */
  private readonly DStream: typeof DecompressionStream | undefined;
  private readonly installRoot: string;
  private readonly onProgress?: (p: InstallProgress) => void;
  private readonly wasmRuntime?: WasmRuntime;

  constructor(opts: InstallerOptions) {
    this.registry = (opts.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error("Installer: 未注入 fetch");
    this.fetchFn = f.bind(globalThis);
    this.DStream = opts.decompressionStream ??
      (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
    // DStream can be absent if wasmRuntime provides inflate support — validated at use time.
    this.installRoot = (opts.installRoot ?? "/node_modules").replace(/\/+$/, "");
    if (opts.onProgress) this.onProgress = opts.onProgress;
    if (opts.wasmRuntime) this.wasmRuntime = opts.wasmRuntime;
  }

  async installOne(
    name: string,
    range: SemverRange,
  ): Promise<{
    name: string;
    version: string;
    files: VfsFile[];
    dependencies: Record<string, string>;
  }> {
    this.onProgress?.({ name, phase: "metadata" });

    let version: string;
    let tarballUrl: string;
    let integrityStr = "";
    let shasumStr = "";
    let dependencies: Record<string, string> = {};

    // T5.4.1: Prefer WASM for metadata parsing + version resolution.
    // WASM receives raw JSON, internally resolves dist-tags + semver, returns result.
    if (this.wasmRuntime?.parseNpmMetadata) {
      const rawJson = await this.fetchRawMetadata(name);
      const resolved = this.wasmRuntime.parseNpmMetadata(rawJson, range);
      if (!resolved) throw new Error(`Installer: 未找到匹配 ${name}@${range}`);
      version = resolved.version;
      tarballUrl = resolved.tarball;
      integrityStr = resolved.integrity ?? "";
      shasumStr = resolved.shasum ?? "";
      dependencies = resolved.dependencies;
    } else {
      // Fallback: TS-side metadata parsing + version resolution.
      const meta = await this.fetchMetadata(name);
      const available = meta.versions ? Object.keys(meta.versions) : [];
      // 优先使用 WASM 的真实 Zig semver；若不可用则回退到 JS 子集实现。
      const chosen = this.wasmRuntime
        ? (this.wasmRuntime.semverSelect(JSON.stringify(available), range) ??
            chooseVersion(available, range, meta["dist-tags"]))
        : chooseVersion(available, range, meta["dist-tags"]);
      if (!chosen) throw new Error(`Installer: 未找到匹配 ${name}@${range}`);
      version = chosen;
      const versionMeta = meta.versions![version]!;
      tarballUrl = versionMeta.dist?.tarball ?? "";
      integrityStr = versionMeta.dist?.integrity ?? "";
      shasumStr = versionMeta.dist?.shasum ?? "";
      dependencies = versionMeta.dependencies ?? {};
    }

    if (!tarballUrl) throw new Error(`Installer: ${name}@${version} 缺少 dist.tarball`);

    this.onProgress?.({ name, version, phase: "tarball" });
    const tgz = await this.fetchBytes(tarballUrl);

    // 完整性校验：用 WASM Zig 实现验证 SRI 值，防止 supply-chain 篡改。
    // 优先取 `integrity`（SRI，sha512）；若缺则取 `shasum`（sha1 hex）。
    if (this.wasmRuntime) {
      const sri = integrityStr || shasumStr;
      if (sri) {
        const result = this.wasmRuntime.integrityVerify(tgz, sri);
        if (result === "fail") throw new Error(`Installer: ${name}@${version} 完整性校验失败`);
        // "bad" = 未知算法 → 继续（向前兼容）
      }
    }

    this.onProgress?.({ name, version, phase: "extract" });

    // Phase 5.4 T5.4.3: prefer direct WASM VFS extraction (inflate + tar parse in Zig).
    // When extractTgz is available, files are written directly into WASM VFS — no
    // snapshot round-trip needed. Return empty files[] to signal this to the caller.
    const prefix = `${this.installRoot}/${name}`;
    if (this.wasmRuntime?.extractTgz) {
      this.wasmRuntime.extractTgz(prefix, tgz);
      this.onProgress?.({ name, version, phase: "done" });
      return {
        name,
        version,
        files: [], // already written to WASM VFS directly
        dependencies,
      };
    }

    // Fallback: Phase 5.1 WASM inflate + JS tar parse (for environments without extractTgz)
    let tarBytes: Uint8Array;
    const wasmInflated = this.wasmRuntime?.inflate(tgz, "gzip") ?? null;
    if (wasmInflated !== null) {
      tarBytes = wasmInflated;
    } else if (this.DStream) {
      tarBytes = await gunzip(tgz, this.DStream);
    } else {
      throw new Error("Installer: 解压不可用（需要 DecompressionStream 或带 bun_inflate 的 WasmRuntime）");
    }
    const entries = parseTar(tarBytes);

    // npm tarball 的所有文件都在 "package/" 前缀下；剥掉并挂到 installRoot/<name>/。
    const files: VfsFile[] = [];
    for (const e of entries) {
      if (e.type !== "file") continue;
      const stripped = stripPackagePrefix(e.path);
      if (stripped === null) continue;
      files.push({ path: `${prefix}/${stripped}`, data: e.data, mode: e.mode });
    }

    this.onProgress?.({ name, version, phase: "done" });
    return {
      name,
      version,
      files,
      dependencies,
    };
  }

  /** Fetch npm registry metadata as raw JSON text (for WASM-side parsing). */
  private async fetchRawMetadata(name: string): Promise<string> {
    const url = `${this.registry}/${encodeURIComponent(name)}`;
    const res = await this.fetchFn(url, {
      headers: { accept: "application/vnd.npm.install-v1+json,application/json" },
    });
    if (!res.ok) throw new Error(`Installer: GET ${url} → ${res.status}`);
    return res.text();
  }

  private async fetchMetadata(name: string): Promise<NpmPackageMetadata> {
    const url = `${this.registry}/${encodeURIComponent(name)}`;
    const res = await this.fetchFn(url, {
      headers: { accept: "application/vnd.npm.install-v1+json,application/json" },
    });
    if (!res.ok) throw new Error(`Installer: GET ${url} → ${res.status}`);
    return (await res.json()) as NpmPackageMetadata;
  }

  private async fetchBytes(url: string): Promise<Uint8Array> {
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`Installer: GET ${url} → ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

interface NpmPackageMetadata {
  name?: string;
  "dist-tags"?: Record<string, string>;
  versions?: Record<
    string,
    {
      version: string;
      dist?: {
          tarball?: string;
          integrity?: string;
          /** legacy sha1 hex — 40 chars */
          shasum?: string;
        };
      dependencies?: Record<string, string>;
    }
  >;
}

// ──────────────────────────────────────────────────────────
// semver 子集
// ──────────────────────────────────────────────────────────
//
// 完整 semver 行为复杂；这里覆盖 Phase 4 验收所需的最小集合：
//   - 完全相等：     "1.2.3"
//   - dist-tag：    "latest" / 任何不含数字开头的字符串
//   - caret：       "^1.2.3" → 选择 >=1.2.3 同主版本最高
//   - tilde：       "~1.2.3" → 选择 >=1.2.3 同次版本最高
//   - 通配符：       "*" / "" / "x" → 最高
//   - 比较符：       ">=1.2.3"（仅 >=）
// 不支持区间（A || B）、`<` `<=` `>`、预发布版本顺序细节。
//

export function chooseVersion(
  available: string[],
  range: SemverRange,
  distTags?: Record<string, string>,
): string | null {
  if (available.length === 0) return null;
  const r = (range ?? "").trim();
  if (r === "" || r === "*" || r === "x" || r === "X") {
    return pickHighestStable(available);
  }
  if (distTags && Object.prototype.hasOwnProperty.call(distTags, r)) {
    const v = distTags[r];
    return v ?? null;
  }
  if (/^\d/.test(r)) {
    const exact = parseSemver(r);
    if (exact !== null) {
      const match = available.find((v) => semverEq(parseSemver(v), exact));
      if (match) return match;
    }
  }
  if (r.startsWith("^") || r.startsWith("~") || r.startsWith(">=")) {
    const op = r.startsWith(">=") ? ">=" : r[0]!;
    const baseStr = r.slice(op.length).trim();
    const base = parseSemver(baseStr);
    if (base === null) return null;
    const candidates = available
      .map((v) => ({ v, p: parseSemver(v) }))
      .filter((x) => x.p !== null && rangeMatch(op, base, x.p!));
    candidates.sort((a, b) => semverCmp(b.p!, a.p!));
    return candidates[0]?.v ?? null;
  }
  // 兜底：精确匹配；否则 latest。
  if (available.includes(r)) return r;
  if (distTags?.["latest"]) return distTags["latest"];
  return pickHighestStable(available);
}

function pickHighestStable(versions: string[]): string | null {
  const stable = versions
    .map((v) => ({ v, p: parseSemver(v) }))
    .filter((x) => x.p !== null && x.p!.pre.length === 0);
  const pool = stable.length > 0 ? stable : versions.map((v) => ({ v, p: parseSemver(v) })).filter((x) => x.p !== null);
  pool.sort((a, b) => semverCmp(b.p!, a.p!));
  return pool[0]?.v ?? null;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  pre: string;
}

function parseSemver(v: string): ParsedSemver | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.+))?$/.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    pre: m[4] ?? "",
  };
}

function semverEq(a: ParsedSemver | null, b: ParsedSemver | null): boolean {
  if (!a || !b) return false;
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch && a.pre === b.pre;
}

function semverCmp(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // 有预发布的版本视为更小
  if (a.pre === b.pre) return 0;
  if (a.pre === "") return 1;
  if (b.pre === "") return -1;
  return a.pre < b.pre ? -1 : 1;
}

function rangeMatch(op: "^" | "~" | ">=" | string, base: ParsedSemver, v: ParsedSemver): boolean {
  if (semverCmp(v, base) < 0) return false;
  // npm 语义：当 range 不显式带预发布时，候选版本中的预发布会被排除。
  if (base.pre === "" && v.pre !== "") return false;
  if (op === ">=") return true;
  if (op === "^") return v.major === base.major && v.major !== 0
    ? true
    : v.major === 0 && v.minor === base.minor;
  if (op === "~") return v.major === base.major && v.minor === base.minor;
  return false;
}

// ──────────────────────────────────────────────────────────
// gunzip
// ──────────────────────────────────────────────────────────

export async function gunzip(
  bytes: Uint8Array,
  D: typeof DecompressionStream = (globalThis as { DecompressionStream: typeof DecompressionStream })
    .DecompressionStream,
): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new D("gzip"));
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// ──────────────────────────────────────────────────────────
// ustar / pax tar parser（最小集合）
// ──────────────────────────────────────────────────────────

export interface TarEntry {
  path: string;
  type: "file" | "dir" | "symlink" | "longname" | "longlink" | "pax" | "global-pax" | "other";
  mode: number;
  data: Uint8Array;
}

const BLOCK = 512;
const decoder = new TextDecoder("utf-8");

export function parseTar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  let pendingLongName: string | null = null;
  let pendingPaxName: string | null = null;
  while (off + BLOCK <= bytes.byteLength) {
    const header = bytes.subarray(off, off + BLOCK);
    if (isAllZero(header)) {
      off += BLOCK;
      continue;
    }
    const name = readString(header, 0, 100);
    const mode = readOctal(header, 100, 8);
    const size = readOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const prefix = readString(header, 345, 155);
    const ustar = readString(header, 257, 6);

    let fullPath = name;
    if (ustar === "ustar" && prefix.length > 0 && typeFlag !== "L" && typeFlag !== "x") {
      fullPath = prefix + "/" + name;
    }

    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.byteLength) break;
    const data = bytes.subarray(dataStart, dataEnd);

    const blocks = Math.ceil(size / BLOCK);
    off = dataStart + blocks * BLOCK;

    if (typeFlag === "L") {
      // GNU long name extension
      pendingLongName = trimNul(decoder.decode(data));
      continue;
    }
    if (typeFlag === "x") {
      // pax extended header: parse "<len> path=<value>\n"
      pendingPaxName = parsePaxPath(decoder.decode(data));
      continue;
    }
    if (typeFlag === "g") {
      continue; // global pax header — ignore
    }

    const finalPath = pendingPaxName ?? pendingLongName ?? fullPath;
    pendingLongName = null;
    pendingPaxName = null;

    let type: TarEntry["type"];
    if (typeFlag === "5" || (size === 0 && finalPath.endsWith("/"))) type = "dir";
    else if (typeFlag === "2") type = "symlink";
    else if (typeFlag === "0" || typeFlag === "\0" || typeFlag === "" || typeFlag === "7") type = "file";
    else type = "other";

    entries.push({
      path: finalPath,
      type,
      mode,
      data: type === "file" ? new Uint8Array(data) : new Uint8Array(0),
    });
  }
  return entries;
}

function isAllZero(buf: Uint8Array): boolean {
  for (let i = 0; i < buf.byteLength; i++) if (buf[i] !== 0) return false;
  return true;
}

function readString(buf: Uint8Array, off: number, len: number): string {
  return trimNul(decoder.decode(buf.subarray(off, off + len)));
}

function trimNul(s: string): string {
  const idx = s.indexOf("\0");
  return idx >= 0 ? s.slice(0, idx) : s;
}

function readOctal(buf: Uint8Array, off: number, len: number): number {
  const s = readString(buf, off, len).trim();
  if (s.length === 0) return 0;
  return parseInt(s, 8);
}

function parsePaxPath(text: string): string | null {
  // 每个记录格式： "<length> <key>=<value>\n"
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp < 0) break;
    const len = Number(text.slice(i, sp));
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(i, i + len);
    const eq = record.indexOf("=");
    if (eq > 0) {
      const key = record.slice(record.indexOf(" ") + 1, eq);
      const value = record.slice(eq + 1, record.length - 1); // 去掉末尾 \n
      if (key === "path") return value;
    }
    i += len;
  }
  return null;
}

function stripPackagePrefix(p: string): string | null {
  // npm tarball 的所有条目都以 "package/" 开头
  if (p === "package" || p === "package/") return null;
  if (p.startsWith("package/")) return p.slice("package/".length);
  // 某些 monorepo 包会用其他前缀（例如 "package2/"），跳过
  const slash = p.indexOf("/");
  if (slash > 0) return p.slice(slash + 1);
  return null;
}
