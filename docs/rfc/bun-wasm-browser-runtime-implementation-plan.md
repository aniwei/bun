# Bun WASM Browser Runtime — 实施计划

| 字段     | 值              |
| -------- | --------------- |
| 关联 RFC | bun-wasm-browser-runtime-technical-design.md |
| 日期     | 2026-04-21      |
| 状态     | Draft           |

---

## 1 总述

本文档是 RFC 技术设计的配套实施计划。按照"最小可验证切片"原则，将整个工程拆分为 6 个 Phase，每个 Phase 有明确的：

- **交付物**（可演示/可测试的产出）
- **验收准则**（怎样算完成）
- **依赖关系**（前置 Phase 与外部依赖）
- **子任务清单**（可分配的原子工作项）

Phase 之间遵循严格串行依赖——**后一个 Phase 的开工以前一个 Phase 的验收通过为前提**。Phase 内部的子任务可以并行。

---

## 2 Phase 总览

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5
基础设施     扩展       JSI 最小     Bun.serve   npm install  性能/兼容
& 重构      transpiler  运行时      + 预览      + 完整生态
```

| Phase | 代号 | 核心交付 | 验收标准 |
|-------|------|---------|---------|
| 0 | **Scaffold** | 构建系统 + JSI 骨架 + VFS 骨架 | `zig build -Dtarget=wasm32-freestanding -Dwasm_profile=browser_runtime` 编译通过 |
| 1 | **Transpile+** | 浏览器内 transpile + bundle + lockfile parse | 在浏览器演示页中转译 TS 文件并显示输出 |
| 2 | **EvalMin** | 浏览器内执行简单 JS 脚本 + 基础 Node API | `console.log("hi")` + `fs.readFileSync` + `fetch` 在浏览器跑通 |
| 3 | **Serve** | `Bun.serve()` + ServiceWorker 预览 | 浏览器 iframe 打开 localhost 预览页面 |
| 4 | **Install** | `bun install` 浏览器跑通 | 浏览器中 `bun install` 一个 vite 项目并 `bun run dev` |
| 5 | **Polish** | 性能优化 + Node API 扩展 + 稳定性 | benchmark 达标 + CI 通过 |

---

## 3 Phase 0 — Scaffold（基础设施与重构）

### 3.1 目标

搭建 wasm browser-runtime 编译管线，使项目在 `wasm32-freestanding` 目标下能编译出一个空壳 `.wasm` 文件。

### 3.2 子任务

#### T0.1 — build.zig 增加 `WasmProfile`

**文件**：`build.zig`

- 新增 build option: `-Dwasm_profile=transpiler_only|browser_runtime`
- 当 `browser_runtime` 时：
  - 启用 `src/jsi/` 模块
  - 启用 `src/sys_wasm/` 模块
  - 选择 `src/async/wasm_event_loop.zig` 而非 `stub_event_loop.zig`
  - 跳过 `bun.js/bindings/`、`bun.js/event_loop/`、`napi/`、`v8/`
  - 跳过 vendor: WebKit、libuv、tinycc、c-ares、mimalloc

**验收**：`zig build -Dtarget=wasm32-freestanding -Dwasm_profile=browser_runtime` 不报错

#### T0.2 — 扩展 `jsc_stub.zig` → `src/jsi/`

**新建文件**：

```
src/jsi/
  runtime.zig        # jsi.Runtime 核心结构体（空壳，仅类型定义）
  value.zig          # jsi.Value = u32, 基本操作原型
  imports.zig        # 所有 WASM import 的 @extern 声明（空实现）
  host_function.zig  # HostFunction tag→callback 注册表
  promise.zig        # Promise 工具函数
  module.zig         # ESM module 管理
```

**关键决策**：

- `jsi.Value` 为 `u32` (handle id)，**不是** JSC 的 NaN-boxed `i64`
- `jsi.Runtime` 持有 `globalThis: Value` + 一组 `@extern fn` 指针
- 所有 `@extern` 函数在 Zig 侧声明但由 Host(TS) 侧实现

**验收**：`src/jsi/runtime.zig` 能被 `src/main_wasm.zig` 导入并编译

#### T0.3 — 创建 `src/sys_wasm/` VFS 骨架

**新建文件**：

```
src/sys_wasm/
  vfs.zig            # Inode 表 + 目录树 + 基本 CRUD
  proc.zig           # ProcessTable 空壳
  net.zig            # 网络 stub (全部返回 ENOSYS)
