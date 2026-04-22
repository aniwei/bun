/**
 * Shared helpers for instantiating and interacting with bun-core.wasm.
 *
 * Used by both kernel-worker.ts (Worker environment) and integration tests
 * (Node.js / Bun environment).
 */

import { JsiHost, PrintLevel } from './jsi-host'

export type StdKind = 'stdout' | 'stderr'

/** Options for createWasmRuntime. */
export interface WasmRuntimeOptions {
  /** Called when the WASM binary calls console.log / print to stdout or stderr. */
  onPrint?: (data: string, kind: StdKind) => void
  /** Forwarded to JsiHost — optional transpile callback. */
  transpile?: (src: string, filename: string) => string
  /** Forwarded to JsiHost — optional evaluator (e.g. vm.runInContext for Node host). */
  evaluator?: (code: string, url: string) => unknown
  /** Forwarded to JsiHost — the object that becomes `globalThis` inside WASM (handle 4). */
  global?: object
  /**
   * T5.5.3: 预先分配的 SharedArrayBuffer-backed `WebAssembly.Memory`。
   *
   * threads wasm 使用 `import_memory = true`，必须由宿主传入共享 Memory；
   * 非线程 wasm 忽略此选项（wasm 自行定义 memory）。
   * 若省略，threadPool 注入也会跳过。
   */
  sharedMemory?: WebAssembly.Memory | undefined
  /**
   * T5.5.3: `jsi_thread_spawn` 的 pthread 孵化钩子。
   * 由 kernel-worker 在 threaded 模式下将 `ThreadPool.spawn.bind(pool)` 注入；
   * 单线程模式下留 undefined，`jsi_thread_spawn` 返回 0。
   */
  spawnThread?: ((arg: number) => number) | undefined
  /**
   * T5.5.3: 当前 Worker 的线程 id（主/单线程=0，子 Worker 由 ThreadPool 分配）。
   */
  threadId?: number | undefined
}

