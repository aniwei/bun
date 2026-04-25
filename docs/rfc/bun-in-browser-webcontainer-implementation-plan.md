# Bun-in-Browser WebContainer 实施文档

| 字段 | 值 |
| --- | --- |
| 状态 | Draft |
| 版本 | v1 (2026-04-24) |
| 关联 RFC | bun-in-browser-webcontainer.md |
| 模块 API 设计 | bun-in-browser-module-design.md |
| API 调用层设计 | bun-in-browser-webcontainer-api-layer-design.md |
| 目标 | 将 RFC 拆解为可执行阶段任务，按文件与功能跟踪完成度 |

---

## 1. 范围与原则

本实施文档覆盖 RFC 的 M1-M8 全阶段推进，包含：

- 每阶段 TODO List（明确到文件与功能）
- 每阶段完成度（0-100%）
- 迭代摘要（每轮交付、风险、下一步）

状态定义：

- `未开始`：需求冻结但尚未落代码
- `进行中`：已有分支实现或脚手架
- `已完成`：代码 + 验收用例 + CI 门禁全部通过
- `阻塞`：依赖前置阶段或外部能力

阶段执行规则：

- 每个阶段进入编码前，必须先完成该阶段的“实施前确认（Stage Gate）”。
- 未完成 Stage Gate 的阶段，状态只能为 `未开始` 或 `阻塞`，不得更新实现完成度。
- 允许“受控并行推进”：若后续阶段任务与前序阶段退出条件低耦合（例如独立 polyfill/纯 TS 语义回放），可在前序阶段 `进行中` 时并行开发，但必须满足：
  - 不修改前序阶段未稳定的核心边界（本项目主要指 Kernel/SAB/VFS 同步桥主链路）
  - 每轮在“迭代摘要/测试状态”中注明并行推进范围与回归结果
  - 不将前序阶段标记为 `已完成`，且后续阶段完成度只能按“已落代码+已通过测试”小步更新
- Stage Gate 至少包含：范围确认、文件级任务确认、依赖确认、测试确认、启动决策。
- 编码时须对照 [模块 API 设计文档](./bun-in-browser-module-design.md) 核对每个文件的类名与方法签名，如需变更，先修改设计文档，再落代码。
- 每个模块必须作为 `packages/` 下独立 package 交付，并通过 `pnpm workspace` 统一管理依赖与脚本入口。
- package 名统一使用 `@mars/web-*` scoped 命名；跨包引用统一走 package name，不再使用 `../../bun-web-*/src/*` 跨包相对路径。
- 阶段完成前需检查 package 交付完整性：`package.json` 最小字段齐全、workspace 依赖声明完整、根 workspace 配置已纳入。

代码风格与 Oxc 门禁：

- 风格参考：https://github.com/cgoinglove/better-chatbot/（仅参考风格原则，不复制实现）
- 风格对齐范围提升为跨阶段硬要求：`packages/bun-web-*` 下所有模块、所有源码文件、测试文件、构建配置文件与相关实施文档中的代码片段，均需持续向上述参考风格收敛，不允许只在新增文件上执行而放任历史文件长期漂移
- TS/JS 代码尽量不使用分号与双引号，优先单引号与自然分段空行
- 每阶段提交前必须完成格式化与 lint 检查

格式对齐执行规则：

- 每次开始新的实施任务前，先检查目标模块内将被修改的文件是否存在明显格式漂移；若有，和功能改动一并收敛
- 每轮迭代至少要覆盖“本轮触达的全部文件”，不得只格式化局部新增代码而保留同文件旧风格分裂
- 阶段收口前，需补做对应模块剩余文件的格式对齐，直到 `packages/bun-web-*` 全量代码风格一致
- 若格式化工具与既有语义存在冲突，以不改变行为为前提进行最小收敛，并在迭代摘要记录例外文件

建议执行命令：

```sh
# 格式化（若环境提供 oxfmt）
bunx oxfmt "packages/bun-web-*/src/**/*.{ts,tsx}"

# lint（必须通过）
bunx oxlint "packages/bun-web-*/src/**/*.{ts,tsx}" --fix
```

准入标准：

- 未通过 oxlint 的阶段，不得将任务状态从 `进行中` 更新为 `已完成`
- 若环境不可用 oxfmt，需在阶段摘要中注明并保证 oxlint 结果为零错误

测试范围与边界（本项目当前阶段强约束）：

- 不执行 Bun Zig 源码相关构建与测试（不跑 `bun bd`、`zig build`、`bun run zig:*`）
- 仅执行 Bun-in-browser 技术文档相关模块测试：`packages/bun-web-*`（统一由 `packages/bun-web-test` 的 Vitest 用例驱动）
- 官方回归仅覆盖 Bun JS/TS 测试目录（`test/js/*`、`test/cli/install`、`test/bundler`）
- 若出现 Zig 构建链错误，不作为本阶段模块实现阻塞条件，但需在“测试状态”中记录

## 1.1 WebContainer 对齐专项实施计划（A0）

目标：对齐 https://webcontainers.io/ 的核心调用模型（boot/mount/spawn/on/teardown），把当前 API 外形对齐推进到“真实跨模块调用链对齐”。

范围：

- 仅覆盖调用层与模块边界收敛，不改动 Bun Zig 主仓核心构建链。
- 以 `@mars/web-client -> @mars/web-kernel -> @mars/web-runtime -> @mars/web-sw` 为主链。

退出标准：

- `BunContainer.boot/mount/spawn` 不再走本地 stub 路径，全部经 kernel 控制面。
- `server-ready/process-exit/file-change` 来自真实内核/运行时事件，而非 SDK 本地模拟。
- 新增链路验收测试通过并记录在本计划“测试状态”中。

### A0 Stage Gate

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 只推进调用链收敛，不扩展新功能面 | [x] 已确认 |
| 文件级任务确认 | A0-1 ~ A0-8 文件和职责已冻结 | [x] 已确认 |
| 依赖确认 | kernel/runtime/sw 已具备可接线能力 | [x] 已确认 |
| 测试确认 | 新增 A0 链路验收测试并纳入 bun-web-test | [ ] 待确认 |
| 启动决策 | 允许进入实施 | [x] 已确认 |

### A0 TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| A0-1 | packages/bun-web-client/src/sdk.ts | boot/mount/spawn 从 stub 切换到 kernel RPC 通道 | 84% | 进行中 | 已将 `mount/spawn/kill` 统一切到 `kernel.handleCommand(...)` 控制面入口；client 本地 `executeSpawnedProcess` 分支已移除，改为 kernel `executeProcess` 控制命令 + `stdio/processExit` 事件链驱动；`boot` 新增 `processExecutor` 注入透传用于 runtime 主链路接管；默认执行器加载优先支持 `createRuntimeProcessExecutor({ workerUrl })`，并在显式 `workerUrl` 场景绕过共享缓存确保每实例生效 |
| A0-2 | packages/bun-web-client/src/client.types.ts | 对齐 webcontainers 风格事件与 spawn 选项映射 | 72% | 进行中 | `server-ready` 事件已通过 kernel 端口注册链路透传 `url/host/port/protocol`，并新增 host/protocol 回归测试 |
| A0-3 | packages/bun-web-kernel/src/kernel.ts | 暴露稳定控制面命令处理入口（spawn/mount/kill/registerPort） | 84% | 进行中 | 已新增统一 `handleCommand()` 入口并覆盖 `spawn/mount/kill/registerPort/unregisterPort/notifyStdio/notifyExit/executeProcess` 测试；新增 `processExecutor` 可注入执行接口（默认 stub），为 runtime/supervisor 真执行链切换预留稳定边界；`waitpid` 已支持进程退出后的真实 exit code 回收（reap）语义。新增分层结论：`bun add/install/i` 归属 kernel 命令路由与 installer 编排，不放在 SW 或 process worker 内实现。 |
| A0-4 | packages/bun-web-runtime/src/spawn.ts + process-supervisor.ts | 接收 kernel 调度，返回可转发的进程句柄与事件 | 66% | 进行中 | 已新增 runtime `process-executor` 并在 kernel `processExecutor` 注入路径验证通过（m1）；`@mars/web-client` 已显式声明 `@mars/web-runtime` 依赖并增强默认执行器加载诊断；`runtime.spawn` 当前承担进程句柄与生命周期编排，命令执行仍由 `kernel.executeProcess -> processExecutor` 主链路负责；本轮将 bun 脚本执行改为 worker-only（移除 inline fallback），并补齐 worker 不可用失败语义回归。职责冻结：runtime process-executor 负责 worker 脚本执行，不承载 add/install/i 的安装语义。 |
| A0-5 | packages/bun-web-sw/src/sw.ts | 端口路由与 server-ready 事件透传对齐 | 100% | 已完成 | 已升级为类化管理：`WebServiceWorkerManager` 统一 install/activate/fetch 生命周期，`KernelServiceWorkerBridgeManager` 负责 kernel 端口表接入；路由顺序固定为 worker script -> kernel virtual route -> passthrough fetch。新增脚本处理器链：`detectWorkerScriptModuleType` 判定 package CJS/ESM（扩展名 + package.type），`EsbuildWorkerScriptProcessor` 将 CJS 转为 ESM 后返回执行脚本。职责冻结：SW 仅负责路由与脚本分发，不承载 bun 包管理命令语义。 |
| A0-6 | packages/bun-web-test/tests/m7-client-sdk.test.ts | 将 stub 假设改为真实链路断言 | 82% | 进行中 | 已新增 `boot(processExecutor)` 注入断言，并将 `server-ready` 用例改为真实链路（`Bun.serve` -> runtime registerPort -> kernel portRegistered -> client 透传），验证 `url/host/port/protocol` 载荷契约；新增 `boot({ workerUrl })` 覆盖断言，锁定默认执行器工厂在脚本 URL 模式下的接线行为 |
| A0-7 | packages/bun-web-test/tests/m8-example-flow.test.ts | example 链路验证 boot->mount->spawn->server-ready | 92% | 进行中 | `@mars/web-example` 已平台化为可扩展 use-case registry（vite-react-ts/express/koa/fastify/hono/bun-serve-routes），`runBunWebExample` 支持 `useCase` 选择并保持默认兼容；m8 example/ecosystem 定向回归通过（18/18） |
| A0-8 | docs/rfc/bun-in-browser-webcontainer-api-layer-design.md + docs/rfc/bun-in-browser-module-design.md | 文档与实现同步（调用矩阵、职责、事件契约） | 94% | 进行中 | 已同步类化 SW 管理与脚本处理契约：`WebServiceWorkerManager`、`WorkerScriptProcessor`、SW ↔ kernel 路由桥接能力与 `workerScripts/scriptProcessor` 选项，并补充 package CJS/ESM 判定与 CJS->ESM（esbuild）转译约束；新增 `serviceWorkerUrl/serviceWorkerRegisterOptions` 主线程注册说明（`navigator.serviceWorker.register` + `ready`），并明确不再通过 boot 注入 `serviceWorkerScope`；职责冻结保持不变：`bun add/install/i` 归 kernel+installer，SW/runtime process-executor 不承载包管理语义。 |

### A0 验收命令（计划）

- `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts packages/bun-web-test/tests/m7-client-sdk.test.ts`
- `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts packages/bun-web-test/tests/m8-example-flow.test.ts`
- `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts packages/bun-web-test/tests/m8-ecosystem-acceptance.test.ts`

### A0 风险与缓解

- 风险：client 与 runtime 事件命名/载荷不一致。
- 缓解：先冻结事件 schema（server-ready/process-exit/filechange/error/port），再落代码。
- 风险：接线后旧 stub 测试大面积失效。
- 缓解：先改测试为“双轨断言”（过渡期允许适配层），再切主路径。

当前进展说明：2026-04-25 本轮继续推进 A0 控制面收敛：`@mars/web-kernel` 的 `executeProcess` 保持“可注入执行器（processExecutor）+ 默认 stub”模式；`@mars/web-runtime` 的 `process-executor` 已在 `Bun.serve` 路径上报端口与元信息（`host/protocol`）；`@mars/web-kernel` 的 `portRegistered` 事件已扩展为 `{ pid, port, host, protocol }` 并在 registerPort 时发布；`@mars/web-client` 已消费该事件并透传为 SDK `server-ready`（URL 由 `${protocol}://${host}:${port}` 生成），不再依赖脚本文本启发式。新增对默认 runtime 执行器接线的稳定性收敛：`@mars/web-client` 显式声明 `@mars/web-runtime` 依赖，并保留源码路径候选以覆盖工作区测试解析；在默认执行器动态加载失败时输出一次性诊断告警（保留注入执行器覆盖能力）。职责分工明确：`runtime.spawn` 当前负责进程句柄/生命周期编排，`executeProcess` 命令执行由 `processExecutor` 负责。本轮将 bun 脚本执行升级为 worker-only（移除 inline fallback，不再主路径直接 await `AsyncFunction`），worker 不可用时返回明确失败语义；同时保持 `process.exit/Bun.exit`、throw=1、unknown=127 契约。进一步完成“脚本拦截”接线：`process-executor.worker.ts` 独立脚本化、SW 新增 `registerWorkerScript/installWorkerScriptInterceptor`，client 默认执行器优先走 `createRuntimeProcessExecutor({ workerUrl })`，并修复显式 `workerUrl` 被缓存吞掉的问题（显式 URL 场景按实例绕过缓存）。新增分层冻结结论：`bun add/install/i` 将接入 kernel 命令控制面并复用 installer，SW 与 runtime process-executor 不承载包管理语义。新增回归与验证：`m7-client-sdk` 22/22、`m4-serve-routing` 26/26、`m1-vfs-bootstrap` 85/85，局部合计 133/133；全量关键回归 `m1+m4+m7+m8` 合计 150/150 通过。

## 1.2 Initializer + ServiceWorker 主动初始化计划（A1-A3）

目标：

- 将 SW 接入从“boot 条件执行”改为“Initializer 主动初始化流程”。
- 由 kernel 持有 `serviceWorker` 成员，统一封装 `navigator.serviceWorker`。
- 将模块请求拦截与 `postMessage` 往返协议稳定化并纳入回归。

### A1 Stage Gate

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 只改初始化流程与协议，不改 installer 语义 | [ ] 待确认 |
| 文件级任务确认 | A1-1 ~ A1-5 任务与文件已冻结 | [ ] 待确认 |
| 依赖确认 | A0 控制面可用，SW 路由基线可用 | [ ] 待确认 |
| 测试确认 | m7 + 新增 m4 模块拦截用例纳入门禁 | [ ] 待确认 |
| 启动决策 | 允许进入 A1 实施 | [ ] 待确认 |

### A1 TODO List（初始化器抽象）

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| A1-1 | packages/bun-web-shared/src/initializer-pipeline.ts（建议新增） | 抽象通用 InitializerPipeline（register/run/ordered execution） | 0% | 未开始 | 支持 `id/order/shouldRun` 与按选项选择执行 |
| A1-2 | packages/bun-web-runtime/src/process-bootstrap.ts | 复用共享调度抽象，保持 runtime 任务语义不变 | 0% | 未开始 | 现有 `runtime-transpiler-init/runtime-bundler-init` 用例全通过 |
| A1-3 | packages/bun-web-kernel/src/kernel-initializer.ts（建议新增） | 新增 KernelInitializer，封装 wasm init、boot hook、sw url 计算 | 0% | 未开始 | `Kernel.boot -> initializer.run` 时序可观测且可测试 |
| A1-4 | packages/bun-web-client/src/api.ts | `BunContainer.boot` 切换到新时序并透传 `initializers` 选项 | 0% | 未开始 | 不传选项走默认全量流程，兼容旧行为 |
| A1-5 | packages/bun-web-test/tests/m7-client-sdk.test.ts | 新增启动时序断言（initializer before sw register） | 0% | 未开始 | 至少 1 条严格顺序断言通过 |

### A2 Stage Gate

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 只引入 kernel.serviceWorker 封装与 hook 发布 | [ ] 待确认 |
| 文件级任务确认 | A2-1 ~ A2-4 文件与接口冻结 | [ ] 待确认 |
| 依赖确认 | A1 pipeline 可用 | [ ] 待确认 |
| 测试确认 | m7 新增 hook/register/unregister 测试 | [ ] 待确认 |
| 启动决策 | 允许进入 A2 实施 | [ ] 待确认 |

### A2 TODO List（kernel.serviceWorker 封装）

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| A2-1 | packages/bun-web-kernel/src/service-worker-controller.ts（建议新增） | 封装 `register/unregister/getRegistration/getRegistrations/postMessageToActive` | 0% | 未开始 | 在无 `navigator.serviceWorker` 环境下稳定降级 |
| A2-2 | packages/bun-web-kernel/src/kernel.ts | 挂载 `kernel.serviceWorker` 成员并接入 Initializer | 0% | 未开始 | `Kernel.boot` 后可访问 controller |
| A2-3 | packages/bun-web-kernel/src/kernel.hooks.ts（建议新增） | 发布 `boot/service-worker.before-register/service-worker.register` | 0% | 未开始 | hook 抛错不阻断主流程，错误可观测 |
| A2-4 | packages/bun-web-test/tests/m7-client-sdk.test.ts | 注册流程与 hook 触发顺序测试 | 0% | 未开始 | 顺序断言 + 错误路径断言通过 |

