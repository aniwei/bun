/**
 * Kernel client —— 运行在 UI 线程，封装 Worker 生命周期与消息协议。
 */

import {
  PROTOCOL_VERSION,
  type HostRequest,
  type KernelEvent,
  type VfsSnapshotRequest,
  type SpawnRequest,
  type ServeFetchRequest,
} from "./protocol";
import { buildSnapshot, type VfsFile } from "./vfs-client";
import { PreviewPortRegistry, buildPreviewUrl } from "./preview-router";

export interface KernelOptions {
  /** 已编译的 bun-core.wasm 模块（可由 `WebAssembly.compileStreaming(fetch(...))` 得到）。 */
  wasmModule: WebAssembly.Module;
  /** Worker URL（通常由打包器在 import.meta.url 下解析 kernel-worker.ts）。 */
  workerUrl: string | URL;
  /** 初始 VFS 内容。 */
  initialFiles?: VfsFile[];
  /** 握手后首次运行前设置到 process.argv（不含前置的 "bun"）。 */
  argv?: string[];
  /** 握手后首次运行前设置到 process.env。 */
  env?: Record<string, string>;
  /**
   * 握手完成后自动运行的入口文件路径（VFS 内绝对路径）。
   * 仅在 Worker 已加载 VFS 内容后才有效，应与 `initialFiles` 配合使用。
   */
  entry?: string;
  /** 事件回调。 */
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onExit?: (code: number) => void;
  onError?: (err: { message: string; stack?: string | undefined }) => void;
}

type PendingEval = { resolve: () => void; reject: (e: Error) => void };
type PendingSpawn = { resolve: (code: number) => void; reject: (e: Error) => void };
type PendingServeFetch = {
  resolve: (r: { status: number; statusText?: string; headers: Record<string, string>; body: string }) => void;
  reject: (e: Error) => void;
};

