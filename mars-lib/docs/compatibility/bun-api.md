# Bun API 兼容矩阵

- 状态: Draft
- 日期: 2026-04-28
- 数据来源: `packages/mars-runtime/src/compat-matrix.ts`
- 阶段说明: Phase 2 已完成工程化验收闭环；本矩阵中的 Phase 3 API 仍属于预研切片，需等待明确进入 Phase 3 后继续扩展。

## 状态说明

| 状态 | 含义 |
| --- | --- |
| supported | 验收路径已覆盖，行为目标接近 Bun 常见用法。 |
| partial | 可用于当前验收路径，但还有明确兼容缺口。 |
| unsupported | 当前不可用，调用应失败或不暴露。 |
| planned | 已纳入路线图，尚未实现。 |

## 当前矩阵

| API | 状态 | Phase | 当前说明 | 验收覆盖 |
| --- | --- | --- | --- | --- |
| `Bun.file` | partial | M1 | 基于 MarsVFS 支持 text/json/arrayBuffer/stream；native 文件元数据完整兼容待补。 | Phase 1 Bun.file/Bun.write 验收 |
| `Bun.write` | partial | M1 | 支持将 string、Blob、Response、Request、Uint8Array 兼容输入写入 MarsVFS。 | Phase 1 Bun.file/Bun.write 验收 |
| `Bun.serve` | partial | M1 | 支持虚拟 HTTP server 注册、`listen(0)` 风格动态端口与 fetch 分发；WebSocket upgrade 待补。 | Phase 1 Bun.serve 验收 |
| `node:http` | partial | M1 | 覆盖 `createServer()`、`listen()`、`listen(0)`、`address()`、`close()`、IncomingMessage 请求元数据/body 访问和 ServerResponse `writeHead()`/`write()`/`end()`；Express app/router/middleware 与 Koa async middleware playground 已接入。`node:http` 直接注册 MarsKernel 虚拟端口，不基于 `Bun.serve()` 包装；二者共享 port table 与 dispatch 路径。streaming 与 upgrade 完整兼容待补。 | Phase 1 node:http 验收 |
| `MarsRuntime.run` | partial | M2 | 支持 TS/TSX entry 经 resolver、`@swc/wasm-web` transpiler 和 loader 执行，并将 console stdout/stderr 映射到 ProcessHandle streams；完整 worker 进程隔离待补。 | Phase 2 runtime.run 验收 |
| `bun install` | partial | M2 | Shell 命令 `bun install` 已能从 MarsVFS `package.json` 读取 dependencies/devDependencies，并通过 MarsInstaller 写入 `node_modules` 和 `mars-lock.json`。cache miss 时可通过注入的 registry client 拉取 package metadata 与 tarball bytes，并支持基础 npm `.tgz` 解包到 package files；lifecycle scripts、workspaces、完整 semver 和 Bun lockfile 完整兼容待补。当前 Express/Koa playground 使用内置 app 形态 fixture，不依赖真实 npm `express`/`koa` 包。 | Phase 2 shell bun install / registry fetch / tgz extract 验收 |
| `Bun.build` | partial | M3 | 支持单/多 entry 经 `esbuild-wasm` transform 后输出到 MarsVFS，并可在 `sourcemap: true` 时写出 `.js.map` artifact；完整依赖 bundling、splitting、plugin pipeline 待补。 | Phase 3 Bun.build 验收 |
| `bun run` | partial | M3 | `MarsShell` 已能将 `bun run <entry>` 分发到当前内存态 Kernel pid 与 `runEntryScript` 路径；Process Worker 隔离和真实 ServiceWorker 模块拦截待补。 | Phase 3 bun run 验收 |
| `Bun.spawn` | partial | M3 | `Bun.spawn({ cmd })` 与 `runtime.spawn()` 已能执行 `bun run <entry>` 并进入当前内存态 Kernel pid；通用命令执行、Process Worker 隔离和 streaming stdin 待补。 | Phase 3 Bun.spawn 验收 |
| `Bun.spawnSync` | partial | M3 | 当前 async 浏览器 profile 返回明确 unsupported fallback result；SAB 同步执行路径待补。 | Phase 3 spawnSync fallback 验收 |
| `Bun.CryptoHasher` | partial | M3 | 基于 WebCrypto 覆盖 sha1/sha256/sha512 async digest，并提供 Mars md5 fallback；Bun 同步 digest 兼容待补。 | Phase 3 CryptoHasher 验收 |
| `Bun.password` | partial | M3 | 基于 WebCrypto PBKDF2-SHA256 覆盖 hash/verify fallback；Bun bcrypt/argon2 兼容待补。 | Phase 3 Bun.password 验收 |
| `node:crypto` | partial | M3 | 覆盖 randomUUID、randomBytes、sha/md5 async createHash digest 与 async createHmac digest；完整 Node 同步 Hash/Hmac 语义待补。 | Phase 3 node:crypto 验收 |
| `Bun.sql` | partial | M3 | MarsVFS-backed sqlite prework 覆盖 create/insert/select/count/update/delete 和 tagged query；原生 sqlite WASM 兼容待补。 | Phase 3 Bun.sql 验收 |