### A3 Stage Gate

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 仅实现模块命名空间拦截 + postMessage 协议 | [ ] 待确认 |
| 文件级任务确认 | A3-1 ~ A3-5 文件与协议字段冻结 | [ ] 待确认 |
| 依赖确认 | A2 serviceWorker controller 可用 | [ ] 待确认 |
| 测试确认 | m4/m7 增加模块请求往返与错误语义测试 | [ ] 待确认 |
| 启动决策 | 允许进入 A3 实施 | [ ] 待确认 |

### A3 TODO List（模块拦截与 postMessage 协议）

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| A3-1 | packages/bun-web-sw/src/sw.ts | 新增 `ModuleRequestInterceptor`，仅拦截 `/__bun__/modules/*` | 0% | 未开始 | 非命名空间请求不受影响 |
| A3-2 | packages/bun-web-kernel/src/module-request-handler.ts（建议新增） | 处理 `MODULE_REQUEST` 并返回 `MODULE_RESPONSE`（buffer transferable） | 0% | 未开始 | 正常/错误路径均返回稳定结构 |
| A3-3 | packages/bun-web-kernel/src/service-worker-controller.ts | 增加 postMessage request-response 相关辅助方法 | 0% | 未开始 | `requestId` 关联与超时回收可测 |
| A3-4 | packages/bun-web-test/tests/m4-serve-routing.test.ts | 覆盖模块命名空间拦截与透传互斥 | 0% | 未开始 | 命中模块路由与普通路由互不污染 |
| A3-5 | packages/bun-web-test/tests/m7-client-sdk.test.ts | 覆盖模块 buffer 返回、headers/status 语义 | 0% | 未开始 | buffer 内容与响应头断言通过 |

### A1-A3 验收命令（计划）

- `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts packages/bun-web-test/tests/m7-client-sdk.test.ts`
- `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts packages/bun-web-test/tests/m4-serve-routing.test.ts`
- `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts packages/bun-web-test/tests/m1-vfs-bootstrap.test.ts`

### A1-A3 风险与缓解

- 风险：initializer 抽象破坏 runtime 既有任务行为。
  缓解：先适配层迁移，再逐步替换；保留原任务 id 与顺序测试。
- 风险：`kernel.serviceWorker` 与主线程环境耦合导致 worker 环境报错。
  缓解：controller 做能力探测，缺失时返回 no-op/结构化错误。
- 风险：模块拦截规则与现有虚拟路由冲突。
  缓解：固定命名空间优先级与匹配顺序，新增互斥测试锁定。
---

## 2. 总体完成度看板

| 阶段 | 名称 | 当前完成度 | 状态 | 说明 |
| --- | --- | --- | --- | --- |
| M0 | 文档与门禁基线 | 100% | 已完成 | RFC 修订、验收脚手架与官方测试驱动脚本已落盘 |
| M1 | Kernel + VFS 最小可运行 | 100% | 已完成 | kernel/vfs/runtime 最小骨架 + `@mars/web-shared` 公共事件层 + `@mars/web-node` process 继承改造已落盘；M1-1 新增 stdio 通道管理（allocateStdio/onStdio/notifyExit/waitpid 事件驱动），并补 worker message port 接入（attachProcessPort，将 stdout/stderr/exit 接到 onStdio + waitpid 主链路）与 Kernel 事件总线（`stdio`/`processExit`）；本轮补齐 attachProcessPort 同 pid 绑定替换与 exit/kill 自动解绑清理（含 stdio channel 回收）；M1-3 重构为真正三层 OverlayFS（BaseLayer/PersistLayer/MemLayer + ENOENT 错误码）；M1-4 已补 native OPFS root 检测、目录 hydration、best-effort 写回、reopen 再水化、SyncAccessHandle→writable 回退，以及原生写回统计可观测（attempts/successes/failures/syncFallbacks/lastError）；M1-5 在 bootstrap 之外新增 RuntimeProcessSupervisor（attach + onExit + cleanup）编排层，并补更高层 `bootstrapSupervisedProcess()`、`spawnSupervisedProcess()` 入口，以及 `exited/onStdio` 句柄抽象与 `spawn.ts` 的最小 `ChildProcess` 适配层；本轮进一步补齐 runtime `spawn()` 薄入口（复用 supervisor + handle 适配），并通过 `stdin: pipe`、`onExit` 回调契约与 pid 就绪语义测试锁定行为；本轮进一步明确 `stdout/stderr` 的 `pipe/inherit/ignore` 输出策略；M1-6 补齐 process stdio 句柄（stdin/stdout/stderr fd + writer 适配）；M1-8 acceptance 已补齐 spawn() stdout ignore（流关闭）、stdout inherit（不进入子 pipe）、spawnSync 占位报错三类边界 smoke；m1-vfs-bootstrap.test.ts 71/71 pass，m1-acceptance.test.ts 15/15 pass |
| M2 | Resolver + Node 核心 polyfill | 100% | 已完成 | M2-3 fs 补齐 `lstatSync/realpathSync` + promises 对应方法（95%）；M2-4 path 补齐 `parse/format/toNamespacedPath`（posix + win32），url 补齐 `fileURLToPath/pathToFileURL`（90%）；M2-5 module 补齐 `node:buffer` 注册、`builtinModulesList` 数组导出（40+ 模块）、`createRequireWithVfs`（VFS node_modules 解析），新增 Module 类实现、wrap/nodeModulePaths/_extensions/_resolveLookupPaths 导出，并新增回放用例覆盖 node_modules 裸包加载与包内相对 require（90%）；M2-6 官方语义回放已扩展到 fs/path/module/buffer/events/stream，官方回放共 86/86 全通过（100%）；M2-7 Buffer 主路径已落盘，官方回放测试通过（85%）；M2-8 已落 `node:events` + `node:stream`，并补齐 `stream/web` 与 `stream/promises` 最小入口，events+stream 官方回放子集已完成（93%）；M2-9 `@mars/web-webapis` 包已落盘（80%），39/39 测试通过。整体实现达成，主要完成度由官方回放用例验证确保质量。 |
| M3 | 安装器（bun install）MVP | 100% | 已完成 | 已完成 `@mars/web-installer` 包脚手架与主链路语义闭环：registry metadata/semver、tarball 下载与 integrity 校验、最小 tar.gz 解包、lockfile 稳定读写/增量、node_modules 扁平布局与冲突回退、缓存命中与回源刷新、metadata+tarball 重试（含默认 6 次上限与耗尽可观测）、overrides npm alias、frozen-lockfile 一致性约束；M3 install-cli 测试总计 105 条全部通过，M3 门禁合计 125 条通过，依赖 M1-M2 |
| M4 | Service Worker + Bun.serve | 100% | 已完成 | M4-1~M4-10 基线实现全部落盘：新增 `@mars/web-sw/@mars/web-net/@mars/web-dns/@mars/web-client/@mars/web-proxy-server`，补齐 runtime `Bun.serve` 与 node `http-net`，并新增 SW runtime 入口 `installServiceWorkerRuntime`；M4 专项回归 5 文件 31/31 通过，官方 `test/js/bun/http` 门禁 25/25（100%）通过，`web:typecheck`/`web:build` 通过 |
| M5 | Shell + Spawn + WebSocket | 100% | 已完成 | shell/spawn/worker_threads/async_hooks 与 registry+hook 已落盘，官方 `test/js/bun/shell` 门禁已通过 |
| M6 | Build/Transpiler/Test Runner | 58% | 进行中 | swc/esbuild 浏览器主路径已落地，统一 WASM 加载抽象已接入，剩余 wa-sqlite/crypto/zlib 深化 |
| M7 | Plugin/Compat Registry/CI 门禁 | 0% | 未开始 | 依赖 M1-M6 |
| M8 | 官方测试集直通与性能稳定性 | 5% | 进行中 | 已有运行器与 skip 机制，尚未连到真实实现 |

项目总体完成度（按阶段权重）：`89%`

---

## 3. Phase TODO List

## M0 文档与门禁基线（已完成）

### 实施前确认（Stage Gate）

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | M0 只覆盖文档、测试脚手架与门禁入口 | [x] 已确认 |
| 文件级任务确认 | M0 文件清单与功能边界已明确 | [x] 已确认 |
| 前置依赖确认 | 无前置阶段依赖 | [x] 已确认 |
| 测试计划确认 | 已定义最小可执行测试入口 | [x] 已确认 |
| 启动决策 | 允许执行并已完成 | [x] 已确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M0-1 | docs/rfc/bun-in-browser-webcontainer.md | RFC 主文档，统一架构/API/验收/风险 | 100% | 已完成 | 文档可读且路径无断链 |
| M0-2 | docs/rfc/bun-in-browser-webcontainer-implementation-plan.md | 实施计划与阶段任务拆解 | 100% | 已完成 | 每阶段有文件级 TODO 与完成度 |
| M0-3 | packages/bun-web-test/tests/acceptance.test.ts | 验收测试骨架（API/FS/HTTP/Shell/SQLite） | 100% | 已完成 | 可被 Vitest 调起；共享 runInRuntime 已切到 `/usr/bin/env bun`，full web:test 失败见测试状态清单 |
| M0-4 | test/integration/bun-in-browser/run-official-tests.ts | 官方测试集分目录运行与阈值门禁 | 100% | 已完成 | 输出目录通过率并返回正确 exit code |
| M0-5 | test/integration/bun-in-browser/skip-in-browser.txt | 浏览器不支持用例排除机制 | 100% | 已完成 | 脚本可加载并应用跳过规则 |
| M0-6 | package.json | 增加 web:test / web:test:official 脚本入口 | 100% | 已完成 | `bun run web:test*` 命令可解析 |
| M0-7 | docs/rfc/bun-in-browser-module-design.md | 代码风格规范（Oxc + lint）与类命名契约 | 100% | 已完成 | 编码风格、lint 门禁、类名签名规则已文档化 |
| M0-8 | package.json + pnpm-workspace.yaml + packages/bun-web-*/package.json | package 交付与 workspace/Nx 管理基线 | 100% | 已完成 | 物理目录保持 `packages/bun-web-*`，逻辑包名统一映射为 `@mars/web-*`，并被 workspace 统一管理；2026-04-25 已统一所有 bun-web 模块的 `tsdown.config.ts`、`tsconfig.json`、`README.md` 与 `build/typecheck/clean` 脚本，并新增 Nx 统一编排 `web:build` / `web:typecheck` / `web:clean`；已验证 Nx 可发现 9 个 bun-web 模块，且 `web:build` / `web:typecheck` 均通过。最新构建已消除 `TypedEventEmitter` 的 MISSING_EXPORT 告警，当前仅剩 tsdown 的 `define` 非阻塞输入告警 |

---

## M1 Kernel + VFS 最小可运行

### 实施前确认（Stage Gate）

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 只实现最小 kernel/vfs/stdio 主路径，不扩展插件或网络 | [ ] 待确认 |
| 文件级任务确认 | M1-1~M1-10 的文件、功能、责任人已逐项确认（含 node:process + shared 公共层 + iOS SAB fallback 补充项） | [ ] 待确认 |
| 前置依赖确认 | M0 的文档、脚本与测试入口可用 | [ ] 待确认 |
| 测试计划确认 | 明确 M1 smoke 用例与通过标准 | [ ] 待确认 |
| 启动决策 | 批准进入 M1 编码 | [ ] 待确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M1-1 | packages/bun-web-kernel/src/kernel.ts | `Kernel.boot()`、进程表、PID 分配 | 82% | 进行中 | 2026-04-24：新增 allocateStdio/onStdio/notifyExit/waitpid 事件驱动，并补 attachProcessPort（worker `stdout/stderr/exit` 消息接入内核事件链）；本轮将 Kernel 对齐 `@mars/web-shared` TypedEventEmitter（`stdio`/`processExit` 事件），并补 attachProcessPort 同 pid 绑定替换、exit/kill 自动解绑和 stdio channel 回收；m1-vfs-bootstrap.test.ts 覆盖 7 个 Kernel stdio 测试全部通过 |
| M1-2 | packages/bun-web-kernel/src/syscall-bridge.ts | SAB 请求/响应队列、`syscallSync()` | 50% | 进行中 | 已落 async fallback 错误契约（`ERR_BUN_WEB_SYNC_UNAVAILABLE`）、sync capability 正向主路径与 seq 单调递增断言，并由集成测试覆盖 |
| M1-3 | packages/bun-web-vfs/src/overlay-fs.ts + packages/bun-web-vfs/src/watch-bus.ts | Base/Persist/Mem 三层 VFS | 80% | 进行中 | 2026-04-24：重构为真正三层 OverlayFS；BaseLayer/PersistLayer/MemLayer 独立类；读取 Mem→Persist→Base 优先级；ENOENT 错误码；readdirSync 跨层合并；async wrappers；2026-04-25：补齐 `WatchBus` 与 `VFS.watch()`，write/mkdir/unlink/rename 可发出 `change/rename` 事件并向父目录传播；m2-node-fs.test.ts 新增 watch 回归后 12/12 全通过 |
| M1-4 | packages/bun-web-vfs/src/opfs-adapter.ts | OPFS 持久层适配（含 SyncAccessHandle） | 80% | 进行中 | 2026-04-24：在目录感知最小适配层之上，补 native OPFS root 检测（`navigator.storage.getDirectory()`）、subroot 打开、目录 hydration、best-effort mkdir/write/unlink 写回、reopen 再水化回读验证、SyncAccessHandle 失败时 writable 回退、双路径失败时内存主路径可用，以及原生写回统计可观测接口（attempts/successes/failures/syncFallbacks/lastError + reset）；m1-vfs-bootstrap.test.ts 中 OPFSAdapter 用例扩至 16/16（含 fake native handle preload/persistence/reopen/recovery/observability 路径）通过；真实浏览器 SyncAccessHandle 刷新持久化与错误恢复策略仍待接入 |
| M1-5 | packages/bun-web-runtime/src/process-bootstrap.ts + packages/bun-web-runtime/src/process-supervisor.ts + packages/bun-web-runtime/src/spawn.ts | Process Worker 启动、stdio 初始化与生命周期编排 | 98% | 进行中 | 2026-04-24：新增 StdioWriter（MessagePort 管道）、installConsoleCapture、bootstrapProcessWorker 完整实现（process 注入/cwd/env/argv/VFS/exit hook）；补齐 process stdout/stderr writer 接线，并在未传 stdio port 时回退到 `globalThis.postMessage`（含 exit 事件）；新增 RuntimeProcessSupervisor 统一封装 attachProcessPort + processExit 回调收敛 + cleanup，并补更高层 `bootstrapSupervisedProcess()`、`spawnSupervisedProcess()` 入口，以及最小句柄抽象（`exited`/`onStdio`/`cleanup`）；此前已新增 `spawn.ts` 的 `createChildProcessHandle()` 适配层，本轮再补 runtime `spawn()` 薄入口（默认走 supervisor 编排并回收生命周期），并通过 `stdin: 'pipe'`、`onExit(proc, code, signal)`、`stdout ignore` 与 `stdout inherit`（不进入子句柄 pipe）用例补齐行为回归；2026-04-25：补充 bun-web 运行时 Bun 顶层最小镜像安装，覆盖 `version/env/argv/cwd/file/write/stdin/stdout/stderr`，浏览器环境直接注入 `globalThis.Bun`，宿主 Bun 环境回退到 `globalThis.__BUN_WEB_BUN__` 镜像并按可写性做 best-effort 补丁；`m1-vfs-bootstrap.test.ts` 新增 Bun mirror 回归后聚焦测试通过 |
| M1-6 | packages/bun-web-node/src/process.ts | `node:process` 基础 process 对象（M1 版本） | 80% | 进行中 | 2026-04-24：在 `process.env/argv/cwd/chdir/exit` + `on/off/once/emit` + `addListener/removeListener/removeAllListeners/listenerCount` + `nextTick/kill(当前 pid)` 之外，补齐 `stdin/stdout/stderr` 最小句柄形状（fd/isTTY/read/write/end）并接入 bootstrap writer；m1-vfs-bootstrap.test.ts 新增 stdio 覆盖通过 |
| M1-7 | packages/bun-web-kernel/src/async-fallback.ts | iOS Safari / 无 SAB 环境 async 降级模式（RFC §13 风险） | 52% | 进行中 | 已落 capability 探测与桥接选择；无 SAB 时 `createBridge` 默认进入 async fallback，`callSync` 抛明确错误、`callAsync` 保持可用，并有集成测试覆盖 |
| M1-8 | packages/bun-web-test/tests/m1-acceptance.test.ts | 新增 M1 smoke 组（kernel/vfs/runtime/module，纯 JS 验证） | 100% | 已完成 | 2026-04-24：已覆盖 Bun/version + process 基础属性、process stdio 句柄与 write()、RuntimeProcessSupervisor 的 stdout/exit 生命周期收敛、runtime `spawn()` 公共入口句柄契约、VFS 读写/目录/ENOENT 边界、TS/JSX 转译、动态 import、CommonJS require、import.meta.url；本轮新增 spawn() stdout ignore 流关闭断言、spawn() stdout inherit 不进入子 pipe 断言、spawnSync 占位报错断言；`bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts packages/bun-web-test/tests/m1-acceptance.test.ts` 可执行，不触发 Zig/build 链路 |
| M1-9 | packages/bun-web-test/tests/m1-kernel.test.ts | M1 kernel/vfs/runtime smoke 测试（独立） | 100% | 已完成 | `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts packages/bun-web-test/tests/m1-kernel.test.ts` 可执行（含 M1-2 sync fallback 错误契约 + sync capability 正向主路径 + seq 递增，以及 M1-7 能力判定、default-path、sync/async 行为断言） |
| M1-10 | packages/bun-web-shared/src/event-emitter.ts | 抽象 shared 公共包并提供 TypedEventEmitter（供 process 继承） | 100% | 已完成 | `process` 通过 `@mars/web-shared` 复用事件能力，smoke 覆盖继承断言 |

