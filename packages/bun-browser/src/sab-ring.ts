/**
 * SabRing —— SharedArrayBuffer-backed single-producer/single-consumer byte ring buffer.
 *
 * 基础设施：为 pipe（stdin/stdout/stderr/IPC）与 VFS 远端 I/O 提供
 * 跨 Worker 的共享内存通道。
 *
 * 内存布局（所有整数为 Int32，little-endian）：
 *
 *   +---------- header (HEADER_BYTES = 32) --------------+
 *   | [0] head    — producer write offset (mod capacity) |
 *   | [1] tail    — consumer read  offset (mod capacity) |
 *   | [2] closed  — 0/1 flag                             |
 *   | [3] waiters — count of consumers blocked in wait() |
 *   | [4..7]      — reserved                             |
 *   +---------- data (capacity bytes) --------------------+
 *
 * 空/满的经典消歧：保留 1 字节（head == (tail-1) mod cap 视为满）。
 * 使用 `Atomics.store`/`Atomics.load` 保证跨 Worker 可见；`Atomics.notify` 唤醒
 * 阻塞在 `head` 上等待的消费者。若当前上下文非 SAB，则退化为普通 `Int32Array`，
 * 仍然在单线程内部可用（便于单元测试）。
 */

export const SAB_RING_HEADER_BYTES = 32

export interface SabRingHandle {
  /** Raw buffer; either `SharedArrayBuffer` or `ArrayBuffer` (fallback). */
  buffer: SharedArrayBuffer | ArrayBuffer
  /** Capacity of the data region, in bytes. */
  capacity: number
}

const HEAD_IDX = 0
const TAIL_IDX = 1
const CLOSED_IDX = 2
const WAITERS_IDX = 3

/**
 * 检测当前环境是否支持 SAB + Atomics.wait（需要 COOP/COEP isolated context）。
 * Worker 内 `Atomics.wait` 可用；主线程仅 `waitAsync` 可用（此处当作不支持真阻塞）。
 */
export function sabCapability(): { sab: boolean; atomicsWait: boolean } {
  const sab = typeof SharedArrayBuffer !== 'undefined'
  const atomicsWait =
    sab &&
    typeof Atomics !== 'undefined' &&
    typeof (Atomics as unknown as { wait?: unknown }).wait === 'function' &&
    typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined'
  return { sab, atomicsWait }
}

export function createSabRing(capacity: number): SabRingHandle {
  if (!Number.isInteger(capacity) || capacity < 16) {
    throw new RangeError(`SabRing capacity must be an integer ≥ 16, got ${capacity}`)
  }
  const total = SAB_RING_HEADER_BYTES + capacity
  const buffer: SharedArrayBuffer | ArrayBuffer =
    typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(total) : new ArrayBuffer(total)
  return { buffer, capacity }
}

/**
 * 生产者句柄——只读 tail、写 head；不会阻塞（满时写入部分字节后返回）。
 */
export class SabRingProducer {
  private readonly hdr: Int32Array
  private readonly data: Uint8Array
  private readonly capacity: number

  constructor(handle: SabRingHandle) {
    this.hdr = new Int32Array(handle.buffer, 0, SAB_RING_HEADER_BYTES / 4)
    this.data = new Uint8Array(handle.buffer, SAB_RING_HEADER_BYTES, handle.capacity)
    this.capacity = handle.capacity
  }

  /** 可写字节数（=capacity-1 - 已占用）。 */
  writable(): number {
    const head = Atomics.load(this.hdr, HEAD_IDX)
    const tail = Atomics.load(this.hdr, TAIL_IDX)
    const used = (head - tail + this.capacity) % this.capacity
    return this.capacity - 1 - used
  }

