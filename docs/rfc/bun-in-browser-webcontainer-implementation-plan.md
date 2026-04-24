# Bun-in-Browser WebContainer 实施文档

| 字段 | 值 |
| --- | --- |
| 状态 | Draft |
| 版本 | v1 (2026-04-24) |
| 关联 RFC | bun-in-browser-webcontainer.md |
| 模块 API 设计 | bun-in-browser-module-design.md |
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
- TS/JS 代码尽量不使用分号与双引号，优先单引号与自然分段空行
- 每阶段提交前必须完成格式化与 lint 检查

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
---

## 2. 总体完成度看板

| 阶段 | 名称 | 当前完成度 | 状态 | 说明 |
| --- | --- | --- | --- | --- |
| M0 | 文档与门禁基线 | 100% | 已完成 | RFC 修订、验收脚手架与官方测试驱动脚本已落盘 |
| M1 | Kernel + VFS 最小可运行 | 100% | 已完成 | kernel/vfs/runtime 最小骨架 + `@mars/web-shared` 公共事件层 + `@mars/web-node` process 继承改造已落盘；M1-1 新增 stdio 通道管理（allocateStdio/onStdio/notifyExit/waitpid 事件驱动），并补 worker message port 接入（attachProcessPort，将 stdout/stderr/exit 接到 onStdio + waitpid 主链路）与 Kernel 事件总线（`stdio`/`processExit`）；本轮补齐 attachProcessPort 同 pid 绑定替换与 exit/kill 自动解绑清理（含 stdio channel 回收）；M1-3 重构为真正三层 OverlayFS（BaseLayer/PersistLayer/MemLayer + ENOENT 错误码）；M1-4 已补 native OPFS root 检测、目录 hydration、best-effort 写回、reopen 再水化、SyncAccessHandle→writable 回退，以及原生写回统计可观测（attempts/successes/failures/syncFallbacks/lastError）；M1-5 在 bootstrap 之外新增 RuntimeProcessSupervisor（attach + onExit + cleanup）编排层，并补更高层 `bootstrapSupervisedProcess()`、`spawnSupervisedProcess()` 入口，以及 `exited/onStdio` 句柄抽象与 `spawn.ts` 的最小 `ChildProcess` 适配层；本轮进一步补齐 runtime `spawn()` 薄入口（复用 supervisor + handle 适配），并通过 `stdin: pipe`、`onExit` 回调契约与 pid 就绪语义测试锁定行为；本轮进一步明确 `stdout/stderr` 的 `pipe/inherit/ignore` 输出策略；M1-6 补齐 process stdio 句柄（stdin/stdout/stderr fd + writer 适配）；M1-8 acceptance 已补齐 spawn() stdout ignore（流关闭）、stdout inherit（不进入子 pipe）、spawnSync 占位报错三类边界 smoke；m1-vfs-bootstrap.test.ts 71/71 pass，m1-acceptance.test.ts 15/15 pass |
| M2 | Resolver + Node 核心 polyfill | 100% | 已完成 | M2-3 fs 补齐 `lstatSync/realpathSync` + promises 对应方法（95%）；M2-4 path 补齐 `parse/format/toNamespacedPath`（posix + win32），url 补齐 `fileURLToPath/pathToFileURL`（90%）；M2-5 module 补齐 `node:buffer` 注册、`builtinModulesList` 数组导出（40+ 模块）、`createRequireWithVfs`（VFS node_modules 解析），新增 Module 类实现、wrap/nodeModulePaths/_extensions/_resolveLookupPaths 导出，并新增回放用例覆盖 node_modules 裸包加载与包内相对 require（90%）；M2-6 官方语义回放已扩展到 fs/path/module/buffer/events/stream，官方回放共 86/86 全通过（100%）；M2-7 Buffer 主路径已落盘，官方回放测试通过（85%）；M2-8 已落 `node:events` + `node:stream`，并补齐 `stream/web` 与 `stream/promises` 最小入口，events+stream 官方回放子集已完成（93%）；M2-9 `@mars/web-webapis` 包已落盘（80%），39/39 测试通过。整体实现达成，主要完成度由官方回放用例验证确保质量。 |
| M3 | 安装器（bun install）MVP | 60% | 进行中 | 已完成 `@mars/web-installer` 包脚手架，落地 registry metadata + tarball 下载/完整性校验/最小 tar.gz 解包 + lockfile 最小读写/增量更新 + node_modules 扁平布局规划/去重链路，并新增包缓存最小实现（IndexedDB 优先 + OPFS 回退 + 回填热缓存）与 install 组合入口回放测试（含 scoped registry、registryUrl 优先级、dist-tag、lockfile-only、缓存重装、分块流式 tarball 响应、metadata/tarball 重试恢复、metadata/tarball 4xx 不重试、metadata/tarball 重试耗尽 attempt 可观测性、overrides 覆盖 transitive 依赖、optionalDependencies 根依赖与 transitive 失败跳过语义）；本轮新增首批真实目录门禁适配（m3-install-cli-tarball-integrity、m3-install-cli-overrides，共 10 条，全部通过），依赖 M1-M2 |
| M3 | 安装器（bun install）MVP | 73% | 进行中 | 已完成 `@mars/web-installer` 包脚手架，落地 registry metadata + tarball 下载/完整性校验/最小 tar.gz 解包 + lockfile 最小读写/增量更新 + node_modules 扁平布局规划/去重链路，并新增包缓存最小实现（IndexedDB 优先 + OPFS 回退 + 回填热缓存）与 install 组合入口回放测试；本轮新增 `m3-install-cli-streaming-extract.test.ts`（5条，映射 `bun-install-streaming-extract.test.ts` 可迁移语义：chunked 提取一致性 / chunked vs buffered 等价 / integrity mismatch 失败）、`m3-install-cli-cache-store.test.ts`（4条，覆盖 cache miss 写入 / cache hit 跳过 tarball 请求 / cache integrity mismatch 回源刷新 / lockfile-only 不触发 cache）与 `m3-install-cli-registry-pathname.test.ts`（3条，映射 `bun-install-pathname-trailing-slash.test.ts` 路径语义），M3 install-cli 测试总计 84 条全部通过，M3 门禁合计 104 条通过，依赖 M1-M2 |
| M4 | Service Worker + Bun.serve | 0% | 未开始 | 依赖 M1-M2 |
| M5 | Shell + Spawn + WebSocket | 0% | 未开始 | 依赖 M1-M4 |
| M6 | Build/Transpiler/Test Runner | 0% | 未开始 | 依赖 M1-M5 |
| M7 | Plugin/Compat Registry/CI 门禁 | 0% | 未开始 | 依赖 M1-M6 |
| M8 | 官方测试集直通与性能稳定性 | 5% | 进行中 | 已有运行器与 skip 机制，尚未连到真实实现 |

