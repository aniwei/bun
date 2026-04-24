# Bun-in-Browser 模块 API 设计文档

| 字段 | 值 |
| --- | --- |
| 状态 | Draft |
| 版本 | v1 (2026-04-24) |
| 关联 RFC | [bun-in-browser-webcontainer.md](./bun-in-browser-webcontainer.md) |
| 关联实施计划 | [bun-in-browser-webcontainer-implementation-plan.md](./bun-in-browser-webcontainer-implementation-plan.md) |
| 目标 | 为每个 packages/ 模块给出文件命名、核心类名与公开 API 签名 |

> 本文档是实施前的接口契约。每次开始某阶段编码前，对应模块的类名/方法签名须已在此文档中冻结。
> 实施时以本文档为准；发现需变更时先修改本文档并在 PR 中注明理由，再同步修改实施计划。

---

## 命名规范

### 代码风格与质量门禁（Oxc）

- 风格参考：https://github.com/cgoinglove/better-chatbot/（仅参考风格原则，不复制实现代码）
- TypeScript 代码默认使用单引号，尽量不使用双引号
- 默认不写分号，由工具链在必要处自动补齐
- 复杂逻辑按语义分段，尽量保持空行分隔，避免多条语句挤在一行
- 保持一条语句一行，避免链式调用过长

建议本地检查顺序：

```sh
# 1) 格式化（若环境提供 oxfmt）
bunx oxfmt "packages/bun-web-*/src/**/*.{ts,tsx}"

# 2) lint（必须通过）
bunx oxlint "packages/bun-web-*/src/**/*.{ts,tsx}" --fix
```

若当前环境未提供 oxfmt，则至少执行 oxlint 并保证零错误。

### 文件命名

- 全部 `kebab-case`，与 RFC §10 包名风格一致。
- 入口文件统一命名为 `index.ts`，对外导出公开 API。
- 实现文件按职责单词命名，如 `overlay-fs.ts`、`syscall-bridge.ts`。
- 类型声明文件统一后缀 `.types.ts`，可被跨包引用。

### 类命名

- `PascalCase`，与所属包功能对应，如 `KernelProcess`、`OverlayFS`。
- 单例类（全局唯一）加 `Manager` 或 `Registry` 后缀，如 `ProcessManager`、`CompatRegistry`。
- 错误类统一后缀 `Error`，继承 `BunWebError`，如 `SyscallError`、`VFSNotFoundError`。
- 内部实现类加 `_` 前缀或放入 `internal/` 子目录，不在 `index.ts` 导出。

### 错误码约定

D 级 API 的存根调用统一抛出：

```ts
throw new BunWebUnsupportedError('Bun.udpSocket', {
  code: 'ERR_BUN_WEB_UNSUPPORTED',
  level: 'D',
});
```

---

## 包依赖关系（顶层）

```
bun-web-client
  └─ bun-web-runtime
       ├─ bun-web-kernel  ←→  bun-web-vfs
       │    └─ (SAB Bridge)
       ├─ bun-web-resolver
       ├─ bun-web-transpiler
       ├─ bun-web-node
       │    └─ bun-web-webapis
       ├─ bun-web-net
       │    └─ bun-web-dns
       ├─ bun-web-shell
       │    └─ bun-web-shell-builtins
       ├─ bun-web-bundler
       │    └─ bun-web-transpiler
       ├─ bun-web-test
       ├─ bun-web-sqlite
       └─ bun-web-crypto
bun-web-sw  (独立 Worker 上下文，不 import runtime)
bun-web-hooks  ←  bun-web-plugin-api
bun-web-compat-registry  ←  所有包（注册时依赖）
bun-web-agent  ←  bun-web-shell + bun-web-runtime
bun-web-proxy-server  (可选独立服务端，Node/Deno/Bun 运行)
bun-web-installer  ←  bun-web-vfs + bun-web-resolver
```

---

## 1. `bun-web-kernel`

> 实施计划：M1-1, M1-2, M1-7 | RFC §1（Kernel Worker）、§3（SAB Bridge）、§13（iOS fallback）

### 文件结构

```
packages/bun-web-kernel/
  src/
    index.ts            # 公开导出
    kernel.ts           # Kernel 主类
    process-table.ts    # 进程表
    scheduler.ts        # 调度器
    signal.ts           # 信号系统
    pipe.ts             # stdio 管道
    syscall-bridge.ts   # SAB 请求/响应队列
    syscall-handler.ts  # Kernel 侧 syscall 处理分发
    async-fallback.ts   # iOS Safari / 无 SAB 降级模式
    errors.ts           # 内核错误类
    kernel.types.ts     # 跨包类型定义
```

### 核心类设计

```ts
// kernel.types.ts
export type Pid = number;
export type Fd = number;

export interface KernelConfig {
  maxProcesses?: number;       // 默认 32
  sabSize?: number;            // SAB 缓冲区大小，默认 4MB
  asyncFallback?: boolean;     // 无 SAB 时强制 async 模式
  tunnelUrl?: string;          // TCP/TLS 隧道服务端地址（RFC §5.4）
}

export interface ProcessDescriptor {
  pid: Pid;
  cwd: string;
  env: Record<string, string>;
  argv: string[];
  stdio: { stdin: Fd; stdout: Fd; stderr: Fd };
  status: 'running' | 'exited' | 'zombie';
  exitCode: number | null;
  port: MessagePort;           // 与 Process Worker 通信
}

// kernel.ts
export class Kernel {
  static readonly instance: Kernel;

  static async boot(config?: KernelConfig): Promise<Kernel>;
  static shutdown(): Promise<void>;

  get processes(): ProcessTable;
  get vfs(): import('../bun-web-vfs').VFS;
  get syscallBridge(): SyscallBridge;

  spawn(opts: SpawnOptions): Promise<ProcessDescriptor>;
  kill(pid: Pid, signal?: number): void;
  waitpid(pid: Pid): Promise<number>;            // exit code

  // 端口表（供 Bun.serve 注册）
  registerPort(pid: Pid, port: number): void;
  unregisterPort(port: number): void;
  resolvePort(port: number): Pid | null;
}

// process-table.ts
export class ProcessTable {
  get(pid: Pid): ProcessDescriptor | undefined;
  add(desc: ProcessDescriptor): void;
  remove(pid: Pid): void;
  list(): ProcessDescriptor[];
}

// syscall-bridge.ts
export const SYSCALL_OP = {
  FS_READ:        0x01,
  FS_WRITE:       0x02,
  FS_STAT:        0x03,
  FS_READDIR:     0x04,
  FS_MKDIR:       0x05,
  FS_UNLINK:      0x06,
  FS_RENAME:      0x07,
  FS_WATCH:       0x08,
  NET_CONNECT:    0x20,
  NET_LISTEN:     0x21,
  PROCESS_SPAWN:  0x30,
  PROCESS_WAIT:   0x31,
} as const;

export type SyscallOp = typeof SYSCALL_OP[keyof typeof SYSCALL_OP];

export interface SyscallRequest {
  op: SyscallOp;
  seq: number;          // 递增序号，用于匹配响应
  payload: Uint8Array;  // CBOR/MessagePack 编码
}

export interface SyscallResponse {
  seq: number;
  ok: boolean;
  payload: Uint8Array;
  errorCode?: number;
}

/** Process Worker 侧：发起同步 syscall */
export class SyscallBridge {
  constructor(sab: SharedArrayBuffer);

  /** 同步阻塞调用（Atomics.wait），需在 Worker 内使用 */
  callSync(op: SyscallOp, payload: Uint8Array): SyscallResponse;

  /** 异步调用（iOS fallback / 主线程） */
  callAsync(op: SyscallOp, payload: Uint8Array): Promise<SyscallResponse>;

  readonly isAsync: boolean;   // true = iOS/无 SAB 降级模式
}

// async-fallback.ts
export function detectSABSupport(): boolean;
export function createBridge(port: MessagePort): SyscallBridge;
```

