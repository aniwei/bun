# RFC: Bun WASM Browser Runtime — 技术设计文档

| 字段     | 值                              |
| -------- | ------------------------------- |
| 状态     | Draft                           |
| 作者     | —                               |
| 日期     | 2026-04-21                      |
| 关联仓库 | oven-sh/bun                     |
| 目标     | 将 Bun 核心编译为 WASM 运行在浏览器/Node.js 宿主中 |

---

## 1 背景与动机

### 1.1 目标

将 Bun 运行时的核心能力（transpiler、bundler、package manager、Node API 兼容层）编译为 WebAssembly，运行在浏览器标签页或 Node.js 进程中。**不集成 JavaScriptCore**——JS 执行委托给宿主 JS 引擎（浏览器原生 V8/SpiderMonkey/JSC 或 Node.js `vm` 模块），两者之间通过 JSI 风格的 C-ABI 桥接。

### 1.2 参考架构

| 参照项 | 借鉴点 |
|--------|--------|
| **WebContainers (StackBlitz)** | 浏览器内运行 Node 工具链的可行性验证；memfs、ServiceWorker 拦截、进程-Worker 映射、COOP/COEP 部署模式 |
| **React Native JSI** | 不序列化的跨语言值桥接——不透明句柄 + HostFunction 回调；双宿主（Hermes/JSC/V8）适配同一 C++ ABI |

### 1.3 非目标

- 把 JavaScriptCore 编译进 WASM（体积 > 50 MB，JIT 不可用）
- 100% Node.js API 兼容（首期只覆盖高频子集）
- 原生模块（`.node` / N-API）直通（浏览器环境无法执行原生二进制）
- `bun:ffi` / TinyCC JIT 支持（浏览器禁止 `PROT_EXEC`）

---

## 2 仓库现状分析（已验证）

### 2.1 已有 WASM 基础设施

| 组件 | 位置 | 状态 |
|------|------|------|
| WASM 入口 | `src/main_wasm.zig` | 导出 9 个函数：`init`, `transform`, `scan`, `getTests`, `bun_malloc`, `bun_free`, `cycleStart`, `cycleEnd`, `emsc_main`。仅覆盖 transpiler 场景 |
| JSC 空桩 | `src/jsc_stub.zig` | 定义 `C`, `WebCore`, `Jest`, `API.Transpiler`, `Node`, `VirtualMachine` 六个空 struct。仅够让 transpiler 编译通过 |
| 编译期标志 | `src/env.zig` L1-L16 | `BuildTarget.wasm`, `isWasm`, `isBrowser`, `isPosix` 等已定义，~20 处使用 |
| 构建分支 | `build.zig` L162, L778, L860 | wasm 目标跳过 `linkLibC/linkLibCpp`，选择 `stub_event_loop.zig` |
| 事件循环桩 | `src/async/stub_event_loop.zig` | 仅 3 行 opaque 类型声明（`Loop`, `KeepAlive`, `FilePoll`），无任何方法 |
| npm 包 | `packages/bun-wasm/` | TypeScript 胶水层 + 极简 WASI shim，API 面只有 `transform`, `scan`, `getTests` |

### 2.2 JSC 耦合深度（实测数据）

| 层级 | 文件数 | JSC 引用密度 | 耦合强度 |
|------|--------|-------------|---------|
| `src/bun.js/bindings/` | **1329** | 100% — 全部含 JSC FFI | 基石级 |
| `src/bun.js/event_loop/` | 17 | 100% — 调度器直接绑 JSC | 关键级 |
| `src/bun.js/node/` | 38 | 100% — Node API 包装器 | 很高 |
| `src/bun.js/api/` | 全部 | 100% — server/crypto/glob 等 | 很高 |
| `src/bundler/bundle_v2.zig` | 1 | L5047: `pub const EventLoop = bun.jsc.AnyEventLoop` | 高 |
| `src/install/install_binding.zig` | 1 | L2: `const JSValue = jsc.JSValue` | 高 |
| `src/bun.zig` (根) | 1 | L712: `pub const jsc = bun_js.jsc` — 唯一 wasm 分支在 L1060 | 核心 |
| `src/js_parser.zig` | 1 | **零引用** | 独立 |
| `src/Global.zig` | 1 | 仅 1 处 FSEvents | 极低 |