```

**接口对齐**：`vfs.zig` 需要实现 `src/sys.zig` 中 wasm 分支引用的文件操作签名：

```zig
pub fn open(path: []const u8, flags: u32, mode: u32) !fd_t { ... }
pub fn read(fd: fd_t, buf: []u8) !usize { ... }
pub fn write(fd: fd_t, data: []const u8) !usize { ... }
pub fn close(fd: fd_t) void { ... }
pub fn stat(path: []const u8) !Stat { ... }
pub fn mkdir(path: []const u8, mode: u32) !void { ... }
pub fn readdir(path: []const u8) ![]DirEntry { ... }
```

**验收**：在 Main 中调用 `vfs.mkdir("/tmp")` + `vfs.open("/tmp/a.txt")` + `vfs.write(...)` + `vfs.read(...)` 能在 WASM 中通过单元测试

#### T0.4 — 创建 `src/async/wasm_event_loop.zig`

**替代**：`stub_event_loop.zig` 的 opaque 类型

须实现的最小接口：

```zig
pub const Loop = struct {
    pub fn init(allocator: Allocator) Loop { ... }
    pub fn tick(self: *Loop) u32 { ... }  // ms until next timer; 0=idle
    pub fn addTimer(self: *Loop, deadline_ms: u64, callback: TaskCallback) void { ... }
    pub fn addTask(self: *Loop, task: Task) void { ... }
};

pub const KeepAlive = struct {
    ref_count: u32 = 0,
    pub fn ref(self: *KeepAlive) void { ... }
    pub fn unref(self: *KeepAlive) void { ... }
};

pub const FilePoll = struct {
    // wasm 下无真 fd poll, 做 stub + 回调注册
};
```

**验收**：timer 注册 → tick() → callback 触发的循环在 WASM 内通过测试

#### T0.5 — bun.zig 根模块 wasm 隔离

**文件**：`src/bun.zig`

在 wasm 编译时屏蔽所有 JSC 相关导出：

```zig
pub const jsc = if (comptime Environment.isWasm)
    @import("jsi/runtime.zig")         // JSI 替代
else
    bun_js.jsc;                        // 原 JSC
```

同理处理其他需要条件编译的路径（约 5-10 处）。

**验收**：wasm 编译不再尝试解析 `src/bun.js/bindings/` 下任何文件

#### T0.6 — scripts/build 增加 wasm target

**文件**：`scripts/build/config.ts`

```typescript
export type OS = "linux" | "darwin" | "windows" | "wasm";
```

为可编译的 vendor 库（zlib-ng, zstd, brotli, libdeflate, picohttpparser, lshpack）增加 wasm 构建配置。

**验收**：`bun run build --target wasm32-freestanding --wasm-profile browser_runtime` 能产出 `.wasm` 文件

### 3.3 Phase 0 验收检查表

- [ ] `zig build` wasm 目标编译通过
- [ ] 产出的 `.wasm` 文件可被浏览器 `WebAssembly.instantiate` 加载
- [ ] VFS 基本操作单元测试通过
- [ ] wasm_event_loop timer 单元测试通过
- [ ] 不引入任何 JSC/WebKit 符号（`wasm-objdump -x` 检查 import section 无 JSC 符号）

---

## 4 Phase 1 — Transpile+（扩展 Transpiler）

### 4.1 目标

在浏览器中不仅能 transform 单个文件，还能 resolve 模块图 + bundle + 解析 lockfile。

### 4.2 前置条件

- Phase 0 全部验收通过

### 4.3 子任务

#### T1.1 — 扩展 `main_wasm.zig` 导出

在现有 `transform`, `scan`, `getTests` 基础上增加：

```zig
export fn bun_resolve(specifier_ptr: u32, specifier_len: u32, from_ptr: u32, from_len: u32) u64 { ... }
export fn bun_bundle(config_ptr: u32, config_len: u32) u64 { ... }
export fn bun_lockfile_parse(lockfile_ptr: u32, lockfile_len: u32) u64 { ... }
```

**`bun_resolve`**：
- 使用 `src/resolver/` 的解析逻辑
- fs 后端切到 VFS（Phase 0 T0.3）
- 输入：specifier + importerPath；输出：resolvedPath + loader

**`bun_bundle`**：
- 使用 `src/bundler/` 的打包逻辑
- EventLoop 使用 `wasm_event_loop`（Phase 0 T0.4）
- 输入：入口文件路径 + config JSON；输出：bundled JS string

**`bun_lockfile_parse`**：
- 使用 `src/install/lockfile.zig` 纯解析
- 输入：lockfile 二进制；输出：JSON

**难点**：bundler 核心 (`bundle_v2.zig` L5047) 硬编码 `bun.jsc.AnyEventLoop`。需要：
1. 让 `bun.jsc` 在 wasm 下解析为 JSI 模块
2. JSI 模块导出一个兼容 `AnyEventLoop` 接口的类型
3. 或引入 `BundlerEventLoop = if (comptime isWasm) WasmEventLoop else bun.jsc.AnyEventLoop`

#### T1.2 — VFS 预加载协议

设计 VFS snapshot 二进制格式，支持从 Host 侧一次性写入完整文件树：

```typescript
// 格式: [u32 file_count] [Entry...]
// Entry: [u32 path_len] [u8[] path] [u32 data_len] [u8[] data] [u16 mode]