---

## 2. `bun-web-vfs`

> 实施计划：M1-3, M1-4, M3-5 | RFC §2（三层 VFS）

### 文件结构

```
packages/bun-web-vfs/
  src/
    index.ts
    overlay-fs.ts       # 三层叠加 OverlayFS 主类
    base-layer.ts       # 只读 CDN 快照层
    persist-layer.ts    # OPFS 持久层
    mem-layer.ts        # 内存层（/tmp /proc /dev）
    opfs-adapter.ts     # OPFS SyncAccessHandle 封装
    watch-bus.ts        # fs.watch 事件总线（BroadcastChannel）
    cache-store.ts      # 包缓存（IndexedDB + OPFS）
    stat.ts             # FileStat 类型
    errors.ts
    vfs.types.ts
```

### 核心类设计

```ts
// vfs.types.ts
export interface FileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtime: Date;
  atime: Date;
  ctime: Date;
  mode: number;
  uid: number;
  gid: number;
}

export interface Dirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface VFSReadOptions {
  encoding?: BufferEncoding | null;
  flag?: string;
}

// overlay-fs.ts
export class VFS {
  constructor(opts: { base: BaseLayer; persist: PersistLayer; mem: MemLayer });

  // 同步 API（在 Kernel Worker 内直接调用；在 Process Worker 内通过 SAB 桥接）
  readFileSync(path: string, opts?: VFSReadOptions): Buffer | string;
  writeFileSync(path: string, data: Buffer | string): void;
  statSync(path: string): FileStat;
  readdirSync(path: string, opts?: { withFileTypes?: boolean }): string[] | Dirent[];
  mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  unlinkSync(path: string): void;
  renameSync(oldPath: string, newPath: string): void;
  existsSync(path: string): boolean;

  // 异步 API
  readFile(path: string, opts?: VFSReadOptions): Promise<Buffer | string>;
  writeFile(path: string, data: Buffer | string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;

  // watch
  watch(path: string, listener: WatchListener): WatchHandle;

  // 层管理
  readonly layers: { base: BaseLayer; persist: PersistLayer; mem: MemLayer };
}

// opfs-adapter.ts
export class OPFSAdapter {
  static async open(root?: string): Promise<OPFSAdapter>;
  readSync(path: string): Uint8Array;
  writeSync(path: string, data: Uint8Array): void;
  unlinkSync(path: string): void;
  readdirSync(path: string): string[];
  mkdirSync(path: string): void;
}

// watch-bus.ts
export type WatchListener = (event: 'change' | 'rename', filename: string) => void;
export interface WatchHandle { close(): void; }

export class WatchBus {
  subscribe(path: string, listener: WatchListener): WatchHandle;
  emit(path: string, event: 'change' | 'rename'): void;
}

// cache-store.ts
export class PackageCacheStore {
  static async open(): Promise<PackageCacheStore>;
  has(key: string): Promise<boolean>;
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, data: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}
```

---

## 3. `bun-web-runtime`

> 实施计划：M1-5, M4-2, M5-3, M8-5 | RFC §1（Process Worker）、§8.1（Bun.* API）

### 文件结构

```
packages/bun-web-runtime/
  src/
    index.ts
    process-bootstrap.ts   # Process Worker 入口，Bun 全局注入
    bun-globals.ts         # Bun.version/env/argv/cwd 等常量注入
    serve.ts               # Bun.serve() 实现
    spawn.ts               # Bun.spawn / Bun.spawnSync
    file.ts                # Bun.file / Bun.write
    sleep.ts               # Bun.sleep / Bun.sleepSync
    inspect.ts             # Bun.inspect / Bun.deepEquals 等纯逻辑
    hash.ts                # Bun.hash.wyhash/xxHash64 等
    glob.ts                # Bun.Glob
    semver.ts              # Bun.semver.*
    color.ts               # Bun.color
    string-width.ts        # Bun.stringWidth
    toml-yaml.ts           # Bun.TOML / Bun.YAML
    s3-sql-redis.ts        # Bun.S3Client / Bun.SQL / Bun.redis（C/D级存根）
    open-in-editor.ts      # Bun.openInEditor（D级，emit 事件）
    memory-gc.ts           # Blob URL LRU / 句柄回收
    module-registry.ts     # ModuleRegistry（ESM/CJS 加载）
    runtime.types.ts
```

### 核心类设计

```ts
// process-bootstrap.ts
export interface ProcessBootstrapOptions {
  kernel: import('../bun-web-kernel').Kernel;
  pid: number;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  sabBuffer: SharedArrayBuffer | null;  // null = async fallback
}

export async function bootstrapProcessWorker(opts: ProcessBootstrapOptions): Promise<void>;
// 在 Process Worker 顶层调用，注入全局 Bun / process / require 等

// serve.ts
export interface ServeOptions<T = unknown> {
  port?: number;             // 0 = 内核分配虚拟端口
  hostname?: string;
  fetch(req: Request, server: Server): Response | Promise<Response>;
  websocket?: WebSocketHandler<T>;
  error?(err: Error): Response | Promise<Response>;
  tls?: ServeOptionsT['tls'];   // C级，降级时忽略
  reusePort?: boolean;          // 浏览器中忽略
}

export interface Server {
  readonly port: number;
  readonly url: URL;
  stop(closeActiveConnections?: boolean): Promise<void>;
  reload(opts: Partial<ServeOptions>): void;
  publish(topic: string, data: string | Uint8Array): void;
  ref(): void;
  unref(): void;
}

export function serve<T = unknown>(opts: ServeOptions<T>): Server;

// spawn.ts
export interface SpawnOptions {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: 'pipe' | 'inherit' | 'ignore' | Blob | ReadableStream;
  stdout?: 'pipe' | 'inherit' | 'ignore';
  stderr?: 'pipe' | 'inherit' | 'ignore';
  onExit?(proc: ChildProcess, exitCode: number, signal: number | null): void;
}

export interface ChildProcess {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array> | null;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: number): void;
  ref(): void;
  unref(): void;
}

export function spawn(opts: SpawnOptions): ChildProcess;
export function spawnSync(opts: SpawnOptions): SyncSubprocess;

// module-registry.ts
export class ModuleRegistry {
  // ESM 模块：转译后注册为 Blob URL
  registerESM(specifier: string, source: string): Promise<string>;   // → Blob URL
  // CJS 模块：new Function 沙箱
  registerCJS(specifier: string, source: string): CJSModule;
  // 解析已注册模块
  resolve(specifier: string, fromFile?: string): string | null;
  // 注销（用于 HMR）
  invalidate(specifier: string): void;
}

// memory-gc.ts
export class BlobURLPool {
  register(url: string, sizeHint?: number): void;
  release(url: string): void;
  gc(maxBytes?: number): void;     // LRU 驱逐
  readonly stats: { count: number; totalBytes: number };
}
```