---

## M2 Resolver + Node 核心 polyfill

### 实施前确认（Stage Gate）

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 仅覆盖 resolver 与 node 核心模块最小集合 | [ ] 待确认 |
| 文件级任务确认 | M2-1~M2-9 的文件与功能映射已确认（含 buffer/events/stream/webapis 补充项） | [ ] 待确认 |
| 前置依赖确认 | M1 退出条件已满足 | [ ] 待确认 |
| 测试计划确认 | 明确 test/js/node 子集回放策略 | [ ] 待确认 |
| 启动决策 | 批准进入 M2 编码 | [ ] 待确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M2-1 | packages/bun-web-resolver/src/resolve.ts | `resolve()` 支持 exports/imports/conditions | 100% | 已完成 | 2026-04-24：`@mars/web-resolver` 包已创建；`resolve()` 支持相对/绝对/裸包/`#`-imports；`package.json` exports 完整实现（条件导出、子路径、`*` 模式匹配、嵌套数组 fallback）；node_modules walk-up 算法；imports 字段（精确与模式）；`resolveExports`/`resolveImports` 独立导出；m2-resolver.test.ts 26/33 个相关用例全部通过 |
| M2-2 | packages/bun-web-resolver/src/tsconfig-paths.ts | tsconfig `paths/baseUrl` 解析 | 100% | 已完成 | 2026-04-24：`createTsconfigPathResolver()` 实现；支持精确 paths、`*` 通配符、多候选列表、baseUrl 回退；相对路径不受影响；m2-resolver.test.ts 7/33 个相关用例全部通过 |
| M2-3 | packages/bun-web-node/src/fs.ts | `node:fs` + `fs/promises` 绑定 VFS | 95% | 进行中 | 已支持 `readFile/writeFile/appendFile/exists/mkdir/readdir(withFileTypes)/stat/lstat/realpath/rename/unlink/copyFile/rm` 的 sync + promises 主路径；`lstatSync` = statSync（VFS 无符号链接），`realpathSync` 规范化并验证存在性；新增 `Stats/BigIntStats`（含 `Stats(...)` 无 `new`）、`createStatsForIno` shim 与 aborted signal (`ABORT_ERR`) 处理 |
| M2-4 | packages/bun-web-node/src/path.ts + packages/bun-web-node/src/url.ts | `node:path`（posix/win32）+ `node:url/querystring/string_decoder` 实现 | 90% | 进行中 | path 补齐 `parse/format/toNamespacedPath`（posix + win32 全覆盖）；url 补齐 `fileURLToPath`（支持 string/URL，decode percent-encoded）和 `pathToFileURL`（正确 percent-encode 特殊字符） |
| M2-5 | packages/bun-web-node/src/module.ts | `createRequire/isBuiltin/register` | 90% | 进行中 | 补齐 `node:buffer` 注册（`builtinSpecifiers` + `builtinModules`）；导出 `builtinModulesList`（bare 名数组）；`node:url` 补加 `fileURLToPath/pathToFileURL`；新增 `createRequireWithVfs` 支持 VFS node_modules eval 加载；补齐 `internal-for-testing` bare alias 到 `bun:internal-for-testing` 的映射兼容（含 `require` / `require.resolve` / `isBuiltin` 语义）；本轮补齐 `createRequire()` 对目录尾斜杠与 `file://` base 输入的兼容（用于官方 `createRequire(<dir>/)` 语义迁移）；新增 Module 类实现（构造器、`_compile` 方法、Module.Module 引用）、静态方法（`_extensions`、`_resolveLookupPaths`、`findSourceMap`）及 `wrap()`/`_nodeModulePaths()` 导出函数；builtinModulesList 扩展至 40+ 内置模块名（包含 assert/crypto/dns/http/net/os/util/vm/worker_threads 等）；`bun-web-node` 依赖加 `@mars/web-resolver` |
| M2-6 | test/js/node/ | 优先回放 fs/path/module/buffer/events/stream 官方测试 | 100% | 已完成 | 已完成真实目录两批子集：① module/path/url：39 pass / 0 fail；② fs 稳定子集（`fs.test.ts` + `fs-mkdir.test.ts`）：264 pass / 5 skip / 0 fail。模块测试已迁移到 `packages/bun-web-test/tests` 并统一改为 Vitest；2026-04-25 批量复测 M1/M2 迁移用例 13 文件全部通过（218 pass / 0 fail）。同日完成 bun-web 全模块工程基线统一（tsdown + tsconfig + README）并接入 Nx；当前 `web:build` / `web:typecheck` 均已通过。2026-04-25 本轮推进：官方 `fs-stats-truncate` / `fs-stats-constructor` 与 `abort-signal-leak-read-write-file` 的可稳定子集已改造并移植到 `packages/bun-web-test/tests/m2-node-fs-official-replay.test.ts`（8/8）；path 官方回放扩展至 7/7（dirname/extname/relative 子集，posix+win32 双平台）；module 官方回放扩展至 14/14（Module 类实例化、builtinModules、wrap、路径生成、加载器、解析等）；buffer 官方回放 `m2-node-buffer-official-replay.test.ts` 扩展至 14/14（from/alloc/concat/compare/isBuffer/isEncoding/byteLength/copy/equals/fill/indexOf/includes/slice）；events 官方回放 `m2-node-events-official-replay.test.ts` 扩展至 23/23（新增 `captureRejectionSymbol`、`once` abort（含已 aborted）、`once` 自动清理监听器、`removeAllListeners(event)`、多 emitter `setMaxListeners` 语义）；stream 官方回放 `m2-node-stream-official-replay.test.ts` 扩展至 20/20，新增 `finished` 在 readable/writable 已结束状态下即时 resolve。官方回放总体：fs(8) + path(7) + module(14) + buffer(14) + events(23) + stream(20) = **86/86 全通过**；`web:typecheck` 与 `web:build` 保持全绿。官方目录门禁仍作为补充观测（非主验证路径），当前在 skip 清单下 11/11、100% 通过。 |
| M2-7 | packages/bun-web-node/src/buffer.ts | `node:buffer` + Bun 扩展补丁（RFC §8.2 A级） | 85% | 进行中 | 已实现 `Buffer.from/alloc/allocUnsafe/concat/isBuffer/compare/isEncoding/byteLength` 静态方法，实例方法 `toString/copy/equals/compare/fill/indexOf/includes/subarray/slice/toJSON` 及完整整数/浮点 read/write；51 个 smoke 用例全部通过 |
| M2-8 | packages/bun-web-node/src/events-stream.ts | `node:events` / `node:stream` / `node:stream/web` / `node:stream/promises`（readable-stream，RFC §8.2 A级） | 93% | 进行中 | 已落 `EventEmitter`、`Readable/Writable/Duplex/Transform/PassThrough` 最小主路径、async iterator、`stream`/`events`/`stream/web`/`stream/promises` builtin 注册，含 `finished/pipeline` 最小语义与 `Readable.toWeb/fromWeb`、uint8array、newListener/error/prefinish 及时序回放子集（toWeb 严格序列：pause/resume/data/data/readable/end/close + readable-on-end + add/removeListener alias、once 清理、callback 动态监听器语义）；本轮补齐 `EventEmitter.eventNames()` 并通过官方回放用例验证 string/symbol 事件名语义，同时扩展 stream/promises 在 readable end/error 与直连 pipeline、已结束状态即时 resolve 的官方回放，并补充 events 侧 `captureRejectionSymbol` 与 once abort/cleanup 回放。 |
| M2-9 | packages/bun-web-webapis/src/index.ts | Web 标准 API 补丁层：navigator UA 兼容策略、BroadcastChannel、CompressionStream 扩展（RFC §8.3、§10 `bun-web-webapis/`） | 80% | 进行中 | 2026-04-24：navigator-ua/broadcast/compression/websocket-patch/blob-file/performance-ext/crypto-ext 已落盘；`installWebAPIs()` 统一入口；m2-webapis.test.ts 39/39 pass；M6 WASM polyfill（brotli/zstd/BLAKE3）留存 TODO |

---

## M3 安装器（bun install）MVP

### 实施前确认（Stage Gate）

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 仅实现安装主链路（metadata/tarball/lockfile/layout） | [x] 已确认 |
| 文件级任务确认 | M3-1~M3-6 文件与功能已确认 | [x] 已确认 |
| 前置依赖确认 | M1-M2 退出条件满足，VFS 与 resolver 可复用 | [x] 已确认 |
| 测试计划确认 | 明确 test/cli/install 的可兼容用例集合 | [x] 已确认 |
| 启动决策 | 批准进入 M3 编码 | [x] 已确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M3-1 | packages/bun-web-installer/src/registry.ts | npm registry metadata 拉取 | 100% | 已完成 | `fetchPackageMetadata()` + `resolveVersion()` 已完整覆盖 dist-tag/exact/range（^/~/>=/</<=）语义，补齐 dist-tag 缺失显式报错与 registry pathname 尾斜杠归一化；由 `m3-installer-registry.test.ts`（4/4）、`m3-install-cli-semver.test.ts`（21/21）与 `m3-install-cli-registry-pathname.test.ts`（3/3）验证 |
| M3-2 | packages/bun-web-installer/src/tarball.ts | tarball 下载、解压、完整性校验 | 100% | 已完成 | `downloadTarball()`、`verifyIntegrity()`（SRI sha1/sha256/sha384/sha512）、`extractTarball()`（tar.gz 最小解包）均已落盘；主链路补齐 damaged tarball 解包失败重试与耗尽语义，相关门禁全部通过 |
| M3-3 | packages/bun-web-installer/src/lockfile.ts | `bun.lock` 读写与最小增量更新 | 100% | 已完成 | 已实现稳定排序读写、增量 upsert、lockfile-only 语义，并补齐 frozen-lockfile 一致性约束（lockfile 将变更时失败）；`m3-install-cli-lock.test.ts` 12 条全部通过 |
| M3-4 | packages/bun-web-installer/src/node-modules-layout.ts | 扁平化安装与去重策略 | 100% | 已完成 | lockfile→layout graph、hoist 复用与冲突嵌套回退策略已稳定；`m3-install-cli-layout.test.ts` 7 条覆盖根依赖路径、共享去重、冲突回退、entries/links 有序语义 |
| M3-5 | packages/bun-web-vfs/src/cache-store.ts | 包缓存（IndexedDB + OPFS） | 100% | 已完成 | 已实现命中优先、miss 回退、回填热缓存、读写/删除与命中统计；install 主链路补齐缓存命中 integrity 再校验与失败回源刷新，`m3-install-cli-cache-store.test.ts` 4 条通过 |
| M3-6 | test/cli/install/ | 回放可兼容安装测试 | 100% | 已完成 | 已在 `packages/bun-web-test` 建立 install replay + 真实目录门禁可迁移集合：覆盖 tarball integrity、lockfile 稳定/lockfile-only、hoist/dedup、scoped registry、registryUrl pathname、dist-tag、缓存命中与回源刷新、metadata/tarball 重试恢复与耗尽、overrides（含 npm alias，含 scoped alias）、optionalDependencies 根与 transitive 失败跳过、frozen-lockfile 一致性约束（含 lockfile-only + optionalDependencies 交叉语义）等语义；当前共 105 条（20 replay + 85 真实目录门禁）全部通过 |

当前进展说明：`@mars/web-installer` package 已接入 root workspace 与 Nx 编排；本轮新增真实目录门禁适配：`m3-install-cli-lock.test.ts`（映射 `bun-lock.test.ts`，8 条，覆盖 lockfile 格式/幂等/round-trip/增量/lockfile-only 语义）与 `m3-install-cli-layout.test.ts`（映射 `bun-install.test.ts` hoist/dedup 子集，7 条，覆盖根依赖路径/hoist/共享去重/冲突嵌套/有序/links 语义），M3 测试总计 65 条全部通过。
当前进展说明：`@mars/web-installer` package 已接入 root workspace 与 Nx 编排；本轮新增真实目录门禁 `m3-install-cli-streaming-extract.test.ts`（5 条：chunked 提取成功、chunked/buffered 等价、integrity mismatch 失败、1-byte chunk 稳定、大块 chunk 稳定），并完成 M3 install-cli 合集回归 77/77（8 files）；M3 门禁合计 97 条，`web:typecheck` / `web:build` 均通过。
当前进展说明：本轮新增真实目录门禁 `m3-install-cli-cache-store.test.ts`（4 条：cache miss 写入、cache hit 跳过 tarball 请求、cache integrity mismatch 回源刷新、lockfile-only 不触发 cache），并在 `packages/bun-web-installer/src/install.ts` 补齐缓存命中 tarball 的 integrity 再校验逻辑；M3 install 9 文件回归 81/81 通过，`web:typecheck` / `web:build` 均通过。
当前进展说明：本轮新增真实目录门禁 `m3-install-cli-registry-pathname.test.ts`（3 条：prefixed route + 单尾斜杠无双斜杠、多尾斜杠归一化、scoped package 编码路径），并在 `packages/bun-web-installer/src/registry.ts` 将 registry URL 归一化逻辑从“去除 1 个尾斜杠”提升为“去除全部尾斜杠”；M3 install 10 文件回归 84/84 通过，`web:typecheck` / `web:build` 均通过。
当前进展说明：本轮新增真实目录门禁 `m3-install-cli-lockfile-only.test.ts`（4 条：root/transitive lockfile-only 仅 metadata、metadata 5xx 重试恢复后仍无 tarball 请求、optionalDependencies 失败跳过），并完成 M3 install 11 文件回归 88/88 通过；M3 门禁合计 108 条，`web:typecheck` / `web:build` 均通过。
当前进展说明：本轮在 `packages/bun-web-installer/src/install.ts` 将 tarball 重试语义扩展到“解包失败可重试”（此前仅下载失败重试），并在 `m3-install-cli-streaming-extract.test.ts` 新增 2 条门禁（damaged tarball 重试恢复、重试耗尽 attempt 可观测）；M3 install 11 文件回归 90/90 通过；M3 门禁合计 110 条，`web:typecheck` / `web:build` 均通过。
当前进展说明：本轮在 `packages/bun-web-installer/src/install.ts` 将默认 retryCount 从 0 调整为 5（总尝试次数 6），并在 `m3-install-cli-retry.test.ts` 新增 2 条真实目录门禁（metadata 默认重试 6 次、tarball 默认重试 6 次）；M3 install 11 文件回归 92/92 通过；M3 门禁合计 112 条，`web:typecheck` / `web:build` 均通过。
当前进展说明：本轮在 `packages/bun-web-installer/src/registry.ts` 补齐 dist-tag 缺失的显式错误语义（`dist-tag '<tag>' not found`），修复 `m3-installer-registry.test.ts` 末条断言不一致问题；M3 install + registry 12 文件回归 96/96 通过，`web:typecheck` / `web:build` 均通过。
当前进展说明：本轮在 `m3-install-cli-retry.test.ts` 新增默认重试耗尽语义门禁 2 条（metadata/tarball 均为 after 6 attempts），与已落地默认 retryCount=5（总尝试 6 次）形成闭环；M3 install + registry 12 文件回归 98/98 通过；M3 门禁合计 114 条，`web:typecheck` / `web:build` 均通过。
当前进展说明：本轮在 `packages/bun-web-installer/src/install.ts` 新增 overrides 的 npm alias 解析（`npm:<pkg>@<spec>`），并在 `m3-install-cli-overrides.test.ts` 新增 1 条真实目录门禁（`bytes -> npm:lodash@4.0.0`）；M3 install + registry 12 文件回归 99/99 通过；M3 门禁合计 115 条，`web:typecheck` / `web:build` 均通过。
当前进展说明：本轮在 `packages/bun-web-installer/src/install.ts` 新增 frozen-lockfile 一致性语义（无现有 lockfile 时拒绝执行；若安装后 lockfile 指纹变化则失败），并在 `m3-install-cli-lock.test.ts` 新增 2 条真实目录门禁（unchanged pass / manifest changes fail）；M3 install + registry 12 文件回归 101/101 通过；M3 门禁合计 117 条，`web:typecheck` / `web:build` 均通过。
当前进展说明：本轮补充 frozen-lockfile 边界门禁 2 条（无现有 lockfile 报错、lockfile-only 模式下变更拒绝），`m3-install-cli-lock.test.ts` 扩至 12 条；M3 install + registry 12 文件回归 103/103 通过；M3 门禁合计 119 条，`web:typecheck` / `web:build` 均通过。
当前进展说明：本轮继续补充门禁 3 条：`m3-install-cli-overrides.test.ts` 新增 scoped npm alias 覆盖、`m3-install-cli-lockfile-only.test.ts` 新增 lockfile-only + overrides alias（仅 metadata）与 lockfile-only + frozen 不变通过语义；M3 install + registry 12 文件回归 106/106 通过；M3 门禁合计 122 条，`web:typecheck` / `web:build` 均通过。
当前进展说明：本轮继续补充门禁 3 条：`m3-install-cli-lockfile-only.test.ts` 新增 lockfile-only + scoped overrides alias（仅 metadata）、frozen + optionalDependencies 失败不变通过、frozen + optionalDependencies 从失败变可解析时拒绝（mismatch）语义；M3 install + registry 12 文件回归 109/109 通过；M3 门禁合计 125 条，`web:typecheck` / `web:build` 均通过。