// Host 侧
const snapshot = encodeSnapshot({
  "package.json": '{"name":"demo"}',
  "index.ts": 'console.log("hello")',
  "tsconfig.json": '{...}',
});
wasm.exports.bun_vfs_load_snapshot(snapshotPtr, snapshotLen);
```

#### T1.3 — packages/bun-browser 初版

```
packages/bun-browser/
  src/
    index.ts           # BunKernel 类 (boot, terminate)
    kernel-worker.ts   # Worker 内部: WASM 加载 + 消息协议
    jsi-host-stub.ts   # JSI import 最小实现 (只有 console + 内存)
    vfs-client.ts      # 主线程 ↔ Worker 的 VFS 操作代理
    protocol.ts        # MessageChannel 消息类型定义
  package.json
  tsconfig.json
  rollup.config.ts
```

#### T1.4 — 演示页面

```html
<!-- packages/bun-browser/demo/index.html -->
<textarea id="input">const x: number = 42; console.log(x);</textarea>
<button id="transform">Transform</button>
<button id="bundle">Bundle</button>
<pre id="output"></pre>
<script type="module">
  import { BunKernel } from "../dist/index.js";
  const kernel = await BunKernel.boot({ wasmUrl: "../dist/bun-core.wasm" });
  // transform / bundle 按钮绑定...
</script>
```

### 4.4 Phase 1 验收检查表

- [ ] 浏览器演示页中：输入 TypeScript → 点击 Transform → 输出有效 JavaScript
- [ ] 浏览器演示页中：mount 多文件项目 → Bundle → 输出 bundled JS
- [ ] `bun_lockfile_parse` 能解析一个真实 bun.lock 文件
- [ ] Chrome 90+, Firefox 100+, Safari 15.2+ 三大浏览器通过

---

## 5 Phase 2 — EvalMin（最小运行时）

### 5.1 目标

在浏览器中执行用户 JS/TS 代码，支持最小 Node API 子集。

### 5.2 前置条件

- Phase 1 全部验收通过

### 5.3 子任务

#### T2.1 — JSI Host Adapter 完整实现

**文件**：`packages/bun-browser/src/jsi-host.ts`

实现 RFC 中定义的全部 JSI import 函数：

```typescript
class JSIHostAdapter {
  private handleTable: Map<number, any> = new Map();
  private nextHandle = 5; // 0-4 预留
  private memory: WebAssembly.Memory;

  // -- 值构造 --
  jsi_make_number(value: number): number { ... }
  jsi_make_string(ptr: number, len: number): number { ... }
  jsi_make_object(): number { ... }

