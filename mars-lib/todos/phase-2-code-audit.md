# Phase 2 代码实现审计

- 状态: Audited
- 日期: 2026-04-27
- 对应技术设计文档: `mars-lib/rfc/0001-mars-lib-technical-design.md`
- 审计范围: M2-01 到 M2-27 当前实现，以及 `phase2.acceptance.test.ts` / `phase2.installer.acceptance.test.ts` 覆盖情况
- 验证命令: `bun run check`（typecheck + `oxlint --max-warnings 0` + tests）
- 验证结果: Pass
- 追加复核: package exports pattern、exports/imports array fallback、exports subpath 封装、exports/imports null target、imports 外部 package target、package self-reference、`.mjs`/`.cjs` 扩展名补全、条件 exports object、tsconfig paths、package browser map、cyclic ESM/CJS namespace cache、递归 importer invalidation、installer semver hyphen/partial/prerelease/build metadata、installer optionalDependencies、installer peerDependencies、installer workspace symlink、installer lifecycle env/scripts、installer package JS bins、installer tgz/PAX path/linkpath、installer tar symlink、installer fixture cache、dev server、module response、HMR、static/dynamic import 执行、基础 JSX 转换、runtime stdout/stderr、vite config root、alias、define、HMR root、first screen render model 与统一 playground fixture 加载已补验收

## 1. 技术设计核对结论

### 1.1 MarsResolver

对应 RFC 第 13 节要求:

- 支持相对路径、绝对路径、bare package。
- 支持扩展名补全和目录 index。
- 支持 `package.json` 的 `exports`、`imports`、`main`、`module`、`browser` 字段。
- 支持 `tsconfig.json` 的 `baseUrl` 和 `paths`。

当前实现状态:

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 相对路径解析 | Done | `resolve("./feature", importer)` 已覆盖测试。 |
| 绝对路径解析 | Done | 通过 `normalizePath()` 和 `resolveWithExtensions()` 支持。 |
| 扩展名补全 | Done | 默认支持 `.ts`、`.tsx`、`.js`、`.jsx`、`.mjs`、`.cjs`、`.json`。 |
| 目录 index | Done | 支持 `candidate/index + extension`。 |
| bare package | Done | 支持向上查找 `node_modules/<package>`。 |
| package self-reference | Done | 包内部可按自身 `package.json#name` 解析 `pkg` / `pkg/subpath`，并复用 exports/null target 封装语义。 |
| package subpath | Done | 支持 `pkg/subpath` 映射到 package 目录内部路径。 |
| package exports | Done | 支持 `.`、条件对象、subpath、array fallback、`./features/*` 这类 pattern fallback、`null` target 阻断，并阻止带 exports 的未导出 subpath 回退到 package 内部文件。 |
| package imports | Done | 支持从最近 `package.json` 解析 `#alias`、array fallback、`#features/*` 这类 pattern fallback、`null` target 阻断和外部 package target。 |
| module/main | Done | `module` 优先于 `main`。 |
| browser 字段 | Done | 条件 exports 会优先 `browser`，并已支持独立 browser field/map 与 `false` 禁用映射。 |
| tsconfig paths | Done | `createTsconfigPathResolver()` 已实现，并已接入 `resolve()` 主链路。 |

审计修复:

- 将 `conditions` 真正接入 package exports 解析。
- 新增 package subpath 解析。
- 新增 `#imports` 解析。
- 新增 package exports/imports pattern fallback。
- 新增 package exports/imports array fallback。
- 新增 `.mjs`/`.cjs` extensionless resolve 与 browser map candidate 测试覆盖。
- 新增 package exports 未导出 subpath 封装、exports/imports `null` target 与条件 exports object 测试覆盖。
- 新增 package self-reference 测试覆盖。
- 新增 package imports 外部 package target 测试覆盖。
- 新增 package browser field/map 与 `false` 禁用映射测试覆盖。
- 将 `tsconfig paths` 和 `baseUrl` 接入 `resolve()` 主链路。
- 新增相关测试覆盖。

### 1.2 MarsTranspiler

对应 RFC 第 13 节要求:

- 支持 `.ts`、`.tsx`、`.jsx` 转译。
- 输出 `TransformResult`，包含 `code`、`map`、`imports`、`diagnostics`。
- 支持扫描 static import、require、dynamic import。

当前实现状态:

SWC 取舍:

- 当前已直接引入社区 `@swc/wasm-web`，默认 transform 路径使用 SWC WASM，输出 CommonJS 形式供 Mars evaluator 执行。
- SWC WASM 初始化已抽象到 `@mars/shared/createWasmLoader()`，统一处理初始化并发复用、ready 状态和失败后的重试。
- `BasicTranspiler` 仍作为 fallback 保留，覆盖 wasm 初始化失败和同步 `require()` 在 SWC 尚未 ready 前的路径。
- playground/core-modules/transpiler 用例继续验证 static import、dynamic import、JSX 和 export async function；测试关注执行语义与 import graph，不依赖 SWC 生成代码的精确文本。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| TransformInput/TransformResult 类型 | Done | 已定义公共类型。 |
| import 扫描 | Done | 支持 static import、dynamic import、require 的基础正则扫描。 |
| wasm loader | Done | `@mars/shared` 提供 `createWasmLoader()`，SWC adapter 已接入并覆盖并发初始化与失败重试测试。 |
| diagnostics | Done | 空文件 warning 已覆盖基础路径。 |
| sourcemap 字段 | Partial | SWC 可返回 map 字段；source map 消费与文件映射仍需后续硬化。 |
| TS 类型剥离 | Done | 默认由 SWC WASM parser/transform 处理，BasicTranspiler 仅作为 fallback。 |
| TSX/JSX | Done | 默认由 SWC classic JSX transform 输出到 `__mars_jsx` helper。 |
| static import 降级 | Done | SWC CommonJS 输出接入 Mars `require()`。 |
| dynamic import 降级 | Done | string-literal `import()` 降为 `__mars_dynamic_import()` 并接入 loader。 |
| ESM export 转换 | Done | SWC CommonJS 输出接入 `exports`，BasicTranspiler fallback 支持常见 M2 路径。 |

审计结论:

- 当前 SWC WASM 实现足够支撑 M2 的 `.ts` / `.tsx` 直接执行、Vite playground 加载和 first screen render model 验收。
- 仍需硬化完整 ESM live binding、循环依赖、source map 消费、worker 缓存和 React automatic runtime 细节。
- 带有 `import { value } from "./dep"` 的入口现在可经 transpiler 降为 `require()` 后执行。
- 后续可继续增强 SWC WASM/Rust 转译路径，覆盖更完整的 TypeScript、JSX runtime 和 source map 链路。

### 1.3 MarsLoader

对应 RFC 第 13 节要求:

- 支持 ESM、CommonJS、JSON、TS/TSX 执行。
- 支持 ESM/CJS bridge。
- 支持模块缓存和 invalidation。

当前实现状态:

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| LoadedModule/ModuleNamespace/ModuleRecord | Done | 已定义。 |
| JSON module | Done | `format === "json"` 返回 `{ default }`。 |
| TS module import | Done | VFS -> resolver -> transpiler -> evaluator 已覆盖测试。 |
| CJS require | Done | `require()` 通过 resolver 递归加载依赖。 |
| CJS namespace | Done | object exports 返回 `default` 和具名扩展。 |
| module cache | Done | import/require 均写入 `#records` 并复用。 |
| invalidate | Done | 可按 path 删除缓存。 |
| ESM static import | Done | 常见 static import 经 transpiler 降级后可通过 `require()` 递归执行。 |
| dynamic import | Done | string-literal `import()` 经 loader 递归 import 并复用缓存。 |
| ESM/CJS bridge | Done | M2 验收范围内支持 ESM 降级 require、CJS require、JSON require 与缓存复用。 |

审计修复:

- CJS evaluator 接收 loader 提供的 `require()`，不再抛固定错误。
- `require()` 结果写入缓存。
- `import()` 命中缓存时直接返回 namespace。
- 新增 CJS require 与 dynamic import 测试。

### 1.4 MarsRuntime.run(entry)

对应 RFC 第 6、13、20.4 节要求:

- `MarsRuntime.run(entry)` 应能执行 `.ts` / `.tsx` 入口。
- 入口执行需要通过 resolver -> transpiler -> loader。
- 执行结束需要返回进程句柄和退出码。

当前实现状态:

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| run-entry 文件 | Done | `runEntryScript()` 已创建。 |
| loader pipeline | Done | `runtime.run()` 调用 `runEntryScript()`。 |
| exit code | Done | 成功后 kill(pid, 0)，失败后 kill(pid, 1) 并抛错。 |
| stdout/stderr | Done | `console.log/error/warn` 已映射到 ProcessHandle stdout/stderr streams。 |
| TSX 实际执行 | Done | 基础 JSX helper、static import、dynamic import 和 playground TSX render model 已覆盖。 |

## 2. 测试覆盖

当前新增/扩展测试:

1. resolver 相对路径 + 扩展名补全。
2. resolver package exports + imports。
3. resolver package exports/imports pattern fallback。
4. resolver tsconfig paths 与 baseUrl。
5. transpiler TS export 转换。
6. loader 从 MarsVFS import TS module。
7. loader CJS require 递归解析。
8. runtime.run 执行 TS entry 并返回 exit code 0。
9. installer 从离线 metadata/tarball cache 写入 `node_modules`，并通过 resolver 解析写入包。
10. dev server 生成 `/@vite/client`，加载 VFS TSX 模块并返回 JavaScript response。
11. HMR channel 接收 module graph invalidation payload。
12. transpiler 将 static import 降为 require，并转换基础 JSX。
13. loader 执行带 static import 与基础 JSX 的 TSX 模块。
14. dev server 应用 `vite.config.ts` root 与 server.hmr 配置。
15. dev server 通过 `loadPlaygroundFiles("vite-react-ts")` 从真实 `playground/vite-react-ts` 文件加载 TSX 模块。
16. dev server 应用 `vite.config.ts` alias 与 define，并按配置 root 归一化 HMR 路径。
17. playground 功能模块用例通过 `module-cases.json` 登记，并由 acceptance test 校验入口文件真实存在且可读取。
18. resolver package browser field/map 与 `false` 禁用映射。
19. loader dynamic import 通过 module cache 执行。
20. runtime.run stdout/stderr stream 映射。
21. installer 从 `playground/fixtures/npm-cache/metadata.json` 加载真实 fixture cache 并安装递归依赖。
22. TSX/Vite playground first screen render model 验收。
23. `playground/core-modules` 覆盖 resolver、transpiler、loader、runtime、installer、bundler-dev-server 核心模块用例，并由 acceptance test 真实执行。
24. resolver 阻止 package exports 未导出 subpath 回退，并覆盖 root conditional exports object、exports/imports array fallback、`.mjs`/`.cjs` 扩展名补全、exports/imports direct null target、条件 null target、imports 外部 package target 与 package self-reference。
25. installer 覆盖 dist-tag、exact、`^`、`~`、wildcard、hyphen ranges、partial comparators、partial `^`/`~`、comma comparator sets、spaced comparator tokens、OR-combined prerelease gating、v-prefixed exact/partial versions、比较运算符组合、prerelease opt-in 语义和 build metadata，并在 range 不满足时拒绝安装而不是 fallback 到 latest。
26. installer tgz 解包覆盖 PAX extended path，且忽略 `../` 与绝对路径等 tar 路径逃逸条目。
27. installer 覆盖 root 与 transitive optionalDependencies: 可解析时安装，缺失或 range 不满足时跳过且不阻断安装；`bun install` shell 入口会读取 package.json optionalDependencies。
28. installer 覆盖 peerDependencies: required peer 自动安装，已存在 peer 必须满足 range，optional peer 缺失时跳过；`bun install` shell 入口会读取 package.json peerDependencies。
29. installer 覆盖 workspaces: root `package.json#workspaces` 可发现本地 package，`workspace:` 协议依赖由本地 workspace 满足并写入 `node_modules`；`bun.lock` tuple metadata 会记录 workspace path，并以 golden 文本断言固定输出。
30. installer 覆盖 lockfile replay: root 直接依赖与 workspace 包内的 registry 依赖都会沿用 `bun.lock` 已锁版本，metadata 变更后不会静默漂移到新的 latest。
31. installer 覆盖 lifecycle scripts: package/root `preinstall`、`install`、`postinstall` 会在 `bun install` 写入 `node_modules` 后通过 MarsShell 执行，脚本失败会使安装失败。
32. installer 覆盖 lifecycle env: lifecycle scripts 可获得 `npm_lifecycle_*`、`npm_command`、`npm_package_json` 和从所属 package.json 扁平化的 `npm_package_*`。
33. installer 覆盖 package JS bins: package `bin` 元数据会生成 `node_modules/.bin` shim，lifecycle scripts 可通过 `PATH` 调用 shebang JS binary，并获得 Mars 注入的 `process.env` / `process.argv`。
34. installer 覆盖冲突 transitive dependency: root 已有不兼容版本时，依赖会安装到 requester 的嵌套 `node_modules`，resolver 会从对应 package 路径命中 nested version。
35. installer 与 runtime core module 注入联动覆盖官方 npm-installed `express@5.1.0` / `koa@2.14.2` fixture: `bun install` 写入 `node_modules` 后，CJS 应用可 `require("express")`、`require("koa")` 和 `require("node:http")`，并通过 Mars 注入的 `http`/`node:http` 启动虚拟服务。

验证结果:

```text
151 pass
0 fail
991 expect() calls
```

