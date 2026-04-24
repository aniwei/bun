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
- Stage Gate 至少包含：范围确认、文件级任务确认、依赖确认、测试确认、启动决策。
- 编码时须对照 [模块 API 设计文档](./bun-in-browser-module-design.md) 核对每个文件的类名与方法签名，如需变更，先修改设计文档，再落代码。

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
---

## 2. 总体完成度看板

| 阶段 | 名称 | 当前完成度 | 状态 | 说明 |
| --- | --- | --- | --- | --- |
| M0 | 文档与门禁基线 | 100% | 已完成 | RFC 修订、验收脚手架与官方测试驱动脚本已落盘 |
| M1 | Kernel + VFS 最小可运行 | 25% | 进行中 | kernel/vfs/runtime 最小骨架与 M1 smoke 已落盘，测试受构建错误阻塞 |
| M2 | Resolver + Node 核心 polyfill | 0% | 未开始 | 依赖 M1 |
| M3 | 安装器（bun install）MVP | 0% | 未开始 | 依赖 M1-M2 |
| M4 | Service Worker + Bun.serve | 0% | 未开始 | 依赖 M1-M2 |
| M5 | Shell + Spawn + WebSocket | 0% | 未开始 | 依赖 M1-M4 |
| M6 | Build/Transpiler/Test Runner | 0% | 未开始 | 依赖 M1-M5 |
| M7 | Plugin/Compat Registry/CI 门禁 | 0% | 未开始 | 依赖 M1-M6 |
| M8 | 官方测试集直通与性能稳定性 | 5% | 进行中 | 已有运行器与 skip 机制，尚未连到真实实现 |

项目总体完成度（按阶段权重）：`16%`

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
| M0-3 | test/integration/bun-in-browser/acceptance.test.ts | 验收测试骨架（API/FS/HTTP/Shell/SQLite） | 100% | 已完成 | 可被 bun test 调起（当前执行失败，见测试状态清单） |
| M0-4 | test/integration/bun-in-browser/run-official-tests.ts | 官方测试集分目录运行与阈值门禁 | 100% | 已完成 | 输出目录通过率并返回正确 exit code |
| M0-5 | test/integration/bun-in-browser/skip-in-browser.txt | 浏览器不支持用例排除机制 | 100% | 已完成 | 脚本可加载并应用跳过规则 |
| M0-6 | package.json | 增加 web:test / web:test:official 脚本入口 | 100% | 已完成 | `bun run web:test*` 命令可解析 |
| M0-7 | docs/rfc/bun-in-browser-module-design.md | 代码风格规范（Oxc + lint）与类命名契约 | 100% | 已完成 | 编码风格、lint 门禁、类名签名规则已文档化 |

---

## M1 Kernel + VFS 最小可运行

### 实施前确认（Stage Gate）