  // -- 属性访问 --
  jsi_get_prop(obj: number, name_ptr: number, name_len: number): number { ... }
  jsi_set_prop(obj: number, name_ptr: number, name_len: number, val: number): void { ... }

  // -- 调用 --
  jsi_call(fn: number, this_: number, argv_ptr: number, argc: number): number { ... }
  jsi_new(ctor: number, argv_ptr: number, argc: number): number { ... }

  // -- HostFunction --
  jsi_make_host_function(tag: number, name_ptr: number, name_len: number, argc: number): number { ... }

  // -- Promise --
  jsi_make_promise(): number { ... }
  jsi_resolve(promise: number, value: number): void { ... }
  jsi_reject(promise: number, value: number): void { ... }

  // -- 执行 --
  jsi_eval(code_ptr: number, code_len: number, url_ptr: number, url_len: number): number { ... }

  // -- 生命周期 --
  jsi_retain(handle: number): number { ... }
  jsi_release(handle: number): void { ... }
}
```

GC 辅助：使用 `FinalizationRegistry` 跟踪宿主 JS 对象，当 WASM 侧释放 handle 时同步清理。

#### T2.2 — Zig 侧 JSI Runtime 实现

**文件**：`src/jsi/runtime.zig`

从空壳升级为功能实现：

```zig
pub const Runtime = struct {
    global: Value,

    pub fn eval(self: *Runtime, code: []const u8, url: []const u8) !Value {
        return Value{ .handle = imports.jsi_eval(
            @intFromPtr(code.ptr), code.len,
            @intFromPtr(url.ptr), url.len,
        ) };
    }

    pub fn getProperty(self: *Runtime, obj: Value, name: []const u8) Value {
        return Value{ .handle = imports.jsi_get_prop(
            obj.handle,
            @intFromPtr(name.ptr), name.len,
        ) };
    }

    pub fn call(self: *Runtime, func: Value, this: Value, args: []const Value) !Value {
        // 将 args 写入 WASM memory 中的 handle 数组
        // 调用 imports.jsi_call
    }

    pub fn createHostFunction(
        self: *Runtime,
        comptime callback: HostFn,
        name: []const u8,
        argc: u32,
    ) Value {
        const tag = host_function.register(callback);
        return Value{ .handle = imports.jsi_make_host_function(
            tag, @intFromPtr(name.ptr), name.len, argc,
        ) };
    }
};
```

#### T2.3 — 最小 Node API 实现

通过 JSI HostFunction 注入以下全局/模块到用户代码运行环境：

| API | 实现位置 | 说明 |
|-----|---------|------|
| `console.log/warn/error` | WASM 内格式化 → `jsi_call(host_console_log, ...)` | 输出到宿主 console |
| `setTimeout/setInterval/clearTimeout` | `wasm_event_loop` timer | 注册到 WASM 事件循环 |
| `process.env` | JSI Proxy → WASM 内 env 表 | |
| `process.cwd()` | VFS 当前目录 | |
| `require("fs").readFileSync` | VFS 同步读 | |
| `require("fs").writeFileSync` | VFS 同步写 | |
| `require("fs").existsSync` | VFS stat | |
| `require("fs").readdirSync` | VFS readdir | |
| `require("path")` | `src/paths.zig` 纯计算（已可移植） | |
| `require("url")` | `src/url.zig` 纯计算（已可移植） | |
| `fetch()` | JSI → 宿主 `fetch()` 直通 | |
| `Buffer` | WASM memory 上的 TypedArray 包装 | |

实现策略：
1. Transpiler(WASM) 识别 `require("fs")` → 替换为内部模块 ID
2. Module loader(WASM) 拦截此 ID → 通过 JSI 注入预构建的 polyfill 对象
3. Polyfill 对象的方法是 HostFunction，回调到 WASM VFS

#### T2.4 — bun_spawn 实现

```
bun_spawn("bun", ["run", "index.ts"]):
  1. transpiler 转译 index.ts → js
  2. resolver 解析 imports
  3. bundler 打包(如需要)
  4. jsi_eval(bundled_js) 在宿主执行
  5. 注入 Node polyfill 作为全局
  6. 返回 pid, 用户可监听 stdout/exit