**关键量化**：需要替换或隔离的文件 > **1400**（bindings + event_loop + node + api），其中含大量 `extern fn` 直调 C++ 符号。

### 2.3 模块可移植性分类

#### ✅ 直接可移植（纯计算，零 JSC / 零系统调用）

```
js_parser.zig, js_lexer.zig, js_printer.zig, transpiler.zig
css/, sourcemap/, semver/, glob/, ini.zig, url.zig
base64/, sha.zig, hmac.zig, wyhash.zig, unicode/
string/, collections/, allocators/, comptime_string_map.zig
resolver/ (fs 后端需替换)
```

#### 🟡 需要后端替换（功能可复用，I/O 层需重写）

| 模块 | 阻断依赖 | 替代方案 |
|------|----------|---------|
| `bundler/` | `bun.jsc.AnyEventLoop` (L5047) | 提供 wasm-compat MiniEventLoop |
| `install/` 解析层 | `lockfile.zig`, `resolution.zig` 纯 Zig；`npm.zig` 用 `bun.http.AsyncHTTP` | 锁文件解析直接复用；registry fetch 走 JSI → `fetch` |
| `install/` 绑定层 | `install_binding.zig` 直接引用 `jsc.JSValue` | 需为 JSI 重写 |
| `shell/` | 依赖 `Process`/`Pipe`/`Signal` | 走虚拟进程表 + Worker |
| `fs/`, `sys/` | POSIX syscall | VFS + memfs |
| `http/` | uWS/libuv | JSI → `fetch` / WebSocket |
| `watcher/` | inotify/FSEvents/kqueue | memfs 事件总线 |

#### ❌ 放弃 / 不移植

```
vendor/WebKit (JSC)                → 不编译
src/bun.js/bindings/ (1329 文件)    → 用 JSI 桥替代
src/napi/, src/v8/                 → 首版不支持
src/bun.js/api/FFI.zig + tinycc   → 浏览器禁用
src/bake/ (SSR 框架)               → 可选，延期
所有 JIT / mmap(PROT_EXEC) / fork() / 原生线程池
```

### 2.4 Vendor C 库移植评估

| 库 | 可行性 | 备注 |
|----|--------|------|
| zlib-ng | ✅ | 纯 C 计算，zig-cc 可交叉 |
| zstd | ✅ | 同上 |
| brotli | ✅ | 同上（`BROTLI_EMSCRIPTEN: OFF` 当前显式关闭，需打开或用 zig-cc） |
| libdeflate | ✅ | 同上 |
| picohttpparser | ✅ | < 2K 行纯 C |
| lshpack | ✅ | HTTP/2 HPACK 纯计算 |
| libarchive | 🟡 | 需去掉 lzma 和系统 I/O 后端，用 VFS 适配 |
| boringssl | 🟡 | 哈希/HMAC 可编译；TLS (`SSL_*`) 不需要（浏览器原生处理） |
| mimalloc | ❌ | 依赖 `mmap`/`VirtualAlloc`；换 Zig GPA 或 `wee_alloc` |
| libuv | ❌ | 不编译 |
| tinycc | ❌ | 不编译  |
| WebKit | ❌ | 不编译 |
| c-ares | ❌ | 不需要（浏览器原生 DNS） |

**构建链缺口**：`scripts/build/config.ts` L20 的 `OS` 类型只有 `"linux" | "darwin" | "windows"`，无 wasm。`scripts/build/deps/` 下无任何 vendor 有 wasm 构建配置。需要新增 wasm 构建 profile。

---

## 3 总体架构