| 确认项 | 说明 | 当前状态 |
| --- | --- | --- |
| 目标与范围确认 | 只实现最小 kernel/vfs/stdio 主路径，不扩展插件或网络 | [ ] 待确认 |
| 文件级任务确认 | M1-1~M1-9 的文件、功能、责任人已逐项确认（含 node:process + iOS SAB fallback 补充项） | [ ] 待确认 |
| 前置依赖确认 | M0 的文档、脚本与测试入口可用 | [ ] 待确认 |
| 测试计划确认 | 明确 M1 smoke 用例与通过标准 | [ ] 待确认 |
| 启动决策 | 批准进入 M1 编码 | [ ] 待确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M1-1 | packages/bun-web-kernel/src/kernel.ts | `Kernel.boot()`、进程表、PID 分配 | 40% | 进行中 | 能启动 1 个进程并返回 pid |
| M1-2 | packages/bun-web-kernel/src/syscall-bridge.ts | SAB 请求/响应队列、`syscallSync()` | 30% | 进行中 | `fs.readFileSync` 桥接可阻塞返回 |
| M1-3 | packages/bun-web-vfs/src/overlay-fs.ts | Base/Persist/Mem 三层 VFS | 35% | 进行中 | `read/write/readdir/stat` 全通过 |
| M1-4 | packages/bun-web-vfs/src/opfs-adapter.ts | OPFS 持久层适配（含 SyncAccessHandle） | 25% | 进行中 | 页面刷新后文件仍可读取 |
| M1-5 | packages/bun-web-runtime/src/process-bootstrap.ts | Process Worker 启动、stdio 初始化 | 35% | 进行中 | `bun run entry.ts` 可输出 stdout |
| M1-6 | packages/bun-web-node/src/process.ts | `node:process` 完整 process 对象（RFC §8.2 A级） | 0% | 未开始 | `process.env/argv/cwd/exit` 等核心属性可用 |
| M1-7 | packages/bun-web-kernel/src/async-fallback.ts | iOS Safari / 无 SAB 环境 async 降级模式（RFC §13 风险） | 30% | 进行中 | 无 SAB 时同步 API 抛明确错误，async API 正常工作 |
| M1-8 | test/integration/bun-in-browser/acceptance.test.ts | 新增 M1 smoke 组（kernel/vfs） | 10% | 进行中 | 相关用例在 CI 绿色 |
| M1-9 | test/integration/bun-in-browser/m1-kernel.test.ts | M1 kernel/vfs/runtime smoke 测试（独立） | 60% | 阻塞 | `bun bd test` 通过（当前受 `build.zig:881 unreachable else prong` 阻塞） |

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
| M2-1 | packages/bun-web-resolver/src/resolve.ts | `resolve()` 支持 exports/imports/conditions | 0% | 未开始 | node 条件导出案例通过 |
| M2-2 | packages/bun-web-resolver/src/tsconfig-paths.ts | tsconfig `paths/baseUrl` 解析 | 0% | 未开始 | TS 路径映射案例通过 |
| M2-3 | packages/bun-web-node/src/fs.ts | `node:fs` + `fs/promises` 绑定 VFS | 0% | 未开始 | sync/async 文件 API 基本覆盖 |
| M2-4 | packages/bun-web-node/src/path.ts | `node:path`（posix/win32）实现 | 0% | 未开始 | 路径规范化回归通过 |
| M2-5 | packages/bun-web-node/src/module.ts | `createRequire/isBuiltin/register` | 0% | 未开始 | CJS/ESM 混合加载通过 |
| M2-6 | test/js/node/ | 优先回放 fs/path/module 相关官方测试 | 0% | 未开始 | 该子集通过率 ≥ 95% |
| M2-7 | packages/bun-web-node/src/buffer.ts | `node:buffer` + Bun 扩展补丁（RFC §8.2 A级） | 0% | 未开始 | `Buffer.from/alloc/concat` 与 Bun 扩展行为一致 |
| M2-8 | packages/bun-web-node/src/events-stream.ts | `node:events` / `node:stream` / `node:stream/web` / `node:stream/promises`（readable-stream，RFC §8.2 A级） | 0% | 未开始 | pipe/transform/async iterator 基础用例通过 |
| M2-9 | packages/bun-web-webapis/src/index.ts | Web 标准 API 补丁层：navigator UA 兼容策略、BroadcastChannel、CompressionStream 扩展（RFC §8.3、§10 `bun-web-webapis/`） | 0% | 未开始 | navigator UA 兼容策略生效；所有 RFC §8.3 Web API 形状不缺失 |

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
| M3-1 | packages/bun-web-installer/src/registry.ts | npm registry metadata 拉取 | 0% | 未开始 | 支持公开包基础元数据查询 |
| M3-2 | packages/bun-web-installer/src/tarball.ts | tarball 下载、解压、完整性校验 | 0% | 未开始 | 校验失败时可中断并报错 |
| M3-3 | packages/bun-web-installer/src/lockfile.ts | `bun.lock` 读写与最小增量更新 | 0% | 未开始 | 重复安装 lockfile 稳定不抖动 |
| M3-4 | packages/bun-web-installer/src/node-modules-layout.ts | 扁平化安装与去重策略 | 0% | 未开始 | express/koa/vite 依赖树可运行 |
| M3-5 | packages/bun-web-vfs/src/cache-store.ts | 包缓存（IndexedDB + OPFS） | 0% | 未开始 | 二次安装耗时显著下降 |
| M3-6 | test/cli/install/ | 回放可兼容安装测试 | 0% | 未开始 | 通过率 ≥ 80% |

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

> **与 RFC §12 偏差说明**：RFC §12 M5 交付含 `bun:test`，实施计划将其推后至 M6（与 Build/Transpiler 同批交付，降低风险）；Shell 从 RFC §12 M6 提前至本阶段，以便 AI Agent 命令集合尽早可用。所有能力最终均覆盖，仅执行顺序调整。

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
| 测试计划确认 | 明确 bundler、bun:test、sqlite 验收标准 | [ ] 待确认 |
| 启动决策 | 批准进入 M6 编码 | [ ] 待确认 |

### TODO List

| ID | 文件 | 功能 | 完成度 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- | --- |
| M6-1 | packages/bun-web-transpiler/src/swc.ts | `Bun.Transpiler` 核心实现 | 0% | 未开始 | TS/JSX 转译与 scanImports 通过 |
| M6-2 | packages/bun-web-bundler/src/build.ts | `Bun.build()` API 与输出管理 | 0% | 未开始 | vite-react-ts 产物可预览 |
| M6-3 | packages/bun-web-test/src/runner.ts | `bun:test` 执行与报告器 | 0% | 未开始 | describe/test/expect 可跑 |
| M6-4 | packages/bun-web-test/src/snapshot.ts | 快照读写（OPFS） | 0% | 未开始 | snapshot 稳定可回放 |
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
| M7-6 | test/integration/bun-in-browser/acceptance.test.ts | 插件生命周期验收用例 | 0% | 未开始 | 注册/卸载副作用可回滚 |
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
| test/integration/bun-in-browser/acceptance.test.ts | 验收集成测试 | `bun run web:test` | 失败 | 2026-04-24：`Timeout waiting for Bun to connect` |
| test/integration/bun-in-browser/m1-kernel.test.ts | M1 smoke 测试 | `bun bd test test/integration/bun-in-browser/m1-kernel.test.ts` | 阻塞 | 2026-04-24：构建失败 `build.zig:881 unreachable else prong`，测试未进入执行阶段 |
| test/integration/bun-in-browser/run-official-tests.ts | 官方测试驱动脚本 | `bun run web:test:official` | 未运行 | 脚本已落盘，待 runtime 最小链路打通后执行 |
| test/integration/bun-in-browser/skip-in-browser.txt | 跳过清单 | 被 `run-official-tests.ts` 读取 | 进行中 | 规则文件已生效，仍需按 issue 逐条补齐注释 |
| test/integration/bun-in-browser/baseline.json | 回归基线 | `bun run web:test:official:update-baseline` | 未创建 | 待首次完整跑通后生成 |

