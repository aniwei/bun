# Bun WASM Browser Runtime — Phase 5 迭代计划

**状态**：Phase 5.1 已完成 ✅ · Phase 5.2 T5.2.1–T5.2.8 全部完成 ✅ · Phase 5.3 T5.3.1a-i + T5.3.2(CSS) + T5.3.3 + T5.3.5 + T5.3.6 + T5.3.7 完成 🟡（T5.3.4 降级为长期探索项）· Phase 5.4 T5.4.1 + T5.4.2 + T5.4.3 + T5.4.4 + T5.4.5 完成 🟡 · **Phase 5.5 T5.5.1(源级) + T5.5.2(host ThreadPool) + T5.5.3(能力探测+协议+内核接入) + T5.5.4(JSI ABI + 基础设施) 完成** 🟡 · **Phase 5.6 T5.6.1(独立 WASM Instance + live VFS 全链路) 完成** 🟡（原 T5.6.3 撤销，由 Phase 5.13 替代）· Phase 5.7 T5.7.1 + T5.7.2 + T5.7.3 完成 🟡（见 §8.2 表述修正）· **Phase 5.8 全部完成** ✅ · **Phase 5.9 全部完成** ✅ · **Phase 5.11 T5.11.1–T5.11.6 全部完成** ✅（482/482 通过）  
**新规划**：Phase 5.10（Zig 真身二期）· 5.11（WebContainer API 对齐）· 5.12（阻塞 I/O 真身化）· 5.13（自研 Shell）· 5.14（预览闭环）· 5.15（稳定化）—— 详见 §9。  
**当前测试**：447/447 通过（19 个测试文件，0 失败）。
**依赖文档**：
- [bun-wasm-browser-runtime-technical-design.md](./bun-wasm-browser-runtime-technical-design.md)
- [bun-wasm-browser-runtime-implementation-plan.md](./bun-wasm-browser-runtime-implementation-plan.md)

**范围**：在 Phase 0-4 基础上，结合 WebContainer 的能力模型，系统性复用 `src/` 下现有 Zig 能力，把 bun-browser 从"可跑 hello world + 装包"推进到"可作为浏览器端完整 Bun 运行时"。

---

## 1. 对标 WebContainer 的能力差距

| 维度 | WebContainer | bun-browser 现状 | 差距 |
|------|--------------|------------------|------|
| 进程模型 | 每进程独立 Worker，真 `spawn`/`kill`/pipe | 单 Worker 内联 `jsi_eval` | ❌ 无隔离 |
| fs 语义 | 完整 POSIX（symlink/mount/watch） | VFS 基本 CRUD | ⚠️ 缺 symlink/watch/mount |
| 阻塞 I/O | SAB + Atomics.wait 真阻塞 | 协作式 `bun_tick` 轮询 | ❌ 无阻塞系统调用 |
| npm | 内置协议 + postinstall script | TS installer + WASM semver/integrity | ⚠️ 无 lifecycle scripts |
| 网络 | TCP over WebSocket relay、端口转发 | `Bun.serve` + Service Worker 拦截 | ⚠️ 无 TCP |
| 多线程 | wasm-threads（pthread）+ 共享堆 | ⚠️ 基础设施就绪（SAB ring、atomic-wait、ThreadPool、JSI ABI），共享堆 wasm 构建脚本已写入，待 zig toolchain 产出 `bun-core.threads.wasm` | ⚠️ 构建待执行 |
| 终端 | PTY + xterm.js | ❌ | ❌ |
| 文件监听 | fs.watch (inotify 模拟) | ❌ | ❌ |
| 跨源隔离 | 强制 COOP/COEP | 未启用 | ❌ |

---

## 2. Zig 能力复用矩阵

对 `src/` 下 15+ 个子系统做盘点，按接入成本 × 价值排序。

| # | Zig 模块 | 成本 | 价值 | 对标能力 |
|---|---------|:----:|:----:|---------|
| 1 | `src/paths.zig` | 🟢 | 🟡 | fs path 正确性 |
| 2 | `src/sha.zig` + `src/base64/*` | 🟢 | 🟡 | `Bun.hash` / crypto |
| 3 | `src/zlib.zig` + `brotli.zig` | 🟡 | 🔥 | tarball 解压、`Bun.gzipSync` |
| 4 | `src/url.zig` | 🟢 | 🟢 | `new URL` 正确性 |
| 5 | `src/glob/*` | 🟡 | 🟡 | `Bun.Glob` |
| 6 | `src/resolver/*` | 🟠 | 🔥 | package.json exports/tsconfig paths |
| 7 | `src/js_parser.zig` + `js_printer.zig` + `transpiler.zig` | 🔴 | 🔥 | TS 真转译，消除 Host 回调 |
| 8 | `src/bundler/*` + `linker.zig` | 🔴 | 🔥 | tree-shaking、代码分割 |
| 9 | `src/install/npm.zig` + `dependency.zig` + `tarball.zig` + `integrity.zig` | 🟠 | 🔥 | npm 协议完整 |
| 10 | `src/fs/*` + `src/bun.js/node/node_fs.zig` | 🟠 | 🔥 | Node fs 全 API（dirent/Stats/Promise） |
| 11 | `src/shell/*` | 🟠 | 🟡 | `Bun.$` |
| 12 | `src/sourcemap/*` | 🟡 | 🟡 | 栈帧还原 |
| 13 | `src/HTMLScanner.zig` | 🟡 | 🟢 | `HTMLRewriter` |
| 14 | `src/patch.zig` | 🟡 | 🟢 | bun patch |
| 15 | `src/threading/*` | 🔴 | 🔥 | 真并行（依赖 wasm-threads） |

**当前已接入**：`src/semver/*`、`src/sys_wasm/vfs.zig`、`src/jsi/*`、`src/timer.zig`、`src/bun_wasm_semver.zig`。  
**Phase 5.5 host 基础设施（TS）**：`packages/bun-browser/src/sab-ring.ts`（SPSC SAB ring）、`packages/bun-browser/src/atomic-wait.ts`（Atomics 跨环境抽象）、`packages/bun-browser/src/thread-pool.ts`（host pthread 孵化器）。

---

## 3. 架构级缺口（非单模块可补）

### A. wasm-threads + SAB 事件循环

对标 WebContainer 的阻塞系统调用模型。

- **构建**（已落地源码，待 zig toolchain 执行）：`build-wasm-smoke.zig` 新增 `build-wasm-threads` step — `wasm_target` 使用 `cpu_features_add = {.atomics, .bulk_memory}`；`Executable.shared_memory = true` + `import_memory = true`；初始 16 MiB / 上限 256 MiB；产物 `packages/bun-browser/bun-core.threads.wasm` 与 `bun-core.wasm` 共存
- **运行时**：每 pthread 一 Worker，通过 `ThreadPool`（`src/thread-pool.ts`）孵化；tid 单调分配（主=0，子≥1）；`thread:start/{tid,arg,memory,module}` 协议启动；`thread:exit/error` 回调
- **宿主侧**：demo server 需发 `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`（T5.5.3 ⏳）
- **新增 JSI imports**（`src/jsi/imports.zig` + `jsi-host.ts`）：`jsi_atomic_wait(ptr,expected,timeout_ms)u32`（0=ok/1=not-equal/2=timed-out）、`jsi_atomic_notify(ptr,count)u32`、`jsi_thread_spawn(arg)u32`（返回 tid）、`jsi_thread_self()u32`、`jsi_thread_capability()u32`（bit0=SAB/bit1=Worker+waitSync/bit2=host-spawn）
- **SAB ring**：`sab-ring.ts` — 32B header（head/tail/closed/waiters）+ SPSC 数据区，用于 pipe/stdio/VFS 远端 I/O
- **Atomics 抽象**：`atomic-wait.ts` — Worker 内 `Atomics.wait` / 主线程 `Atomics.waitAsync` / 无 SAB 时 setTimeout 轮询
- **降级**：`threadPoolAvailable(memory)` 探测 SAB 可用性；非 isolated 上下文自动走单线程路径（`jsi_thread_spawn` 返回 0）

### B. 进程隔离

对标 WebContainer 的 spawn。

- 每个 `bun_spawn` 在独立 WASM Instance 运行（同一 Module 多 Instance，共享 VFS 快照）
- pipe 通过 SAB ring buffer + `Atomics.notify`
- `bun_kill` / `bun_feed_stdin` / `bun_close_stdin` 真实可用

### C. 真实 TCP / HTTP 服务

- **浏览器**：`Bun.serve` 走 Service Worker 路由（已有），可选接 WebSocket relay 让远端客户端接入
- **Node 宿主**：直接 bind `net.Server`

### D. sourcemap 贯通

transpile / bundle 输出 sourcemap → 错误对象堆栈反查回源。

---

## 4. 分阶段迭代计划

### Phase 5.1 — Zig 基础能力直通（低风险打底）✅

**时间盒**：1 周（已完成）  
**目标**：纯计算模块零障碍接入，立刻替换现有手写/Host 回调实现。

| 任务 | 模块 | 替换对象 | 新 ABI | 状态 |
|------|------|---------|--------|------|
| T5.1.1 | `std.fs.path`（替代 `src/paths.zig`） | `normPath/joinPath/pathDirname` 手写实现 | `bun_path_normalize`、`bun_path_dirname`、`bun_path_join` | ✅ |
| T5.1.2 | `src/sha.zig` + `src/base64/*` | `crypto.subtle` / 手写 SHA | `bun_hash(algo, ptr, len) u64`、`bun_base64_encode/decode` | ✅ |
| T5.1.3 | `src/zlib.zig` + `src/brotli.zig` | `DecompressionStream` | `bun_inflate/bun_deflate(ptr, len, format) u64` | ✅ |
| T5.1.4 | `std.Uri`（替代 `src/url.zig`） | `URL_MODULE_SRC` 内联 JS | `bun_url_parse`、`__bun_url_parse` HostFunction | ✅ |

**实现说明**：

- **T5.1.1**：`src/paths.zig` 和 `src/url.zig` 均依赖 `bun` package，无法直接编入 `wasm32-freestanding`。改用 Zig 标准库替代：
  - `normPath` → `std.fs.path.resolvePosix(alloc, &.{path})`（绝对路径无需 CWD）
  - `pathDirname` → `std.fs.path.dirnamePosix(path) orelse "/"`
  - 外部 ABI `bun_path_join` 使用 packed buffer 格式：`[base_len: u32 LE][base bytes][rel bytes]`

- **T5.1.4**：注入 `__bun_url_parse` HostFunction（由 `std.Uri.parse` 驱动）到 JSI 全局，`URL_MODULE_SRC` 内联 JS 优先使用它，`native URL` 作为回退。同时导出 `bun_url_parse` WASM ABI 供 TS 层调用，返回 JSON（字段：`href/scheme/protocol/host/hostname/port/pathname/search/hash/auth`）。

**验收结果**：
- 全量测试 **192 / 192 通过**（新增 18 个 path/url 测试）
- 新测试文件：`packages/bun-browser/test/path-url.test.ts`
- `installer.ts` 的 `DecompressionStream` 已替换为 `wasmRuntime.inflate('gzip')` + fallback
- `bun-core.wasm` 新增导出：`bun_path_normalize`、`bun_path_dirname`、`bun_path_join`、`bun_url_parse`

---

### Phase 5.2 — Transpiler 真身

**状态**：🟡 原型（轻量 Zig stripper）已落地，`js_parser` 全栈接入待实现

**时间盒**：2-3 周  
**目标**：消除对 Host `jsi_transpile` 的硬依赖，TS/JSX 在 WASM 内部真实转译。

#### 分层策略

- **原型层**：`src/bun_wasm_transform.zig` — wasm32-freestanding 纯 stdlib 实现的轻量
  TS/JSX strip 转译器，不引入 `js_parser`/`Log`/`FileSystem` 等大依赖。
  支持的特性：
  - 变量、2参数、返回值类型注解删除
  - `interface` / `type` / `declare` 整体删除
  - `class` 访问修饰符、装饰器
  - `enum` 折叠为 IIFE
  - `as T` 转换、非空断言 `!`
  - `import type` / `export type`
  - 函数签名与 class 中的泛型
  - 基础 JSX（React.createElement／tsx）

  不在覆盖范围（留给 `js_parser` 完整接入）：sourcemap、namespace 合并、
  复杂条件类型、模块重映射。

- **未来**：`src/js_parser.zig` + `js_printer.zig` + `transpiler.zig` 真身接入，
  在同一 `bun_transform` ABI 下替换底层实现，上层无感。

#### T5.2.6 依赖面分析（阻塞项）

`js_parser.zig` 与 `transpiler.zig` 强依赖以下模块，WASM 化成本陡峭：

| 依赖 | 用途 | WASM 适配策略 |
|------|------|---------------|
| `bun.jsc` (`JSValue`/`JSGlobalObject`) | macros / plugin runner | stub：WASM 构建禁用 macros，`PluginRunner = void` |
| `bun.logger.Log` | 错误与警告收集 | 可用：改为 `std.ArrayList(Msg)`，由 WASM 直接序列化到 `errors[]` |
| `bun.Fs.FileSystem` | 源文件路径规范化 | 用 `std.fs.path.resolvePosix` 替换 |
| `bun.RuntimeTranspilerCache` | 转译结果缓存（磁盘） | stub：WASM 内关闭缓存（`cache = null`） |
| `bun.Mimalloc` / `bun.default_allocator` | 全局分配器 | 替换为 `std.heap.wasm_allocator` |
| `_resolver.PendingResolution` | lazy import 引用 | 可用：同 `ParseResult` 一起 WASM 化 |
| `bun.bundle_v2.*` | bundler 耦合字段 | 隔离：`ParseResult` 所用字段单独 WASM 化；bundle 路径仍走手写 |