## 当前执行拓扑

主流程按运行时边界可以分为页面 host、ServiceWorker scope、Kernel/Process Worker 和 VFS/module graph 四层:

1. 页面 host 由 Vite 在 `127.0.0.1` 提供，统一输出 COOP/COEP/CORP headers；React playground 首屏展示 secure context、SAB、ServiceWorker registration、active state 与 controller 状态。
2. `createMarsRuntime({ serviceWorkerUrl })` 负责注册同源 module ServiceWorker，等待 `registration.ready`，再用 MessageChannel 发送 `sw.connect`，建立 client->SW bridge。
3. ServiceWorker 脚本创建 `MarsVFS`、`MarsKernel` 与 `ServiceWorkerRouter`；初始化不使用 top-level await，而是以 `bootPromise` hydrate snapshot，并让 install/activate/fetch/RPC 全部等待它。
4. SW fetch event 和 `sw.fetch` RPC 共用 `ServiceWorkerRouter`：虚拟端口请求转发到 Kernel，VFS asset 从 MarsVFS 读取，`/__mars__/module?path=...` 与存在于 MarsVFS 的 `/src/*.ts(x)` 源码请求生成浏览器 ESM response；Vite host 的 `/@vite/client` 和缺失的宿主源码请求在 `fallback: 'network'` 下回到网络。
5. ESM response 由 SWC 输出原生 import/export，并将依赖重写成稳定 module URL；依赖模块二跳加载继续回到同一个 SW module route。
6. 文件更新已具备自动 fanout 切片：页面侧 runtime 的 VFS watcher 会把写入转换为 `sw.vfs.patch` 并发送到 ServiceWorker bridge，`flushServiceWorkerVFS()` 可等待同步完成；Process Worker factory 也可绑定源 VFS，将写入/删除自动转换为 `process.worker.vfs.patch`。
7. Kernel Worker 与 Process Worker 已有 MessageChannel/native Worker carrier：页面发送 `kernel.connect`，Kernel controller 管理 `process.worker.create/message/terminate`，Process Worker bootstrap 注入 `Bun` / `process` / `require` 并把 stdout/stderr/exit 回传。
8. `kernel.spawn({ kind: "worker" })` 已能在 Kernel Worker controller 内自动创建 Process Worker，并把 worker stdout/stderr/exit 映射回 Kernel pid；当前尚未自动完成的是完整 npm graph/Vite special paths 的 SW 接管，以及 worker script bundling/loading 自动化。

已串联:

1. `createMarsRuntime()` 创建 MarsVFS、内存态 MarsKernel、MarsShell、Bun facade 和 `ServiceWorkerRouter`
2. `MarsRuntime.boot()` 启动内存态 Kernel，并把 `Bun` / `process` 安装到当前 `globalThis`
3. `MarsRuntime.run(entry)` 通过 Kernel 创建虚拟 pid，再调用 `runEntryScript()` 读取、转译并执行 entry
4. `MarsShell` 已注册 `bun` 命令，`bun run index.ts` 会进入同一条 Kernel pid、SWC WASM transpiler、loader/evaluator 和 stdio bridge 路径
5. `runtime.spawn("bun", ["run", "index.ts"])` 和 `Bun.spawn({ cmd: ["bun", "run", "index.ts"] })` 已复用上述脚本执行路径
6. Kernel `ProcessHandle` 已有 stdin readable、stdout/stderr readable 和可选 WritableStream mirror，`write()` 可向 stdin 写入
7. `createMarsProcessWorkerFactory()` 已有受控 worker boot/message/terminate 生命周期；无 worker URL 时走 in-memory fallback，有 worker URL 时可通过 `new Worker()` 承载并使用 `process.worker.boot/message/stdin/stdout/stderr/exit/terminate` 协议
8. `runtime.fetch(previewUrl)` 手动进入 `ServiceWorkerRouter`，再按虚拟端口转发到 Kernel port table
9. `createMarsMemoryBridgePair()`、`createMarsPostMessageBridgeTransport()`、`createServiceWorkerBridgeController()` 和 `createKernelWorkerController()` 已能用统一 bridge 协议跑通 client->SW fetch、SW->Kernel `server.request`、MessageChannel Kernel RPC 与 Kernel->Process Worker boot/message/terminate 的可测试链路
10. `installServiceWorkerFetchHandler()` 已提供 ServiceWorker `fetch` event 风格的 `respondWith(router.fetch(request))` 安装路径，验收覆盖 fetch event -> SW router -> Kernel bridge -> VirtualServer
11. `createMarsRuntime({ serviceWorkerUrl })` 已接入 `navigator.serviceWorker.register()` 抽象、`ready` 等待、client->SW MessageChannel 握手和可选 dispose unregister 生命周期，验收与 playground 使用可注入 ServiceWorkerContainer 覆盖
12. `installServiceWorkerBootstrap()` 已提供 SW script bootstrap 入口，可监听 `sw.connect` message、接管 transferred `MessagePort`、安装 client bridge controller，并与 fetch event handler 共用同一个 router
13. `installKernelWorkerBootstrap()` 已提供 Kernel Worker bootstrap 入口，可监听 `kernel.connect` message、接管 transferred `MessagePort`、安装 Kernel Worker controller，并响应该端口上的 `kernel.boot`、Process Worker lifecycle、`process.worker.vfs.patch` 与 `process.worker.run` RPC
14. `connectMarsKernelWorker()` 已提供页面侧 Kernel Worker native carrier，可用 `new Worker()` 创建 worker、传递 MessagePort、发送 `kernel.connect`，并通过 client endpoint 承载 `kernel.boot`、Process Worker lifecycle、VFS patch 与 run RPC
15. `ServiceWorkerRouter` 已能拦截 `/__mars__/module` 和 `/src/*.ts(x)` 源码 URL，通过 `createModuleResponse({ format: "esm" })` 返回浏览器可加载的 ESM，并将入口 relative import、dynamic import 与首个 VFS `node_modules` bare import 重写到稳定 module URL 以支持依赖二跳加载
16. `installProcessWorkerRuntimeBootstrap()` 已提供 Process Worker script bootstrap，可接收 `process.worker.boot`，按 Bun 风格 argv/cwd/env context 注入 `Bun`、`process`、`require`，并执行 `bun run <entry>` 后把 console stdout/stderr 与 exit code 回传到 native carrier 协议
17. `createProcessWorkerBootstrapScript()` / `createProcessWorkerBootstrapBlobURL()` 已能生成 module Worker bootstrap source 和 Blob URL，作为真实 `workerURL` 打包加载自动化的前置
18. Playground 已接入首个真实浏览器 Worker smoke：通过 Blob module URL 创建原生 `Worker`，worker 内使用 Vite `/@fs` import URL 加载 `@mars/runtime`/`@mars/vfs`/`@mars/kernel`，并验证 `bun run <entry>` stdout 与 exit 回传
19. Playground 已接入真实 ServiceWorker scope smoke 和页面级 host runtime：Vite dev/preview 同源提供 `/mars-sw-scope-smoke.js` module script，并输出 COOP/COEP/CORP headers 让页面进入 `crossOriginIsolated`、启用 `SharedArrayBuffer`；React UI 加载后会注册真实 `navigator.serviceWorker` 并显示 SAB/SW ready 状态，smoke 用例通过 MessageChannel `sw.fetch` 验证 SW scope 内 `/__mars__/module` ESM 响应
20. VFS snapshot 已参与跨上下文启动态同步：Process Worker bootstrap script 可内联 serialized snapshot 并在安装 runtime 前 restore，ServiceWorker scope smoke 也通过 serialized snapshot hydrate `/workspace` module graph
21. VFS patch 已参与 Process Worker 运行期同步：页面侧和 Kernel Worker bridge 均可发送 `process.worker.vfs.patch`，worker scope 应用增量 write/delete patch 后通过 `process.worker.run` 显式执行更新后的 entry；Process Worker factory 也可绑定源 VFS 并自动 fanout write/delete patch
22. VFS patch 已参与 ServiceWorker 运行期同步：页面侧可发送 `sw.vfs.patch`，SW scope 应用增量 write/delete patch 后通过 `sw.fetch` 返回更新后的 `/__mars__/module` ESM 响应
23. `kernel.spawn({ kind: "worker" })` 已接入 Process Worker factory：Kernel Worker RPC 可自动创建 Worker、返回 worker id、把 stdout/stderr 写回 Kernel stdio，并在 worker exit 后 resolve `waitpid`
24. `MarsRuntime` 已接入 ServiceWorker VFS 自动 fanout：`Bun.write()` / `vfs.writeFile()` 会经 watcher 生成 JSON-safe write/delete patch，发送到 `sw.vfs.patch`，并可通过 `flushServiceWorkerVFS()` 等待 bridge patch 完成
25. `MarsProcessWorkerFactory` 已接入 Process Worker VFS 自动 fanout：factory 绑定源 VFS 后，新 worker 会监听同一 sync root，把 write/delete 转换为 `process.worker.vfs.patch` 并同步到 worker scope