---

## 4. `bun-web-vfs` → `bun-web-kernel` 内 `syscall-handler.ts`

（Kernel 侧：处理来自 Process Worker 的 syscall 请求，分发到 VFS / 进程表）

```ts
// syscall-handler.ts
export class SyscallHandler {
  constructor(vfs: VFS, kernel: Kernel);

  handle(req: SyscallRequest): SyscallResponse;

  private handleFsRead(payload: Uint8Array): SyscallResponse;
  private handleFsWrite(payload: Uint8Array): SyscallResponse;
  private handleFsStat(payload: Uint8Array): SyscallResponse;
  private handleProcessSpawn(payload: Uint8Array): SyscallResponse;
  // ...
}
```

---

## 5. `bun-web-resolver`

> 实施计划：M2-1, M2-2 | RFC §4.1（Resolver）

### 文件结构

```
packages/bun-web-resolver/
  src/
    index.ts
    resolve.ts           # 主解析入口
    conditions.ts        # exports/imports/conditions 解析
    tsconfig-paths.ts    # tsconfig paths/baseUrl
    extension-map.ts     # .ts↔.js / .tsx↔.jsx 映射
    package-json.ts      # package.json 缓存读取
    resolver.types.ts
```

### 核心类设计

```ts
// resolver.types.ts
export interface ResolveOptions {
  conditions?: string[];    // 默认 ['browser', 'bun', 'import', 'require']
  extensions?: string[];    // 默认 ['.ts','.tsx','.js','.jsx','.json']
  tsconfig?: TsConfigPaths;
  vfs: import('../bun-web-vfs').VFS;
  cwd?: string;
}

export interface ResolveResult {
  path: string;             // 绝对路径
  type: 'esm' | 'cjs' | 'builtin' | 'data';
  sideEffects: boolean;
}

// resolve.ts
export class Resolver {
  constructor(opts: ResolveOptions);

  resolve(specifier: string, fromFile: string): ResolveResult;
  resolveAsync(specifier: string, fromFile: string): Promise<ResolveResult>;

  // 批量预解析（bundler 用）
  resolveAll(specifiers: string[], fromFile: string): ResolveResult[];
}

// tsconfig-paths.ts
export interface TsConfigPaths {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

export function loadTsConfig(vfs: VFS, cwd: string): TsConfigPaths;
export function resolveTsPath(
  specifier: string,
  tsconfig: TsConfigPaths,
  baseDir: string,
): string | null;
```

---

## 6. `bun-web-transpiler`

> 实施计划：M6-1 | RFC §4.2（Transpiler）

### 文件结构

```
packages/bun-web-transpiler/
  src/
    index.ts
    swc.ts             # Bun.Transpiler 实现（swc-wasm 封装）
    esbuild.ts         # esbuild-wasm 封装（bundler 用）
    cache.ts           # IndexedDB 转译缓存（hash → output）
    source-map.ts      # sourcemap 合并与内联
    transpiler.types.ts
```

### 核心类设计

```ts
// transpiler.types.ts
export interface TranspileOptions {
  loader?: 'ts' | 'tsx' | 'js' | 'jsx' | 'json';
  target?: 'browser' | 'bun' | 'node';
  jsx?: 'react' | 'react-jsx' | 'preserve';
  jsxFactory?: string;
  jsxFragment?: string;
  decorators?: boolean;
  sourceMaps?: boolean | 'inline';
}

export interface TranspileResult {
  code: string;
  map?: string;          // sourcemap JSON string
  imports: string[];     // 静态导入列表（scanImports 用途）
}

// swc.ts
export class BunTranspiler {
  constructor(opts?: TranspileOptions);

  transform(source: string, opts?: Partial<TranspileOptions>): TranspileResult;
  transformAsync(source: string, opts?: Partial<TranspileOptions>): Promise<TranspileResult>;

  // 对齐 Bun.Transpiler.scan() API
  scan(source: string): { imports: Array<{ path: string; kind: 'import' | 'require' }> };
  scanImports(source: string): string[];
}

// cache.ts
export class TranspileCache {
  static async open(): Promise<TranspileCache>;
  get(contentHash: string, optsHash: string): TranspileResult | null;
  set(contentHash: string, optsHash: string, result: TranspileResult): Promise<void>;
  clear(): Promise<void>;
}
```

---

## 7. `bun-web-node`

> 实施计划：M2-3~M2-8, M4-7, M5-4, M5-5, M6-8, M6-9 | RFC §8.2（node:* 全家桶）

### 文件结构

```
packages/bun-web-node/
  src/
    index.ts
    fs.ts                # node:fs + fs/promises（绑定 VFS + SAB）
    path.ts              # node:path（posix/win32）
    url.ts               # node:url / querystring / string_decoder
    module.ts            # node:module（createRequire/isBuiltin/register）
    buffer.ts            # node:buffer + Bun 扩展
    events-stream.ts     # node:events + stream + stream/web + stream/promises
    http-net.ts          # node:http / https / net / tls（over WS 隧道）
    http2.ts             # node:http2（C级，request-like 子集）
    worker_threads.ts    # node:worker_threads
    async_hooks.ts       # node:async_hooks / AsyncLocalStorage
    child_process.ts     # node:child_process（委托 Bun.spawn）
    zlib.ts              # node:zlib（pako + fflate + brotli-wasm）
    process.ts           # node:process 完整对象
    vm-misc.ts           # node:vm / v8 / wasi / assert / util / console / readline / os / cluster
    perf_hooks.ts        # node:perf_hooks / timers（原生 API 封装）
    dgram.ts             # node:dgram（D级存根）
    node.types.ts
```

### 核心类设计（代表性模块）

```ts
// process.ts
export interface BunWebProcess extends NodeJS.Process {
  // 全部 Node.js process 属性
  readonly pid: number;
  readonly ppid: number;
  readonly platform: 'browser';    // RFC §8.2: platform='browser'
  readonly version: string;
  readonly versions: Record<string, string>;
  env: Record<string, string>;
  argv: string[];
  cwd(): string;
  chdir(dir: string): void;
  exit(code?: number): never;
  on(event: string, listener: (...args: unknown[]) => void): this;
  emit(event: string, ...args: unknown[]): boolean;
  nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]): void;
  // Bun 扩展
  isBun: true;
  browser: true;
}

export const process: BunWebProcess;

// http-net.ts
export interface VirtualSocket extends NodeJS.EventEmitter {
  write(data: Buffer | string): boolean;
  end(data?: Buffer | string): void;
  destroy(err?: Error): void;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly localAddress: string;
  readonly localPort: number;
  pipe<T extends NodeJS.WritableStream>(dest: T): T;
}

export interface VirtualServer extends NodeJS.EventEmitter {
  listen(port: number, cb?: () => void): this;
  listen(options: { port: number; host?: string }, cb?: () => void): this;
  close(cb?: (err?: Error) => void): this;
  readonly address: () => { port: number; address: string; family: string } | null;
}

// async_hooks.ts
export class AsyncLocalStorage<T> {
  run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R;
  getStore(): T | undefined;
  enterWith(store: T): void;
  disable(): void;
}

export class AsyncResource {
  constructor(type: string);
  runInAsyncScope<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R;
  bind<T extends (...args: unknown[]) => unknown>(fn: T): T;
}

// vm-misc.ts
export class Script {
  constructor(code: string, options?: { filename?: string });
  runInThisContext(): unknown;
  runInNewContext(ctx?: Record<string, unknown>): unknown;
}

export function createContext(ctx?: Record<string, unknown>): Record<string, unknown>;
export function runInContext(code: string, ctx: Record<string, unknown>): unknown;
export function runInNewContext(code: string, ctx?: Record<string, unknown>): unknown;

// zlib.ts
export function gzip(data: Uint8Array): Promise<Uint8Array>;
export function gunzip(data: Uint8Array): Promise<Uint8Array>;
export function deflate(data: Uint8Array): Promise<Uint8Array>;
export function inflate(data: Uint8Array): Promise<Uint8Array>;
export function brotliCompress(data: Uint8Array): Promise<Uint8Array>;
export function brotliDecompress(data: Uint8Array): Promise<Uint8Array>;

export class Gzip extends TransformStream<Uint8Array, Uint8Array> {}
export class Gunzip extends TransformStream<Uint8Array, Uint8Array> {}
export class BrotliCompress extends TransformStream<Uint8Array, Uint8Array> {}
export class BrotliDecompress extends TransformStream<Uint8Array, Uint8Array> {}
```