```

#### T2.5 — 事件循环宿主驱动

```typescript
// packages/bun-browser/src/kernel-worker.ts
class KernelWorker {
  private wasm: WebAssembly.Instance;
  private running = false;

  async runLoop() {
    this.running = true;
    while (this.running) {
      const nextMs = this.wasm.exports.bun_tick();
      if (nextMs === 0) {
        // idle, 等待 wakeup
        await this.waitForWakeup();
      } else {
        await this.sleep(nextMs);
      }
    }
  }

  // 外部事件（IO 回调、用户输入）触发 wakeup
  wakeup() {
    this.wasm.exports.bun_wakeup();
    // 打断 waitForWakeup
  }
}
```

### 5.4 Phase 2 验收检查表

- [ ] 浏览器中：`kernel.spawn("bun", ["-e", 'console.log("hello")'])` → stdout 输出 "hello"
- [ ] 浏览器中：mount package.json + index.ts → `bun run index.ts` → 正确执行
- [ ] `fs.readFileSync` / `fs.writeFileSync` 在 VFS 上正确工作
- [ ] `setTimeout` 在 WASM 事件循环中正确调度
- [ ] `fetch("https://httpbin.org/get")` 通过 JSI → 宿主 fetch 正确返回
- [ ] 同一 wasm 文件在 Node.js 宿主下也能运行（使用 `vm.Context` 作为 JSI 后端）

---

## 6 Phase 3 — Serve（HTTP Server + 预览）

### 6.1 目标

`Bun.serve()` 在浏览器中工作，用户通过 iframe 可预览 HTTP 响应。

### 6.2 前置条件

- Phase 2 全部验收通过

### 6.3 子任务

#### T3.1 — ServiceWorker 实现

**文件**：`packages/bun-browser/src/service-worker.ts`

```typescript
// 拦截 localhost:PORT/* 请求 → 转发到 Kernel Worker
self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (routeTable.has(url.port)) {
    event.respondWith(forwardToKernel(url.port, event.request));
  }
});

// COOP/COEP 头注入（用于启用 SharedArrayBuffer）
self.addEventListener("install", () => { ... });