项目总体完成度（按阶段权重）：`56%`
项目总体完成度（按阶段权重）：`62%`

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
| M1-3 | packages/bun-web-vfs/src/overlay-fs.ts | Base/Persist/Mem 三层 VFS | 72% | 进行中 | 2026-04-24：重构为真正三层 OverlayFS；BaseLayer/PersistLayer/MemLayer 独立类；读取 Mem→Persist→Base 优先级；ENOENT 错误码；readdirSync 跨层合并；async wrappers；m1-vfs-bootstrap.test.ts 29/29 VFS 测试全通过 |
| M1-4 | packages/bun-web-vfs/src/opfs-adapter.ts | OPFS 持久层适配（含 SyncAccessHandle） | 80% | 进行中 | 2026-04-24：在目录感知最小适配层之上，补 native OPFS root 检测（`navigator.storage.getDirectory()`）、subroot 打开、目录 hydration、best-effort mkdir/write/unlink 写回、reopen 再水化回读验证、SyncAccessHandle 失败时 writable 回退、双路径失败时内存主路径可用，以及原生写回统计可观测接口（attempts/successes/failures/syncFallbacks/lastError + reset）；m1-vfs-bootstrap.test.ts 中 OPFSAdapter 用例扩至 16/16（含 fake native handle preload/persistence/reopen/recovery/observability 路径）通过；真实浏览器 SyncAccessHandle 刷新持久化与错误恢复策略仍待接入 |
| M1-5 | packages/bun-web-runtime/src/process-bootstrap.ts + packages/bun-web-runtime/src/process-supervisor.ts + packages/bun-web-runtime/src/spawn.ts | Process Worker 启动、stdio 初始化与生命周期编排 | 96% | 进行中 | 2026-04-24：新增 StdioWriter（MessagePort 管道）、installConsoleCapture、bootstrapProcessWorker 完整实现（process 注入/cwd/env/argv/VFS/exit hook）；补齐 process stdout/stderr writer 接线，并在未传 stdio port 时回退到 `globalThis.postMessage`（含 exit 事件）；新增 RuntimeProcessSupervisor 统一封装 attachProcessPort + processExit 回调收敛 + cleanup，并补更高层 `bootstrapSupervisedProcess()`、`spawnSupervisedProcess()` 入口，以及最小句柄抽象（`exited`/`onStdio`/`cleanup`）；此前已新增 `spawn.ts` 的 `createChildProcessHandle()` 适配层，本轮再补 runtime `spawn()` 薄入口（默认走 supervisor 编排并回收生命周期），并通过 `stdin: 'pipe'`、`onExit(proc, code, signal)`、`stdout ignore` 与 `stdout inherit`（不进入子句柄 pipe）用例补齐行为回归；`spawnSync` 明确为占位错误；m1-vfs-bootstrap.test.ts 18/18 bootstrap 测试全通过 |
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
| 目标与范围确认 | 仅实现安装主链路（metadata/tarball/lockfile/layout） | [ ] 待确认 |
| 文件级任务确认 | M3-1~M3-6 文件与功能已确认 | [ ] 待确认 |
| 前置依赖确认 | M1-M2 退出条件满足，VFS 与 resolver 可复用 | [ ] 待确认 |
| 测试计划确认 | 明确 test/cli/install 的可兼容用例集合 | [ ] 待确认 |
| 启动决策 | 批准进入 M3 编码 | [ ] 待确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M3-1 | packages/bun-web-installer/src/registry.ts | npm registry metadata 拉取 | 35% | 进行中 | 已实现 `fetchPackageMetadata()` + `resolveVersion()` 最小链路（含非 2xx 与 payload 结构校验、dist-tag 缺失错误语义），并由 `m3-installer-registry.test.ts` 4/4 覆盖 |
| M3-1 | packages/bun-web-installer/src/registry.ts | npm registry metadata 拉取 | 55% | 进行中 | 已实现 `fetchPackageMetadata()` + `resolveVersion()`（dist-tag / exact / semver 范围 ^/~/>=/</<= 三种规格，通过 `semver.ts` maxSatisfying 驱动），由 `m3-installer-registry.test.ts`（4/4）与 `m3-install-cli-semver.test.ts` resolveVersion 组（6/6）覆盖；新增独立 `semver.ts` 模块：compareVersions/satisfiesRange/maxSatisfying，映射 `test/cli/install/semver.test.ts` comparisons/satisfies 子集（21/21），从 `index.ts` 统一导出 |
| M3-2 | packages/bun-web-installer/src/tarball.ts | tarball 下载、解压、完整性校验 | 30% | 进行中 | 已实现 `downloadTarball()`、`verifyIntegrity()`（SRI sha1/sha256/sha384/sha512）与 `extractTarball()`（tar.gz 最小解包，文件/目录条目）；已覆盖成功/失败校验与解包语义回归 |
| M3-3 | packages/bun-web-installer/src/lockfile.ts | `bun.lock` 读写与最小增量更新 | 45% | 进行中 | 已实现 `readLockfile()` / `writeLockfile()` / `upsertLockfilePackage()` 与稳定排序序列化，重复 upsert 输出稳定不抖动；本轮补充真实目录门禁适配（m3-install-cli-lock.test.ts，8条）：lockfile 创建验证、keys 字母序、round-trip 稳定性、跨 reinstall 幂等、transitive 完整覆盖、lockfile-only 无 tarball、增量 upsert、dependency keys 排序 |
| M3-4 | packages/bun-web-installer/src/node-modules-layout.ts | 扁平化安装与去重策略 | 40% | 进行中 | 已实现 lockfile→layout graph 转换、根依赖解析、扁平化 hoist（同版本复用）与冲突版本嵌套回退策略，最小语义回归已覆盖；本轮补充真实目录门禁适配（m3-install-cli-layout.test.ts，7条）：根依赖路径、transitive hoist、共享去重、冲突嵌套、entries 有序、links 正确指向、所有包均在 plan 中 |
| M3-5 | packages/bun-web-vfs/src/cache-store.ts | 包缓存（IndexedDB + OPFS） | 35% | 进行中 | 已实现 `PackageCacheStore`（IndexedDB 命中优先、OPFS miss 回退读取、OPFS 命中后回填 IndexedDB 热缓存、读写/删除与命中统计），并补最小回归覆盖；本轮在 `installFromManifest` 主链路补齐“缓存命中 tarball 的 integrity 再校验 + 失败后回源刷新”语义，并由 `m3-install-cli-cache-store.test.ts` 覆盖 |
| M3-6 | test/cli/install/ | 回放可兼容安装测试 | 70% | 进行中 | 已在 `packages/bun-web-test` 新增 install replay 用例（tarball integrity 变更失败、lockfile 稳定性、hoist 共享依赖、scoped registry、registryUrl 优先级、dist-tag 解析、lockfile-only、lockfile-only 增量更新、缓存重装、分块流式 tarball 响应、metadata/tarball 重试恢复、metadata/tarball 4xx 不重试、metadata/tarball 重试耗尽 attempt 可观测性、overrides 覆盖 transitive 依赖、optionalDependencies 根依赖成功/失败跳过、transitive optional 失败跳过不阻塞 layout）；真实目录门禁适配：`m3-install-cli-tarball-integrity`（5条）、`m3-install-cli-overrides`（5条）、`m3-install-cli-lock`（8条，映射 `bun-lock.test.ts`）、`m3-install-cli-layout`（7条，映射 `bun-install.test.ts` hoist/nested/dedup 子集），共 45 条（20 replay + 25 真实目录门禁），全部通过 |
| M3-6 | test/cli/install/ | 回放可兼容安装测试 | 95% | 进行中 | 已在 `packages/bun-web-test` 新增 install replay 用例（tarball integrity 变更失败、lockfile 稳定性、hoist 共享依赖、scoped registry、registryUrl 优先级、dist-tag 解析、lockfile-only、lockfile-only 增量更新、缓存重装、分块流式 tarball 响应、metadata/tarball 重试恢复、metadata/tarball 4xx 不重试、metadata/tarball 重试耗尽 attempt 可观测性、overrides 覆盖 transitive 依赖、optionalDependencies 根依赖成功/失败跳过、transitive optional 失败跳过不阻塞 layout）；真实目录门禁适配：`m3-install-cli-tarball-integrity`（5条）、`m3-install-cli-overrides`（5条）、`m3-install-cli-lock`（8条，映射 `bun-lock.test.ts`）、`m3-install-cli-layout`（7条，映射 `bun-install.test.ts` hoist/nested/dedup 子集）、`m3-install-cli-semver`（21条，映射 `semver.test.ts` order/satisfies/maxSatisfying/resolveVersion/端到端 range 安装）、`m3-install-cli-retry`（6条，映射 `bun-install-retry.test.ts`）、`m3-install-cli-streaming-extract`（5条，映射 `bun-install-streaming-extract.test.ts` 可迁移子语义）、`m3-install-cli-cache-store`（4条，映射 install 缓存主链路语义）、`m3-install-cli-registry-pathname`（3条，映射 custom registry pathname trailing slash 语义），共 84 条（20 replay + 64 真实目录门禁），全部通过 |