---

## 8. `bun-web-webapis`

> 实施计划：M2-9 | RFC §8.3（Web 标准 API 补丁层）

### 文件结构

```
packages/bun-web-webapis/
  src/
    index.ts
    navigator-ua.ts     # navigator.userAgent 兼容策略（RFC §8.3 特殊处）
    websocket-patch.ts  # 在 Process Worker 中 globalThis.WebSocket → VirtualWebSocket
    blob-file.ts        # Blob/File Bun 扩展属性补丁
    broadcast.ts        # BroadcastChannel 跨 Worker 路由
    compression.ts      # CompressionStream / DecompressionStream 扩展
    performance-ext.ts  # performance Bun 扩展属性（performance.nodeTiming 等）
    crypto-ext.ts       # crypto.subtle 缺失算法补丁
    webapis.types.ts
```

### 核心类设计

```ts
// navigator-ua.ts
export interface UACompatStrategy {
  /**
   * UA 标识字符串，注入到 globalThis.__BUN_WEB_UA__
   * 默认 "Bun/x.y.z (browser)"
   */
  identifier: string;
  /**
   * 出站 fetch 请求头注入（在 SW 层拦截后添加）
   * 默认注入 X-Bun-Runtime: browser
   */
  headerInjection: Record<string, string>;
}

export function installUACompat(strategy?: Partial<UACompatStrategy>): void;
export function getBunUAIdentifier(): string;

// websocket-patch.ts
export class VirtualWebSocket extends EventTarget {
  constructor(url: string | URL, protocols?: string | string[]);
  send(data: string | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  readonly readyState: 0 | 1 | 2 | 3;
  readonly url: string;
  readonly protocol: string;
  readonly bufferedAmount: number;
  onopen: ((this: VirtualWebSocket, ev: Event) => unknown) | null;
  onclose: ((this: VirtualWebSocket, ev: CloseEvent) => unknown) | null;
  onmessage: ((this: VirtualWebSocket, ev: MessageEvent) => unknown) | null;
  onerror: ((this: VirtualWebSocket, ev: Event) => unknown) | null;
}

export function installWebSocketPolyfill(): void;
```

---

## 9. `bun-web-sw`

> 实施计划：M4-1, M4-9 | RFC §5（Service Worker 网络虚拟化）

### 文件结构

```
packages/bun-web-sw/
  src/
    sw.ts              # SW 主入口（fetch 拦截、activate、install）
    router.ts          # 虚拟端口路由（resolveVirtualPort）
    kernel-bridge.ts   # SW ↔ Kernel 通信（MessageChannel）
    static-handler.ts  # 静态资源读 VFS
    heartbeat.ts       # SW 保活与自动复活逻辑
    sw.types.ts
```

### 核心类设计

```ts
// router.ts
export interface VirtualRoute {
  pid: number;
  port: number;
  pattern: RegExp;   // 匹配 URL.pathname
}

export class VirtualRouter {
  register(route: VirtualRoute): void;
  unregister(port: number): void;
  resolve(url: URL): VirtualRoute | null;
  // 格式：http://<pid>.bun.local/ 或 /__bun__/:port/
  resolveVirtualPort(url: URL): number | null;
}

// kernel-bridge.ts
export class SWKernelBridge {
  static connect(): Promise<SWKernelBridge>;
  dispatch(port: number, req: Request): Promise<Response>;
  onPortRegistered(cb: (port: number, pid: number) => void): void;
  onPortUnregistered(cb: (port: number) => void): void;
}

// heartbeat.ts
export class SWHeartbeat {
  constructor(intervalMs?: number);   // 默认 20s
  start(): void;
  stop(): void;
  onRecovery(cb: () => void): void;   // SW 复活后回调（重建端口表）
}
```

---

## 10. `bun-web-net`

> 实施计划：M4-3, M4-4, M4-7 | RFC §5.2（WebSocket 桥）、§5.4（TCP 隧道）

### 文件结构

```
packages/bun-web-net/
  src/
    index.ts
    http-bridge.ts          # Request/Response 流式桥接（SW ↔ Process Worker）
    websocket-virtual.ts    # VirtualWebSocket（BroadcastChannel 实现）
    ws-tunnel.ts            # TCP/TLS over WebSocket 隧道客户端
    socket-polyfill.ts      # node:net.Socket → WS 隧道或同源 MessagePort
    tls-stub.ts             # node:tls createSecureContext 存根
    net.types.ts
```

### 核心类设计

```ts
// http-bridge.ts
export class HTTPBridge {
  // SW 侧：将 FetchEvent 的 Request 转成 MessageChannel 传给 Process Worker
  static bridgeRequest(req: Request, pid: number): Promise<Response>;

  // Process Worker 侧：接收 Request，交给 Bun.serve handler，回传 Response
  onRequest(handler: (req: Request) => Response | Promise<Response>): void;
}

// websocket-virtual.ts
export type WSMessageData = string | Uint8Array;

export class WSKernelBus {
  // Kernel 侧：注册某 pid 的 WebSocket handler
  register(pid: number, handler: WebSocketHandler): void;
  // 入站消息路由
  dispatch(pid: number, msg: WSMessageData): void;
}

// ws-tunnel.ts
export interface TunnelOptions {
  tunnelUrl: string;          // wss://proxy/tunnel?target=host:port&proto=tcp
  target: string;             // host:port
  proto: 'tcp' | 'tls';
}

export class WSTunnel {
  constructor(opts: TunnelOptions);
  connect(): Promise<void>;
  write(data: Uint8Array): void;
  readonly readable: ReadableStream<Uint8Array>;
  close(): void;
}

// socket-polyfill.ts
export class VirtualSocket extends EventTarget {
  constructor(tunnelUrl?: string);
  connect(port: number, host?: string, cb?: () => void): this;
  write(data: Buffer | string, encoding?: BufferEncoding, cb?: (err?: Error) => void): boolean;
  end(data?: Buffer | string): this;
  destroy(err?: Error): this;
  pipe<T extends NodeJS.WritableStream>(dest: T): T;
  readonly remoteAddress: string;
  readonly remotePort: number;
}
```

