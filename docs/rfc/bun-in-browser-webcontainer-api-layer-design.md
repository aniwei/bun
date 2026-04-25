# Bun-in-Browser WebContainer API 调用层设计

| 字段 | 值 |
| --- | --- |
| 状态 | Draft |
| 版本 | v1 (2026-04-25) |
| 关联 RFC | bun-in-browser-webcontainer.md |
| 关联实施计划 | bun-in-browser-webcontainer-implementation-plan.md |
| 目标 | 将参考 WebContainer 架构落地为可实现、可测试的调用层契约 |

---

## 1. 结论与边界

本项目未缺失 WebContainer 架构参考与 API 形状设计。

- 架构参考已在 RFC 给出：Host Page / Service Worker / Kernel Worker / Process Workers。
- 模块级 API 已在模块设计文档给出：各包公开类与方法签名。

当前缺口是“调用层契约冻结”：

- 哪一层对外暴露什么 API。
- 层与层之间使用哪条通信通道。
- 错误码、事件名、流式数据协议是否稳定可测。

本文档用于填补该缺口，并作为 M4-M7 的实现依据。

---

## 2. 分层调用面

### 2.0 Initializer 驱动启动总线（新增）

目标：将当前“boot 内部条件执行”升级为“可扩展、可观测、可测试”的统一初始化总线。

冻结启动时序（v2）：

1. `BunContainer.boot(options)`
2. `Kernel.boot(config, vfs)`
3. `Kernel.initializer.run(context)`
4. `kernel.serviceWorker.register()`
5. 发布 `service-worker.register` hook
6. 容器状态转 `ready`

其中 `Kernel.initializer.run(context)` 至少包含以下阶段：

- wasm 初始化（transpiler/bundler 等）
- 发布 `boot` hook（插件可扩展）
- 计算 `serviceWorkerUrl`（默认来自 `@mars/web-sw` 导出）
- 其他初始化任务（按阶段注册）

建议抽象：

- `@mars/web-runtime` 已有 `ProcessBootstrap` initializer 队列，不建议重复实现。
- 建议抽离为共享初始化管线抽象（如 `@mars/web-shared` 中 `InitializerPipeline`），`runtime` 与 `kernel` 分别注册各自任务。
- 约束：仅复用“调度模型与生命周期语义”，不共享运行时私有状态对象。

示例接口（设计草案）：

```ts
type InitializerContext = {
  kernel: Kernel
  options: BunContainerBootOptions
  hooks: HookRegistry
  serviceWorkerUrl: string
}

type InitializerTask = {
  id: string
  order?: number
  shouldRun?: (ctx: InitializerContext) => boolean
  run: (ctx: InitializerContext) => void | Promise<void>
}

interface InitializerPipeline {
  register(task: InitializerTask): () => void
  run(ctx: InitializerContext): Promise<void>
}
```

### 2.1 Host SDK 层（对齐 WebContainer 风格）

对外入口：@mars/web-client

- BunContainer.boot(options)
- BunContainer.mount(files)
- BunContainer.spawn(cmd, args, options)
- BunContainer.on('server-ready', listener)
- BunContainer.teardown()

约束：

- Host 层不直接触达 Process Worker。
- Host 仅通过 SDK RPC 与 Kernel 控制面交互。
- 预览 iframe URL 仅由 server-ready 事件驱动更新。

Boot 可选参数补充（SW worker 脚本分发）：

```ts
type BunContainerBootOptions = {
  // ...existing fields
  serviceWorkerUrl?: string
  serviceWorkerRegisterOptions?: RegistrationOptions
  serviceWorkerScripts?:
    | Map<string, string | {
        source: string
        specifier?: string
        packageName?: string
        packageType?: 'module' | 'commonjs'
        moduleFormat?: 'auto' | 'esm' | 'cjs'
      }>
    | Record<string, string | {
        source: string
        specifier?: string
        packageName?: string
        packageType?: 'module' | 'commonjs'
        moduleFormat?: 'auto' | 'esm' | 'cjs'
      }>
  serviceWorkerScriptProcessor?: {
    process(input: {
      pathname: string
      descriptor: {
        source: string
        specifier?: string
        packageName?: string
        packageType?: 'module' | 'commonjs'
        moduleFormat?: 'auto' | 'esm' | 'cjs'
      }
      detectedModuleType: 'esm' | 'cjs'
    }): Promise<{ source: string; contentType?: string }> | { source: string; contentType?: string }
  }
  // 新增：控制初始化器任务集合
  initializers?: 'all' | string[]
}
```