/** Opaque runtime handle returned by {@link createWasmRuntime}. */
export interface WasmRuntime {
  instance: WebAssembly.Instance
  host: JsiHost
  /** Write bytes into WASM linear memory and call fn(ptr, len); frees the buffer after. */
  withBytes(data: Uint8Array, fn: (ptr: number, len: number) => void): void
  /** Write a UTF-8 string into WASM and call fn(ptr, len); frees after. */
  withString(str: string, fn: (ptr: number, len: number) => void): void
  /**
   * Phase 1 T1.1：调用 WASM 导出的 `bun_lockfile_parse(text)` 并返回解析结果。
   *
   * 接受 bun.lock 文本内容，返回 `{ lockfileVersion, workspaceCount, packageCount, packages: [...] }`。
   * 若 bun-core.wasm 未导出此函数则抛错。
   */
  parseLockfile(text: string): LockfileSummary
  /**
   * Phase 1 T1.1：调用 `bun_resolve(specifier, from)`。
   *
   * 返回 `{ path, loader }`，遵循 Node/bun 风格的扩展名与 `index.*` 探测；
   * 若 specifier 为裸包，会在 from 的祖先目录中搜索 `node_modules/<spec>`。
   */
  resolve(specifier: string, from: string): ResolveResult
  /**
   * Phase 1 T1.1：调用 `bun_bundle(entry)`。
   *
   * 入口必须是 VFS 绝对路径。返回自包含的 IIFE JS 代码，安装 __modules__ 表
   * 并执行入口。扫描的依赖形式：`require("...")` / `import ... from "..."` /
   * `import("...")` / `export ... from "..."`（仅静态字符串 specifier）。
   */
  bundle(entry: string): string
  /**
   * Zig 复用步骤 2：调用 `bun_semver_select(versionsJson, range)`。
   *
   * `versionsJson` 是版本字符串 JSON 数组，如 `["1.0.0","2.0.0"]`。
   * `range` 是 semver 范围字符串，如 `"^1.0.0"`。
   * 返回最高匹配版本字符串，或在无匹配时返回 `null`。
   * 使用真实 Zig semver 解析器（src/semver/*）。
   */
  semverSelect(versionsJson: string, range: string): string | null
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
  integrityVerify(data: Uint8Array, integrity: string): 'ok' | 'fail' | 'bad'
  /**
   * Phase 5.1 T5.1.2：计算原始加密摘要。
   *
   * algo: 0=SHA-1(20B), 1=SHA-256(32B), 2=SHA-512(64B), 3=SHA-384(48B), 4=MD5(16B)
   *
   * 返回原始摘要字节（未做 hex/base64 编码）。
   * 若 WASM 不导出 bun_hash，返回 null。
   */
  hash(algo: 0 | 1 | 2 | 3 | 4, data: Uint8Array): Uint8Array | null
  /**
   * Phase 5.1 T5.1.2：Base64 编码（标准，带 `=` 填充）。
   *
   * 若 WASM 不导出 bun_base64_encode，返回 null。
   */
  base64Encode(data: Uint8Array): string | null
  /**
   * Phase 5.1 T5.1.2：Base64 解码（兼容带/不带 `=` 填充的输入）。
   *
   * 若 WASM 不导出 bun_base64_decode，返回 null。
   * 输入非法 base64 时抛 Error。
   */
  base64Decode(b64: string): Uint8Array | null
  /**
   * Phase 5.1 T5.1.3：解压数据。
   *
   * format: `"gzip"` (默认) | `"zlib"` | `"raw"`
   *
   * 若 WASM 不导出 bun_inflate，返回 null。
   * 解压失败时抛 Error。
   */
  inflate(data: Uint8Array, format?: 'gzip' | 'zlib' | 'raw'): Uint8Array | null
  /**
   * Phase 5.1 T5.1.3：压缩数据。
   *
   * format: `"gzip"` (默认) | `"zlib"` | `"raw"`
   *
   * 若 WASM 不导出 bun_deflate，返回 null。
   * 压缩失败时抛 Error。
   */
  deflate(data: Uint8Array, format?: 'gzip' | 'zlib' | 'raw'): Uint8Array | null
  /**
   * Phase 5.1 T5.1.1：使用 std.fs.path.resolvePosix 规范化 POSIX 路径。
   *
   * 解析 `.`/`..`，折叠重复 `/`，始终返回绝对路径（以 `/` 开头）。
   * 若 WASM 不导出 bun_path_normalize，返回 null。
   */
  pathNormalize(path: string): string | null
  /**
   * Phase 5.1 T5.1.1：返回路径的目录部分（最后一个 `/` 之前）。
   *
   * 根路径返回 `"/"`,  无 `/` 的路径返回 `"/"`.
   * 若 WASM 不导出 bun_path_dirname，返回 null。
   */
  pathDirname(path: string): string | null
  /**
   * Phase 5.1 T5.1.1：拼接两段 POSIX 路径后规范化。
   *
   * `rel` 以 `/` 开头时忽略 `base`，直接规范化 `rel`。
   * 若 WASM 不导出 bun_path_join，返回 null。
   */
  pathJoin(base: string, rel: string): string | null
  /**
   * Phase 5.1 T5.1.4：使用 std.Uri 解析 URL 字符串。
   *
   * 返回 URL 各组成部分。解析失败时返回 null。
   * 若 WASM 不导出 bun_url_parse，返回 null。
   */
  urlParse(url: string): UrlComponents | null
  /**
   * Phase 5.2：TS/JSX → JS 内置转译（`bun_transform`）。
   *
   * 输入：原始源码 + 文件名（用于推断 ts/tsx/jsx）+ 可选 JSX 模式。
   * 输出：`{ code, errors }`。`code` 为 null 时 `errors` 非空。
   * 若 WASM 不导出 `bun_transform`，返回 null。
   */
  transform(source: string, filename: string, opts?: TransformOptions): TransformResult | null
  /**
   * T5.3.3：调用 `bun_bundle2`，支持 externals 和 define 配置。
   *
   * - `external`：跳过这些包的递归打包，改用 `globalThis.require(spec)` 委托给宿主
   * - `define`：源码中的文本替换，如 `process.env.NODE_ENV` → `"production"`
   *
   * 返回与 `bundle()` 相同格式的 IIFE 代码。
   */
  bundle2(config: BundleConfig): string
  /**
   * Phase 5.4 T5.4.3：将 .tgz tarball 解压并直接写入 WASM VFS。
   *
   * - `prefix`：安装前缀，如 `"/node_modules/react"`
   * - `tgz`：原始 gzip 压缩的 tarball 字节
   *
   * Tarball 内的 `package/` 根目录会被自动剥离（npm 标准布局）。
   * 解压结果直接写入 WASM 内部 VFS，调用方无需额外调用 `bun_vfs_load_snapshot`。
   *
   * 返回解压的文件数量。若 WASM 不导出 `bun_tgz_extract`，返回 null（调用方应回退到 JS 实现）。
   * 解压失败时抛 Error。
   */
  extractTgz(prefix: string, tgz: Uint8Array): number | null
  /**
   * Phase 5.4 T5.4.1：解析 npm registry metadata JSON，选出最佳匹配版本。
   *
   * - `json`：npm GET `/<pkgname>` 原始响应 JSON 字符串
   * - `range`：semver range 或 dist-tag（如 `"^1.0.0"`、`"latest"`、`"1.2.3"`）
   *
   * 内部使用 Zig 真实 semver + dist-tags 解析，无需 TS 侧逻辑。
   * 返回已解析的版本信息；无匹配版本时返回 `null`。
   * 若 WASM 不导出 `bun_npm_parse_metadata`，返回 `null`（调用方回退到 TS 实现）。
   */
  parseNpmMetadata(json: string, range: string): NpmResolvedVersion | null
  /**
   * Phase 5.4 T5.4.5：将已解析的包列表序列化为 bun.lock 文本（JSON 格式）。
   *
   * - `packages`：已解析的包信息列表
   * - `workspaceCount`：workspace 数量（默认为 1）
   *
   * 返回 bun.lock 文本，若 WASM 不导出则返回 null。
   */
  writeLockfile(data: {
    packages: Array<{ key: string; name: string; version: string }>
    workspaceCount?: number
  }): string | null
  /**
   * Phase 5.4 T5.4.2：WASM 内部 BFS，从 npm registry metadata 解析完整依赖图。
   *
   * - `deps`：顶层依赖 `{name: range}`
   * - `metadata`：每个包的 npm registry 响应 JSON 字符串（用于 BFS 展开）
   *
   * 返回 `{ resolved, missing }`；若 WASM 不导出则返回 null。
   */
  resolveGraph(deps: Record<string, string>, metadata: Record<string, string>): ResolveGraphResult | null
  /**
   * Phase 5.4 T5.4.4（异步 fetch 协议）步骤1：开始安装，返回第一个 fetch 请求。
   *
   * 若无需 fetch（无顶层依赖），返回 null。
   */
  npmInstallBegin(deps: Record<string, string>, registry?: string): NpmFetchRequest | null
  /** 步骤2：轮询下一个待 fetch 的请求（peek，不弹出）。 */
  npmNeedFetch(): NpmFetchRequest | null
  /** 步骤3：喂入 fetch 响应。调用后内部会处理响应并可能入队新请求。 */
  npmFeedResponse(reqId: number, data: Uint8Array): void
  /** 将包名标记为已见（跳过重复下载）。 */
  npmInstallMarkSeen(name: string): void
  /** 步骤4：获取最终安装结果（resolved + missing）。 */
  npmInstallResult(): ResolveGraphResult | null
  /** 步骤5：清理安装状态。 */
  npmInstallEnd(): void
  /**
   * Phase 5.7 T5.7.2：Source map 位置查找（`bun_sourcemap_lookup`）。
   *
   * - `map`：sourcemap JSON 字符串（v3 格式）
   * - `line`：生成代码中的 0-based 行号
   * - `col`：生成代码中的 0-based 列号
   *
   * 返回原始位置；若 WASM 不导出则返回 null。
   */
  sourcemapLookup(map: string, line: number, col: number): SourcemapPosition | null
  /**
   * Phase 5.7 T5.7.3：HTML 重写（`bun_html_rewrite`）。
   *
   * - `html`：输入 HTML 字符串
   * - `rules`：重写规则列表
   *
   * 返回重写后的 HTML；若 WASM 不导出则返回 null。
   */
  htmlRewrite(html: string, rules: HtmlRewriteRule[]): string | null
  /**
   * T5.10.3：Brace 展开（`bun_brace_expand`）。
   *
   * 将 ASCII brace 表达式展开为字符串数组。
   * - `"{a,b,c}"` → `["a","b","c"]`
   * - `"foo{a,b}bar"` → `["fooabar","foobbar"]`
   * - 支持嵌套 brace group
   *
   * 若 WASM 不导出 `bun_brace_expand` 则返回 null。
   */
  braceExpand(pattern: string): string[] | null
  /**
   * T5.13.1：解析 POSIX-like shell 命令为 JSON AST（`bun_shell_parse`）。
   *
   * 返回 ShellAST 对象；若 WASM 不导出 `bun_shell_parse` 则返回 null。
   *
   * AST 结构：
   * - `{ t: "seq", stmts: ShellAST[] }` — 顶层序列（always）
   * - `{ t: "pipe", cmds: ShellCmd[] }` — 管道（两条及以上命令）
   * - `{ t: "cmd", argv: string[], redirs: ShellRedir[], bg?: true }` — 单条命令
   */
  shellParse(src: string): ShellAST | null
  /**
   * T5.6.1：将当前 VFS 状态序列化为二进制 snapshot（与 bun_vfs_load_snapshot 使用相同格式）。
   *
   * 返回包含全部 VFS 文件的字节数组；VFS 为空或 WASM 不导出时返回 null。
   * 返回值可直接传入子进程的 SpawnInitMessage.vfsSnapshots。
   */
  dumpVfsSnapshot(): Uint8Array | null
}

