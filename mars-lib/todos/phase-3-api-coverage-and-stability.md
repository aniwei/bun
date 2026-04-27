# Phase 3: API 覆盖与稳定性

- 状态: Ready (Phase 2 Done, awaiting explicit start)
- 总完成百分比: 12%
- 测试状态: Pass
- 依赖 Phase: Phase 1、Phase 2 已通过
- 执行策略: Phase 3 需要用户明确启动后再进入主线实现；当前仅保留已完成的低风险预研切片与兼容矩阵维护。
- 对应技术设计文档: `mars-lib/rfc/0001-mars-lib-technical-design.md`
- Playground 接入矩阵: `mars-lib/playground/README.md`
- Playground 功能模块用例: `mars-lib/playground/module-cases.json`
- 相关章节: 8 MarsKernel 进程与端口接口, 9 MarsVFS 接口, 10 Mars Service Worker Runtime, 11 Bun API Facade, 16 Vite + React + TypeScript 支持, 18 MarsCore Rust/WASM 边界, 20.6 浏览器兼容, 22 M3, 23 风险与对策

## 开始前确认

### 技术设计核对

- 确认 Phase 3 不改变 Phase 1/2 的验收主线，只在现有 MarsRuntime、MarsKernel、MarsVFS、MarsLoader、MarsBundler 基础上扩展 API 覆盖率和稳定性。
- 确认 `Bun.spawn()` 在浏览器中映射为受控 Worker 或内置命令，不承诺 native 子进程。
- 确认 `Bun.spawnSync()` 在无 SharedArrayBuffer 环境下允许降级为明确错误或 async fallback，具体策略需要记录在未决问题中。
- 确认 `Bun.build()` 可以先复用 MarsBundler 的构建能力，输出到 MarsVFS。
- 确认 crypto/password 可以优先使用 WebCrypto 或 Rust crypto wasm，所有输入输出类型需与 Bun 常见用法兼容。
- 确认 sqlite 使用 WASM 模块并在 MarsVFS 上读写数据库文件。
- 确认 WebSocket upgrade 经由 Service Worker/虚拟服务器通道实现，浏览器安全限制下不提供原生 TCP。
- 确认 OPFS 持久化用于恢复 runtime 文件状态，不替代内存层热路径。
- 确认 Chrome 与 Firefox 验收要分别覆盖 SAB 与 async fallback profile。

### 代码风格

- 以 `mars-lib/AGENTS.md` 为默认基线，若子模块已有规范且冲突，需在变更说明中注明偏差理由。
- TypeScript / JavaScript 尽量不使用分号 `;` 和双引号 `"`，避免超长行，复杂表达式主动换行。
- 命名保持语义完整，除极小作用域临时变量外，不使用 `tmp`、`ctx`、`cfg`、`obj` 等泛化命名。
- 导入顺序遵循 AGENTS 规则: 绝对 default -> 相对 default -> 绝对具名 -> 相对具名 -> type imports -> 样式/静态资源。
- 新 API 必须同步维护兼容矩阵，明确 supported/partial/unsupported/fallback 行为。
- crypto/sqlite/websocket 等能力保持独立包实现，公共类型与实现拆分，避免 `mars-runtime` 单点膨胀。
- 单文件超过 1000 行必须拆分，优先按领域职责、运行时边界（runtime/kernel/vfs/loader/hooks）、types 与实现拆分。
- Rust 代码遵循同等可读性要求，`use` 顺序为标准库/第三方 -> `crate::` -> `super::`。
- 提交前执行并通过 `ox format --check` 与 `ox lint --max-warnings 0`。

### 前置依赖

- Phase 1: Runtime、VFS、Kernel、SW、Shell、Express/Koa 验收通过。
- Phase 2: Resolver、Transpiler、Loader、Installer、Vite React TS、TSX 执行、playground 矩阵与文档同步验收通过。

## Todo