---

## 11. `bun-web-dns`

> 实施计划：M4-8 | RFC §8.1（Bun.dns.* C级）

### 文件结构

```
packages/bun-web-dns/
  src/
    index.ts
    doh.ts         # DoH 客户端（1.1.1.1 JSON API）
    cache.ts       # DNS 结果缓存（TTL 维护）
    dns.types.ts
```

### 核心类设计

```ts
// doh.ts
export interface DNSRecord {
  name: string;
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SOA';
  ttl: number;
  data: string;
}

export interface LookupResult {
  address: string;
  family: 4 | 6;
}

export class DoHResolver {
  constructor(endpoint?: string);  // 默认 'https://1.1.1.1/dns-query'

  lookup(hostname: string, family?: 4 | 6): Promise<LookupResult>;
  resolve(hostname: string, rrtype?: string): Promise<DNSRecord[]>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  resolveMx(hostname: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt(hostname: string): Promise<string[][]>;
  reverse(ip: string): Promise<string[]>;
}

// re-export as bun-compatible API
export const dns: {
  lookup: DoHResolver['lookup'];
  resolve: DoHResolver['resolve'];
  resolve4: DoHResolver['resolve4'];
  resolve6: DoHResolver['resolve6'];
};
```

---

## 12. `bun-web-installer`

> 实施计划：M3-1~M3-4 | RFC §（bun install MVP）

### 文件结构

```
packages/bun-web-installer/
  src/
    index.ts
    registry.ts              # npm registry metadata 拉取（fetch + 缓存）
    tarball.ts               # tarball 下载、brotli/gzip 解压、SHA 校验
    lockfile.ts              # bun.lock TOML 读写与最小增量更新
    node-modules-layout.ts   # 扁平化 node_modules 布局与去重
    lifecycle.ts             # postinstall 脚本（受限执行）
    installer.types.ts
```

### 核心类设计

```ts
// installer.types.ts
export interface PackageSpec {
  name: string;
  version: string;     // 精确版本或 range
  resolved?: string;   // tarball URL
  integrity?: string;  // sha512
}

// registry.ts
export class RegistryClient {
  constructor(registryUrl?: string);  // 默认 'https://registry.npmjs.org'

  getPackument(name: string): Promise<Packument>;
  resolveVersion(name: string, range: string): Promise<PackageSpec>;
  downloadTarball(spec: PackageSpec): Promise<ReadableStream<Uint8Array>>;
}

// tarball.ts
export class TarballExtractor {
  extract(
    stream: ReadableStream<Uint8Array>,
    destPath: string,
    vfs: VFS,
  ): Promise<void>;

  verify(data: Uint8Array, integrity: string): boolean;  // sha512-<base64>
}

// lockfile.ts
export interface LockfileEntry {
  name: string;
  version: string;
  resolved: string;
  integrity: string;
  dependencies?: Record<string, string>;
}

export class LockfileManager {
  static read(vfs: VFS, cwd: string): Promise<LockfileManager>;
  write(vfs: VFS, cwd: string): Promise<void>;

  has(name: string, version: string): boolean;
  add(entry: LockfileEntry): void;
  remove(name: string): void;
  diff(previous: LockfileManager): { added: LockfileEntry[]; removed: LockfileEntry[] };
}

// node-modules-layout.ts
export class NodeModulesLayout {
  constructor(vfs: VFS, cwd: string);

  install(packages: LockfileEntry[]): Promise<void>;
  uninstall(names: string[]): Promise<void>;
  // 去重策略：尽可能提升到最近公共父目录
  hoist(tree: PackageTree): HoistedTree;
}
```

---

## 13. `bun-web-bundler`

> 实施计划：M6-2 | RFC §8.1（Bun.build）

### 文件结构

```
packages/bun-web-bundler/
  src/
    index.ts
    build.ts          # Bun.build() 主入口
    chunk-merger.ts   # 自研 chunk 合并策略
    plugin-adapter.ts # 适配 bun-web-hooks 的 loader plugin 桥
    output.ts         # BuildOutput / BuildArtifact 类型
    bundler.types.ts
```

### 核心类设计

```ts
// bundler.types.ts
export interface BuildOptions {
  entrypoints: string[];
  outdir?: string;
  outfile?: string;
  target?: 'browser' | 'bun' | 'node';
  format?: 'esm' | 'cjs' | 'iife';
  splitting?: boolean;
  minify?: boolean | { whitespace?: boolean; syntax?: boolean; identifiers?: boolean };
  sourcemap?: 'none' | 'inline' | 'external' | 'linked';
  define?: Record<string, string>;
  external?: string[];
  plugins?: import('../bun-web-plugin-api').BunWebPlugin[];
  loader?: Record<string, string>;
}

export interface BuildArtifact {
  readonly path: string;
  readonly kind: 'entry-point' | 'chunk' | 'asset' | 'sourcemap';
  readonly size: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface BuildOutput {
  readonly success: boolean;
  readonly outputs: BuildArtifact[];
  readonly logs: Array<{ level: 'error' | 'warning' | 'info'; message: string; position?: { file: string; line: number; column: number } }>;
}

// build.ts
export function build(opts: BuildOptions): Promise<BuildOutput>;
```

---

## 14. `bun-web-shell`

> 实施计划：M5-1, M5-2 | RFC §7（Shell 命令集）

### 文件结构

```
packages/bun-web-shell/
  src/
    index.ts
    parser.ts          # shell 语法解析（AST）
    executor.ts        # AST 执行器（管道/重定向/glob 展开）
    context.ts         # ShellContext 构建与生命周期
    glob-expand.ts     # glob 展开（复用 Bun.Glob）
    pipeline.ts        # 管道 ReadableStream ↔ WritableStream 桥接
    shell.types.ts
```

### 核心类设计

```ts
// shell.types.ts
export interface ShellContext {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
  fs: import('../bun-web-vfs').VFS;
  signal: AbortSignal;
  builtins: Map<string, ShellBuiltin>;
}

export interface ShellBuiltin {
  name: string;
  run(ctx: ShellContext): Promise<number>;    // 返回 exit code
}

export interface ShellResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

// parser.ts
export type ShellNode =
  | { type: 'Command'; argv: ShellWord[]; redirects: Redirect[] }
  | { type: 'Pipeline'; commands: ShellNode[] }
  | { type: 'Sequence'; left: ShellNode; right: ShellNode; op: ';' | '&&' | '||' }
  | { type: 'Subshell'; body: ShellNode };

export function parseShell(input: string): ShellNode;

// executor.ts
export class ShellExecutor {
  constructor(ctx: ShellContext);

  run(node: ShellNode): Promise<number>;
  exec(argv: string[]): Promise<number>;

  /** 注册额外 builtin（由 plugin 调用） */
  registerBuiltin(builtin: ShellBuiltin): void;
}

// index.ts（Bun.$ 实现）
export function createShellTag(ctx: ShellContext): ShellTag;
export type ShellTag = (
  template: TemplateStringsArray,
  ...values: unknown[]
) => ShellPromise;

export interface ShellPromise extends Promise<ShellResult> {
  text(): Promise<string>;
  lines(): Promise<string[]>;
  json<T = unknown>(): Promise<T>;
  nothrow(): ShellPromise;
  quiet(): ShellPromise;
  stdin(input: string | Uint8Array | ReadableStream): ShellPromise;
  env(vars: Record<string, string>): ShellPromise;
  cwd(dir: string): ShellPromise;
}
```