```
┌──────────────────────────── 浏览器 Tab ─────────────────────────────┐
│                                                                     │
│  ┌── 主线程 (UI) ────────┐    ┌───── Bun Kernel Worker ──────────┐  │
│  │  @aspect/bun-browser  │    │                                  │  │
│  │  · mount(files)       │    │  ┌──────────────────────────┐    │  │
│  │  · spawn(cmd, opts)   │◄──►│  │ bun-core.wasm (Zig→W32) │    │  │
│  │  · on('exit', cb)     │    │  │  ├ transpiler             │    │  │
│  │  · fs.writeFile()     │    │  │  ├ bundler (wasm evloop)  │    │  │
│  └────────▲──────────────┘    │  │  ├ installer (resolver)   │    │  │
│           │ MessageChannel    │  │  ├ shell interpreter       │    │  │
│           │ + Transferable    │  │  ├ VFS (memfs)             │    │  │
│           ▼                   │  │  ├ compression (zlib/zstd) │    │  │
│  ┌──────────────────────┐    │  │  └ jsi_bridge (C-ABI)      │    │  │
│  │  Service Worker      │    │  └────────────┬───────────────┘    │  │
│  │  · 拦截 localhost:*  │    │               │ WASM imports      │  │
│  │  · 注入 COOP/COEP   │    │               ▼                    │  │
│  │  · 静态资源缓存     │    │  ┌──────────────────────────┐      │  │
│  └──────────────────────┘    │  │ JS Host Adapter (TS)     │      │  │
│                               │  │  · 实现 JSI import 表    │      │  │
│                               │  │  · 管理 HostValue 句柄表 │      │  │
│                               │  │  · eval/compileMod 桥    │      │  │
│                               │  └──────────────────────────┘      │  │
│                               └────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

### 3.1 数据流

```
用户代码 (TS/JSX)
    │
    │  ① mount → VFS 写入
    ▼
bun-core.wasm: transpile + resolve + bundle
    │
    │  ② jsi_eval(bundled_js) → 宿主引擎执行
    ▼
Host JS Engine (V8/SM/JSC)
    │
    │  ③ 用户代码调 require("fs") →
    │     宿主侧 polyfill 调 jsi_dispatch_host_fn →
    │     WASM VFS 读写
    ▼
结果返回用户代码
```

---

## 4 JSI 桥接层设计

### 4.1 设计原则

借鉴 React Native JSI 核心思想：

1. **不序列化**：跨边界传递的是不透明句柄，不是 JSON
2. **双向回调**：WASM 可调宿主函数，宿主也可调 WASM 注册的 HostFunction
3. **引用计数**：宿主侧维护 `HostValue` 句柄表（WeakRef + FinalizationRegistry 辅助）
4. **双宿主**：同一 `bun-core.wasm` 可在浏览器和 Node.js 中运行，只换 Host Adapter

### 4.2 ABI 定义

#### 4.2.1 HostValue 句柄

```
类型: u32（WASM i32）
含义: 宿主侧 handleTable[id] 的索引
特殊值:
  0 = undefined
  1 = null
  2 = true
  3 = false
  4 = globalThis
```

当 `externref` WASM proposal 可用时，可直接传递 JS 引用，省去句柄表查找。

#### 4.2.2 WASM Imports（Host 提供）

```c
// ── 值生命周期 ──
u32  jsi_retain(u32 handle);                    // 引用 +1
void jsi_release(u32 handle);                   // 引用 -1, 归零时删除

// ── 值构造 ──
u32  jsi_make_number(f64 value);
u32  jsi_make_string(u32 ptr, u32 len);         // 从 WASM memory 读 UTF-8
u32  jsi_make_object();
u32  jsi_make_array(u32 length);
u32  jsi_make_arraybuffer(u32 ptr, u32 len, u32 copy);
u32  jsi_make_error(u32 msg_ptr, u32 msg_len);

// ── 类型查询 ──
u32  jsi_typeof(u32 handle);                    // 返回 TypeTag enum
f64  jsi_to_number(u32 handle);
u32  jsi_to_string(u32 handle);                 // 返回新字符串 handle
u32  jsi_to_boolean(u32 handle);
void jsi_string_read(u32 handle, u32 buf_ptr, u32 buf_len); // 写入 WASM memory