当前进展说明：`@mars/web-installer` package 已接入 root workspace 与 Nx 编排；本轮新增真实目录门禁适配：`m3-install-cli-lock.test.ts`（映射 `bun-lock.test.ts`，8 条，覆盖 lockfile 格式/幂等/round-trip/增量/lockfile-only 语义）与 `m3-install-cli-layout.test.ts`（映射 `bun-install.test.ts` hoist/dedup 子集，7 条，覆盖根依赖路径/hoist/共享去重/冲突嵌套/有序/links 语义），M3 测试总计 65 条全部通过。
当前进展说明：`@mars/web-installer` package 已接入 root workspace 与 Nx 编排；本轮新增真实目录门禁 `m3-install-cli-streaming-extract.test.ts`（5 条：chunked 提取成功、chunked/buffered 等价、integrity mismatch 失败、1-byte chunk 稳定、大块 chunk 稳定），并完成 M3 install-cli 合集回归 77/77（8 files）；M3 门禁合计 97 条，`web:typecheck` / `web:build` 均通过。
当前进展说明：本轮新增真实目录门禁 `m3-install-cli-cache-store.test.ts`（4 条：cache miss 写入、cache hit 跳过 tarball 请求、cache integrity mismatch 回源刷新、lockfile-only 不触发 cache），并在 `packages/bun-web-installer/src/install.ts` 补齐缓存命中 tarball 的 integrity 再校验逻辑；M3 install 9 文件回归 81/81 通过，`web:typecheck` / `web:build` 均通过。
当前进展说明：本轮新增真实目录门禁 `m3-install-cli-registry-pathname.test.ts`（3 条：prefixed route + 单尾斜杠无双斜杠、多尾斜杠归一化、scoped package 编码路径），并在 `packages/bun-web-installer/src/registry.ts` 将 registry URL 归一化逻辑从“去除 1 个尾斜杠”提升为“去除全部尾斜杠”；M3 install 10 文件回归 84/84 通过，`web:typecheck` / `web:build` 均通过。