**建议路径（未来工作）**：

1. 在 `bun_wasm_shim.zig` 内逐步扩展：`logger.Msg`、`logger.Source`、`options.Loader`、`js_ast.Ast` 的
   WASM-safe 子集；其他 jsc-依赖字段用 `comptime if (is_wasm) void else ...` 隔离。
2. 新增 `src/bun_wasm_parser.zig`，顶层 `fn parse(source, opts) !Ast`，委托到 `js_parser.Parser`
   但在 WASM 构建下关闭 macro/plugin 路径。
3. `bun_transform` ABI 不变，实现切换到 `js_parser` + `js_printer`。
4. 观察 `build-wasm-smoke.zig` 的产物大小（预估 +800KB~2MB），视情况启用 `-Doptimize=ReleaseSmall`。

#### 任务

| 任务 | 说明 | 状态 |
|------|------|:----:|
| T5.2.1 | 轻量 stripper `src/bun_wasm_transform.zig`（Zig） | ✅ |
| T5.2.2 | `bun_transform(opts_ptr, opts_len) u64` WASM ABI | ✅ |
| T5.2.3 | `packages/bun-browser/src/wasm.ts` 新增 `transform()` 封装 + `TransformResult` 类型 | ✅ |
| T5.2.4 | Bundler 内部 `transpileIfNeeded` 接入；优先 `jsi_transpile`（ESM→CJS 完整降级），失败回退内置 WASM stripper | ✅ |
| T5.2.5 | 端到端测试：`packages/bun-browser/test/transform.test.ts` | ✅ |
| T5.2.6 | 完整 ESM→CJS 转换：`import`/`export` 全形式解析，生成 `require()`/`module.exports` | ✅ |
| T5.2.7 | sourcemap v3 生成：VLQ 编码 + 行追踪，`bun_transform` 返回 `map` 字段 | ✅ |
| T5.2.8 | identity 检测：host `jsi_transpile` 透传时回退 WASM 内置 ESM→CJS，WASM 完全自含 | ✅ |

#### ABI

```c
// 输入 JSON:
//   { "code": <TS>,
//     "filename": <str>,
//     "jsx": "react"|"react-jsx"|"preserve"|"none",
//     "esm_to_cjs": true,   // T5.2.6：将 import/export 转换为 require/module.exports
//     "source_map": true    // T5.2.7：生成 sourcemap v3
//   }
// 输出 JSON:
//   { "code": <JS|null>,
//     "errors": [<string>...],
//     "map": <string|null>  // sourcemap v3 JSON（仅 source_map=true 时存在）
//   }
u64 bun_transform(u32 opts_ptr, u32 opts_len);
```

#### 验收

- 当前验收（T5.2.1–T5.2.8 全部完成，292/292 测试通过）：
  - Bundler 在无 Host 帮助下将 `.ts`/`.tsx` 打包为可运行 JS（T5.2.8 identity 检测）
  - `rt.transform(src, file)` 返回 `{code, errors}`
  - `rt.transform(src, file, { esmToCjs: true })` 返回含 `require()`/`module.exports` 的 CJS（T5.2.6）
  - `rt.transform(src, file, { sourceMap: true })` 返回含 `map` 字段的结果，`map` 为 sourcemap v3 JSON（T5.2.7）
  - 源码存在轻度语法问题时，shape 仍保持合法

---

### Phase 5.3 — Resolver / Bundler 真身

**状态**：🟡 手写 resolver 已具备 package.json 主要字段 + tsconfig paths；`src/resolver/*` 真身接入待做

**时间盒**：3-4 周  
**目标**：替换 `bun_browser_standalone.zig` 里手写的 80 行 ModuleLoader 与 300 行 bundler。

#### 分层策略

- **现阶段（手写 resolver 增强版）**：在 `bun_browser_standalone.zig` 内扩展 VFS-based resolver，
  补齐 monorepo 项目最常用的字段——对 MVP 场景已够用，不阻塞 Phase 5.4+。
- **未来（真身接入）**：将 `src/resolver/resolver.zig`（DirInfo / PackageJson / TSConfigJSON）
  编入 WASM，替换手写实现但保持 `bun_resolve` ABI 兼容。

#### 任务拆分

| 任务 | 说明 | 状态 |
|------|------|:----:|
| T5.3.1a | `package.json` `main` / `module` / `browser` 字段（字符串） | ✅ |
| T5.3.1b | `package.json` `exports["."]` 字符串 / 条件对象（browser → import → default → require 优先） | ✅ |
| T5.3.1c | `package.json` `exports["./subpath"]` 字面匹配 | ✅ |
| T5.3.1d | Scoped packages `@scope/name` 正确拆分 | ✅ |
| T5.3.1e | `tsconfig.json` `compilerOptions.paths` + `baseUrl` + `*` 通配符 | ✅ |
| T5.3.1f | tsconfig 向上查找（monorepo apps/web → 根 tsconfig） | ✅ |
| T5.3.1g | `exports` `imports` 条件中 `pattern/*` 通配符 | ✅ |
| T5.3.1h | `tsconfig.extends` 继承链 | ✅ |
| T5.3.1i | Node builtin 映射（`node:fs`/`fs`/`node:path`/`path`/`events` 等 → `<builtin:node:fs>` 虚拟路径 + polyfill/delegate 注入） | ✅ |
| T5.3.2 | `src/bundler/*` 最小子集（树摇 / CSS import / code-splitting）<br/>**已落地：CSS passthrough** — `.css` 文件转译为 `<style>` 注入 IIFE；resolver ext 探测 + `classifyLoader` 均加入 `.css` | 🟡 |
| T5.3.3 | 新 ABI `bun_bundle2` 接收 config_json（`entrypoint` + `external[]` + `define{}`） | ✅ |
| T5.3.4 | 旧 `bun_resolve`/`bun_bundle` 作薄封装 → 底层替换为 `src/resolver/*` | ⏳ |
| T5.3.5 | `import.meta.url`/`import.meta.env`/`import.meta.resolve()` polyfill（ESM→CJS 模式） | ✅ |
| T5.3.6 | 动态 `import("spec")` → `Promise.resolve(require("spec"))` 转换 | ✅ |
| T5.3.7 | 每模块头部注入 `__filename`/`__dirname` 变量 | ✅ |

#### Phase 5.8 — Node.js 内置模块 polyfill（inline JS）

**状态**：✅ 已完成（**329/329 全通过**）  
**目标**：补齐 `events`/`buffer`/`assert`/`querystring`/`string_decoder` 五个高频内置模块的纯 JS 实现，在 `requireFn`（运行时 `require()`）和 `builtinPolyfillSource`（bundle 打包路径）同步生效。

| 任务 | 说明 | 状态 |
|------|------|:----:|
| T5.8.1 | `events` / `node:events` — 完整 EventEmitter（on/once/off/emit/prependListener/removeAllListeners/inherits） | ✅ |
| T5.8.2 | `buffer` / `node:buffer` — Buffer class（from/alloc/concat/isBuffer + read/write UInt8/16/32 BE/LE）| ✅ |
| T5.8.3 | `assert` / `node:assert` — 全套断言（ok/strictEqual/deepStrictEqual/throws/rejects/match/AssertionError）| ✅ |
| T5.8.4 | `querystring` / `node:querystring` — parse/stringify，支持数组值、`+` 空格、maxKeys | ✅ |
| T5.8.5 | `string_decoder` / `node:string_decoder` — StringDecoder（write/end，TextDecoder 驱动）| ✅ |

**验收**（**329/329 全通过**，较上轮 +26）：
- `require('events')` / `require('node:events')` 返回可用的 EventEmitter 类
- EventEmitter on/once/off/emit/prependListener/removeAllListeners/inherits/listenerCount 均正确
- `require('buffer').Buffer.from/alloc/concat/isBuffer` + read/write UInt32BE/LE 正确
- `require('assert').strictEqual/deepStrictEqual/throws/rejects/match` 在通过/失败场景均正确抛出/不抛 AssertionError
- `require('querystring').parse/stringify` 支持 `+` 解码空格、数组值多对
- `require('string_decoder').StringDecoder.write/end` UTF-8 解码正确
- 以上 5 个模块均可通过 **bundle 路径**（`builtinPolyfillSource`）内联到输出 bundle
- 新增测试文件：`packages/bun-browser/test/node-builtins.test.ts`（26 个用例）

#### Phase 5.9 — 更多 Node.js 内置模块 polyfill（stream/crypto/os/zlib/http/child_process/worker_threads/process）

**状态**：🟡 部分完成（37/43，详见下表 + 已知问题）  
**目标**：补齐 8 个次高频内置模块，同样在 `requireFn`（运行时）和 `builtinPolyfillSource`（bundle 路径）两条路径同步生效。源码常量位于 `src/bun_browser_standalone.zig`（`STREAM_MODULE_SRC` / `CRYPTO_MODULE_SRC` / `OS_MODULE_SRC` / `ZLIB_MODULE_SRC` / `HTTP_MODULE_SRC` / `CHILD_PROCESS_MODULE_SRC` / `WORKER_THREADS_MODULE_SRC` / `PROCESS_MODULE_SRC`）。

| 任务 | 模块 | 说明 | 状态 |
|------|------|------|:----:|
| T5.9.1 | `stream` / `node:stream` | Readable/Writable/Duplex/Transform/PassThrough，pipeline/finished，`Symbol.asyncIterator`；依赖 `events` | 🟡 Zig 源已修复<br>(Writable.end/Stream 别名 ✅；PassThrough/Transform/pipeline 需 wasm 重建后生效) |
| T5.9.2 | `crypto` / `node:crypto` | createHash(sha1/sha256)、createHmac、randomBytes、randomUUID、timingSafeEqual、pbkdf2Sync；纯 JS，无 host 依赖 | ✅ (8/8)<br>sha256 之前标红是测试期望值写错（与 Bun/Node 官方 crypto 交叉验证，实际输出 `...5dae2223b00361a3...` 就是正确的 FIPS 180-4 值） |
| T5.9.3 | `os` / `node:os` | platform/type/arch/hostname/homedir/tmpdir/EOL/cpus/totalmem/freemem/constants | ✅ (5/5) |
| T5.9.4 | `zlib` / `node:zlib` | gunzipSync 委托 `Bun.gunzipSync`，gzipSync 抛错，createGunzip 返回 PassThrough，constants | ✅ (4/4) |
| T5.9.5 | `http` / `https` / `node:http` / `node:https` | STATUS_CODES/METHODS/createServer（返回 listen/close/address stub）；https 与 http 同 API | ✅ (4/4) |
| T5.9.6 | `child_process` / `node:child_process` | execSync/spawnSync 抛错，exec/spawn 返回 stub（stdout/stderr/kill）| ✅ (4/4) |
| T5.9.7 | `worker_threads` / `node:worker_threads` | isMainThread=true、threadId=0、Worker 抛错、MessageChannel 创建 port1/port2 | ✅ (4/4) |
| T5.9.8 | `process` / `node:process` | require('process') 返回 process-like 对象（platform/env/cwd），与 globalThis.process 统一 | ✅ (2/2) |

**已知问题**（3 个 stream 相关失败，源已修复待 wasm 重建；`node-builtins-extra.test.ts`）：

| 测试 | 行 | 状态 |
|------|---:|------|
| `node:stream > PassThrough passes data through` | 135 | Zig `STREAM_MODULE_SRC` 已加 `Readable.prototype.on` override（`on('data', fn)` 自动调用 `resume()`），`/tmp/stream-test.js` 独立验证 PASS，待 wasm 重建 |
| `node:stream > Transform uppercases data` | 153 | 同上 |
| `node:stream > pipeline connects streams` | 182 | 同上 |
| `bundle: stream PassThrough` | 543 | 同上 |

**crypto sha256 疑似失败的真相**（已 resolved）：测试期望值 `...5dae2ec7...` 是错的，实际 FIPS 180-4 Appendix A.1 的 SHA-256("abc") = `BA7816BF 8F01CFEA 414140DE 5DAE2223 B00361A3 96177A9C B410FF61 F20015AD`。Bun 内建 `require('crypto').createHash('sha256').update('abc').digest('hex')` 亦是此值。已同步修正 `node-builtins-extra.test.ts` 两处。Zig 端 `_sha256` 实现一直是正确的。

**stream 修复详情**：补丁加入两行（`src/bun_browser_standalone.zig` 第 582 行附近）：

```js
Readable.prototype.on=function(ev,fn){EE.prototype.on.call(this,ev,fn);if(ev==='data')this.resume();return this;};
Readable.prototype.addListener=Readable.prototype.on;
```

这对齐了 Node.js 语义——首次添加 `'data'` 监听者即从 paused 切换到 flowing 模式，消费队列中已入队的 chunk 并继续派发新的 push。`PassThrough/Transform/pipeline` 三个场景均依赖此行为。