// ── 属性访问 ──
u32  jsi_get_prop(u32 obj, u32 name_ptr, u32 name_len);
void jsi_set_prop(u32 obj, u32 name_ptr, u32 name_len, u32 val);
u32  jsi_get_index(u32 arr, u32 index);
void jsi_set_index(u32 arr, u32 index, u32 val);
u32  jsi_has_prop(u32 obj, u32 name_ptr, u32 name_len);

// ── 调用 ──
u32  jsi_call(u32 fn, u32 this_, u32 argv_ptr, u32 argc);
u32  jsi_new(u32 ctor, u32 argv_ptr, u32 argc);

// ── HostFunction 注册 ──
u32  jsi_make_host_function(u32 tag, u32 name_ptr, u32 name_len, u32 argc);

// ── Promise ──
u32  jsi_make_promise();                        // 返回 [promise_handle, resolver_tag]
void jsi_resolve(u32 promise, u32 value);
void jsi_reject(u32 promise, u32 value);

// ── 脚本执行 ──
u32  jsi_eval(u32 code_ptr, u32 code_len, u32 url_ptr, u32 url_len);
u32  jsi_eval_module(u32 code_ptr, u32 code_len, u32 url_ptr, u32 url_len);
```

#### 4.2.3 WASM Exports（WASM 提供）

```c
// ── 初始化 ──
u32  bun_init(u32 config_ptr, u32 config_len);  // JSON 配置

// ── 事件循环 ──
u32  bun_tick();                                 // 推进事件循环, 返回下次 timeout(ms); 0=idle
void bun_wakeup();                               // 外部事件到达时通知

// ── 进程管理 ──
u32  bun_spawn(u32 cmd_ptr, u32 cmd_len);        // 返回 pid
void bun_feed_stdin(u32 pid, u32 ptr, u32 len);
void bun_close_stdin(u32 pid);
void bun_kill(u32 pid, u32 signal);

// ── JSI 回调入口 ──
u32  jsi_dispatch_host_fn(u32 tag, u32 argv_ptr, u32 argc); // host function 被调时进入 Zig
void jsi_dispatch_finalizer(u32 tag);            // handle 释放通知

// ── 直通能力 (Phase 1 即有) ──
u64  bun_transform(u64 opts);                    // 现有 transpiler
u64  bun_scan(u64 opts);
u64  bun_resolve(u32 specifier_ptr, u32 len, u32 from_ptr, u32 from_len);
u64  bun_bundle(u32 config_ptr, u32 config_len);

// ── 内存 ──
u32  bun_malloc(u32 size);
void bun_free(u32 ptr, u32 len);
```

### 4.3 Zig 侧 JSI 运行时抽象

```
src/jsi/
  ├── runtime.zig        # Runtime 结构体：持有 globalThis handle, 提供所有 JSI 操作
  ├── value.zig          # Value = u32 (HostValue handle); 引用计数辅助
  ├── host_function.zig  # HostFunction 注册表 (tag → fn pointer)
  ├── imports.zig        # 所有 @extern 声明, 对接 jsi-host.ts
  ├── promise.zig        # Promise 辅助 (make, resolve, reject)
  └── module.zig         # ESM module 图管理 (jsi_eval_module 调度)
