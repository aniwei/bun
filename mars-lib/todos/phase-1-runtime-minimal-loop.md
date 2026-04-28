# Phase 1: Runtime 最小闭环

- 状态: Done
- 总完成百分比: 100%
- 测试状态: Pass
- 依赖 Phase: 无
- 对应技术设计文档: `mars-lib/rfc/0001-mars-lib-technical-design.md`
- Playground 接入矩阵: `mars-lib/playground/README.md`
- 相关章节: 4 总体架构, 6 用户侧 API, 7 MarsBridge 通信协议, 8 MarsKernel 进程与端口接口, 9 MarsVFS 接口, 10 Mars Service Worker Runtime, 11 Bun API Facade, 12 Node HTTP 兼容层, 15 MarsShell 与 AI Agent 接口, 19 请求流转, 20.1 Express, 20.2 Koa, 20.5 AI Agent Shell, 21 验收测试接口, 22 M1

## 开始前确认

### 技术设计核对

- 确认 MarsRuntime 是用户主入口，负责暴露 `vfs`、`shell`、`kernel`、`plugins`、`boot()`、`dispose()`、`run()`、`spawn()`、`fetch()`、`preview()`。
- 确认 MarsBridge 统一使用 request/notify/on 的消息模型，所有跨 Page、Service Worker、Runtime Worker 的消息必须带 `id`、`type`、`source`、`target`、`payload`。
- 确认 MarsKernel 在 M1 只需要实现进程表、端口表、stdio 事件、`spawn()`、`kill()`、`waitpid()`、`registerPort()`、`resolvePort()`、`dispatchToPort()`。
- 确认 MarsVFS 在 M1 需要覆盖同步与异步基础读写，支持 `exists`、`readFile`、`writeFile`、`stat`、`readdir`、`mkdir`、`unlink`、`rename`。
- 确认 MarsServiceWorkerRuntime 需要完成虚拟端口请求转发，访问 `http://mars.localhost:3000/` 时能转发到 MarsKernel 注册的 VirtualServer。
- 确认 Bun API Facade 在 M1 只需要优先实现 `Bun.file()`、`Bun.write()`、`Bun.serve()`、`Bun.fetch()` 的验收路径。
- 确认 Node HTTP 兼容层只做纯 `node:http`/`http`、Express app/router/middleware 与 Koa async middleware 所需最小实现；Mars loader 注入 `node:http`/`http` 核心模块，应用源码不直接引用 `@mars/node`；`node:http` 直接注册 MarsKernel 虚拟端口，不基于 `Bun.serve()` 包装。
- 确认 MarsShell 在 M1 只做基础命令和结构化结果，不做完整 POSIX shell。

### 代码风格

- 以 `mars-lib/AGENTS.md` 为默认基线，若子模块已有规范且冲突，需在变更说明中注明偏差理由。
- TypeScript / JavaScript 尽量不使用分号 `;` 和双引号 `"`，避免超长行，复杂表达式主动换行。
- 命名保持语义完整，除极小作用域临时变量外，不使用 `tmp`、`ctx`、`cfg`、`obj` 等泛化命名。
- 导入顺序遵循 AGENTS 规则: 绝对 default -> 相对 default -> 绝对具名 -> 相对具名 -> type imports -> 样式/静态资源。
- 接口类型与实现拆分，公共类型放在 `types` 或 `interface` 文件，避免跨层反向依赖。
- 单文件超过 1000 行必须拆分，优先按领域职责、运行时边界（runtime/kernel/vfs/loader/hooks）、types 与实现拆分。
- Rust 代码遵循同等可读性要求，`use` 顺序为标准库/第三方 -> `crate::` -> `super::`。
- 提交前执行并通过 `ox format --check` 与 `ox lint --max-warnings 0`。

### 前置依赖

- 无前置 Phase。
- 需要先确认 monorepo 基础工作区、TypeScript 配置、测试工具和浏览器测试方案。

## Todo