**通过部分的验收**：
- `require('os').platform()` / `arch()` / `tmpdir()` / `homedir()` / `EOL` 返回合法字符串
- `require('zlib').gunzipSync` 可用，`gzipSync` 抛 "not available"，`createGunzip` 返回 stream-like 对象
- `require('http').STATUS_CODES[200] === 'OK'`，`createServer` 返回含 `listen`/`close`/`address` 的 stub
- `require('child_process').execSync` 抛 "not supported"，`spawn` 返回含 stdout/stderr/kill 的 stub
- `require('worker_threads').isMainThread === true`，`MessageChannel` 两端 `postMessage` 为函数
- `require('process')` 返回 process-like 对象
- `require('crypto').randomBytes(16).length === 16`，`randomUUID()` 命中 UUIDv4 正则，`timingSafeEqual` 相等/不等正确，HMAC-SHA256 known vector 正确
- bundle 路径：os/http/child_process/worker_threads 均可通过 `builtinPolyfillSource` 内联到打包输出

#### 已落地 ABI（Phase 5.3a / T5.3.3）

**Phase 5.3a**：无新 ABI —— resolver 改进在 `bun_resolve` / `bun_bundle` 内部生效，上层 `rt.resolve()` / `rt.bundle()` 调用方式不变。

**T5.3.3**：新增 `bun_bundle2(cfg_ptr, cfg_len) u64`，接受 JSON 配置：
```json
{ "entrypoint": "/app/index.ts", "external": ["react"], "define": { "process.env.NODE_ENV": "\"production\"" } }
```
`wasm.ts` 新增 `BundleConfig` 接口 + `rt.bundle2(config)` 方法。`external` 包在运行时委托 `globalThis.require(...)`；`define` 在转译前做词边界文本替换。

```c
// 行为变化：
// 1. spec 非裸导入仍走 resolveRelative（未变）
// 2. spec 裸导入先试 tsconfig paths → 匹配则解析；否则走 node_modules lookup
// 3. node_modules lookup 自下而上找 dir，然后读 package.json：
//      exports["."] 字符串 → exports["."].browser|import|default|require → module → main
//      subpath `pkg/foo` → 若 exports["./foo"] 命中则用之；否则 resolveRelative(dir, "./foo")
```

#### 验收

- 当前验收（Phase 5.3a + T5.3.2 + T5.3.3 + T5.3.5 + T5.3.6 + T5.3.7，**303/303 全通过**）：
  - `rt.resolve("@scope/pkg", ...)`, `rt.resolve("pkg/sub", ...)`, `rt.resolve("@/utils", ...)` 通过
  - Bundler 遇到 tsconfig 别名的 import 能自动解析并打包
  - package.json `exports` 的 browser/import/default/require 条件按优先级匹配
  - 未匹配 tsconfig paths 的裸导入自动 fallback 到 node_modules
  - `rt.bundle2({ external: ["react"] })` 阻止 react 被打包，改用 `globalThis.require` 委托
  - `rt.bundle2({ define: { "process.env.NODE_ENV": '"production"' } })` 在转译前完成文本替换
  - externals + define 可组合使用
  - **T5.3.2（CSS）**：`require('./style.css')` 打包产出 `document.createElement("style")` + `appendChild` 的 IIFE，在 DOM 可用时自动注入样式
  - **T5.3.5**：`import.meta.url` → 文件名字符串；`import.meta.env` → `process.env` polyfill；`import.meta.resolve()` → `require.resolve()`；未知属性 → `{url,env}` 对象
  - **T5.3.6**：`import("spec")` → `Promise.resolve().then(function(){return require("spec")})`
  - **T5.3.7**：每个模块包裹内头部自动注入 `var __filename="...",__dirname="...";`
- 正式验收（待 T5.3.4 完成）：
  - `Bun.resolveSync` 能处理 monorepo、tsconfig paths、exports 条件（输出与 CLI Bun 一致）
  - `Bun.build` 输出含 sourcemap、tree-shake 后的 bundle

---

### Phase 5.4 — 真实 npm 协议

**时间盒**：2 周  
**目标**：TS 版 `installer.ts` 退化为薄 fetch 壳，版本解析/依赖图/lockfile 全在 Zig。

**任务**：
- T5.4.1 `src/install/npm.zig` manifest 解析接入 WASM ✅
  - **已落地**：`bun_npm_parse_metadata(json_ptr,json_len,range_ptr,range_len) u64`
  - 内部：`std.json` 全量解析 npm metadata JSON → 提取 dist-tags + versions → `semverSelectFromList`（从 `bun_semver_select` 重构提取）→ 返回 JSON `{version,tarball,integrity?,shasum?,dependencies{}}`
  - 支持 semver range / dist-tag（如 `"latest"`）/ 精确版本 / 通配符（`"*"`→ 优先 latest dist-tag）
  - `installer.ts` 优先走 WASM 路径（`parseNpmMetadata`），回退到 TS semver
  - 新增 6 个集成测试（`bun_npm_parse_metadata` describe 块）
- T5.4.2 `src/install/dependency.zig` 版本图求解 ✅
- T5.4.3 `src/install/tarball.zig` 解压入 VFS（依赖 Phase 5.1 的 zlib）✅
  - **已落地**：Zig 内置 ustar/PAX tar 解析器 + `inflateImpl` gzip 解压 + 直接写入 `vfs_g`
  - ABI：`bun_tgz_extract(input_ptr, input_len) u64`（packed input：`[prefix_len:u32][prefix][tgz]`）
  - `installer.ts` 优先使用 WASM 路径，回退到 JS inflate+parseTar
  - 新增 5 个集成测试（`bun_tgz_extract` describe 块）
- T5.4.4 Host ↔ WASM 异步 fetch 协议 ✅
- T5.4.5 lockfile v2 读写（复用 `src/install/lockfile/*`）✅

**验收**：
- `installPackages()` 中的 `chooseVersion` / 依赖 BFS / integrity 全部委托 WASM
- 支持 `dependencies` + `peerDependencies` + `optionalDependencies`
- lockfile 能被 CLI Bun 读取验证
- **当前验收（T5.4.1 + T5.4.2 + T5.4.3 + T5.4.4 + T5.4.5，281/281 全通过）**：
  - `rt.parseNpmMetadata(json, range)` 正确解析 npm registry metadata JSON
  - semver range（`^1.0.0`）/ dist-tag（`latest`）/ 精确版本（`1.2.3`）/ 通配符（`*`）均支持
  - `dependencies` 对象完整提取
  - 无匹配版本返回 `null`
  - `rt.extractTgz(prefix, tgz)` 返回解压文件数
  - 提取后文件可被 `rt.resolve` / `rt.bundle` 直接访问（无需额外 `bun_vfs_load_snapshot`）
  - 嵌套目录（`dist/utils/helper.js`）正确创建（`mkdirp`）
  - `installPackages({ wasmRuntime: rt })` 路径：`result.files = []`，文件已在 VFS 中
  - `rt.resolveGraph(deps, metadata)` WASM 内部 BFS 展平完整传递依赖图，去重，缺失包放入 `missing[]`
  - `rt.writeLockfile({ packages, workspaceCount })` 序列化为有效 JSON 格式 lockfile
  - 异步 fetch 协议：`npmInstallBegin` → `npmNeedFetch` → `npmFeedResponse` → `npmInstallResult` → `npmInstallEnd` 完整链路可用

---

### Phase 5.5 — wasm-threads + SAB（架构升级）

**状态**：🟡 T5.5.1 Zig 构建脚本落地（待 toolchain 验证）+ T5.5.2 host ThreadPool 完成 + **T5.5.3 能力探测/协议/内核接入完成** ✅ + T5.5.4 ABI/基础设施完成（共 96/96 通过）；T5.5.5/6 待 `bun-core.threads.wasm` 产物实际生成后接入。

**时间盒**：3-4 周  
**风险**：🔴 最大  
**目标**：对标 WebContainer 的阻塞语义模型。

**任务**：
- T5.5.1 `build-wasm-smoke.zig` 开启 `shared-memory` / `atomics` 🟡（源级完成，待本地 zig toolchain 执行产出 `bun-core.threads.wasm`）
  - 新增 `build-wasm-threads` step：`cpu_features_add = {.atomics, .bulk_memory}` + `shared_memory = true` + `import_memory = true`
  - `initial_memory = 16 MiB` / `max_memory = 256 MiB`（匹配非线程版，未来可调）
  - 产物：`packages/bun-browser/bun-core.threads.wasm`（与 `bun-core.wasm` 共存；host 按能力探测挑选）
  - `single_threaded = true` 仍保留 —— Zig stdlib 部分代码非线程安全，真正的并发由 JS 侧 Worker + SAB 承担；`memory.atomic.wait32/notify` 是 wasm 指令，不受此 flag 影响
- T5.5.2 Host 端 pthread 支持 ✅
  - `packages/bun-browser/src/thread-pool.ts` —— `ThreadPool` 类：tid 单调分配（主线程=0，子线程≥1）、`maxThreads` 上限、`spawn()`/`join()`/`terminate()`/错误传播
  - `threadPoolAvailable(memory)` —— `SharedArrayBuffer` + `memory.buffer instanceof SharedArrayBuffer` 双探测
  - 协议 UI→Worker：`{type:"thread:start", tid, arg, memory, module}`；Worker→UI：`thread:exit | thread:error`
  - `kernel.ts` 后续只需构造 `ThreadPool` 实例并将 `pool.spawn.bind(pool)` 注入 `JsiHostOptions.spawnThread`
  - 测试：`test/thread-pool.test.ts` 14 例（tid 单调、maxThreads、onExit/onError、join 多消费者、terminate 语义）
- T5.5.3 COOP/COEP 能力探测 + 内核接入 ✅
  - 新增 `src/thread-capability.ts`：`detectThreadCapability()` / `createSharedMemory()` / `selectWasmModule()`
  - `protocol.ts` HandshakeRequest 新增 `threadsWasmModule?` + `sharedMemory?`；HandshakeAck 新增 `threadMode: "threaded" | "single"`
  - `wasm.ts` WasmRuntimeOptions 新增 `sharedMemory?` / `spawnThread?` / `threadId?`；`createWasmRuntime` 在 threads 模式下将 SAB Memory 注入 `env.memory`
  - `kernel.ts` KernelOptions 新增 `threadsWasmModule?`；构造时自动检测能力并在握手消息中携带 threads 所需字段
  - `kernel-worker.ts` 握手 handler：worker 侧再次探测能力，若 threadsReady 则创建 `ThreadPool`，以 threads 模块 + sharedMemory + `spawnThread` 启动，降级路径透明
  - 测试：`test/thread-capability.test.ts` 13 例（结构验证、条件逻辑、createSharedMemory、selectWasmModule 四路径、幂等性）全通过
  - 检测失败时自动降级到单线程（零额外配置）
- T5.5.4 新 JSI imports ✅
  - `jsi_atomic_wait(view_ptr, expected, timeout_ms) u32` —— 0=ok, 1=not-equal, 2=timed-out
  - `jsi_atomic_notify(view_ptr, count) u32` —— 返回唤醒数；非 SAB 返回 0
  - `jsi_thread_spawn(arg) u32` —— 返回 tid，未启用 pool 时返回 0
  - `jsi_thread_self() u32` —— 当前线程 tid；主线程为 0
  - `jsi_thread_capability() u32` —— 位图：bit0=SAB, bit1=inWorker+waitSync, bit2=host-spawn
  - Zig: `src/jsi/imports.zig`；Host: `packages/bun-browser/src/jsi-host.ts`（含 non-SAB fallback path）
- T5.5.5 `bun_tick` 事件循环改为 `Atomics.wait` 真阻塞模型 ⏳
- T5.5.6 `std.Thread` 在 WASM 下映射到 `bun_thread_spawn` ⏳

**新增基础设施**（本轮落地）：
- `packages/bun-browser/src/sab-ring.ts` —— SPSC 字节 ring 缓冲（SharedArrayBuffer-backed，header 32B + 数据区），用于 pipe/stdio/VFS 远端 I/O：
  - `createSabRing(capacity)` / `SabRingProducer` / `SabRingConsumer`
  - `head`/`tail`/`closed`/`waiters` 四槽 header；经典空/满消歧（保留 1 字节）
  - `write()` 非阻塞、带 wrap-around；`read()` 非阻塞；`readBlocking()` 在 Worker 内真阻塞
  - 非 SAB 环境自动退化为 `ArrayBuffer`，单线程内部仍可用（便于测试）
- `packages/bun-browser/src/atomic-wait.ts` —— `Atomics.wait` / `Atomics.waitAsync` 跨环境抽象：
  - `detectAtomicWait()` 环境能力探测（sab/inWorker/sync/async）
  - `atomicWaitSync()` —— Worker 内真阻塞；主线程降级到一次性比较
  - `atomicWaitAsync()` —— `waitAsync` Promise 路径；无 SAB 时 setTimeout 轮询
  - `atomicNotify()` —— 唤醒；非 SAB 返回 0（no-op）