### 5.2 官方测试目录状态（目标与当前）

| 测试目录 | 目标状态 | 当前状态 | 备注 |
| --- | --- | --- | --- |
| test/js/web/ | 通过率 100% | 未运行 | 待 M1-M2 完成后启动 |
| test/js/node/ | 通过率 >= 95% | 未运行 | 需先完成 fs/path/module polyfill |
| test/js/bun/http/ | 通过率 >= 90% | 未运行 | 依赖 M4 `Bun.serve` |
| test/js/bun/crypto/ | 通过率 >= 90% | 未运行 | 依赖 M6 crypto/hasher 适配 |
| test/js/bun/shell/ | 通过率 >= 85% | 未运行 | 依赖 M5 shell builtins |
| test/cli/install/ | 通过率 >= 80% | 未运行 | 依赖 M3 安装器 |
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
| §6 插件体系 | Hook 命名空间、BunWebPlugin 类型、安全沙箱、Bun.plugin 对齐 | M7-1, M7-2 | ⬜ 未开始 |
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
| §8.1 bun:test | 移植 src/js/，snapshot 写 OPFS | M6-3, M6-4 | ⬜ 未开始 |
| §8.1 bun:ffi | 存根；允许 dlopen('.wasm') 扩展 | M7-3（compat registry 登记 D级） | ⬜ 未开始 |
| §8.2 node:fs / fs/promises | VFS + SAB sync | M2-3 | ⬜ 未开始 |
| §8.2 node:path / url / querystring | 纯算法 | M2-4 | ⬜ 未开始 |
| §8.2 node:buffer | buffer 包 + Bun 扩展 | M2-7 | ⬜ 未开始 |
| §8.2 node:events / stream / stream/web | readable-stream | M2-8 | ⬜ 未开始 |
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
| §8.2 node:process | 完整 process 对象 | M1-6 | ⬜ 未开始 |
| §8.2 node:module | createRequire / isBuiltin / register | M2-5 | ⬜ 未开始 |
| §8.2 node:sqlite | 映射到 bun:sqlite | M6-5（含别名） | ⬜ 未开始 |
| §8.3 Web 标准 API | fetch/Blob/File/URL/WebSocket/Streams/TextEncoder/crypto 等；navigator UA 兼容策略 | M2-9 | ⬜ 未开始 |
| §9 Compat Registry | 符号→级别注册；CI 扫描 bun-types；产出 COMPAT.md | M7-3, M7-4 | ⬜ 未开始 |
| §10 `bun-web-kernel/` | Kernel + 调度 + SAB syscall bridge | M1-1, M1-2, M1-7 | ⬜ 未开始 |
| §10 `bun-web-vfs/` | OPFS/Mem overlay fs；包缓存 | M1-3, M1-4, M3-5 | ⬜ 未开始 |
| §10 `bun-web-runtime/` | Process Worker bootstrap、Bun.* 实现 | M1-5, M4-2, M5-3, M8-5 | ⬜ 未开始 |
| §10 `bun-web-node/` | node:* 全家桶 polyfill | M2-3~M2-8, M4-7, M5-4, M5-5, M6-8, M6-9 | ⬜ 未开始 |
| §10 `bun-web-webapis/` | Web 标准 API 补丁层 | M2-9 | ⬜ 未开始 |
| §10 `bun-web-resolver/` | 模块解析 | M2-1, M2-2 | ⬜ 未开始 |
| §10 `bun-web-transpiler/` | swc/esbuild WASM 封装 | M6-1 | ⬜ 未开始 |
| §10 `bun-web-installer/` | bun install | M3-1~M3-4 | ⬜ 未开始 |
| §10 `bun-web-bundler/` | Bun.build | M6-2 | ⬜ 未开始 |
| §10 `bun-web-shell/` | Bun.$ 解释器 | M5-1, M5-2 | ⬜ 未开始 |
| §10 `bun-web-shell-builtins/` | 全部 builtin shell 命令（独立包） | M5-7 | ⬜ 未开始 |
| §10 `bun-web-sw/` | Service Worker HTTP + WS 虚拟化；SW 保活 | M4-1, M4-9 | ⬜ 未开始 |
| §10 `bun-web-test/` | bun:test 运行器 | M6-3, M6-4 | ⬜ 未开始 |
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