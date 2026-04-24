import { describe, expect, test } from 'vitest'

import type { CacheKeyValueStore } from '../../../packages/bun-web-vfs/src/cache-store'
import { PackageCacheStore } from '../../../packages/bun-web-vfs/src/cache-store'

class MemoryKVStore implements CacheKeyValueStore {
  private readonly map = new Map<string, Uint8Array>()

  async get(key: string): Promise<Uint8Array | null> {
    return this.map.get(key) ?? null
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.map.set(key, new Uint8Array(value))
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
}

class MemoryOPFS {
  private readonly map = new Map<string, Uint8Array>()

  readSync(path: string): Uint8Array {
    const found = this.map.get(path)
    if (!found) {
      const error = new Error('not found') as Error & { code?: string }
      error.code = 'ENOENT'
      throw error
    }
    return new Uint8Array(found)
  }

  writeSync(path: string, data: Uint8Array): void {
    this.map.set(path, new Uint8Array(data))
  }

  unlinkSync(path: string): void {
    this.map.delete(path)
  }

  has(path: string): boolean {
    return this.map.has(path)
  }
}

describe('bun-web M3 installer cache store', () => {
  test('set/get returns tarball via IndexedDB fast path', async () => {
    const kv = new MemoryKVStore()
    const store = new PackageCacheStore({ keyValueStore: kv })

    const payload = new Uint8Array([1, 2, 3])
    await store.setTarball('react@18.2.0', payload)

    const loaded = await store.getTarball('react@18.2.0')
    expect(Array.from(loaded ?? [])).toEqual([1, 2, 3])
    expect(store.getStats()).toEqual({
      indexedDBHits: 1,
      opfsHits: 0,
      misses: 0,
      writes: 1,
    })
  })

  test('OPFS miss fallback can warm IndexedDB cache', async () => {
    const kv = new MemoryKVStore()
    const opfs = new MemoryOPFS()
    const store = new PackageCacheStore({
      keyValueStore: kv,
      opfsAdapter: opfs,
      opfsRoot: '/cache',
    })

    opfs.writeSync('/cache/lodash%404.17.21.tgz', new Uint8Array([9, 9, 9]))

    const loaded = await store.getTarball('lodash@4.17.21')
    expect(Array.from(loaded ?? [])).toEqual([9, 9, 9])
    expect(store.getStats()).toEqual({
      indexedDBHits: 0,
      opfsHits: 1,
      misses: 0,
      writes: 0,
    })

    const second = await store.getTarball('lodash@4.17.21')
    expect(Array.from(second ?? [])).toEqual([9, 9, 9])
    expect(store.getStats().indexedDBHits).toBe(1)
  })

  test('deleteTarball removes cached entry from both layers', async () => {
    const kv = new MemoryKVStore()
    const opfs = new MemoryOPFS()
    const store = new PackageCacheStore({
      keyValueStore: kv,
      opfsAdapter: opfs,
      opfsRoot: '/cache',
    })

    await store.setTarball('vite@5.4.0', new Uint8Array([4, 5, 6]))
    expect(opfs.has('/cache/vite%405.4.0.tgz')).toBe(true)

    await store.deleteTarball('vite@5.4.0')

    expect(await store.getTarball('vite@5.4.0')).toBeNull()
    expect(opfs.has('/cache/vite%405.4.0.tgz')).toBe(false)
  })

  test('validates empty cache key and empty tarball', async () => {
    const store = new PackageCacheStore()

    await expect(store.getTarball('')).rejects.toThrowError('cacheKey must be a non-empty string')
    await expect(store.setTarball('abc', new Uint8Array())).rejects.toThrowError('tarball must not be empty')
  })
})