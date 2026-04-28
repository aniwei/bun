# Phase 2: 工程化项目运行

- 状态: Done (M2 验收闭环); Post-M2 Hardening Active
- 总完成百分比: 100%
- 测试状态: Pass
- 依赖 Phase: Phase 1 Runtime 最小闭环必须通过
- 对应技术设计文档: `mars-lib/rfc/0001-mars-lib-technical-design.md`
- 代码审计文档: `mars-lib/todos/phase-2-code-audit.md`
- Playground 接入矩阵: `mars-lib/playground/README.md`
- Playground 功能模块用例: `mars-lib/playground/module-cases.json`
- 相关章节: 6 用户侧 API, 9 MarsVFS 接口, 13 Mars Loader / Resolver / Transpiler, 16 Vite + React + TypeScript 支持, 17 Package Installer 与离线缓存, 19.3 VFS 模块加载, 20.3 Vite + React + TypeScript, 20.4 直接执行 TSX, 21 验收测试接口, 22 M2

## 开始前确认

### 完成口径

Phase 2 的 `Done` 指 M2 设计文档中定义的工程化验收闭环已完成: resolver/transpiler/loader/runtime/installer/dev-server/playground fixture 均有真实自动化验收，且 playground 与文档同步。它不等同于完整 Node/Vite/npm 生产级兼容。

继续被视为 Post-M2 hardening 的能力包括: 完整 ESM live binding 与循环依赖语义、完整 source map 消费、React automatic runtime 细节、真实浏览器 React 首屏、完整 Vite plugin/server lifecycle、浏览器 WebSocket HMR、完整 Bun lockfile parity，以及更高级 npm semver range 语法（npm script env 已补充 `npm_config_{global,local_prefix,prefix,user_agent}` 边缘变量）。这些缺口必须保留在审计文档和后续 Phase/backlog 中，但不阻塞 M2 验收完成。

### 技术设计核对

- 确认 Phase 2 在 Phase 1 的 Runtime、VFS、Kernel、Service Worker、Bun.serve、Shell 基础上继续扩展，不重写 Phase 1 已稳定接口。
- 确认 MarsResolver 需要支持相对路径、绝对路径、bare package、`package.json exports/imports/main/module/browser`、扩展名补全、目录 index、`tsconfig paths`。
- 确认 MarsTranspiler 需要覆盖 `.ts`、`.tsx`、`.jsx` 转译，并输出 imports、diagnostics、source map 可选数据。
- 确认 ModuleLoader 需要支持 ESM/CJS bridge、JSON、TS/TSX 执行、模块缓存和 invalidation。
- 确认 MarsInstaller 需要有离线 cache 路径，验收不依赖外部 registry；`bun install` shell 命令覆盖读取 MarsVFS `package.json` 后写入 `node_modules`，并可在 cache miss 时通过注入的 registry fetch provider 拉取 metadata/tgz tarball 且完成基础解包；常见 semver range 必须选择满足范围的最高版本，不能静默 fallback 到 latest，且需要覆盖 hyphen ranges、partial comparators、prerelease opt-in 语义与 build metadata；tar 解包必须支持 PAX path/linkpath、安全 symlink 并拒绝路径逃逸条目；optionalDependencies 可用时安装，缺失或不满足时跳过且不阻断安装；peerDependencies 必需 peer 可自动解析，已存在 peer 必须满足 range，optional peer 缺失可跳过；workspaces 可发现本地 package、满足 `workspace:` 协议依赖并以 `node_modules` symlink 写入；package/root lifecycle scripts 需要执行且失败时中断安装；lifecycle env 需要覆盖 `npm_lifecycle_*`、`npm_command`、`npm_package_json` 和扁平化 `npm_package_*`；package bin 需要生成 `node_modules/.bin` shim、进入 lifecycle `PATH` 并可执行 shebang JS binary。
- 确认 Vite M1 范围是协议兼容层，而不是完整复刻 Node 版 Vite。
- 确认 `.tsx` 直接执行需要通过 resolver -> transpiler -> loader -> process stdout 或 virtual server 输出完成闭环。