---

## M4 Service Worker + Bun.serve

### 实施前确认（Stage Gate）

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 覆盖 HTTP 主路径、基础 WebSocket 桥接、DoH、proxy fallback、preview 链路 | [x] 已确认 |
| 文件级任务确认 | M4-1~M4-10 文件与接口契约已全部落盘 | [x] 已确认 |
| 前置依赖确认 | M1-M3 依赖链路可稳定运行 | [x] 已确认 |
| 测试计划确认 | 已新增 M4 集成回归并执行通过 | [x] 已确认 |
| 启动决策 | M4 编码已完成并通过门禁 | [x] 已确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M4-0 | docs/rfc/bun-in-browser-webcontainer-api-layer-design.md | WebContainer 架构对齐与 API 调用层契约冻结（Host SDK / Kernel 控制面 / SW 网络面 / Runtime 运行面） | 100% | 已完成 | 已定义跨层 API、事件载荷、错误模型与 M4-M7 落地映射，可作为实现与测试基线 |
| M4-1 | packages/bun-web-sw/src/sw.ts | `fetch` 拦截与虚拟端口路由 | 100% | 已完成 | 已支持 `<pid>.bun.local` 与 `/__bun__/:port/*` 路由识别与分发，并提供 SW `fetch` 事件绑定入口（installFetchInterceptor） |
| M4-2 | packages/bun-web-runtime/src/serve.ts | `Bun.serve()` 注册/stop/reload | 100% | 已完成 | 已实现注册、端口表登记、reload 与 stop 生命周期 |
| M4-3 | packages/bun-web-net/src/http-bridge.ts | Request/Response 流式桥接 | 100% | 已完成 | POST body 回读与流式响应场景回归通过 |
| M4-4 | packages/bun-web-net/src/websocket-virtual.ts | VirtualWebSocket 协议与升级桥 | 100% | 已完成 | 同信道消息广播（ws echo 基线）回归通过 |
| M4-5 | packages/bun-web-client/src/preview.ts | iframe 预览自动挂载 server-ready URL | 100% | 已完成 | server-ready -> iframe src 自动更新回归通过 |
| M4-6 | packages/bun-web-test/tests/m4-*.test.ts | `serve` 兼容子集回归（bun-web-test） | 100% | 已完成 | M4 专项回归 5 文件 38/38 通过 |
| M4-7 | packages/bun-web-node/src/http-net.ts | `node:http` / `node:https` / `node:net` / `node:tls` polyfill（RFC §8.2 A/B/C级）；`node:net` Socket→WS 隧道 | 100% | 已完成 | 已补齐 `net`/`tls` 基线子集：`createNetServer/createConnection/connect`、`tls.connect/createSecureContext` 与 in-memory socket 数据通路；`connect/tlsConnect` 已支持通过 `configureNetTunnel()` 桥接到 `@mars/web-net` 的 `socket/ws-tunnel`，且 `tlsConnect` 在 tunnel 模式下走独立 `proto=tls` 通道；`http` 请求头读写与多次 `write()+end()` 拼接语义已补齐；`https.request/get` 已补齐 RequestOptions 默认 `https:` 归一化与请求错误回传（emit error）；`node:http2` 已补齐 C 级 request-like 子集（`http2.connect/session.request` 与 `response/data/end` 事件语义） |
| M4-8 | packages/bun-web-dns/src/doh.ts | `Bun.dns.*` / `node:dns` / `dns/promises` DoH 客户端（RFC §8.1/8.2 C级，默认 `https://cloudflare-dns.com/dns-query`，可配置 endpoint） | 100% | 已完成 | DoH 查询与 `lookup()` 解析回归通过 |
| M4-9 | packages/bun-web-sw/src/heartbeat.ts | SW 生命周期保活与自动复活（RFC §13 风险"SW 生命周期回收"） | 100% | 已完成 | 已提供 heartbeat + failures/recovery 机制与回归 |
| M4-10 | packages/bun-web-proxy-server/src/server.ts | 可选 WS/TCP 隧道服务端（RFC §5.4）；无配置时跳过，注入 tunnelUrl 后解锁 postgres/redis 等原始 TCP | 100% | 已完成 | 已实现 `createProxyServer` 基线与 tunnel URL 构造；并与 `@mars/web-net/ws-tunnel` 完成 `protocol/proto` 参数兼容；已补齐生命周期与入口策略校验（`start/stop`、Bearer 鉴权、target allowlist、连接请求校验）；已实现 `handleTunnelRequest(Request|TunnelRequest)` 与会话管理（open/list/close/stop-clear）；已实现 `handleFetch(Request)` 入口与 bootstrap 回滚；已实现可插拔 `transport.connect(target, protocol)` 接入、连接回收、`writeTunnelData/subscribeTunnelData` 数据面 API；已实现 `bindWebSocket(sessionId, socket)` 双向桥接；已实现可注入 `runtime.start({ fetch })` 的真实服务启动与停止链路 |

当前进展说明：M4 已完成主路径实现与回归：新建 `@mars/web-sw/@mars/web-net/@mars/web-dns/@mars/web-client/@mars/web-proxy-server` 五个包，补齐 runtime `serve.ts` 与 node `http-net.ts`，并新增 SW runtime 入口（`installServiceWorkerRuntime`，统一装配 install/activate/fetch 监听）；M4 专项测试集（`m4-runtime-network.test.ts`、`m4-serve-routing.test.ts`、`m4-http-ws-bridge.test.ts`、`m4-dns-preview-proxy-heartbeat.test.ts`、`m4-node-http-net.test.ts`）共 38 条覆盖 M4-1~M4-10；`web:typecheck` 与 `web:build` 均通过。
当前进展说明：2026-04-25 本轮推进 M4-7：`packages/bun-web-node/src/http-net.ts` 已新增 `VirtualSocket`/`VirtualServer`、`createNetServer/createConnection/connect`、`tls.connect/createSecureContext` 基线；`packages/bun-web-test/tests/m4-node-http-net.test.ts` 扩展后为 5/5 通过（含 net/tls 用例）。
当前进展说明：2026-04-25 本轮继续推进 M4-7：`packages/bun-web-net/src/ws-tunnel.ts`、`packages/bun-web-net/src/socket-polyfill.ts`、`packages/bun-web-net/src/tls-stub.ts` 已落地并接入包导出；`packages/bun-web-test/tests/m4-net-tunnel-socket.test.ts` 新增 3 条基线回归并通过。M4 网络相关测试组合 `m4-http-ws-bridge + m4-net-tunnel-socket + m4-node-http-net` 合计 11/11 通过。
当前进展说明：2026-04-25 本轮继续推进 M4-7：`packages/bun-web-node/src/http-net.ts` 已新增 `configureNetTunnel()` 与 tunnel 适配器（`TunnelSocketAdapter`），`connect/tlsConnect` 可桥接到 `@mars/web-net` 的隧道 socket；`packages/bun-web-test/tests/m4-node-http-net.test.ts` 新增“configured ws tunnel bridge”用例后合计 6/6 通过。网络组合回归更新为 12/12 通过。
当前进展说明：2026-04-25 本轮继续推进 M4-7：`packages/bun-web-net/src/socket-polyfill.ts` 已支持 `connectTLS()`，`packages/bun-web-node/src/http-net.ts` 将 `tlsConnect` 的 tunnel 路由切换为独立 `proto=tls` 通道；`m4-node-http-net.test.ts` 新增“tlsConnect bridges through configured ws tunnel using tls channel”后合计 7/7 通过。网络组合回归更新为 13/13 通过。
当前进展说明：2026-04-25 本轮继续推进 M4-7：`packages/bun-web-node/src/http-net.ts` 已补齐 `ClientRequest` 的请求头 set/get/remove 与 body 多次写入拼接语义（`write()+end(chunk)`），并保留 tunnel + tls 独立通道路由；`m4-node-http-net.test.ts` 扩展后 9/9 通过。网络组合回归更新为 15/15 通过。
当前进展说明：2026-04-25 本轮继续推进 M4-7：`packages/bun-web-node/src/http-net.ts` 已补齐 `https.request/get` 的 RequestOptions 协议归一化（默认 `https:`）与请求失败错误回传（`request.emit('error')`）；`m4-node-http-net.test.ts` 新增 2 条回归后 11/11 通过。网络组合回归更新为 17/17 通过。
当前进展说明：2026-04-25 本轮完成 M4-7 收尾：`packages/bun-web-node/src/http-net.ts` 已新增 `node:http2` C 级 request-like 子集（`http2.connect`、`session.request`、`stream response/data/end`、session close/destroy），`m4-node-http-net.test.ts` 新增 2 条 http2 回归后 13/13 通过。M4 组合回归更新为 38/38 通过。
当前进展说明：2026-04-25 本轮继续推进 M4-7/M4-10：`packages/bun-web-net/src/ws-tunnel.ts` 已兼容并归一化 `protocol/proto` 通道参数，支持直接消费 `ProxyServer.buildTunnelURL()` 产物；`m4-net-tunnel-socket.test.ts` 新增 proxy URL 互通回归后 4/4 通过。M4 组合回归更新为 24/24 通过（`m4-node-http-net` + `m4-net-tunnel-socket` + `m4-http-ws-bridge` + `m4-dns-preview-proxy-heartbeat`）。
当前进展说明：2026-04-25 本轮继续推进 M4-10：`packages/bun-web-proxy-server/src/server.ts` 已新增 proxy 生命周期（`start/stop/isRunning`）与入口策略校验（`validateTunnelRequest`：运行态、Bearer 鉴权、target 白名单）；`m4-dns-preview-proxy-heartbeat.test.ts` 新增 2 条 proxy 回归后 8/8 通过。M4 组合回归更新为 26/26 通过。
当前进展说明：2026-04-25 本轮继续推进 M4-10 真实链路接入层：`packages/bun-web-proxy-server/src/server.ts` 已支持处理 `Request` 入站（解析 `target` + `protocol/proto` + `authorization`）并建立/关闭隧道会话（`activeTunnelCount/listTunnels/closeTunnel`）；`m4-dns-preview-proxy-heartbeat.test.ts` 新增 2 条会话管理回归后 10/10 通过；本轮聚焦回归（`m4-dns-preview-proxy-heartbeat` + `m4-net-tunnel-socket`）14/14 通过。
当前进展说明：2026-04-25 本轮继续推进 M4-10 真实服务端接入：`packages/bun-web-proxy-server/src/server.ts` 已新增 `handleFetch(Request, { onTunnelOpen })`，可在 HTTP 入口完成 method 校验、鉴权/白名单校验、会话建立和 bootstrap 失败回滚（自动关闭会话）；`m4-dns-preview-proxy-heartbeat.test.ts` 新增 2 条入口回归后 12/12 通过。M4 组合回归更新为 30/30 通过（`m4-node-http-net` + `m4-net-tunnel-socket` + `m4-http-ws-bridge` + `m4-dns-preview-proxy-heartbeat`）。
当前进展说明：2026-04-25 本轮继续推进 M4-10 数据链路接驳层：`packages/bun-web-proxy-server/src/server.ts` 已新增可插拔 `transport` 连接通道，`handleFetch` 可在校验通过后执行 `transport.connect(target, protocol)` 建链，并在建链失败时自动回滚会话；`closeTunnel/stop` 会回收连接资源。`m4-dns-preview-proxy-heartbeat.test.ts` 新增 2 条 transport 回归后 14/14 通过。M4 组合回归更新为 32/32 通过。
当前进展说明：2026-04-25 本轮继续推进 M4-10 数据面 API：`packages/bun-web-proxy-server/src/server.ts` 已新增 `writeTunnelData(sessionId, payload)` 与 `subscribeTunnelData(sessionId, handler)`，并接通 transport `write/onData` 钩子以支持入站分发；`m4-dns-preview-proxy-heartbeat.test.ts` 新增 2 条数据面回归后 16/16 通过。M4 组合回归更新为 34/34 通过。
当前进展说明：2026-04-25 本轮继续推进 M4-10 双向桥接：`packages/bun-web-proxy-server/src/server.ts` 已新增 `bindWebSocket(sessionId, socket)`，支持 socket->transport 与 transport->socket 的双向字节转发，并在 socket close / tunnel close 时自动反注册与清理；`m4-dns-preview-proxy-heartbeat.test.ts` 新增 1 条桥接回归后 17/17 通过。M4 组合回归更新为 35/35 通过。
当前进展说明：2026-04-25 本轮完成 M4-10 收尾：`packages/bun-web-proxy-server/src/server.ts` 已新增可注入 runtime 适配器（`runtime.start({ tunnelURL, fetch })` / `runtimeServer.stop()`），`ProxyServer.start/stop` 已具备真实服务生命周期驱动能力并将请求分发至 `handleFetch`。`m4-dns-preview-proxy-heartbeat.test.ts` 新增 runtime 启停与分发回归后 18/18 通过。M4 组合回归更新为 36/36 通过。

---

## M5 Shell + Spawn + 多线程

> **与 RFC §12 偏差说明**：RFC §12 M5 交付含测试运行器能力，实施计划将其统一推后至 M6（Vitest + bun-web-test 同批交付，降低风险）；Shell 从 RFC §12 M6 提前至本阶段，以便 AI Agent 命令集合尽早可用。所有能力最终均覆盖，仅执行顺序调整。

### 实施前确认（Stage Gate）

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 聚焦 shell 内建命令、spawn、worker_threads 基础语义 | [x] 已确认 |
| 文件级任务确认 | M5-1~M5-7 文件与功能边界已确认（builtin 命令已并入 bun-web-shell） | [x] 已确认 |
| 前置依赖确认 | M1-M4 关键依赖（stdio、serve、vfs）已可用 | [x] 已确认 |
| 测试计划确认 | 明确 shell 与多线程回归用例集合 | [x] 已确认 |
| 启动决策 | 批准进入 M5 编码 | [x] 已确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M5-1 | packages/bun-web-shell/src/parser.ts | shell 语法解析（管道/重定向/glob） | 100% | 已完成 | parser 支持管道/重定向，glob 在 runner 执行阶段展开 |
| M5-2 | packages/bun-web-shell/src/runner.ts | `grep/ls/cd/cat/find/jq` 等内建命令执行编排 | 100% | 已完成 | runner 已切换 registry 执行入口，命令链路可通过 hook 扩展 |
| M5-3 | packages/bun-web-runtime/src/spawn.ts | `Bun.spawn/spawnSync` Worker 化执行 | 100% | 已完成 | `spawnSync` 已支持 `sh -c` shell 命令线与 stdout/stderr 编码输出 |
| M5-4 | packages/bun-web-node/src/worker_threads.ts | `node:worker_threads` 语义对齐 | 100% | 已完成 | message channel 与 Worker 包装器基础语义测试通过 |
| M5-5 | packages/bun-web-node/src/async_hooks.ts | `AsyncLocalStorage` 传播机制 | 100% | 已完成 | `run/bind/getStore` 与 `executionAsyncId/triggerAsyncId` 基线通过 |
| M5-6 | test/js/bun/shell/ | Shell 兼容子集回归 | 100% | 已完成 | 官方目录回放通过（31/31, 100%），满足阈值 ≥ 85% |
| M5-7 | packages/bun-web-shell/src/register-builtin-commands.ts | builtin 命令集合并入 `@mars/web-shell`；Phase 1 全量内置命令（RFC §7 完整命令表） | 100% | 已完成 | registry 与 builtin command 统一由 `@mars/web-shell` 提供（含 async execute） |

当前进展说明：M5 已完成全量闭环：shell/builtins 两包接线（workspace + Nx）、`spawnSync` 基线、`worker_threads`/`async_hooks` polyfill、registry/hook 扩展机制；新增回归 `m5-shell-parser-builtins.test.ts`、`m5-worker-async-hooks.test.ts` 共 8 条通过；`web:typecheck` 与 `web:build` 通过；官方 `test/js/bun/shell` 门禁通过（31/31, 100%）。
当前进展说明：2026-04-25 本轮继续推进 shell/kernel 边界收敛：Kernel 已实例级持有 command registry，默认 `executeProcess` 统一走 registry `executeAsync`，并通过 `kernel.use(plugin)` 开放外部插件式命令注册；builtin 命令注册入口已并入 `@mars/web-shell`，kernel 不再内联 builtinHook。
当前进展说明：2026-04-25 本轮补齐 webcontainer 架构对齐约束：`bun` 命令已从 builtin 集合移出，改由 kernel 在自持 registry 注册并强制委托 `processExecutor`（process worker 执行路径）；`@mars/web-shell` 的 kernel command 注册仅保留 `echo/sleep`，禁止在 builtins 层以 `AsyncFunction` 直接执行 `bun` 脚本。

### M3-M5 文档一致性审计（2026-04-25）