// ── T5.13.1 Shell AST types ──────────────────────────────────────────────────

export interface ShellRedir {
  /** Redirect operator: `">"`, `">>"`, or `"<"`. */
  t: '>' | '>>' | '<'
  fd: number
  target: string
}

export interface ShellCmd {
  t: 'cmd'
  argv: string[]
  redirs: ShellRedir[]
  bg?: true
}

export interface ShellPipe {
  t: 'pipe'
  cmds: ShellCmd[]
}

export interface ShellSeq {
  t: 'seq'
  stmts: Array<ShellCmd | ShellPipe>
}

export type ShellAST = ShellSeq

/** Phase 5.4 T5.4.2 / T5.4.4 返回结构。 */
export interface ResolveGraphResult {
  resolved: Array<{
    name: string
    version: string
    tarball: string
    integrity?: string
    shasum?: string
    dependencies: Record<string, string>
  }>
  missing: string[]
}

/** Phase 5.4 T5.4.4 异步 fetch 协议请求结构。 */
export interface NpmFetchRequest {
  id: number
  url: string
  type: 'metadata' | 'tarball'
  name: string
  range: string
}

/** Phase 5.7 T5.7.2 Source map 位置。 */
export interface SourcemapPosition {
  source: string | null
  line?: number
  col?: number
  name?: string
}

/** Phase 5.7 T5.7.3 HTML 重写规则。 */
export interface HtmlRewriteRule {
  selector: string
  /** set_attr 操作：目标属性名 */
  attr?: string
  /** set_attr 操作：替换值 */
  replace?: string
  /** set_text 操作：新文本内容 */
  text?: string
  /** remove 操作：为 true 时移除匹配的标签 */
  remove?: boolean
}

/** Phase 5.4 T5.4.1：`parseNpmMetadata` 返回结构。 */
export interface NpmResolvedVersion {
  version: string
  tarball: string
  integrity?: string
  shasum?: string
  dependencies: Record<string, string>
}

/** Phase 1 T1.1：bun_resolve 返回结构。 */
export interface ResolveResult {
  path: string
  loader: 'ts' | 'tsx' | 'js' | 'jsx' | 'mjs' | 'cjs' | 'json'
}

/**
 * Phase 5.2：`transform` 的可选参数。
 *
 * `jsx`:
 *   - `"react"` (默认)：`<div/>` → `React.createElement('div')`
 *   - `"react-jsx"`：React 17+ automatic runtime，顶部自动 `import { jsx, jsxs, Fragment } from 'react/jsx-runtime'`
 *   - `"preserve"`：保留 JSX 原样
 *   - `"none"`：.ts 文件禁用 JSX 处理
 *
 * `esmToCjs` (T5.2.6)：将 ESM import/export 转换为 CommonJS require/module.exports。
 * `sourceMap` (T5.2.7)：生成 sourcemap v3 JSON，结果存入 `TransformResult.map`。
 */
export interface TransformOptions {
  jsx?: 'react' | 'react-jsx' | 'preserve' | 'none'
  /** T5.2.6: 将 ESM import/export 转换为 CommonJS require/module.exports */
  esmToCjs?: boolean
  /** T5.2.7: 生成 sourcemap v3 JSON */
  sourceMap?: boolean
}

/** Phase 5.2：`transform` 返回结构。 */
export interface TransformResult {
  code: string | null
  errors: string[]
  /** T5.2.7: sourcemap v3 JSON 字符串（仅在 opts.sourceMap=true 时非 null） */
  map?: string | null
}

/**
 * T5.3.3：`bundle2` 配置对象。
 *
 * `entrypoint`：VFS 绝对路径，作为打包入口（必填）。
 * `external`：不打包进 bundle 的包名列表，运行时委托给 `globalThis.require`。
 * `define`：源码文本替换表，键为被替换的 JS 表达式，值为替换后的 JS 表达式字符串。
 */
export interface BundleConfig {
  entrypoint: string
  external?: string[]
  define?: Record<string, string>
}

/** Phase 5.1 T5.1.4：bun_url_parse 返回结构（与 node:url.parse 对齐）。 */
export interface UrlComponents {
  href: string
  scheme: string
  protocol: string
  host: string
  hostname: string
  port: string
  pathname: string
  search: string
  hash: string
  auth: null
}