  /** 写入尽可能多的字节，返回写入的字节数。 */
  write(bytes: Uint8Array): number {
    const avail = this.writable()
    if (avail === 0) return 0
    const n = Math.min(avail, bytes.byteLength)
    const head = Atomics.load(this.hdr, HEAD_IDX)
    const first = Math.min(n, this.capacity - head)
    this.data.set(bytes.subarray(0, first), head)
    if (n > first) this.data.set(bytes.subarray(first, n), 0)
    Atomics.store(this.hdr, HEAD_IDX, (head + n) % this.capacity)
    // 唤醒阻塞在 head 上的消费者（如果有）。
    if (Atomics.load(this.hdr, WAITERS_IDX) > 0) {
      try {
        Atomics.notify(this.hdr, HEAD_IDX, +Infinity)
      } catch {
        /* 非 SAB 环境下 notify 会抛；忽略即可 */
      }
    }
    return n
  }

  close(): void {
    Atomics.store(this.hdr, CLOSED_IDX, 1)
    try {
      Atomics.notify(this.hdr, HEAD_IDX, +Infinity)
    } catch {
      /* 非 SAB 环境下 notify 会抛；忽略即可 */
    }
  }

  isClosed(): boolean {
    return Atomics.load(this.hdr, CLOSED_IDX) === 1
  }
}

/**
 * 消费者句柄——读 head、写 tail；`read()` 非阻塞，`readBlocking()` 在 Worker 内
 * 使用 `Atomics.wait` 真阻塞直到有数据或 ring 关闭。
 */
export class SabRingConsumer {
  private readonly hdr: Int32Array
  private readonly data: Uint8Array
  private readonly capacity: number

  constructor(handle: SabRingHandle) {
    this.hdr = new Int32Array(handle.buffer, 0, SAB_RING_HEADER_BYTES / 4)
    this.data = new Uint8Array(handle.buffer, SAB_RING_HEADER_BYTES, handle.capacity)
    this.capacity = handle.capacity
  }

  /** 可读字节数。 */
  readable(): number {
    const head = Atomics.load(this.hdr, HEAD_IDX)
    const tail = Atomics.load(this.hdr, TAIL_IDX)
    return (head - tail + this.capacity) % this.capacity
  }

  /** 非阻塞读；返回实际读取的字节数。 */
  read(out: Uint8Array): number {
    const avail = this.readable()
    if (avail === 0) return 0
    const n = Math.min(avail, out.byteLength)
    const tail = Atomics.load(this.hdr, TAIL_IDX)
    const first = Math.min(n, this.capacity - tail)
    out.set(this.data.subarray(tail, tail + first), 0)
    if (n > first) out.set(this.data.subarray(0, n - first), first)
    Atomics.store(this.hdr, TAIL_IDX, (tail + n) % this.capacity)
    return n
  }

  isClosed(): boolean {
    return Atomics.load(this.hdr, CLOSED_IDX) === 1
  }

  /**
   * Worker-only: 阻塞等待数据。返回 "ok"（有新数据）/"closed"/"timed-out"。
   * timeout 单位为毫秒，Infinity 表示永久。
   */
  readBlocking(
    out: Uint8Array,
    timeoutMs: number = Infinity,
  ): { bytes: number; status: 'ok' | 'closed' | 'timed-out' } {
    // 若已有数据直接返回
    const immediate = this.read(out)
    if (immediate > 0) return { bytes: immediate, status: 'ok' }
    if (this.isClosed()) return { bytes: 0, status: 'closed' }

    const head = Atomics.load(this.hdr, HEAD_IDX)
    Atomics.add(this.hdr, WAITERS_IDX, 1)
    try {
      // 仅在 head 未变时等待；expected 必须与快照一致。
      const res = Atomics.wait(this.hdr, HEAD_IDX, head, timeoutMs)
      if (res === 'timed-out') return { bytes: 0, status: 'timed-out' }
    } finally {
      Atomics.sub(this.hdr, WAITERS_IDX, 1)
    }

    const n = this.read(out)
    if (n > 0) return { bytes: n, status: 'ok' }
    return { bytes: 0, status: this.isClosed() ? 'closed' : 'ok' }
  }
}