| ID | 状态 | 完成百分比 | 测试通过 | 文件/模块 | 功能介绍 | 完成时设计核对 |
| --- | --- | ---: | --- | --- | --- | --- |
| M3-01 | In Progress | 65% | Pass | `mars-lib/packages/mars-runtime/src/compat-matrix.ts` | 定义 Bun API 兼容矩阵，记录 supported/partial/unsupported/fallback。 | 已记录 M1/M3 已实现 API 与 planned API，并由 Phase3 测试覆盖 `Bun.build` 条目；后续新增 API 需持续补全。 |
| M3-02 | Not Started | 0% | Not Run | `mars-lib/packages/mars-kernel/src/process-worker-factory.ts` | 实现受控 Process Worker 创建、初始化、销毁。 | 核对 RFC 第 8 和第 23.2 节进程限制。 |
| M3-03 | Not Started | 0% | Not Run | `mars-lib/packages/mars-kernel/src/stdio.ts` | 实现 stdin/stdout/stderr stream 桥接、backpressure 和关闭语义。 | 核对 RFC 第 8 节 stdio 事件。 |
| M3-04 | Not Started | 0% | Not Run | `mars-lib/packages/mars-runtime/src/bun-spawn.ts` | 实现 `Bun.spawn()` 到 Process Worker 或内置命令的映射。 | 核对 RFC 第 11 与第 23.2 节。 |
| M3-05 | Not Started | 0% | Not Run | `mars-lib/packages/mars-runtime/src/bun-spawn-sync.ts` | 实现 `Bun.spawnSync()` 的 SAB 路径和无 SAB 降级错误。 | 核对 RFC 第 23.3 与第 24 节未决问题。 |
| M3-06 | In Progress | 70% | Pass | `mars-lib/packages/mars-bundler/src/build.ts` | 实现 `Bun.build()` 底层构建入口，支持 entrypoints/outdir/outfile/format/target。 | 已支持 entrypoints、outfile/outdir、format、target、define、sourcemap 占位与 VFS 读取；可构建 vite playground entry；完整依赖 bundling/splitting/minify 待补。 |
| M3-07 | In Progress | 70% | Pass | `mars-lib/packages/mars-bundler/src/output-writer.ts` | 将 build 产物、source map、logs 写入 MarsVFS。 | 已写入 MarsVFS、自动创建输出目录，并返回 text/arrayBuffer artifact；source map 文件输出待补。 |
| M3-08 | In Progress | 70% | Pass | `mars-lib/packages/mars-runtime/src/bun-build.ts` | 将 `Bun.build()` facade 接到 MarsBundler。 | `runtime.bun.build()` 已接入 MarsBundler 并覆盖 TSX entry 验收；Bun BuildResult 完整结构待补。 |
| M3-09 | Not Started | 0% | Not Run | `mars-lib/packages/mars-crypto/src/hasher.ts` | 实现 `Bun.CryptoHasher` 常用算法，优先 sha1/sha256/sha512/md5。 | 核对 RFC 第 11 与第 22 M3。 |
| M3-10 | Not Started | 0% | Not Run | `mars-lib/packages/mars-crypto/src/password.ts` | 实现 `Bun.password.hash()`、`verify()` 的浏览器兼容路径。 | 核对 RFC 第 11 节 password API。 |
| M3-11 | Not Started | 0% | Not Run | `mars-lib/packages/mars-node/src/crypto.ts` | 实现 `node:crypto` 验收路径子集，如 createHash、randomUUID、randomBytes。 | 核对 RFC 第 12 与第 22 M3。 |
| M3-12 | Not Started | 0% | Not Run | `mars-lib/packages/mars-sqlite/src/sqlite-wasm.ts` | 加载 sqlite WASM，初始化数据库实例。 | 核对 RFC 第 11 和第 18 节 sqlite 边界。 |
| M3-13 | Not Started | 0% | Not Run | `mars-lib/packages/mars-sqlite/src/vfs-adapter.ts` | 将 sqlite 文件读写适配到 MarsVFS。 | 核对 RFC 第 9 和第 22 M3。 |
| M3-14 | Not Started | 0% | Not Run | `mars-lib/packages/mars-runtime/src/bun-sql.ts` | 提供 `Bun.sql` 或 SQLFactory facade。 | 核对 RFC 第 11 节 `Bun.sql`。 |
| M3-15 | Not Started | 0% | Not Run | `mars-lib/packages/mars-webapis/src/websocket-server.ts` | 实现 VirtualServer WebSocket upgrade 适配层。 | 核对 RFC 第 11 和第 22 M3。 |
| M3-16 | Not Started | 0% | Not Run | `mars-lib/packages/mars-sw/src/websocket-route.ts` | 在 Service Worker/Bridge 中分发 WebSocket upgrade 或 HMR 通道。 | 核对 RFC 第 10、第 16 和第 23.2 节。 |
| M3-17 | Not Started | 0% | Not Run | `mars-lib/packages/mars-vfs/src/opfs-adapter.ts` | 实现 OPFS persistence adapter，支持 open/get/set/delete/keys/close。 | 核对 RFC 第 9 与第 22 M3。 |
| M3-18 | Not Started | 0% | Not Run | `mars-lib/packages/mars-vfs/src/snapshot.ts` | 实现 snapshot/restore，支持 runtime 文件状态恢复。 | 核对 RFC 第 6、第 9 和第 22 M4 前置能力。 |
| M3-19 | Not Started | 0% | Not Run | `mars-lib/packages/mars-kernel/src/capabilities.ts` | 检测 SharedArrayBuffer、Atomics.wait、OPFS、Service Worker 等能力。 | 核对 RFC 第 23.3 节 SAB 风险对策。 |
| M3-20 | Not Started | 0% | Not Run | `mars-lib/packages/mars-test/src/browser-profiles.ts` | 定义 chromium/firefox、sab/async fallback、memory/opfs 测试 profile。 | 核对 RFC 第 20.6 与第 21 节。 |
| M3-21 | In Progress | 18% | Pass | `mars-lib/packages/mars-test/src/phase3.acceptance.test.ts` | 覆盖重复 boot/dispose、spawn/kill、build、crypto、sqlite、OPFS restore。 | 已新增 Phase3 验收入口并覆盖 Bun.build、vite playground entry 与兼容矩阵；稳定性、crypto、sqlite、OPFS 待补。 |
| M3-22 | In Progress | 60% | Pass | `mars-lib/docs/compatibility/bun-api.md` | 生成或维护 Bun API 兼容矩阵文档。 | 已新增 Bun API 兼容矩阵文档并记录 Bun.build 当前支持范围；后续 API 需同步维护。 |

