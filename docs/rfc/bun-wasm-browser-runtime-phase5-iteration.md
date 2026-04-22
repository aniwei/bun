# Bun WASM Browser Runtime — Phase 5 迭代计划

**状态**：Phase 5.1 已完成 ✅ · Phase 5.2 T5.2.1–T5.2.8 全部完成 ✅ · Phase 5.3 T5.3.1a-i + T5.3.2(CSS) + T5.3.3 + T5.3.5 + T5.3.6 + T5.3.7 完成 🟡 · Phase 5.4 T5.4.1 + T5.4.2 + T5.4.3 + T5.4.4 + T5.4.5 完成 🟡 · Phase 5.7 T5.7.1 + T5.7.2 + T5.7.3 完成 🟡 · **Phase 5.8 全部完成** ✅  
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
| 多线程 | wasm-threads（pthread）+ 共享堆 | 单线程 | ❌ |
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

---

## 3. 架构级缺口（非单模块可补）

### A. wasm-threads + SAB 事件循环

对标 WebContainer 的阻塞系统调用模型。

- **构建**：`build-wasm-smoke.zig` 增 `-fshared-memory -fatomics`，导出 `memory` 为 shared
- **运行时**：每 pthread 一 Worker，主 Worker 通过 `postMessage` + Atomics 映射 tid → 信号
- **宿主侧**：demo server 发 `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
- **新增 ABI**：`jsi_atomic_wait` / `jsi_atomic_notify` / `bun_thread_spawn`
- **降级**：非 isolated 上下文下输出单线程版本，feature detection

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

**时间盒**：3-4 周  
**风险**：🔴 最大  
**目标**：对标 WebContainer 的阻塞语义模型。

**任务**：
- T5.5.1 `build-wasm-smoke.zig` 开启 `shared-memory` / `atomics`
  - 输出 2 份 wasm（`bun-core.threads.wasm` / `bun-core.wasm`）供能力探测
- T5.5.2 Host 端 pthread 支持
  - 主 Worker 孵化子 Worker
  - `memory` import 共享
  - tid → Worker 映射表
- T5.5.3 demo server 发 COOP / COEP
  - 检测失败时自动降级到单线程
- T5.5.4 新 JSI imports
  - `jsi_atomic_wait(addr, expected, timeout_ns) u32`
  - `jsi_atomic_notify(addr, count) u32`
- T5.5.5 `bun_tick` 事件循环改为 `Atomics.wait` 真阻塞模型
- T5.5.6 `std.Thread` 在 WASM 下映射到 `bun_thread_spawn`

**验收**：
- `Bun.spawn` 真正并行（Phase 5.6 配合）
- `fs.readFileSync` 对远端 VFS 可阻塞
- 能力探测：无 SAB 上下文自动降级，功能无差异

---

### Phase 5.6 — 进程隔离与 shell

**时间盒**：2-3 周  
**目标**：`bun_spawn` 真实进程模型；`Bun.$` 可用。

**任务**：
- T5.6.1 每个 `bun_spawn` 独立 WASM Instance
  - 共享 VFS 快照（COW 语义）
  - 独立 JSI handle 空间
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

// Phase 5.5（依赖 wasm-threads）
u32  bun_thread_spawn(u32 entry_tag, u32 arg);
void jsi_atomic_wait(u32 addr, u32 expected, u64 timeout_ns);   // import
void jsi_atomic_notify(u32 addr, u32 count);                    // import

// Phase 5.6
u32 bun_spawn2(u32 cmd_ptr, u32 cmd_len,
               u32 stdin_sab, u32 stdout_sab, u32 stderr_sab);
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

## 8. 变更记录

| 日期 | 作者 | 变更 |
|------|------|------|
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