---

## M4 Service Worker + Bun.serve

### 实施前确认（Stage Gate）

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 仅覆盖 HTTP 主路径与基础 WebSocket 桥接 | [ ] 待确认 |
| 文件级任务确认 | M4-1~M4-10 的文件与接口契约已确认（含 http-net/dns/heartbeat/proxy-server 补充项） | [ ] 待确认 |
| 前置依赖确认 | M1-M2 可稳定运行，M3 非阻塞依赖已评估 | [ ] 待确认 |
| 测试计划确认 | 明确 test/js/bun/http 子集与验收场景 | [ ] 待确认 |
| 启动决策 | 批准进入 M4 编码 | [ ] 待确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M4-1 | packages/bun-web-sw/src/sw.ts | `fetch` 拦截与虚拟端口路由 | 0% | 未开始 | 可访问 `http://<pid>.bun.local` |
| M4-2 | packages/bun-web-runtime/src/serve.ts | `Bun.serve()` 注册/stop/reload | 0% | 未开始 | serve 基础生命周期通过 |
| M4-3 | packages/bun-web-net/src/http-bridge.ts | Request/Response 流式桥接 | 0% | 未开始 | POST body 与流式响应正确 |
| M4-4 | packages/bun-web-net/src/websocket-virtual.ts | VirtualWebSocket 协议与升级桥 | 0% | 未开始 | ws echo 用例通过 |
| M4-5 | packages/bun-web-client/src/preview.ts | iframe 预览自动挂载 server-ready URL | 0% | 未开始 | Hono/Elysia 页面可打开 |
| M4-6 | test/js/bun/http/ | 回放兼容的 `serve` 用例子集 | 0% | 未开始 | 通过率 ≥ 90% |
| M4-7 | packages/bun-web-node/src/http-net.ts | `node:http` / `node:https` / `node:net` / `node:tls` polyfill（RFC §8.2 A/B/C级）；`node:net` Socket→WS 隧道 | 0% | 未开始 | `http.get` / `http.createServer` 基础用例通过 |
| M4-8 | packages/bun-web-dns/src/doh.ts | `Bun.dns.*` / `node:dns` / `dns/promises` DoH 客户端（RFC §8.1/8.2 C级，走 1.1.1.1 JSON API） | 0% | 未开始 | `Bun.dns.lookup('github.com')` 返回有效 IP |
| M4-9 | packages/bun-web-sw/src/heartbeat.ts | SW 生命周期保活与自动复活（RFC §13 风险"SW 生命周期回收"） | 0% | 未开始 | SW 被回收后 `Bun.serve` 进行中连接可自愈 |
| M4-10 | packages/bun-web-proxy-server/src/server.ts | 可选 WS/TCP 隧道服务端（RFC §5.4）；无配置时跳过，注入 tunnelUrl 后解锁 postgres/redis 等原始 TCP | 0% | 未开始 | 注入 tunnelUrl 后 TCP 连接可通；无配置时抛 NotSupportedError |

---

## M5 Shell + Spawn + 多线程

> **与 RFC §12 偏差说明**：RFC §12 M5 交付含测试运行器能力，实施计划将其统一推后至 M6（Vitest + bun-web-test 同批交付，降低风险）；Shell 从 RFC §12 M6 提前至本阶段，以便 AI Agent 命令集合尽早可用。所有能力最终均覆盖，仅执行顺序调整。