async function forwardToKernel(port: string, request: Request): Promise<Response> {
  // 通过 MessageChannel 发送给 Kernel Worker
  // Kernel Worker 调 WASM 路由 → 返回 Response
}
```

#### T3.2 — WASM 侧 HTTP 路由

复用 `src/bun.js/api/server.zig` 的路由逻辑，但：
- 请求来源：不是 socket，而是 JSI 传入的 `Request` 对象 handle
- 响应输出：不是 write to socket，而是通过 JSI 构造 `new Response(body, init)` 返回

```zig
// src/bun_wasm_server.zig
pub fn handleRequest(runtime: *jsi.Runtime, request_handle: jsi.Value) jsi.Value {
    const method = runtime.getProperty(request_handle, "method");
    const url = runtime.getProperty(request_handle, "url");
    // ... 路由匹配 → 调用用户注册的 handler → 返回 Response handle
}
```

#### T3.3 — 端口分配 + iframe 预览

```typescript
// SDK 侧
kernel.on("server:listening", ({ port }) => {
  // ServiceWorker 注册此端口
  // iframe.src = `${location.origin}/__bun_preview__/${port}/`
});
```

#### T3.4 — Bun.serve() 注入

用户代码中 `Bun.serve({ fetch(req) { return new Response("hi") } })` 的执行路径：

1. transpiler 识别 `Bun.serve` 调用
2. `Bun` 全局对象由 JSI HostFunction 注入
3. `serve()` 调用反弹到 WASM，注册 handler 到路由表
4. 通知 Host 侧注册端口
5. ServiceWorker 开始拦截该端口请求

### 6.4 Phase 3 验收检查表

- [ ] `Bun.serve({ port: 0, fetch: () => new Response("hello") })` 在浏览器跑通
- [ ] iframe 打开预览 URL 显示 "hello"
- [ ] 静态文件服务（`Bun.file()` 从 VFS 读取）工作
- [ ] 多个 serve 实例用不同端口
- [ ] HMR WebSocket 连接建立（为 Phase 4 Vite 支持铺路）

---

## 7 Phase 4 — Install（包管理器）

### 7.1 目标

在浏览器中运行 `bun install` 并能启动 Vite dev server。

### 7.2 前置条件

- Phase 3 全部验收通过

### 7.3 子任务

#### T4.1 — npm Registry Fetch 适配

**复用**：`src/install/npm.zig` 的协议解析逻辑
**替代**：`bun.http.AsyncHTTP` → JSI → 宿主 `fetch()`

```zig
// src/install/npm_wasm.zig
pub fn fetchPackageMetadata(
    runtime: *jsi.Runtime,
    package_name: []const u8,
    callback: *TaskCallback,
) void {
    const url = std.fmt.allocPrint(allocator, "https://registry.npmjs.org/{s}", .{package_name});
    const fetch_fn = runtime.getProperty(runtime.global, "fetch");
    const url_val = runtime.makeString(url);
    const promise = runtime.call(fetch_fn, runtime.global, &.{url_val});
    // 注册 .then() 回调 → 解析 JSON → 调 callback
}
```

**CORS 问题**：npm registry 默认不支持浏览器 CORS。解决方案：
- 提供可配置的 CORS 代理 URL
- 或使用支持 CORS 的镜像（如 unpkg, esm.sh 的 registry 接口）

#### T4.2 — Tarball 解压到 VFS

**复用**：`vendor/libarchive`（已在 Phase 0 编译为 wasm）
**流程**：

```
fetch .tgz → gunzip (zlib-ng/wasm) → untar (libarchive/wasm) → 写入 VFS /node_modules/
```

#### T4.3 — Lifecycle Scripts

`postinstall` 等 lifecycle scripts 在 WASM 进程模型中执行：

```
bun_spawn("node", ["./scripts/postinstall.js"], { cwd: pkg_dir })
```

仅支持纯 JS scripts，不支持 native compilation。

#### T4.4 — Shell 解释器最小子集

**复用**：`src/shell/` 的 AST parser
**实现**：解释执行以下子集：

```
支持:
  - 简单命令: bun run dev, echo hello
  - 管道: cmd1 | cmd2
  - 重定向: > file, >> file, < file
  - 环境变量: VAR=value cmd
  - &&, ||
  - 字符串插值: "hello $NAME"

不支持:
  - fork(), exec()
  - 后台 (&)
  - 子 shell ((...))
  - 信号 trap
```

#### T4.5 — Worker 进程池

当 `bun_spawn` 需要隔离环境时（如 `node ./script.js`）：

```typescript
class WorkerPool {
  private pool: Worker[] = [];
  private maxWorkers = navigator.hardwareConcurrency || 4;