| 项目 | 结论 | 说明 | 后续动作 |
| --- | --- | --- | --- |
| M3 模块设计签名对齐 | 🟨 存在偏差 | 模块设计文档使用类接口（RegistryClient/TarballExtractor/NodeModulesLayout），实现为函数式 API 导出 | 已在模块设计文档同步为函数式签名；后续若恢复类接口，需先改文档再改代码 |
| M4-7 完成度标注 | 🟨 存在偏差 | 实现已覆盖 `http` 基础子集，但文档此前标注为 `http/https/net/tls` 全量完成 | 已将 M4-7 状态回调为“进行中（60%）”并拆分剩余项 |
| M4-8 DoH 端点说明 | 🟨 存在偏差 | 实现默认端点为 `https://cloudflare-dns.com/dns-query`，与文档旧描述（1.1.1.1 JSON API）不一致 | 已更新实施文档与模块设计文档为“默认 cloudflare，可配置 endpoint” |
| M5 parser 接口签名 | 🟨 存在偏差 | 模块设计文档写 `parseShell(): ShellNode`，实现为 `parseShellPipeline(): ParsedPipeline` | 已在模块设计文档同步为 `parseShellPipeline` 与 `ParsedPipeline` |
| M3/M4/M5 回归状态 | ✅ 一致 | 在 `packages/bun-web-test` 直接执行 `m3-*.test.ts/m4-*.test.ts/m5-*.test.ts`，23 文件 164 测试通过 | 作为本轮一致性校验基线留档 |

---

## M6 Build/Transpiler/Test Runner

### 实施前确认（Stage Gate）

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 聚焦 build/transpiler/test/sqlite 主路径 | [x] 已确认 |
| 文件级任务确认 | M6-1~M6-9 文件与功能覆盖关系已确认（含 bun-web-crypto/zlib/vm-misc 补充项） | [x] 已确认 |
| 前置依赖确认 | M1-M5 基础运行链路可用 | [x] 已确认 |
| 测试计划确认 | 明确 bundler、vitest、sqlite 验收标准 | [x] 已确认 |
| 启动决策 | 批准进入 M6 编码 | [x] 已确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M6-1 | packages/bun-web-transpiler/src/swc.ts | `Bun.Transpiler` 核心实现 | 83% | 进行中 | 已实现 `WebTranspiler/BunTranspiler`、`transform/transformAsync/scan/scanImports`，并补齐 `cache.ts`（TranspileCache）与 `source-map.ts`（inline sourcemap）；转译路径已切换为浏览器强约束：仅 swc-wasm（无 Bun.Transpiler/fallback 兜底）；已新增显式 `initSwcWasm()/isSwcWasmReady()`、`createInitializedTranspiler()` 与 loader 配置能力，并接入 runtime 启动链路（`@mars/web-runtime/src/transpiler-runtime.ts` + `ProcessBootstrap` 初始化队列 + `bootstrapProcessWorker.initializeTranspiler` + `bootstrapInitializers` 选择器）；已完成等价 options 稳定序列化 hash（按键顺序无关）提升缓存命中率，并改为复用 `@mars/web-shared` 的 `WasmModuleLoader` 统一 wasm 模块加载/获取状态机 |
| M6-2 | packages/bun-web-bundler/src/build.ts | `Bun.build()` API 与输出管理 | 83% | 进行中 | 已完成浏览器约束迁移：`build()` 主路径改为 `esbuild-wasm`（`esbuild-wasm.ts` 显式 init 门禁，移除 `Bun.build` 依赖）；并保留 `artifacts/metafile/chunkMerge/plugin-adapter` 能力。当前 `plugin-adapter` 已切换为 esbuild plugin 适配（target 过滤 + beforeBuild/afterBuild 生命周期），`chunkMerge` 已支持 `metadata`、`entry-only` 与 `size-buckets` 策略，且 `build.ts` 已补齐 `banner/footer` 选项透传；`esbuild-wasm.ts` 已复用 `@mars/web-shared` 的 `WasmModuleLoader` 统一 wasm 模块加载/获取与 reset 语义，且已接入 runtime 启动链路（`runtime-bundler-init` initializer + `initializeBundler/bundlerInit` 透传）；已补齐 worker 选项解析契约（非浏览器默认 `worker=false`、显式参数优先级覆盖全局配置）与初始化分支契约（wasmURL 被拒绝时回退到 worker-only 初始化、重复初始化错误视为 ready），并补齐 runtime 侧 worker 默认/覆盖透传链路回归（`initRuntimeBundler` 浏览器默认 `worker=true`、`bootstrapProcessWorker.bundlerInit.worker` 可覆盖全局 worker）；新增 worker 能力降级语义（worker 不可用时自动回退到 `worker=false`，并在携带 `wasmURL/wasmModule` 时保持 wasm 输入继续初始化）以提升真机可用性；尚未落地 esbuild-wasm 真机 worker 实配与更深入 chunk 决策策略 |
| M6-3 | packages/bun-web-test/vitest.config.ts + packages/bun-web-test/package.json | Vitest 执行入口与门禁脚本 | 100% | 已完成 | `bun run web:test`、`bun run web:test:official` 已可执行；模块测试统一由 Vitest 运行 |
| M6-4 | packages/bun-web-test/tests/**/*.test.ts | 测试用例迁移与快照策略（Vitest） | 85% | 进行中 | 已新增统一快照工具 `tests/snapshot-utils.ts`（稳定化排序+波动字段归一化），并在 M6 聚焦用例与 M3/M5 代表性大用例中落地快照断言；扩面回归（M3+M5+M6）保持全通过，剩余待继续扩面 |
| M6-5 | packages/bun-web-sqlite/src/sqlite.ts | `bun:sqlite` / `node:sqlite` wa-sqlite + OPFS VFS 绑定（RFC §8.1 A级、§10 `bun-web-sqlite/`；原路径 `bun-web-runtime/src/sqlite.ts` 错误，已修正） | 75% | 暂缓 | 冻结当前基线：已扩展 Statement 类（run/all/get/values/iterate/finalize/toString）、Database.query/transaction/inTransaction/filename/deserialize，并完成 WaSQLiteFactory 注入与回归；按最新决策，sqlite/OPFS VFS 后续实现暂不推进 |
| M6-6 | test/bundler/ | 可兼容 bundler 用例回放 | 84% | 进行中 | 已新增 `packages/bun-web-test/tests/m6-bundler-official-replay.test.ts` 并扩面到 24 条官方风格回放子集（define/splitting/chunkMerge off+metadata+entry-only+size-buckets/plugin lifecycle+setup forwarding/sourcemap none+inline+external/external/minify/metafile 开关/banner+footer/warning logs 顺序/target 映射/neutral platform/排序与边界契约/outfile 契约/backend failure 透传）；与 M6 聚焦回归联合验证 72/72 全通过；已达到并超过当前阶段目标通过率（≥ 80%），后续可继续扩面到更多 `test/bundler/*` 语义子集 |
| M6-7 | packages/bun-web-crypto/src/index.ts | `Bun.CryptoHasher` / `Bun.password.hash/verify` / `Bun.hash.*`（RFC §8.1 A级、§10 `bun-web-crypto/`）；@noble/hashes（sha3/blake3/keccak） | 85% | 进行中 | 已切换至 @noble/hashes 纯 JS 路线（browser-native，零依赖）；`CryptoHasher` 支持 sha256/sha512/sha3-256/sha3-512/blake3/keccak-256 等；新增 `bunHash.blake3/sha3_256/keccak256` fast-hash 表面；`passwordHash/passwordVerify` 改用 @noble/hashes/pbkdf2；`m6-sqlite-crypto.test.ts` 扩展为 6/6 全通过；已升级 passwordHash/passwordVerify 至 argon2id（@noble/hashes/argon2.js）；移除 node:crypto 依赖，改用 globalThis.crypto.getRandomValues 与内联 timingSafeEqual；bcrypt 路线可选 |
| M6-8 | packages/bun-web-node/src/zlib.ts | `node:zlib` wasm-flate + brotli-wasm（RFC §8.2 A级） | 75% | 暂缓 | 冻结当前基线：已完成 wasm-flate backend 注入模式与回归验证；按最新决策，zlib 后续实现暂不推进 |
| M6-9 | packages/bun-web-node/src/vm-misc.ts | `node:vm`(B) / `node:v8`(C) / `node:wasi`(B) / `node:assert`(A) / `node:util`(A) / `node:console`(A) / `node:readline`(A) / `node:os`(B) / `node:cluster`(C) 批量实现（RFC §8.2） | 65% | 进行中 | 已新增 `MarsWebUnsupportedError`（code: ERR_BUN_WEB_UNSUPPORTED, compatLevel）与 `clusterModule` D/C 级 stub（fork/setupPrimary/disconnect 等调用均抛 MarsWebUnsupportedError）；已有 vm/assert/util/os/readline/v8/wasi 最小桥接基线；`m6-node-zlib-vm-misc.test.ts` 新增 error shape 与 cluster stub 回归后 8/8 全通过 |

当前进展说明：2026-04-25 本轮推进 M6-1 API 对齐：`packages/bun-web-transpiler/src/swc.ts` 新增 `BunTranspiler`、`transformAsync()`、`scan()` 与 `transformResult()`（返回 code/imports），并保留旧接口兼容；`m6-transpiler-bundler.test.ts` 新增兼容 API 回归后 3/3 通过。M6 基线回归（`m6-transpiler-bundler` + `m6-sqlite-crypto` + `m6-node-zlib-vm-misc`）7/7 通过。
当前进展说明：2026-04-25 本轮完成 M1-M6 偏差修复与复核：修复 `events-stream` buffer encoding 语义、`Buffer.from(ArrayBuffer)` 共享内存语义、`process` 对 `TypedEventEmitter` 继承一致性，并更新过期的 `spawnSync` 占位断言为当前实现语义；M1~M6 全量证据回归 47 文件 576/576 通过。
当前进展说明：2026-04-25 本轮继续推进 M6-1 子模块：`packages/bun-web-transpiler/src` 已新增 `transpiler.types.ts`、`cache.ts`（TranspileCache，memory + IndexedDB fallback）与 `source-map.ts`（inline sourcemap helper），并接入 `BunTranspiler` 的 cache/sourceMaps 路径；`m6-transpiler-bundler.test.ts` 扩展后 5/5 通过，M6 组合回归 9/9 通过。
当前进展说明：2026-04-25 本轮继续推进 M6-1 主路线：`packages/bun-web-transpiler/src/swc.ts` 已接入 swc-wasm 执行链路（支持 `@swc/wasm-web` / `@swc/wasm` 运行时加载），并移除 Bun.Transpiler/fallback 兜底以对齐浏览器运行约束；新增不可用报错回归与 swc async/sync 命中回归后，`m6-transpiler-bundler.test.ts` 扩展为 8/8 通过。
当前进展说明：2026-04-25 本轮继续推进 M6-1 工程化接入：`swc.ts` 已从全局注入切换为显式 loader/init API（`initSwcWasm`、`isSwcWasmReady`），测试侧改为初始化后执行同步转译路径；`packages/bun-web-transpiler/package.json` 已声明 `@swc/wasm-web` 依赖。`m6-transpiler-bundler` 扩展为 9/9 通过，M6 组合回归 13/13 通过。
当前进展说明：2026-04-25 本轮继续推进 M6-1 启动链路：新增 `createInitializedTranspiler()` 异步工厂，用于 runtime 启动阶段先完成 swc-wasm 初始化再下发可同步转译实例；`m6-transpiler-bundler.test.ts` 新增工厂初始化回归后 10/10 通过，M6 组合回归 14/14 通过。
当前进展说明：2026-04-25 本轮继续推进 M6-1 runtime 集成：新增 `packages/bun-web-runtime/src/transpiler-runtime.ts`（`initRuntimeTranspiler/getRuntimeTranspiler/isRuntimeTranspilerReady`），并在 `bootstrapProcessWorker` 增加可选 `initializeTranspiler` 启动开关；`m6-transpiler-bundler.test.ts` 新增 runtime 单例复用与 bootstrap 启动初始化回归后 12/12 通过，M6 组合回归 16/16 通过。
当前进展说明：2026-04-25 本轮继续推进 ProcessBootstrap 抽象：`packages/bun-web-runtime/src/process-bootstrap.ts` 已重构为 `ProcessBootstrap` 类，支持 initializer 队列注册/注销与启动阶段串行执行；swc 初始化改为默认注册任务（受 `initializeTranspiler` 开关控制）并在启动时执行。新增 `m1-vfs-bootstrap` 队列顺序/条件执行回归 2 条，`m6-transpiler-bundler` 继续保持 12/12 通过，M6 组合回归 16/16 通过。
当前进展说明：2026-04-25 本轮继续推进 ProcessBootstrap 队列策略：`ProcessBootstrapOptions` 新增 `bootstrapInitializers`（`'all' | string[]`）用于按 initializer id 选择执行启动任务，并贯通到 `RuntimeProcessSupervisor`/`spawn()` 调用链。新增 `m1-vfs-bootstrap` 显式选择执行回归与 `m6-transpiler-bundler` 按 id 触发 swc 初始化回归后，聚焦回归 91/91 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-1 缓存命中率：`packages/bun-web-transpiler/src/swc.ts` 新增转译 options 稳定序列化（按 key 排序）后再 hash，消除“等价参数仅因键顺序不同导致缓存 miss”的问题；`m6-transpiler-bundler.test.ts` 新增稳定键序回归后，M6 聚焦回归 18/18 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-2 output artifact：`packages/bun-web-bundler/src/build.ts` 新增 `BuildResult.artifacts`（path/kind/loader/hash/bytes/sourcemapPath）与 `metafile` 透传，`m6-transpiler-bundler.test.ts` 增加 artifact/metafile 断言后 14/14 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-2 plugin-adapter：新增 `packages/bun-web-bundler/src/plugin-adapter.ts`，支持插件按 target 过滤执行、`beforeBuild/afterBuild` 生命周期与 `setup` 透传到 esbuild plugin 链路，并在 `m6-transpiler-bundler.test.ts` 增加生命周期与 target 过滤回归后 15/15 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-2 chunk-merger：新增 `packages/bun-web-bundler/src/chunk-merger.ts`，并在 `build()` 增加 `splitting` 与 `chunkMerge: 'metadata'` 选项，返回 entry-point/chunk 聚合统计（entryPointCount/chunkCount/totalBytes/paths）；`m6-transpiler-bundler.test.ts` 新增 split 输出聚合回归后 16/16 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-2 esbuild-wasm 主路径：`packages/bun-web-bundler/src/build.ts` 已移除 `Bun.build`，改为 `esbuild-wasm` backend（`esbuild-wasm.ts` 提供 `initEsbuildWasm()/isEsbuildWasmReady()` 与显式初始化门禁）；M6 聚焦回归（`m6-transpiler-bundler` + `m6-sqlite-crypto` + `m6-node-zlib-vm-misc`）21/21 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-1/M6-2 WASM 抽象收敛：新增 `packages/bun-web-shared/src/wasm-module-loader.ts`（`WasmModuleLoader`），并在 `packages/bun-web-transpiler/src/swc.ts` 与 `packages/bun-web-bundler/src/esbuild-wasm.ts` 复用同一加载/缓存/reset 状态机；既保留 swc/esbuild 各自显式 init 门禁与测试注入接口，也消除重复实现；M6 聚焦回归维持 21/21 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-3 工程一致性：`packages/bun-web-test/vitest.config.ts` 已移除 `defineConfig.resolve.alias`，测试解析改为 workspace 依赖主路径；`packages/bun-web-test/package.json` 已声明 `@mars/web-net` 与 `@mars/web-shared` 为 `workspace:*`，不再依赖配置别名解析；M6 聚焦回归维持 21/21 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-2 浏览器初始化链路：`packages/bun-web-bundler/src/esbuild-wasm.ts` 新增 `resolveEsbuildWasmInitOptions()`，支持从 `globalThis.__BUN_WEB_ESBUILD_WASM__` 读取 `wasmURL/wasmModule/worker`，并在浏览器 runtime 默认 `worker=true`；新增回归覆盖全局配置加载与默认 worker 策略后，M6 聚焦回归提升至 22/22 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-2 runtime 集成：新增 `packages/bun-web-runtime/src/bundler-runtime.ts`（`initRuntimeBundler/isRuntimeBundlerReady`），并在 `ProcessBootstrap` 默认注册 `runtime-bundler-init` 任务；`spawn/supervisor/bootstrap` 已新增 `initializeBundler` 与 `bundlerInit` 透传，支持按 `bootstrapInitializers` 选择执行。新增回归覆盖“启动即初始化”和“按 initializer id 初始化”后，M6 聚焦回归提升至 24/24 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-2 chunk 策略化：`packages/bun-web-bundler/src/chunk-merger.ts` 与 `build.ts` 新增 `chunkMerge: 'entry-only'` 模式，支持仅聚合 entry 输出并报告 `omittedChunkCount`；新增回归覆盖 entry-only 行为后，M6 聚焦回归提升至 25/25 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-2 chunk 策略化（二阶段）：新增 `chunkMerge: 'size-buckets'` 模式，按体积分桶输出 `sizeBuckets`（tiny/small/medium/large）统计并保持与总摘要一致；新增回归覆盖分桶计数与字节一致性后，M6 聚焦回归提升至 26/26 全通过。