Service Worker 注册路径说明：

- 主线程环境下，SDK 会调用 `navigator.serviceWorker.register(serviceWorkerUrl, serviceWorkerRegisterOptions)` 并等待 `navigator.serviceWorker.ready`。
- 若未提供 `serviceWorkerUrl`，默认使用 `@mars/web-sw` 导出的 `DEFAULT_WEB_SW_SERVICE_WORKER_URL`（当前值 `'/@mars/web-sw/sw.js'`），解析失败时回退到 `'/sw.js'`。
- 当前实现不会通过 boot 选项注入 `serviceWorkerScope`；该字段已移除。
- 只有在 Service Worker 全局上下文可用时，才会在该上下文安装 fetch/install/activate 拦截桥接。

新增约束（Kernel 持有 serviceWorker 成员）：

- `kernel.serviceWorker` 为唯一 SW 控制入口，封装 `navigator.serviceWorker`。
- Host 与插件不得直接绕过该成员调用 `navigator.serviceWorker.*`。
- 注册成功后必须发布 `service-worker.register` hook。

示例（package CJS 脚本在 SW 转为 ESM 后返回）：

```ts
const container = await BunContainer.boot({
  serviceWorkerUrl: '/sw.js',
  serviceWorkerRegisterOptions: { scope: '/' },
  serviceWorkerScripts: {
    '/__bun__/worker/pkg.js': {
      source: 'module.exports = 7',
      packageName: 'pkg',
      packageType: 'commonjs',
    },
  },
  serviceWorkerScriptProcessor: {
    async process(input) {
      if (input.detectedModuleType === 'cjs') {
        return { source: `export default (${JSON.stringify(input.descriptor.source)})` }
      }
      return { source: input.descriptor.source }
    },
  },
})
```

默认行为说明：

- 若 `serviceWorkerScriptProcessor` 未提供，命中 `serviceWorkerScripts` 的脚本会按原始 `source` 返回。
- `detectedModuleType` 仍会被判定（用于可观测与后续扩展），但不会触发自动 CJS->ESM 转译。
- 因此 CJS 自动转译是显式 opt-in 能力，而不是隐式默认行为。

`detectedModuleType` 判定优先级（高 -> 低）：

1. `moduleFormat` 显式值（`esm` / `cjs`）
2. `specifier`/pathname 扩展名（`.mjs/.mts` -> esm，`.cjs/.cts` -> cjs）
3. `packageType`（`module` -> esm，`commonjs` -> cjs）
4. `packageName` 存在时默认按 package cjs 处理
5. 兜底 `esm`

输入校验约束（boot 阶段快速失败）：

- `serviceWorkerScripts` 的 key 必须是绝对 pathname（以 `/` 开头）。
- descriptor 形态时必须提供 `source: string`。
- 校验失败时抛稳定错误前缀：`[BunContainer.boot] serviceWorkerScripts...`，用于测试与日志检索。

### 2.2 Kernel 控制面

对内入口：@mars/web-kernel

- spawn / kill / waitpid
- registerPort / resolvePort / unregisterPort
- onStdio / processExit
- use(plugin) / registerShellCommand / unregisterShellCommand / hasShellCommand
- bun 子命令路由（run/add/install/i）
- installer 编排入口（manifest->lockfile/layout）

约束：

- 控制面消息必须可重放且幂等。
- 同 pid attachProcessPort 为替换语义。
- 进程退出后自动解绑 stdio 与 port 监听。
- Kernel 实例必须持有唯一 command registry；外部命令扩展统一通过 `use(plugin)` 注入。
- `bun add/install/i` 必须在 kernel 控制面分发；禁止在 SW 与 process-executor worker 中实现包管理语义。

新增能力（ServiceWorkerController）：

- `kernel.serviceWorker.register()`
- `kernel.serviceWorker.unregister()`
- `kernel.serviceWorker.getRegistration()`
- `kernel.serviceWorker.getRegistrations()`
- `kernel.serviceWorker.postMessageToActive(message, transfer?)`