/** Phase 1 T1.1 返回结构。 */
export interface LockfileSummary {
  lockfileVersion: number
  workspaceCount: number
  packageCount: number
  packages: Array<{ key: string; name: string; version: string }>
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
  const { onPrint, transpile, evaluator, global, sharedMemory, spawnThread, threadId } = opts
  let _instance: WebAssembly.Instance | undefined
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  const host = new JsiHost({
    ...(onPrint
      ? {
          onPrint: (data: string, level: PrintLevel) =>
            onPrint(data, level === PrintLevel.Stderr ? 'stderr' : 'stdout'),
        }
      : {}),
    ...(transpile !== undefined ? { transpile } : {}),
    ...(evaluator !== undefined ? { evaluator } : {}),
    ...(global !== undefined ? { global } : {}),
    ...(spawnThread !== undefined ? { spawnThread } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
  })

  /** Build the minimal WASI shim that routes fd_write to onPrint. */
  function makeWasiShim() {
    const getMem = () => {
      const m = _instance?.exports.memory as WebAssembly.Memory | undefined
      if (!m) throw new Error('wasm memory unavailable')
      return m
    }
    return {
      fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number): number => {
        const mem = getMem()
        const view = new DataView(mem.buffer)
        const bytes = new Uint8Array(mem.buffer)
        let total = 0
        const parts: string[] = []
        for (let i = 0; i < iovsLen; i++) {
          const p = iovs + i * 8
          const ptr = view.getUint32(p, true)
          const len = view.getUint32(p + 4, true)
          parts.push(dec.decode(bytes.subarray(ptr, ptr + len)))
          total += len
        }
        view.setUint32(nwritten, total, true)
        const kind = fd === 2 ? 'stderr' : 'stdout'
        onPrint?.(parts.join(''), kind)
        return 0
      },
      proc_exit: (code: number): never => {
        throw Object.assign(new Error(`proc_exit(${code})`), { wasmExitCode: code })
      },
    }
  }

  const wasmImports: WebAssembly.Imports = {
    jsi: host.imports(),
    wasi_snapshot_preview1: makeWasiShim(),
    env: {
      jsi_now_ms: (): bigint => BigInt(Date.now()),
      // T5.5.3: threads wasm 使用 import_memory=true；若宿主传入 SharedArrayBuffer-backed
      // Memory，将其注入到 env.memory，供 wasm 线程共享。非线程 wasm 不访问此字段。
      ...(sharedMemory !== undefined ? { memory: sharedMemory } : {}),
    },
  }

  _instance = (await WebAssembly.instantiate(module, wasmImports)) as unknown as WebAssembly.Instance

  host.bind(_instance)