### 代码风格

- 以 `mars-lib/AGENTS.md` 为默认基线，若子模块已有规范且冲突，需在变更说明中注明偏差理由。
- TypeScript / JavaScript 尽量不使用分号 `;` 和双引号 `"`，避免超长行，复杂表达式主动换行。
- 命名保持语义完整，除极小作用域临时变量外，不使用 `tmp`、`ctx`、`cfg`、`obj` 等泛化命名。
- 导入顺序遵循 AGENTS 规则: 绝对 default -> 相对 default -> 绝对具名 -> 相对具名 -> type imports -> 样式/静态资源。
- Resolver、Transpiler、Loader 保持函数职责单一，公共类型与实现拆分，避免单文件和单函数持续膨胀。
- 单文件超过 1000 行必须拆分，优先按领域职责、运行时边界（runtime/kernel/vfs/loader/hooks）、types 与实现拆分。
- Installer 写 lockfile 或缓存索引时必须排序，确保重复执行结果稳定且可回放。
- 测试优先真实执行验收路径，不使用 mock/spyon 替代核心运行链路。
- 提交前执行并通过 `bun run format --check` 与 `bun run lint --max-warnings 0`。

### 前置依赖

- Phase 1 `MarsRuntime.boot()`、MarsVFS、MarsKernel、Service Worker router、Bun API Facade、MarsShell 必须可用。
- Phase 1 Express/Koa 基础验收必须通过。

### Transpiler 取舍说明

- 当前 M2 已接入社区 `@swc/wasm-web`，默认 transpiler 通过 SWC WASM 处理 TS/TSX/JSX、CommonJS 输出、classic JSX pragma 和 sourcemap 字段。
- wasm 初始化状态、并发复用和失败重试统一下沉到 `@mars/shared` 的 `createWasmLoader()`，SWC adapter 只负责声明 `@swc/wasm-web` 的初始化函数。
- `BasicTranspiler` 仍保留为 fallback: wasm 初始化失败时继续支撑验收，且同步 `require()` 在 SWC 尚未初始化前仍可用。
- 验收口径以可执行语义和 import graph 为准，不再绑定 SWC 具体生成代码文本；后续硬化重点是 worker 缓存、完整 source map 和更完整的 ESM 语义。

## Todo