未串联:

1. ServiceWorker registration、SW script bootstrap、真实 scope smoke、SW scope 增量 VFS patch、源码 URL 首跳、VFS `node_modules` bare import 二跳、Vite host network fallback 和 playground host SAB/SW 状态面板已接入；完整浏览器 fetch event 接管、完整 npm graph 和 Vite special path 自动化仍待补
2. Kernel Worker native carrier 已有页面侧 `new Worker()` 与 MessagePort 握手抽象；Process Worker bootstrap script source/Blob URL、snapshot restore、增量 VFS patch、factory VFS 自动 fanout 与真实浏览器 Worker smoke 已接入
3. Process Worker native carrier、runtime bootstrap、stdio protocol 与 `kernel.spawn({ kind: "worker" })` 已串联；worker script bundling/loading 自动化待补
4. 浏览器原生 `/src/*.ts(x)` 模块请求已可通过 ServiceWorker module response 完成首跳，VFS `node_modules` bare import 已可重写为 `/__mars__/module?path=...` 二跳；完整 npm graph、Vite special paths 和完整浏览器 import graph 接管仍待补
5. ServiceWorker ESM module response 已与 loader/evaluator 的 CommonJS 执行模型拆分，且 playground smoke 覆盖 `/src/*.ts` 首跳；Vite special path 自动化仍待补

## 当前转译运行路径

已支持:

1. 默认通过 `@swc/wasm-web` 转译 `.ts` / `.tsx` / `.jsx`
2. SWC WASM 初始化由 `@mars/shared` 的 `createWasmLoader()` 管理，覆盖并发复用、ready 状态和失败后重试
3. SWC CommonJS 输出接入 Mars loader/evaluator，用于 static import、export 和 TS 类型剥离
4. SWC ESM 输出可用于 ServiceWorker module response，保留浏览器原生 import/export，并由 `@mars/sw` 重写依赖 specifier 到 `/__mars__/module?path=...`
5. classic JSX pragma 输出到 Mars `__mars_jsx` helper，支撑 TSX playground first screen render model
6. string-literal dynamic import 在 CommonJS 执行路径下降级到 `__mars_dynamic_import()` 并接入 loader cache；ESM module response 保留 native dynamic import 后再重写 specifier
7. `BasicTranspiler` 仅作为 wasm 初始化失败和同步 `require()` 尚未 ready 时的 fallback，并支持 ServiceWorker ESM response 的轻量 TS/JSX fallback
8. playground 用例 `core-modules/transpiler/app.tsx`、`tsx/app.tsx`、`vite-react-ts/src/App.tsx` 和 `core-modules/runtime/service-worker-module-response.ts` 已纳入验收

暂未支持:

1. 完整 ESM live binding 和循环依赖语义
2. source map 消费与文件映射
3. React automatic runtime 细节
4. worker 侧 SWC 缓存与跨会话复用