新增 hook 事件：

- `boot`
- `service-worker.before-register`
- `service-worker.register`
- `service-worker.register.error`

### 2.3 Service Worker 网络面

对内入口：@mars/web-sw

- fetch 拦截并路由到虚拟端口。
- 将 request body 流桥接到目标进程。
- 将 response body 流回传给页面。

约束：

- 对外部 origin 请求透传。
- 对内路由仅依赖 Kernel 端口表。
- SW 重启后通过心跳与重建流程恢复路由状态。
- SW 仅负责网络路由与 worker 脚本分发，禁止承载 bun CLI 包管理语义。

新增模块请求拦截契约：

- SW 仅拦截“明确命名空间”的模块请求，禁止泛匹配。
- 建议命名空间：`/__bun__/modules/*`（与虚拟服务路由 `__bun__/:port` 区分）。
- 非命名空间请求一律透传或按既有虚拟端口路由处理。
- 命中模块请求后，SW 不直接解析模块，必须通过 `postMessage` 请求 kernel。

### 2.4 Process 运行面

对内入口：@mars/web-runtime + @mars/web-node

- Bun.serve lifecycle
- node:http / node:net 映射
- stdio 输出与 exit 通知
- shell command registry（register / unregister / tryExecute / execute / has）
- shell hook 注册入口（hook 向 registry 注入命令）

约束：

- 业务输出走 MessagePort 控制面，不进入 SAB 数据面。
- 同步 FS/NET syscall 仅走 SAB 桥。
- shell 执行面必须先经 registry 查询命令，再进入 builtin/hook 注册实现。
- hook 仅通过 registry 注册命令，不直接改写 runtime 内部状态。
- `web-shell` 负责 registry 与 builtin 命令装配（包内模块）；kernel 不再内联 builtinHook。
- `bun` 命令归属 kernel：由 kernel 在其自持 registry 中注册，并强制委托 `processExecutor`（process worker 路径）执行。
- `processExecutor` 的主职责是 Worker 中的脚本执行（如 `bun run`）；`bun add/install/i` 由 kernel 控制面路由到 installer 能力。
- 禁止在 shell builtin 层通过 `AsyncFunction` 直接执行 `bun` 脚本，以避免偏离 webcontainer.io 的 Process Worker 架构。
- `processExecutor` 的 bun 路径必须 worker-only 执行；禁止 inline fallback 到主线程 `AsyncFunction`。
- VFS 在多 Worker 场景必须共享同一逻辑视图：状态源统一由 kernel/vfs 持有，worker 通过 syscall/RPC 访问，不允许每个 worker 维护独立主文件树。
- 进程局部状态（cwd/env/fd/stdio 缓冲）必须保持 worker 私有，不与其他 worker 共享。
- Process Worker 启动必须经过 `ProcessBootstrap` 初始化队列；初始化任务通过注册机制串行执行。
- 浏览器场景下转译初始化（swc-wasm）作为队列任务在启动阶段执行；禁止回退到 Bun.Transpiler/fallback。
- 浏览器场景下构建初始化（esbuild-wasm）可作为队列任务在启动阶段执行（`runtime-bundler-init`）；支持 `initializeBundler` 与 `bundlerInit` 参数透传。
- 初始化队列支持按 initializer id 选择执行（`bootstrapInitializers`），用于最小化启动任务集合与分场景启动策略。
- build 调用层在浏览器路径必须使用 `esbuild-wasm` 并先完成显式初始化（`initEsbuildWasm`）；禁止使用 `Bun.build` 作为运行时兜底。
- build 调用层支持 `chunkMerge` 策略化摘要：`metadata`（全量 entry+chunk）、`entry-only`（仅 entry 摘要，并报告省略 chunk 数）与 `size-buckets`（按体积分桶统计 tiny/small/medium/large）。
- swc/esbuild 的 wasm 模块加载与获取必须复用共享抽象（`@mars/web-shared` 的 `WasmModuleLoader`），统一 loader 缓存、并发加载与 reset 语义；业务模块仅保留各自 init 门禁与能力校验。
- esbuild 浏览器初始化允许通过 `globalThis.__BUN_WEB_ESBUILD_WASM__` 注入 `wasmURL/wasmModule/worker`；未显式设置 `worker` 时，浏览器 runtime 默认 `worker=true`，非浏览器 runtime 默认 `worker=false`。
- 插件 Hook 引擎统一采用 HookRegistry：支持 `register/on/registerAll`、`disable/enable`、`unregister/clear` 与 preset 注入，禁止在 bundler/runtime 中各自维护私有 hook 容器。
- Hook 调度强制分为 `execute(interceptor)` 与 `emit(observer)` 两条路径；运行时按 priority 升序调度，hook 抛错仅日志记录，不中断后续 hook。