```

核心类型映射（与 JSC 的差异）：

| JSC 类型 | JSI 替代 | 说明 |
|----------|---------|------|
| `JSValue` (enum(i64), NaN-boxed) | `jsi.Value` (u32 handle) | 不再是内联值，是宿主侧引用 |
| `*JSGlobalObject` | `*jsi.Runtime` | 持有 globalThis 句柄 + import 函数表 |
| `*JSC.VM` | `*jsi.Runtime` | 合并——wasm 下不需要区分 VM 和 GlobalObject |
| `JSC.JSFunction.create(...)` | `jsi.Runtime.createHostFunction(...)` | 通过 tag 注册 Zig 回调 |
| `JSValue.toSlice(globalObject)` | `jsi.Runtime.toString(value) → []const u8` | 数据拷贝到 WASM memory |
| `JSC.JSPromise` | `jsi.Promise` | 通过 `jsi_make_promise` / `jsi_resolve` |

### 4.4 性能设计

WASM ↔ Host 边界调用比 RN JSI（同进程 C++ 指针）慢约 10-50x。关键缓解手段：

| 策略 | 机制 |
|------|------|
| **批量参数** | `jsi_call` 的 `argv` 指向 WASM memory 中的 handle 数组，一次传递多个参数 |
| **SharedArrayBuffer 直通** | Buffer / TypedArray 数据不跨边界拷贝，共享同一块 SAB |
| **热路径合并** | `fs.readFileSync` 不拆成 open+read+close 三次 JSI 调用，直接在 WASM 内 VFS 完成，只在返回时做一次 `jsi_make_arraybuffer` |
| **字符串内部化** | 高频属性名 (`"length"`, `"toString"`, ...) 预注册为常量 handle，避免重复 `jsi_make_string` |
| **惰性桥接** | VFS、compression 等纯 WASM 路径不经过 JSI，只在真正需要宿主 JS 能力时才跨边界 |

---

## 5 虚拟操作系统层

### 5.1 VFS（虚拟文件系统）

```
┌─────────────────────────────────────┐
│              VFS API                │  ← src/sys_wasm/vfs.zig
│  open / read / write / stat / ...  │
├─────────────────────────────────────┤
│  Overlay FS                        │
│  ┌─────────┐ ┌─────────┐ ┌──────┐ │
│  │ L0:     │ │ L1:     │ │ L2:  │ │
│  │ Readonly│ │ User    │ │ Tmp  │ │
│  │ Snapshot│ │ Mount   │ │ Write│ │
│  │(builtins│ │ (mount) │ │(/tmp)│ │
│  │ node_m) │ │         │ │      │ │
│  └─────────┘ └─────────┘ └──────┘ │
├─────────────────────────────────────┤
│  Storage Backend                   │
│  · WASM Memory (权威)             │
│  · IndexedDB / OPFS (持久化)      │
│  · SharedArrayBuffer (跨 Worker)  │
└─────────────────────────────────────┘
```

**数据结构**：Zig 中的 inode 表 + 目录树。

```zig
// src/sys_wasm/vfs.zig (骨架)
pub const Inode = struct {
    id: u64,
    kind: enum { file, directory, symlink },
    data: union { inline_buf: []u8, external_ref: u32 },
    mode: u16,
    size: u64,
    mtime_ms: u64,
    children: ?*DirectoryEntries,
};
```

**与现有代码对接**：`src/sys.zig` 和 `src/fs.zig` 在 `comptime Environment.isWasm` 分支下选择 `sys_wasm/vfs.zig` 作为后端。

### 5.2 进程模型

```
                    Bun Kernel Worker
                    ┌──────────────────────────┐
                    │  ProcessTable             │
                    │  ┌────┬────┬────┬────┐   │
                    │  │PID1│PID2│PID3│... │   │
                    │  └──┬─┴──┬─┴──┬─┴────┘   │
                    │     │    │    │           │
                    │     ▼    │    ▼           │
                    │  [inline]│ [Worker]       │
                    │  同Worker│ 新Worker+wasm  │
                    │  JSI eval│                │
                    └──────────┴────────────────┘