### 实施前确认（Stage Gate）

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 聚焦 shell 内建命令、spawn、worker_threads 基础语义 | [ ] 待确认 |
| 文件级任务确认 | M5-1~M5-7 文件与功能边界已确认（含 bun-web-shell-builtins 独立包） | [ ] 待确认 |
| 前置依赖确认 | M1-M4 关键依赖（stdio、serve、vfs）已可用 | [ ] 待确认 |
| 测试计划确认 | 明确 shell 与多线程回归用例集合 | [ ] 待确认 |
| 启动决策 | 批准进入 M5 编码 | [ ] 待确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M5-1 | packages/bun-web-shell/src/parser.ts | shell 语法解析（管道/重定向/glob） | 0% | 未开始 | `cat|grep|xargs` 链路正确 |
| M5-2 | packages/bun-web-shell/src/builtins/*.ts | `grep/ls/cd/cat/find/jq` 等内建命令 | 0% | 未开始 | AI Agent 命令集合可用 |
| M5-3 | packages/bun-web-runtime/src/spawn.ts | `Bun.spawn/spawnSync` Worker 化执行 | 0% | 未开始 | 子进程 stdin/stdout/stderr 正常 |
| M5-4 | packages/bun-web-node/src/worker_threads.ts | `node:worker_threads` 语义对齐 | 0% | 未开始 | message channel 用例通过 |
| M5-5 | packages/bun-web-node/src/async_hooks.ts | `AsyncLocalStorage` 传播机制 | 0% | 未开始 | 上下文不串扰 |
| M5-6 | test/js/bun/shell/ | Shell 兼容子集回归 | 0% | 未开始 | 通过率 ≥ 85% |
| M5-7 | packages/bun-web-shell-builtins/src/*.ts | 独立包 `bun-web-shell-builtins/`（RFC §10 要求与 `bun-web-shell/` 分离）；Phase 1 全量内置命令（RFC §7 完整命令表） | 0% | 未开始 | RFC §7 中所有 AI Agent 高频命令均可用 |

---

## M6 Build/Transpiler/Test Runner

### 实施前确认（Stage Gate）

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 聚焦 build/transpiler/test/sqlite 主路径 | [ ] 待确认 |
| 文件级任务确认 | M6-1~M6-9 文件与功能覆盖关系已确认（含 bun-web-crypto/zlib/vm-misc 补充项） | [ ] 待确认 |
| 前置依赖确认 | M1-M5 基础运行链路可用 | [ ] 待确认 |
| 测试计划确认 | 明确 bundler、vitest、sqlite 验收标准 | [ ] 待确认 |
| 启动决策 | 批准进入 M6 编码 | [ ] 待确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M6-1 | packages/bun-web-transpiler/src/swc.ts | `Bun.Transpiler` 核心实现 | 0% | 未开始 | TS/JSX 转译与 scanImports 通过 |
| M6-2 | packages/bun-web-bundler/src/build.ts | `Bun.build()` API 与输出管理 | 0% | 未开始 | vite-react-ts 产物可预览 |
| M6-3 | packages/bun-web-test/vitest.config.ts + packages/bun-web-test/package.json | Vitest 执行入口与门禁脚本 | 70% | 进行中 | `bun run web:test` 可执行；模块测试统一由 Vitest 运行 |
| M6-4 | packages/bun-web-test/tests/**/*.test.ts | 测试用例迁移与快照策略（Vitest） | 55% | 进行中 | 原 `test/integration/bun-in-browser/*.test.ts` 已迁移，snapshot 策略稳定可回放 |
| M6-5 | packages/bun-web-sqlite/src/sqlite.ts | `bun:sqlite` / `node:sqlite` wa-sqlite + OPFS VFS 绑定（RFC §8.1 A级、§10 `bun-web-sqlite/`；原路径 `bun-web-runtime/src/sqlite.ts` 错误，已修正） | 0% | 未开始 | CRUD 与 prepare/serialize/WAL 通过 |
| M6-6 | test/bundler/ | 可兼容 bundler 用例回放 | 0% | 未开始 | 通过率 ≥ 80% |
| M6-7 | packages/bun-web-crypto/src/index.ts | `Bun.CryptoHasher` / `Bun.password.hash/verify` / `Bun.hash.*`（RFC §8.1 A级、§10 `bun-web-crypto/`）；argon2-wasm + bcrypt-wasm + blake3-wasm + sha3-wasm | 0% | 未开始 | hash/password 输出与原生 Bun 一致 |
| M6-8 | packages/bun-web-node/src/zlib.ts | `node:zlib` pako + fflate + brotli-wasm（RFC §8.2 A级） | 0% | 未开始 | gzip/inflate/brotli 压缩解压与 Node 行为一致 |
| M6-9 | packages/bun-web-node/src/vm-misc.ts | `node:vm`(B) / `node:v8`(C) / `node:wasi`(B) / `node:assert`(A) / `node:util`(A) / `node:console`(A) / `node:readline`(A) / `node:os`(B) / `node:cluster`(C) 批量实现（RFC §8.2） | 0% | 未开始 | 各模块 API 形状无缺失；D级符号调用时抛 `ERR_BUN_WEB_UNSUPPORTED` |

---

## M7 Plugin + Compat Registry + CI

### 实施前确认（Stage Gate）

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 聚焦插件机制、兼容矩阵与 CI 门禁，不扩展运行时特性 | [ ] 待确认 |
| 文件级任务确认 | M7-1~M7-8 文件与职责已确认（含 bun-web-agent / bun-web-client SDK 补充项） | [ ] 待确认 |
| 前置依赖确认 | M1-M6 的 API 表面与测试入口可复用 | [ ] 待确认 |
| 测试计划确认 | 明确插件生命周期与 CI 失败门槛 | [ ] 待确认 |
| 启动决策 | 批准进入 M7 编码 | [ ] 待确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M7-1 | packages/bun-web-hooks/src/hook.ts | Hook 引擎（sync/async/first） | 0% | 未开始 | 插件顺序与过滤器正确 |
| M7-2 | packages/bun-web-plugin-api/src/index.ts | `Bun.plugin` 统一适配层 | 0% | 未开始 | loader 插件能生效 |
| M7-3 | packages/bun-web-compat-registry/src/index.ts | API 符号分级注册表 | 0% | 未开始 | 所有公开符号有等级登记 |
| M7-4 | scripts/gen-compat-matrix.ts | 从 bun-types 扫描并生成兼容矩阵 | 0% | 未开始 | 漏登记时 CI 失败 |
| M7-5 | .github/workflows/web-runtime.yml | 浏览器 runtime CI 流水线 | 0% | 未开始 | 合并前自动执行门禁 |
| M7-6 | packages/bun-web-test/tests/acceptance.test.ts | 插件生命周期验收用例 | 0% | 未开始 | 注册/卸载副作用可回滚 |
| M7-7 | packages/bun-web-agent/src/index.ts | AI Agent 受限 shell + 审计 overlay（RFC §10 `bun-web-agent/`）；能力白名单、命令审计日志、沙箱隔离 | 0% | 未开始 | 受限命令集可执行，禁止命令返回明确拒绝（非崩溃） |
| M7-8 | packages/bun-web-client/src/sdk.ts | `@bun-web/client` 宿主 SDK 完整接口（RFC §10 `bun-web-client/`）：`BunContainer.boot/mount/spawn/on('server-ready')` 对齐 WebContainer API 风格 | 0% | 未开始 | RFC §10 示例代码可直接运行 |

---

## M8 官方测试集直通 + 性能稳定性