## 当前 `Bun.build` 范围

已支持:

1. `entrypoints`
2. `outfile` / `outdir`
3. `format: "esm" | "cjs" | "iife"` 的 esbuild 输出格式
4. `target`
5. `define`
6. `sourcemap: true` 透传给 esbuild transform，并写出外部 `.js.map` artifact
7. 输出目录自动创建
8. 输出 artifact 的 `text()` / `arrayBuffer()`
9. 通过统一 playground fixture 构建 `playground/vite-react-ts/src/App.tsx`
10. 通过 `@mars/shared` 管理 `esbuild-wasm` 初始化，浏览器构建使用 wasm asset URL

暂未支持:

1. 依赖图打包与代码合并
2. code splitting
3. tree shaking
4. minify
5. external
6. loader map
7. 插件 pipeline
8. CSS / asset 输出

## 当前 crypto 范围

已支持:

1. `Bun.CryptoHasher` facade 暴露 `MarsCryptoHasher`
2. `MarsCryptoHasher("md5" | "sha1" | "sha256" | "sha512")`
3. `update(string | ArrayBuffer | ArrayBufferView)`
4. `digest("hex" | "base64" | "base64url" | "buffer")`，当前为 async WebCrypto-backed API
5. `node:crypto` 子集: `randomUUID()`、`randomBytes(size)`、`createHash(algorithm).update(input).digest(encoding)`、`createHmac(algorithm, key).update(input).digest(encoding)`
6. `Bun.password.hash()` / `verify()` 的 WebCrypto PBKDF2-SHA256 fallback

暂未支持:

1. Bun/Node 完全同步的 Hash digest 语义
2. 同步 HMAC、sign/verify、cipher、key object、secure heap 等完整 `node:crypto` API
3. Bun `Bun.password` 的 bcrypt/argon2 格式兼容与 cost 参数完整映射

## 当前 sqlite 范围

已支持:

1. `Bun.sql` facade 暴露默认 MarsVFS-backed sqlite prework database
2. `Bun.sql.db.exec()` / `run()` / `all()` / `get()`
3. `Bun.sql.open(path)` 可在 MarsVFS 指定 JSON-backed database 文件
4. tagged query `Bun.sql\`select ... where id = ${value}\`` 会把插值转换为 `?` 参数
5. 当前 SQL 子集覆盖 `create table if not exists`、`insert into`、`select`、`count(*) as`、单条件 `where`、`order by`、`update`、`delete`
6. database state 会持久化到 MarsVFS，可通过 reopen 读取

暂未支持:

1. 原生 sqlite WASM 引擎
2. SQL parser 完整语法、事务、索引、约束、join、聚合函数
3. Bun sqlite 参数类型与同步 API 完整兼容
4. OPFS-backed sqlite 文件锁和多 worker 并发写入

## 当前 VFS snapshot 范围

已支持:

1. `MarsVFS.snapshot(path)` 读取内存层 FileTree
2. `snapshotVFS()` 将 FileTree 序列化为 JSON-safe base64 tree
3. `restoreVFSSnapshot()` 将序列化 tree 恢复到目标 root
4. `createOPFSPersistenceAdapter()` 支持 browser OPFS `navigator.storage.getDirectory()`，并在无 OPFS 环境提供 memory fallback
5. `createWriteFilePatch()` / `createDeleteFilePatch()` 可生成 JSON-safe 增量 patch，并由 Process Worker 与 ServiceWorker bridge 在运行期应用
6. Phase 3 验收覆盖 workspace 文件跨 runtime restore、Process Worker patch 后 run、ServiceWorker patch 后 module fetch 与 adapter open/get/set/delete/keys/close

暂未支持:

1. 真实浏览器 profile 下的 OPFS 自动化矩阵
2. 自动增量 snapshot/diff 与文件 watcher fanout
3. 文件元数据、权限、mtime/ctime 完整持久化

## 当前浏览器能力 profile

已支持:

1. `detectMarsCapabilities()` 检测 ServiceWorker、SharedArrayBuffer、Atomics.wait、OPFS、WebCrypto、Worker
2. `createBrowserTestProfiles()` 生成 async fallback、SAB worker、OPFS persistence、ServiceWorker module profile
3. 当前 Phase 3 测试覆盖 profile 生成逻辑，不假设本机浏览器能力固定开启