---

## 15. `bun-web-shell-builtins`

> 实施计划：M5-7 | RFC §7（Phase 1 命令集完整表）

### 文件结构

```
packages/bun-web-shell-builtins/
  src/
    index.ts             # 注册所有 builtin
    # 文件浏览
    ls.ts  tree.ts  pwd.ts  cd.ts  stat.ts  file.ts  which.ts  readlink.ts
    # 文件读写
    cat.ts  head.ts  tail.ts  wc.ts  cp.ts  mv.ts  rm.ts  mkdir.ts  rmdir.ts
    touch.ts  ln.ts  chmod.ts  echo.ts  tee.ts
    # 查找过滤
    grep.ts  find.ts  fd.ts  sed.ts  awk.ts  sort.ts  uniq.ts  cut.ts  tr.ts  xargs.ts
    # 差异补丁
    diff.ts  patch.ts
    # 压缩
    tar.ts  gzip.ts  gunzip.ts  zip.ts  unzip.ts
    # 网络
    curl.ts  wget.ts
    # 进程环境
    ps.ts  kill.ts  env.ts  export.ts  sleep.ts  time.ts  true.ts  false.ts
    # 管道助手
    jq.ts  yq.ts  base64.ts  sha256sum.ts  md5sum.ts
    # 版本控制
    git.ts        # isomorphic-git 封装
    # 包管理
    bun-cmd.ts    # bun / bunx / npm→bun / npx→bunx / node→bun 统一入口
```

### 核心类设计（统一 builtin 接口）

```ts
// index.ts
export const BUILTINS: ShellBuiltin[] = [
  /* 所有命令实例 */
];

export function registerAllBuiltins(executor: ShellExecutor): void;

// 每个命令文件导出同样形状
// grep.ts 示例：
export const grep: ShellBuiltin = {
  name: 'grep',
  async run(ctx: ShellContext): Promise<number> {
    // 解析 ctx.argv，从 ctx.stdin 或 ctx.fs 读文件
    // 写出到 ctx.stdout / ctx.stderr
    // 返回 exit code
  },
};

// git.ts 使用 isomorphic-git
export const git: ShellBuiltin = {
  name: 'git',
  async run(ctx: ShellContext): Promise<number> {
    // 封装 isomorphic-git，使用 ctx.fs 作为 fs 参数
  },
};
```

---

## 16. `bun-web-test`

> 实施计划：M6-3, M6-4 | RFC §8.1（bun:test A级）

### 文件结构

```
packages/bun-web-test/
  src/
    index.ts
    runner.ts         # 测试执行器（describe/test/it/beforeEach 等）
    expect.ts         # expect() 匹配器（移植自 Bun）
    snapshot.ts       # snapshot 读写（OPFS）
    reporter.ts       # 结果报告（TAP / JSON / 终端彩色）
    mock.ts           # jest.fn() / jest.spyOn() 兼容层
    test.types.ts
```

### 核心类设计

```ts
// runner.ts
export interface TestSuite {
  name: string;
  tests: TestCase[];
  beforeAll: HookFn[];
  afterAll: HookFn[];
  beforeEach: HookFn[];
  afterEach: HookFn[];
  nested: TestSuite[];
}

export interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
  timeout?: number;
  skip?: boolean;
  only?: boolean;
  todo?: boolean | string;
}

export type HookFn = () => void | Promise<void>;

export class TestRunner {
  describe(name: string, fn: () => void): void;
  test(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  it: TestRunner['test'];
  beforeAll(fn: HookFn): void;
  afterAll(fn: HookFn): void;
  beforeEach(fn: HookFn): void;
  afterEach(fn: HookFn): void;

  run(opts?: { filter?: string; timeout?: number }): Promise<TestRunResult>;
}

export interface TestRunResult {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  duration: number;
  failures: Array<{ name: string; error: Error }>;
}

// snapshot.ts
export class SnapshotStore {
  static async open(vfs: VFS, snapshotDir: string): Promise<SnapshotStore>;
  get(key: string): string | undefined;
  update(key: string, value: string): Promise<void>;
  flush(): Promise<void>;

  // 对比：首次写入；后续对比差异
  match(received: string, key: string): void;
  matchInline(received: string, inline?: string): void;
}
```

---

## 17. `bun-web-sqlite`

> 实施计划：M6-5 | RFC §8.1（bun:sqlite A级）

### 文件结构

```
packages/bun-web-sqlite/
  src/
    index.ts
    sqlite.ts        # Database 主类（wa-sqlite + OPFS VFS 绑定）
    statement.ts     # Statement 类（prepare / bind / step / finalize）
    opfs-vfs.ts      # wa-sqlite 的 OPFS VFS 适配器
    serialize.ts     # Database.serialize / deserialize
    sqlite.types.ts
```

### 核心类设计

```ts
// sqlite.ts
export interface DatabaseOptions {
  readonly?: boolean;
  create?: boolean;
  strict?: boolean;
}

export class Database {
  constructor(filename: string | ':memory:', opts?: DatabaseOptions);

  static open(filename: string, opts?: DatabaseOptions): Database;
  static deserialize(data: Uint8Array, opts?: DatabaseOptions): Database;

  prepare<T extends Record<string, unknown> = Record<string, unknown>>(sql: string): Statement<T>;

  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string): Statement<T>;

  exec(sql: string): void;
  run(sql: string, ...params: SQLValue[]): { changes: number; lastInsertRowid: number };

  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;

  serialize(fileName?: string): Uint8Array;
  close(throwOnError?: boolean): void;

  readonly inTransaction: boolean;
  readonly filename: string;
}

// statement.types
export type SQLValue = string | number | bigint | null | Uint8Array;

export class Statement<Row extends Record<string, unknown> = Record<string, unknown>> {
  all(...params: SQLValue[]): Row[];
  get(...params: SQLValue[]): Row | null;
  run(...params: SQLValue[]): { changes: number; lastInsertRowid: number };
  values(...params: SQLValue[]): unknown[][];
  iterate(...params: SQLValue[]): Generator<Row>;
  finalize(): void;
  toString(): string;
}
```

---

## 18. `bun-web-crypto`

> 实施计划：M6-7 | RFC §8.1（CryptoHasher/password/hash.* A级）

### 文件结构

```
packages/bun-web-crypto/
  src/
    index.ts
    hasher.ts          # Bun.CryptoHasher（WebCrypto + blake3/sha3 WASM）
    password.ts        # Bun.password.hash / verify（argon2 + bcrypt WASM）
    fast-hash.ts       # Bun.hash.wyhash / xxHash64 / cityHash / murmur WASM 绑定
    random.ts          # Bun.randomUUIDv7 / randomUUIDv5
    node-crypto.ts     # node:crypto（WebCrypto + crypto-browserify 扩展）
    crypto.types.ts
```

### 核心类设计

