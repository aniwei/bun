# Phase 4: AI Agent 与插件生态

- 状态: Not Started
- 总完成百分比: 0%
- 测试状态: Not Run
- 依赖 Phase: Phase 1、Phase 2、Phase 3 必须通过
- 对应技术设计文档: `mars-lib/rfc/0001-mars-lib-technical-design.md`
- Playground 接入矩阵: `mars-lib/playground/README.md`
- 相关章节: 6 用户侧 API, 7 MarsBridge 通信协议, 14 Mars Hooks 插件系统, 15 MarsShell 与 AI Agent 接口, 20.5 AI Agent Shell, 21 验收测试接口, 22 M4

## 开始前确认

### 技术设计核对

- 确认 Phase 4 的目标是把 Hook、Shell、Plugin、Agent 能力产品化，不重写 Phase 1-3 的 runtime 基础设施。
- 确认 MarsHooks 是横切系统，覆盖 API 调用、请求、响应、文件读写、模块解析、模块加载、代码转译、命令执行、进程生命周期。
- 确认 Hook 上下文必须携带 `traceId`、`pid`、`cwd`、`pluginName`、`runtimeId`，便于 AI Agent 调试和审计。
- 确认 Shell 面向 AI Agent 需要结构化输出，而不是只输出文本。
- 确认自定义命令通过 `MarsShell.registerCommand()` 或 Hook `onCommandRun` 扩展。
- 确认 Plugin Registry 先做本地/离线安装和加载，不强依赖远程服务。
- 确认 Agent task replay 依赖 Phase 3 的 snapshot/restore 和稳定日志。

### 代码风格

- 以 `mars-lib/AGENTS.md` 为默认基线，若子模块已有规范且冲突，需在变更说明中注明偏差理由。
- TypeScript / JavaScript 尽量不使用分号 `;` 和双引号 `"`，避免超长行，复杂表达式主动换行。
- 命名保持语义完整，除极小作用域临时变量外，不使用 `tmp`、`ctx`、`cfg`、`obj` 等泛化命名。
- 导入顺序遵循 AGENTS 规则: 绝对 default -> 相对 default -> 绝对具名 -> 相对具名 -> type imports -> 样式/静态资源。
- 插件类型定义集中在 `mars-plugin-api`，Hook 调度、Trace、策略与 runtime 组合分层实现，避免跨层反向依赖。
- Trace 与 Replay 数据结构必须稳定、可序列化、可导出、可 diff，不包含不可克隆对象。
- 单文件超过 1000 行必须拆分，优先按领域职责、运行时边界（runtime/kernel/vfs/loader/hooks）、types 与实现拆分。
- Rust 代码遵循同等可读性要求，`use` 顺序为标准库/第三方 -> `crate::` -> `super::`。
- 提交前执行并通过 `ox format --check` 与 `ox lint --max-warnings 0`。

### 前置依赖

- Phase 1: Shell、VFS、Kernel、Service Worker 基础能力可用。
- Phase 2: Loader、Transpiler、Installer、Vite 验收可用。
- Phase 3: API 覆盖、OPFS、snapshot/restore、浏览器 profile 稳定。

## Todo

