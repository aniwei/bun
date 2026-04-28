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
| Phase 1 | `node-http/` | `node-http/server.ts` | `packages/mars-test/src/phase1.acceptance.test.ts` | Done | 覆盖应用源码通过 `node:http` 导入 `createServer()`、`listen(0)` 动态端口、POST headers/body、`address()` 和 `close()` 解绑。 |
| Phase 1 | `express/` | `express/server.ts` | `packages/mars-test/src/phase1.acceptance.test.ts` | Done | 覆盖 Express 风格 `app.use()`、`app.get()`、`app.post()`、`app.listen()`，源码通过 `node:http` 创建虚拟服务，包含 middleware header、GET query、POST JSON body 和 `close()` 解绑。 |
| Phase 1 | `koa/` | `koa/server.ts` | `packages/mars-test/src/phase1.acceptance.test.ts` | Done | 覆盖 Koa 风格 `app.use()` 洋葱中间件、async `next()`、`app.listen()`，源码通过 `http` 创建虚拟服务，包含 after middleware header、GET query、POST body 和 `close()` 解绑。 |
| Phase 2 | `core-modules/resolver/` | `core-modules/resolver/browser-map.json` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 覆盖 package browser field/map、exports/imports、array fallback、imports 外部 package target、pattern fallback、`.mjs`/`.cjs` 扩展名补全、`null` target 阻断、package self-reference 和禁用映射。 |
| Phase 2 | `core-modules/transpiler/` | `core-modules/transpiler/app.tsx` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 通过 `@swc/wasm-web` 覆盖 static import、dynamic import、JSX 和 export async function，wasm 初始化由 `@mars/shared` 统一管理。 |
| Phase 2 | `core-modules/loader/` | `core-modules/loader/entry.tsx` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 覆盖经 SWC WASM 转译后的 TSX 执行、static import、dynamic import、JSON require、CJS require、cyclic ESM namespace cache 和递归 importer invalidation。 |
| Phase 2 | `core-modules/runtime/` | `core-modules/runtime/run-entry.ts` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 覆盖 `MarsRuntime.run()` 通过 `@swc/wasm-web` 转译 TS entry，并映射 stdout/stderr stream。 |
| Phase 2 | `core-modules/installer/` | `core-modules/installer/dependencies.ts` | `packages/mars-test/src/phase2.acceptance.test.ts`, `packages/mars-test/src/phase2.installer.acceptance.test.ts` | Done | 覆盖 semver range 离线安装入口依赖，写入 `package.json` 后通过 `bun install` shell 命令配合 npm-cache fixture 真实安装递归依赖；独立验收覆盖 hyphen ranges、partial comparators、prerelease opt-in、build metadata、嵌套 transitive dependency、optionalDependencies 跳过语义、peerDependencies 自动安装/冲突检测、workspace symlink、lifecycle env、package JS bins，以及安装官方 `express@5.1.0` / `koa@2.14.2` fixture 后通过 `express` / `koa` / `node:http` 启动虚拟服务。 |
| Phase 2 | `core-modules/installer/` | `core-modules/installer/dependencies.ts` | `packages/mars-test/src/phase2.acceptance.test.ts`, `packages/mars-test/src/phase2.installer.acceptance.test.ts` | Done | 覆盖 registry fetch provider: cache miss 时拉取 package metadata 与 tgz tarball，并由 `bun install` 解包写入 `node_modules`；独立验收覆盖 PAX path/linkpath、tar symlink 与路径逃逸过滤。 |
| Phase 2 | `core-modules/bundler/` | `core-modules/bundler/vite.config.ts` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 覆盖 Vite root、alias、define、DevServer module response 和 HMR path。 |
| Phase 2 | `tsx/` | `tsx/app.tsx` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 覆盖 `@swc/wasm-web` TSX/JSX 转换、loader 执行、stdout/stderr 映射和 first screen render model。 |
| Phase 2 | `vite-react-ts/` | `vite-react-ts/src/App.tsx` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 通过 `loadPlaygroundFiles("vite-react-ts")` 被 DevServer 和 loader render model 真实加载；运行时转译走 SWC WASM，Bun.build 预研走 esbuild-wasm。 |
| Phase 2 | `fixtures/npm-cache/` | `fixtures/npm-cache/metadata.json` | `packages/mars-test/src/phase2.acceptance.test.ts` | Done | 通过 `loadPlaygroundPackageCache()` 加载离线 metadata/tarball keys，并安装 vite/react/typescript 递归依赖和官方 Express/Koa tarball dependency graph。 |
| Phase 3 | `vite-react-ts/` | `vite-react-ts/src/App.tsx` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | `Bun.build` 通过 `esbuild-wasm` 构建 playground entry，支持 `minify: true`，并在 `sourcemap: true` 时写出 `.js.map` artifact；Phase 2 Done 前仅作为预研切片。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/bun-run-index.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | `bun run index.ts` 通过 MarsShell 命令层进入 Kernel 虚拟 pid、SWC WASM loader 和 stdio bridge；配置 native-capable Process Worker factory 时，MarsShell 与 `runtime.spawn()` 均可把 `bun run` stdout/stderr/exit 回灌到 Kernel ProcessHandle；ServiceWorker 模块拦截待补。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/bun-run-index.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | `Bun.spawn({ cmd: ["bun", "run", "index.ts"] })` 复用 bun run 执行链路；通用命令执行已覆盖，配置 Process Worker factory 后 `Bun.spawn` / `runtime.spawn` 的 worker 路由、`ProcessHandle.write()` / `ProcessHandle.closeStdin()` 转发、初始 string stdin、初始 ReadableStream stdin 转发与 stdin stream close 协议已进入验收，完整 backpressure 细节待补。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/crypto.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | `Bun.CryptoHasher` / `node:crypto` 预研用例覆盖 WebCrypto sha256 digest、Mars md5 fallback 与 async createHmac，完整同步 Hash/Hmac 待补。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/password.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | `Bun.password` 预研用例覆盖 WebCrypto PBKDF2-SHA256 hash/verify fallback 和 cost-to-iterations 映射，bcrypt/argon2 待补。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/sqlite.ts`, `core-modules/runtime/sqlite-transaction.ts`, `core-modules/runtime/sqlite-wasm.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | `Bun.sql` 预研用例覆盖 sql.js sqlite WASM 在 MarsVFS 上的 create/insert/select/update/delete、tagged query、database 文件持久化与 begin/commit/rollback 事务语义；`sqlite-wasm` 用例额外验证二进制文件 header（`SQLite format 3`）与 reopen 可读性。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/snapshot.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | VFS snapshot 用例覆盖 workspace tree 序列化与跨 runtime restore，为 OPFS persistence adapter 做前置。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/stdio.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | Kernel stdio 用例覆盖 ProcessHandle stdin 写入、stdout/stderr stream 和 WritableStream mirror。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/opfs.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | OPFS persistence adapter 用例覆盖 open/get/set/delete/keys/close；无 OPFS 环境使用 memory fallback 保持验收稳定。 |
| Phase 3 | `packages/mars-test/src/` | `browser-profiles.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | Chromium/Firefox 自动化矩阵已定义，覆盖 SAB+ServiceWorker、OPFS、async fallback 与 ServiceWorker module profiles；真实 browser runner 接线待补。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/process-worker.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | Process worker factory 用例覆盖受控 worker boot/message/terminate、in-memory fallback、Worker URL native carrier 和 stdin/stdout/stderr 消息协议；worker global 注入仍属后续链路。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/process-worker-bootstrap.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | Process Worker runtime bootstrap 用例覆盖 boot payload 注入 Bun/process/require 上下文，并以 argv/cwd/env context 驱动 worker scope。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/process-worker-script.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | Process Worker script 用例覆盖 module Worker bootstrap source 生成和 Blob URL 发布，为真实 workerURL 打包加载做前置。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/process-worker-script.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Smoke | 真实浏览器 Worker smoke 用例通过 Blob module URL 创建原生 Worker，从 VFS snapshot restore base tree，再由源 runtime `Bun.write()` 触发 Process Worker VFS 自动 fanout，boot Process Worker runtime，并验证 `bun run` entry 的 stdout/exit 回传。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/bridge-chain.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | ServiceWorker/Kernel/Process Worker bridge 用例覆盖 client->SW fetch、SW->Kernel bridge-backed server.request、MessageChannel transport、Kernel->Process Worker lifecycle、`process.worker.vfs.patch`、`process.worker.run`，以及 `kernel.spawn(kind: "worker")` 自动创建 Process Worker 后的 stdout/exit 回灌。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/service-worker-registration.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | ServiceWorker registration 用例覆盖 `createMarsRuntime({ serviceWorkerUrl })`、register/ready、client->SW MessageChannel 握手和 dispose unregister 生命周期。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/service-worker-bootstrap.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | ServiceWorker bootstrap 用例覆盖 SW script 收到 `sw.connect` MessagePort、安装 client bridge controller、处理 `sw.fetch` RPC、fetch event handler，以及 Vite host dev client/source 请求的 network fallback。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/service-worker-module-response.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | ServiceWorker module response 用例覆盖 `/src/*.ts` 原生源码 URL 首跳、`/__mars__/module` ESM 响应、入口 import 重写、相对依赖二跳和 VFS `node_modules` bare import 二跳加载。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/service-worker-scope-smoke.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Smoke | 真实 ServiceWorker scope smoke 用例通过 Vite 同源 SW 脚本注册真实 `navigator.serviceWorker`；生成脚本不使用 top-level await，而是以 `bootPromise` 完成 VFS hydrate，再由 `runtime.bun.write()` 触发 ServiceWorker VFS 自动 fanout，并通过 `sw.fetch` 验证 SW scope 内 `/__mars__/module` ESM 响应。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/kernel-worker-bootstrap.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Prework | Kernel Worker bootstrap 用例覆盖 worker 收到 `kernel.connect` MessagePort、安装 Kernel controller、页面侧 `new Worker()` carrier、响应 `kernel.boot` 和 Process Worker lifecycle RPC。 |
| Phase 3 | `core-modules/runtime/` | `core-modules/runtime/playground-host.ts` | `packages/mars-test/src/phase3.acceptance.test.ts` | Smoke | Playground host runtime 用例要求 Vite dev/preview 输出 COOP/COEP headers，使页面进入 `crossOriginIsolated` 并启用 `SharedArrayBuffer`，同时页面加载时注册真实 ServiceWorker。 |
| Phase 4 | 待新增 | 待新增 | `packages/mars-test/src/phase4.acceptance.test.ts` | Not Started | 需要插件、Hook trace、Agent shell/replay playground。 |

## 统一加载入口

Playground 本身是一个 Vite + TypeScript + React 项目，用于运行和展示 Mars-lib 的使用用例。浏览器侧运行入口在 `src/browser-runtime.ts`，Node/Bun 验收读取入口在 `src/node-runtime.ts`。

`mars-test` 不拥有 playground，只从 `playground/src/node-runtime.ts` 读取用例 fixture 做验收，避免测试包和可交互 playground 分叉。

功能模块用例统一登记在 `module-cases.json`，并通过 `loadPlaygroundModuleCases()` 读取。每条用例至少包含 Phase、模块名、playground 名称、入口文件、验收测试文件、状态和说明。

## 当前主流程架构

当前 playground 主流程从页面启动到 worker/module 执行按以下顺序串联:

1. Vite dev/preview 从 `127.0.0.1` 提供 React playground、`/@fs` 包源码和同源 `/mars-sw-scope-smoke.js`，并对页面与 SW 脚本统一输出 COOP/COEP/CORP headers。
2. React 首屏调用 `ensurePlaygroundRuntimeStatus()`，创建 `createMarsRuntime({ serviceWorkerUrl: "/mars-sw-scope-smoke.js", serviceWorkerScope: "/" })`，触发真实 `navigator.serviceWorker.register()`。
3. ServiceWorker 脚本创建独立 `MarsVFS`、`MarsKernel` 和 `ServiceWorkerRouter`，以 `bootPromise` hydrate 初始 VFS snapshot；`install` / `activate` / fetch event / MessageChannel RPC 都等待同一个 `bootPromise`，避免 top-level await 与初始化竞态。
4. `installServiceWorkerBootstrap()` 在 SW 内同时安装 fetch event handler 和 `sw.connect` message handler；页面侧 registration ready 后通过 transferred `MessagePort` 建立 client->SW bridge endpoint。
5. 页面或 playground case 通过 bridge 发送 `sw.fetch` 时，SW 调用 `ServiceWorkerRouter.fetch()`；虚拟 server 请求会经 `ServiceWorkerKernelClient` 分发到 Kernel port table，`/__mars__/module?path=...` 和 `/src/*.ts(x)` 源码请求会进入 ESM module response。
6. `ServiceWorkerRouter` 的 module response 使用 `@swc/wasm-web` ESM 输出，重写 static/dynamic import 到稳定的 `/__mars__/module?path=...` URL，并从 SW scope 内的 `MarsVFS` 读取源码；Vite host 的 `/@vite/client` 和缺失的宿主 `/src/*.ts(x)` 请求在 `fallback: 'network'` 下回到 Vite。
7. 页面侧 runtime 写文件已能通过 VFS watcher 自动 fanout 到 ServiceWorker bridge，并可用 `flushServiceWorkerVFS()` 等待 `sw.vfs.patch` 完成；Process Worker factory 也可绑定源 VFS，将写入/删除自动 fanout 为 `process.worker.vfs.patch`。
8. Kernel Worker / Process Worker 主链路目前已有 MessageChannel carrier、`kernel.connect`、`process.worker.boot`、`process.worker.stdin`、`process.worker.stdin.close`、stdio stdout/stderr 回传和 `bun run <entry>` 上下文注入；`kernel.spawn({ kind: "worker" })` 已能经 Kernel Worker controller 自动创建 Process Worker，并将 worker stdout/exit 回灌到 Kernel pid。完整 streaming backpressure 和 worker script bundling/loading 自动化仍是下一步。

稳定主入口是 `http://127.0.0.1:<port>/` 上的 Browser Runtime 面板和 runnable cases；模块加载稳定入口是 `/__mars__/module?path=...`，且 `/src/*.ts(x)` 原生源码 URL 首跳与 VFS `node_modules` bare import 二跳已能由 ServiceWorker module response 接管。完整 npm graph、Vite special paths 和完整浏览器 import graph 接管尚未完成。

## 运行方式

在 `mars-lib/playground` 目录执行:

```bash
bun install
bun run dev
```

Playground 需要浏览器 secure context 才能启用 `SharedArrayBuffer` 和 `navigator.serviceWorker`。默认 `dev` / `preview` 脚本绑定 `127.0.0.1`；请从 `http://127.0.0.1:<port>/` 打开页面，不要使用 `0.0.0.0`、局域网 IP、仓库根目录 dev server 或 `file://`。

Vite 会启动 React playground 页面。页面中的 `Run All` 会运行当前已接线的 runnable cases，包括 Phase 1 的 runtime/VFS/Shell、Bun file、Bun.serve、纯 node:http、Express app/router/middleware 和 Koa 洋葱中间件，Phase 2 的 resolver、transpiler、loader、runtime、installer、bundler-dev-server、TSX 和 Vite React TS 用例，以及 Phase 3 的 prework 用例；其中 bridge-chain 用例会跑通 client->SW、SW->Kernel bridge-backed server request、Kernel->Process Worker lifecycle、`process.worker.vfs.patch`、`process.worker.run` 和 `kernel.spawn(kind: "worker")` 自动 worker 创建/stdio/exit，ServiceWorker module response 用例会跑通 `/src/*.ts` 原生 URL 首跳、`/__mars__/module` ESM 入口、相对依赖二跳和 VFS `node_modules` bare import 二跳加载，Kernel Worker bootstrap 用例会跑通页面侧 `new Worker()` carrier 到 `kernel.connect` MessagePort，Process Worker runtime bootstrap 用例会验证 worker scope 内 Bun/process/require context 注入。

当前 `bun install` 是浏览器 runtime 内的最小实现: 读取 MarsVFS 中的 `package.json`，使用注入的 package cache 写入 `node_modules` 与 `mars-lock.json`；cache miss 时可通过 registry fetch provider 拉取 package metadata 和 tgz tarball，并支持 optionalDependencies 跳过语义、peerDependencies 自动安装与 range 冲突检测、optional peer 跳过、本地 workspace package 发现、`workspace:` 协议、`node_modules` workspace symlink、package/root `preinstall`/`install`/`postinstall` lifecycle scripts、`npm_lifecycle_*` / `npm_command` / `npm_package_json` / 扁平化 `npm_package_*` env、package `bin` 元数据、`node_modules/.bin` shim、lifecycle `PATH` 注入和 shebang JS binary 执行、基础 npm `.tgz`/PAX 解包、PAX path/linkpath、tar symlink、路径逃逸过滤、常见 semver range 最高满足版本选择、hyphen ranges、partial comparators、prerelease opt-in 语义、build metadata 解析和冲突 transitive dependency 的嵌套 `node_modules` 安装。它还不是完整 Bun package manager；Bun lockfile、npm 的更多边缘 script env 和更高级 npm semver range 语法仍待补。当前 npm-cache fixture 中的官方 `express@5.1.0` / `koa@2.14.2` 可安装、可运行，会通过 `http` / `node:http` 创建虚拟服务。

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
| 剩余缺口 | Phase 验收范围内的 partial/prework 必须在 Phase todo 中明确，且不得作为 Done 依据；超出当前 Phase 的生产级 hardening 必须在 audit/backlog 中明确边界。 |