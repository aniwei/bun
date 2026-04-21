/**
 * Kernel client —— 运行在 UI 线程，封装 Worker 生命周期与消息协议。
 */

import {
  PROTOCOL_VERSION,
  type HostRequest,
  type KernelEvent,
  type VfsSnapshotRequest,
} from "./protocol";
import { buildSnapshot, type VfsFile } from "./vfs-client";

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

export class Kernel {
  private worker: Worker;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: unknown) => void;
  private pendingEvals = new Map<string, PendingEval>();

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

  stop(code = 130): void {
    this.post({ kind: "stop", code });
  }

  terminate(): void {
    this.worker.terminate();
  }
}