| ID | 状态 | 完成百分比 | 测试通过 | 文件/模块 | 功能介绍 | 完成时设计核对 |
| --- | --- | ---: | --- | --- | --- | --- |
| M1-01 | Done | 100% | Pass | `mars-lib/package.json` | 定义 Mars-lib 工作区根包、脚本入口、包管理器约束。 | 核对 RFC 第 5 节包结构和 npm scope。 |
| M1-02 | Done | 100% | Pass | `mars-lib/tsconfig.base.json` | 定义 TypeScript 基础编译配置，供所有 Mars TS 包继承。 | 核对 M1 TypeScript 包公共类型和显式导出要求。 |
| M1-03 | Done | 100% | Pass | `mars-lib/packages/mars-bridge/src/protocol.ts` | 定义 `MarsMessage`、`MarsResponse`、`SerializedError`、消息 source/target/type 常量。 | 核对 RFC 第 7 节消息 envelope 字段完整性。 |
| M1-04 | Done | 100% | Pass | `mars-lib/packages/mars-bridge/src/endpoint.ts` | 实现 `MarsBridgeEndpoint` 的 `request`、`notify`、`on`、超时、AbortSignal 和响应匹配。 | 核对所有跨边界消息使用统一协议。 |
| M1-05 | Done | 100% | Pass | `mars-lib/packages/mars-vfs/src/path.ts` | 实现路径 normalize、join、dirname、basename、相对路径转绝对路径。 | 核对 RFC 第 9 节 Unix 风格路径要求。 |
| M1-06 | Done | 100% | Pass | `mars-lib/packages/mars-vfs/src/mem-layer.ts` | 实现内存 VFS 层，支持文件、目录、基础 stat 元数据。 | 核对 M1 基础读写和目录能力。 |
| M1-07 | Done | 100% | Pass | `mars-lib/packages/mars-vfs/src/vfs.ts` | 实现 `MarsVFS` 同步/异步 API、cwd、chdir、watch 事件骨架。 | 核对 RFC 第 9 节 MarsVFS 接口。 |
| M1-08 | Done | 100% | Pass | `mars-lib/packages/mars-kernel/src/process-table.ts` | 实现 `ProcessDescriptor` 存储、pid 分配、状态更新、ps 查询。 | 核对 RFC 第 8 节进程表字段。 |
| M1-09 | Done | 100% | Pass | `mars-lib/packages/mars-kernel/src/port-table.ts` | 实现端口到 pid/VirtualServer 的映射、动态端口分配、注册、注销、查询。 | 核对 RFC 第 8 与第 19 节虚拟端口流转。 |
| M1-10 | Done | 100% | Pass | `mars-lib/packages/mars-kernel/src/kernel.ts` | 实现 MarsKernel boot/shutdown/spawn/kill/waitpid/registerPort/dispatchToPort。 | 核对 RFC 第 8 节 MarsKernel 接口。 |
| M1-11 | Done | 100% | Pass | `mars-lib/packages/mars-sw/src/classify-request.ts` | 实现 `classifyRequest()`，识别 virtual-server、vfs-asset、module、external。 | 核对 RFC 第 10 节请求分类规则。 |
| M1-12 | Done | 100% | Pass | `mars-lib/packages/mars-sw/src/router.ts` | 实现 Service Worker router，将虚拟服务请求转发给 kernel client。 | 核对 RFC 第 10 与第 19.2 节请求转发路径。 |
| M1-13 | Done | 100% | Pass | `mars-lib/packages/mars-runtime/src/bun-file.ts` | 实现 `Bun.file()` 的最小 MarsBunFile，支持 text/json/arrayBuffer/stream。 | 核对 RFC 第 11 节 Bun API Facade。 |
| M1-14 | Done | 100% | Pass | `mars-lib/packages/mars-runtime/src/bun-write.ts` | 实现 `Bun.write()` 到 MarsVFS 的写入路径。 | 核对 RFC 第 11 节和 VFS 写入语义。 |
| M1-15 | Done | 100% | Pass | `mars-lib/packages/mars-runtime/src/bun-serve.ts` | 实现 `Bun.serve()`、Server 对象、动态 port 注册、stop/reload 骨架。 | 核对 RFC 第 11 与第 19.1 节。 |
| M1-16 | Done | 100% | Pass | `mars-lib/packages/mars-runtime/src/install-global.ts` | 安装 `globalThis.Bun`、`process`、基础 `Buffer` 入口。 | 核对 RFC 第 11 节全局对象要求。 |
| M1-17 | Done | 100% | Pass | `mars-lib/packages/mars-node/src/http.ts` | 实现 `createServer()`、`listen()`/`listen(0)`、`close()`、`address()` 的最小 HTTP 兼容层，并通过 runtime core module 注入绑定 `node:http`/`http`。 | 核对 RFC 第 12 节纯 node:http 与 Express/Koa 映射。 |
| M1-18 | Done | 100% | Pass | `mars-lib/packages/mars-node/src/incoming-message.ts` | 将 Request 适配为 Express/Koa 可读的 IncomingMessage 子集。 | 核对 Express/Koa hello world 所需 req 字段。 |
| M1-19 | Done | 100% | Pass | `mars-lib/packages/mars-node/src/server-response.ts` | 将 ServerResponse 写入转换为 Web Response。 | 核对 `res.send()` 和 Koa body 输出路径。 |
| M1-20 | Done | 100% | Pass | `mars-lib/packages/mars-shell/src/parser.ts` | 实现基础 shell 命令解析，支持命令、参数、`&&`。 | 核对 RFC 第 15 节基础 Shell 范围。 |
| M1-21 | Done | 100% | Pass | `mars-lib/packages/mars-shell/src/commands/fs.ts` | 实现 `ls`、`cd`、`pwd`、`cat`、`echo`、`mkdir`、`rm` 基础命令。 | 核对 RFC 第 20.5 节 AI Agent Shell 验收。 |
| M1-22 | Done | 100% | Pass | `mars-lib/packages/mars-shell/src/shell.ts` | 实现 `MarsShell.run()`、`stream()` 骨架和 `CommandResult`。 | 核对 RFC 第 15 节 MarsShell 接口。 |
| M1-23 | Done | 100% | Pass | `mars-lib/packages/mars-client/src/runtime.ts` | 实现 `createMarsRuntime()`、boot/dispose、vfs/kernel/shell 组装。 | 核对 RFC 第 6 节用户侧 API。 |
| M1-24 | Done | 100% | Pass | `mars-lib/packages/mars-client/src/preview.ts` | 实现 `preview(port)`，生成 `http://mars.localhost:${port}/`。 | 核对 RFC 第 10 和第 19.2 节虚拟服务访问。 |
| M1-25 | Done | 100% | Pass | `mars-lib/packages/mars-test/src/acceptance.ts` | 定义 `AcceptanceCase`、`AcceptanceRunnerOptions`、`AcceptanceResult` 测试接口。 | 核对 RFC 第 21 节验收测试接口。 |
| M1-26 | Done | 100% | Pass | `mars-lib/playground/core-modules/bun/`, `mars-lib/playground/node-http/` | 编写 Runtime/VFS/Shell、Bun.file/Bun.write、Bun.serve 和纯 node:http 使用实例。 | 核对 RFC 第 6、9、11、12、15、19.1 与 20.5 节验收标准。 |
| M1-27 | Done | 100% | Pass | `mars-lib/playground/express/server.ts` | 编写 Express 风格 app/use/get/post/listen 验收样例，源码通过 `node:http` 创建服务，覆盖 middleware、GET query、POST JSON body 和 close 解绑。 | 核对 RFC 第 20.1 节 Express 验收标准。 |
| M1-28 | Done | 100% | Pass | `mars-lib/playground/koa/server.ts` | 编写 Koa async middleware 洋葱模型验收样例，源码通过 `http` 创建服务，覆盖 next/after middleware、GET query、POST body 和 close 解绑。 | 核对 RFC 第 20.2 节 Koa 验收标准。 |
| M1-29 | Done | 100% | Pass | `mars-lib/packages/mars-test/src/phase1.acceptance.test.ts` | 真实读取 playground Phase 1 使用实例，通过 Mars loader 执行源码并覆盖 VFS、Bun.serve、node:http、http、Express、Koa、Shell 基础命令。 | 核对 RFC 第 20 和第 21 节验收项。 |