**验收**（当前阶段，44/44 新增测试通过）：
- `test/sab-ring.test.ts` 11 例：capability、SPSC 读写、环绕、close 语义、非-SAB fallback
- `test/atomic-wait.test.ts` 8 例：capability 检测、not-equal/timed-out/ok/唤醒
- `test/jsi-host.test.ts` 新增 8 例：`jsi_thread_self`、`jsi_thread_spawn` delegation、`jsi_thread_capability` 位图、`jsi_atomic_wait`/`jsi_atomic_notify` non-SAB fallback
- `test/thread-pool.test.ts` 14 例：`threadPoolAvailable`、tid 单调、onExit/onError、maxThreads 上限、join 多消费者、terminate 语义、postMessage 失败路径
- 全套 434/438 通过（剩余 4 例为 stream polyfill，已在 Zig 源修复，待 wasm 重建生效）

**最终验收**（待 T5.5.1/5/6 完成）：
- `Bun.spawn` 真正并行（Phase 5.6 配合）
- `fs.readFileSync` 对远端 VFS 可阻塞
- 能力探测：无 SAB 上下文自动降级，功能无差异

---

### Phase 5.6 — 进程隔离与 shell

**时间盒**：2-3 周  
**目标**：`bun_spawn` 真实进程模型；`Bun.$` 可用。

**任务**：
- T5.6.1 每个 `bun_spawn` 独立 WASM Instance ✅
  - 新建 `src/spawn-worker.ts` —— 子进程 Worker 入口：收到 `spawn:init` 后创建独立 `WasmRuntime`，按序加载父进程 VFS 快照，应用 argv/env/cwd，按子命令路由（`bun run`/`bun -e`/fallback `bun_spawn`），转发 stdout/stderr/exit 消息
  - 新建 `src/process-manager.ts` —— `ProcessManager` 类：`workerFactory` 注入（势
    测友好）、`trackVfsSnapshot()` 积累父进程 VFS 快照、`spawn(opts): Promise<exitCode>` 创建子进程 Worker、中继 stdout/stderr 回调、退出后 resolve
  - COW VFS 语义：父进程通过 `bun_vfs_load_snapshot` 加载的文件对子进程可见；子进程内部写入不影响父进程（独立线性内存）
  - `protocol.ts` HandshakeRequest 新增 `spawnWorkerUrl?:string`
  - `kernel.ts` KernelOptions 新增 `spawnWorkerUrl?:string|URL`
  - `kernel-worker.ts` handshake handler：初始化 `ProcessManager`；`vfs:snapshot` handler 同步 `trackVfsSnapshot`；`spawn` handler：`ProcessManager` 存在时打包给子进程 Worker，否则回退 in-process `bun_spawn`（向后兼容）
  - **live VFS 全链路（已实现）**：
    - Zig 新增 `bun_vfs_dump_snapshot() u64` 导出——将 `vfs_g.exportSnapshot()` 序列化后以 `(ptr << 32) | len` 打包返回，host 读取后调用 `bun_free(ptr)` 释放
    - `wasm.ts` `WasmRuntime.dumpVfsSnapshot(): Uint8Array | null` — 调用 `bun_vfs_dump_snapshot`，将返回的 packed u64 拆包后 slice WASM 线性内存，确保父进程运行时写入的文件对子进程可见
    - `process-manager.ts` `ProcessSpawnOptions` 新增 `extraSnapshots?: ArrayBuffer[]`；`spawn()` 将 `pendingSnapshots + extraSnapshots` 合并后写入 `SpawnInitMessage.vfsSnapshots`
    - `kernel-worker.ts` `spawn` handler 在调用 `processManager.spawn()` 前先执行 `rt.dumpVfsSnapshot()`，将结果以 `extraSnapshots` 传入，实现父进程 `Bun.write` 写入的文件子进程完全可见
  - 测试：`test/process-manager.test.ts` 14 例全通过（含 3 例 `extraSnapshots` 场景）；`test/integration.test.ts` 新增 6 例全链路集成测试
- T5.6.2 stdio 走 SAB ring buffer
  - 依赖 Phase 5.5 的 atomics
- T5.6.3 `src/shell/*` 接入 → `Bun.$`
- T5.6.4 PTY 协议对接
  - 浏览器：xterm.js
  - Node 宿主：真实 PTY

**验收**：
- `bun run` 可跑 shell 脚本
- `Bun.$` 模板字符串可用
- 进程 stdio 真实隔离

---

### Phase 5.7 — Bun.* API 补齐与 sourcemap

**状态**：🟡 T5.7.1 完成（Bun 对象核心 API 全量实现）

**时间盒**：2 周  
**目标**：Bun 对象表面积接近真实 runtime 的浏览器可用子集。

**任务**：
- T5.7.1 新增 Bun.* API ✅
  - （详见上方 T5.7.1 实现细节）
- T5.7.2 `src/sourcemap/*` 栈帧还原 ✅
- T5.7.3 `HTMLRewriter` via `src/HTMLScanner.zig` ✅

**T5.7.1 实现细节**：

- **JSI 新增两个 import**（`src/jsi/imports.zig` + `jsi-host.ts`）：
  - `jsi_read_arraybuffer(handle, dest_ptr, dest_len) i32`
  - `jsi_arraybuffer_byteLength(handle) i32`
- **Zig HostFn**（`src/bun_browser_standalone.zig`，在 `setupGlobals` 注册）：
  - `bunFileReadFn` — VFS 文件 → ArrayBuffer handle
  - `bunFileSizeFn` — VFS stat size（缺失时返回 0）
  - `bunFileWriteFn` — 写字符串或 ArrayBuffer/TypedArray 到 VFS
  - `bunResolveSyncFn` — builtin → tsconfig paths → resolveBareInVfs 链
  - `bunGunzipSyncFn` — `inflateImpl` gzip 解压
  - `bunTranspileCodeFn` — `transpileIfNeeded` 管道
- **`BUN_GLOBAL_SRC` 扩充**：从仅含 `serve` 扩展为完整 Bun 对象，HostFn 引用在 IIFE 最后 `delete globalThis.__bun_*` 清理，避免污染全局命名空间

**验收**（T5.7.1，**257/257 全通过**）：
- `Bun` 对象包含所有预期属性（21 个 key），`missing=[]`
- `Bun.file(path).text()` / `.arrayBuffer()` / `.json()` / `.size` 行为正确
- `Bun.write(path, string|Uint8Array|BunFile)` 写入 VFS 并可读回
- `Bun.resolveSync` 处理相对路径、node 内建、tsconfig paths
- `Bun.inspect` 递归格式化，支持循环引用 → `[Circular]`
- `Bun.sleep(ms)` 返回 Promise，配合 `bun_tick` 正常 resolve
- `Bun.gunzipSync` 解压 gzip 字节还原原始内容
- `Bun.Transpiler.transformSync(tsCode)` 去除类型注解
- 新增测试文件：`packages/bun-browser/test/bun-apis.test.ts`（32 个用例）

**T5.7.2 实现细节**：

- **Zig**：`bun_sourcemap_lookup(input_ptr, input_len) u64`
  - 输入 JSON：`{"map":"<sourcemap v3 json 字符串>","line":<0-based>,"col":<0-based>}`
  - 内置 Base64-VLQ 解码器（`vlqDecode`）逐段解析 `mappings` 字段
  - 输出 JSON：`{"source":"<file>","line":N,"col":N,"name":"<name>"}` 或 `{"source":null}`
  - 行/列越界时返回 `{"source":null}`，解析失败时返回 packError

- **TS**：`wasm.ts` 新增 `SourcemapPosition` 接口 + `sourcemapLookup(map, line, col): SourcemapPosition | null`

**T5.7.3 实现细节**：

- **Zig**：`bun_html_rewrite(input_ptr, input_len) u64`
  - 输入 JSON：`{"html":"...","rules":[{"selector":"tag[attr=val]","attr":"...","replace":"..."/"text":"..."/"remove":true}]}`
  - 支持选择器：`"tag"`、`"tag[attr]"`、`"tag[attr=val]"`
  - 支持操作：`set_attr`（修改属性值）、`set_text`（替换标签体文本）、`remove`（删除整个标签）
  - 简单非验证型字符扫描实现，适用于常见 HTML 重写场景

- **TS**：`wasm.ts` 新增 `HtmlRewriteRule` 接口 + `htmlRewrite(html, rules): string | null`

**验收**（T5.7.1 + T5.7.2 + T5.7.3，**281/281 全通过**，较上轮 +13）：
- `rt.sourcemapLookup(mapJson, line, col)` 返回正确源文件 + 原始行列
- 行列越界返回 `{ source: null }`
- 无效 JSON 输入不崩溃，返回 null 或 `{ source: null }`
- `rt.htmlRewrite(html, rules)` 替换 `script[src]` 属性、`set_text` 内容替换
- 无匹配规则时 HTML 原样返回，空规则列表不崩溃
- 新增测试文件：`packages/bun-browser/test/installer.test.ts`（新增 13 个用例）

---

## 5. 新 ABI 汇总（Phase 5 全期）

```c
// Phase 5.1 ✅ 已实现
u64 bun_hash(u32 algo, u32 ptr, u32 len);
u64 bun_base64_encode(u32 ptr, u32 len);
u64 bun_base64_decode(u32 ptr, u32 len);
u64 bun_inflate(u32 ptr, u32 len, u32 format);   // 0=gzip, 1=zlib, 2=raw
u64 bun_deflate(u32 ptr, u32 len, u32 format);   // ⭕️ deferred (Zig 0.15.2 API 冗余)
u64 bun_path_normalize(u32 ptr, u32 len);
u64 bun_path_dirname(u32 ptr, u32 len);
u64 bun_path_join(u32 paths_ptr, u32 paths_len); // packed: [base_len:u32le][base][rel]
u64 bun_url_parse(u32 ptr, u32 len);             // → JSON {href,scheme,protocol,host,hostname,port,pathname,search,hash,auth}

// Phase 5.2 ✅ 原型已实现（轻量 stripper），js_parser 版本 ⏳
u64 bun_transform(u32 opts_ptr, u32 opts_len);   // 输入/输出 JSON，见 Phase 5.2 小节

// Phase 5.3
u64 bun_resolve2(u32 spec_ptr, u32 spec_len,
                 u32 from_ptr, u32 from_len,
                 u32 cfg_ptr,  u32 cfg_len);   // ⏳ 待实现
u64 bun_bundle2(u32 cfg_ptr, u32 cfg_len);    // ✅ T5.3.3 已实现

// Phase 5.7 T5.7.1 ✅ 已实现（JSI import，非 WASM export）
// import: jsi_read_arraybuffer(handle u32, dest_ptr u32, dest_len u32) i32
// import: jsi_arraybuffer_byteLength(handle u32) i32

// Phase 5.7 T5.7.2 ✅ 已实现
// 输入 JSON: {"map":"<sourcemap v3 json>","line":<0-based>,"col":<0-based>}
// 输出 JSON: {"source":"<file>","line":N,"col":N,"name":"<name>"} 或 {"source":null}
u64 bun_sourcemap_lookup(u32 input_ptr, u32 input_len);

// Phase 5.7 T5.7.3 ✅ 已实现
// 输入 JSON: {"html":"...","rules":[{"selector":"tag[attr=val]","attr":"...","replace":"..."|"text":"..."|"remove":true}]}
// 输出: 重写后的 HTML 字符串
u64 bun_html_rewrite(u32 input_ptr, u32 input_len);

// Phase 5.4 T5.4.3 ✅ 已实现
// packed input: [prefix_len:u32 LE][prefix bytes][tgz bytes]
u64 bun_tgz_extract(u32 input_ptr, u32 input_len);  // → JSON {"extracted":N}

// Phase 5.4 T5.4.1 ✅ 已实现
u64 bun_npm_parse_metadata(u32 json_ptr, u32 json_len,
                            u32 range_ptr, u32 range_len);  // → JSON {version,tarball,integrity?,shasum?,dependencies{}}

// Phase 5.4 T5.4.2 ✅ 已实现
// 输入 JSON: {"deps":{"react":"^18.0.0"}, "metadata":{"react":"<npm registry json>"}}
// 输出 JSON: {"resolved":[{name,version,tarball,...,dependencies{}}], "missing":[<name>...]}
u64 bun_npm_resolve_graph(u32 input_ptr, u32 input_len);

// Phase 5.4 T5.4.4 ✅ 已实现（异步 fetch 协议）
// 输入 JSON: {"deps":{"react":"^18.0.0"}, "registry":"https://registry.npmjs.org"}
// 输出 JSON（首个 fetch 请求）: {"id":N,"url":"...","type":"metadata"|"tarball","name":"...","range":"..."}
u64  bun_npm_install_begin(u32 input_ptr, u32 input_len);
u64  bun_npm_need_fetch();  // 返回同格式 fetch 请求，ptr=0 表示无待处理请求
void bun_npm_feed_response(u32 req_id, u32 data_ptr, u32 data_len);
void bun_npm_install_mark_seen(u32 name_ptr, u32 name_len);
u64  bun_npm_install_result();  // 输出 JSON: {"resolved":[...],"missing":[...]}
void bun_npm_install_end();

// Phase 5.4 T5.4.5 ✅ 已实现
// 输入 JSON: {"packages":[{key,name,version}...],"workspaceCount":N}
// 输出: bun.lock 文本（JSON 格式）
u64 bun_lockfile_write(u32 input_ptr, u32 input_len);

// Phase 5.4
u64  bun_npm_need_fetch();
void bun_npm_feed_response(u32 req_id, u32 data_ptr, u32 data_len, u32 status);

// Phase 5.5（JSI imports，非 WASM export；Zig 声明在 src/jsi/imports.zig，host 实现在 jsi-host.ts）✅ T5.5.4 已实现
// import: jsi_atomic_wait(view_ptr u32, expected i32, timeout_ms u32) u32  → 0=ok, 1=not-equal, 2=timed-out
// import: jsi_atomic_notify(view_ptr u32, count u32) u32                  → 唤醒数；非 SAB 返回 0
// import: jsi_thread_spawn(arg u32) u32                                    → tid（0=失败/pool 未启用）
// import: jsi_thread_self() u32                                            → 当前 tid；主线程=0
// import: jsi_thread_capability() u32                                      → 位图 bit0=SAB|bit1=Worker+waitSync|bit2=host-spawn
// host side T5.5.2 ✅:
//   threadPoolAvailable(memory): boolean
//   ThreadPool.spawn(arg) → tid  /  .join(tid): Promise<code>  /  .terminate()

// Phase 5.6
u32 bun_spawn2(u32 cmd_ptr, u32 cmd_len,
               u32 stdin_sab, u32 stdout_sab, u32 stderr_sab);

// Phase 5.6 T5.6.1 ✅ 已实现
// 将当前运行时 VFS 序列化为快照，供子进程 Worker 加载（实现父进程运行时写入文件对子进程可见）
// 返回值：packed u64 = (ptr << 32) | len，host 通过 bun_read_string(ptr, len) 读取字节后调用 bun_free(ptr) 释放
u64 bun_vfs_dump_snapshot();
```

