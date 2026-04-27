# Mars-lib Playground 接入矩阵

- 状态: Active
- 日期: 2026-04-27
- 目标: 每个 Phase 完成前，都必须有对应 playground 入口、自动化验收和文档同步。
- 功能模块用例清单: `module-cases.json`

## 接入规则

1. Phase 标记为 `Done` 前，必须在本目录存在可运行 playground 入口。
2. Playground 文件必须被对应 Phase 的 acceptance test 真实读取或执行，不能只作为静态占位。
3. Playground 的 TS/TSX 示例必须纳入 `tsconfig.json` 或对应测试类型检查范围。
4. 每次新增或调整 Phase 能力，必须同步更新本矩阵、对应 `todos/phase-*.md` 和 RFC 验收说明。
5. 若 Phase 处于 prework/gated 状态，只能登记为预研接入，不可作为 Phase Done 依据。
6. 功能模块用例必须同步写入 `module-cases.json`，并由 acceptance test 校验用例指向的真实文件存在且可读取。

## 当前矩阵

| Phase | Playground | 入口文件 | 自动化验收 | 状态 | 说明 |
| --- | --- | --- | --- | --- | --- |
| Phase 1 | `core-modules/bun/` | `core-modules/bun/vfs-shell.ts` | `packages/mars-test/src/phase1.acceptance.test.ts` | Done | 覆盖 runtime boot、VFS 基础读写、目录 stat、MarsShell 命令和结构化 grep。 |
| Phase 1 | `core-modules/bun/` | `core-modules/bun/bun-file.ts` | `packages/mars-test/src/phase1.acceptance.test.ts` | Done | 覆盖 `Bun.write()`、`Bun.file()`、file size 和 JSON 读取。 |
| Phase 1 | `core-modules/bun/` | `core-modules/bun/bun-serve.ts` | `packages/mars-test/src/phase1.acceptance.test.ts` | Done | 覆盖 `Bun.serve()` 虚拟端口注册、preview URL 和 `runtime.fetch()` 转发。 |
| Phase 1 | `express/` | `express/server.ts` | `packages/mars-test/src/phase1.acceptance.test.ts` | Done | 覆盖 node:http 风格虚拟服务与 Express hello world 路径。 |
| Phase 1 | `koa/` | `koa/server.ts` | `packages/mars-test/src/phase1.acceptance.test.ts` | Done | 覆盖 async middleware 风格虚拟服务路径。 |
| Phase 2 | `core-modules/resolver/` | `core-modules/resolver/browser-map.json` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 覆盖 package browser field/map、exports/imports、pattern fallback 和禁用映射。 |
| Phase 2 | `core-modules/transpiler/` | `core-modules/transpiler/app.tsx` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 通过 `@swc/wasm-web` 覆盖 static import、dynamic import、JSX 和 export async function，wasm 初始化由 `@mars/shared` 统一管理。 |
| Phase 2 | `core-modules/loader/` | `core-modules/loader/entry.tsx` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 覆盖 TSX 执行、static import、dynamic import、JSON require 和 CJS require。 |
| Phase 2 | `core-modules/runtime/` | `core-modules/runtime/run-entry.ts` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 覆盖 `MarsRuntime.run()` 和 stdout/stderr stream 映射。 |
| Phase 2 | `core-modules/installer/` | `core-modules/installer/dependencies.ts` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 覆盖离线安装入口依赖，并配合 npm-cache fixture 真实安装递归依赖。 |
| Phase 2 | `core-modules/bundler/` | `core-modules/bundler/vite.config.ts` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 覆盖 Vite root、alias、define、DevServer module response 和 HMR path。 |
| Phase 2 | `tsx/` | `tsx/app.tsx` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 覆盖基础 TSX/JSX 转换、loader 执行、stdout/stderr 映射和 first screen render model。 |
| Phase 2 | `vite-react-ts/` | `vite-react-ts/src/App.tsx` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 通过 `loadPlaygroundFiles("vite-react-ts")` 被 DevServer、loader render model 和 Bun.build 真实加载。 |
| Phase 2 | `fixtures/npm-cache/` | `fixtures/npm-cache/metadata.json` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 通过 `loadPlaygroundPackageCache()` 加载离线 metadata/tarball keys，并安装 vite/react/typescript 递归依赖。 |
| Phase 3 | `vite-react-ts/` | `vite-react-ts/src/App.tsx` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | `Bun.build` 可构建 playground entry；Phase 2 Done 前仅作为预研切片。 |
| Phase 4 | 待新增 | 待新增 | `packages/mars-test/src/phase4.acceptance.test.ts` | Not Started | 需要插件、Hook trace、Agent shell/replay playground。 |

## 统一加载入口

Playground 本身是一个 Vite + TypeScript + React 项目，用于运行和展示 Mars-lib 的使用用例。浏览器侧运行入口在 `src/browser-runtime.ts`，Node/Bun 验收读取入口在 `src/node-runtime.ts`。

`mars-test` 不拥有 playground，只从 `playground/src/node-runtime.ts` 读取用例 fixture 做验收，避免测试包和可交互 playground 分叉。

功能模块用例统一登记在 `module-cases.json`，并通过 `loadPlaygroundModuleCases()` 读取。每条用例至少包含 Phase、模块名、playground 名称、入口文件、验收测试文件、状态和说明。

## 运行方式

在 `mars-lib/playground` 目录执行:

```bash
bun install
bun run dev
```

Vite 会启动 React playground 页面。页面中的 `Run Phase 1 + 2` 会运行 Phase 1 的 runtime/VFS/Shell、Bun file、Bun.serve、node:http Express/Koa，以及 Phase 2 的 resolver、transpiler、loader、runtime、installer、bundler-dev-server、TSX 和 Vite React TS 用例。

构建 playground:

```bash
bun run build
```

完整仓库验收仍在 `mars-lib` 目录执行:

```bash
bun run typecheck && bun run test
```

## Phase Done 检查项

| 检查项 | 要求 |
| --- | --- |
| Playground 文件 | 存在真实入口文件，不是空目录或纯占位。 |
| 自动化验收 | 对应 Phase acceptance test 真实加载或执行 playground。 |
| 类型检查 | TS/TSX playground 纳入 typecheck。 |
| 文档同步 | 更新本文件、对应 Phase todo、必要 RFC 段落。 |
| 模块用例 | 更新 `module-cases.json`，并确认 acceptance test 校验入口文件。 |
| 剩余缺口 | 若仍是 partial/prework，必须在 Phase todo 中明确，不得标记 Done。 |