| ID | 状态 | 完成百分比 | 测试通过 | 文件/模块 | 功能介绍 | 完成时设计核对 |
| --- | --- | ---: | --- | --- | --- | --- |
| M4-01 | Not Started | 0% | Not Run | `mars-lib/packages/mars-plugin-api/src/types.ts` | 定义 `MarsPlugin`、Hook context、MaybePromise、Disposable、Plugin metadata。 | 核对 RFC 第 14 节 MarsPlugin 接口。 |
| M4-02 | Not Started | 0% | Not Run | `mars-lib/packages/mars-hooks/src/container.ts` | 实现 `PluginContainer.use/remove/list/callHook`。 | 核对 RFC 第 14 节 PluginContainer。 |
| M4-03 | Not Started | 0% | Not Run | `mars-lib/packages/mars-hooks/src/order.ts` | 实现 `enforce: pre/post`、注册顺序和 Hook 执行顺序。 | 核对 RFC 第 14 节插件调度要求。 |
| M4-04 | Not Started | 0% | Not Run | `mars-lib/packages/mars-hooks/src/request-pipeline.ts` | 实现 `onRequest` 洋葱模型和 `onResponse` 调度。 | 核对 RFC 第 14 节 request hook。 |
| M4-05 | Not Started | 0% | Not Run | `mars-lib/packages/mars-hooks/src/api-call.ts` | 实现 `beforeApiCall`、`afterApiCall`、短路和结果记录。 | 核对 RFC 第 14 节 API hook。 |
| M4-06 | Not Started | 0% | Not Run | `mars-lib/packages/mars-hooks/src/file-hooks.ts` | 实现 `onFileRead`、`onFileWrite` 内容替换和访问控制。 | 核对 RFC 第 14 与第 20.5 节。 |
| M4-07 | Not Started | 0% | Not Run | `mars-lib/packages/mars-hooks/src/module-hooks.ts` | 实现 `onResolve`、`onLoad`、`onTransform` 接入 loader pipeline。 | 核对 RFC 第 14 与第 13 节。 |
| M4-08 | Not Started | 0% | Not Run | `mars-lib/packages/mars-hooks/src/command-hooks.ts` | 实现 `onCommandRun`、`onCommandOutput` 和自定义命令扩展。 | 核对 RFC 第 14 与第 15 节。 |
| M4-09 | Not Started | 0% | Not Run | `mars-lib/packages/mars-hooks/src/trace.ts` | 定义 HookTrace、TraceEvent、traceId 生成、导出和过滤。 | 核对 RFC 第 14 节 Hook 上下文字段。 |
| M4-10 | Not Started | 0% | Not Run | `mars-lib/packages/mars-client/src/plugin-runtime.ts` | 将 PluginContainer 接入 MarsRuntime boot/dispose 和各模块。 | 核对 RFC 第 6 与第 14 节。 |
| M4-11 | Not Started | 0% | Not Run | `mars-lib/packages/mars-shell/src/structured-output.ts` | 为 `grep`、`find`、`ps`、`inspect` 等命令输出稳定 JSON。 | 核对 RFC 第 15 与第 20.5 节。 |
| M4-12 | Not Started | 0% | Not Run | `mars-lib/packages/mars-shell/src/commands/search.ts` | 实现 `grep`、`find` 的结构化搜索结果。 | 核对 RFC 第 15 节内置命令。 |
| M4-13 | Not Started | 0% | Not Run | `mars-lib/packages/mars-shell/src/commands/process.ts` | 实现 `ps`、`kill` 命令并返回结构化进程列表。 | 核对 RFC 第 15 节进程管理命令。 |
| M4-14 | Not Started | 0% | Not Run | `mars-lib/packages/mars-shell/src/commands/agent.ts` | 实现 `inspect`、`snapshot`、`restore`、`hooks` Agent 命令。 | 核对 RFC 第 15 与第 22 M4。 |
| M4-15 | Not Started | 0% | Not Run | `mars-lib/packages/mars-shell/src/completion.ts` | 实现命令、路径、插件命令自动补全。 | 核对 RFC 第 15 节 complete 接口。 |
| M4-16 | Not Started | 0% | Not Run | `mars-lib/packages/mars-plugin-api/src/permissions.ts` | 定义插件权限模型，如 fs/read、fs/write、network、process、shell。 | 核对 RFC 第 23.2 节浏览器安全限制。 |
| M4-17 | Not Started | 0% | Not Run | `mars-lib/packages/mars-hooks/src/policy.ts` | 实现文件系统策略插件和权限拒绝错误。 | 核对 RFC 第 20.5 节文件读取 Hook。 |
| M4-18 | Not Started | 0% | Not Run | `mars-lib/packages/mars-plugin-api/src/registry.ts` | 定义插件 registry metadata、安装来源、版本和入口。 | 核对 RFC 第 22 M4 Plugin registry。 |
| M4-19 | Not Started | 0% | Not Run | `mars-lib/packages/mars-hooks/src/registry.ts` | 实现本地/离线插件 registry 加载、启用、禁用。 | 核对 Phase 4 不依赖外部服务要求。 |
| M4-20 | Not Started | 0% | Not Run | `mars-lib/packages/mars-agent/src/task-log.ts` | 定义 Agent task log、命令记录、文件变更、hook trace 引用。 | 核对 RFC 第 22 M4 Agent task replay。 |
| M4-21 | Not Started | 0% | Not Run | `mars-lib/packages/mars-agent/src/replay.ts` | 基于 snapshot/restore 重放 Agent task，验证输出一致性。 | 核对 Phase 3 snapshot/restore 依赖。 |
| M4-22 | Not Started | 0% | Not Run | `mars-lib/packages/mars-client/src/trace-viewer-model.ts` | 提供 Hook trace viewer 的数据模型和过滤 API。 | 核对 RFC 第 22 M4 Hook trace viewer。 |
| M4-23 | Not Started | 0% | Not Run | `mars-lib/examples/plugins/audit-plugin.ts` | 示例插件: 记录文件写入和请求响应。 | 核对 RFC 第 14 节插件示例。 |
| M4-24 | Not Started | 0% | Not Run | `mars-lib/examples/plugins/encrypted-files-plugin.ts` | 示例插件: 文件读写加密/解密。 | 核对 RFC 第 20.5 节文件读取 Hook。 |
| M4-25 | Not Started | 0% | Not Run | `mars-lib/packages/mars-test/src/phase4.acceptance.test.ts` | 覆盖 Hook 调度、结构化 shell、插件 registry、策略插件、task replay。 | 核对 RFC 第 20.5、第 21、第 22 M4。 |
| M4-26 | Not Started | 0% | Not Run | `mars-lib/docs/plugins.md` | 编写插件开发文档、Hook 顺序、权限和示例。 | 核对 RFC 第 14 与第 22 M4。 |
| M4-27 | Not Started | 0% | Not Run | `mars-lib/docs/agent-shell.md` | 编写 AI Agent Shell 命令、结构化输出和 replay 文档。 | 核对 RFC 第 15 与第 20.5 节。 |