全部 ABI 变更需同步：

- `src/jsi/imports.zig`（若为 import）
- `packages/bun-browser/src/jsi-host.ts`
- `packages/bun-browser/src/wasm.ts`（host API 包装）
- 本文档 §5

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| 二进制体积膨胀（1.7MB → 8MB+） | 首屏慢 | 分 `bun-core-lite.wasm`（runtime）/ `bun-core-full.wasm`（+ 编译器），按需懒加载 |
| wasm-threads 浏览器兼容性（Safari 17+、iOS WebView 受限） | 功能降级 | 双版本 + feature detection，保留单线程路径 |
| COOP/COEP 侵入性（iframe 嵌入受限） | 嵌入场景不可用 | 提供 non-isolated build，牺牲 SAB 换嵌入性 |
| Zig 模块的 `Log`/`allocator`/`FileSystem` 耦合 | 接入工作量爆炸 | 每模块先过"编译"再过"功能"；stub 收敛到 `bun_wasm_shim.zig` |
| sourcemap 体积 | 生产环境浪费 | 默认关闭，仅 dev 模式或显式配置开启 |

---

## 7. 执行顺序建议

```
5.1 (基础打底)
 ├─► 5.2 (transpiler) ───┐
 ├─► 5.3 (resolver/bundler) ─► 与 5.2 合流，提供 Bun.build
 └─► 5.4 (npm) ──────────┘

5.5 (wasm-threads) —— 独立大头，可与 5.2/5.3 并行
 └─► 5.6 (spawn/shell) —— 依赖 5.5 的 SAB

5.7 (API 补齐) —— 贯穿整个 Phase 5，随各子阶段落地
```

**立刻起步推荐**：Phase 5.1 全部任务。全是纯计算模块、WASM 编译零障碍，当天能完成 1-2 项，为后续 Phase 5.4 的 npm 真身铺路（tarball 解压 + integrity 都要 SHA / zlib）。

---

## 8. 能力对标与 Zig 复用再审计（2026-04-26）

**背景**：447/447 绿后重新核对两件事：(1) 当前与 WebContainer 真实 API 的对标是否准确；(2) `§2 Zig 能力复用矩阵`中标"已接入"的项目有无与真实代码出入。

### 8.1 WebContainer 能力复核

对照 `@webcontainer/api` 公开文档的真实 API 表面：

| WebContainer API | bun-browser 现状 | 真实差距 |
|------------------|------------------|---------|
| `spawn(cmd, args, opts)` → `WebContainerProcess { output: ReadableStream, input: WritableStream, exit: Promise<number>, kill(signal), resize(dim) }` | `kernel.spawn(argv): Promise<exitCode>` + `onStdout`/`onStderr` 回调 | 🟠 **API shape 不齐** —— 需外包 Streams API；`resize`/真 `kill` 均未实现 |
| `fs.readFile/writeFile/readdir/mkdir/rm/rename` （Promise 返回） | Zig 内置 VFS + Node `fs` polyfill，但**对外 `kernel.fs.*` 异步 API 不存在** | 🟠 缺主线程侧异步 fs API |
| `fs.watch(path, opts)` | ❌ 未实现 | 🔴 缺 inotify 模拟 |
| `mount(FileSystemTree)` | `buildSnapshot(VfsFile[])` + `bun_vfs_load_snapshot` | 🟡 语义等价、格式不同；缺 `FileSystemTree` JSON 树结构适配 |
| `export(path)` | `bun_vfs_dump_snapshot()` （T5.6.1 落地） | 🟡 语义等价、格式不同 |
| `on("port", listener)` / `on("server-ready")` | Service Worker 已捕获 `/__bun_preview__/{port}/*`，但 Kernel 无 `on("port")` API | 🟠 缺事件回调；`Bun.serve({ port })` 绑定与预览路由之间缺桥 |
| `on("preview-message", ...)` | ❌ | 🟠 iframe↔kernel 消息桥未实现 |
| COOP/COEP 强制 | `service-worker.ts` 可选注入 | 🟢 具备 |
| `credentials` （npm auth） | ❌ | 🟢 低优先，MVP 不阻塞 |
| PTY / xterm.js | ❌ | 🔴 缺失 |
| TCP over WebSocket relay | ❌ | 🔴 浏览器固有限制，延期 |
| pthread + 共享堆 | 源级就绪 + `ThreadPool` 已实现 | 🟡 wasm 产物未构建（阻塞 zig toolchain） |

**修正**：`§1` 表格原说"每进程独立 Worker 真 spawn"是 WebContainer 现状、"单 Worker 内联 `jsi_eval`"是 bun-browser 现状。实测 T5.6.1 完成后，bun-browser **已具备**每进程独立 Worker + 独立 WASM Instance，此栏应更新为"M1 形式已具备（postMessage 字符串流），stdio 尚未切到 SAB 流（M2 目标）"。

### 8.2 Zig 复用情况硬核对（grep 实测）

对 `§2` 表逐项交叉核对 `bun.jsc` / `AsyncHTTP` / `@import("bun")` 引用：

| # | 模块 | 文档声称 | 实际状态 | JSC 耦合点 |
|---|------|---------|---------|-----------|
| 1 | `src/paths.zig` | 🟢 | ⚠️ **未接真身**，当前用 `std.fs.path`；`paths.zig` 自身带 `@import("bun")` 可通过 shim 接入 | 浅 |
| 2 | `src/sha.zig`、`src/base64/*` | 🟢 ✅ | ✅ 已接入（`bun_hash`、`bun_base64_*`） | 无 |
| 3 | `src/zlib.zig` | 🔥 ✅ | ✅ 已接入（`bun_inflate`） | 无 |
| 3b | `src/brotli.zig` | — | ⚠️ 未接入（依赖 brotli C lib，需 wasm 交叉编译） | 无 |
| 4 | `src/url.zig` | 🟢 | ⚠️ **未接真身**，当前用 `std.Uri`；如需 WHATWG URL 细节应接入真身 | 浅（仅 `@import("bun")`） |
| 5 | `src/glob/*` | 🟡 | ❌ **未接入**（`src/glob/GlobWalker.zig` 引用 `bun.jsc`；但 `src/glob/glob.zig` 核心匹配器多半纯） | 混合（walker JSC，matcher 纯） |
| 6 | `src/resolver/*` | 🔥 | ❌ **未接入且成本极高** —— `resolver.zig` 多处 `bun.jsc.ModuleLoader.HardcodedModule.Alias` / `HTTPThread` / `JSGlobalObject`；**建议 T5.3.4 降级为长期探索项** | 深 |
| 7 | `src/js_parser.zig` + `transpiler.zig` | 🔥 | ❌ 未接入（与 `§Phase 5.2 T5.2.6 依赖面分析`一致） | 深 |
| 8 | `src/bundler/*` | 🔥 | ❌ 未接入（`bundle_v2.zig` L5047 `bun.jsc.AnyEventLoop` 硬编码） | 深 |
| 9 | `src/install/npm.zig` + `dependency.zig` + `tarball.zig` + `integrity.zig` | 🔥 | `integrity.zig` ✅ 接入（`bun_integrity_verify`）；其他三个未接入；**`dependency.zig` JSC 仅集中在 `.toJS/.fromJS/.inferFromJS` 三个方法，剥掉即可 WASM** | 混合 |
| 9b | `src/install/lockfile/*` | — | ❌ **未接入（高价值遗漏）**：`lockfile.zig` + `bun.lock.zig` + `Tree.zig` + `Package/` 全部**无 JSC 引用**（实测 grep 0 命中），当前 `bun_lockfile_parse` 是 300 行手写 JSON parser | 无（可直接接入） |
| 10 | `src/fs/*` + `src/bun.js/node/node_fs.zig` | 🔥 | ❌ 未接入；**bun.js/node 不在 WASM 编译范围**，MVP 通过 JS polyfill 代替 | 深 |
| 11 | `src/shell/*` | 🟡 | ❌ **未接入且不可行**：`shell.zig`/`interpreter.zig`/`subproc.zig` 本质都是 JSC 类（`ShellInterpreter` 是 JSClass）；**建议 T5.6.3 重定向为"基于 `braces.zig` 的轻量自研 shell"** | 深 |
| 11b | `src/shell/braces.zig` | — | ❌ **未接入（低成本高价值）**：brace expansion 纯 Zig 实现，0 JSC 引用 | 无 |
| 12 | `src/sourcemap/*` | 🟡 ✅（Phase 5.7 T5.7.2 声称） | ⚠️ **文档措辞误导** —— `bun_sourcemap_lookup` 是**独立的内联 VLQ 解码器**，并未调用 `src/sourcemap/Mapping.zig`；`Mapping.zig` / `CodeCoverage.zig` 带 JSC，`vlq.zig`（如存在）可剥离接入 | 浅/深混合 |
| 13 | `src/HTMLScanner.zig` | 🟢 ✅（Phase 5.7 T5.7.3 声称） | ⚠️ **文档措辞误导** —— `bun_html_rewrite` 是独立字符扫描器，并未调用 `HTMLScanner.zig`；`HTMLScanner.zig` 自身**零 JSC 引用**，可真身接入 | 无 |
| 14 | `src/patch.zig` | 🟢 | ❌ 未接入；全部接口是 JSC methods，需大改 | 深 |
| 15 | `src/threading/*` | 🔥 | ❌ 未接入；host 侧已用 `thread-pool.ts` 替代 | — |
| 15b | `src/semver/*` | — | ✅ 已接入（`bun_semver_select`，`SemverObject` 有 JSC 方法但未进入 WASM 路径） | 浅（可 shim） |

**重要修正项**（需回写到 `§2` 与对应 Phase 节）：

1. **`bun_html_rewrite` 与 `bun_sourcemap_lookup` 并非"真身接入"**：文档表述让读者误以为复用了 `src/HTMLScanner.zig` / `src/sourcemap/*.zig`。实际两者均为 `bun_browser_standalone.zig` 内联实现。应在 Phase 5.7 文字改为"接口等价 / 独立实现"；真身接入留作 Phase 5.10 子任务。
2. **`src/install/lockfile/*` 是最具价值的未接入项**：零 JSC 依赖 + 即用即得 + 能让浏览器产出与 CLI Bun 100% 兼容的 `bun.lock`/`bun.lockb`。
3. **`src/resolver/*` 真身接入（T5.3.4）不应作为常规迭代项**：经实测耦合面（`HTTPThread` + `VM` + `ModuleLoader`）过宽，建议**取消**并声明"手写 resolver 增强版是最终方案"。
4. **`src/shell/*` 真身接入（原 T5.6.3）不可行**：`ShellInterpreter` 是 JSC class；重定向为"基于 `braces.zig` 的自研 shell（Phase 5.13）"。

---

## 9. Phase 5.10+ 新迭代任务（基于 §8 审计）

### Phase 5.10 — Zig 真身接入二期（低风险高价值）

**目标**：把 `§8.2` 中"已识别为可直接接入"的清洁 Zig 模块接入 WASM，替换手写实现。

**时间盒**：1-2 周  
**前置**：无（均可与 Phase 5.5/5.6 并行）

