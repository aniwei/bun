# Bun WASM Browser Runtime — Phase 5 迭代计划

**状态**：Phase 5.1 已完成 ✅  
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

**时间盒**：2-3 周  
**目标**：消除对 Host `jsi_transpile` 的依赖，TS/JSX 在 WASM 内部真实转译。

**任务**：
- T5.2.1 把 `src/js_parser.zig` / `js_printer.zig` / `transpiler.zig` 编入 WASM
- T5.2.2 剥离 `Log` 对文件系统的依赖，`defines` / `runtime.js` 内联为 `@embedFile`
- T5.2.3 新 ABI `bun_transform(opts_ptr, opts_len) u64` —— JSON 输入，返回 `{code, map, errors}`
- T5.2.4 JSI 侧 `jsi_transpile` 改走 `bun_transform`；Host 回调缺省可移除
- T5.2.5 sourcemap 随错误堆栈返回

**验收**：
- TS / TSX / JSX 真实转译，输出等价于 CLI `bun build --target=browser`
- Host 侧不再需要注入 transpile callback
- 栈帧能反查回源

---

### Phase 5.3 — Resolver / Bundler 真身

**时间盒**：3-4 周  
**目标**：替换 `bun_browser_standalone.zig` 里手写的 80 行 ModuleLoader 与 300 行 bundler。

**任务**：
- T5.3.1 `src/resolver/*` WASM 化
  - package.json `exports` / `imports`
  - tsconfig `paths`
  - Node builtin 映射
- T5.3.2 `src/bundler/*` 最小子集
  - 单入口 IIFE + 多入口 ESM
  - CSS import 支持
  - code-splitting（二期）
- T5.3.3 新 ABI
  - `bun_resolve2(specifier, from, config_json) u64`
  - `bun_bundle2(config_json) u64`
- T5.3.4 保留旧 `bun_resolve` / `bun_bundle` 作为薄封装，直到测试迁移完毕

**验收**：
- `Bun.resolveSync` 能处理 monorepo、tsconfig paths、exports 条件
- `Bun.build` 输出含 sourcemap、tree-shake 后的 bundle

---

### Phase 5.4 — 真实 npm 协议

**时间盒**：2 周  
**目标**：TS 版 `installer.ts` 退化为薄 fetch 壳，版本解析/依赖图/lockfile 全在 Zig。

**任务**：
- T5.4.1 `src/install/npm.zig` manifest 解析接入 WASM
- T5.4.2 `src/install/dependency.zig` 版本图求解
- T5.4.3 `src/install/tarball.zig` 解压入 VFS（依赖 Phase 5.1 的 zlib）
- T5.4.4 Host ↔ WASM 异步 fetch 协议
  - WASM 暴露 `bun_npm_need_fetch() u64` → 返回 `{url, kind}` 或 null
  - Host `fetch` 完成后 `bun_npm_feed_response(req_id, data_ptr, data_len, status)` 回填
- T5.4.5 lockfile v2 读写（复用 `src/install/lockfile/*`）

**验收**：
- `installPackages()` 中的 `chooseVersion` / 依赖 BFS / integrity 全部委托 WASM
- 支持 `dependencies` + `peerDependencies` + `optionalDependencies`
- lockfile 能被 CLI Bun 读取验证

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

**时间盒**：2 周  
**目标**：Bun 对象表面积接近真实 runtime 的浏览器可用子集。

**任务**：
- T5.7.1 新增 Bun.* API
  - `Bun.file` / `Bun.write` / `Bun.glob` / `Bun.env` / `Bun.argv` / `Bun.main`
  - `Bun.inspect` / `Bun.which` / `Bun.resolveSync`
  - `Bun.password` / `Bun.gzipSync` / `Bun.gunzipSync`
  - `Bun.Transpiler`（复用 Phase 5.2 的 `bun_transform`）
- T5.7.2 `src/sourcemap/*` 栈帧还原
- T5.7.3 `HTMLRewriter` via `src/HTMLScanner.zig`

**验收**：
- `Bun` 全属性与 CLI Bun 的浏览器兼容子集一致
- 错误堆栈显示源文件位置（而非 transpile 后的 JS）

---

## 5. 新 ABI 汇总（Phase 5 全期）

```c
// Phase 5.1 ✅ 已实现
u64 bun_hash(u32 algo, u32 ptr, u32 len);
u64 bun_base64_encode(u32 ptr, u32 len);
u64 bun_base64_decode(u32 ptr, u32 len);
u64 bun_inflate(u32 ptr, u32 len, u32 format);   // 0=gzip, 1=zlib, 2=raw
u64 bun_deflate(u32 ptr, u32 len, u32 format);
u64 bun_path_normalize(u32 ptr, u32 len);
u64 bun_path_dirname(u32 ptr, u32 len);
u64 bun_path_join(u32 paths_ptr, u32 paths_len); // packed: [base_len:u32le][base][rel]
u64 bun_url_parse(u32 ptr, u32 len);             // → JSON {href,scheme,protocol,host,hostname,port,pathname,search,hash,auth}

// Phase 5.2
u64 bun_transform(u32 opts_ptr, u32 opts_len);

// Phase 5.3
u64 bun_resolve2(u32 spec_ptr, u32 spec_len,
                 u32 from_ptr, u32 from_len,
                 u32 cfg_ptr,  u32 cfg_len);
u64 bun_bundle2(u32 cfg_ptr, u32 cfg_len);

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
