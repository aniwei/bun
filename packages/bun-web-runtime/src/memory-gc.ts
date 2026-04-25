/**
 * memory-gc.ts（M8-5）
 *
 * Blob URL / 动态 import Blob URL / Worker URL 的 LRU 追踪与 GC 回收策略。
 *
 * 背景（RFC §13）：
 *   浏览器 runtime 在每次 `import()`、`new Worker()`、`URL.createObjectURL()` 时
 *   会生成 blob: URL，若不显式调用 `URL.revokeObjectURL()` 会导致内存持续膨胀。
 *
 * 策略：
 *   - 所有生成的 Blob URL 必须经由 BlobURLRegistry 登记
 *   - LRU 超出容量时自动 revoke 最久未使用的条目
 *   - 显式 release(url) 立即 revoke 并从 LRU 移除
 *   - 支持 dispose() 批量清理（容器关闭时调用）
 *   - processHandleRegistry：追踪 Worker/SharedWorker 句柄，确保关闭时 terminate()
 */

// ── LRU 链表节点 ──────────────────────────────────────────────────────────────

interface LRUNode<K, V> {
  key: K
  value: V
  prev: LRUNode<K, V> | null
  next: LRUNode<K, V> | null
}

// ── LRU Cache ─────────────────────────────────────────────────────────────────

class LRUCache<K, V> {
  private readonly capacity: number
  private readonly map: Map<K, LRUNode<K, V>> = new Map()
  private head: LRUNode<K, V> | null = null // 最近使用
  private tail: LRUNode<K, V> | null = null // 最久未使用

  private onEvict?: (key: K, value: V) => void

  constructor(capacity: number, onEvict?: (key: K, value: V) => void) {
    this.capacity = capacity
    this.onEvict = onEvict
  }

  get(key: K): V | undefined {
    const node = this.map.get(key);
    if (!node) return undefined;
    this.moveToHead(node);
    return node.value;
  }

  set(key: K, value: V): void {
    const existing = this.map.get(key);
    if (existing) {
      existing.value = value;
      this.moveToHead(existing);
      return;
    }

    const node: LRUNode<K, V> = { key, value, prev: null, next: null };
    this.map.set(key, node);
    this.addToHead(node);

    if (this.map.size > this.capacity) {
      const evicted = this.removeTail();
      if (evicted) {
        this.map.delete(evicted.key);
        this.onEvict?.(evicted.key, evicted.value);
      }
    }
  }

  delete(key: K): boolean {
    const node = this.map.get(key);
    if (!node) return false;
    this.removeNode(node);
    this.map.delete(key);
    return true;
  }

  clear(): void {
    // 按 tail→head 顺序 evict 所有条目
    let cur = this.tail;
    while (cur) {
      const prev = cur.prev;
      this.onEvict?.(cur.key, cur.value);
      cur = prev;
    }
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  get size(): number {
    return this.map.size;
  }

  // ── 链表操作 ──────────────────────────────────────────────────────────────

  private addToHead(node: LRUNode<K, V>): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private removeNode(node: LRUNode<K, V>): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  private moveToHead(node: LRUNode<K, V>): void {
    if (node === this.head) return;
    this.removeNode(node);
    this.addToHead(node);
  }

  private removeTail(): LRUNode<K, V> | null {
    const t = this.tail;
    if (!t) return null;
    this.removeNode(t);
    return t;
  }
}

// ── BlobURLRegistry ───────────────────────────────────────────────────────────

const DEFAULT_BLOB_URL_CAPACITY = 256;

/**
 * 管理 Blob URL 生命周期。
 *
 * 使用示例：
 * ```ts
 * const registry = new BlobURLRegistry()
 * const url = registry.create(blob, 'script')
 * // ... 使用 url ...
 * registry.release(url)
 * ```
 */
export class BlobURLRegistry {
  private readonly lru: LRUCache<string, { category: string }>