| 任务 | 内容 | 工作量 | 状态 |
|------|------|:------:|:----:|
| T5.10.1 | `src/install/lockfile/*` 真身接入——替换手写 `bun_lockfile_parse` + `bun_lockfile_write`，产物与 CLI Bun 互通 | 🟠 中 | ⏳ 受阻：`parseIntoBinaryLockfile` 要求 `?*PackageManager`，PackageManager 深度依赖 JSC+libuv，需设计 WasmPackageManager 空壳或绕路 API |
| T5.10.2 | `src/HTMLScanner.zig` 真身接入——`bun_html_rewrite` 内部改走 `HTMLScanner`，增加属性/选择器支持面 | 🟡 小 | ⏳ 受阻：`HTMLScanner` 用途为扫描 import 语义，与 `bun_html_rewrite` 任意选择器/属性改写不匹配；lol-html C 库需接入 WASM 构建，工作量远超 🟡 |
| T5.10.3 | `src/shell/braces.zig` 接入——暴露 `bun_brace_expand(ptr, len) u64` ABI，为 Phase 5.13 shell 准备 | 🟢 很小 | ✅ 已完成（ASCII 内联实现）：`braces.zig` 因 `shell.zig` JSC 耦合 + shim 缺 `Output.scoped`/`BabyList` 无法直接导入，改用独立递归展开器；`bun_brace_expand` export + `wasm.ts braceExpand()` + 9 测试全通过 |
| T5.10.4 | `src/install/dependency.zig` 接入——剥离 `.toJS/.fromJS/.inferFromJS` 三个 JSC 方法后，`bun_npm_resolve_graph` 使用真实 `Dependency.Version` 结构 | 🟡 小 | ⏳ |
| T5.10.5 | `src/sourcemap/VLQ.zig` 接入——`bun_sourcemap_lookup` 替换内联解码器 | 🟢 很小 | ✅ 已完成：`VLQ.decode()` 无 `bun.assert` 调用可直接导入；`vlqDecode` 30 行内联实现替换为薄包装层调用 `VLQ.decode`，保留首字符合法性和越界守卫 |
| T5.10.6 | 文档修正——同步更新任务状态、补充可行性结论、去除"已接入"误导措辞 | 🟢 | ✅ 已完成（本次迭代）|

**验收**：
- `rt.parseLockfile(text)` 与 CLI Bun `bun install` 产出的 `bun.lock` 解析结果字段对齐（`lockfileVersion/workspaceCount/packageCount/packages[]`）
- `rt.writeLockfile(pkgs)` 可被 CLI Bun 作为真实 lockfile 消费
- `rt.htmlRewrite(html, rules)` 支持属性重写 + 文本替换 + 节点删除，基于 `HTMLScanner` 的鲁棒解析
- 无回归；测试 ≥460 pass

### Phase 5.11 — WebContainer API 表面对齐

**目标**：让现有 WebContainer 用户可低成本切换到 bun-browser，或至少 API shape 一致。

**时间盒**：2 周  
**前置**：Phase 3 Service Worker（已完成）

| 任务 | 内容 | 状态 |
|------|------|:----:|
| T5.11.1 | `Kernel.on("port", listener)` + `on("server-ready", listener)` —— `Bun.serve({ port })` 调用时 kernel 捕获并触发事件，携带 `{ port, url }` | ✅ |
| T5.11.2 | `ProcessHandle` Streams API —— `kernel.process(argv)` 返回 `{ output: ReadableStream, stdout: ReadableStream, stderr: ReadableStream, exit: Promise<number>, kill(signal), resize(dim), input: WritableStream }`；`spawn:stdout/stderr` 带 id 事件流路由 | ✅ |
| T5.11.3 | `kernel.fs.*` 异步 API —— `readFile/writeFile/readdir/mkdir/rm/rename/stat`，全部返回 Promise；主线程 ↔ Worker 走 `fs:*` 协议 | ✅ |
| T5.11.4 | `kernel.mount(tree: FileSystemTree)` / `kernel.exportFs(path): FileSystemTree` —— WebContainer FileSystemTree 格式（嵌套 `{ directory/file/contents }` 对象）适配到现有 `VfsFile[]` | ✅ |
| T5.11.5 | `kernel.on("preview-message", listener)` —— iframe `window.postMessage` 懒安装 window.message 监听器，中继到 kernel listener；订阅者归零时自动卸载 | ✅ |
| T5.11.6 | `src/webcontainer-compat.ts`（作为 `bun-browser/webcontainer-compat` 子路径导出）—— 提供 WebContainer-style `WebContainer.boot(opts)` 工厂，内部包装 bun-browser Kernel；`fs`/`spawn`/`mount`/`on`/`teardown` API 对齐 `@webcontainer/api ^1.x` | ✅ |

**验收**：
- `await WebContainer.boot(opts)` 返回对象 shape 与 `@webcontainer/api` 兼容
- `process.output.pipeTo(new WritableStream(...))` 可消费 stdout
- `await kernel.fs.readFile("/index.ts", "utf-8")` 返回字符串
- 典型 WebContainer demo（StackBlitz 的 `simple-demo`）改 3-5 行 import 即可跑通

### Phase 5.12 — 阻塞 I/O & 进程真身化

**目标**：把 T5.6.1 的 postMessage 字符串流升级为 SAB 字节流，实现对标 WebContainer 的阻塞系统调用模型。

**时间盒**：3-4 周  
**前置**：Phase 5.5 T5.5.1 实际产出 `bun-core.threads.wasm`

| 任务 | 内容 | 原编号 | 状态 |
|------|------|:-----:|:----:|
| T5.12.1 | `bun_tick` 切换到 `Atomics.wait` 真阻塞模型 | 原 T5.5.5 | ⏳ |
| T5.12.2 | 子进程 stdio 切到 SAB ring —— `ProcessManager.spawn` + `spawn-worker.ts` 底层改用 `sab-ring.ts`，并在 `ProcessHandle` 暴露为 `ReadableStream`/`WritableStream` | 原 T5.6.2 | ⏳ |
| T5.12.3 | `bun_kill(pid, signal)` 真实实现 —— SAB header 增加 `signal` slot，子 Worker `bun_tick` 每次检查；常见信号 SIGTERM/SIGINT/SIGKILL | — | ⏳ |
| T5.12.4 | `std.Thread` → `bun_thread_spawn` 映射 | 原 T5.5.6 | ⏳ |
| T5.12.5 | `fs.watch` —— VFS 内部事件总线 + `chokidar`-style 回调；主线程通过 `watchFile` 协议订阅 | — | ⏳ |

**验收**：
- 子进程 `fs.readFileSync` 对远端 VFS **真阻塞**（主线程 VFS 写入瞬时可见）
- `process.kill("SIGTERM")` 使子进程 exit code 15
- `fs.watch("/src")` 在 `Bun.write("/src/index.ts")` 时立刻触发 listener

### Phase 5.13 — 轻量自研 Shell（取代原 T5.6.3）

**目标**：在无法复用 `src/shell/interpreter.zig` 的前提下，基于 `braces.zig` + 自研 lexer/parser 实现 `Bun.$` MVP。

**时间盒**：2-3 周  
**前置**：T5.10.3（`bun_brace_expand`）

| 任务 | 内容 | 状态 |
|------|------|:----:|
| T5.13.1 | Zig 侧 `bun_shell_parse(src) u64` —— AST-only，返回 JSON（command / pipe / redirect / subst / glob / brace） | ⏳ |
| T5.13.2 | TS 侧 `ShellInterpreter` —— 解析 AST 驱动 `ProcessManager.spawn` 管道、`kernel.fs.*` 重定向、env 变量展开 | ⏳ |
| T5.13.3 | 内置命令（JS 实现）：`echo/cd/pwd/ls/cat/mkdir/rm/cp/mv/env/export` 直接操作 VFS | ⏳ |
| T5.13.4 | `Bun.$\`...\`` 模板字符串 tag —— 复用 Phase 5.7 Bun 对象，调用 `ShellInterpreter` | ⏳ |
| T5.13.5 | 错误处理 + 退出码传播；`$.text() / .lines() / .json()` 流式 API | ⏳ |

**验收**：
- `await $\`ls /src | head -n 3\`` 在 VFS 中有效
- `await $\`cat package.json | grep name\`.text()` 返回字符串
- 管道多层组合正确（`a | b | c`）

### Phase 5.14 — 预览体验闭环

**目标**：与 T5.11.1/5 配合，真正支持多 port 并发预览 + iframe 双向通信。

**时间盒**：1-2 周  
**前置**：T5.11.1、T5.11.5

| 任务 | 内容 | 状态 |
|------|------|:----:|
| T5.14.1 | 多 port 注册表 —— `preview-router.ts` 升级，允许同时监听多个 port，每个一个 `on("port")` 事件 | ⏳ |
| T5.14.2 | COOP/COEP 头**强制**注入 —— demo 页附带 deploy 模板，或 SW 层必定下发 | ⏳ |
| T5.14.3 | iframe ↔ kernel `postMessage` bridge —— iframe 内注入小 script，`window.postMessage` 经 SW 中继到 kernel `on("preview-message")` | ⏳ |
| T5.14.4 | Port 自动分配 + 冲突检测 —— `Bun.serve({ port: 0 })` 自动选可用 port | ⏳ |

### Phase 5.15 — 稳定化 & CI

| 任务 | 内容 | 状态 |
|------|------|:----:|
| T5.15.1 | `bun-core.threads.wasm` CI lane —— docker 镜像装 zig 0.15.2 + 每 PR 构建 + artifacts 上传 | ⏳ |
| T5.15.2 | JSC 依赖追踪工具 —— `scripts/audit-wasm-shim.ts`：扫描 `src/` 下所有 `@import("bun")` 和 `bun.jsc` 引用，输出 markdown 报告（模块、JSC 耦合点、可否 shim、估算工作量） | ⏳ |
| T5.15.3 | 集成测试矩阵 —— 真实 vite/next/hono 项目的端到端测试（install → build → serve → fetch） | ⏳ |
| T5.15.4 | 体积预算 —— `bun-core.wasm` 当前大小记录 + Phase 5.10 接入后回归检查（目标 < 2.5 MB gzip） | ⏳ |

### 新迭代执行顺序建议

```
5.10 (Zig 真身二期) ── 并行 ──► 5.11 (WebContainer API 对齐)
                                      │
5.15 (CI/toolchain) ──────────────────┤
                                      │
5.12 (阻塞 I/O) ◄── 依赖 5.5 threads wasm 产物
  └─► 5.13 (自研 shell) ◄── 依赖 T5.10.3 (braces)
         └─► 5.14 (预览闭环) ◄── 依赖 5.11.1/5
```

**立刻起步推荐**：T5.10.3（`bun_brace_expand`）和 T5.10.5（VLQ 真身）均已完成，T5.10.6（文档修正）亦同步完成。当前绿线 **491/491**（24 files）。下一步建议：T5.10.4（`dependency.zig` 剥离 JSC 方法，工作量小，可行性高）；T5.10.1 需 WasmPackageManager 设计方案再推进；T5.10.2 重新评估为"扩展 `bun_html_rewrite` 选择器能力"而非接入 `HTMLScanner`。

---

## 10. 变更记录