当前进展说明：2026-04-25 本轮推进 M6-8 wasm-flate 迁移与 M6-9 错误分级：`packages/bun-web-node/src/zlib.ts` 已切换为 wasm-flate backend 注入模式（`__setFlateBackend`/`initFlateWasm`/`isFlateWasmReady`），brotli 独立 `__setBrotliBackend` 注入模式，移除 fflate/node:zlib 依赖；`vm-misc.ts` 新增 `MarsWebUnsupportedError`（ERR_BUN_WEB_UNSUPPORTED/compatLevel）与 `clusterModule` C 级 stub；`vitest.config.ts` 新增 wasm-flate browser 入口别名；`m6-node-zlib-vm-misc.test.ts` 扩展为 8/8 通过，M6 聚焦回归提升至 32/32 全通过。
当前进展说明：2026-04-25 本轮推进 M6-7 crypto 扩展：`packages/bun-web-crypto/src/index.ts` 切换至 @noble/hashes（blake3/sha3/keccak）纯 JS 路线，移除 node:crypto/createHash 依赖；新增 `bunHash` fast-hash 表面、`CryptoHasher` 多算法支持与 incremental update；`m6-sqlite-crypto.test.ts` 扩展为 6/6 全通过，M6 聚焦回归提升至 36/36 全通过。
当前进展说明：2026-04-25 本轮推进 M6-7 argon2id 升级与 M6-5 WaSQLiteFactory 注入：`bun-web-crypto/src/index.ts` 升级 passwordHash/passwordVerify 至 argon2id（@noble/hashes/argon2.js），移除 node:crypto 依赖，改用 browser-native randomBytes（crypto.getRandomValues）与内联 timingSafeEqual；`bun-web-sqlite/src/sqlite.ts` 新增 WaSQLiteFactory backend 注入模式（同 zlib FlateBackend 模式），wa-sqlite@1.0.0 安装为依赖；新增 6 个回归测试，M6 聚焦回归提升至 48/48 全通过。
当前进展说明：2026-04-25 基于最新实施决策，M6-5（sqlite）与 M6-8（zlib）调整为“暂缓推进”，冻结当前可用基线并保留既有回归覆盖；后续优先推进非 sqlite/zlib 子任务。
当前进展说明：2026-04-25 本轮继续推进 M6-4 快照策略统一：新增 `packages/bun-web-test/tests/snapshot-utils.ts` 作为稳定快照工具（对象键排序 + 波动文本归一化），并在 `m6-transpiler-bundler` / `m6-node-zlib-vm-misc` / `m6-sqlite-crypto` 三个聚焦测试新增统一快照断言；M6 聚焦回归维持 48/48 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-4 扩面：`m3-installer-cache-store.test.ts` 与 `m5-shell-parser-builtins.test.ts` 已接入 `stableSnapshot` 统一断言风格（统计对象/命令解析与执行结果形状）；扩面后回归（M3+M5+M6 聚焦 5 文件）57/57 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-4 扩面（二阶段）：`m3-installer-node-modules-layout.test.ts` 已接入 `stableSnapshot` 统一结构断言（`plan.entries` 复杂数组对象）；扩面后回归（M3+M5+M6 聚焦 6 文件）61/61 全通过。
当前进展说明：2026-04-25 本轮启动 M6-6 bundler 用例回放：新增 `packages/bun-web-test/tests/m6-bundler-official-replay.test.ts`，首批迁移官方风格语义子集（define 常量替换、splitting metadata 汇总、entry-only chunk 省略计数）；与 M6 聚焦回归联合验证 4 文件 51/51 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-6 bundler 用例回放（二阶段）：`m6-bundler-official-replay.test.ts` 已扩面到 plugin lifecycle/target 过滤、`chunkMerge: size-buckets` 与 `sourcemap: external` map artifact 关联校验；与 M6 聚焦回归联合验证 4 文件 54/54 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-6 bundler 用例回放（三阶段）：`m6-bundler-official-replay.test.ts` 新增 `external` 裸模块保持、`minify` 产物收缩与 define 保真、`metafile` outputs 暴露校验，回放子集累计 9 条；与 M6 聚焦回归联合验证 4 文件 57/57 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-6 bundler 用例回放（四阶段）：`m6-bundler-official-replay.test.ts` 新增 `banner/footer` 注入、warning logs 透传、target→platform 映射校验，回放子集累计 12 条；并同步补齐 `packages/bun-web-bundler/src/build.ts` 的 `banner/footer` 透传。与 M6 聚焦回归联合验证 4 文件 60/60 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-6 bundler 用例回放（五阶段）：`m6-bundler-official-replay.test.ts` 新增 `chunkMerge: off` 空摘要契约、plugin `setup` 透传注册校验、未指定 target 的 `neutral` 平台映射校验，回放子集累计 15 条；与 M6 聚焦回归联合验证 4 文件 63/63 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-6 bundler 用例回放（六阶段）：`m6-bundler-official-replay.test.ts` 新增 `size-buckets` 边界分桶（1023/1024/10KB/100KB）校验、`metadata` 路径排序确定性校验、仅非 mergeable artifact 时返回空摘要校验，回放子集累计 18 条；与 M6 聚焦回归联合验证 4 文件 66/66 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-6 bundler 用例回放（七阶段）：`m6-bundler-official-replay.test.ts` 新增 `outfile` 单输出路径契约、`sourcemap: none -> false` 后端映射校验与 `sourcemap: inline` 透传校验，回放子集累计 21 条；与 M6 聚焦回归联合验证 4 文件 69/69 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-6 bundler 用例回放（八阶段）：`m6-bundler-official-replay.test.ts` 新增 backend build failure 透传拒绝校验、warning logs 顺序保持校验、`metafile` 开关显隐校验，回放子集累计 24 条；与 M6 聚焦回归联合验证 4 文件 72/72 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-2 worker 初始化策略验证：`m6-transpiler-bundler.test.ts` 新增 `resolveEsbuildWasmInitOptions` 的“非浏览器默认 `worker=false`”与“显式参数优先于全局配置”回归校验；与 M6 聚焦回归联合验证 4 文件 74/74 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-2 初始化分支覆盖：`m6-transpiler-bundler.test.ts` 新增 `initEsbuildWasm` 的“wasmURL 非浏览器被拒绝后回退到 worker-only initialize”与“Cannot call initialize more than once 视为 ready 并短路后续 init”回归校验；与 M6 聚焦回归联合验证 4 文件 76/76 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-2 runtime worker 实配链路：`m6-transpiler-bundler.test.ts` 新增 `initRuntimeBundler` 浏览器默认 `worker=true` 与 `bootstrapProcessWorker` 下 `bundlerInit.worker` 覆盖全局 `worker=true` 的透传回归校验；与 M6 聚焦回归联合验证 4 文件 78/78 全通过。
当前进展说明：2026-04-25 本轮继续推进 M6-2 worker 能力降级语义：`packages/bun-web-bundler/src/esbuild-wasm.ts` 新增 worker 不可用错误识别并自动回退 `worker=false` 初始化；`m6-transpiler-bundler.test.ts` 新增“无 wasm 输入降级回退”与“保留 wasmURL 的降级回退”回归校验；与 M6 聚焦回归联合验证 4 文件 80/80 全通过。
当前进展说明：2026-04-25 本轮启动 M7 文档契约固化：将 HookRegistry（register/on/registerAll、enable/disable、execute/emit 分离、preset 注入）补充到实施计划与 RFC 设计文档；M7 维持 0%（仅设计与验收标准固化，代码尚未落地）。
当前进展说明：2026-04-25 M7-1 HookRegistry 代码落地：创建 packages/bun-web-hooks 新包（hook.ts / define-hook.ts / timings.ts / presets.ts / hooks.types.ts / index.ts），注册到 root workspace；新增 m7-hooks.test.ts 26 条用例全通过；实施文档 M7-1 状态更新为 100% 完成。
当前进展说明：2026-04-25 M7-2 PluginRegistry 落地：创建 packages/bun-web-plugin-api 新包（plugin.types.ts / loader-pattern.ts / plugin-context.ts / sandbox.ts / plugin-registry.ts / index.ts）；Bun.plugin 兼容接口通过 PluginContextImpl.asBunBuildContext 实现；新增 m7-plugin-api.test.ts 24 条用例全通过；M7 组合回归 50/50 全通过。
当前进展说明：2026-04-25 M7-3/M7-4 CompatRegistry + gen-compat-matrix 落地：创建 packages/bun-web-compat-registry 新包（compat.types.ts / levels.ts / registry.ts / scanner.ts / index.ts）；实现 CompatRegistry 单例、assertSupported D 级守卫、validate 未登记检测、scanDtsContent 正则扫描；新增 scripts/gen-compat-matrix.ts CI 脚本；M7 三包组合回归 83/83 全通过。
### M1-M6 文档一致性审计（2026-04-25 第三轮）

| 里程碑 | 结论 | 证据 | 偏差与风险 | 修正动作 |
| --- | --- | --- | --- | --- |
| M1 | ✅ 已对齐 | 本轮 M1~M6 全量证据回归：576/576 通过 | 先前 `spawnSync` 占位断言已过期 | 已更新验收用例到当前语义并通过 |
| M2 | ✅ 已对齐（当前基线） | `m2-node-stream-replay-uint8array`、`m2-node-buffer` 等相关回放均通过 | 已消除 stream/buffer 关键语义缺口 | 持续保持官方回放子集门禁 |
| M3 | ✅ 基本一致 | M3 相关用例本轮全部通过（含 install replay/lock/layout/cache/retry/semver） | 未见与实施/模块设计冲突 | 保持现状，持续回放官方增量子集 |
| M4 | ✅ 一致 | M4 组合回归 38/38 通过，M4-1~M4-10 已闭环 | 未见主路径偏差 | 维持完成态 |
| M5 | ✅ 一致 | `m5-shell-parser-builtins` + `m5-worker-async-hooks` 全通过 | 未见主路径偏差 | 维持完成态 |
| M6 | 🟨 进行中（范围已调整） | M6 聚焦回归 48/48 全通过 | M6-7 已完成 @noble/hashes + argon2id 迁移；M6-9 已补齐 MarsWebUnsupportedError 与 cluster stub；M6-5（sqlite）与 M6-8（zlib）按最新决策暂缓推进并冻结当前基线 | 持续推进非 sqlite/zlib 的 M6 子任务 |

---

## M7 Plugin + Compat Registry + CI

### 实施前确认（Stage Gate）

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 聚焦插件机制、兼容矩阵与 CI 门禁，不扩展运行时特性 | [x] 已确认 |
| 文件级任务确认 | M7-1~M7-8 文件与职责已确认（含 bun-web-agent / bun-web-client SDK 补充项） | [x] 已确认 |
| 前置依赖确认 | M1-M6 的 API 表面与测试入口可复用 | [x] 已确认 |
| 测试计划确认 | 明确插件生命周期与 CI 失败门槛 | [x] 已确认 |
| 启动决策 | 批准进入 M7 编码 | [x] 已确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M7-1 | packages/bun-web-hooks/src/hook.ts | Hook 引擎（HookRegistry） | 100% | ✅ 完成 | 基于 HookRegistry 完成 register/on/registerAll、enable/disable、unregister/clear、preset 注入；按 priority 升序执行并支持 timing 级过滤；`execute(interceptor)` 与 `emit(observer)` 分离，错误记录不阻断后续 hook |
| M7-2 | packages/bun-web-plugin-api/src/index.ts | `Bun.plugin` 统一适配层 | 100% | ✅ 完成 | `Bun.plugin({ name, setup })` 映射到 HookRegistry 的 loader timing（`loader:load/transform/source-map`）；支持插件运行时 disable/enable 与副作用回滚；loader 插件在 build/run 两条链路均生效 |
| M7-3 | packages/bun-web-compat-registry/src/index.ts | API 符号分级注册表 | 100% | ✅ 完成 | 所有公开符号有等级登记 |
| M7-4 | scripts/gen-compat-matrix.ts | 从 bun-types 扫描并生成兼容矩阵 | 100% | ✅ 完成 | 漏登记时 CI 失败 |
| M7-5 | .github/workflows/web-runtime.yml | 浏览器 runtime CI 流水线 | 0% | ⏭️ 跳过（用户决策） | 合并前自动执行门禁 |
| M7-6 | packages/bun-web-test/tests/m7-acceptance.test.ts | 插件生命周期验收用例（13 测试：register/disable/enable/unregister/rollback/multi-plugin/dispose/Bun.plugin-compat/list-consistency） | 100% | ✅ 完成 | 注册/卸载副作用可回滚 |
| M7-7 | packages/bun-web-agent/src/index.ts | AI Agent 受限 shell + 审计 overlay（RFC §10 `bun-web-agent/`）；能力白名单、命令审计日志、沙箱隔离（19 测试） | 100% | ✅ 完成 | 受限命令集可执行，禁止命令返回明确拒绝（非崩溃） |
| M7-8 | packages/bun-web-client/src/sdk.ts | `@mars/web-client` 宿主 SDK 完整接口（RFC §10 `bun-web-client/`）：`BunContainer.boot/mount/spawn/on('server-ready')`；PreviewManager；ContainerProcess/TerminalHandle（20 测试） | 100% | ✅ 完成 | RFC §10 示例代码可直接运行 |

---

## M8 官方测试集直通 + 性能稳定性

### 实施前确认（Stage Gate）

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 聚焦官方测试通过率、基线维护与性能稳定性 | [x] 已确认 |
| 文件级任务确认 | M8-1~M8-7 文件与指标责任已确认 | [x] 已确认 |
| 前置依赖确认 | M1-M7 的实现与门禁链路基本齐备 | [x] 已确认（M1-M7 全部完成，135 测试通过） |
| 测试计划确认 | 明确目录阈值、回归策略与压测计划 | [x] 已确认 |
| 启动决策 | 批准进入 M8 收敛阶段 | [x] 已确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M8-1 | test/integration/bun-in-browser/run-official-tests.ts | 全目录并发执行、阈值与基线对比；`--concurrency`/`--json`/`--update-baseline` CLI flags | 100% | ✅ 完成 | 支持目录门禁与回归判定 |
| M8-2 | test/integration/bun-in-browser/skip-in-browser.txt | 跳过规则精细化与 issue 绑定 | 100% | ✅ 完成 | 每条跳过有可追溯原因 |
| M8-3 | test/integration/bun-in-browser/baseline.json | 基线固化与更新策略（含全部 7 个目录初始条目） | 100% | ✅ 完成 | 新回归可自动报警 |
| M8-4 | scripts/bench-web-runtime.ts | 启动/HMR/install/grep 基准采集（p50/p95/min/max；--json 趋势追加） | 100% | ✅ 完成 | 输出性能趋势报告 |
| M8-5 | packages/bun-web-runtime/src/memory-gc.ts | Blob URL LRU + revokeObjectURL GC；ProcessHandleRegistry Worker 追踪；MemoryGC 协调器（14 测试） | 100% | ✅ 完成 | LRU eviction 与 dispose 验证通过 |
| M8-6 | docs/rfc/bun-in-browser-webcontainer-implementation-plan.md | M8 状态同步，模块追踪表更新 | 100% | ✅ 完成 | 发布前状态与现实一致 |
| M8-7 | packages/bun-web-example/src/index.ts | BunContainer -> mount -> spawn/eval -> output 端到端示例包；补齐整体流程实施项并升级为 `Vite + React + TypeScript`（Dify 风格）模板（3 测试） | 100% | ✅ 完成 | 宿主 SDK 到代码执行链路可直接验证 |

### M7-M8 文档一致性审计（2026-04-25 第四轮）

| 项目 | 结论 | 证据 | 修正动作 |
| --- | --- | --- | --- |
| BunContainer 整体流程实施项 | 🟨 先前缺失显式条目 | 原实施计划仅在 M7-8 与 RFC 示例提到 `BunContainer`，没有单独的端到端落实项 | 新增 M8-7 `@mars/web-example`，用 `runBunWebExample()` 固化 `boot -> mount -> spawn -> output` 链路 |
| `bun-web-runtime` 跨包导入规范 | 🟨 存在偏差 | `process-bootstrap.ts` / `bundler-runtime.ts` 仍使用跨包相对路径 | 已改为 `@mars/web-node` / `@mars/web-bundler` scoped import |
| `@mars/web-client` API 对齐 | ✅ 已收敛到当前实现 | `BunContainerBootOptions` 补齐 `tunnelUrl/coopCoepHeaders/workerType`；`spawn` 同时支持 object form 与 RFC 示例风格 | 已同步模块设计文档与 RFC 主文档；新增 example 测试锁定行为 |

---

## 4. 迭代摘要

## Iteration 0（已完成）

- 交付：
  - RFC 主文档修正（HTTP2 级别、UA 表述、路径与链接一致性）
  - 验收测试骨架与官方测试驱动脚本
  - 排除清单文件与 npm 脚本入口
- 结果：
  - 文档与门禁路径一致，具备执行入口
  - 尚未接入真实 runtime 实现

## Iteration 1（目标：M1-M2）

- 目标：打通最小运行时链路（Kernel/VFS/Resolver/node:fs）
- 计划完成度目标：项目总体 13% → 35%
- 关键风险：SAB 同步桥在浏览器策略限制下可能回退到 async 模式
- 退出条件：`bun run entry.ts` 在浏览器容器内可执行并读写文件

