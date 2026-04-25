import type { TranspileResult } from './transpiler.types'

type CacheRecord = {
  key: string
  result: TranspileResult
}

type CacheStoreAdapter = {
  loadAll(): Promise<CacheRecord[]>
  put(record: CacheRecord): Promise<void>
  clear(): Promise<void>
}

function cacheKey(contentHash: string, optsHash: string): string {
  return `${contentHash}:${optsHash}`
}

async function openIndexedDBAdapter(
  dbName: string,
  storeName: string,
): Promise<CacheStoreAdapter | null> {
  if (typeof indexedDB === 'undefined') {
    return null
  }

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1)

    request.onupgradeneeded = () => {
      const upgradeDB = request.result
      if (!upgradeDB.objectStoreNames.contains(storeName)) {
        upgradeDB.createObjectStore(storeName, { keyPath: 'key' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to open transpile cache database'))
  })

  const withStore = <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode)
      const store = tx.objectStore(storeName)
      const request = run(store)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
    })
  }

  return {
    async loadAll(): Promise<CacheRecord[]> {
      const result = await withStore<CacheRecord[]>('readonly', store => store.getAll())
      return Array.isArray(result) ? result : []
    },
    async put(record: CacheRecord): Promise<void> {
      await withStore('readwrite', store => store.put(record))
    },
    async clear(): Promise<void> {
      await withStore('readwrite', store => store.clear())
    },
  }
}

export class TranspileCache {
  private readonly store = new Map<string, TranspileResult>()

  private constructor(private readonly adapter: CacheStoreAdapter | null) {}

  static async open(
    options: {
      dbName?: string
      storeName?: string
    } = {},
  ): Promise<TranspileCache> {
    const dbName = options.dbName ?? 'mars-web-transpiler-cache'
    const storeName = options.storeName ?? 'transpile-cache'

    let adapter: CacheStoreAdapter | null = null
    try {
      adapter = await openIndexedDBAdapter(dbName, storeName)
    } catch {
      adapter = null
    }

    const cache = new TranspileCache(adapter)
    if (adapter) {
      const records = await adapter.loadAll()
      for (const record of records) {
        cache.store.set(record.key, record.result)
      }
    }
    return cache
  }

  get(contentHash: string, optsHash: string): TranspileResult | null {
    return this.store.get(cacheKey(contentHash, optsHash)) ?? null
  }

  async set(contentHash: string, optsHash: string, result: TranspileResult): Promise<void> {
    const key = cacheKey(contentHash, optsHash)
    this.store.set(key, result)
    if (this.adapter) {
      await this.adapter.put({ key, result })
    }
  }

  async clear(): Promise<void> {
    this.store.clear()
    if (this.adapter) {
      await this.adapter.clear()
    }
  }
}