```ts
// hasher.ts
export type CryptoAlgorithm =
  | 'blake2b256' | 'blake2b512'
  | 'sha1' | 'sha256' | 'sha384' | 'sha512'
  | 'sha512-256' | 'sha3-224' | 'sha3-256' | 'sha3-384' | 'sha3-512'
  | 'md4' | 'md5' | 'ripemd160';

export class CryptoHasher {
  constructor(algorithm: CryptoAlgorithm, seed?: string | Uint8Array);

  update(data: string | Uint8Array | ArrayBufferView, encoding?: BufferEncoding): this;
  digest(): Uint8Array;
  digest(encoding: 'hex' | 'base64'): string;
  copy(): CryptoHasher;

  static hash(algorithm: CryptoAlgorithm, data: string | Uint8Array): string;

  readonly algorithm: CryptoAlgorithm;
  static readonly algorithms: CryptoAlgorithm[];
}

// password.ts
export type PasswordAlgorithm = 'argon2id' | 'argon2i' | 'argon2d' | 'bcrypt';

export interface PasswordHashOptions {
  algorithm?: PasswordAlgorithm;
  memoryCost?: number;    // argon2 参数
  timeCost?: number;
  parallelism?: number;
}

export const password: {
  hash(plaintext: string, opts?: PasswordHashOptions): Promise<string>;
  verify(plaintext: string, hash: string): Promise<boolean>;
  hashSync(plaintext: string, opts?: PasswordHashOptions): string;
  verifySync(plaintext: string, hash: string): boolean;
};

// fast-hash.ts
export const hash: {
  wyhash(data: string | Uint8Array, seed?: bigint): bigint;
  xxHash64(data: string | Uint8Array, seed?: bigint): bigint;
  xxHash32(data: string | Uint8Array, seed?: number): number;
  cityHash64(data: string | Uint8Array): bigint;
  cityHash32(data: string | Uint8Array): number;
  murmur32v3(data: string | Uint8Array, seed?: number): number;
  adler32(data: string | Uint8Array): number;
  crc32(data: string | Uint8Array): number;
};
```

---

## 19. `bun-web-hooks`

> 实施计划：M7-1 | RFC §6（插件体系 Hook Engine）

### 文件结构

```
packages/bun-web-hooks/
  src/
    index.ts
    hook.ts            # Hook 引擎主类
    typed-hooks.ts     # 所有 hook 命名空间的强类型定义
    middleware.ts      # 中间件链（洋葱模型）
    hooks.types.ts
```

### 核心类设计

```ts
// hooks.types.ts
export type HookName =
  | 'kernel:boot' | 'kernel:shutdown'
  | 'vfs:read' | 'vfs:write' | 'vfs:stat' | 'vfs:watch'
  | 'resolve:beforeResolve' | 'resolve:afterResolve'
  | 'loader:load' | 'loader:transform' | 'loader:source-map'
  | 'process:beforeSpawn' | 'process:afterSpawn' | 'process:onExit'
  | 'net:fetch' | 'net:websocket' | 'net:serve'
  | 'shell:beforeCommand' | 'shell:registerBuiltin' | 'shell:afterCommand'
  | 'test:beforeEach' | 'test:afterEach';

export type HookMode = 'sync' | 'async' | 'first';
// sync: 所有注册函数串行执行，最后一个返回值生效
// async: 串行 await 执行，最后一个返回值生效
// first: 第一个非 undefined 返回值生效（短路）

export interface HookRegistration<T = unknown, R = unknown> {
  hook: HookName;
  mode?: HookMode;
  priority?: number;    // 高数字优先（默认 0）
  handler: (ctx: T) => R | Promise<R>;
}

// hook.ts
export class HookEngine {
  register<T, R>(reg: HookRegistration<T, R>): () => void;   // 返回取消注册函数
  unregister(hook: HookName, handler: Function): void;

  call<T, R>(hook: HookName, ctx: T, mode?: HookMode): R | undefined;
  callAsync<T, R>(hook: HookName, ctx: T, mode?: HookMode): Promise<R | undefined>;

  hasHooks(hook: HookName): boolean;
  clear(hook?: HookName): void;
}
```

---

## 20. `bun-web-plugin-api`

> 实施计划：M7-2 | RFC §6（BunWebPlugin / PluginContext）

### 文件结构

```
packages/bun-web-plugin-api/
  src/
    index.ts
    plugin-context.ts    # PluginContext 实现（Proxy 沙箱）
    loader-pattern.ts    # LoaderPattern 类型与匹配逻辑
    sandbox.ts           # 插件 CPU/内存预算熔断
    plugin.types.ts
```

### 核心类设计

```ts
// plugin.types.ts（对齐 RFC §6.2）
export interface BunWebPlugin {
  name: string;
  version?: string;
  scopes?: Array<'kernel' | 'process' | 'sw' | 'shell'>;
  setup(ctx: PluginContext): void | Promise<void>;
}

export interface LoaderPattern {
  filter: RegExp;
  namespace?: string;
  loader(opts: LoaderArgs): LoaderResult | Promise<LoaderResult>;
}

export interface LoaderArgs {
  path: string;
  namespace: string;
  importer: string;
  vfs: import('../bun-web-vfs').VFS;
}

export interface LoaderResult {
  contents: string | Uint8Array;
  loader?: 'ts' | 'tsx' | 'js' | 'jsx' | 'json' | 'css' | 'text' | 'file';
}

// plugin-context.ts
export class PluginContextImpl implements PluginContext {
  constructor(
    engine: HookEngine,
    vfs: VFS,
    shellExecutor: ShellExecutor,
    allowedScopes: BunWebPlugin['scopes'],
  );

  readonly hooks: TypedHooks;
  readonly fs: VFS;

  registerShellBuiltin(name: string, impl: ShellBuiltin): void;
  registerLoader(opts: LoaderPattern): void;

  readonly logger: Logger;
  readonly abortSignal: AbortSignal;
}

// sandbox.ts
export interface PluginBudget {
  cpuMs?: number;       // 单次 setup 最大 CPU 时间
  memoryMB?: number;    // 最大内存增量
}

export function runWithBudget<T>(fn: () => Promise<T>, budget: PluginBudget): Promise<T>;
```

---

## 21. `bun-web-compat-registry`

> 实施计划：M7-3, M7-4 | RFC §9（Compat Registry）

### 文件结构

```
packages/bun-web-compat-registry/
  src/
    index.ts
    registry.ts         # CompatRegistry 主类
    levels.ts           # 兼容级别枚举与验证
    scanner.ts          # 从 bun-types 扫描符号（build-time）
    compat.types.ts
```

### 核心类设计

```ts
// compat.types.ts（对齐 RFC §9）
export type CompatLevel = 'A' | 'B' | 'C' | 'D';

export interface CompatEntry {
  symbol: string;      // 'Bun.serve' / 'node:net.Socket'
  level: CompatLevel;
  notes?: string;
  since?: string;      // semver，首次实现版本
  issues?: string[];   // 已知不兼容对应 GitHub issue URL
}

// registry.ts
export class CompatRegistry {
  static readonly instance: CompatRegistry;

  register(entry: CompatEntry): void;
  get(symbol: string): CompatEntry | undefined;
  list(level?: CompatLevel): CompatEntry[];
  validate(): ValidationResult;   // 检查未登记符号

  // D 级调用守卫（在 D 级 API 存根处自动调用）
  assertSupported(symbol: string): void;
}

export class BunWebUnsupportedError extends Error {
  constructor(symbol: string, meta?: { code?: string; level?: CompatLevel });
  readonly code: 'ERR_BUN_WEB_UNSUPPORTED';
  readonly symbol: string;
  readonly compatLevel: CompatLevel;
}
```