### 2.4.1 Worker 代码分发（SW + Kernel）

- 允许通过 Service Worker 拦截 Worker 脚本请求，并将请求转发到 kernel 统一解析后返回脚本内容。
- Worker 脚本分发仅作为代码加载通道；执行仍在 Worker 上下文完成，禁止在 SW 或主线程执行脚本字符串。
- kernel 返回内容必须带版本戳/etag（或等价 hash）用于缓存一致性；SW 可缓存但不得越过 kernel 权限与路径校验。
- 该通道失败时返回稳定错误码（如 `ERR_BUN_WEB_WORKER_SCRIPT_UNAVAILABLE`），禁止静默回退到 inline eval。

### 2.5 模块职责与精确调用矩阵

参考基线：

- https://webcontainers.io/api
- https://webcontainers.io/guides/introduction

| 模块 | 上游调用（谁调用它） | 下游调用（它调用谁） | 模块作用 | 必须稳定的契约 |
| --- | --- | --- | --- | --- |
| `@mars/web-client` | Host App（React/Vite 页面） | `@mars/web-kernel`（控制面 RPC，目标态） | 对外 SDK，暴露 boot/mount/spawn/on/teardown 风格 API | 不直接触达 Process Worker；事件名与回调参数稳定 |
| `@mars/web-kernel` | `@mars/web-client`、`@mars/web-runtime`、`@mars/web-sw` | `@mars/web-vfs`、`SyscallBridge` | 进程表、PID、端口路由、stdio/exit 生命周期总线 + command registry 持有者 | `spawn/kill/waitpid`、`registerPort/resolvePort` 与 `use(plugin)` 注入语义幂等 |
| `@mars/web-vfs` | `@mars/web-kernel`、`@mars/web-node`、installer | OPFS/内存层适配器 | 三层文件系统（base/persist/mem）和 watch 总线 | path 规范化、ENOENT/权限错误语义与 watch 事件稳定 |
| `@mars/web-runtime` | `@mars/web-client`（目标态经 kernel 调度）、测试 harness | `@mars/web-kernel`、`@mars/web-node`、`@mars/web-shell`、`@mars/web-bundler`、`@mars/web-transpiler` | Process Worker 启动编排、Bun.serve 生命周期、spawn 句柄装配、脚本执行 worker | `spawn` 句柄（stdout/stderr/exited/kill）与 `server-ready` 事件稳定；不承载 add/install/i 包管理语义 |
| `@mars/web-node` | `@mars/web-runtime`、用户脚本 | `@mars/web-vfs`、`@mars/web-webapis`、`@mars/web-resolver` | Node 兼容层（fs/path/module/events/stream 等） | A/B 级 API 行为回放稳定，D 级明确抛错 |
| `@mars/web-sw` | 浏览器 SW 全局事件（install/activate/fetch） | `@mars/web-kernel` | 网络入口：fetch 路由、请求/响应流桥接、心跳恢复、worker 脚本分发拦截 | 对外 origin 透传；对内仅基于 kernel 端口表；不承载 bun CLI 命令语义 |
| `@mars/web-net` | `@mars/web-runtime`、`@mars/web-node` | `@mars/web-dns`、隧道适配 | net/http/ws/tls 连接能力与降级策略 | 无隧道时统一 NotSupportedError；有隧道时连接语义稳定 |
| `@mars/web-dns` | `@mars/web-net`、`@mars/web-node` | 浏览器 DNS 能力或 stub | DNS 查询与 host 解析适配 | 失败语义（NXDOMAIN/ENOTFOUND）统一映射 |
| `@mars/web-shell` | `@mars/web-runtime`、`@mars/web-agent` | builtin command 模块（包内）与 HookRegistry | shell 命令执行与内置命令注册 | `register/has/execute` 语义与 stderr/exitCode 稳定 |
| `@mars/web-bundler` | `@mars/web-runtime`、上层工具 API | `esbuild-wasm`、`@mars/web-shared` loader | 浏览器内 build 能力和产物摘要 | 仅走 wasm 路径；`chunkMerge` 策略稳定 |
| `@mars/web-transpiler` | `@mars/web-runtime`、`@mars/web-bundler` | swc wasm、`@mars/web-shared` loader | TS/JSX 转译 | init 显式门禁 + 转译错误结构稳定 |
| `@mars/web-installer` | Host/CLI 安装入口、kernel bun 包管理路由 | `@mars/web-vfs`、`@mars/web-resolver` | npm metadata/tarball/lockfile/node_modules 布局 | integrity、重试、frozen-lockfile 语义稳定 |
| `@mars/web-proxy-server` | 外部预览/反向代理场景 | `@mars/web-sw`、目标服务 | 可选代理层（Node/Deno/Bun） | 仅作为可选旁路，不破坏默认 SW 主路径 |