```

两级调度：
- **内联进程**：纯 JS/TS 脚本在当前 Worker 的独立 Realm 中 `jsi_eval`
- **隔离进程**：`Bun.spawn(["node", ...])` → 派生新 Worker，加载同一份 `bun-core.wasm` + 共享 VFS（通过 SAB）

进程间通信：
- stdio → `MessageChannel` + `Transferable ArrayBuffer`
- 信号 → 结构化消息 `{ type: "signal", pid, signal }`
- 退出 → `{ type: "exit", pid, code }`

### 5.3 网络层

| 场景 | 实现 |
|------|------|
| 出站 HTTP (`fetch`, `npm install`) | JSI → 宿主 `fetch()`。浏览器环境需 CORS-friendly 镜像或代理 |
| 出站 WebSocket | JSI → 宿主 `new WebSocket()` |
| 入站 HTTP (`Bun.serve`) | ServiceWorker 注册路由表 → `fetch` 事件拦截 → postMessage → Kernel Worker 内路由 → 通过 JSI 返回 Response |
| TCP/UDP 原始套接字 | 首版不支持；可通过 WebTransport 后续扩展 |

### 5.4 事件循环

现有 `src/async/stub_event_loop.zig` 只有 3 个 opaque 类型，需要实现完整的 wasm 事件循环：

```zig
// src/async/wasm_event_loop.zig (新文件)
pub const Loop = struct {
    timer_queue: TimerHeap,        // 最小堆管理 setTimeout/setInterval
    microtask_queue: TaskQueue,    // Promise microtask
    io_pending: TaskQueue,         // 等待宿主回调的 I/O 任务
    idle: bool,

    pub fn tick(self: *Loop) u32 {  // 返回下次 timeout ms
        self.drainMicrotasks();
        self.processTimers();
        self.processIOCallbacks();
        return self.nextTimerDeadline();
    }
};
```

宿主侧驱动方式：

```typescript
// packages/bun-browser/src/kernel.ts
function runLoop() {
  const nextMs = wasm.exports.bun_tick();
  if (nextMs > 0) {
    setTimeout(runLoop, nextMs);
  }
  // IO 回调由 jsi_dispatch_host_fn 异步触发 wakeup
}
```

---

## 6 构建系统改造

### 6.1 build.zig 新增 Profile

```zig
pub const WasmProfile = enum {
    transpiler_only,    // 现有行为
    browser_runtime,    // 新：完整运行时
};
```

`browser_runtime` 启用的模块集：

```
✅ js_parser, js_lexer, js_printer, transpiler
✅ resolver (VFS 后端)
✅ bundler (wasm_event_loop)
✅ install (纯解析层: lockfile, resolution, dependency)
✅ shell (解释器, 无 fork)
✅ css, sourcemap, semver, glob
✅ jsi/ (新)
✅ sys_wasm/ (新: vfs, proc, net)
✅ async/wasm_event_loop.zig (新)
✅ vendor: zlib-ng, zstd, brotli, libdeflate, picohttpparser, lshpack
🟡 vendor: libarchive (去 I/O 后端), boringssl (仅 hash 子集)
❌ bun.js/bindings/, bun.js/event_loop/, napi/, v8/
❌ vendor: WebKit, libuv, tinycc, c-ares, mimalloc
```

### 6.2 Vendor 构建链扩展

`scripts/build/config.ts` 需要扩展：

```typescript
export type OS = "linux" | "darwin" | "windows" | "wasm";
```

每个可编译 vendor 需增加 wasm 配置：

```typescript
// scripts/build/deps/zlib.ts 增加
if (cfg.os === "wasm") {
  spec.args.ZLIB_TARGET = "wasm32";
  // 使用 zig cc 作为 C 编译器
}
```

### 6.3 产物

```
dist/
  bun-core.wasm          # ~6-10 MB (ReleaseSmall + wasm-opt -Oz)
  bun-core.wasm.gz       # ~2-3 MB
  bun-browser.js         # Host Adapter + SDK (ESM)
  bun-browser.d.ts       # TypeScript 声明
  bun-sw.js              # ServiceWorker
```

---

## 7 公共 API 设计

### 7.1 SDK API（`@aspect/bun-browser`）

```typescript
import { BunKernel } from "@aspect/bun-browser";

// 初始化
const kernel = await BunKernel.boot({
  wasmUrl: "/bun-core.wasm",       // 或 CDN URL
  fsSnapshot?: ArrayBuffer,         // 预加载文件系统快照
  registryProxy?: string,           // npm registry CORS 代理
  serviceWorkerUrl?: "/bun-sw.js",
  sharedArrayBuffer?: boolean,      // 默认 true（需 COOP/COEP）
});