## 2.1 新增工程化模块复核

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| MarsInstaller | Done | 已支持离线 metadata/tarball cache、registry fetch provider、fixture manifest 加载、本地 workspace package 发现、workspace symlink、依赖计划、optionalDependencies 跳过语义、peerDependencies 自动安装与 range 冲突检测、package/root lifecycle env/scripts、`npm_config_{global,local_prefix,prefix,user_agent}` 边缘 env、package bin `.bin` shim 与 shebang JS binary 执行、常见 semver range 选择、hyphen ranges、partial comparators、partial `^`/`~`、comma comparator sets、spaced comparator tokens、OR-combined prerelease gating、v-prefixed exact/partial versions、prerelease opt-in、build metadata、基础 npm tgz/PAX path/linkpath 解包、tar symlink、路径逃逸过滤、写入 `node_modules`、`mars-lock.json` 和结构化 `bun.lock`（`lockfileVersion/configVersion/workspaces/packages` + root workspace name + tuple-style package entries，固定 metadata object 段位 + resolved/workspace metadata，workspace tuple 文本已 golden 固定，且依赖字段写入最终解析版本），并在 root 依赖声明匹配时回放 lockfile 固定版本，包括 workspace 包内部 registry 依赖；完整 Bun lockfile文本格式细节与更高级 npm semver range 语法作为后续硬化项。 |
| MarsBundler DevServer | Done | 已支持 `/@vite/client`、`transformRequest()`、`loadModule()`、vite config root、alias、define、HMR update payload；完整 Vite plugin/server 生命周期作为后续硬化项。 |
| ModuleGraph | Done | 已记录 imports/importers 并支持 invalidation；复杂依赖图清理作为后续硬化项。 |
| Service Worker module response | Done | 已将 module 请求转成 transpiled JavaScript Response，并接入 runtime router。 |
| Playground fixtures | Done | `core-modules`、TSX/Vite React TS 骨架、离线 npm-cache metadata/tarball keys 与功能模块用例已落盘，核心模块 playground 文件已通过统一 fixture loader 被 resolver、transpiler、loader、runtime、installer、dev server 与 Bun.build 验收加载，TSX 示例已纳入 typecheck。 |

## 3. Post-M2 硬化项

### 高优先级

1. 硬化当前 SWC WASM/Rust 转译路径，补齐 worker 缓存、source map 消费和更完整 JSX/TSX runtime。
2. 完整 ESM live binding、循环依赖边界和 CJS/ESM 细节语义仍需硬化；基础 cyclic ESM/CJS namespace cache 已补验收。
3. Vite React TS 真实浏览器首屏仍依赖完整 React JSX runtime、plugin pipeline 和依赖预构建。
4. HMR 浏览器 WebSocket 兼容层需要在 Phase 3 WebSocket/API 稳定性中补齐。

### 已复现失败样例

1. ESM static import: VFS 中 `entry.ts` 引入 `./dep` 后，`ModuleLoader.import()` 曾报 `SyntaxError: Unexpected token '{'. import call expects one or two arguments.`，现已修复常见路径并覆盖测试。
2. Package exports pattern: `exports: { "./features/*": "./src/features/*.ts" }` 下解析 `demo/features/a` 曾返回 `null`，现已修复并覆盖测试。
3. Cyclic module cache: ESM/CJS 循环依赖曾因模块记录执行后才写入缓存而可能重复加载，现已通过预创建 namespace cache 修复常见路径并覆盖测试。

### 中优先级

1. CJS/ESM bridge 需要支持更多 ESM import CJS、CJS require ESM 的边界语义。
2. Module graph 与 invalidation 需要补插件 transform 结果缓存、浏览器 HMR 协议兼容；loader importer cache 已支持递归失效并覆盖测试。
3. Installer 需要继续补完整 Bun lockfile文本格式细节和更高级 npm semver range 语法兼容；optionalDependencies、peerDependencies、workspace symlink、workspace tuple metadata 文本、lifecycle env/scripts、`npm_config_{global,local_prefix,prefix,user_agent}` 边缘 env、package JS bins、常见 range 最高满足版本选择、hyphen ranges、partial comparators、partial `^`/`~`、prerelease opt-in/build metadata、PAX path/linkpath、tar symlink 解包与 root/workspace lockfile replay 已覆盖。

### 低优先级

1. sourcemap 目前是占位。
2. diagnostics 需要更细粒度错误位置。
3. `wasm` 与 `asset` format 只完成类型枚举，尚未执行。

## 4. 结论

Phase 2 当前 M2-01 到 M2-27 已达到工程化验收闭环，测试通过；但其中 `MarsTranspiler`、`MarsLoader`、`MarsBundler` 和 `MarsInstaller` 的部分能力仍是基础实现，不应视为完整 Vite/TSX 生产能力。

后续建议优先替换或增强 transpiler 与 ESM 语义，再补 Vite config/plugin pipeline、真实浏览器 React 首屏、浏览器 HMR 协议兼容和更完整包管理语义。