---

## 22. `bun-web-agent`

> 实施计划：M7-7 | RFC §10（`bun-web-agent/`）

### 文件结构

```
packages/bun-web-agent/
  src/
    index.ts
    agent-shell.ts      # 受限 shell（能力白名单过滤）
    audit-overlay.ts    # 命令审计日志（VFS 追加写）
    capabilities.ts     # 能力集定义与运行时白名单检查
    agent.types.ts
```

### 核心类设计

```ts
// agent.types.ts
export interface AgentCapabilities {
  allowedCommands: string[];         // 允许的 shell 命令列表
  allowedPaths: string[];            // 允许读写的路径前缀
  allowNetwork: boolean;             // 是否允许出站 fetch
  maxOutputBytes?: number;           // 单次命令最大输出字节数（防止输出爆炸）
  auditLog?: string;                 // 审计日志写入 VFS 路径（默认 /tmp/agent-audit.jsonl）
}

// agent-shell.ts
export class AgentShell {
  constructor(baseExecutor: ShellExecutor, caps: AgentCapabilities);

  exec(command: string, ctx?: Partial<ShellContext>): Promise<AgentExecResult>;

  readonly capabilities: AgentCapabilities;
}

export interface AgentExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  blocked: boolean;   // true = 命令被白名单拒绝
  reason?: string;
}

// audit-overlay.ts
export class AuditOverlay {
  constructor(vfs: VFS, logPath: string);

  log(entry: AuditEntry): Promise<void>;
  tail(n?: number): Promise<AuditEntry[]>;
}

export interface AuditEntry {
  ts: string;           // ISO 8601
  command: string;
  argv: string[];
  exitCode: number;
  blocked: boolean;
}
```

---

## 23. `bun-web-client`

> 实施计划：M4-5, M7-8 | RFC §10（`bun-web-client/`、宿主 SDK）

### 文件结构

```
packages/bun-web-client/
  src/
    index.ts
    sdk.ts         # BunContainer 主类（对齐 WebContainer API 风格）
    preview.ts     # iframe 预览挂载
    terminal.ts    # xterm.js ↔ Process Worker stdio 桥接
    rpc.ts         # 宿主 ↔ Kernel 的 postMessage RPC
    events.ts      # 事件系统（server-ready / process-exit / file-change）
    client.types.ts
```

### 核心类设计

```ts
// sdk.ts（对齐 RFC §10 示例代码）
export interface BunContainerOptions {
  tunnelUrl?: string;        // 可选 TCP 隧道（RFC §5.4）
  coopCoepHeaders?: boolean; // 自动注入 COOP/COEP（默认 false）
  workerType?: 'shared' | 'dedicated';  // Kernel Worker 类型
}

export class BunContainer {
  static async boot(opts?: BunContainerOptions): Promise<BunContainer>;
  static shutdown(): Promise<void>;

  /**
   * 挂载文件树到 VFS /
   * @param files 文件路径 → 文件内容（对齐 WebContainer.mount）
   */
  mount(files: FileTree, opts?: { mountPoint?: string }): Promise<void>;

  /** 在容器内运行命令，返回 ChildProcessHandle */
  spawn(cmd: string, args?: string[], opts?: SpawnOpts): Promise<ContainerProcess>;

  /** 直接执行 TypeScript/JavaScript 源码 */
  eval(source: string, opts?: { filename?: string }): Promise<unknown>;

  /** 监听容器事件 */
  on(event: 'server-ready', handler: (port: number, url: URL) => void): this;
  on(event: 'process-exit', handler: (pid: number, code: number) => void): this;
  on(event: 'file-change', handler: (path: string) => void): this;
  off(event: string, handler: Function): this;

  /** 绑定 xterm.js Terminal 实例 */
  attachTerminal(terminal: ITerminal, pid?: number): TerminalHandle;

  readonly fs: VFSPublicAPI;
}

export type FileTree = Record<string, string | Uint8Array | FileTree>;

export interface ContainerProcess {
  readonly pid: number;
  readonly output: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: number): void;
  input: WritableStream<Uint8Array>;
}

// preview.ts
export class PreviewManager {
  attach(iframe: HTMLIFrameElement): void;
  detach(): void;
  onServerReady(port: number, url: URL): void;
}
```

---

## 24. `bun-web-proxy-server`

> 实施计划：M4-10 | RFC §5.4（可选 WS/TCP 隧道服务端）

### 文件结构

```
packages/bun-web-proxy-server/
  src/
    server.ts      # 隧道服务端主类（运行在 Node/Bun/Deno，不在浏览器）
    handler.ts     # WS 升级处理与 TCP 透传
    auth.ts        # 可选 Token 鉴权
    proxy.types.ts
```

### 核心类设计

```ts
// proxy.types.ts
export interface ProxyServerOptions {
  port?: number;              // 默认 3001
  allowedTargets?: string[];  // 白名单（host:port 前缀），空数组=全允许
  authToken?: string;         // 可选 Bearer token 验证
  tls?: { cert: string; key: string };
}

// server.ts（在 Bun/Node/Deno 上运行，非浏览器）
export class ProxyServer {
  constructor(opts?: ProxyServerOptions);
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;   // wss://host:port
}

// handler.ts
export async function handleTunnel(
  ws: WebSocket,
  target: string,
  proto: 'tcp' | 'tls',
): Promise<void>;
```

---

## 附录：错误类层次

```ts
// packages/bun-web-kernel/src/errors.ts（或统一放 bun-web-runtime）
export class BunWebError extends Error {
  readonly code: string;
}

export class SyscallError extends BunWebError {
  readonly syscall: string;
  readonly errno: number;
}

export class VFSNotFoundError extends BunWebError { }    // ENOENT
export class VFSPermissionError extends BunWebError { }  // EACCES
export class VFSIsDirectoryError extends BunWebError { } // EISDIR

export class BunWebUnsupportedError extends BunWebError {
  readonly code: 'ERR_BUN_WEB_UNSUPPORTED';
  readonly compatLevel: 'C' | 'D';
  readonly symbol: string;
}

export class PluginSandboxError extends BunWebError { }  // 插件熔断
export class TunnelNotConfiguredError extends BunWebError { }  // 未配置 tunnelUrl
```

---

## 附录：跨包共用类型索引

| 类型 | 定义位置 | 消费者 |
|---|---|---|
| `VFS` | `bun-web-vfs/vfs.types.ts` | runtime / node / kernel / installer / sqlite / test |
| `FileStat` / `Dirent` | `bun-web-vfs/vfs.types.ts` | node:fs / resolver |
| `ShellContext` / `ShellBuiltin` | `bun-web-shell/shell.types.ts` | shell-builtins / plugin-api / agent |
| `SyscallBridge` | `bun-web-kernel/kernel.types.ts` | runtime / node |
| `BunWebPlugin` / `PluginContext` | `bun-web-plugin-api/plugin.types.ts` | runtime / bundler / hooks |
| `CompatEntry` | `bun-web-compat-registry/compat.types.ts` | 所有包（注册时） |
| `BunWebError` 及子类 | `bun-web-kernel/errors.ts` | 所有包 |
| `FileTree` | `bun-web-client/client.types.ts` | sdk / mount |
