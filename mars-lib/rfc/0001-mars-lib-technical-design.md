# RFC 0001: Mars-lib 技术方案与模块接口设计

- 状态: Draft
- 日期: 2026-04-28
- 目标读者: Mars-lib Runtime、WASM Core、Service Worker、插件系统、AI Agent Shell、工程化验收相关开发者

## 1. 摘要

Mars-lib 是一个运行在浏览器中的轻量级 Bun 兼容运行时。它以 Rust/WASM 实现核心运行时能力，通过 Service Worker 拦截网络请求，配合虚拟文件系统、进程模拟、模块加载器、内置 Shell 与 Hook 插件体系，使浏览器具备接近本地服务端开发环境的执行能力。

Mars-lib 的核心目标不是把浏览器伪装成完整操作系统，而是在浏览器安全模型内提供一组稳定、可编程、可测试的服务器端开发能力，优先支持以下验收场景:

1. 在浏览器中运行 Express 服务。
2. 在浏览器中运行 Koa 服务。
3. 在浏览器中运行 Vite + React + TypeScript 开发环境，并支持 HMR。
4. 直接执行 `.ts` / `.tsx` 文件。
5. 为 AI Agent 提供结构化 Shell、文件系统、Hook 和插件能力。

Mars-lib 借鉴 WebContainer 的核心思路: 使用 Service Worker 劫持请求，在 Worker/WASM 中承载运行时，通过虚拟化文件系统、网络、进程和模块加载能力，让前端页面可以访问一个“虚拟本地服务器”。Mars-lib 的差异点在于目标 API 对齐 Bun，而不是 Node.js；同时把 Hook 插件体系和 AI Agent Shell 作为一等能力。

## 2. 术语

- Mars-lib: 项目整体名称。
- MarsRuntime: 浏览器中创建的运行时实例，用户主要交互入口。
- MarsCore: Rust 编写并编译到 WASM 的核心模块。
- MarsBridge: JavaScript、WASM、Web Worker、Service Worker 之间的通信胶水层。
- MarsKernel: 进程、端口、stdio、syscall、Worker 生命周期管理器。
- MarsVFS: 虚拟文件系统。
- MarsServiceWorkerRuntime: Service Worker 中运行的请求拦截与分发逻辑。
- MarsShell: 面向用户和 AI Agent 的虚拟 Shell。
- MarsHooks: Hook 插件调度系统。
- Virtual Server: 由 `Bun.serve()`、`node:http.createServer()` 或框架 `listen()` 注册到 MarsKernel 的虚拟 HTTP/WebSocket 服务。
- VFS: Virtual File System，包含内存层、持久化层和只读基础层。

## 3. 设计目标

### 3.1 功能目标

1. 提供 Bun 顶级 API 的浏览器兼容实现，包括 `Bun.file()`、`Bun.write()`、`Bun.serve()`、`Bun.fetch()`、`Bun.spawn()`、`Bun.build()`、`Bun.plugin()`、`Bun.password`、`Bun.CryptoHasher`、`Bun.sql` 等。
2. 提供 Node.js 常用兼容层，至少覆盖 Express、Koa、Vite、React、TypeScript 项目的运行路径所需模块。
3. 提供完整 VFS，支持 Unix 风格路径、目录、文件、stat、watch、rename、unlink、持久化与快照。
4. 使用 Service Worker 实现虚拟端口访问，例如 `http://mars.localhost:3000/`。
5. 提供模块解析和加载能力，支持 ESM、CommonJS、JSON、WASM、TS、TSX、JSX。
6. 提供面向 AI Agent 的 Shell，支持基本命令、管道、重定向、进程管理、结构化输出和自定义命令。
7. 提供 Hook 插件系统，允许拦截 API 调用、请求、响应、文件读写、命令执行、模块解析、模块加载和代码转译。
8. 提供可自动化的验收测试，覆盖 Express、Koa、Vite React TS、TSX 执行和 AI Shell。

### 3.2 非目标

1. M1 阶段不要求实现完整 POSIX 语义。
2. M1 阶段不要求完整兼容所有 Bun API 行为边界。
3. M1 阶段不要求真实 native 子进程，`Bun.spawn()` 可以映射为受控 Worker 或内置命令。
4. M1 阶段不要求运行所有 npm 包，只要求覆盖验收路径依赖。
5. 不绕过浏览器安全限制，例如任意本地文件访问、原生 TCP/UDP socket 等。

## 4. 总体架构