### 2.6 端到端调用序列（精确到模块）

#### A. Boot 链路（对齐 WebContainer.boot）

1. Host 调用 `@mars/web-client` `BunContainer.boot(options)`。
2. `@mars/web-client` 创建控制面通道（目标态：SharedWorker/ServiceWorker + MessagePort）。
3. `@mars/web-kernel` `boot()` 初始化进程表、端口表、stdio 总线、SAB bridge。
4. `@mars/web-kernel` 运行 InitializerPipeline：wasm 初始化、发布 `boot` hook、计算 `serviceWorkerUrl`、其他任务。
5. `@mars/web-kernel` 调用 `kernel.serviceWorker.register()` 并发布 `service-worker.register` hook。
6. `@mars/web-runtime` 完成 ProcessBootstrap 初始化队列（transpiler/bundler 可选）。
7. `@mars/web-client` 接收 ready 信号，容器状态转 `ready`。

#### A.1 模块请求链路（新增）

1. 页面或 Worker 请求 `'/__bun__/modules/<specifier>'`。
2. SW `fetch` 命中模块命名空间，构造 `ModuleRequestMessage` 并 `postMessage` 到 kernel。
3. kernel 解析 specifier、加载模块源码或二进制产物，生成 `ArrayBuffer`。
4. kernel 回发 `ModuleResponseMessage`（含 contentType/status/headers/buffer）。
5. SW 将返回数据封装为 `Response` 并回给请求方。

消息协议（草案）：

```ts
type ModuleRequestMessage = {
  type: 'MODULE_REQUEST'
  requestId: string
  pathname: string
  method: string
  headers: Array<[string, string]>
}

type ModuleResponseMessage = {
  type: 'MODULE_RESPONSE'
  requestId: string
  status: number
  headers: Array<[string, string]>
  contentType?: string
  buffer?: ArrayBuffer
  error?: string
}
```

协议约束：

- `requestId` 必须全局唯一并一一对应。
- `buffer` 使用 Transferable 传输，避免拷贝。
- kernel 处理失败必须返回结构化错误，不允许 SW 静默降级。

#### B. Mount 链路（对齐 WebContainer.mount）

1. Host 调用 `@mars/web-client` `mount(files)`。
2. `@mars/web-client` 发送 mount RPC 到 `@mars/web-kernel`。
3. `@mars/web-kernel` 委托 `@mars/web-vfs` 落盘（mem/persist 层）并产生 watch 事件。
4. `@mars/web-client` 收到 file-change 事件，触发 UI/预览更新。

#### C. Spawn 链路（对齐 WebContainer.spawn）

