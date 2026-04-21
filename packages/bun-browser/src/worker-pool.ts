/**
 * WorkerPool —— 通用 Web Worker 池，用于把 CPU 密集任务（gunzip/tar/transpile/…）
 * 并行分发到多个 dedicated Worker。
 *
 * 设计目标：
 *   - **不阻塞 UI 线程**：任务提交方仅收发 `postMessage`。
 *   - **背压**：空闲 worker 才接新任务；等待中的任务排队，FIFO 出队。
 *   - **多路复用**：每个任务有唯一 id；同一个 Worker 串行处理它的队列，
 *     避免 postMessage race。简单、可预测。
 *   - **宿主无关**：接受任意 Worker 工厂，便于浏览器 / Node.js test 环境注入。
 *
 * 协议假设（worker 侧实现者负责遵守）：
 *   - UI → Worker: `{ jobId: string, input: unknown }`
 *   - Worker → UI: `{ jobId: string, ok: true, output: unknown }`
 *                | `{ jobId: string, ok: false, error: string }`
 *
 * 不与 Kernel 协议耦合；Kernel Worker 若需要内部并行，可在其内部
 * 自行创建 WorkerPool 作为二级调度。
 */

export type WorkerLike = {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
  removeEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
};

export type WorkerFactory = () => WorkerLike;

export interface WorkerPoolOptions {
  /** 池大小；默认 `navigator.hardwareConcurrency || 2`，上限由调用方自行限制。 */
  size?: number;
  /** Worker 工厂；每次调用返回一个新的 worker。 */
  factory: WorkerFactory;
}

interface PoolJob<I, O> {
  id: string;
  input: I;
  transfer: Transferable[];
  resolve: (o: O) => void;
  reject: (e: Error) => void;
}

interface PoolWorkerState {
  worker: WorkerLike;
  busy: boolean;
  /** 当前正在处理的 jobId（busy=true 时有意义）。 */
  currentJobId?: string | undefined;
}

export class WorkerPool<I = unknown, O = unknown> {
  private readonly workers: PoolWorkerState[] = [];
  private readonly queue: PoolJob<I, O>[] = [];
  private readonly pending = new Map<string, PoolJob<I, O>>();
  private readonly size: number;
  private terminated = false;
  private counter = 0;

  constructor(opts: WorkerPoolOptions) {
    const defaultSize =
      typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
        ? Math.max(1, navigator.hardwareConcurrency)
        : 2;
    this.size = Math.max(1, opts.size ?? defaultSize);
    for (let i = 0; i < this.size; i++) {
      const w = opts.factory();
      const state: PoolWorkerState = { worker: w, busy: false };
      const listener = (ev: { data: unknown }): void => this.onWorkerMessage(state, ev.data);
      w.addEventListener("message", listener);
      w.addEventListener("error", (e: unknown) => this.onWorkerError(state, e));
      this.workers.push(state);
    }
  }

  /** 池大小（只读）。 */
  get workerCount(): number {
    return this.size;
  }

  /** 当前排队中但未开始的任务数。 */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** 当前正在执行（已分发到 worker）的任务数。 */
  get activeCount(): number {
    return this.pending.size - this.queue.length;
  }

  /**
   * 提交一个任务。返回 worker 的输出。
   *
   * @param input    任意可结构化克隆的输入。
   * @param transfer 可转移的 ArrayBuffer 列表（零拷贝交给 worker）。
   */
  submit(input: I, transfer: Transferable[] = []): Promise<O> {
    if (this.terminated) return Promise.reject(new Error("WorkerPool: terminated"));
    return new Promise<O>((resolve, reject) => {
      const id = `p${++this.counter}`;
      const job: PoolJob<I, O> = { id, input, transfer, resolve, reject };
      this.pending.set(id, job);
      this.queue.push(job);
      this.drain();
    });
  }

  /**
   * 并发 `map`：对每个输入各派一个任务，保持输出顺序。
   * 池大小即为最大并发度。
   */
  async map<T>(inputs: T[], toInput: (t: T) => { input: I; transfer?: Transferable[] }): Promise<O[]> {
    const jobs = inputs.map((t) => {
      const { input, transfer } = toInput(t);
      return this.submit(input, transfer ?? []);
    });
    return Promise.all(jobs);
  }

  private drain(): void {
    if (this.terminated) return;
    for (const state of this.workers) {
      if (state.busy) continue;
      const job = this.queue.shift();
      if (!job) return;
      state.busy = true;
      state.currentJobId = job.id;
      state.worker.postMessage({ jobId: job.id, input: job.input }, job.transfer);
    }
  }

  private onWorkerMessage(state: PoolWorkerState, data: unknown): void {
    const msg = data as { jobId?: string; ok?: boolean; output?: O; error?: string } | null;
    if (!msg || typeof msg !== "object" || typeof msg.jobId !== "string") return;
    const job = this.pending.get(msg.jobId);
    if (!job) return;
    this.pending.delete(msg.jobId);
    state.busy = false;
    state.currentJobId = undefined;
    if (msg.ok) job.resolve(msg.output as O);
    else job.reject(new Error(msg.error ?? "WorkerPool: worker reported failure"));
    this.drain();
  }

  private onWorkerError(state: PoolWorkerState, err: unknown): void {
    const id = state.currentJobId;
    if (id) {
      const job = this.pending.get(id);
      if (job) {
        this.pending.delete(id);
        const message = (err as { message?: string })?.message ?? String(err);
        job.reject(new Error(`WorkerPool: worker crashed: ${message}`));
      }
    }
    state.busy = false;
    state.currentJobId = undefined;
    // 继续消费队列；若整个 worker 崩溃，后续任务还会在它上面失败，
    // 由调用方处理（重试策略不属于此层）。
    this.drain();
  }

  /** 停止所有 worker，拒绝所有 pending job。 */
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    for (const state of this.workers) {
      try {
        state.worker.terminate();
      } catch {
        // ignore
      }
    }
    const rejectErr = new Error("WorkerPool: terminated");
    for (const job of this.pending.values()) job.reject(rejectErr);
    this.pending.clear();
    this.queue.length = 0;
  }
}