```text
┌──────────────────────────────────────────────────────────┐
│                     Browser Page                         │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐  │
│  │ Mars Shell UI│ │ Plugin Panel │ │ User Application │  │
│  └──────┬───────┘ └──────┬───────┘ └────────┬─────────┘  │
│         │                │                  │            │
│  ┌──────┴────────────────┴──────────────────┴─────────┐  │
│  │                    Mars Client                       │  │
│  │  createMarsRuntime, preview, shell, vfs, plugins     │  │
│  └──────────────────────┬──────────────────────────────┘  │
└─────────────────────────┼─────────────────────────────────┘
                          │ MarsBridge
┌─────────────────────────┼─────────────────────────────────┐
│              Mars Service Worker Runtime                  │
│  - fetch interception                                      │
│  - virtual host and port routing                           │
│  - VFS asset/module response                               │
│  - request forwarding to MarsKernel                        │
└─────────────────────────┼─────────────────────────────────┘
                          │ MessageChannel / postMessage
┌─────────────────────────┼─────────────────────────────────┐
│                 Mars Runtime Worker                        │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                    MarsKernel                         │  │
│  │  process table, port table, stdio, syscall bridge     │  │
│  └───────────────┬──────────────────────────────────────┘  │
│                  │                                         │
│  ┌───────────────┴──────────────────────────────────────┐  │
│  │                    MarsCore WASM                       │  │
│  │  VFS metadata, shell parser, HTTP pipeline, crypto,   │  │
│  │  sqlite, deterministic runtime logic                  │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### 4.1 当前实现状态

Phase 3 启动时，Mars-lib 已具备一条内存态执行链路，但还不是完整 WebContainer 式跨上下文拓扑。

当前主流程由四个运行时边界组成:

1. 浏览器页面 host: Vite 在 `127.0.0.1` 输出 playground 页面、`/@fs` package source、COOP/COEP/CORP headers 和同源 ServiceWorker script route。React UI 负责启动 host runtime，并展示 secure context、SAB、SW ready/controller 状态。
2. ServiceWorker scope: `/mars-sw-scope-smoke.js` 创建 SW 内部 MarsVFS、MarsKernel、ServiceWorkerRouter，并用 `bootPromise` 完成 snapshot hydrate；install/activate/fetch/RPC 都等待该 promise，避免 top-level await 和初始化竞态。真实 playground 中 Vite host 的 `/@vite/client` 与缺失宿主源码请求会通过 `fallback: 'network'` 回到 Vite。
3. Bridge/Kernel/Process Worker: 页面与 SW、Kernel Worker 与页面、Kernel 与 Process Worker 均通过 `@mars/bridge` 的 request/response 与 MessageChannel/postMessage transport 传递 RPC；Process Worker bootstrap 在 worker scope 注入 Bun/process/require context 并回传 stdio/exit。`kernel.spawn({ kind: "worker" })` 已能在 Kernel Worker controller 内自动创建 Process Worker，并把 worker stdout/stderr/exit 映射回 Kernel pid。
4. VFS/module graph: 当前稳定依赖入口是 `/__mars__/module?path=...`，`/src/*.ts(x)` 源码 URL 首跳和 VFS `node_modules` bare import 二跳也可由 ServiceWorkerRouter 接管。ServiceWorkerRouter 从 SW scope VFS 读取源码，SWC 输出 ESM 并重写 import URL；页面 runtime 写入已能经 VFS watcher 自动 fanout 到 `sw.vfs.patch`，Process Worker factory 绑定源 VFS 后也能将写入/删除自动 fanout 为 `process.worker.vfs.patch`。

已串联:

1. `createMarsRuntime()` 创建 MarsVFS、MarsKernel、MarsShell、Bun facade 和 `ServiceWorkerRouter`。
2. `MarsRuntime.run(entry)` 通过 Kernel 创建虚拟 pid，再由 `runEntryScript()` 读取 VFS、调用 SWC WASM transpiler、进入 loader/evaluator，并把 console stdout/stderr 写回 Kernel。
3. `MarsShell` 已接入 `bun run <entry>` 命令，命令会进入同一条虚拟 pid、stdio bridge 和 loader 执行路径。
4. `runtime.spawn("bun", ["run", entry])` 与 `Bun.spawn({ cmd: ["bun", "run", entry] })` 已复用同一条虚拟 pid 和 stdio bridge 路径。
5. `runtime.fetch(previewUrl)` 可手动经过 `ServiceWorkerRouter` 分发到 Kernel port table 和 VirtualServer。
6. `ProcessHandle` 已具备 stdin readable、stdout/stderr readable、`write()` 输入和 stdout/stderr mirror，为后续 Process Worker stdio bridge 做前置。
7. `createMarsProcessWorkerFactory()` 已覆盖受控 worker boot/message/terminate 生命周期；无 Worker URL 时走 in-memory fallback，有 Worker URL 时可通过 `new Worker()` 承载并使用 `process.worker.boot/message/stdin/stdout/stderr/exit/terminate` 协议。
8. `Bun.spawnSync()` 当前返回明确 unsupported fallback result；`Bun.CryptoHasher`、`Bun.password` 与 `node:crypto` 子集已通过 WebCrypto 覆盖验收；`Bun.sql` 已有 MarsVFS-backed sqlite prework，覆盖基础表操作、tagged query 和 database 文件持久化。
9. VFS snapshot 已支持 JSON-safe 序列化和跨 runtime restore；OPFS persistence adapter 已覆盖 open/get/set/delete/keys/close，并在无 OPFS 环境提供 memory fallback；浏览器 capabilities/profile 已有可测试描述。
10. `@mars/bridge` 已提供 in-memory transport pair、postMessage/MessageChannel transport 和 async request/response listener；`@mars/sw` 与 `@mars/kernel` 已有 bridge controller 预研切片，可跑通 client->SW fetch、SW->Kernel server request、Kernel Worker RPC 和 Kernel->Process Worker lifecycle 消息流。
11. `@mars/sw` 已提供 ServiceWorker `fetch` event handler 安装函数，验收覆盖 fetch event `respondWith()` 到 Kernel bridge 的分发路径。
12. `createMarsRuntime({ serviceWorkerUrl })` 已接入 ServiceWorker registration 抽象，可调用 `navigator.serviceWorker.register()`、等待 `ready`、发送 client->SW MessageChannel 握手，并在 dispose 时可选 unregister；验收与 playground 通过可注入 ServiceWorkerContainer 覆盖生命周期。
13. `installServiceWorkerBootstrap()` 已提供 SW script bootstrap 入口，可监听 `sw.connect` message、接管 transferred `MessagePort`、安装 client bridge controller，并与 fetch event handler 共用同一个 router。
14. `installKernelWorkerBootstrap()` 已提供 Kernel Worker bootstrap 入口，可监听 `kernel.connect` message、接管 transferred `MessagePort`、安装 Kernel Worker controller，并响应该端口上的 `kernel.boot`、Process Worker lifecycle、`process.worker.vfs.patch` 与 `process.worker.run` RPC。
15. `connectMarsKernelWorker()` 已提供页面侧 Kernel Worker native carrier，可用 `new Worker()` 创建 worker、传递 MessagePort、发送 `kernel.connect`，并通过 client endpoint 承载 `kernel.boot`、Process Worker lifecycle、VFS patch 与 run RPC。
16. `ServiceWorkerRouter` 已能拦截 `/__mars__/module` 与 `/src/*.ts(x)` 源码 URL，通过 `createModuleResponse({ format: "esm" })` 返回浏览器 ESM，并将静态、动态和 VFS `node_modules` bare import 重写到稳定 module URL，验收覆盖原生源码 URL 首跳、入口模块、相对依赖和 package 依赖二跳加载。
17. `installProcessWorkerRuntimeBootstrap()` 已提供 Process Worker script bootstrap，可接收 `process.worker.boot`，以 Bun 风格 argv/cwd/env context 注入 `Bun`、`process`、`require`，执行 `bun run <entry>`，并把 console stdout/stderr 与 exit code 回传到 native carrier 协议。
18. `createProcessWorkerBootstrapScript()` / `createProcessWorkerBootstrapBlobURL()` 已提供 module Worker bootstrap source 和 Blob URL 生成能力，为真实 `workerURL` 打包加载自动化做前置。
19. Playground 已接入首个真实浏览器 Worker smoke：通过 Blob module URL 创建原生 `Worker`，worker 内使用 Vite `/@fs` import URL 加载 runtime/vfs/kernel 包，并验证 `bun run <entry>` 的 stdout 与 exit 回传。
20. Playground 已接入真实 ServiceWorker scope smoke 和页面级 host runtime：Vite dev/preview 同源提供 `/mars-sw-scope-smoke.js` module script，并输出 COOP/COEP/CORP headers 让页面进入 `crossOriginIsolated`、启用 `SharedArrayBuffer`；React UI 加载后会注册真实 `navigator.serviceWorker` 并显示 SAB/SW ready 状态，smoke 用例通过 MessageChannel `sw.fetch` 验证 SW scope 内 `/__mars__/module` ESM 响应。
21. VFS snapshot 已参与跨上下文启动态同步：Process Worker bootstrap script 可内联 serialized snapshot 并在安装 runtime 前 restore，ServiceWorker scope smoke 也通过 serialized snapshot hydrate `/workspace` module graph。
22. VFS patch 已参与 Process Worker 运行期同步：页面侧和 Kernel Worker bridge 均可发送 `process.worker.vfs.patch`，worker scope 应用增量 write/delete patch 后通过 `process.worker.run` 显式执行更新后的 entry；`MarsProcessWorkerFactory` 也可绑定源 VFS 并自动 fanout write/delete patch。
23. VFS patch 已参与 ServiceWorker 运行期同步：页面侧可发送 `sw.vfs.patch`，SW scope 应用增量 write/delete patch 后通过 `sw.fetch` 返回更新后的 `/__mars__/module` ESM 响应。
24. `kernel.spawn({ kind: "worker" })` 已接入 Kernel Worker controller：RPC spawn 会创建 Kernel pid、自动 boot Process Worker、返回 worker id、将 worker stdout/stderr 写入 Kernel stdio，并在 worker exit 后 resolve `waitpid`。
25. `MarsRuntime` 已接入 ServiceWorker VFS 自动 fanout：runtime VFS 写入会生成 JSON-safe patch 并通过 client->SW bridge 发送到 `sw.vfs.patch`，`flushServiceWorkerVFS()` 可等待 SW scope VFS 与页面 VFS 同步完成。
26. `MarsProcessWorkerFactory` 已接入 Process Worker VFS 自动 fanout：factory 绑定源 VFS 后，新 worker 会监听 sync root 并把 runtime 写入转换成 `process.worker.vfs.patch`，真实浏览器 Worker smoke 已改为 `Bun.write()` 驱动同步。

未串联:

1. ServiceWorker registration、SW script bootstrap、真实 scope smoke、SW scope 增量 VFS patch、源码 URL 首跳、VFS `node_modules` bare import 二跳、Vite host network fallback 和 playground host SAB/SW 状态面板已接入；完整浏览器 fetch event 接管、完整 npm graph 和 Vite special path 自动化仍待补。
2. Kernel Worker bootstrap 与页面侧 native carrier 已有可测试抽象；Process Worker native carrier、runtime bootstrap、worker script source/Blob URL 生成、snapshot restore、增量 VFS patch、factory VFS 自动 fanout 与真实浏览器加载 smoke 已覆盖 stdio/module/context 主链路。
3. `process` / `require` / `Bun` 已可按 boot context 注入 Process Worker scope；完整 stdin consumer 和 Process Worker script loading 自动化仍待补。
4. 浏览器原生 `/src/*.ts(x)` 模块请求已可通过 ServiceWorker module response 完成首跳，VFS `node_modules` bare import 已可重写为 `/__mars__/module?path=...` 二跳；完整 npm graph、node_modules 子资源和 Vite special paths 的完整接管仍待补。
5. ServiceWorker module response 已与 loader/evaluator 的 CommonJS 执行模型拆分，真实 scope smoke 和 `/src/*.ts` 首跳已覆盖；Vite special path 自动化仍待补。

## 5. Monorepo 包结构

```text
mars-lib/
├── nx.json
├── package.json
├── tsconfig.base.json
├── .oxlintrc.json
├── .oxfmt.toml
├── packages/
│   ├── mars-client/          # 浏览器入口 SDK
│   ├── mars-runtime/         # Bun API facade 与全局对象安装
│   ├── mars-core/            # Rust/WASM 核心运行时
│   ├── mars-kernel/          # 进程、端口、syscall、stdio 管理
│   ├── mars-vfs/             # 虚拟文件系统
│   ├── mars-sw/              # Service Worker 请求拦截
│   ├── mars-shared/          # 通用 wasm loader、共享工具与跨包基础设施
│   ├── mars-bridge/          # JS/WASM/SW/Worker 通信胶水层
│   ├── mars-loader/          # CJS/ESM/TS/TSX 模块加载器
│   ├── mars-resolver/        # package exports/imports/tsconfig paths 解析
│   ├── mars-transpiler/      # TS/TSX/JSX 转译
│   ├── mars-bundler/         # Bun.build / Vite dev graph / HMR
│   ├── mars-shell/           # 虚拟 Shell 与 AI Agent 命令接口
│   ├── mars-hooks/           # Hook 调度引擎
│   ├── mars-plugin-api/      # 插件类型定义与开发 SDK
│   ├── mars-installer/       # npm 包安装、缓存、node_modules 写入
│   ├── mars-node/            # node:* 兼容层
│   ├── mars-webapis/         # Request/Response/WebSocket/Blob 等适配
│   ├── mars-crypto/          # Bun.password / CryptoHasher / node:crypto 子集
│   ├── mars-sqlite/          # Bun.sql / sqlite wasm
│   └── mars-test/            # 验收测试工具
├── playground/
│   ├── core-modules/
│   │   └── bun/             # Runtime/VFS/Shell、Bun.file、Bun.serve 使用实例
│   ├── node-http/
│   ├── express/
│   ├── koa/
│   ├── vite-react-ts/
│   └── tsx/
└── examples/
    └── vite-typescript-react/
        ├── src/
        │   ├── module-cases/      # 各模块运行用例入口
        │   └── test-cases/        # 面向测试场景的页面与驱动
        ├── tests/
        │   ├── modules/           # 模块级自动化测试
        │   └── acceptance/        # 验收级自动化测试
        ├── fixtures/              # 共享 fixture 与 mock 数据
        ├── vite.config.ts
        └── package.json
```

建议 npm scope:

```text
@mars/client
@mars/runtime
@mars/core
@mars/kernel
@mars/vfs
@mars/sw
@mars/shared
@mars/bridge
@mars/loader
@mars/resolver
@mars/transpiler
@mars/bundler
@mars/shell
@mars/hooks
@mars/plugin-api
```

### 5.1 工程编排与代码规范 (Nx + ox)

Mars-lib 使用 Nx 统一组织 monorepo 的构建、测试与任务编排，并使用 ox 统一格式化与静态检查。

工程化约束:

1. 使用 Nx project graph 管理 `packages/*` 之间的依赖关系。
2. 每个包通过 `project.json` 或 `package.json` 声明标准 targets: `build`、`test`、`typecheck`、`lint`、`format`。
3. CI 默认通过 `nx affected` 只执行受影响模块，减少全量构建成本。
4. lint 与 format 统一由 ox 工具链负责，本 RFC 约定命令名为 `ox lint` 和 `ox format`。

推荐命令约定:

```bash
# 全仓统一执行
nx run-many -t build,test,typecheck

# 增量执行（CI 默认）
nx affected -t build,test,lint

# 代码规范
ox format
ox lint

# CI 校验模式
ox format --check
ox lint --max-warnings 0
```

CI 最低门禁:

1. `nx affected -t build,test,typecheck,lint` 必须通过。
2. `ox format --check` 必须通过。
3. `ox lint --max-warnings 0` 必须通过。

## 6. 用户侧 API

`mars-client` 是使用者主入口。

```ts
export interface MarsBootOptions {
  root?: string;
  serviceWorkerUrl?: string;
  workerUrl?: string;
  initialFiles?: FileTree;
  env?: Record<string, string>;
  plugins?: MarsPlugin[];
  persistence?: "memory" | "indexeddb" | "opfs";
  sharedArrayBuffer?: "auto" | "required" | "disabled";
  cdnBaseUrl?: string;
  offline?: boolean;
}

export interface MarsRuntime {
  readonly vfs: MarsVFS;
  readonly shell: MarsShell;
  readonly kernel: MarsKernel;
  readonly plugins: PluginContainer;

  boot(): Promise<void>;
  dispose(): Promise<void>;

  run(entry: string, options?: RunOptions): Promise<ProcessHandle>;
  spawn(command: string, args?: string[], options?: SpawnOptions): Promise<ProcessHandle>;

  install(files: FileTree): Promise<void>;
  snapshot(path?: string): Promise<FileTree>;
  restore(tree: FileTree, root?: string): Promise<void>;

  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  preview(port: number): string;
  registerServer(server: VirtualServer): Promise<void>;
}

export function createMarsRuntime(options?: MarsBootOptions): Promise<MarsRuntime>;
```

示例:

```ts
import { createMarsRuntime } from "@mars/client";

const mars = await createMarsRuntime({
  initialFiles,
  plugins: [],
});

await mars.boot();
await mars.shell.run("bun run dev");

iframe.src = mars.preview(3000);
```

## 7. MarsBridge 通信协议

所有跨 Page、Service Worker、Runtime Worker、Process Worker、WASM 的消息统一使用 envelope。

```ts
export type MarsMessageSource = "client" | "sw" | "kernel" | "process" | "wasm";
export type MarsMessageTarget = "client" | "sw" | "kernel" | "process" | "wasm";

export interface MarsMessage<T = unknown> {
  id: string;
  type: string;
  source: MarsMessageSource;
  target: MarsMessageTarget;
  pid?: number;
  traceId?: string;
  payload: T;
}

export interface MarsResponse<T = unknown> {
  id: string;
  ok: boolean;
  payload?: T;
  error?: SerializedError;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: unknown;
}
```

核心消息类型:

```text
kernel.boot
kernel.shutdown
kernel.spawn
kernel.kill
kernel.waitpid
kernel.stdio
server.listen
server.close
server.request
vfs.read
vfs.write
vfs.stat
vfs.readdir
vfs.watch
module.resolve
module.load
module.transform
shell.run
shell.complete
hook.call
```

Bridge 接口:

```ts
export interface MarsBridgeEndpoint {
  request<TReq, TRes>(type: string, payload: TReq, options?: BridgeRequestOptions): Promise<TRes>;
  notify<T>(type: string, payload: T): void;
  on<T>(type: string, listener: (payload: T, message: MarsMessage<T>) => void): Disposable;
  close(): void;
}

export interface BridgeRequestOptions {
  target?: MarsMessageTarget;
  pid?: number;
  traceId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  transfer?: Transferable[];
}
```

## 8. MarsKernel 进程与端口接口

MarsKernel 管理虚拟进程、端口、stdio、Worker 生命周期和 syscall bridge。

```ts
export type Pid = number;
export type Fd = number;

export interface KernelConfig {
  maxProcesses?: number;
  sharedBufferSize?: number;
  asyncSyscallFallback?: boolean;
  workerFactory?: ProcessWorkerFactory;
}

export interface ProcessDescriptor {
  pid: Pid;
  ppid: Pid;
  cwd: string;
  env: Record<string, string>;
  argv: string[];
  status: "starting" | "running" | "exited" | "killed" | "zombie";
  exitCode: number | null;
  startedAt: number;
  exitedAt?: number;
}

export interface SpawnOptions {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: ReadableStream<Uint8Array> | string;
  stdout?: WritableStream<Uint8Array>;
  stderr?: WritableStream<Uint8Array>;
  kind?: "script" | "shell" | "server" | "worker";
}

export interface ProcessHandle {
  readonly pid: Pid;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;

  write(input: string | Uint8Array): Promise<void>;
  kill(signal?: string | number): Promise<void>;
}

export interface MarsKernel {
  boot(): Promise<void>;
  shutdown(): Promise<void>;

  spawn(options: SpawnOptions): Promise<ProcessHandle>;
  kill(pid: Pid, signal?: string | number): Promise<void>;
  waitpid(pid: Pid): Promise<number>;
  ps(): ProcessDescriptor[];

  registerPort(pid: Pid, port: number, server: VirtualServer): void;
  unregisterPort(port: number): void;
  resolvePort(port: number): Pid | null;
  dispatchToPort(port: number, request: Request): Promise<Response>;

  on<K extends keyof KernelEvents>(event: K, listener: KernelEvents[K]): Disposable;
}

export interface KernelEvents {
  "process:start": (payload: { pid: Pid; argv: string[] }) => void;
  "process:exit": (payload: { pid: Pid; code: number }) => void;
  "stdio": (payload: { pid: Pid; fd: 1 | 2; chunk: Uint8Array }) => void;
  "server:listen": (payload: { pid: Pid; port: number; protocol: "http" | "ws" }) => void;
  "server:close": (payload: { pid: Pid; port: number }) => void;
}
```

## 9. MarsVFS 接口

MarsVFS 提供同步与异步文件系统接口。同步接口用于 CommonJS 和 Node 兼容层，异步接口用于浏览器持久化与 UI 操作。

```ts
export interface MarsVFS {
  cwd(): string;
  chdir(path: string): void;

  existsSync(path: string): boolean;
  readFileSync(path: string, encoding?: BufferEncoding): Uint8Array | string;
  writeFileSync(path: string, data: string | Uint8Array, options?: WriteFileOptions): void;
  statSync(path: string): MarsStats;
  readdirSync(path: string, options?: ReaddirOptions): string[] | MarsDirent[];
  mkdirSync(path: string, options?: MkdirOptions): void;
  unlinkSync(path: string): void;
  renameSync(from: string, to: string): void;

  readFile(path: string, encoding?: BufferEncoding): Promise<Uint8Array | string>;
  writeFile(path: string, data: string | Uint8Array, options?: WriteFileOptions): Promise<void>;
  stat(path: string): Promise<MarsStats>;
  readdir(path: string, options?: ReaddirOptions): Promise<string[] | MarsDirent[]>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;

  watch(path: string, listener: VFSWatchListener): Disposable;
  mount(path: string, layer: VFSLayer): void;
  snapshot(path?: string): Promise<FileTree>;
  restore(tree: FileTree, root?: string): Promise<void>;
}

export interface MarsStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mode: number;
  mtime: Date;
  atime: Date;
  ctime: Date;
}

export interface MarsDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface VFSLayer {
  readonly name: string;
  readonly readonly?: boolean;

  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  list(path: string): Promise<VFSEntry[]>;
  stat(path: string): Promise<MarsStats | null>;
}

export interface PersistenceAdapter {
  open(namespace: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  close(): Promise<void>;
}
```

VFS 推荐分层:

```text
MemLayer      # 当前会话中的可写热数据
PersistLayer  # IndexedDB/OPFS 持久化数据
BaseLayer     # 初始工程文件、内置运行时文件、只读 fixture
```

## 10. Mars Service Worker Runtime

Service Worker 负责拦截浏览器 `fetch` 请求，并按请求类型分发到 MarsKernel、MarsVFS 或外部网络。

```ts
export interface ServiceWorkerRuntimeOptions {
  scope?: string;
  virtualHosts?: string[];
  kernelClient: ServiceWorkerKernelClient;
  vfsClient: ServiceWorkerVFSClient;
  fallback?: "network" | "404";
}

export interface ServiceWorkerKernelClient {
  resolvePort(port: number): Promise<Pid | null>;
  dispatchToKernel(pid: Pid, request: Request): Promise<Response>;
}

export interface ServiceWorkerVFSClient {
  readFile(path: string): Promise<Uint8Array | null>;
  stat(path: string): Promise<MarsStats | null>;
  contentType(path: string): string;
}

export interface FetchRouteContext {
  request: Request;
  url: URL;
  kind: "virtual-server" | "vfs-asset" | "module" | "external";
}

export interface ServiceWorkerRouter {
  match(request: Request): Promise<FetchRouteContext | null>;
  handle(context: FetchRouteContext): Promise<Response>;
}
```

请求分类规则:

```ts
export type RequestKind = "virtual-server" | "vfs-asset" | "module" | "external";

export function classifyRequest(url: URL): RequestKind {
  if (url.hostname.endsWith(".mars.localhost")) return "virtual-server";
  if (url.pathname.startsWith("/__mars__/vfs/")) return "vfs-asset";
  if (url.pathname.startsWith("/@vite/") || url.pathname.includes("/node_modules/")) return "module";
  return "external";
}
```

虚拟端口流转:

```text
browser fetch http://mars.localhost:3000/
  -> Service Worker fetch event
  -> classifyRequest: virtual-server
  -> resolvePort(3000)
  -> dispatchToKernel(pid, request)
  -> VirtualServer.fetch(request)
  -> Response
```

## 11. Bun API Facade

`mars-runtime` 安装 `globalThis.Bun`、`process`、`Buffer` 和必要的 `node:*` 兼容模块。

```ts
export interface MarsBun {
  version: string;
  env: Record<string, string>;

  file(path: string | URL, options?: BlobPropertyBag): MarsBunFile;
  write(destination: string | URL | MarsBunFile, input: BlobPart | Response | Request): Promise<number>;

  serve(options: ServeOptions): Server;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

  spawn(options: BunSpawnOptions): Subprocess;
  spawnSync(options: BunSpawnSyncOptions): SyncSubprocessResult;

  build(options: BuildOptions): Promise<BuildResult>;
  plugin(plugin: BunPlugin): void;

  password: PasswordAPI;
  CryptoHasher: typeof CryptoHasher;
  SQL?: SQLFactory;
}

export function installBunGlobal(runtime: MarsRuntime): MarsBun;
```

`Bun.serve()` 接口:

```ts
export interface ServeOptions {
  port?: number;
  hostname?: string;
  fetch(request: Request, server: Server): Response | Promise<Response>;
  websocket?: WebSocketHandler;
  error?(error: unknown): Response | Promise<Response>;
}

export interface Server {
  readonly port: number;
  readonly hostname: string;
  readonly url: URL;

  fetch(request: Request): Promise<Response>;
  stop(closeActiveConnections?: boolean): void;
  reload(options: Partial<ServeOptions>): void;
  upgrade(request: Request, options?: UpgradeOptions): boolean;
}
```

## 12. Node HTTP 兼容层

Express 和 Koa 主要依赖 `node:http`、`node:stream`、`node:events`、`node:url`、`node:querystring`、`node:path`、`node:fs` 等模块。Mars-lib 必须优先实现框架运行路径。

```ts
export interface NodeHttpCompat {
  createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void
  ): NodeHttpServer;
}

export interface NodeHttpServer {
  listen(port?: number, hostname?: string, callback?: () => void): this;
  close(callback?: (err?: Error) => void): this;
  address(): { address: string; port: number; family: string } | null;
  on(event: "request" | "upgrade" | "listening" | "close" | "error", listener: Function): this;
}
```

Node HTTP / Express / Koa 映射:

```text
http.createServer(handler).listen(0) 或 app.listen(3000)
  -> node:http.createServer(handler).listen(port)
  -> MarsKernel.allocatePort(port)
  -> MarsKernel.registerPort(pid, assignedPort, server)
  -> MarsServiceWorkerRuntime.resolvePort(assignedPort)
  -> MarsKernel.dispatchToPort(assignedPort, request)
  -> IncomingMessage / ServerResponse adapter
  -> Response
```

`node:http` 与 `Bun.serve()` 是并列 facade: 二者都注册到 MarsKernel 的虚拟端口表并共享请求分发路径，但 `node:http` 不通过 `Bun.serve()` 包一层实现，避免 Node adapter 语义被 Bun server 对象约束。

## 13. Mars Loader / Resolver / Transpiler

模块系统负责 ESM、CommonJS、TS、TSX、JSX、JSON、WASM 的加载、解析、转译和缓存。

```ts
export interface ModuleLoader {
  import(specifier: string, parentUrl?: string): Promise<unknown>;
  require(specifier: string, parentPath: string): unknown;
  evaluateModule(module: LoadedModule): Promise<ModuleNamespace>;
  invalidate(path: string): void;
}

export interface ResolveContext {
  specifier: string;
  importer?: string;
  conditions: string[];
  extensions: string[];
  cwd: string;
}

export interface ResolveResult {
  path: string;
  format: "esm" | "cjs" | "json" | "wasm" | "asset";
  external?: boolean;
}

export interface Transpiler {
  transform(input: TransformInput): Promise<TransformResult>;
  scanImports(code: string, loader: Loader): ImportRecord[];
}

export interface TransformInput {
  path: string;
  code: string;
  loader: "js" | "jsx" | "ts" | "tsx" | "json";
  target?: "browser" | "bun" | "node";
  sourcemap?: boolean;
}

export interface TransformResult {
  code: string;
  map?: string;
  imports: ImportRecord[];
  diagnostics: Diagnostic[];
}
```

实现优先级:

1. `.js`、`.mjs`、`.cjs`、`.json`。
2. `.ts`、`.tsx`、`.jsx`，先接入 SWC WASM 或 Rust transpiler。
3. `package.json` 的 `exports`、`imports`、`main`、`module`、`browser` 字段。
4. `tsconfig.json` 的 `baseUrl` 和 `paths`。
5. Vite dev graph 和 HMR invalidation。

M2 验收口径:

1. Resolver 必须覆盖 package exports/imports、subpath、pattern fallback、browser field/map、扩展名补全和 tsconfig paths。
2. Transpiler 在 M2 默认使用社区 `@swc/wasm-web` adapter 完成 TS/TSX/JSX 转译，wasm 初始化统一通过 `@mars/shared` 的 wasm loader 管理，并保留 BasicTranspiler 作为 wasm 初始化失败和同步 `require()` 路径的 fallback。
3. Loader 必须覆盖 CJS/JSON、ESM static import 降级、string-literal dynamic import、模块缓存和 invalidation。
4. Runtime run 必须把 console stdout/stderr 映射到 ProcessHandle streams。
5. SWC WASM adapter 必须在 `playground/core-modules/transpiler` 中有可运行用例，验收应检查执行语义和 import graph，而不是绑定具体生成代码文本。
6. Phase 2 核心模块 playground 用例统一放在 `playground/core-modules/`，按 resolver、transpiler、loader、runtime、installer、bundler-dev-server 拆分入口。

## 14. Mars Hooks 插件系统

插件系统是 Mars-lib 的横切能力，所有关键路径都应通过 Hook 调度。

```ts
export interface MarsPlugin {
  name: string;
  enforce?: "pre" | "post";

  setup?(api: PluginSetupAPI): void | Promise<void>;

  beforeApiCall?(ctx: ApiCallContext): MaybePromise<void | ApiCallOverride>;
  afterApiCall?(ctx: ApiCallResultContext): MaybePromise<void>;

  onRequest?(ctx: RequestContext, next: RequestNext): Promise<Response>;
  onResponse?(ctx: ResponseContext): MaybePromise<Response | void>;

  onFileRead?(ctx: FileReadContext): MaybePromise<void | Uint8Array | string>;
  onFileWrite?(ctx: FileWriteContext): MaybePromise<void | Uint8Array | string>;

  onResolve?(ctx: ResolveContext): MaybePromise<ResolveResult | null | void>;
  onLoad?(ctx: LoadContext): MaybePromise<LoadResult | null | void>;
  onTransform?(ctx: TransformInput): MaybePromise<TransformResult | null | void>;

  onCommandRun?(ctx: CommandRunContext): MaybePromise<CommandResult | void>;
  onCommandOutput?(ctx: CommandOutputContext): MaybePromise<void>;

  onProcessSpawn?(ctx: SpawnOptions): MaybePromise<SpawnOptions | void>;
  onProcessExit?(ctx: { pid: Pid; code: number }): MaybePromise<void>;
}

export interface PluginContainer {
  use(plugin: MarsPlugin): Promise<void>;
  remove(name: string): Promise<void>;
  list(): MarsPlugin[];

  callHook<K extends keyof MarsPlugin>(
    hook: K,
    ...args: HookArgs<K>
  ): Promise<HookResult<K>>;
}
```

设计要求:

1. `onRequest` 使用洋葱模型，类似 Koa middleware。
2. `beforeApiCall` 可以短路默认实现，用于权限控制、审计、mock 和记录。
3. `onFileRead` / `onFileWrite` 可以替换文件内容，用于加密、同步、访问控制。
4. `onResolve` / `onLoad` / `onTransform` 对齐 Vite/Rollup 插件心智。
5. 所有 Hook 上下文都应包含 `traceId`、`pid`、`cwd`、`pluginName` 和 `runtimeId`。

插件示例:

```ts
export default function auditPlugin(): MarsPlugin {
  return {
    name: "audit",
    async onFileWrite(ctx) {
      console.log("write", ctx.path, ctx.pid);
    },
    async onRequest(ctx, next) {
      const response = await next(ctx.request);
      response.headers.set("x-mars-plugin", "audit");
      return response;
    },
  };
}
```

## 15. MarsShell 与 AI Agent 接口

MarsShell 是可编程命令执行器，不只是终端 UI。

```ts
export interface MarsShell {
  cwd(): string;
  cd(path: string): Promise<void>;

  run(command: string, options?: ShellRunOptions): Promise<CommandResult>;
  stream(command: string, options?: ShellRunOptions): AsyncIterable<ShellChunk>;

  registerCommand(command: ShellCommand): Disposable;
  complete(input: string, cursor: number): Promise<CompletionResult>;
  history(): ShellHistoryEntry[];
}

export interface ShellCommand {
  name: string;
  description?: string;
  usage?: string;
  run(ctx: CommandContext): Promise<CommandResult> | CommandResult;
  complete?(ctx: CompletionContext): Promise<CompletionItem[]> | CompletionItem[];
}

export interface CommandContext {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
  vfs: MarsVFS;
  kernel: MarsKernel;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  json?: unknown;
}
```

内置命令:

```text
fs:      ls, cd, pwd, cat, echo, mkdir, rm, cp, mv, touch
search:  grep, find
process: ps, kill
network: curl, wget
pkg:     install, add, remove, list
runtime: bun, bun run, node, tsx, vite
agent:   inspect, snapshot, restore, hooks
```

AI Agent 推荐使用结构化输出:

```ts
const result = await mars.shell.run("grep -R hello src", {
  structured: true,
});

// result.json = { matches: [{ file, line, column, text }] }
```

## 16. Vite + React + TypeScript 支持

Mars-lib M1 不需要完整运行 Node 版 Vite 的所有内部实现，建议实现 Vite Dev Server 协议兼容层。

```ts
export interface DevServer {
  listen(port?: number): Promise<void>;
  close(): Promise<void>;

  transformRequest(url: string): Promise<TransformResult | null>;
  loadModule(url: string): Promise<Response>;
  handleHMRUpdate(file: string): Promise<HMRUpdate[]>;
}

export interface HMRChannel {
  send(payload: HMRPayload): void;
  onMessage(listener: (payload: HMRPayload) => void): Disposable;
}
```

M1 支持范围:

1. `/@vite/client`。
2. `/src/App.tsx` 和普通 TS/TSX 模块 transform。
3. `/node_modules/.vite/deps/*` 预构建缓存。
4. WebSocket HMR payload。
5. `vite.config.ts` 核心字段: `root`、`plugins`、`resolve.alias`、`define`、`server.hmr`。

### 16.1 Vite TypeScript React Example 项目

为统一运行模块用例和测试用例，新增 `examples/vite-typescript-react/` 作为标准示例工程。

目标:

1. 提供各模块可视化运行用例（module cases），便于功能联调与回归复现。
2. 提供各模块自动化测试用例（test cases），便于 CI 持续验证。
3. 保证模块用例和测试用例共用同一套 runtime 启动路径、fixture 与插件配置。

建议约定:

1. 每个核心模块至少提供 1 个 `module case` 与 1 个对应 `test case`。
2. `src/module-cases/` 负责可运行页面或交互入口。
3. `tests/modules/` 负责模块级断言，`tests/acceptance/` 负责跨模块验收断言。
4. `fixtures/` 作为单一数据源，避免用例和测试各自维护重复 mock。

建议任务命名:

```bash
nx run vite-typescript-react:dev
nx run vite-typescript-react:test
nx run vite-typescript-react:test:acceptance
```

## 17. Package Installer 与离线缓存

MarsInstaller 负责 npm metadata、tarball cache、依赖解析和 VFS 中的 `node_modules` 写入。当前 `bun install` shell 命令是最小实现: 从 MarsVFS `package.json` 读取 dependencies/devDependencies，使用注入的 package cache 写入 `node_modules` 与 `mars-lock.json`；cache miss 时可通过 registry fetch provider 拉取 metadata 和 tarball bytes。真实 tgz 解包、lifecycle scripts、workspaces 和 Bun lockfile 完整兼容仍待补。

```ts
export interface PackageInstaller {
  install(options: InstallOptions): Promise<InstallResult>;
  resolvePackage(specifier: string, range: string): Promise<ResolvedPackage>;
  fetchTarball(pkg: ResolvedPackage): Promise<Uint8Array>;
  writeNodeModules(plan: InstallPlan): Promise<void>;
}

export interface InstallOptions {
  cwd: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  lockfile?: boolean;
  registry?: string;
  offline?: boolean;
}

export interface PackageCache {
  getTarball(key: string): Promise<Uint8Array | null>;
  setTarball(key: string, data: Uint8Array): Promise<void>;
  getMetadata(name: string): Promise<PackageMetadata | null>;
  setMetadata(name: string, metadata: PackageMetadata): Promise<void>;
}
```

验收项目应内置离线包缓存 fixture:

```text
playground/fixtures/npm-cache/
├── metadata.json
├── express-*.tgz
├── koa-*.tgz
├── vite-*.tgz
├── react-*.tgz
└── typescript-*.tgz
```

M2 验收要求 `metadata.json` 可被测试工具加载为离线 `PackageCache`，并能安装 Vite playground 所需的递归依赖。真实 tgz 解包可作为后续硬化项，但 fixture 不得只是未被测试读取的静态占位。

## 18. MarsCore Rust/WASM 边界

MarsCore 使用 Rust 实现确定性核心逻辑，但不直接暴露大量高层 JS 对象。推荐暴露稳定 syscall/hostcall ABI，由 JavaScript 层适配浏览器对象。

```rust
#[wasm_bindgen]
pub struct MarsCore {
    runtime_id: String,
}

#[wasm_bindgen]
impl MarsCore {
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> Result<MarsCore, JsValue>;

    pub fn init(&mut self) -> Result<(), JsValue>;

    pub fn syscall(&mut self, op: u32, payload: Uint8Array) -> Result<Uint8Array, JsValue>;

    pub fn dispatch_request(&mut self, request: JsValue) -> Promise;

    pub fn tick(&mut self) -> Result<(), JsValue>;

    pub fn dispose(&mut self);
}
```

Rust 内部模块:

```rust
mod vfs;
mod http;
mod shell;
mod process;
mod crypto;
mod sqlite;
mod module_loader;
mod hooks;
mod serde_protocol;
```

责任边界:

```text
JavaScript: Request/Response/WebSocket/Worker/IndexedDB/OPFS/MessageChannel
Rust: path normalize, shell parser, routing table, fs metadata, crypto hash, sqlite, command AST
```

## 19. 请求流转

### 19.1 Bun.serve

```text
用户代码调用 Bun.serve({ port: 3000, fetch })
  -> MarsRuntime beforeApiCall("Bun.serve")
  -> MarsKernel.allocatePort(port)
  -> MarsKernel.registerPort(pid, assignedPort, virtualServer)
  -> MarsServiceWorkerRuntime 更新端口映射
  -> 返回 Server 对象
```

### 19.2 浏览器访问虚拟服务

```text
browser fetch http://mars.localhost:3000/api
  -> Service Worker fetch event
  -> classifyRequest: virtual-server
  -> resolvePort(3000): pid
  -> dispatchToKernel(pid, Request)
  -> virtualServer.fetch(Request)
  -> MarsHooks.onResponse
  -> Service Worker respondWith(Response)
```

### 19.3 VFS 模块加载

```text
import "/src/App.tsx"
  -> Service Worker classifyRequest: module
  -> MarsVFS.readFile("/workspace/src/App.tsx")
  -> MarsResolver.resolve
  -> MarsTranspiler.transform
  -> Response(code, content-type: text/javascript)
```

## 20. 验收标准

### 20.1 Express

1. 在 VFS 中写入 Express 应用。
2. 执行 `bun server.ts` 或 `node server.js`。
3. 应用监听 3000 端口。
4. `fetch("http://mars.localhost:3000/")` 返回预期 HTML/JSON。
5. 支持 `res.send()`、`req.params`、中间件顺序。

### 20.2 Koa

1. 在 VFS 中写入 Koa 应用。
2. 支持 async middleware。
3. 请求上下文 `ctx.request`、`ctx.response`、`ctx.body` 行为符合验收样例。
4. 端口访问路径与 Express 一致。

### 20.3 Vite + React + TypeScript

1. VFS 中包含完整 Vite React TS 项目。
2. 执行 `bun run dev` 或 `vite --host 0.0.0.0`。
3. M2 验收需通过 loader 校验 first screen render model；真实浏览器 React 首屏在后续浏览器 profile 中继续硬化。
4. 修改 `src/App.tsx` 后触发 HMR。
5. HMR 不刷新整个运行时实例。

### 20.4 直接执行 TSX

1. VFS 中写入 `app.tsx`。
2. 执行 `bun app.tsx` 或 `tsx app.tsx`。
3. TSX 被正确转译并执行。
4. stdout 或虚拟 HTTP 服务输出符合预期。

### 20.5 AI Agent Shell

1. 通过编程接口执行 `ls`、`cd /tmp && cat test.txt`、`grep`。
2. 返回 `stdout`、`stderr`、`code` 和可选 `json`。
3. Hook 插件可以增加自定义命令。
4. 文件读取 Hook 可以注入加密/解密或访问控制。

### 20.6 浏览器兼容

1. 最新 Chrome 通过全部验收。
2. 最新 Firefox 通过不依赖 SharedArrayBuffer 的异步 fallback 验收。
3. 除静态资源 CDN 或预置 fixture 外，验收不依赖外部服务器。

### 20.7 Vite TypeScript React Example 用例覆盖

1. `examples/vite-typescript-react/` 必须覆盖各核心模块运行用例。
2. 每个模块必须在同项目内提供自动化测试用例。
3. 所有用例需可在本地与 CI 通过统一命令执行。
4. 新增模块时，必须同步新增对应 example 用例与测试用例。

### 20.8 Phase Playground 接入门禁

每个 Phase 标记为 `Done` 前，必须完成 playground 接入并同步文档。

门禁要求:

1. `playground/README.md` 必须登记该 Phase 的 playground 入口、入口文件、自动化验收文件和当前状态。
2. `playground/module-cases.json` 必须登记该 Phase 的功能模块用例，至少包含 Phase、模块名、playground 名称、入口文件、验收文件、状态和说明。
3. 对应 Phase acceptance test 必须真实加载或执行 playground 文件，不允许只放置静态占位。
4. Acceptance test 必须校验 `module-cases.json` 中的用例入口真实存在且可读取。
5. TS/TSX playground 必须纳入 typecheck，避免示例文件仅在运行时被字符串读取。
6. Phase todo 文档必须同步 playground 状态、功能模块用例和剩余缺口。
7. 若后续 Phase 依赖前一 Phase 未完成能力，只能标记为 prework/gated，不得宣称主线进入下一 Phase。

## 21. 验收测试接口

```ts
export interface AcceptanceCase {
  name: string;
  files: FileTree;
  setup?(runtime: MarsRuntime): Promise<void>;
  run(runtime: MarsRuntime): Promise<void>;
  assert(runtime: MarsRuntime): Promise<void>;
}

export interface AcceptanceRunnerOptions {
  browser: "chromium" | "firefox";
  persistence: "memory" | "opfs" | "indexeddb";
  offline: boolean;
}

export interface AcceptanceResult {
  name: string;
  passed: boolean;
  durationMs: number;
  logs: string[];
  error?: SerializedError;
}
```

### 21.1 Example 项目测试矩阵

`examples/vite-typescript-react/` 维护模块用例与测试矩阵，建议结构如下:

```ts
export interface ExampleCaseDefinition {
  id: string;
  module: string;
  caseType: "module" | "test" | "acceptance";
  entry: string;
  expected: string;
  tags?: string[];
}
```

执行要求:

1. `module` 用例用于人工联调与浏览器可视化验证。
2. `test` 与 `acceptance` 用例用于自动化断言与 CI 门禁。
3. 任何影响模块行为的改动，必须更新对应矩阵条目与断言。

## 22. 分阶段路线

### M1: Runtime 最小闭环

1. `MarsRuntime.boot()`。
2. MarsVFS 基础读写。
3. MarsKernel 进程表与端口表。
4. MarsServiceWorkerRuntime 请求转发。
5. `Bun.serve()`。
6. `node:http` 最小实现。
7. Express/Koa hello world。
8. Shell 基础命令。

### M2: 工程化项目运行

1. MarsResolver package exports/imports。
2. MarsTranspiler TS/TSX/JSX，默认通过 `@swc/wasm-web` 和 `@mars/shared` wasm loader 执行运行时转译。
3. ModuleLoader ESM/CJS bridge。
4. `.tsx` 直接执行。
5. MarsInstaller 离线 cache。
6. Vite React TS 首屏渲染。
7. Vite HMR。
8. 建立 `examples/vite-typescript-react/` 模块用例与测试用例矩阵。
9. 接入 `playground/core-modules`、`playground/README.md` 与 `playground/module-cases.json`，并由 Phase 2 acceptance test 真实读取和执行 playground fixture。

### M3: API 覆盖与稳定性

1. `Bun.spawn()` Worker 模拟。
2. `Bun.build()`，当前预研切片使用 `esbuild-wasm` transform 输出到 MarsVFS，并与 M2 的 SWC WASM 运行时转译路径保持分工。
3. `Bun.password`、`CryptoHasher`、`node:crypto` 子集。
4. `Bun.sql` / sqlite wasm，当前预研切片先提供 MarsVFS-backed SQL 子集与 tagged query，后续替换为原生 sqlite WASM 引擎。
5. WebSocket upgrade。
6. OPFS 持久化恢复。
7. Chrome/Firefox 全量验收。

### M4: AI Agent 与插件生态

1. Hook trace viewer。
2. Plugin registry。
3. Shell 结构化命令输出。
4. 文件系统策略插件。
5. Agent task replay。
6. Runtime snapshot/restore。

## 23. 风险与对策

### 23.1 Bun 全 API 覆盖成本高

对策: 以验收路径驱动 API 优先级，先实现 Express/Koa/Vite/TSX 所需能力，再维护 Bun API 兼容矩阵。

### 23.2 浏览器安全模型限制进程和网络

对策: `Bun.spawn()` 映射为受控 Worker 或内置命令；TCP/UDP 能力通过虚拟服务、WebSocket 或代理策略表达。

### 23.3 SharedArrayBuffer 可用性不稳定

对策: 提供 `sharedArrayBuffer: "auto"` 和异步 syscall fallback。Chrome 优先走 SAB，Firefox 验收走 fallback。

### 23.4 npm 生态兼容复杂

对策: M1/M2 使用离线 fixture 和重点依赖白名单；逐步扩展 resolver、installer、polyfill 覆盖。

### 23.5 Vite 行为复杂

对策: 优先实现 Vite Dev Server 协议兼容层，而不是完整复刻 Node 版 Vite 运行时。

## 24. 未决问题

1. MarsCore 是否必须承担 HTTP pipeline，还是由 TypeScript 层实现 HTTP adapter 更利于迭代？
2. `Bun.spawnSync()` 在无 SAB 环境下是否允许降级为抛错？
3. npm package installer 是否内置 registry client，还是通过可插拔 PackageProvider 实现？
4. Vite 插件 API 需要支持到什么程度才能覆盖目标项目？
5. Firefox 中 Service Worker 与 Module Worker 的组合限制是否需要单独 runtime profile？

## 25. 结论

Mars-lib 的核心不是一次性完整复制 Bun，而是构建一个面向浏览器、AI Agent 和工程化项目的 Bun 兼容运行时底座。稳定的模块边界应围绕 MarsRuntime、MarsCore、MarsBridge、MarsKernel、MarsVFS、MarsServiceWorkerRuntime、MarsLoader、MarsHooks 和 MarsShell 展开。

只要 Express、Koa、Vite React TS、TSX 执行和 AI Agent Shell 五条验收主线先跑通，Mars-lib 就具备可演进的工程基础。后续 Bun API 覆盖率、Node 兼容层、包管理、crypto、sqlite、WebSocket 等能力都可以作为独立模块持续增强。