## Phase 完成标准

- `MarsRuntime.boot()` 可以创建可用 runtime。
- MarsVFS 可以完成基础读写、目录操作和 stat。
- `Bun.serve()` 注册虚拟 3000 端口后，Service Worker router 可以将请求转发到对应 handler。
- 纯 `node:http`、`http`、Express app/router/middleware 和 Koa async middleware 洋葱模型通过验收，且应用源码走 Node core specifier 而不是 `@mars/node`。
- Playground 已接入 `playground/core-modules/bun`、`playground/node-http`、`playground/express` 与 `playground/koa`，并在 Phase 1 acceptance test 和 Vite React playground 中覆盖核心路径。
- MarsShell 可执行 `ls`、`cd`、`pwd`、`cat`、`echo`、`mkdir`、`rm`，返回 `CommandResult`。
- Phase 1 测试全部通过。

## 状态更新规则

1. 每完成一个 Todo，先对照“完成时设计核对”列检查实现是否偏离 RFC。
2. Todo 状态可取 `Not Started`、`In Progress`、`Blocked`、`Done`。
3. Todo 完成百分比按实际实现、测试、文档核对共同判断；未测试不得超过 80%。
4. `测试通过` 可取 `Not Run`、`Pass`、`Fail`、`N/A`。
5. Phase 总完成百分比按 Todo 完成百分比平均计算。
6. Phase 状态在所有 Todo 为 `Done`、测试通过且 `mars-lib/playground/README.md` 已同步后更新为 `Done`。
