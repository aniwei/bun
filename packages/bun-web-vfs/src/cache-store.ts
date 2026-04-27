import { OPFSAdapter } from './opfs-adapter'

export interface CacheKeyValueStore {
  get(key: string): Promise<Uint8Array | null>
  set(key: string, value: Uint8Array): Promise<void>
  delete(key: string): Promise<void>
}

export type PackageCacheStoreStats = {
  indexedDBHits: number
  opfsHits: number
  misses: number
  writes: number
}

export type PackageCacheStoreOptions = {
  keyValueStore?: CacheKeyValueStore
  opfsAdapter?: Pick<OPFSAdapter, 'readSync' | 'writeSync' | 'unlinkSync'>
  opfsRoot?: string
}

type IndexedDBFactory = Pick<IDBFactory, 'open'>

class IndexedDBBackedStore implements CacheKeyValueStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(
    dbName = 'bun-web-package-cache',
    storeName = 'tarballs',
    factory = globalThis.indexedDB as IndexedDBFactory | undefined,
  ): Promise<IndexedDBBackedStore | null> {
    if (!factory) return null

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(dbName, 1)
      request.onupgradeneeded = () => {
        const result = request.result
        if (!result.objectStoreNames.contains(storeName)) {
          result.createObjectStore(storeName)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'))
    })

    return new IndexedDBBackedStore(db)
  }

  async get(key: string): Promise<Uint8Array | null> {
    const value = await this.readFromStore(key)
    if (!(value instanceof Uint8Array)) {
      return null
    }
    return value
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    await this.writeToStore(key, value)
  }

  async delete(key: string): Promise<void> {
    await this.deleteFromStore(key)
  }

  private async readFromStore(key: string): Promise<unknown> {
    return await this.withStore('readonly', store => store.get(key))
  }

  private async writeToStore(key: string, value: Uint8Array): Promise<void> {
    await this.withStore('readwrite', store => store.put(value, key))
  }

  private async deleteFromStore(key: string): Promise<void> {
    await this.withStore('readwrite', store => store.delete(key))
  }

  private async withStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const tx = this.db.transaction('tarballs', mode)
      const store = tx.objectStore('tarballs')
      const request = run(store)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
    })
  }
}

function normalizeRoot(path: string): string {
  if (!path) return '/.bun-web-cache/tarballs'
  if (path.startsWith('/')) return path
  return `/${path}`
}

function toStrictBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(input.byteLength)
  out.set(input)
  return out
}

function encodeCacheKey(key: string): string {
  return encodeURIComponent(key)
}

export class PackageCacheStore {
  private readonly opfsRoot: string
  private readonly stats: PackageCacheStoreStats = {
    indexedDBHits: 0,
    opfsHits: 0,
    misses: 0,
    writes: 0,
  }

  constructor(
    private readonly options: PackageCacheStoreOptions = {},
  ) {
    this.opfsRoot = normalizeRoot(options.opfsRoot ?? '/.bun-web-cache/tarballs')
  }

  static async create(options: PackageCacheStoreOptions = {}): Promise<PackageCacheStore> {
    if (options.keyValueStore) {
      return new PackageCacheStore(options)
    }

    const keyValueStore = await IndexedDBBackedStore.open()
    return new PackageCacheStore({
      ...options,
      keyValueStore: keyValueStore ?? undefined,
    })
  }

  getStats(): PackageCacheStoreStats {
    return { ...this.stats }
  }

  async getTarball(cacheKey: string): Promise<Uint8Array | null> {
    this.assertCacheKey(cacheKey)

    const idb = this.options.keyValueStore
    if (idb) {
      const value = await idb.get(cacheKey)
      if (value) {
        this.stats.indexedDBHits += 1
        return toStrictBytes(value)
      }
    }

    const opfs = this.options.opfsAdapter
    if (!opfs) {
      this.stats.misses += 1
      return null
    }

    try {
      const value = opfs.readSync(this.cachePath(cacheKey))
      this.stats.opfsHits += 1

      // Warm IndexedDB on OPFS hit to speed up subsequent reads.
      if (idb) {
        await idb.set(cacheKey, value)
      }

      return toStrictBytes(value)
    } catch {
      this.stats.misses += 1
      return null
    }
  }

  async setTarball(cacheKey: string, tarball: Uint8Array): Promise<void> {
    this.assertCacheKey(cacheKey)
    if (tarball.byteLength === 0) {
      throw new TypeError('tarball must not be empty')
    }

    const bytes = toStrictBytes(tarball)

    if (this.options.keyValueStore) {
      await this.options.keyValueStore.set(cacheKey, bytes)
    }

    if (this.options.opfsAdapter) {
      this.options.opfsAdapter.writeSync(this.cachePath(cacheKey), bytes)
    }

    this.stats.writes += 1
  }

  async deleteTarball(cacheKey: string): Promise<void> {
    this.assertCacheKey(cacheKey)

    if (this.options.keyValueStore) {
      await this.options.keyValueStore.delete(cacheKey)
    }

    if (this.options.opfsAdapter) {
      try {
        this.options.opfsAdapter.unlinkSync(this.cachePath(cacheKey))
      } catch {
        // Cache deletion is best-effort.
      }
    }
  }

  private cachePath(cacheKey: string): string {
    return `${this.opfsRoot}/${encodeCacheKey(cacheKey)}.tgz`
  }

  private assertCacheKey(cacheKey: string): void {
    if (!cacheKey || cacheKey.trim().length === 0) {
      throw new TypeError('cacheKey must be a non-empty string')
    }
  }
}