  async spawn(cmd: string[], opts: SpawnOpts): Promise<Process> {
    const worker = this.pool.pop() || this.createWorker();
    // 发送 { type: "spawn", cmd, env, cwd, vfsSnapshot }
    // Worker 内加载同一份 bun-core.wasm
    // VFS 通过 SharedArrayBuffer 共享
  }
}
```

#### T4.6 — 集成测试：Vite 项目

```
测试流程:
1. mount 一个 React + Vite 项目的文件到 VFS
2. kernel.spawn("bun", ["install"])        → 安装依赖
3. kernel.spawn("bun", ["run", "dev"])     → 启动 vite dev
4. 等待 server:listening 事件
5. iframe 打开预览 → 验证页面渲染
```

### 7.4 Phase 4 验收检查表

- [ ] `bun install` 对一个有 5+ 依赖的 package.json 完成安装（`node_modules` 写入 VFS）
- [ ] `bun run dev` 启动 Vite → iframe 预览正常
- [ ] lockfile 生成并可被后续 `bun install` 使用
- [ ] 安装时间 < 30 秒（对中等项目，取决于 CORS 代理速度）

---

## 8 Phase 5 — Polish（性能与兼容性）

### 8.1 目标

性能优化、扩大 Node API 覆盖率、CI 稳定性。

### 8.2 子任务

#### T5.1 — SIMD 优化

启用 `wasm32-simd128`（Chrome 91+, Firefox 89+, Safari 16.4+）：
- `highway` SIMD 向量化
- `js_lexer` 快速 ASCII 扫描
- `string/immutable.zig` 向量化字符串操作

#### T5.2 — Memory Snapshot / COW

首次 `bun install` 后，序列化 VFS + WASM 状态为 snapshot：
- 后续 boot 可跳过重新安装
- 使用 IndexedDB / OPFS 持久化

#### T5.3 — 扩展 Node API 覆盖

按使用频率逐步增加：

| 优先级 | 模块 | 范围 |
|--------|------|------|
| P0 | `fs` | `readFile`, `writeFile`, `stat`, `mkdir`, `readdir`, `watch` (VFS 事件) |
| P0 | `path` | 全部（已可移植） |
| P0 | `events` | `EventEmitter` 全部 |
| P1 | `stream` | `Readable`, `Writable`, `Transform`, `pipeline` |
| P1 | `buffer` | `Buffer.from`, `alloc`, `concat`, `toString` |
| P1 | `crypto` | `createHash`, `randomBytes`, `randomUUID` |
| P1 | `child_process` | `spawn`, `exec`（映射到 bun_spawn） |
| P2 | `http` | `createServer`（映射到 Bun.serve）, `request`（映射到 fetch） |
| P2 | `os` | `platform`, `arch`, `cpus`, `tmpdir` |
| P2 | `util` | `promisify`, `inspect`, `format` |
| P3 | `net` | TCP client/server（WebSocket 隧道） |
| P3 | `dns` | `lookup`（宿主侧 resolve） |

#### T5.4 — Benchmark 套件

```
指标                        | 目标
---------------------------|--------
WASM 加载 + 初始化          | < 500ms
Transform 1000 行 TS        | < 50ms
Bundle 50 文件项目          | < 2s
bun install 10 依赖        | < 15s
Bun.serve 请求延迟         | < 10ms (ServiceWorker 开销)
WASM 产物体积 (gzip)       | < 3 MB
```

#### T5.5 — CI 集成

```yaml
# .github/workflows/wasm.yml
jobs:
  build-wasm:
    - zig build -Dtarget=wasm32-freestanding -Dwasm_profile=browser_runtime -Doptimize=ReleaseSmall
    - wasm-opt -Oz dist/bun-core.wasm -o dist/bun-core.wasm
    - npm run build --workspace=packages/bun-browser
    - npx playwright test test/wasm-browser/

  test-wasm:
    - Chrome: playwright chromium
    - Firefox: playwright firefox
    - Safari: playwright webkit
    - Node.js host: node test/wasm-node/
```

#### T5.6 — NAPI Bridge (可选)

Node.js 宿主模式下，可选 delegate napi 调用到真 Node napi：

```typescript
// 仅 Node 宿主
if (hostRuntime === "node") {
  napiModuleCache.set(modulePath, require(modulePath));
}
```

浏览器宿主下 napi 调用返回 `ENOSYS`。

### 8.3 Phase 5 验收检查表

- [ ] SIMD 优化后 transform 性能提升 > 30%
- [ ] 全部 benchmark 指标达标
- [ ] Chrome/Firefox/Safari CI 绿灯
- [ ] Node.js 宿主 CI 绿灯
- [ ] P0+P1 Node API 覆盖率 > 80% (按 API 数计)
- [ ] 文档发布（README + API Reference + 部署指南）

---

## 9 新增文件清单汇总

```
src/
  jsi/
    runtime.zig              # Phase 0.2 创建, Phase 2.2 填充
    value.zig                # Phase 0.2
    imports.zig              # Phase 0.2
    host_function.zig        # Phase 0.2
    promise.zig              # Phase 0.2, Phase 2.2
    module.zig               # Phase 1.1

  sys_wasm/
    vfs.zig                  # Phase 0.3
    proc.zig                 # Phase 0.3 骨架, Phase 2.4 填充
    net.zig                  # Phase 0.3 stub, Phase 3.2 填充

  async/
    wasm_event_loop.zig      # Phase 0.4

  install/
    npm_wasm.zig             # Phase 4.1

  bun_wasm_server.zig        # Phase 3.2