| ID | 状态 | 完成百分比 | 测试通过 | 文件/模块 | 功能介绍 | 完成时设计核对 |
| --- | --- | ---: | --- | --- | --- | --- |
| M2-01 | Done | 100% | Pass | `mars-lib/packages/mars-resolver/src/types.ts` | 定义 `ResolveContext`、`ResolveResult`、resolver fs adapter、conditions、extensions。 | 核对 RFC 第 13 节 Resolve 接口。 |
| M2-02 | Done | 100% | Pass | `mars-lib/packages/mars-resolver/src/package-json.ts` | 读取并解析 `package.json` 的 main/module/browser/exports/imports 字段。 | 核对 RFC 第 13 节 package 字段要求。 |
| M2-03 | Done | 100% | Pass | `mars-lib/packages/mars-resolver/src/exports.ts` | 实现 package exports/imports 条件匹配、subpath、array fallback、pattern fallback、`null` target 阻断和 imports 外部 package target。 | 已覆盖条件 exports/imports、array fallback、`*` pattern fallback、direct null target、条件 null target、imports bare package target 和 package self-reference exports。 |
| M2-04 | Done | 100% | Pass | `mars-lib/packages/mars-resolver/src/tsconfig-paths.ts` | 实现 `baseUrl` 和 `paths` 匹配，返回候选绝对路径。 | 已接入 `resolve()` 主链路并覆盖测试。 |
| M2-05 | Done | 100% | Pass | `mars-lib/packages/mars-resolver/src/resolve.ts` | 实现相对、绝对、bare package、package self-reference、imports 外部 package target、扩展名补全、目录 index resolve。 | 主链路已覆盖 `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`/`.json` 扩展名补全、exports/imports/subpath/tsconfig paths、package browser field/map、未导出 subpath 禁止 fallback、array fallback、`null` target 阻断、条件 exports object、imports bare package target 和 package self-reference 验收。 |
| M2-06 | Done | 100% | Pass | `mars-lib/packages/mars-transpiler/src/types.ts` | 定义 `TransformInput`、`TransformResult`、`ImportRecord`、`Diagnostic`。 | 核对 RFC 第 13 节 Transpiler 接口。 |
| M2-07 | Done | 100% | Pass | `mars-lib/packages/mars-transpiler/src/swc.ts`, `mars-lib/packages/mars-shared/src/wasm-loader.ts` | 提供 SWC WASM transpiler，支持 ts/tsx/jsx 到 Mars 可执行 js，并复用共享 wasm loader。 | 默认使用 `@swc/wasm-web`，wasm 初始化由 `@mars/shared` 管理，保留 BasicTranspiler fallback；dynamic import 仍降级到 `__mars_dynamic_import()`，JSX 使用 Mars helper。 |
| M2-08 | Done | 100% | Pass | `mars-lib/packages/mars-transpiler/src/scan-imports.ts` | 扫描 static import、require、dynamic import，用于 module graph。 | 核对 RFC 第 13 节 `scanImports`。 |
| M2-09 | Done | 100% | Pass | `mars-lib/packages/mars-loader/src/module-record.ts` | 定义 LoadedModule、ModuleNamespace、缓存记录和状态机。 | 核对 RFC 第 13 节 ModuleLoader。 |
| M2-10 | Done | 100% | Pass | `mars-lib/packages/mars-loader/src/cjs.ts` | 实现 CommonJS wrapper、`require()`、`module.exports`、JSON require。 | CJS require、JSON require 和循环 require namespace cache 已覆盖，并可通过 resolver 递归加载依赖。 |
| M2-11 | Done | 100% | Pass | `mars-lib/packages/mars-loader/src/esm.ts` | 实现 ESM import 入口、动态 import、模块缓存。 | static import 经 transpiler 降级后可执行，dynamic import 已接入 loader cache；cyclic ESM namespace cache 已覆盖，完整 live binding 作为后续硬化项。 |
| M2-12 | Done | 100% | Pass | `mars-lib/packages/mars-loader/src/loader.ts` | 串联 resolver、VFS、transpiler、CJS/ESM evaluate、invalidate。 | resolver/transpiler/evaluate/cache 已串联，TSX、static import、dynamic import、CJS/JSON、循环 namespace cache 和递归 importer invalidation 真实执行已覆盖。 |
| M2-13 | Done | 100% | Pass | `mars-lib/packages/mars-runtime/src/run-entry.ts` | 实现 `MarsRuntime.run(entry)` 和 `bun app.tsx` 执行路径。 | TS/TSX entry 已可执行，console stdout/stderr 已映射到 ProcessHandle streams。 |
| M2-14 | Done | 100% | Pass | `mars-lib/packages/mars-installer/src/types.ts` | 定义 InstallOptions、InstallResult、ResolvedPackage、PackageMetadata、PackageCache、PackageInstaller。 | 已核对 RFC 第 17 节 Installer 接口，支持 dependencies/devDependencies/optionalDependencies/peerDependencies/workspaces 输入与 metadata。 |
| M2-15 | Done | 100% | Pass | `mars-lib/packages/mars-installer/src/cache.ts` | 实现 metadata/tarball 内存离线缓存接口，支持确定性验收 fixture 注入。 | 已提供 fixture manifest -> MemoryPackageCache 入口，并由 playground npm-cache 真实加载验收。 |
| M2-16 | Done | 100% | Pass | `mars-lib/packages/mars-installer/src/plan.ts`, `mars-lib/packages/mars-installer/src/version-range.ts`, `mars-lib/packages/mars-installer/src/registry.ts` | 实现最小依赖安装计划，支持 root dependencies/devDependencies/optionalDependencies/peerDependencies/workspaces 递归解析并排序，cache miss 时可通过 registry fetch provider 拉取 metadata。 | 已核对 RFC 第 17 节 node_modules 写入路径，支持 dist-tag、exact、`^`、`~`、wildcard、比较运算符组合、hyphen ranges、partial comparators、prerelease opt-in 语义和 build metadata，且 required range 不满足时报错；optional dependency 缺失或不满足时跳过；required peer 自动安装，peer range 冲突时报错，optional peer 缺失时跳过；本地 workspace package 优先解析、可满足 `workspace:` range，并以 VFS symlink 写入 `node_modules`；package/root lifecycle scripts 通过 shell 执行并传播失败；lifecycle env 覆盖 `npm_lifecycle_*`、`npm_command`、`npm_package_json` 和扁平化 `npm_package_*`；package bin 元数据会写入 `.bin` shim，进入 lifecycle `PATH` 并执行 shebang JS binary。 |
| M2-17 | Done | 100% | Pass | `mars-lib/packages/mars-installer/src/write-node-modules.ts`, `mars-lib/packages/mars-installer/src/extract-tarball.ts`, `mars-lib/packages/mars-client/src/runtime.ts` | 将解析后的包写入 MarsVFS `/workspace/node_modules` 和 `mars-lock.json`，并通过 `bun install` shell 命令从 `package.json` 触发 cache/registry/tgz 解包安装。 | 已通过 resolver 从写入后的 node_modules 解析 package，并覆盖 shell `bun install` 主流程、registry fetch provider、基础 npm tgz 解包、PAX path/linkpath、tar symlink 和路径逃逸过滤。 |
| M2-18 | Done | 100% | Pass | `mars-lib/packages/mars-bundler/src/dev-server.ts` | 实现 Vite 协议兼容 DevServer listen/close/transformRequest/loadModule。 | `/@vite/client`、`/src/App.tsx`、vite config root、alias、define、HMR root 与 playground Vite TSX 加载已验收；完整插件 pipeline 作为后续硬化项。 |
| M2-19 | Done | 100% | Pass | `mars-lib/packages/mars-bundler/src/module-graph.ts` | 实现 Vite dev module graph、依赖关系和 invalidate。 | HMR invalidation 已验收，基础 imports/importers 图已接入 dev server。 |
| M2-20 | Done | 100% | Pass | `mars-lib/packages/mars-bundler/src/vite-client.ts` | 提供 `/@vite/client` 虚拟模块。 | 已通过 dev server response 验收。 |
| M2-21 | Done | 100% | Pass | `mars-lib/packages/mars-bundler/src/hmr-channel.ts` | 实现 MessageChannel 风格 HMR payload 通道。 | payload 发送已验收；浏览器 WebSocket 兼容层作为 Phase 3 WebSocket/HMR 硬化项。 |
| M2-22 | Done | 100% | Pass | `mars-lib/packages/mars-bundler/src/vite-config.ts` | 读取 `vite.config.ts` 的 root、resolve.alias、define、server.hmr 核心字段。 | root、server.hmr、alias 与 define 已接入 DevServer 验收；复杂 config 表达式与插件配置作为后续硬化项。 |
| M2-23 | Done | 100% | Pass | `mars-lib/packages/mars-sw/src/module-response.ts` | 将 VFS 模块请求转成 transpiled JavaScript Response。 | 已接入 ServiceWorkerRouter，并通过 dev server module response 验收。 |
| M2-24 | Done | 100% | Pass | `mars-lib/playground/tsx/app.tsx` | 编写直接执行 TSX 验收样例。 | TSX JSX 执行已由 acceptance 覆盖，通过 `loadPlaygroundFiles()` 纳入统一 playground fixture，并校验 first screen render model。 |
| M2-25 | Done | 100% | Pass | `mars-lib/playground/vite-react-ts/` | 放置 Vite React TS 验收项目骨架。 | package/index/src/vite.config/src/App.tsx 已落盘，由 dev server、loader render model 和 Bun.build 从真实 playground fixture 加载验收，且 playground TSX 已纳入 typecheck。 |
| M2-26 | Done | 100% | Pass | `mars-lib/playground/fixtures/npm-cache/` | 放置 express/koa/vite/react/typescript 等离线 tgz fixture。 | metadata、tarball key 与包文件内容已落盘，并通过 `loadPlaygroundPackageCache()` 真实安装验收。 |
| M2-27 | Done | 100% | Pass | `mars-lib/packages/mars-test/src/phase2.acceptance.test.ts`, `mars-lib/packages/mars-test/src/phase2.installer.acceptance.test.ts` | 覆盖 resolver、tsx 执行、installer 离线安装、Vite client/module response 与 HMR。 | 已覆盖 browser map、static/dynamic import、基础 JSX、stdout/stderr、installer fixture、semver range/hyphen/partial/prerelease/build metadata、optionalDependencies、peerDependencies、workspace symlink、lifecycle env、package JS bins、tgz/PAX path/linkpath、tar symlink、dev server、module response、HMR、vite config root、alias、define、统一 playground fixture 与 first screen render model。 |