## Phase 完成标准

- MarsHooks 覆盖 API、request/response、file、module、command、process 生命周期。
- Hook trace 可导出、可过滤、可关联 pid/cwd/runtimeId/pluginName。
- Shell 的搜索、进程、agent 命令支持结构化输出。
- 插件可以通过 registry 本地安装、启用、禁用。
- 文件系统策略插件能拦截读取/写入并返回可解释错误。
- Agent task replay 可以从 snapshot 恢复并重放命令序列。
- 插件开发文档和 Agent Shell 文档可指导新插件实现。
- Playground 已接入插件、Hook trace、Agent Shell 或 replay 示例，并在 Phase 4 acceptance test 中真实执行。
- Phase 4 测试全部通过。

## 状态更新规则

1. 每个 Todo 完成后必须核对 RFC 第 14、15、20.5、22 M4 的对应要求。
2. 涉及 Hook pipeline 的变更必须运行 Phase 1-3 相关回归，确认没有破坏 runtime 主路径。
3. Todo 未有验收测试或示例前，完成百分比不得超过 80%。
4. 插件权限、策略、replay 相关 Todo 未完成安全核对前不得标记 `Done`。
5. Phase 总完成百分比按 Todo 完成百分比平均计算。
6. 所有 Todo 为 `Done`，Phase 1-4 验收通过，且 playground 接入矩阵、插件文档和 Agent Shell 文档同步后，Phase 状态更新为 `Done`。