packages/
  bun-browser/
    src/
      index.ts               # Phase 1.3
      kernel-worker.ts        # Phase 1.3, Phase 2.5
      jsi-host.ts             # Phase 1.3 stub, Phase 2.1 完整
      service-worker.ts       # Phase 3.1
      vfs-client.ts           # Phase 1.3
      protocol.ts             # Phase 1.3
      worker-pool.ts          # Phase 4.5
    demo/
      index.html              # Phase 1.4
    package.json
    tsconfig.json
    rollup.config.ts

  bun-node/                   # Phase 2 (Node 宿主适配)
    src/
      index.ts
      jsi-host-node.ts        # 使用 vm.Context

test/
  wasm-browser/
    transform.test.ts         # Phase 1
    eval.test.ts              # Phase 2
    serve.test.ts             # Phase 3
    install.test.ts           # Phase 4
    playwright.config.ts

  wasm-node/
    host.test.ts              # Phase 2

scripts/
  build/
    deps/wasm-profile.ts      # Phase 0.6
```

### 修改文件清单

```
build.zig                            # Phase 0.1 — 增加 WasmProfile
src/bun.zig                          # Phase 0.5 — wasm 条件编译隔离 jsc
src/env.zig                          # 无需修改（已有 isWasm 标志）
src/jsc_stub.zig                     # Phase 0.2 — 可能被 src/jsi/ 取代
src/main_wasm.zig                    # Phase 1.1 — 增加导出函数
src/async/stub_event_loop.zig        # 可能被 wasm_event_loop.zig 替代
src/bundler/bundle_v2.zig            # Phase 1.1 — EventLoop 条件编译
scripts/build/config.ts              # Phase 0.6 — 增加 wasm OS 类型
packages/bun-wasm/                   # Phase 0 — 可能合并或保留兼容
```

---

## 10 风险登记与应对

| # | 风险 | 概率 | 影响 | 应对 |
|---|------|------|------|------|
| R1 | JSI 跨边界开销导致热路径 > 10x 慢 | 高 | 高 | Phase 2 后立即 benchmark；VFS 热路径不跨界；SAB 直通 |
| R2 | Bundler EventLoop 替换引入回归 | 中 | 高 | 通过 comptime 分支保证原平台零影响；wasm 侧独立测试 |
| R3 | npm CORS 代理不稳定/被限速 | 高 | 中 | 允许用户自定义代理；提供离线 snapshot 模式 |
| R4 | WASM Memory 2-4GB 上限被 node_modules 撞顶 | 中 | 中 | 流式解压 + 惰性加载；大项目给出 warning |
| R5 | Safari WASM SIMD / SAB 兼容性问题 | 中 | 低 | SIMD 作为可选优化；SAB 不可用时退回 postMessage 拷贝 |
| R6 | CSP `unsafe-eval` 限制 | 低 | 高 | 文档明确要求；提供 Trusted Types 支持 |
| R7 | 维护负担：jsi/ 与 jsc/ 两套绑定 | 高 | 中 | 长期考虑自动生成 JSI 绑定（从 .classes.ts 同时生成 JSC + JSI） |

---

## 11 长期演进方向

| 方向 | 说明 |
|------|------|
| **自动 JSI 代码生成** | 从 `.classes.ts` 同时生成 JSI Zig 绑定 + TS Host 适配器，减少手写量 |
| **WASM GC proposal** | 当浏览器支持 WASM GC 后，可直接传递 JS 引用而非句柄表，显著降低跨界开销 |
| **WASM Component Model** | WIT 接口定义可替代当前手写 ABI |
| **离线优先** | VFS snapshot + OPFS 持久化 → 完全离线运行 |
| **嵌入式 SQLite** | 使用 wa-sqlite 或 sql.js 提供 `bun:sqlite` |
| **协作编辑** | 多用户通过 CRDT 共享 VFS 状态 |
| **Mobile** | 同一 WASM 在 iOS/Android WebView 中运行 |
