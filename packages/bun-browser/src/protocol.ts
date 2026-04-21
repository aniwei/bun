/**
 * Protocol between the UI thread and the Kernel Worker.
 *
 * 消息总线定义了 UI 线程（应用）与内核 Worker（bun-core.wasm 宿主）之间的所有通信格式。
 * 所有消息均为 JSON 可序列化；大缓冲区通过 `Transferable`（ArrayBuffer）零拷贝传递。
 *
 * 版本策略：任一字段新增/变更须抬升 `PROTOCOL_VERSION`，Host 端需在握手时校验。
 */

export const PROTOCOL_VERSION = 1 as const;

/** UI → Kernel 请求。 */
export type HostRequest =
  | HandshakeRequest
  | VfsSnapshotRequest
  | RunRequest
  | StopRequest
  | EvalRequest
  | SpawnRequest
  | FetchResponse; // host resolving a prior FetchRequest

/** Kernel → UI 事件/响应。 */
export type KernelEvent =
  | HandshakeAck
  | ReadyEvent
  | StdoutEvent
  | StderrEvent
  | ExitEvent
  | ErrorEvent
  | EvalResultEvent
  | SpawnExitEvent
  | FetchRequest
  | VfsEvent;

export interface HandshakeRequest {
  kind: "handshake";
  protocolVersion: number;
  wasmModule: WebAssembly.Module;
  vfsSnapshot?: ArrayBuffer | undefined;
  /** 入口文件在 VFS 中的绝对路径。 */
  entry?: string | undefined;
  /** 透传给运行时的 argv。 */
  argv?: string[] | undefined;
  env?: Record<string, string> | undefined;
}

export interface HandshakeAck {
  kind: "handshake:ack";
  protocolVersion: number;
  /** Host JS 引擎标识（browser | node | node-vm）。 */
  engine: string;
}

export interface VfsSnapshotRequest {
  kind: "vfs:snapshot";
  /** 二进制 VFS snapshot（见 src/sys_wasm/vfs.zig 的 loadSnapshot 格式）。 */
  snapshot: ArrayBuffer;
}

export interface RunRequest {
  kind: "run";
  entry: string;
  argv?: string[];
  env?: Record<string, string>;
}

export interface StopRequest {
  kind: "stop";
  /** 非 0 退出码，默认 130（SIGINT）。 */
  code?: number;
}

export interface EvalRequest {
  kind: "eval";
  id: string;
  source: string;
  filename?: string;
}

export interface ReadyEvent {
  kind: "ready";
}

/** Kernel → UI：eval 请求的执行结果。 */
export interface EvalResultEvent {
  kind: "eval:result";
  /** 对应 EvalRequest.id。 */
  id: string;
  /** undefined = 成功（无异常）。 */
  error?: string | undefined;
}

export interface StdoutEvent {
  kind: "stdout";
  data: string;
}

export interface StderrEvent {
  kind: "stderr";
  data: string;
}

export interface ExitEvent {
  kind: "exit";
  code: number;
}

export interface ErrorEvent {
  kind: "error";
  message: string;
  stack?: string | undefined;
}

/** Kernel 请求 UI 线程发起 fetch（例如 npm registry 代理）。 */
export interface FetchRequest {
  kind: "fetch:request";
  id: string;
  url: string;
  init?: RequestInit;
}

export interface FetchResponse {
  kind: "fetch:response";
  id: string;
  ok: boolean;
  status: number;
  headers?: Record<string, string>;
  body?: ArrayBuffer;
  error?: string;
}

export interface VfsEvent {
  kind: "vfs:event";
  /** 文件路径（watcher 通知）。 */
  path: string;
  type: "change" | "add" | "unlink";
}

/**
 * UI → Kernel：在当前运行时中执行一条命令（同步 in-process spawn）。
 *
 * 对应 WASM 导出 `bun_spawn(cmd_json) → i32`（Phase 2 同步实现）。
 * `argv[0]` 必须为 "bun"；支持 `["bun","-e","<code>"]` 和 `["bun","run","<path>"]`。
 */
export interface SpawnRequest {
  kind: "spawn";
  /** 唯一请求 id，用于将 spawn:exit 路由回对应的 Promise。 */
  id: string;
  /** 完整命令行参数，包含可执行文件名，例如 `["bun", "-e", "..."]`。 */
  argv: string[];
  /** 注入到 process.env 的环境变量（可选）。 */
  env?: Record<string, string>;
  /** 注入到 process.cwd() 的工作目录（可选）。 */
  cwd?: string;
}

/** Kernel → UI：spawn 执行结束通知。 */
export interface SpawnExitEvent {
  kind: "spawn:exit";
  /** 对应 SpawnRequest.id。 */
  id: string;
  /** 进程退出码（0 = 正常）。 */
  code: number;
}