1. Host 调用 `@mars/web-client` `spawn(command, args, opts)`。
2. `@mars/web-client` 发送 spawn RPC 到 `@mars/web-kernel`。
3. `@mars/web-kernel` 分配 pid 与 stdio channel，并调用 `@mars/web-runtime` `spawn`。
4. `@mars/web-runtime` 通过 `RuntimeProcessSupervisor` 启动 Process Worker。
5. `@mars/web-kernel` 通过 `executeProcess` 将 argv 委托给 `processExecutor`。
6. `processExecutor` 在 Worker 中执行 bun 脚本，并通过消息回传 `registerPort/result`。
7. Process Worker 经 `@mars/web-node/@mars/web-shell` 执行脚本/命令。
8. stdio 通过 MessagePort 回传 `@mars/web-kernel`，再转发给 `@mars/web-client` `ContainerProcess.output`。
9. 进程退出后 `processExit` 回传，`exited` promise resolve。

### 2.6.1 控制面整体架构流程（冻结）

1. Host 仅通过 `@mars/web-client` 调用 `boot/mount/spawn/on/shutdown`。
2. `@mars/web-client` 仅调用 `@mars/web-kernel.handleCommand(...)`，不直接执行命令。
3. `@mars/web-kernel` 统一维护进程/端口/stdio 生命周期，并发布 `processExit/portRegistered/stdio` 事件。
4. 命令执行固定入口是 `executeProcess -> processExecutor`，其中 bun 脚本必须在 Worker 执行。
5. `@mars/web-runtime.spawn` 负责进程句柄与生命周期编排，不承担 argv 执行职责。
6. `@mars/web-sw` 仅根据 kernel 端口表做预览路由，`server-ready` 由 `portRegistered` 驱动。
7. `bun add/install/i` 走 `@mars/web-kernel` 控制面并复用 `@mars/web-installer`，不进入 SW 路由语义与 process-executor worker 执行语义。

#### D. 预览链路（对齐 server-ready / port 事件）

1. Process 内 `Bun.serve`（`@mars/web-runtime`）监听端口。
2. `@mars/web-kernel` 记录 `registerPort(pid, port)`。
3. `@mars/web-sw` 拦截 fetch，根据端口表路由到目标 pid。
4. 请求体流桥接到进程，响应流回传到页面 iframe。
5. `@mars/web-client` 触发 `server-ready`，`PreviewManager` 更新 iframe URL。

### 2.7 对齐 webcontainers.io 的 API 契约映射

| webcontainers.io API | 本项目对应 API | 当前状态 | 差距与动作 |
| --- | --- | --- | --- |
| `WebContainer.boot(options)` | `BunContainer.boot(opts)` | 已有 API 外形 | 需完成 client->kernel 真正 RPC 接线 |
| `mount(tree)` | `BunContainer.mount(files)` | 已有 API 外形 | 需切到 kernel/vfs 实际持久链路 |
| `spawn(command,args,opts)` | `BunContainer.spawn(...)` | 已有 API 外形 | 需切到 runtime supervised process 主链路 |
| `on('server-ready'|'error'|'port'...)` | `on('server-ready'|'process-exit'|'file-change')` | 部分对齐 | 增补 `error/port/preview-message` 事件模型 |
| `teardown()` | `shutdown()` | 语义可对齐 | 对齐命名与资源释放边界（可在适配层统一） |

---

## 3. 通信通道与协议

### 3.1 控制面通道

MessagePort / postMessage

- 事件：stdio, processExit, server-ready
- 命令：spawn, kill, registerPort

最小事件载荷：

- server-ready: { pid, port, url }
- stdio: { pid, kind, data }
- processExit: { pid, code }

### 3.2 数据面通道

SharedArrayBuffer + Atomics

- 用于同步 syscall 请求/响应。
- 不承载日志流和生命周期事件。

### 3.3 流式网络通道

ReadableStream / WritableStream

- Request body: SW -> Process
- Response body: Process -> SW -> Page

### 3.4 Worker 代码加载通道（可选）

- `Worker(url)` -> SW `fetch` 拦截 -> kernel `resolveWorkerScript(url)` -> 返回 JS 源码响应。
- SW 负责缓存与回源策略，kernel 负责权限、路径与版本一致性。
- 该通道只负责“加载”，不改变 `executeProcess -> processExecutor -> Worker` 的执行主链。
- 该通道不承载 `bun add/install/i` 包管理语义；仅用于 Worker 脚本加载。
### 3.5 SW ↔ Kernel 端口路由接口（A0-5 冻结）