## Phase 完成标准

- MarsResolver 能解析验收项目中的相对路径、bare package、package self-reference、exports/imports array fallback、`.mjs`/`.cjs` 扩展名补全、tsconfig paths。
- MarsTranspiler 能转译 `.ts`、`.tsx`、`.jsx`，并输出 imports 和 diagnostics。
- ModuleLoader 能执行 `.tsx` 文件、缓存循环 ESM/CJS namespace、递归失效 importer cache，并返回正确 stdout 或 virtual server 输出。
- MarsInstaller 能从 cache、registry fetch provider 或本地 workspace 写入验收项目需要的 `node_modules`，支持基础 npm tgz 解包、PAX path/linkpath、tar symlink、路径逃逸过滤、常见 semver range 最高满足版本选择、hyphen ranges、partial comparators、prerelease opt-in/build metadata、optionalDependencies 跳过语义、核心 peerDependencies 解析、`workspace:` 协议、workspace symlink、package/root lifecycle env/scripts 和 package JS bins；`bun install` shell 命令已能读取 MarsVFS `package.json` 并触发该安装路径。
- Vite React TS 项目可以通过 playground fixture 加载，并由 loader 验证 first screen render model。
- 修改 `src/App.tsx` 后 HMR 生效，且不重启整个 runtime。
- Playground 已接入 `playground/core-modules`、`playground/tsx`、`playground/vite-react-ts` 与 `playground/fixtures/npm-cache`，并通过 `loadPlaygroundFiles()` / `loadPlaygroundPackageCache()` 被 Phase 2 acceptance test 真实加载；功能模块用例已登记到 `playground/module-cases.json` 并校验真实入口文件。
- Phase 2 测试全部通过；最新完整验证为 `bun run check`（typecheck + `oxlint --max-warnings 0` + tests），结果 `98 pass / 0 fail / 594 expect() calls`。

## 状态更新规则

1. 每完成一个 Todo，必须回查 RFC 对应章节，确认文件职责没有越界。
2. Todo 未接入真实验收测试前，完成百分比不得超过 80%。
3. 涉及 Phase 1 接口改动时，必须重新运行 Phase 1 相关验收。
4. Phase 总完成百分比按 Todo 完成百分比平均计算。
5. 所有 Todo 为 `Done`、Phase 1/2 验收通过、playground 接入矩阵、`module-cases.json` 和 RFC 已同步后，Phase 状态更新为 `Done`。