  // Call bun_browser_init (preferred) or _start if present.
  const initFn = _instance.exports.bun_browser_init as (() => void) | undefined
  const startFn = _instance.exports._start as (() => void) | undefined
  if (initFn) initFn()
  else if (startFn) startFn()

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
    const exports_ = _instance!.exports as Record<string, unknown>
    const fn_ =
      extra === undefined
        ? (exports_[fnName] as ((p: number, l: number) => bigint) | undefined)
        : (exports_[fnName] as ((p: number, l: number, x: number) => bigint) | undefined)
    if (!fn_) return null // export not present — caller falls back gracefully
    const alloc = exports_.bun_malloc as (n: number) => number
    const free_ = exports_.bun_free as (ptr: number) => void
    const iPtr = alloc(Math.max(1, data.byteLength))
    if (iPtr === 0) throw new Error(`bun_malloc returned 0 calling ${fnName}`)
    const mem = () => (_instance!.exports.memory as WebAssembly.Memory).buffer
    if (data.byteLength > 0) new Uint8Array(mem(), iPtr, data.byteLength).set(data)
    let packed: bigint
    try {
      packed =
        extra === undefined
          ? (fn_ as (p: number, l: number) => bigint)(iPtr, data.byteLength)
          : (fn_ as (p: number, l: number, x: number) => bigint)(iPtr, data.byteLength, extra)
    } finally {
      free_(iPtr)
    }
    const outPtr = Number(packed >> 32n) >>> 0
    const outLen = Number(packed & 0xffffffffn) >>> 0
    if (outPtr === 0) {
      if (throwOnError) throw new Error(`${fnName} failed (error code ${outLen})`)
      return null
    }
    return { ptr: outPtr, len: outLen, free_ }
  }

  /** Convenience wrapper: returns a Uint8Array copy, or null if not available. */
  function callPacked1x(
    fnName: string,
    data: Uint8Array,
    extra: number | undefined,
    throwOnError: boolean,
  ): Uint8Array | null {
    const r = callPackedRaw(fnName, data, extra, throwOnError)
    if (!r) return null
    const mem = (_instance!.exports.memory as WebAssembly.Memory).buffer
    try {
      return new Uint8Array(mem, r.ptr, r.len).slice()
    } finally {
      r.free_(r.ptr)
    }
  }

  const rt: WasmRuntime = {
    instance: _instance,
    host,

    withBytes(data: Uint8Array, fn: (ptr: number, len: number) => void): void {
      const alloc = _instance!.exports.bun_malloc as (n: number) => number
      const free_ = _instance!.exports.bun_free as (ptr: number) => void
      const ptr = alloc(data.byteLength)
      if (ptr === 0) throw new Error('bun_malloc returned null')
      new Uint8Array((_instance!.exports.memory as WebAssembly.Memory).buffer, ptr, data.byteLength).set(data)
      try {
        fn(ptr, data.byteLength)
      } finally {
        free_(ptr)
      }
    },

    withString(str: string, fn: (ptr: number, len: number) => void): void {
      this.withBytes(enc.encode(str), fn)
    },

    parseLockfile(text: string): LockfileSummary {
      const exports_ = _instance!.exports as Record<string, unknown>
      const parseFn = exports_.bun_lockfile_parse as ((ptr: number, len: number) => bigint) | undefined
      const free_ = exports_.bun_free as (ptr: number) => void
      if (!parseFn) throw new Error('bun-core.wasm does not export bun_lockfile_parse')
      const mem = () => (_instance!.exports.memory as WebAssembly.Memory).buffer
      const bytes = enc.encode(text)
      const alloc = _instance!.exports.bun_malloc as (n: number) => number
      const inputPtr = alloc(bytes.byteLength)
      if (inputPtr === 0) throw new Error('bun_malloc returned null')
      new Uint8Array(mem(), inputPtr, bytes.byteLength).set(bytes)
      let packed: bigint
      try {
        packed = parseFn(inputPtr, bytes.byteLength)
      } finally {
        free_(inputPtr)
      }
      const outPtr = Number(packed >> 32n) >>> 0
      const outLen = Number(packed & 0xffffffffn) >>> 0
      if (outPtr === 0) {
        const codes: Record<number, string> = { 1: 'OOM', 2: 'invalid JSON', 3: 'missing lockfileVersion' }
        throw new Error(`bun_lockfile_parse failed: ${codes[outLen] ?? `code=${outLen}`}`)
      }
      try {
        const view = new Uint8Array(mem(), outPtr, outLen)
        const json = dec.decode(view)
        return JSON.parse(json) as LockfileSummary
      } finally {
        free_(outPtr)
      }
    },

    resolve(specifier: string, from: string): ResolveResult {
      const exports_ = _instance!.exports as Record<string, unknown>
      const resolveFn = exports_.bun_resolve as ((sp: number, sl: number, fp: number, fl: number) => bigint) | undefined
      const alloc = exports_.bun_malloc as (n: number) => number
      const free_ = exports_.bun_free as (ptr: number) => void
      if (!resolveFn) throw new Error('bun-core.wasm does not export bun_resolve')
      const mem = () => (_instance!.exports.memory as WebAssembly.Memory).buffer
      const sbytes = enc.encode(specifier)
      const fbytes = enc.encode(from)
      const sPtr = alloc(Math.max(1, sbytes.byteLength))
      const fPtr = alloc(Math.max(1, fbytes.byteLength))
      if (sPtr === 0 || fPtr === 0) throw new Error('bun_malloc returned null')
      if (sbytes.byteLength > 0) new Uint8Array(mem(), sPtr, sbytes.byteLength).set(sbytes)
      if (fbytes.byteLength > 0) new Uint8Array(mem(), fPtr, fbytes.byteLength).set(fbytes)
      let packed: bigint
      try {
        packed = resolveFn(sPtr, sbytes.byteLength, fPtr, fbytes.byteLength)
      } finally {
        free_(sPtr)
        free_(fPtr)
      }
      const outPtr = Number(packed >> 32n) >>> 0
      const outLen = Number(packed & 0xffffffffn) >>> 0
      if (outPtr === 0) {
        const codes: Record<number, string> = {
          1: 'OOM',
          2: 'module not found',
          3: 'empty specifier',
          4: 'bare package not resolvable',
        }
        throw new Error(`bun_resolve(${specifier}) failed: ${codes[outLen] ?? `code=${outLen}`}`)
      }
      try {
        const json = dec.decode(new Uint8Array(mem(), outPtr, outLen))
        return JSON.parse(json) as ResolveResult
      } finally {
        free_(outPtr)
      }
    },

    bundle(entry: string): string {
      const exports_ = _instance!.exports as Record<string, unknown>
      const bundleFn = exports_.bun_bundle as ((p: number, l: number) => bigint) | undefined
      const alloc = exports_.bun_malloc as (n: number) => number
      const free_ = exports_.bun_free as (ptr: number) => void
      if (!bundleFn) throw new Error('bun-core.wasm does not export bun_bundle')
      const mem = () => (_instance!.exports.memory as WebAssembly.Memory).buffer
      const bytes = enc.encode(entry)
      const ptr = alloc(Math.max(1, bytes.byteLength))
      if (ptr === 0) throw new Error('bun_malloc returned null')
      if (bytes.byteLength > 0) new Uint8Array(mem(), ptr, bytes.byteLength).set(bytes)
      let packed: bigint
      try {
        packed = bundleFn(ptr, bytes.byteLength)
      } finally {
        free_(ptr)
      }
      const outPtr = Number(packed >> 32n) >>> 0
      const outLen = Number(packed & 0xffffffffn) >>> 0
      if (outPtr === 0) {
        const codes: Record<number, string> = {
          1: 'OOM',
          2: 'entry not found',
          3: 'module graph too deep',
          4: 'transpile failed',
        }
        throw new Error(`bun_bundle(${entry}) failed: ${codes[outLen] ?? `code=${outLen}`}`)
      }
      try {
        return dec.decode(new Uint8Array(mem(), outPtr, outLen))
      } finally {
        free_(outPtr)
      }
    },

    integrityVerify(data: Uint8Array, integrity: string): 'ok' | 'fail' | 'bad' {
      const exports_ = _instance!.exports as Record<string, unknown>
      const verifyFn = exports_.bun_integrity_verify as
        | ((dp: number, dl: number, ip: number, il: number) => number)
        | undefined
      if (!verifyFn) return 'ok' // forward-compatible: treat missing as pass
      const alloc = exports_.bun_malloc as (n: number) => number
      const free_ = exports_.bun_free as (ptr: number) => void
      const mem = () => (_instance!.exports.memory as WebAssembly.Memory).buffer
      const ibytes = enc.encode(integrity)
      const dPtr = alloc(Math.max(1, data.byteLength))
      const iPtr = alloc(Math.max(1, ibytes.byteLength))
      if (dPtr === 0 || iPtr === 0) return 'ok'
      if (data.byteLength > 0) new Uint8Array(mem(), dPtr, data.byteLength).set(data)
      if (ibytes.byteLength > 0) new Uint8Array(mem(), iPtr, ibytes.byteLength).set(ibytes)
      let code: number
      try {
        code = verifyFn(dPtr, data.byteLength, iPtr, ibytes.byteLength)
      } finally {
        free_(dPtr)
        free_(iPtr)
      }
      if (code === 0) return 'ok'
      if (code === 1) return 'fail'
      return 'bad'
    },

    semverSelect(versionsJson: string, range: string): string | null {
      const exports_ = _instance!.exports as Record<string, unknown>
      const selectFn = exports_.bun_semver_select as
        | ((vp: number, vl: number, rp: number, rl: number) => bigint)
        | undefined
      const alloc = exports_.bun_malloc as (n: number) => number
      const free_ = exports_.bun_free as (ptr: number) => void
      if (!selectFn) return null // WASM not built with semver support
      const mem = () => (_instance!.exports.memory as WebAssembly.Memory).buffer
      const vbytes = enc.encode(versionsJson)
      const rbytes = enc.encode(range)
      const vPtr = alloc(Math.max(1, vbytes.byteLength))
      const rPtr = alloc(Math.max(1, rbytes.byteLength))
      if (vPtr === 0 || rPtr === 0) return null
      if (vbytes.byteLength > 0) new Uint8Array(mem(), vPtr, vbytes.byteLength).set(vbytes)
      if (rbytes.byteLength > 0) new Uint8Array(mem(), rPtr, rbytes.byteLength).set(rbytes)
      let packed: bigint
      try {
        packed = selectFn(vPtr, vbytes.byteLength, rPtr, rbytes.byteLength)
      } finally {
        free_(vPtr)
        free_(rPtr)
      }
      const outPtr = Number(packed >> 32n) >>> 0
      const outLen = Number(packed & 0xffffffffn) >>> 0
      if (outPtr === 0) return null
      try {
        return dec.decode(new Uint8Array(mem(), outPtr, outLen))
      } finally {
        free_(outPtr)
      }
    },

    hash(algo: 0 | 1 | 2 | 3 | 4, data: Uint8Array): Uint8Array | null {
      return callPacked1x('bun_hash', data, algo, /* throwOnError */ false) as Uint8Array | null
    },

    base64Encode(data: Uint8Array): string | null {
      if (data.byteLength === 0) return ''
      const r = callPackedRaw('bun_base64_encode', data, undefined, false)
      if (!r) return null
      if (r.len === 0) {
        r.free_(r.ptr)
        return ''
      }
      const mem = (_instance!.exports.memory as WebAssembly.Memory).buffer
      try {
        return dec.decode(new Uint8Array(mem, r.ptr, r.len))
      } finally {
        r.free_(r.ptr)
      }
    },

    base64Decode(b64: string): Uint8Array | null {
      return callPacked1x('bun_base64_decode', enc.encode(b64), undefined, /* throwOnError */ true) as Uint8Array | null
    },

    inflate(data: Uint8Array, format: 'gzip' | 'zlib' | 'raw' = 'gzip'): Uint8Array | null {
      const fmtCode = { gzip: 0, zlib: 1, raw: 2 }[format] ?? 0
      return callPacked1x('bun_inflate', data, fmtCode, /* throwOnError */ true) as Uint8Array | null
    },

    deflate(data: Uint8Array, format: 'gzip' | 'zlib' | 'raw' = 'gzip'): Uint8Array | null {
      const fmtCode = { gzip: 0, zlib: 1, raw: 2 }[format] ?? 0
      return callPacked1x('bun_deflate', data, fmtCode, /* throwOnError */ true) as Uint8Array | null
    },

    // ── Phase 5.1 T5.1.1 — path ABIs ───────────────────────────────────────

    pathNormalize(path: string): string | null {
      const r = callPackedRaw('bun_path_normalize', enc.encode(path), undefined, false)
      if (!r) return null
      const mem = (_instance!.exports.memory as WebAssembly.Memory).buffer
      try {
        return dec.decode(new Uint8Array(mem, r.ptr, r.len))
      } finally {
        r.free_(r.ptr)
      }
    },

    pathDirname(path: string): string | null {
      const r = callPackedRaw('bun_path_dirname', enc.encode(path), undefined, false)
      if (!r) return null
      const mem = (_instance!.exports.memory as WebAssembly.Memory).buffer
      try {
        return dec.decode(new Uint8Array(mem, r.ptr, r.len))
      } finally {
        r.free_(r.ptr)
      }
    },

    pathJoin(base: string, rel: string): string | null {
      // Pack: [base_len: u32 LE][base bytes][rel bytes]
      const baseBytes = enc.encode(base)
      const relBytes = enc.encode(rel)
      const buf = new Uint8Array(4 + baseBytes.byteLength + relBytes.byteLength)
      new DataView(buf.buffer).setUint32(0, baseBytes.byteLength, /* littleEndian */ true)
      buf.set(baseBytes, 4)
      buf.set(relBytes, 4 + baseBytes.byteLength)
      const r = callPackedRaw('bun_path_join', buf, undefined, false)
      if (!r) return null
      const mem = (_instance!.exports.memory as WebAssembly.Memory).buffer
      try {
        return dec.decode(new Uint8Array(mem, r.ptr, r.len))
      } finally {
        r.free_(r.ptr)
      }
    },

    // ── Phase 5.1 T5.1.4 — URL parsing via WASM export ─────────────────────

    urlParse(url: string): import('./wasm').UrlComponents | null {
      const r = callPackedRaw('bun_url_parse', enc.encode(url), undefined, false)
      if (!r) return null
      const mem = (_instance!.exports.memory as WebAssembly.Memory).buffer
      try {
        const json = dec.decode(new Uint8Array(mem, r.ptr, r.len))
        return JSON.parse(json) as import('./wasm').UrlComponents
      } finally {
        r.free_(r.ptr)
      }
    },

    // ── Phase 5.2 — TS/JSX transform via WASM export ───────────────────────

    transform(source: string, filename: string, opts?: TransformOptions): TransformResult | null {
      const exports_ = _instance!.exports as Record<string, unknown>
      if (!exports_.bun_transform) return null
      const payload = enc.encode(
        JSON.stringify({
          code: source,
          filename,
          jsx: opts?.jsx ?? 'react',
          // T5.2.6: ESM→CJS conversion (opt-in)
          ...(opts?.esmToCjs ? { esm_to_cjs: true } : {}),
          // T5.2.7: sourcemap generation (opt-in)
          ...(opts?.sourceMap ? { source_map: true } : {}),
        }),
      )
      const r = callPackedRaw('bun_transform', payload, undefined, false)
      if (!r) return { code: null, errors: ['bun_transform returned error'] }
      const mem = (_instance!.exports.memory as WebAssembly.Memory).buffer
      try {
        const json = dec.decode(new Uint8Array(mem, r.ptr, r.len))
        const parsed = JSON.parse(json) as TransformResult
        return parsed
      } finally {
        r.free_(r.ptr)
      }
    },

    // ── T5.3.3 — bundle2: externals + define ───────────────────────────────

    bundle2(config: BundleConfig): string {
      const exports_ = _instance!.exports as Record<string, unknown>
      const bundle2Fn = exports_.bun_bundle2 as ((p: number, l: number) => bigint) | undefined
      const alloc = exports_.bun_malloc as (n: number) => number
      const free_ = exports_.bun_free as (ptr: number) => void
      if (!bundle2Fn) throw new Error('bun-core.wasm does not export bun_bundle2')
      const mem = () => (_instance!.exports.memory as WebAssembly.Memory).buffer
      const payload = enc.encode(JSON.stringify(config))
      const ptr = alloc(Math.max(1, payload.byteLength))
      if (ptr === 0) throw new Error('bun_malloc returned null')
      if (payload.byteLength > 0) new Uint8Array(mem(), ptr, payload.byteLength).set(payload)
      let packed: bigint
      try {
        packed = bundle2Fn(ptr, payload.byteLength)
      } finally {
        free_(ptr)
      }
      const outPtr = Number(packed >> 32n) >>> 0
      const outLen = Number(packed & 0xffffffffn) >>> 0
      if (outPtr === 0) {
        const codes: Record<number, string> = {
          1: 'OOM or parse error',
          2: 'entry not found',
          3: 'module graph too deep',
          4: 'transpile failed',
          5: 'missing entrypoint in config',
        }
        throw new Error(`bun_bundle2 failed: ${codes[outLen] ?? `code=${outLen}`}`)
      }
      try {
        return dec.decode(new Uint8Array(mem(), outPtr, outLen))
      } finally {
        free_(outPtr)
      }
    },

    extractTgz(prefix: string, tgz: Uint8Array): number | null {
      const exports_ = _instance!.exports as Record<string, unknown>
      const extractFn = exports_.bun_tgz_extract as ((p: number, l: number) => bigint) | undefined
      if (!extractFn) return null // export not present — caller falls back to JS

      const alloc = exports_.bun_malloc as (n: number) => number
      const free_ = exports_.bun_free as (ptr: number) => void
      const mem = () => (_instance!.exports.memory as WebAssembly.Memory).buffer

      // Packed input: [prefix_len: u32 LE][prefix bytes][tgz bytes]
      const prefixBytes = enc.encode(prefix)
      const totalLen = 4 + prefixBytes.byteLength + tgz.byteLength
      const inputPtr = alloc(Math.max(1, totalLen))
      if (inputPtr === 0) throw new Error('bun_malloc returned null')

      try {
        const view = new DataView(mem(), inputPtr, totalLen)
        const bytes = new Uint8Array(mem(), inputPtr, totalLen)
        view.setUint32(0, prefixBytes.byteLength, true)
        bytes.set(prefixBytes, 4)
        bytes.set(tgz, 4 + prefixBytes.byteLength)
      } catch {
        free_(inputPtr)
        throw new Error('extractTgz: failed to write input into WASM memory')
      }

      let packed: bigint
      try {
        packed = extractFn(inputPtr, totalLen)
      } finally {
        free_(inputPtr)
      }

      const outPtr = Number(packed >> 32n) >>> 0
      const outLen = Number(packed & 0xffffffffn) >>> 0
      if (outPtr === 0) {
        const codes: Record<number, string> = { 1: 'OOM', 2: 'decompress failed', 3: 'bad input' }
        throw new Error(`bun_tgz_extract failed: ${codes[outLen] ?? `code=${outLen}`}`)
      }
      try {
        const json = dec.decode(new Uint8Array(mem(), outPtr, outLen))
        const result = JSON.parse(json) as { extracted: number }
        return result.extracted
      } finally {
        free_(outPtr)
      }
    },

    parseNpmMetadata(json: string, range: string): NpmResolvedVersion | null {
      const exports_ = _instance!.exports as Record<string, unknown>
      const parseFn = exports_.bun_npm_parse_metadata as
        | ((jp: number, jl: number, rp: number, rl: number) => bigint)
        | undefined
      if (!parseFn) return null // export not present — caller falls back to TS

      const alloc = exports_.bun_malloc as (n: number) => number
      const free_ = exports_.bun_free as (ptr: number) => void
      const mem = () => (_instance!.exports.memory as WebAssembly.Memory).buffer

      const jsonBytes = enc.encode(json)
      const rangeBytes = enc.encode(range)

      const jPtr = alloc(Math.max(1, jsonBytes.byteLength))
      if (jPtr === 0) throw new Error('bun_malloc returned null')
      const rPtr = alloc(Math.max(1, rangeBytes.byteLength))
      if (rPtr === 0) {
        free_(jPtr)
        throw new Error('bun_malloc returned null')
      }

      try {
        new Uint8Array(mem(), jPtr, jsonBytes.byteLength).set(jsonBytes)
        new Uint8Array(mem(), rPtr, rangeBytes.byteLength).set(rangeBytes)
      } catch {
        free_(jPtr)
        free_(rPtr)
        throw new Error('parseNpmMetadata: failed to write into WASM memory')
      }

      let packed: bigint
      try {
        packed = parseFn(jPtr, jsonBytes.byteLength, rPtr, rangeBytes.byteLength)
      } finally {
        free_(jPtr)
        free_(rPtr)
      }

      const outPtr = Number(packed >> 32n) >>> 0
      const outLen = Number(packed & 0xffffffffn) >>> 0
      if (outPtr === 0) {
        if (outLen === 3) return null // no matching version — not an error
        const codes: Record<number, string> = { 1: 'OOM', 2: 'invalid JSON' }
        throw new Error(`bun_npm_parse_metadata failed: ${codes[outLen] ?? `code=${outLen}`}`)
      }
      try {
        const resultJson = dec.decode(new Uint8Array(mem(), outPtr, outLen))
        return JSON.parse(resultJson) as NpmResolvedVersion
      } finally {
        free_(outPtr)
      }
    },

    // ── Phase 5.4 T5.4.5 — bun_lockfile_write ──────────────────────────────

    writeLockfile(data): string | null {
      const r = callPackedRaw('bun_lockfile_write', enc.encode(JSON.stringify(data)), undefined, false)
      if (!r) return null
      const mem2 = (_instance!.exports.memory as WebAssembly.Memory).buffer
      try {
        return dec.decode(new Uint8Array(mem2, r.ptr, r.len))
      } finally {
        r.free_(r.ptr)
      }
    },

    // ── Phase 5.4 T5.4.2 — bun_npm_resolve_graph ───────────────────────────

    resolveGraph(deps, metadata): ResolveGraphResult | null {
      const payload = enc.encode(JSON.stringify({ deps, metadata }))
      const r = callPackedRaw('bun_npm_resolve_graph', payload, undefined, false)
      if (!r) return null
      const mem2 = (_instance!.exports.memory as WebAssembly.Memory).buffer
      try {
        return JSON.parse(dec.decode(new Uint8Array(mem2, r.ptr, r.len))) as ResolveGraphResult
      } finally {
        r.free_(r.ptr)
      }
    },

    // ── Phase 5.4 T5.4.4 — async fetch protocol ────────────────────────────

    npmInstallBegin(deps, registry): NpmFetchRequest | null {
      const payload = enc.encode(JSON.stringify({ deps, registry: registry ?? 'https://registry.npmjs.org' }))
      const r = callPackedRaw('bun_npm_install_begin', payload, undefined, false)
      if (!r) return null
      const mem2 = (_instance!.exports.memory as WebAssembly.Memory).buffer
      try {
        return JSON.parse(dec.decode(new Uint8Array(mem2, r.ptr, r.len))) as NpmFetchRequest
      } finally {
        r.free_(r.ptr)
      }
    },

    npmNeedFetch(): NpmFetchRequest | null {
      const exports_ = _instance!.exports as Record<string, unknown>
      const fn_ = exports_.bun_npm_need_fetch as (() => bigint) | undefined
      if (!fn_) return null
      const packed = fn_()
      const outPtr = Number(packed >> 32n) >>> 0
      const outLen = Number(packed & 0xffffffffn) >>> 0
      if (outPtr === 0) return null
      const free_ = exports_.bun_free as (ptr: number) => void
      const mem2 = (_instance!.exports.memory as WebAssembly.Memory).buffer
      try {
        return JSON.parse(dec.decode(new Uint8Array(mem2, outPtr, outLen))) as NpmFetchRequest
      } finally {
        free_(outPtr)
      }
    },

    npmFeedResponse(reqId, data): void {
      const exports_ = _instance!.exports as Record<string, unknown>
      const fn_ = exports_.bun_npm_feed_response as ((id: number, p: number, l: number) => bigint) | undefined
      if (!fn_) return
      const alloc = exports_.bun_malloc as (n: number) => number
      const free_ = exports_.bun_free as (ptr: number) => void
      const ptr = alloc(Math.max(1, data.byteLength))
      if (ptr === 0) return
      const mem2 = (_instance!.exports.memory as WebAssembly.Memory).buffer
      if (data.byteLength > 0) new Uint8Array(mem2, ptr, data.byteLength).set(data)
      try {
        fn_(reqId, ptr, data.byteLength)
      } finally {
        free_(ptr)
      }
    },

    npmInstallMarkSeen(name): void {
      const exports_ = _instance!.exports as Record<string, unknown>
      const fn_ = exports_.bun_npm_install_mark_seen as ((p: number, l: number) => void) | undefined
      if (!fn_) return
      const alloc = exports_.bun_malloc as (n: number) => number
      const free_ = exports_.bun_free as (ptr: number) => void
      const bytes = enc.encode(name)
      const ptr = alloc(Math.max(1, bytes.byteLength))
      if (ptr === 0) return
      const mem2 = (_instance!.exports.memory as WebAssembly.Memory).buffer
      new Uint8Array(mem2, ptr, bytes.byteLength).set(bytes)
      try {
        fn_(ptr, bytes.byteLength)
      } finally {
        free_(ptr)
      }
    },

    npmInstallResult(): ResolveGraphResult | null {
      const exports_ = _instance!.exports as Record<string, unknown>
      const fn_ = exports_.bun_npm_install_result as (() => bigint) | undefined
      if (!fn_) return null
      const packed = fn_()
      const outPtr = Number(packed >> 32n) >>> 0
      const outLen = Number(packed & 0xffffffffn) >>> 0
      if (outPtr === 0) return null
      const free_ = exports_.bun_free as (ptr: number) => void
      const mem2 = (_instance!.exports.memory as WebAssembly.Memory).buffer
      try {
        return JSON.parse(dec.decode(new Uint8Array(mem2, outPtr, outLen))) as ResolveGraphResult
      } finally {
        free_(outPtr)
      }
    },

    npmInstallEnd(): void {
      const exports_ = _instance!.exports as Record<string, unknown>
      const fn_ = exports_.bun_npm_install_end as (() => void) | undefined
      fn_?.()
    },

    // ── Phase 5.7 T5.7.2 — bun_sourcemap_lookup ────────────────────────────

    sourcemapLookup(map, line, col): SourcemapPosition | null {
      const payload = enc.encode(JSON.stringify({ map, line, col }))
      const r = callPackedRaw('bun_sourcemap_lookup', payload, undefined, false)
      if (!r) return null
      const mem2 = (_instance!.exports.memory as WebAssembly.Memory).buffer
      try {
        return JSON.parse(dec.decode(new Uint8Array(mem2, r.ptr, r.len))) as SourcemapPosition
      } finally {
        r.free_(r.ptr)
      }
    },

    // ── Phase 5.7 T5.7.3 — bun_html_rewrite ────────────────────────────────

    htmlRewrite(html, rules): string | null {
      const payload = enc.encode(JSON.stringify({ html, rules }))
      const r = callPackedRaw('bun_html_rewrite', payload, undefined, false)
      if (!r) return null
      const mem2 = (_instance!.exports.memory as WebAssembly.Memory).buffer
      try {
        return dec.decode(new Uint8Array(mem2, r.ptr, r.len))
      } finally {
        r.free_(r.ptr)
      }
    },

    // ── T5.10.3 — bun_brace_expand ──────────────────────────────────────────

    braceExpand(pattern): string[] | null {
      const r = callPackedRaw('bun_brace_expand', enc.encode(pattern), undefined, false)
      if (!r) return null
      const mem2 = (_instance!.exports.memory as WebAssembly.Memory).buffer
      try {
        return JSON.parse(dec.decode(new Uint8Array(mem2, r.ptr, r.len))) as string[]
      } finally {
        r.free_(r.ptr)
      }
    },

    dumpVfsSnapshot(): Uint8Array | null {
      const fn = _instance!.exports.bun_vfs_dump_snapshot as (() => bigint) | undefined
      if (!fn) return null
      const packed = fn()
      const ptr = Number(packed >> 32n)
      const len = Number(packed & 0xffff_ffffn)
      if (ptr === 0 || len === 0) return null
      const mem2 = (_instance!.exports.memory as WebAssembly.Memory).buffer
      const copy = new Uint8Array(len)
      copy.set(new Uint8Array(mem2, ptr, len))
      const freeFn = _instance!.exports.bun_free as ((p: number) => void) | undefined
      freeFn?.(ptr)
      return copy
    },

    // ── T5.13.1 — bun_shell_parse ────────────────────────────────────────────

    shellParse(src): ShellAST | null {
      const r = callPackedRaw('bun_shell_parse', enc.encode(src), undefined, false)
      if (!r) return null
      const mem2 = (_instance!.exports.memory as WebAssembly.Memory).buffer
      try {
        return JSON.parse(dec.decode(new Uint8Array(mem2, r.ptr, r.len))) as ShellAST
      } finally {
        r.free_(r.ptr)
      }
    },
  }

  return rt
}