```ts
// Duck-type 接口，SW 无需 hard dep @mars/web-kernel / @mars/web-runtime
type KernelSwBridge = {
  resolvePort(port: number): number | null
  subscribe(event: 'portRegistered', listener: (payload: { pid: number; port: number; host: string; protocol: 'http' | 'https' }) => void): () => void
}
type ServeHandlerRegistry = {
  getHandler(port: number): ((request: Request) => Promise<Response> | Response) | null
}

// 从 kernel 生成 PortResolver
function createKernelPortResolver(kernel: { resolvePort(port: number): number | null }): PortResolver

// 从 URL 中提取 path-style 端口（/__bun__/<port>/...）
function extractVirtualPort(url: URL): number | null

// 生成 DispatchToKernel：path-style 优先，host-style 用 pidPortMap 兜底
function createKernelDispatcher(registry: ServeHandlerRegistry, pidPortMap: ReadonlyMap<number, number>): DispatchToKernel

type WorkerScriptDescriptor = {
  source: string
  specifier?: string
  packageName?: string
  packageType?: 'module' | 'commonjs'
  moduleFormat?: 'auto' | 'esm' | 'cjs'
}
type WorkerScriptStore = Map<string, string | WorkerScriptDescriptor>
type WorkerScriptProcessor = {
  process(input: {
    pathname: string
    descriptor: WorkerScriptDescriptor
    detectedModuleType: 'esm' | 'cjs'
  }): Promise<{ source: string; contentType?: string }> | { source: string; contentType?: string }
}

// 组合管理器：统一 install/activate/fetch，先脚本拦截后 kernel 路由
class WebServiceWorkerManager {
  install(): () => void
  uninstall(): void
}

// 全链路集成入口（订阅 portRegistered 维护 pid→port map，cleanup 解订）
function installKernelServiceWorkerBridge(
  kernel: KernelSwBridge,
  target: ServiceWorkerGlobalLike,
  handlerRegistry: ServeHandlerRegistry,
  options?: { workerScripts?: WorkerScriptStore; scriptProcessor?: WorkerScriptProcessor }
): () => void
```

补充约束：

- SW 启动后默认开启网络拦截，路由顺序为：worker script -> virtual bun route -> fetch passthrough。
- package 脚本加载需要先判定 CJS/ESM：`.mjs/.mts` 视为 ESM，`.cjs/.cts` 视为 CJS；`.js` 结合 `package.type` 判定。
- 判定为 CJS 的脚本在 SW 层通过脚本处理器转译为 ESM（推荐 esbuild-wasm transform）。
---

## 4. 错误模型

统一错误分层：

- ERR_BUN_WEB_UNSUPPORTED: API 等级不支持。
- ERR_BUN_WEB_SYNC_UNAVAILABLE: 无 SAB 时同步调用不可用。
- NotSupportedError: 需要可选隧道但未配置。

要求：

- Host SDK 只暴露稳定错误码，不泄漏内部实现细节。
- 跨层传输错误时保留 code 与 message。

---

## 5. M4-M7 落地映射

- M4: 固化 SW <-> Kernel <-> Runtime 的 HTTP/WS 调用链。
- M5: 固化 spawn 与 shell 的控制面协议，并冻结 registry/hook 扩展点。
- M6: 固化 build/test/sqlite 的调用入口与错误回传。
- M7: 固化 Host SDK 对外 API，并对齐 WebContainer 风格。

---

## 6. 最小验收清单

### 6.1 架构验收

- 通过 SDK 启动容器并注册 server-ready。
- SW 能将预览请求路由到目标 pid。
- 进程退出后端口路由自动失效。

### 6.2 API 调用层验收

- BunContainer.boot/mount/spawn/on 在真实用例链路可用。
- Bun.serve start/stop/reload 生命周期可观测。
- node:http 基础请求与响应流式回传可用。

### 6.3 失败语义验收

- 无 tunnelUrl 时 TCP 相关调用返回 NotSupportedError。
- 无 SAB 环境下同步 syscall 返回 ERR_BUN_WEB_SYNC_UNAVAILABLE。

---

## 7. 后续维护规则

- 任何跨层事件名、载荷结构变更，先改本文档再改代码。
- M4-M7 每轮推进需在实施计划记录“本轮新增调用层验收项”。
- 与 RFC 或模块设计冲突时，以“先更新文档契约，再实现”为准。