## Phase 完成标准

- `Bun.spawn()` 可运行受控 Worker 或内置命令，stdio 和退出码稳定。
- `Bun.spawnSync()` 在支持 SAB 的环境下可用，在不支持时有明确可测试的降级行为。
- `Bun.build()` 可构建 M2 验收项目核心样例，并写入 MarsVFS。
- Phase 3 API 切片必须接入 playground；当前 prework 已通过 `playground/vite-react-ts` 覆盖 `Bun.build`，并登记到 `playground/module-cases.json`，但仍不作为 Phase 3 Done 依据。
- `Bun.CryptoHasher`、`Bun.password`、`node:crypto` 常用路径通过测试。
- `Bun.sql` 或 sqlite wasm 能在 MarsVFS 上创建、读写并恢复数据库文件。
- WebSocket upgrade 或 HMR 通道不破坏 M2 Vite HMR。
- OPFS 持久化和 snapshot/restore 可恢复工作区。
- Chrome/Firefox 浏览器 profile 验收通过。

## 状态更新规则

1. 每个新增 API 完成时必须更新兼容矩阵。
2. Todo 未覆盖浏览器真实测试前，完成百分比不得超过 75%。
3. 涉及 M1/M2 已验收路径的改动，必须重新运行对应 Phase 验收。
4. Phase 总完成百分比按 Todo 完成百分比平均计算。
5. 所有稳定性与兼容性测试通过，并完成对应 playground 入口、playground 矩阵、`module-cases.json` 和兼容文档同步后，Phase 状态才能更新为 `Done`。