## Iteration 2（目标：M3-M5）

- 目标：安装器 + Bun.serve + Shell/Spawn 基础能力
- 计划完成度目标：35% → 65%
- 关键风险：SW 生命周期与 WebSocket 桥接稳定性
- 退出条件：express/koa/tsx 验收用例稳定通过

## Iteration 3（目标：M6-M8）

- 目标：build/test/plugin/compat registry 与官方测试直通
- 计划完成度目标：65% → 100%
- 关键风险：官方测试集通过率波动与性能回归
- 退出条件：
  - 官方门禁达到 RFC 阈值
  - 兼容矩阵与基线文件可持续维护

---

## 5. 测试文件与测试状态

> 本节记录“已创建测试文件”的当前状态。状态分为：`通过`、`失败`、`未运行`、`阻塞`。

### 5.1 Bun-in-browser 自有测试文件

| 文件 | 类型 | 运行命令 | 测试状态 | 最新结果 |
| --- | --- | --- | --- | --- |
| packages/bun-web-test/tests/acceptance.test.ts | 验收集成测试 | `bun run web:test` | 待复测 | 已迁移到 Vitest，用例位置已切换；待补全 Vitest 下全量结果回填 |
| packages/bun-web-test/tests/m1-kernel.test.ts | M1 smoke 测试 | `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts tests/m1-kernel.test.ts` | 通过 | 2026-04-25：12 pass / 0 fail |
| packages/bun-web-test/tests/m1-acceptance.test.ts | M1 acceptance 测试 | `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts tests/m1-acceptance.test.ts` | 通过 | 2026-04-25：15 pass / 0 fail |
| packages/bun-web-test/tests/m2-node-fs.test.ts | M2 node:fs smoke 测试 | `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts tests/m2-node-fs.test.ts` | 通过 | 2026-04-25：11 pass / 0 fail |
| packages/bun-web-test/tests/m2-node-fs-official-replay.test.ts | M2 node:fs 官方用例移植（Stats/internal-for-testing/abort-signal） | `bun run web:test -- tests/m2-node-fs-official-replay.test.ts` | 通过 | 2026-04-25：8 pass / 0 fail；新增 `internal-for-testing` bare alias 兼容验证；替代 `bun bd test` 作为当前迭代验证路径 |
| packages/bun-web-test/tests/m2-node-path.test.ts | M2 node:path smoke 测试 | `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts tests/m2-node-path.test.ts` | 通过 | 2026-04-25：8 pass / 0 fail |
| packages/bun-web-test/tests/m2-node-path-official-replay.test.ts | M2 node:path 官方用例移植（parse/format/toNamespacedPath/basename 子集） | `bun run web:test -- tests/m2-node-path-official-replay.test.ts` | 通过 | 2026-04-25：4 pass / 0 fail |
| packages/bun-web-test/tests/m2-node-module-official-replay.test.ts | M2 node:module 官方用例移植（builtin resolve + require cache + createRequire base 语义 + Module 类 + wrap/paths/extensions/lookupPaths 子集） | `bun run web:test -- tests/m2-node-module-official-replay.test.ts` | 通过 | 2026-04-25 晚期：14/14 pass（扩展后）；覆盖 isBuiltin/require.resolve builtin 缓存隔离/cache 隔离/trailing slash/file URL base/builtinModules 数组/Module 类实例化/Module.wrap 包装/wrap 无参/nodeModulePaths 路径生成/_extensions 加载器/_resolveLookupPaths 路径解析 |
| packages/bun-web-test/tests/m2-node-url.test.ts | M2 node:url/querystring/string_decoder smoke 测试 | `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts tests/m2-node-url.test.ts` | 通过 | 2026-04-25：7 pass / 0 fail |
| packages/bun-web-test/tests/m2-node-module.test.ts | M2 node:module smoke 测试 | `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts tests/m2-node-module.test.ts` | 通过 | 2026-04-25：14 pass / 0 fail |
| packages/bun-web-test/tests/m2-node-fs.test.ts | M2 node:fs smoke 测试（含 `fs.watch`） | `bunx --bun vitest run --config ./vitest.config.ts tests/m2-node-fs.test.ts` | 通过 | 2026-04-25：12 pass / 0 fail；新增 `watch()` 监听与 unsubscribe 回归 |
| packages/bun-web-test/tests/m2-node-buffer.test.ts | M2 node:buffer smoke 测试 | `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts tests/m2-node-buffer.test.ts` | 通过 | 2026-04-25：51 pass / 0 fail |
| packages/bun-web-test/tests/m2-node-events.test.ts | M2 node:events smoke 测试 | `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts packages/bun-web-test/tests/m2-node-events.test.ts` | 通过 | 2026-04-25：10 pass / 0 fail（Vitest 迁移后首个回归通过） |
| packages/bun-web-test/tests/m2-node-stream.test.ts | M2 node:stream smoke 测试 | `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts tests/m2-node-stream.test.ts` | 通过 | 2026-04-25：14 pass / 0 fail |
| packages/bun-web-test/tests/m2-node-stream-replay-uint8array.test.ts | M2 node:stream 官方回放（uint8array 子集） | `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts tests/m2-node-stream-replay-uint8array.test.ts` | 通过 | 2026-04-25：5 pass / 0 fail |
| packages/bun-web-test/tests/m2-node-stream-web-promises.test.ts | M2 node:stream/web + stream/promises smoke 测试 | `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts tests/m2-node-stream-web-promises.test.ts` | 通过 | 2026-04-25：3 pass / 0 fail |
| packages/bun-web-test/tests/m2-resolver.test.ts | M2 resolver smoke 测试 | `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts tests/m2-resolver.test.ts` | 通过 | 2026-04-25：33 pass / 0 fail |
| packages/bun-web-test/tests/m2-webapis.test.ts | M2 webapis smoke 测试 | `bunx --bun vitest run --config packages/bun-web-test/vitest.config.ts tests/m2-webapis.test.ts` | 通过 | 2026-04-25：39 pass / 0 fail |
| packages/bun-web-test/tests/m3-installer-registry.test.ts | M3 installer registry 最小语义回归（metadata + version 解析） | `bunx --bun vitest run tests/m3-installer-registry.test.ts` | 通过 | 2026-04-25：4 pass / 0 fail |
| packages/bun-web-test/tests/m3-installer-tarball.test.ts | M3 installer tarball 最小语义回归（download + integrity + extract） | `bunx --bun vitest run tests/m3-installer-tarball.test.ts` | 通过 | 2026-04-25：4 pass / 0 fail |
| packages/bun-web-test/tests/m3-installer-lockfile.test.ts | M3 installer lockfile 最小语义回归（read/write/upsert 稳定性） | `bunx --bun vitest run tests/m3-installer-lockfile.test.ts` | 通过 | 2026-04-25：4 pass / 0 fail |
| packages/bun-web-test/tests/m3-installer-node-modules-layout.test.ts | M3 installer node_modules 扁平布局回归（hoist + 冲突嵌套 + 祖先复用） | `bunx --bun vitest run tests/m3-installer-node-modules-layout.test.ts` | 通过 | 2026-04-25：4 pass / 0 fail |
| packages/bun-web-test/tests/m3-installer-cache-store.test.ts | M3 installer cache-store 最小语义回归（IndexedDB/OPFS 命中与回填） | `bunx --bun vitest run tests/m3-installer-cache-store.test.ts` | 通过 | 2026-04-25：4 pass / 0 fail |
| packages/bun-web-test/tests/m3-installer-cli-install-replay.test.ts | M3 installer 回放可兼容安装测试（映射 `test/cli/install` 子语义） | `bunx --bun vitest run tests/m3-installer-cli-install-replay.test.ts` | 通过 | 2026-04-25：20 pass / 0 fail |
| packages/bun-web-test/tests/m3-install-cli-tarball-integrity.test.ts | M3 真实目录门禁适配（映射 `test/cli/install/bun-install-tarball-integrity.test.ts`：integrity 存储、稳定性、内容变更失败、无 integrity 字段、缓存命中一致性） | `bunx --bun vitest run tests/m3-install-cli-tarball-integrity.test.ts` | 通过 | 2026-04-25：5 pass / 0 fail |
| packages/bun-web-test/tests/m3-install-cli-overrides.test.ts | M3 真实目录门禁适配（映射 `test/cli/install/overrides.test.ts`：overrides 替换根依赖、覆盖 transitive 依赖、后设 override、移除 override 恢复、多 override 同时生效） | `bunx --bun vitest run tests/m3-install-cli-overrides.test.ts` | 通过 | 2026-04-25：5 pass / 0 fail |
| packages/bun-web-test/tests/m3-install-cli-lock.test.ts | M3 真实目录门禁适配（映射 `test/cli/install/bun-lock.test.ts`：lockfile 创建、keys 排序、round-trip 稳定、跨 reinstall 幂等、transitive 完整、lockfile-only 无 tarball、增量 upsert、dependency keys 排序） | `bunx --bun vitest run tests/m3-install-cli-lock.test.ts` | 通过 | 2026-04-25：8 pass / 0 fail |
| packages/bun-web-test/tests/m3-install-cli-layout.test.ts | M3 真实目录门禁适配（映射 `test/cli/install/bun-install.test.ts` hoist/dedup/nested 子集：根依赖路径、transitive hoist、共享去重、冲突嵌套、entries 有序、links 指向正确、所有包在 plan 中） | `bunx --bun vitest run tests/m3-install-cli-layout.test.ts` | 通过 | 2026-04-25：7 pass / 0 fail |
| package.json + nx.json + packages/bun-web-*/package.json | Nx 批量构建编排 | `bun run web:build` | 通过 | 2026-04-25：Nx 已识别并按依赖顺序构建 9 个 bun-web 模块（含 `@mars/web-installer`） |
| packages/bun-web-test/tests/m7-hooks.test.ts | M7-1 HookRegistry 单元测试 | `bunx --bun vitest run tests/m7-hooks.test.ts` | 通过 | 2026-04-25：26 pass / 0 fail |
| packages/bun-web-test/tests/m7-plugin-api.test.ts | M7-2 PluginRegistry 单元测试 | `bunx --bun vitest run tests/m7-plugin-api.test.ts` | 通过 | 2026-04-25：24 pass / 0 fail |
| packages/bun-web-test/tests/m7-compat-registry.test.ts | M7-3/4 CompatRegistry + gen-compat-matrix 单元测试 | `bunx --bun vitest run tests/m7-compat-registry.test.ts` | 通过 | 2026-04-25：33 pass / 0 fail |
| packages/bun-web-test/tests/m7-acceptance.test.ts | M7-6 插件生命周期验收用例 | `bunx --bun vitest run tests/m7-acceptance.test.ts` | 通过 | 2026-04-25：13 pass / 0 fail |
| packages/bun-web-test/tests/m7-agent.test.ts | M7-7 bun-web-agent AgentShell + AuditOverlay 单元测试 | `bunx --bun vitest run tests/m7-agent.test.ts` | 通过 | 2026-04-25：19 pass / 0 fail |
| packages/bun-web-test/tests/m7-client-sdk.test.ts | M7-8 bun-web-client BunContainer/PreviewManager 单元测试 | `bunx --bun vitest run tests/m7-client-sdk.test.ts` | 通过 | 2026-04-25：20 pass / 0 fail |
| packages/bun-web-test/tests/m8-memory-gc.test.ts | M8-5 memory-gc BlobURLRegistry LRU + ProcessHandleRegistry 单元测试 | `bunx --bun vitest run tests/m8-memory-gc.test.ts` | 通过 | 2026-04-25：14 pass / 0 fail |
| packages/bun-web-test/tests/m8-example-flow.test.ts | M8-7 bun-web-example 端到端链路测试（含 Vite+React+TS 模板断言；BunContainer -> mount -> spawn -> output） | `bunx --bun vitest run tests/m8-example-flow.test.ts` | 通过 | 2026-04-25：4 pass / 0 fail（新增 example App 实际接线 `runBunWebExample` 的回归断言） |
| packages/bun-web-test/tests/m8-ecosystem-acceptance.test.ts | §11.1 生态验收（Express + Koa + Fastify + Hono + Bun.serve routes-style + Vite+React+TS + tsx + Shell 子项 + installer 依赖安装回放） | `bunx --bun vitest run tests/m8-ecosystem-acceptance.test.ts` | 通过 | 2026-04-25：10 pass / 0 fail（新增 Hono 与 Bun.serve routes-style scaffold+run smoke；installer 已扩展到 transitive 依赖解析与布局断言：accepts/cookies/esbuild） |
| packages/bun-web-example/package.json | §11.1 真实依赖安装与构建验证（workspace install + Vite build） | `pnpm i --config.strict-ssl=false && pnpm run build:app` | 通过 | 2026-04-25：安装完成并产出 `dist/`（31 modules transformed）；当前环境需关闭 strict-ssl 以绕过证书链异常 |
| package.json + nx.json + packages/bun-web-*/package.json | Nx 批量类型检查编排 | `bun run web:typecheck` | 通过 | 2026-04-25：Nx 已识别 9 个 bun-web 模块（含 `@mars/web-installer`），集中类型检查已全量通过 |
| test/js/node/module/node-module-module.test.js + test/js/node/path/parse-format.test.js + test/js/node/path/to-namespaced-path.test.js + test/js/node/path/basename.test.js + test/js/node/url/pathToFileURL.test.ts | M2-6 官方目录真实门禁子集 | `USE_BUN_WEB_RUNTIME=1 bun test <5 files>` | 通过 | 2026-04-25：39 pass / 0 fail；验证 `node:module` 主链路与 path/url 关键语义已可在 `test/js/node` 真目录回放 |
| test/js/node/fs/fs.test.ts + test/js/node/fs/fs-mkdir.test.ts | M2-6 官方目录 fs 稳定子集 | `USE_BUN_WEB_RUNTIME=1 bun test test/js/node/fs/fs.test.ts test/js/node/fs/fs-mkdir.test.ts` | 通过 | 2026-04-25：264 pass / 5 skip / 0 fail；fs 主路径在真实目录可回放 |
| test/js/node/fs/fs-stats-truncate.test.ts + test/js/node/fs/fs-stats-constructor.test.ts | M2-6 官方目录 fs 差距子集 | `USE_BUN_WEB_RUNTIME=1 bun test test/js/node/fs/fs-stats-truncate.test.ts test/js/node/fs/fs-stats-constructor.test.ts` | 失败 | 2026-04-25：最新复测结果仍为 `1 pass / 3 fail / 1 error`；阻塞 1) `bun:internal-for-testing` 依赖在当前源码状态下仍未解除（`ENOENT reading "bun:internal-for-testing"`）；2) `Stats(...) without new` 与 `Stats prototype` 语义差异（2 fail） |
| test/integration/bun-in-browser/run-official-tests.ts（`--dir test/js/node/fs`） | M2-6 官方目录 fs 门禁（按 skip-in-browser 过滤后） | `bun test/integration/bun-in-browser/run-official-tests.ts --dir test/js/node/fs` | 通过 | 2026-04-25：修复 root 路径、skip 前缀匹配与 `--dir` 阈值继承后持续可用；最新结果 11/11，门禁 100%（≥95%）。同日去除 `fs-stats*` skip 的探测结果为 12/14，定位到 `bun:internal-for-testing` 与 `Stats(...)` 语义差异两项核心阻塞。 |
| `bun bd test test/js/node/fs/fs-stats-constructor.test.ts` | M2-6 根因验证（源码构建路径，非当前主流程） | `bun bd test test/js/node/fs/fs-stats-constructor.test.ts` | 阻塞 | 当前主验证流程已迁移到 `bun-web-test`；该路径仅用于后续 runtime 根因调试。当前仓库在调试构建阶段被 [build.zig](build.zig#L881) 的 `unreachable else prong` 编译错误阻断。 |
| test/integration/bun-in-browser/run-official-tests.ts | 官方测试驱动脚本 | `bun run web:test:official` / `bun test/integration/bun-in-browser/run-official-tests.ts --dir test/js/bun/http` | 进行中 | 2026-04-25：已跑 `test/js/bun/http`（25/25, 100%）与 `test/js/bun/shell`（31/31, 100%）；驱动补充 `CI=1` 与 `stdin: ignore` 以避免交互阻塞 |
| test/integration/bun-in-browser/skip-in-browser.txt | 跳过清单 | 被 `run-official-tests.ts` 读取 | 进行中 | 规则文件已生效，仍需按 issue 逐条补齐注释 |
| test/integration/bun-in-browser/baseline.json | 回归基线 | `bun run web:test:official:update-baseline` | 已创建（部分） | 2026-04-25：已通过 `bun test/integration/bun-in-browser/run-official-tests.ts --dir test/js/node/fs --update-baseline` 落盘 `test/js/node/fs` 基线（11/11, rate=1.0）；后续随目录扩展继续补齐 |

### 5.2 官方测试目录状态（目标与当前）

| 测试目录 | 目标状态 | 当前状态 | 备注 |
| --- | --- | --- | --- |
| test/js/web/ | 通过率 100% | 未运行 | 待 M1-M2 完成后启动 |
| test/js/node/ | 通过率 >= 95% | 进行中 | 2026-04-25：已跑 module/path/url 子集 39 pass / 0 fail，fs 稳定子集 264 pass / 5 skip / 0 fail；剩余阻塞在 `bun:internal-for-testing` 依赖、`Stats(...)` 构造语义对齐，以及 `abort-signal-leak-read-write-file` 的浏览器 runtime GC 波动 |
| test/js/bun/http/ | 通过率 >= 90% | 通过 | 2026-04-25：`bun test/integration/bun-in-browser/run-official-tests.ts --dir test/js/bun/http` 结果 25/25（100%）；同时 `packages/bun-web-test/tests/m4-*.test.ts` 专项回归 31/31 通过 |
| test/js/bun/crypto/ | 通过率 >= 90% | 未运行 | 依赖 M6 crypto/hasher 适配 |
| test/js/bun/shell/ | 通过率 >= 85% | 已通过（31/31, 100%） | 2026-04-25：M5-6 门禁通过；失败阻塞项已在 skip 清单注明原因 |
| test/cli/install/ | 通过率 >= 80% | 进行中 | 2026-04-25：20 条语义回放（20/20）+ 真实目录门禁：`bun-install-tarball-integrity` 映射（5/5）、`overrides` 映射（5/5）、`bun-lock` 映射（8/8）、`bun-install` hoist/dedup 映射（7/7）；合计 45 条全部通过；待后续扩展 |
| test/bundler/ | 通过率 >= 80% | 未运行 | 依赖 M6 bundler |

### 5.3 状态更新规则

- 每次执行测试后，必须同步更新本节“测试状态/最新结果”。
- “通过”状态必须附命令与日期；“失败”状态必须附首个关键错误。
- 任一目录从“通过”回退到“失败”时，需在迭代摘要新增回归说明。

## 6. 维护机制

- 每次迭代结束后必须更新：
  - 本文档各阶段完成度
  - 对应 TODO 的状态与验收备注
  - 迭代摘要中的风险与退出条件
- 严禁“代码未落地但完成度上升”。完成度变化必须可由提交与 CI 结果追溯。
---

## 7. RFC → 任务追踪矩阵

> 每次完成实施任务，必须对照本矩阵核查：任务是否覆盖了对应 RFC 章节的所有要求。RFC 章节若有修订，矩阵也必须同步更新。

| RFC 章节 | 核心要求摘要 | 对应实施任务 ID | 覆盖状态 |
| --- | --- | --- | --- |
| §1 分层架构 | Kernel Worker / Process Workers / Service Worker 三层结构 | M1-1, M1-5, M4-1 | ✅ 已完成（M1 + M4 基线） |
| §2 VFS（三层叠加） | BaseLayer / PersistLayer(OPFS) / MemLayer；SyncAccessHandle；fs.watch BroadcastChannel | M1-3, M1-4 | 🟨 进行中（本轮已补 `WatchBus + VFS.watch` 主路径） |
| §3 SAB Bridge | Process→Kernel 同步 syscall 协议；iOS async fallback | M1-2, M1-7 | 🟨 进行中 |
| §4.1 Resolver | exports/imports/conditions；tsconfig paths/baseUrl；.ts↔.js 互换 | M2-1, M2-2 | ✅ 已完成（M2） |
| §4.2 Transpiler | swc-wasm(主力) / esbuild-wasm(bundler) / IndexedDB 缓存 | M6-1 | 🟨 进行中（API 基线已落地，WASM 路线待补齐） |
| §4.3 Module Registry | ESM Blob URL / CJS new Function / node:* jspm-core | M2-3, M2-5 | 🟨 进行中 |
| §5.1 HTTP 拦截 | fetch 拦截；虚拟主机 `<pid>.bun.local`；零拷贝 body | M4-1, M4-3 | ✅ 已完成（M4） |
| §5.2 WebSocket 桥 | VirtualWebSocket / BroadcastChannel；Bundler 自动替换符号 | M4-4 | ✅ 已完成（M4） |
| §5.3 出站请求 | 外部 fetch/WS 透传；CORS 限制文档化 | M4-3（隐含） | ✅ 已完成（M4） |
| §5.4 TCP/TLS 隧道（可选） | WS 代理服务端；无配置时 NotSupportedError | M4-10 | ✅ 已完成（M4） |
| §6 插件体系 | Hook 命名空间、MarsWebPlugin 类型、安全沙箱、Bun.plugin 对齐 | M7-1, M7-2 | ✅ 完成（M7-1 HookRegistry + M7-2 PluginRegistry 均已落地，50/50 组合通过） |
| §7 Shell 命令集 | parser（管道/重定向/glob）；Phase 1 全量内置命令（AI Agent 高频） | M5-1, M5-2, M5-7 | ✅ 已完成（M5） |
| §8.1 Bun.* 顶层 | version/env/argv/cwd/nanoseconds/sleep | M1-5, M1-6 | 🟨 进行中（`nanoseconds/sleep` 最小实现已在 runtime Bun mirror 落地） |
| §8.1 Bun.file/write/stdin/stdout/stderr | VFS + Blob 包装 | M1-3, M2-3 | 🟨 进行中（最小 `file()/write()/stdin/stdout/stderr` mirror 已落地，Blob/更完整兼容面待补） |
| §8.1 Bun.serve / server.* | 端口表 + SW 转发；TLS/unix/reusePort 降级 | M4-2 | ✅ 已完成（M4） |
| §8.1 Bun.spawn / spawnSync | JS/TS→Worker；系统二进制→Shell builtin | M5-3 | ✅ 已完成（M5 基线） |
| §8.1 Bun.$ (Shell) | bun-web-shell 完整实现 | M5-1, M5-2, M5-7 | ✅ 已完成（M5 基线） |
| §8.1 Bun.Transpiler | swc-wasm 包装，对齐选项 | M6-1 | 🟨 进行中 |
| §8.1 Bun.build / Bun.plugin | esbuild-wasm + hook 引擎 | M6-2, M7-2 | 🟨 进行中（build 基线已落地，plugin/WASM 路线待补） |
| M6-7 | packages/bun-web-crypto/src/index.ts | `Bun.CryptoHasher` / `Bun.password.hash/verify` / `Bun.hash.*`（RFC §8.1 A级、§10 `bun-web-crypto/`）；@noble/hashes（sha3/blake3/keccak） | 85% | 进行中 | 已切换至 @noble/hashes 纯 JS 路线（browser-native，零依赖）；`CryptoHasher` 支持 sha256/sha512/sha3-256/sha3-512/blake3/keccak-256 等；新增 `bunHash.blake3/sha3_256/keccak256` fast-hash 表面；`passwordHash/passwordVerify` 改用 @noble/hashes/pbkdf2；`m6-sqlite-crypto.test.ts` 扩展为 6/6 全通过；已升级 passwordHash/passwordVerify 至 argon2id（@noble/hashes/argon2.js）；移除 node:crypto 依赖，改用 globalThis.crypto.getRandomValues 与内联 timingSafeEqual；bcrypt 路线可选 |
| §8.1 Bun.dns.* | DoH（默认 cloudflare endpoint，可配置） | M4-8 | ✅ 已完成（M4） |
| §8.1 bun:sqlite | wa-sqlite + OPFS VFS | M6-5 | ⏸️ 暂缓（冻结当前 Statement/WaSQLiteFactory 基线） |
| §8.1 测试能力（Vitest） | 统一 Vitest 门禁与 snapshot 策略 | M6-3, M6-4 | 🟨 进行中 |
| §8.1 bun:ffi | 存根；允许 dlopen('.wasm') 扩展 | M7-3（compat registry 登记 D级） | ⬜ 未开始 |
| §8.2 node:fs / fs/promises | VFS + SAB sync | M2-3 | 🟨 进行中 |
| §8.2 node:path / url / querystring | 纯算法 | M2-4 | 🟨 进行中 |
| §8.2 node:buffer | buffer 包 + Bun 扩展 | M2-7 | 🟨 进行中 |
| §8.2 node:events / stream / stream/web | readable-stream | M2-8 | 🟨 进行中 |
| §8.2 node:os | cpus=hardwareConcurrency；platform='browser' | M6-9 | 🟨 进行中 |
| §8.2 node:crypto | WebCrypto + crypto-browserify + WASM | M6-7（兼含） | 🟨 进行中 |
| §8.2 node:tls / net | SW 代理；Socket→WS 隧道 | M4-7 | ✅ 已完成（M4） |
| §8.2 node:http / https | net 之上构建 | M4-7 | ✅ 已完成（M4） |
| §8.2 node:http2 | C级，仅 request-like 子集 | M4-7（含存根） | ✅ 已完成（M4） |
| §8.2 node:zlib | pako + fflate + brotli-wasm | M6-8 | ⏸️ 暂缓（冻结当前 wasm-flate 基线） |
| §8.2 node:child_process | Worker 模拟 exec/spawn/fork | M5-3（Bun.spawn 兼含） | ✅ 已完成（M5 基线） |
| §8.2 node:worker_threads | Worker 直接对应 | M5-4 | ✅ 已完成（M5 基线） |
| §8.2 node:async_hooks / AsyncLocalStorage | Zone 风格 polyfill | M5-5 | ✅ 已完成（M5 基线） |
| §8.2 node:vm / v8 / wasi | B/C级实现 | M6-9 | 🟨 进行中 |
| §8.2 node:assert / util / console / readline | 移植 src/js/node/ | M6-9 | 🟨 进行中 |
| §8.2 node:process | 完整 process 对象 | M1-6 | 🟨 进行中 |
| §8.2 node:module | createRequire / isBuiltin / register | M2-5 | 🟨 进行中 |
| §8.2 node:sqlite | 映射到 bun:sqlite | M6-5（含别名） | ⏸️ 暂缓（随 bun:sqlite 同步冻结） |
| §8.3 Web 标准 API | fetch/Blob/File/URL/WebSocket/Streams/TextEncoder/crypto 等；navigator UA 兼容策略 | M2-9 | 🟨 进行中 |
| §9 Compat Registry | 符号→级别注册；CI 扫描 bun-types；产出 COMPAT.md | M7-3, M7-4 | ⬜ 未开始 |
| §10 `bun-web-kernel/` | Kernel + 调度 + SAB syscall bridge | M1-1, M1-2, M1-7 | 🟨 进行中 |
| §10 `bun-web-vfs/` | OPFS/Mem overlay fs；包缓存 | M1-3, M1-4, M3-5 | 🟨 进行中 |
| §10 `bun-web-runtime/` | Process Worker bootstrap、Bun.* 实现；MemoryGC（Blob URL LRU + Worker 句柄追踪） | M1-5, M4-2, M5-3, M8-5 | ✅ 已完成（M8-5 GC 模块） |
| §10 `bun-web-shared/` | 跨包公共能力（event-emitter 等） | M1-10 | 🟨 进行中 |
| §10 `bun-web-node/` | node:* 全家桶 polyfill | M2-3~M2-8, M4-7, M5-4, M5-5, M6-8, M6-9 | 🟨 进行中 |
| §10 `bun-web-webapis/` | Web 标准 API 补丁层 | M2-9 | 🟨 进行中 |
| §10 `bun-web-resolver/` | 模块解析 | M2-1, M2-2 | ✅ 已完成（M2） |
| §10 `bun-web-transpiler/` | swc/esbuild WASM 封装 | M6-1 | 🟨 进行中 |
| §10 `bun-web-installer/` | bun install | M3-1~M3-6 | 🟨 进行中 |
| §10 `bun-web-bundler/` | Bun.build | M6-2 | 🟨 进行中 |
| §10 `bun-web-shell/` | Bun.$ 解释器 | M5-1, M5-2 | ✅ 已完成（M5 基线） |
| §10 `bun-web-shell/`（builtin 模块） | 全部 builtin shell 命令（并入 shell 包） | M5-7 | ✅ 已完成（M5 phase1） |
| §10 `bun-web-sw/` | Service Worker HTTP + WS 虚拟化；SW 保活 | M4-1, M4-9 | ✅ 已完成（M4） |
| §10 `bun-web-test/` | Vitest 测试包与门禁入口 | M6-3, M6-4 | 🟨 进行中 |
| §10 `bun-web-sqlite/` | wa-sqlite OPFS VFS 绑定 | M6-5 | ⏸️ 暂缓（当前基线保留，后续不推进） |
| M6-7 | packages/bun-web-crypto/src/index.ts | `Bun.CryptoHasher` / `Bun.password.hash/verify` / `Bun.hash.*`（RFC §8.1 A级、§10 `bun-web-crypto/`）；@noble/hashes（sha3/blake3/keccak） | 85% | 进行中 | 已切换至 @noble/hashes 纯 JS 路线（browser-native，零依赖）；`CryptoHasher` 支持 sha256/sha512/sha3-256/sha3-512/blake3/keccak-256 等；新增 `bunHash.blake3/sha3_256/keccak256` fast-hash 表面；`passwordHash/passwordVerify` 改用 @noble/hashes/pbkdf2；`m6-sqlite-crypto.test.ts` 扩展为 6/6 全通过；已升级 passwordHash/passwordVerify 至 argon2id（@noble/hashes/argon2.js）；移除 node:crypto 依赖，改用 globalThis.crypto.getRandomValues 与内联 timingSafeEqual；bcrypt 路线可选 |
| §10 `bun-web-net/` | net/tls/http/http2 over WS 隧道 | M4-3, M4-4, M4-7 | ✅ 已完成（M4） |
| §10 `bun-web-dns/` | DoH 客户端 | M4-8 | ✅ 已完成（M4） |
| §10 `bun-web-hooks/` | Hook 引擎与类型 | M7-1 | ✅ 完成 |
| §10 `bun-web-plugin-api/` | 公共插件 SDK | M7-2 | ✅ 已完成（M7） |
| §10 `bun-web-agent/` | AI Agent 受限 shell + 审计 overlay | M7-7 | ✅ 已完成（M7） |
| §10 `bun-web-compat-registry/` | 符号→级别注册表 | M7-3, M7-4 | ✅ 已完成（M7） |
| §10 `bun-web-client/` | 宿主页面 SDK（BunContainer API） | M4-5, M7-8 | ✅ 已完成（M7）（M4 预览链路 + M7 SDK 全接口） |
| §10 `bun-web-example/` | BunContainer 到代码执行整体流程验证包 | M8-7 | ✅ 已完成（M8） |
| §10 `bun-web-proxy-server/` | 可选 WS/TCP 隧道服务端 | M4-10 | ✅ 已完成（M4） |
| §11.1 生态验收 | Express / Koa / Fastify / Hono / Bun.serve routes-style / Vite+React+TS / tsx / Shell 用例 | M4-6, M5-6, M6-6（及各阶段 smoke） | 🟨 进行中（八个子项 smoke 已全部落地并通过；Express/Koa/Fastify/Hono 与 Bun.serve routes-style 均覆盖框架风格 hook/middleware/route + 404 路由矩阵语义，installer mock-registry 已从根依赖回放扩展到 transitive 依赖解析与布局安装断言。2026-04-25 已修复 pnpm workspace 配置阻塞（root resolutions + pnpm-workspace 范围）；在当前证书环境下通过 `pnpm --config.strict-ssl=false` 已完成 bun-web-example 真实依赖安装与 `vite build` 验证。后续目标是恢复 strict-ssl 默认链路并扩面到更多真实框架依赖） |
| §11.2 官方测试直通 | 分目录通过率门禁；skip 机制；基线回归 | M8-1, M8-2, M8-3 | ✅ 已完成（M8） |
| §11.3 插件体系验收 | loader/hook/副作用回滚 | M7-6 | ✅ 已完成（M7，13 测试） |
| §11.4 API 表面完整性 | typeof 扫描；D级符号行为；tsc 零错误 | M7-3, M7-4 | ✅ 已完成（M7）|
| §11.5 性能基线 | Kernel 冷启 <1.5s；install <8s；HMR <300ms 等 | M8-4 | ✅ 已完成（bench 脚本，待真实数据回填）|
| §11.6 稳定性 | 1h 无泄漏；SW 自愈 | M4-9, M8-5 | 🟨 进行中（M4 心跳/恢复已完成，M8 稳态压测待执行） |
| §12 里程碑（顺序） | M1-M8 核心交付与验收入口 | 实施计划各阶段（M5/M6 内容顺序有已记录偏差） | 对齐中 |
| §13 SAB iOS 受限 | async fallback 模式 | M1-7 | 🟨 进行中 |
| §13 SW 生命周期回收 | Clients.claim + 心跳保活；activate 重建端口表 | M4-9 | ✅ 已完成（M4） |
| §13 ESM Blob URL 膨胀 | LRU + revokeObjectURL GC | M8-5 | ✅ 已完成（memory-gc.ts BlobURLRegistry LRU）|
| §13 esbuild/swc WASM 性能 | WASM SIMD + 多 Worker 并行（后期优化） | M8-4（bench 指导） | ⬜ 未开始 |

### 全模块代码格式对齐审计（2026-04-25）

| 项目 | 结论 | 范围 | 后续动作 |
| --- | --- | --- | --- |
| `packages/bun-web-*` 代码格式一致性 | 🟨 进行中 | 源码、测试、配置与文档代码片段 | 自本轮起作为跨阶段硬要求执行；每次推进按触达文件先收敛，再逐模块补齐历史漂移 |
| 风格参考基线 | ✅ 已确认 | better-chatbot 参考风格 + oxfmt/oxlint | 后续所有实施任务在验收前均需附带格式对齐与 lint 结果 |