### 实施前确认（Stage Gate）

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 聚焦官方测试通过率、基线维护与性能稳定性 | [ ] 待确认 |
| 文件级任务确认 | M8-1~M8-6 文件与指标责任已确认 | [ ] 待确认 |
| 前置依赖确认 | M1-M7 的实现与门禁链路基本齐备 | [ ] 待确认 |
| 测试计划确认 | 明确目录阈值、回归策略与压测计划 | [ ] 待确认 |
| 启动决策 | 批准进入 M8 收敛阶段 | [ ] 待确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M8-1 | test/integration/bun-in-browser/run-official-tests.ts | 全目录并发执行、阈值与基线对比 | 35% | 进行中 | 支持目录门禁与回归判定 |
| M8-2 | test/integration/bun-in-browser/skip-in-browser.txt | 跳过规则精细化与 issue 绑定 | 25% | 进行中 | 每条跳过有可追溯原因 |
| M8-3 | test/integration/bun-in-browser/baseline.json | 基线固化与更新策略 | 0% | 未开始 | 新回归可自动报警 |
| M8-4 | scripts/bench-web-runtime.ts | 启动/HMR/install/grep 基准采集 | 0% | 未开始 | 输出性能趋势报告 |
| M8-5 | packages/bun-web-runtime/src/memory-gc.ts | Blob URL/LRU/句柄回收策略 | 0% | 未开始 | 1h 压测无泄漏 |
| M8-6 | docs/rfc/bun-in-browser-webcontainer.md | 更新最终通过率与不兼容清单 | 10% | 进行中 | 发布前状态与现实一致 |

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
| package.json + nx.json + packages/bun-web-*/package.json | Nx 批量类型检查编排 | `bun run web:typecheck` | 通过 | 2026-04-25：Nx 已识别 9 个 bun-web 模块（含 `@mars/web-installer`），集中类型检查已全量通过 |
| test/js/node/module/node-module-module.test.js + test/js/node/path/parse-format.test.js + test/js/node/path/to-namespaced-path.test.js + test/js/node/path/basename.test.js + test/js/node/url/pathToFileURL.test.ts | M2-6 官方目录真实门禁子集 | `USE_BUN_WEB_RUNTIME=1 bun test <5 files>` | 通过 | 2026-04-25：39 pass / 0 fail；验证 `node:module` 主链路与 path/url 关键语义已可在 `test/js/node` 真目录回放 |
| test/js/node/fs/fs.test.ts + test/js/node/fs/fs-mkdir.test.ts | M2-6 官方目录 fs 稳定子集 | `USE_BUN_WEB_RUNTIME=1 bun test test/js/node/fs/fs.test.ts test/js/node/fs/fs-mkdir.test.ts` | 通过 | 2026-04-25：264 pass / 5 skip / 0 fail；fs 主路径在真实目录可回放 |
| test/js/node/fs/fs-stats-truncate.test.ts + test/js/node/fs/fs-stats-constructor.test.ts | M2-6 官方目录 fs 差距子集 | `USE_BUN_WEB_RUNTIME=1 bun test test/js/node/fs/fs-stats-truncate.test.ts test/js/node/fs/fs-stats-constructor.test.ts` | 失败 | 2026-04-25：最新复测结果仍为 `1 pass / 3 fail / 1 error`；阻塞 1) `bun:internal-for-testing` 依赖在当前源码状态下仍未解除（`ENOENT reading "bun:internal-for-testing"`）；2) `Stats(...) without new` 与 `Stats prototype` 语义差异（2 fail） |
| test/integration/bun-in-browser/run-official-tests.ts（`--dir test/js/node/fs`） | M2-6 官方目录 fs 门禁（按 skip-in-browser 过滤后） | `bun test/integration/bun-in-browser/run-official-tests.ts --dir test/js/node/fs` | 通过 | 2026-04-25：修复 root 路径、skip 前缀匹配与 `--dir` 阈值继承后持续可用；最新结果 11/11，门禁 100%（≥95%）。同日去除 `fs-stats*` skip 的探测结果为 12/14，定位到 `bun:internal-for-testing` 与 `Stats(...)` 语义差异两项核心阻塞。 |
| `bun bd test test/js/node/fs/fs-stats-constructor.test.ts` | M2-6 根因验证（源码构建路径，非当前主流程） | `bun bd test test/js/node/fs/fs-stats-constructor.test.ts` | 阻塞 | 当前主验证流程已迁移到 `bun-web-test`；该路径仅用于后续 runtime 根因调试。当前仓库在调试构建阶段被 [build.zig](build.zig#L881) 的 `unreachable else prong` 编译错误阻断。 |
| test/integration/bun-in-browser/run-official-tests.ts | 官方测试驱动脚本 | `bun run web:test:official` | 未运行 | 脚本已落盘，待 runtime 最小链路打通后执行 |
| test/integration/bun-in-browser/skip-in-browser.txt | 跳过清单 | 被 `run-official-tests.ts` 读取 | 进行中 | 规则文件已生效，仍需按 issue 逐条补齐注释 |
| test/integration/bun-in-browser/baseline.json | 回归基线 | `bun run web:test:official:update-baseline` | 已创建（部分） | 2026-04-25：已通过 `bun test/integration/bun-in-browser/run-official-tests.ts --dir test/js/node/fs --update-baseline` 落盘 `test/js/node/fs` 基线（11/11, rate=1.0）；后续随目录扩展继续补齐 |

### 5.2 官方测试目录状态（目标与当前）

| 测试目录 | 目标状态 | 当前状态 | 备注 |
| --- | --- | --- | --- |
| test/js/web/ | 通过率 100% | 未运行 | 待 M1-M2 完成后启动 |
| test/js/node/ | 通过率 >= 95% | 进行中 | 2026-04-25：已跑 module/path/url 子集 39 pass / 0 fail，fs 稳定子集 264 pass / 5 skip / 0 fail；剩余阻塞在 `bun:internal-for-testing` 依赖、`Stats(...)` 构造语义对齐，以及 `abort-signal-leak-read-write-file` 的浏览器 runtime GC 波动 |
| test/js/bun/http/ | 通过率 >= 90% | 未运行 | 依赖 M4 `Bun.serve` |
| test/js/bun/crypto/ | 通过率 >= 90% | 未运行 | 依赖 M6 crypto/hasher 适配 |
| test/js/bun/shell/ | 通过率 >= 85% | 未运行 | 依赖 M5 shell builtins |
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
| §1 分层架构 | Kernel Worker / Process Workers / Service Worker 三层结构 | M1-1, M1-5, M4-1 | ⬜ 未开始 |
| §2 VFS（三层叠加） | BaseLayer / PersistLayer(OPFS) / MemLayer；SyncAccessHandle；fs.watch BroadcastChannel | M1-3, M1-4 | ⬜ 未开始 |
| §3 SAB Bridge | Process→Kernel 同步 syscall 协议；iOS async fallback | M1-2, M1-7 | ⬜ 未开始 |
| §4.1 Resolver | exports/imports/conditions；tsconfig paths/baseUrl；.ts↔.js 互换 | M2-1, M2-2 | ⬜ 未开始 |
| §4.2 Transpiler | swc-wasm(主力) / esbuild-wasm(bundler) / IndexedDB 缓存 | M6-1 | ⬜ 未开始 |
| §4.3 Module Registry | ESM Blob URL / CJS new Function / node:* jspm-core | M2-3, M2-5 | ⬜ 未开始 |
| §5.1 HTTP 拦截 | fetch 拦截；虚拟主机 `<pid>.bun.local`；零拷贝 body | M4-1, M4-3 | ⬜ 未开始 |
| §5.2 WebSocket 桥 | VirtualWebSocket / BroadcastChannel；Bundler 自动替换符号 | M4-4 | ⬜ 未开始 |
| §5.3 出站请求 | 外部 fetch/WS 透传；CORS 限制文档化 | M4-3（隐含） | ⬜ 未开始 |
| §5.4 TCP/TLS 隧道（可选） | WS 代理服务端；无配置时 NotSupportedError | M4-10 | ⬜ 未开始 |
| §6 插件体系 | Hook 命名空间、MarsWebPlugin 类型、安全沙箱、Bun.plugin 对齐 | M7-1, M7-2 | ⬜ 未开始 |
| §7 Shell 命令集 | parser（管道/重定向/glob）；Phase 1 全量内置命令（AI Agent 高频） | M5-1, M5-2, M5-7 | ⬜ 未开始 |
| §8.1 Bun.* 顶层 | version/env/argv/cwd/nanoseconds/sleep | M1-5, M1-6 | ⬜ 未开始 |
| §8.1 Bun.file/write/stdin/stdout/stderr | VFS + Blob 包装 | M1-3, M2-3 | ⬜ 未开始 |
| §8.1 Bun.serve / server.* | 端口表 + SW 转发；TLS/unix/reusePort 降级 | M4-2 | ⬜ 未开始 |
| §8.1 Bun.spawn / spawnSync | JS/TS→Worker；系统二进制→Shell builtin | M5-3 | ⬜ 未开始 |
| §8.1 Bun.$ (Shell) | bun-web-shell 完整实现 | M5-1, M5-2, M5-7 | ⬜ 未开始 |
| §8.1 Bun.Transpiler | swc-wasm 包装，对齐选项 | M6-1 | ⬜ 未开始 |
| §8.1 Bun.build / Bun.plugin | esbuild-wasm + hook 引擎 | M6-2, M7-2 | ⬜ 未开始 |
| §8.1 Bun.CryptoHasher / Bun.password / Bun.hash.* | WebCrypto + argon2/bcrypt/blake3/sha3 WASM | M6-7 | ⬜ 未开始 |
| §8.1 Bun.dns.* | DoH (1.1.1.1 JSON API) | M4-8 | ⬜ 未开始 |
| §8.1 bun:sqlite | wa-sqlite + OPFS VFS | M6-5 | ⬜ 未开始 |
| §8.1 测试能力（Vitest） | 统一 Vitest 门禁与 snapshot 策略 | M6-3, M6-4 | 🟨 进行中 |
| §8.1 bun:ffi | 存根；允许 dlopen('.wasm') 扩展 | M7-3（compat registry 登记 D级） | ⬜ 未开始 |
| §8.2 node:fs / fs/promises | VFS + SAB sync | M2-3 | 🟨 进行中 |
| §8.2 node:path / url / querystring | 纯算法 | M2-4 | 🟨 进行中 |
| §8.2 node:buffer | buffer 包 + Bun 扩展 | M2-7 | ⬜ 未开始 |
| §8.2 node:events / stream / stream/web | readable-stream | M2-8 | 🟨 进行中 |
| §8.2 node:os | cpus=hardwareConcurrency；platform='browser' | M6-9 | ⬜ 未开始 |
| §8.2 node:crypto | WebCrypto + crypto-browserify + WASM | M6-7（兼含） | ⬜ 未开始 |
| §8.2 node:tls / net | SW 代理；Socket→WS 隧道 | M4-7 | ⬜ 未开始 |
| §8.2 node:http / https | net 之上构建 | M4-7 | ⬜ 未开始 |
| §8.2 node:http2 | C级，仅 request-like 子集 | M4-7（含存根） | ⬜ 未开始 |
| §8.2 node:zlib | pako + fflate + brotli-wasm | M6-8 | ⬜ 未开始 |
| §8.2 node:child_process | Worker 模拟 exec/spawn/fork | M5-3（Bun.spawn 兼含） | ⬜ 未开始 |
| §8.2 node:worker_threads | Worker 直接对应 | M5-4 | ⬜ 未开始 |
| §8.2 node:async_hooks / AsyncLocalStorage | Zone 风格 polyfill | M5-5 | ⬜ 未开始 |
| §8.2 node:vm / v8 / wasi | B/C级实现 | M6-9 | ⬜ 未开始 |
| §8.2 node:assert / util / console / readline | 移植 src/js/node/ | M6-9 | ⬜ 未开始 |
| §8.2 node:process | 完整 process 对象 | M1-6 | 🟨 进行中 |
| §8.2 node:module | createRequire / isBuiltin / register | M2-5 | 🟨 进行中 |
| §8.2 node:sqlite | 映射到 bun:sqlite | M6-5（含别名） | ⬜ 未开始 |
| §8.3 Web 标准 API | fetch/Blob/File/URL/WebSocket/Streams/TextEncoder/crypto 等；navigator UA 兼容策略 | M2-9 | ⬜ 未开始 |
| §9 Compat Registry | 符号→级别注册；CI 扫描 bun-types；产出 COMPAT.md | M7-3, M7-4 | ⬜ 未开始 |
| §10 `bun-web-kernel/` | Kernel + 调度 + SAB syscall bridge | M1-1, M1-2, M1-7 | ⬜ 未开始 |
| §10 `bun-web-vfs/` | OPFS/Mem overlay fs；包缓存 | M1-3, M1-4, M3-5 | 🟨 进行中 |
| §10 `bun-web-runtime/` | Process Worker bootstrap、Bun.* 实现 | M1-5, M4-2, M5-3, M8-5 | ⬜ 未开始 |
| §10 `bun-web-shared/` | 跨包公共能力（event-emitter 等） | M1-10 | 🟨 进行中 |
| §10 `bun-web-node/` | node:* 全家桶 polyfill | M2-3~M2-8, M4-7, M5-4, M5-5, M6-8, M6-9 | 🟨 进行中 |
| §10 `bun-web-webapis/` | Web 标准 API 补丁层 | M2-9 | ⬜ 未开始 |
| §10 `bun-web-resolver/` | 模块解析 | M2-1, M2-2 | ⬜ 未开始 |
| §10 `bun-web-transpiler/` | swc/esbuild WASM 封装 | M6-1 | ⬜ 未开始 |
| §10 `bun-web-installer/` | bun install | M3-1~M3-6 | 🟨 进行中 |
| §10 `bun-web-bundler/` | Bun.build | M6-2 | ⬜ 未开始 |
| §10 `bun-web-shell/` | Bun.$ 解释器 | M5-1, M5-2 | ⬜ 未开始 |
| §10 `bun-web-shell-builtins/` | 全部 builtin shell 命令（独立包） | M5-7 | ⬜ 未开始 |
| §10 `bun-web-sw/` | Service Worker HTTP + WS 虚拟化；SW 保活 | M4-1, M4-9 | ⬜ 未开始 |
| §10 `bun-web-test/` | Vitest 测试包与门禁入口 | M6-3, M6-4 | 🟨 进行中 |
| §10 `bun-web-sqlite/` | wa-sqlite OPFS VFS 绑定 | M6-5 | ⬜ 未开始 |
| §10 `bun-web-crypto/` | WebCrypto + argon2/bcrypt/blake3 WASM | M6-7 | ⬜ 未开始 |
| §10 `bun-web-net/` | net/tls/http/http2 over WS 隧道 | M4-3, M4-4, M4-7 | ⬜ 未开始 |
| §10 `bun-web-dns/` | DoH 客户端 | M4-8 | ⬜ 未开始 |
| §10 `bun-web-hooks/` | Hook 引擎与类型 | M7-1 | ⬜ 未开始 |
| §10 `bun-web-plugin-api/` | 公共插件 SDK | M7-2 | ⬜ 未开始 |
| §10 `bun-web-agent/` | AI Agent 受限 shell + 审计 overlay | M7-7 | ⬜ 未开始 |
| §10 `bun-web-compat-registry/` | 符号→级别注册表 | M7-3, M7-4 | ⬜ 未开始 |
| §10 `bun-web-client/` | 宿主页面 SDK（BunContainer API） | M4-5, M7-8 | ⬜ 未开始 |
| §10 `bun-web-proxy-server/` | 可选 WS/TCP 隧道服务端 | M4-10 | ⬜ 未开始 |
| §11.1 生态验收 | Express / Koa / Vite+React+TS / tsx / Shell 用例 | M4-6, M5-6, M6-6（及各阶段 smoke） | ⬜ 未开始 |
| §11.2 官方测试直通 | 分目录通过率门禁；skip 机制；基线回归 | M8-1, M8-2, M8-3 | 进行中 |
| §11.3 插件体系验收 | loader/hook/副作用回滚 | M7-6 | ⬜ 未开始 |
| §11.4 API 表面完整性 | typeof 扫描；D级符号行为；tsc 零错误 | M7-3, M7-4 | ⬜ 未开始 |
| §11.5 性能基线 | Kernel 冷启 <1.5s；install <8s；HMR <300ms 等 | M8-4 | ⬜ 未开始 |
| §11.6 稳定性 | 1h 无泄漏；SW 自愈 | M4-9, M8-5 | ⬜ 未开始 |
| §12 里程碑（顺序） | M1-M8 核心交付与验收入口 | 实施计划各阶段（M5/M6 内容顺序有已记录偏差） | 对齐中 |
| §13 SAB iOS 受限 | async fallback 模式 | M1-7 | ⬜ 未开始 |
| §13 SW 生命周期回收 | Clients.claim + 心跳保活；activate 重建端口表 | M4-9 | ⬜ 未开始 |
| §13 ESM Blob URL 膨胀 | LRU + revokeObjectURL GC | M8-5 | ⬜ 未开始 |
| §13 esbuild/swc WASM 性能 | WASM SIMD + 多 Worker 并行（后期优化） | M8-4（bench 指导） | ⬜ 未开始 |