  constructor(capacity = DEFAULT_BLOB_URL_CAPACITY) {
    this.lru = new LRUCache<string, { category: string }>(capacity, (url) => {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // revokeObjectURL 不抛，但保险起见 catch
      }
    })
  }

  /**
   * 由 Blob 创建 URL 并登记到 LRU。
   * @param blob   - 要封装的 Blob
   * @param category - 调试标签（'script'|'worker'|'module'|'asset' 等）
   */
  create(blob: Blob, category: string = 'unknown'): string {
    const url = URL.createObjectURL(blob)
    this.lru.set(url, { category })
    return url
  }

  /**
   * 从已有字符串登记一个外部生成的 Blob URL（由调用方创建）。
   */
  register(url: string, category: string = 'unknown'): void {
    this.lru.set(url, { category })
  }

  /**
   * 立即 revoke 并从 LRU 中移除。
   */
  release(url: string): void {
    if (this.lru.delete(url)) {
      try {
        URL.revokeObjectURL(url)
      } catch {}
    }
  }

  /**
   * 标记 URL 为最近使用（防止 LRU 过早 evict）。
   */
  touch(url: string): void {
    this.lru.get(url) // get 会触发 moveToHead
  }

  /** 当前已登记的 Blob URL 数量 */
  get size(): number {
    return this.lru.size
  }

  /** 关闭：revoke 全部 */
  dispose(): void {
    this.lru.clear()
  }
}

// ── ProcessHandleRegistry ────────────────────────────────────────────────────

/**
 * 追踪 Worker / SharedWorker 句柄，确保容器关闭时全部 terminate。
 */
export class ProcessHandleRegistry {
  private readonly handles: Map<string, Worker | SharedWorker> = new Map()
  private idCounter = 0

  /**
   * 登记一个 Worker/SharedWorker 句柄。
   * @returns 句柄 ID，用于 release/terminate
   */
  register(worker: Worker | SharedWorker, label?: string): string {
    const id = `${label ?? 'worker'}-${++this.idCounter}`
    this.handles.set(id, worker)
    return id
  }

  /**
   * 终止指定 Worker 并从注册表中移除。
   */
  terminate(id: string): boolean {
    const w = this.handles.get(id)
    if (!w) return false
    try {
      if (w instanceof Worker) {
        w.terminate()
      }
      // SharedWorker 无法从外部 terminate；仅从注册表移除
    } catch {}
    this.handles.delete(id)
    return true
  }

  /** 返回所有已登记句柄 ID */
  listIds(): string[] {
    return [...this.handles.keys()]
  }

  /** 关闭：terminate 全部 Worker */
  dispose(): void {
    for (const [id, w] of this.handles) {
      try {
        if (w instanceof Worker) w.terminate()
      } catch {}
      this.handles.delete(id)
    }
  }

  get size(): number {
    return this.handles.size
  }
}

// ── MemoryGC（协调器） ────────────────────────────────────────────────────────

/**
 * MemoryGC — 统一资源回收协调器。
 *
 * 持有 BlobURLRegistry + ProcessHandleRegistry，
 * 在容器 shutdown() 时调用 dispose() 批量清理。
 */
export class MemoryGC {
  readonly blobURLs: BlobURLRegistry
  readonly processHandles: ProcessHandleRegistry

  constructor(blobURLCapacity = DEFAULT_BLOB_URL_CAPACITY) {
    this.blobURLs = new BlobURLRegistry(blobURLCapacity)
    this.processHandles = new ProcessHandleRegistry()
  }

  /**
   * 全量清理：revoke 所有 Blob URL、terminate 所有 Worker。
   * 通常在 BunContainer.shutdown() 时调用。
   */
  dispose(): void {
    this.blobURLs.dispose()
    this.processHandles.dispose()
  }

  /** 当前资源快照（用于监控/告警） */
  snapshot(): { blobURLs: number; processHandles: number } {
    return {
      blobURLs: this.blobURLs.size,
      processHandles: this.processHandles.size,
    }
  }
}