| 日期 | 作者 | 变更 |
|------|------|------|
| 2026-04-27 | claude | **Phase 5.10 T5.10.3 + T5.10.5 + T5.10.6 完成**（491/491 全通过）：(1) **T5.10.5 VLQ 真身接入** —— 确认文件为 `src/sourcemap/VLQ.zig`（大写），`VLQ.decode()` 无 `bun.assert` 调用可安全导入 WASM 构建；将 `vlqDecode` 30 行内联 Base64-VLQ 解码器替换为薄包装层：首字符合法性守卫 + 越界守卫 + 委托 `VLQ.decode`，行为与原实现完全一致；(2) **T5.10.3 bun_brace_expand ABI 暴露** —— 调研发现 `src/shell/braces.zig` 因依赖 `shell.zig`（JSC 类耦合）+ shim 缺少 `Output.scoped`/`BabyList` 而无法直接导入；改为在 `bun_browser_standalone.zig` EOF 处实现独立递归 ASCII 展开器（`braceExpandStr`/`findBraceOpen`/`findBraceClose`/`splitByTopCommas`，共 ~120 行）；`bun_brace_expand` 输出 JSON 数组 packed u64 ABI；`wasm.ts` `WasmRuntime` 新增 `braceExpand(pattern): string[] \| null`；新建 `test/brace-expand.test.ts` 9 例全通过；(3) **T5.10.6 文档修正** —— 更新任务表 T5.10.1（PackageManager 阻塞分析）、T5.10.2（HTMLScanner API 不匹配 + lol-html 工作量重估）、T5.10.3/T5.10.5 状态升 ✅、立刻起步推荐更新为 T5.10.4。**491/491（+9），0 失败**。 |
| 2026-04-23 | claude | **Phase 5.11 WebContainer API 全部完成（T5.11.1–T5.11.6）**：T5.11.1 `Kernel.on("port"/"server-ready")` —— `kernel-worker.ts` `installBunServeHook()` 在握手前安装 `self.__bun_routes` Proxy 拦截，捕获 `Bun.serve({ port })` 后发送 `{ kind: "port" }` 消息，`kernel.ts` `onMessage` 响应并发射 `KernelPortEvent`，自动注册到 `PreviewPortRegistry`；T5.11.2 `ProcessHandle` Streams API —— `kernel.process(argv, opts)` 返回带独立三路 `ReadableStream<string>`（output/stdout/stderr）及 `exit: Promise<number>`；`SpawnRequest.streamOutput=true` 时 Worker 发送带 id 的 `spawn:stdout/stderr` 事件，`spawn:exit` 同时完成对应 ProcessHandle；T5.11.3 `kernel.fs.*` —— `readFile/writeFile/readdir/mkdir/rm/rename/stat` 全 Promise，新增 `fs:*` 双向协议，Worker handler 调用 VFS 后 postMessage 回响应；T5.11.4 `kernel.mount(tree)` + `kernel.exportFs(path)` —— `fileSystemTreeToVfsFiles`/`vfsFilesToFileSystemTree` 互转，mount 通过 `vfs:snapshot` 批量写入，exportFs 通过 `vfs:dump-request/response` round-trip；T5.11.5 `kernel.on("preview-message")` —— 懒安装 `window.addEventListener("message")`（仅浏览器环境），仅中继来自同源其他 frame 的消息，订阅者归零自动卸载；T5.11.6 `src/webcontainer-compat.ts`（子路径 `bun-browser/webcontainer-compat`）—— `WebContainer.boot(opts)` 工厂、`get fs(): FileSystemAPI`、`spawn(cmd,args)`、`mount/export/on/off/teardown`，API shape 对齐 `@webcontainer/api ^1.x`；`index.ts` 新增 `ProcessHandle/KernelPortEvent/KernelPreviewMessageEvent/WebContainer` 导出；`package.json exports` 新增 `./webcontainer-compat`；新增测试文件 `kernel-fs.test.ts`/`kernel-process.test.ts`/`webcontainer-compat.test.ts`。**482/482 通过，0 失败**。 |
| 2026-04-26 | claude | **Phase 5 审计与新迭代规划**：基于 447/447 绿线对 `§1 WebContainer 对标`和 `§2 Zig 复用矩阵`做硬核交叉核对（grep 实测 `bun.jsc`/`AsyncHTTP`/`@import("bun")` 引用）。新增 `§8 能力对标与 Zig 复用再审计` —— 修正三项表述误导：(a) `bun_html_rewrite` 并未接入 `src/HTMLScanner.zig`，实为独立字符扫描器；(b) `bun_sourcemap_lookup` 并未接入 `src/sourcemap/*`，实为内联 VLQ 解码器；(c) `src/install/lockfile/*` 是零 JSC 依赖的高价值未接入项（手写 `bun_lockfile_parse` 是 300 行 JSON parser）。新增 `§9 Phase 5.10+ 新迭代任务`：**Phase 5.10** Zig 真身二期（lockfile/HTMLScanner/braces/dependency/vlq 六项真身接入 + 文档修正）；**Phase 5.11** WebContainer API 表面对齐（Streams API、异步 fs、FileSystemTree、port/server-ready 事件、preview-message bridge、`@bun-browser/webcontainer-compat` 子包）；**Phase 5.12** 阻塞 I/O 真身化（`bun_tick` Atomics.wait、stdio SAB ring、`bun_kill` 真实信号、`fs.watch`）；**Phase 5.13** 轻量自研 Shell（取消原 T5.6.3 真身接入，改为基于 `braces.zig` 的 AST+JS interpreter）；**Phase 5.14** 预览体验闭环；**Phase 5.15** 稳定化（threads wasm CI lane、JSC 依赖追踪工具、体积预算）。同时取消/降级：T5.3.4（`src/resolver/*` 真身接入）从常规迭代降级为长期探索项；原 T5.6.3（`src/shell/*` 真身接入）撤销，由 Phase 5.13 替代。编号 §8 旧"变更记录"升为 §10。|
| 2026-04-26 | claude | **T5.6.1 live VFS 全链路完成**：解除"已知限制"，父进程运行时 `Bun.write` 写入的文件现对子进程完全可见。(1) Zig 新增 `bun_vfs_dump_snapshot() u64` WASM export —— 调用 `vfs_g.exportSnapshot()` 序列化当前 VFS 状态，以 `(ptr << 32) \| len` 打包返回，host 读取后调用 `bun_free(ptr)` 释放；(2) `wasm.ts` 新增 `WasmRuntime.dumpVfsSnapshot(): Uint8Array \| null` —— 拆包 packed u64、slice WASM 线性内存、拷贝为独立 `Uint8Array`；(3) `process-manager.ts` `ProcessSpawnOptions` 新增 `extraSnapshots?: ArrayBuffer[]`；`spawn()` 将 `pendingSnapshots + extraSnapshots` 合并为 `SpawnInitMessage.vfsSnapshots` 发送给子 Worker；(4) `kernel-worker.ts` `spawn` handler 在调用 `processManager.spawn()` 前先执行 `rt.dumpVfsSnapshot()`，以 `extraSnapshots` 传入，确保子进程完整继承父进程 VFS 运行时状态；(5) `test/process-manager.test.ts` 新增 3 例 `extraSnapshots` 场景（14 例全通过）；(6) 新建 `test/integration.test.ts` 6 例全链路集成测试（Bun.write → bun_vfs_dump_snapshot → spawn → 子进程可读）；同时 stream polyfill wasm 重建生效，全部 4 个残留失败清零。当前 **447/447 通过，0 失败**。|(1) 新建 `src/spawn-worker.ts` —— 子进程 Worker 入口：收到 `spawn:init` 后对传入的 Module 创建全新 `WasmRuntime`（独立线性内存 + JSI handle 空间），按序加载父进程积累的 VFS 快照（COW 语义），路由 `bun run`/`bun -e`/fallback，转发 stdout/stderr/exit；(2) 新建 `src/process-manager.ts` —— `ProcessManager` 类：`workerFactory` 工厂注入（势测友好，与 ThreadPool 一致）、`trackVfsSnapshot()` 积累快照、`spawn(opts):Promise<exitCode>` 创建子 Worker + 中继 IO + resolve；(3) `protocol.ts` `HandshakeRequest` 新增 `spawnWorkerUrl?`；(4) `kernel.ts` `KernelOptions` 新增 `spawnWorkerUrl?`；(5) `kernel-worker.ts` handshake 初始化 `ProcessManager`，`vfs:snapshot` 同步 `trackVfsSnapshot`，`spawn` handler 在 `ProcessManager` 存在时議包到子 Worker（否则回退 in-process，全向后兆容）；(6) 新建 `test/process-manager.test.ts` —— 11 例全通过（exit、stdout/stderr、Worker error、init payload、trackVfsSnapshot、并发 spawn）。已知限制：父进程脚本内 `Bun.write` 的内部 VFS 写入子进程暂不可见（需 wasm 重建新增 `bun_vfs_dump_snapshot`）。当前 **434/438 通过**（+11 新增，4 残留 stream 待 wasm 重建）。|
| 2026-04-25 | claude | **T5.5.3 COOP/COEP 能力探测 + 内核 ThreadPool 接入完成**：(1) 新建 `src/thread-capability.ts` — `ThreadCapability` 接口（`crossOriginIsolated/sharedArrayBuffer/threadsReady/inWorker/atomicsWaitAsync`）、`detectThreadCapability()` 在主线程/Worker 均有效、`createSharedMemory(initialPages,maxPages)` 构造 SAB-backed WebAssembly.Memory（失败时返回 undefined）、`selectWasmModule(single,threads?,cap?)` 按能力返回 `{module,threaded,sharedMemory}` 三元组。(2) `protocol.ts` HandshakeRequest 新增 `threadsWasmModule?:WebAssembly.Module` + `sharedMemory?:WebAssembly.Memory`；HandshakeAck 新增 `threadMode:"threaded"|"single"`。(3) `wasm.ts` WasmRuntimeOptions 新增 `sharedMemory?/spawnThread?/threadId?`；`createWasmRuntime` 在 sharedMemory 存在时将其注入 `wasmImports.env.memory`（threads wasm import_memory=true 必须），并将 spawnThread/threadId 透传给 JsiHost。(4) `kernel.ts` KernelOptions 新增 `threadsWasmModule?`；构造时检测能力并在握手消息中携带 threads 所需字段。(5) `kernel-worker.ts` 握手 handler：Worker 侧再次探测能力，threadsReady 时创建 `ThreadPool` + 以 threads 模块启动 wasm，否则回退到单线程路径（零额外配置），握手应答携带 `threadMode`。(6) 新建 `test/thread-capability.test.ts` — 13 例全通过（结构验证、条件组合、createSharedMemory、selectWasmModule 四路径、幂等性）。当前 **423/427 通过**（+13 新增，4 残留 stream 仍等待 wasm 重建）。|
| 2026-04-25 | claude | **Phase 5.5 推进 — T5.5.1 源级 + T5.5.2 host ThreadPool 落地**：(1) `build-wasm-smoke.zig` 新增 `build-wasm-threads` step —— 独立的 wasm32 target query（`cpu_features_add = {.atomics, .bulk_memory}`）+ `Executable.shared_memory=true` + `import_memory=true`，初始内存 16 MiB / 上限 256 MiB，产物 `packages/bun-browser/bun-core.threads.wasm` 与 `bun-core.wasm` 共存，host 按 `jsi_thread_capability()` 探测挑选；`single_threaded=true` 保留（Zig stdlib 非线程安全，并发由 JS 侧承担，`memory.atomic.wait32/notify` 是 wasm 指令不受影响）。源级完成，实际执行需 zig toolchain。(2) 新建 `packages/bun-browser/src/thread-pool.ts` —— `ThreadPool` 类：tid 单调分配（主=0、子≥1）、`maxThreads` 上限、`spawn/join/terminate/onExit/onError`、多消费者 join、terminate 释放 outstanding joiners；`threadPoolAvailable(memory)` 对 SAB + `memory.buffer instanceof SharedArrayBuffer` 双探测；协议 UI↔Worker 定义为 `thread:start/exit/error`，`kernel.ts` 后续只需把 `pool.spawn.bind(pool)` 注入 `JsiHostOptions.spawnThread`。(3) 新建 `test/thread-pool.test.ts` —— 14 例全通过（含 tid 单调、maxThreads 上限释放、postMessage 抛错路径、terminate 唤醒 join）。当前 **410/414 通过**（+14 新增，4 残留 stream 仍等待 wasm 重建）。|
| 2026-04-24 | claude | **Phase 5.5 T5.5.4（JSI ABI + host 基础设施）完成**：(1) Zig 侧 `src/jsi/imports.zig` 新增 5 个 import —— `jsi_atomic_wait(view_ptr,expected,timeout_ms)u32` / `jsi_atomic_notify(view_ptr,count)u32` / `jsi_thread_spawn(arg)u32` / `jsi_thread_self()u32` / `jsi_thread_capability()u32`；(2) TS host `packages/bun-browser/src/jsi-host.ts` 实现 5 个 imports + `JsiHostOptions.spawnThread`/`threadId` 钩子（由 kernel 注入，未注入时 `thread_spawn` 返回 0，`atomic_wait` 走 non-SAB fallback path）；(3) 新建 `src/sab-ring.ts` —— SPSC 字节 ring（SharedArrayBuffer-backed，32B header [head/tail/closed/waiters] + data，空/满消歧保留 1 字节，`write/read` wrap-around 正确，`readBlocking` 在 Worker 内真阻塞）；(4) 新建 `src/atomic-wait.ts` —— `Atomics.wait/waitAsync` 跨环境抽象（sync/async/fallback 三条路径 + `detectAtomicWait()` 能力探测）；(5) 新增 3 个测试文件共 **30 例**：`sab-ring.test.ts`(11)、`atomic-wait.test.ts`(8)、`jsi-host.test.ts` Phase 5.5 补充(8) —— 全通过。**同日修复两个 Phase 5.9 failing test**：(a) 修复 `node-builtins-extra.test.ts` 两处 sha256 期望值（原值 `...5dae2ec7...` 是编造的，与 FIPS 180-4 Appendix A.1 及 Bun/Node 内建 crypto 交叉验证后应为 `...5dae2223b00361a3...`，Zig 端 `_sha256` 一直正确）；(b) 修复 `STREAM_MODULE_SRC` 第 582 行附近，`Readable.prototype.on` override 实现 "`on('data',fn)` 自动 resume"（Node.js 标准语义），已用 `/tmp/stream-test.js` 独立验证 PassThrough/Transform/pipeline 三例全 PASS，待 wasm 重建后 4 个 stream 用例可通过。当前测试状态：**396/400 通过**（+30 新增 / -2 修复 / 4 残留 stream 等待 wasm 重建）。|
| 2026-04-24 | claude | **文档审计 — 与代码状态对齐**：(1) 新增 Phase 5.9 章节（`stream`/`crypto`/`os`/`zlib`/`http`/`https`/`child_process`/`worker_threads`/`process` 八个模块 polyfill，源码常量位于 `src/bun_browser_standalone.zig` 第 568–760 行区段，`requireFn` 与 `builtinPolyfillSource` 两条路径已接入，见第 1013–1040、2897–2902 行）；(2) 修正状态头：实测 **366/372 通过**（14 个测试文件），Phase 5.1–5.8 无回归；(3) 记录 6 个 Phase 5.9 已知失败（`test/node-builtins-extra.test.ts` 行 135/153/182/206/543/552）：stream PassThrough/Transform/pipeline 在 `write` 后 `data` 事件不触发（`Transform._write` → `_transform` → `push` 时非 flowing，首次 `on('data')` 未自动 resume）；crypto `sha256('abc')` 产出偏差（`Int32Array(64)` + `\|0` 导致中间量有符号溢出，需改为 `Uint32Array` + `>>>0`）；(4) T5.9.3/4/5/6/7/8 全通过（os/zlib/http/child_process/worker_threads/process 共 23/23）。|
| 2026-04-21 | — | 初稿 |
| 2026-04-21 | claude | Phase 5.1 全部完成：T5.1.1(path std.fs.path)、T5.1.2(hash/base64)、T5.1.3(inflate/deflate)、T5.1.4(url std.Uri)；wasm.ts 新增 8 个接口方法；192/192 测试通过 |
| 2026-04-22 | claude | Phase 5.2 原型完成：轻量 TS/JSX stripper `src/bun_wasm_transform.zig`、WASM ABI `bun_transform`、`wasm.ts` 新增 `transform()` 封装、bundler 内部接入 + 失败回退 `jsi_transpile`、新增 `transform.test.ts` |
| 2026-04-22 | claude | Phase 5.3a 手写 resolver 增强：package.json `main`/`module`/`exports["."]`(字符串 + 条件对象 browser/import/default/require)、`exports["./subpath"]` 字面匹配、scoped packages `@scope/name`、tsconfig `compilerOptions.paths` + `baseUrl` + `*` 通配符 + 向上查找，Bundler 内部统一走 `resolveModule`。新增 11 个 `resolver-bundler.test.ts` 用例。同时在 Phase 5.2 章节补充 T5.2.6 `js_parser`/`transpiler` WASM 化依赖面分析（阻塞项清单 + 建议路径） |
| 2026-04-22 | claude | Phase 5.3 续进：T5.3.1g exports 子路径通配符 `./features/* → ./dist/features/*.js`、T5.3.1h `tsconfig.extends` 继承链（递归加载父 tsconfig，最多 8 层，nearest-wins paths/baseUrl）。新增 2 个测试用例。 |
| 2026-04-22 | claude | T5.3.1i 完成：Node builtin 映射（`isNodeBuiltin`/`builtinVirtualPath`/`canonicalFromVirtualPath`/`builtinPolyfillSource`）；`bun_resolve` 与 `Bundler.resolveModule` 均优先走 builtin 路径，VFS 内同名包不会被误识别；`Bundler.addFile` 对 `<builtin:...>` 路径注入内联 polyfill（`path`/`url`/`util` 内联 JS，`fs`/`crypto`/`events`/`stream` globalThis.require delegate，其余 stub `{}`）。新增 9 个测试用例，**220/220 全通过**。 |
| 2026-04-22 | claude | Phase 5.2 + Zig 0.15.2 兼容性修复：(1) `transpileIfNeeded` 反转优先级——宿主 `jsi_transpile` 优先（完整 ESM→CJS），WASM 内置 stripper 降级兜底；(2) `bun_wasm_transform.zig` 修复 `skipWhitespace` 后丢失空白字符（`handleImportKeyword`/`handleExportKeyword`/`processIdentOrKeyword` 三处）；(3) 新增 `: Type` 冒号类型注解剥离（`processNormal` 增加 brace_depth 保护）；(4) 新增 `prevNonWhitespace`/`nextNonWhitespace` 辅助函数；(5) `scanDependencies` 新增 `import"x"` / `import'x'`（无空格）模式检测；(6) Bundle 输出每模块添加 `// <path>` 注释；(7) 测试侧 `lowerEsmToCjs` 正则 `\s+` → `\s*` 兼容 Bun transpiler 无空格输出。 |
| 2026-04-22 | claude | T5.3.3 完成：新增 `bun_bundle2(cfg_ptr, cfg_len) u64` WASM ABI，接受 JSON 配置（`entrypoint` 必填，`external[]` + `define{}` 可选）。Zig 侧新增 `Bundler.externals`/`Bundler.defines` 字段、`addExternalModule()` 合成模块（`globalThis.require` 委托）、`applyDefines()` 词边界文本替换（在转译前执行）；`wasm.ts` 新增 `BundleConfig` 接口 + `bundle2()` 方法；新增 5 个集成测试。**225/225 全部通过**。 |
| 2026-04-22 | claude | **T5.3.2（CSS passthrough）完成**：`transpileIfNeeded` 对 `.css` 输入产出 `document.createElement("style")` + `appendChild` 的 IIFE（DOM 可用时注入，否则 no-op）；`resolveRelative` 扩展名探测列表 + `classifyLoader` + VFS ModuleLoader 解析列表均加入 `.css`；新增 3 个 CSS bundle 测试。 |
| 2026-04-22 | claude | **Phase 5.7 T5.7.1（Bun.* API 全量）完成**：(1) JSI 层新增 `jsi_read_arraybuffer` + `jsi_arraybuffer_byteLength` import（`src/jsi/imports.zig` + `jsi-host.ts`）；(2) Zig 侧 6 个 HostFn：`bunFileReadFn`/`bunFileSizeFn`/`bunFileWriteFn`/`bunResolveSyncFn`/`bunGunzipSyncFn`/`bunTranspileCodeFn`，在 `setupGlobals` 注册为 `__bun_*` 临时全局；(3) `BUN_GLOBAL_SRC` 从 60 行扩展为 150 行完整 Bun 对象（serve + env/argv/main + sleep + inspect + file + write + resolveSync + gunzipSync + Transpiler + password/hash/deepEquals/deepMatch stub），IIFE 尾部 `delete globalThis.__bun_*` 清理临时 HostFn；(4) 新增测试文件 `bun-apis.test.ts`（32 个用例，覆盖全部新 API）。**257/257 全部通过**（较上轮 +32）。 |
| 2026-04-22 | claude | **Phase 5.4 T5.4.3（WASM 直写 VFS tar 提取）完成**：(1) `vfs.zig` `mkdirp` 改为 `pub fn`；(2) Zig 新增 `bun_tgz_extract(input_ptr, input_len) u64`（packed input：`[prefix_len:u32][prefix][tgz]`），内置 ustar/GNU long-name/PAX tar 解析器 + `inflateImpl` gzip 解压，直接调用 `vfs_g.mkdirp` + `vfs_g.writeFile`，返回 JSON `{"extracted":N}`；(3) `wasm.ts` 新增 `extractTgz(prefix, tgz): number|null` 方法；(4) `installer.ts` 优先走 WASM `extractTgz` 路径（直写 VFS，跳过 JS parseTar + buildSnapshot + loadSnapshot），回退到 JS inflate+parseTar；(5) `installer.test.ts` 新增 5 个集成测试。**262/262 全部通过**（较上轮 +5）。 |
| 2026-04-22 | claude | **Phase 5.4 T5.4.1（WASM npm metadata 解析 + 版本选择）完成**：(1) `semverSelect` 重构：提取 `semverSelectFromList(ver_list, range) ![]const u8` 辅助函数；(2) Zig 新增 `bun_npm_parse_metadata(jp,jl,rp,rl) u64`，内部 `std.json` 解析全量 npm registry metadata JSON，dist-tags / semver range / 精确版本 / 通配符全支持，返回 JSON `{version,tarball,integrity?,shasum?,dependencies{}}`；(3) `wasm.ts` 新增 `NpmResolvedVersion` 接口 + `parseNpmMetadata(json, range): NpmResolvedVersion|null`；(4) `installer.ts` 重构 `installOne`：优先走 WASM `parseNpmMetadata` 路径（fetchRawMetadata 返回原始文本，WASM 内部解析），回退到 TS semverSelect + chooseVersion；(5) 新增 6 个集成测试。**268/268 全部通过**（较上轮 +6）。 |
| 2026-04-23 | claude | **Phase 5.8（Node.js 内置模块 polyfill）全部完成**：新增 5 个高频内置模块的纯 JS 实现，以 Zig 字符串常量形式内嵌到 `src/bun_browser_standalone.zig`，同步更新 `requireFn`（运行时路径）和 `builtinPolyfillSource`（bundle 打包路径）：(1) T5.8.1 `events` — 完整 EventEmitter，含 on/once/off/emit/prependListener/prependOnceListener/removeAllListeners/listenerCount/inherits；(2) T5.8.2 `buffer` — Buffer class，支持 from(string/hex/base64/ArrayBuffer/Array)/alloc/allocUnsafe/concat/compare/isBuffer/byteLength + readUInt8/16/32 BE/LE + writeUInt8/16/32 BE/LE + toString(hex/base64/utf8) + copy/slice/indexOf/includes/equals/write；(3) T5.8.3 `assert` — 全套断言（ok/strictEqual/notStrictEqual/deepStrictEqual/notDeepStrictEqual/equal/throws/doesNotThrow/rejects/doesNotReject/match/doesNotMatch/ifError），AssertionError 继承 Error；(4) T5.8.4 `querystring` — parse/stringify/encode/decode，支持 `+` 空格、数组值、maxKeys 限制、自定义编解码器；(5) T5.8.5 `string_decoder` — StringDecoder（write/end），TextDecoder backed，支持 utf8/hex/base64/latin1。新增 26 个测试（T5.8.1×6 + T5.8.2×6 + T5.8.3×5 + T5.8.4×4 + T5.8.5×2 + bundle路径×3）。**329/329 全部通过**（较上轮 +26）。 |
| 2026-04-23 | claude | **T5.3.5 + T5.3.6 + T5.3.7 完成**：(1) T5.3.5 `import.meta` polyfill：`handleImportKeyword` 在 `skipWhitespace` 前检测 `.meta` 前缀，`emitImportMeta()` 方法将 `.url` → 文件名字符串、`.env` → `process.env` polyfill、`.resolve(` → `require.resolve(`、未知属性 → `{url,env}` 对象，非 ESM 模式下原样透传；(2) T5.3.6 动态 import：`import("spec")` → `Promise.resolve().then(function(){return require("spec")})`，静态小字符串则转换，非静态/非 ESM 模式则透传；(3) T5.3.7 `__filename`/`__dirname`：`Bundler.emit()` 每个模块包裹头部自动注入 `var __filename="<path>",__dirname="<dir>";`；新增 11 个测试（T5.3.5×5 + T5.3.6×3 + T5.3.7×3）。**303/303 全部通过**（较上轮 +11）。 |
| 2026-04-23 | claude | **T5.2.6 + T5.2.7 + T5.2.8 全部完成**：(1) T5.2.6 完整 ESM→CJS：`import default/named/namespace/side-effect/mixed` 全形式 → `require()`，`export default/const/function/class/named-re-export/*` 全形式 → `module.exports` + `exports_deferred`；修复 named import 后缺少 `skipWhitespace()` 的 bug；(2) T5.2.7 sourcemap v3 生成：`Stripper` 新增 `line_origins` 行追踪 + `vlqEncodeValue` VLQ 编码 + `generateSourcemap` JSON 构建，`TransformResult.map` 字段携带输出；`bun_transform` JSON ABI 新增 `source_map` 输入字段和 `map` 输出字段；`wasm.ts` `TransformOptions.sourceMap` + `TransformResult.map`；(3) T5.2.8 identity 检测：`transpileIfNeeded` 检测 host `jsi_transpile` 是否返回等同输入（identity 模式），是则 fallthrough 到 WASM 内置转译（`esm_to_cjs=true`），WASM 完全自含无 host 回调依赖；新增 11 个测试（T5.2.6×7 + T5.2.7×3 + T5.2.8×1）。**292/292 全部通过**（较上轮 +11）。 |
| 2026-04-22 | claude | **Phase 5.4 T5.4.2 + T5.4.4 + T5.4.5 + Phase 5.7 T5.7.2 + T5.7.3 全部完成**：(1) 修复 `src/bun_browser_standalone.zig` 中 6 处 Zig 0.15.2 兼容性错误（`orelse` 匿名 struct 类型推断、`std.ArrayList` → `std.ArrayListUnmanaged`、`deinit(allocator)` 参数、`append(allocator, ...)` 传参）及 1 处 use-after-free（BFS 传递依赖 `free(result_slice)` 移至 JSON 解析之后）；(2) T5.4.2 `bun_npm_resolve_graph`：WASM 内部 BFS 展平传递依赖图，去重，缺失包放入 `missing[]`；(3) T5.4.4 异步 fetch 协议：`bun_npm_install_begin`/`bun_npm_need_fetch`/`bun_npm_feed_response`/`bun_npm_install_mark_seen`/`bun_npm_install_result`/`bun_npm_install_end` 六个 export；(4) T5.4.5 `bun_lockfile_write`：将包列表序列化为 bun.lock JSON 格式；(5) T5.7.2 `bun_sourcemap_lookup`：内置 Base64-VLQ 解码器 + sourcemap v3 `mappings` 解析，返回原始行列 + source 文件名；(6) T5.7.3 `bun_html_rewrite`：简单字符扫描 HTML 重写器，支持 `tag`/`tag[attr]`/`tag[attr=val]` 选择器，set_attr/set_text/remove 操作；(7) `wasm.ts` 新增 8 个接口方法 + 4 个类型（`ResolveGraphResult`/`NpmFetchRequest`/`SourcemapPosition`/`HtmlRewriteRule`）；(8) `installer.test.ts` 新增 13 个测试用例。**281/281 全部通过**（较上轮 +13）。 |