// 文件系统操作
await kernel.fs.writeFile("/app/index.ts", `console.log("hello")`);
await kernel.fs.mkdir("/app/src");
const content = await kernel.fs.readFile("/app/package.json", "utf-8");

// 运行命令
const proc = await kernel.spawn("bun", ["run", "index.ts"], {
  cwd: "/app",
  env: { NODE_ENV: "development" },
});

proc.stdout.on("data", (chunk: Uint8Array) => { ... });
proc.stderr.on("data", (chunk: Uint8Array) => { ... });
const exitCode = await proc.exit;

// Bun.serve() 预览
kernel.on("server:listening", ({ port, url }) => {
  iframe.src = url;  // ServiceWorker 拦截 → 内部路由
});

// 销毁
await kernel.terminate();
```

### 7.2 Node.js 宿主模式

同一份 `bun-core.wasm`，换 Node 适配器：

```typescript
import { BunKernel } from "@aspect/bun-node";

const kernel = await BunKernel.boot({
  wasmPath: "./bun-core.wasm",
  fs: "native",                    // 使用真实 fs 而非 memfs
  hostRuntime: "node",             // JSI 通过 vm.Context 实现
});
```

---

## 8 安全模型

| 维度 | 保障 |
|------|------|
| 代码执行隔离 | WASM 沙箱 + Worker 隔离，与 WebContainer 同级 |
| 文件系统 | VFS 在 WASM Memory 内，无法访问宿主文件系统 |
| 网络 | 所有出站请求通过宿主 `fetch()`，遵循浏览器 CORS 策略 |
| 用户代码 | 通过 `jsi_eval` 在宿主 JS 引擎中执行，受 CSP 约束 |
| 内存安全 | Zig 编译时内存安全 + WASM 线性内存边界检查 |
| 供应链 | npm registry 请求走 HTTPS（宿主 TLS）；tarball 完整性由 lockfile sha 验证 |

**已知限制**：
- `jsi_eval` 等价于 `eval()`，需要 CSP 允许 `unsafe-eval`（与 WebContainer 相同）
- SharedArrayBuffer 需要 COOP/COEP 头——通过 ServiceWorker 注入

---

## 9 已知风险

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| JSI 跨边界开销导致性能退化 | 高 | 批量调用、SAB 直通、VFS 热路径不跨界 |
| WASM Memory 上限 (2-4 GB) | 中 | 大型 node_modules 使用流式解压 + 惰性加载 |
| `asyncify` 体积膨胀 | 中 | 优先用显式 CPS；asyncify 仅兜底 sync API |
| COOP/COEP 部署门槛 | 中 | ServiceWorker 注入；文档明确要求 |
| `eval()` 与 CSP 冲突 | 中 | 提供 `trusted-types` 支持；文档说明 |
| 浏览器兼容性 | 低 | 需要：WASM、Worker、SAB、ServiceWorker（Chrome 90+, Firefox 79+, Safari 15.2+） |

---

## 10 与同类产品对比

| 维度 | 本方案 | WebContainer | wasm-node |
|------|--------|-------------|-----------|
| JS 引擎 | 宿主原生 | 宿主原生 | WASM 编译的 QuickJS |
| 性能 | 宿主引擎全速 + WASM 开销 | 宿主引擎全速 + 私有 VM 开销 | 慢（解释执行） |
| 产物体积 | ~3 MB gzip | ~15 MB (估) | ~1 MB |
| API 兼容度 | Bun API 子集 + Node 子集 | Node 大子集 | Node 小子集 |
| 开源 | ✅ | ❌ (私有) | ✅ |
| 双宿主 (浏览器+Node) | ✅ | ❌ (仅浏览器) | ✅ |
| bundler 内置 | ✅ | ❌ (需装 webpack/vite) | ❌ |
| package manager 内置 | ✅ | npm/yarn/pnpm | ❌ |