export class Kernel {
  private worker: Worker;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: unknown) => void;
  private pendingEvals = new Map<string, PendingEval>();
  private pendingSpawns = new Map<string, PendingSpawn>();
  private pendingServeFetches = new Map<string, PendingServeFetch>();
  /** Phase 3 T3.1：已注册的预览端口（供 ServiceWorker 同步）。 */
  readonly previewPorts = new PreviewPortRegistry();

  constructor(private readonly opts: KernelOptions) {
    this.worker = new Worker(opts.workerUrl, { type: "module" });
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", (e) => this.rejectReady(e));

    const vfsSnapshot = opts.initialFiles ? buildSnapshot(opts.initialFiles) : undefined;
    const transfer: Transferable[] = vfsSnapshot ? [vfsSnapshot] : [];
    this.post(
      {
        kind: "handshake",
        protocolVersion: PROTOCOL_VERSION,
        wasmModule: opts.wasmModule,
        vfsSnapshot,
        entry: opts.entry,
        argv: opts.argv,
        env: opts.env,
      },
      transfer,
    );
  }

  private onMessage = (ev: MessageEvent<KernelEvent>): void => {
    const msg = ev.data;
    switch (msg.kind) {
      case "handshake:ack":
        break;
      case "ready":
        this.resolveReady();
        break;
      case "stdout":
        this.opts.onStdout?.(msg.data);
        break;
      case "stderr":
        this.opts.onStderr?.(msg.data);
        break;
      case "exit":
        this.opts.onExit?.(msg.code);
        break;
      case "error":
        this.opts.onError?.({ message: msg.message, stack: msg.stack });
        break;
      case "eval:result": {
        const pending = this.pendingEvals.get(msg.id);
        if (pending) {
          this.pendingEvals.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve();
        }
        break;
      }
      case "spawn:exit": {
        const pending = this.pendingSpawns.get(msg.id);
        if (pending) {
          this.pendingSpawns.delete(msg.id);
          pending.resolve(msg.code);
        }
        break;
      }
      case "serve:fetch:response": {
        const pending = this.pendingServeFetches.get(msg.id);
        if (pending) {
          this.pendingServeFetches.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve({
            status: msg.status,
            ...(msg.statusText !== undefined ? { statusText: msg.statusText } : {}),
            headers: msg.headers,
            body: msg.body,
          });
        }
        break;
      }
      default:
        break;
    }
  };

  private post(msg: HostRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  async whenReady(): Promise<void> {
    return this.ready;
  }

  async run(entry: string, argv: string[] = [], env: Record<string, string> = {}): Promise<void> {
    await this.ready;
    this.post({ kind: "run", entry, argv, env });
  }

  /**
   * 在运行时中同步执行一条 `bun` 命令（Phase 2 in-process spawn）。
   *
   * - `argv[0]` 必须为 `"bun"`
   * - 支持 `["bun", "-e", "<js>"]` 和 `["bun", "run", "<vfs-path>"]`
   * - stdout/stderr 通过 `onStdout`/`onStderr` 回调流出
   * - 返回退出码（0 = 正常）
   */
  async spawn(
    argv: string[],
    opts: { env?: Record<string, string>; cwd?: string } = {},
  ): Promise<number> {
    await this.ready;
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return new Promise<number>((resolve, reject) => {
      this.pendingSpawns.set(id, { resolve, reject });
      const msg: SpawnRequest = {
        kind: "spawn",
        id,
        argv,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      };
      this.post(msg);
    });
  }

  /**
   * 在运行时中直接 eval 一段源码（不经 VFS 加载器）。
   * – `id` 需全局唯一，用于将 `eval:result` 响应路由回对应的 Promise。
   * – `filename` 用于 sourceURL 注释，影响 stack trace。
   */
  async eval(id: string, source: string, filename?: string): Promise<void> {
    await this.ready;
    return new Promise<void>((resolve, reject) => {
      this.pendingEvals.set(id, { resolve, reject });
      this.post({ kind: "eval", id, source, ...(filename !== undefined ? { filename } : {}) });
    });
  }

  async writeFile(path: string, data: Uint8Array | string, mode = 0o644): Promise<void> {
    await this.ready;
    const snapshot = buildSnapshot([{ path, data, mode }]);
    const msg: VfsSnapshotRequest = { kind: "vfs:snapshot", snapshot };
    this.post(msg, [snapshot]);
  }

  /**
   * 向已注册的 `Bun.serve({ fetch, port })` 路由派发一个请求。
   *
   * Phase 3 T3.3 最小切片：Host 直接绕过 ServiceWorker 主动调用路由 handler。
   * 本方法并非从浏览器地址栏浏览的 `http://localhost:PORT/` 路径，
   * 而是测试与 SSR 场景下的直调通道。
   */
  async fetch(
    port: number,
    init: {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string | ArrayBuffer;
    } = {},
  ): Promise<{
    status: number;
    statusText?: string;
    headers: Record<string, string>;
    body: string;
  }> {
    await this.ready;
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const url = init.url ?? `http://localhost:${port}/`;
    return new Promise((resolve, reject) => {
      this.pendingServeFetches.set(id, { resolve, reject });
      const req: ServeFetchRequest = {
        kind: "serve:fetch",
        id,
        port,
        url,
        ...(init.method !== undefined ? { method: init.method } : {}),
        ...(init.headers !== undefined ? { headers: init.headers } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
      };
      this.post(req);
    });
  }

  stop(code = 130): void {
    this.post({ kind: "stop", code });
  }

  /**
   * Phase 3 T3.1：标记一个端口已由 `Bun.serve()` 注册，供 ServiceWorker 拦截
   * `${origin}/__bun_preview__/{port}/...` 时转发到本 Kernel。
   *
   * 返回对应的预览 URL 基地址。调用方应将 `iframe.src` 指向该 URL。
   */
  registerPreviewPort(port: number, origin?: string): string {
    this.previewPorts.add(port);
    const resolvedOrigin =
      origin ??
      (typeof location !== "undefined" && location?.origin ? location.origin : "http://localhost");
    return buildPreviewUrl(resolvedOrigin, port, "/");
  }

  /** 解除某个端口的预览注册。 */
  unregisterPreviewPort(port: number): boolean {
    return this.previewPorts.remove(port);
  }

  /**
   * Phase 4 T4.1 / T4.2：在浏览器中执行最小 `bun install`。
   *
   * 流程：拉取每个顶层依赖的 metadata → 解析版本 → 下载 tarball →
   * gunzip + ustar 解析 → 把所有文件写入 VFS（`/node_modules/<name>/...`）。
   *
   * 仅展开顶层 dependencies 表，不展开传递依赖；用于 RFC Phase 4 验收
   * 的最小可验证切片。完整的 lockfile 解析与依赖图扁平化是 Phase 5 的工作。
   */
  async installPackages(
    deps: Record<string, string>,
    opts: import("./installer").InstallerOptions = {},
  ): Promise<import("./installer").InstallResult> {
    const { installPackages } = await import("./installer");
    const result = await installPackages(deps, opts);
    if (result.files.length > 0) {
      await this.ready;
      const snapshot = buildSnapshot(result.files);
      const msg: VfsSnapshotRequest = { kind: "vfs:snapshot", snapshot };
      this.post(msg, [snapshot]);
    }
    return result;
  }

  terminate(): void {
    this.worker.terminate();
  }
}
