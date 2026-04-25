/**
 * M8-5 — memory-gc 单元测试
 *
 * 覆盖：
 * - LRU eviction（超容量时 evict 最久未使用）
 * - BlobURLRegistry create/register/release/touch/dispose
 * - ProcessHandleRegistry register/terminate/dispose
 * - MemoryGC snapshot/dispose
 *
 * 注意：测试环境（Node/Bun）没有真实的 URL.createObjectURL / revokeObjectURL；
 * 通过 stub 注入，验证是否在正确时机调用。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── URL.createObjectURL / revokeObjectURL stub ────────────────────────────────

let urlCounter = 0
const revokedUrls: string[] = []

const originalCreate = typeof URL !== 'undefined' ? URL.createObjectURL : undefined
const originalRevoke = typeof URL !== 'undefined' ? URL.revokeObjectURL : undefined

beforeEach(() => {
  urlCounter = 0
  revokedUrls.length = 0

  if (typeof URL !== 'undefined') {
    URL.createObjectURL = (_blob: Blob) => `blob:test-${++urlCounter}`
    URL.revokeObjectURL = (url: string) => { revokedUrls.push(url) }
  }
})

afterEach(() => {
  if (typeof URL !== 'undefined') {
    if (originalCreate) URL.createObjectURL = originalCreate
    if (originalRevoke) URL.revokeObjectURL = originalRevoke
  }
})

// ── 延迟 import（依赖 URL stub 先注入） ─────────────────────────────────────

async function loadModule() {
  const { BlobURLRegistry, ProcessHandleRegistry, MemoryGC } = await import(
    '../../../packages/bun-web-runtime/src/memory-gc.ts'
  )
  return { BlobURLRegistry, ProcessHandleRegistry, MemoryGC }
}

// ── BlobURLRegistry ───────────────────────────────────────────────────────────

describe('BlobURLRegistry – create / release', () => {
  it('create() returns a URL and registers it', async () => {
    const { BlobURLRegistry } = await loadModule()
    const registry = new BlobURLRegistry(10)
    const url = registry.create(new Blob(['content']), 'script')
    expect(url).toMatch(/^blob:/)
    expect(registry.size).toBe(1)
  })

  it('release() revokes the URL immediately', async () => {
    const { BlobURLRegistry } = await loadModule()
    const registry = new BlobURLRegistry(10)
    const url = registry.create(new Blob(['x']), 'module')
    registry.release(url)
    expect(registry.size).toBe(0)
    expect(revokedUrls).toContain(url)
  })

  it('release() on unknown URL is a no-op', async () => {
    const { BlobURLRegistry } = await loadModule()
    const registry = new BlobURLRegistry(10)
    expect(() => registry.release('blob:unknown')).not.toThrow()
  })

  it('register() accepts externally created URL', async () => {
    const { BlobURLRegistry } = await loadModule()
    const registry = new BlobURLRegistry(10)
    registry.register('blob:external', 'worker')
    expect(registry.size).toBe(1)
    registry.release('blob:external')
    expect(revokedUrls).toContain('blob:external')
  })

  it('dispose() revokes all URLs', async () => {
    const { BlobURLRegistry } = await loadModule()
    const registry = new BlobURLRegistry(10)
    const urls = [
      registry.create(new Blob(['a']), 'script'),
      registry.create(new Blob(['b']), 'script'),
      registry.create(new Blob(['c']), 'script'),
    ]
    registry.dispose()
    expect(registry.size).toBe(0)
    for (const url of urls) {
      expect(revokedUrls).toContain(url)
    }
  })
})

describe('BlobURLRegistry – LRU eviction', () => {
  it('evicts oldest URL when capacity exceeded', async () => {
    const { BlobURLRegistry } = await loadModule()
    const registry = new BlobURLRegistry(2) // 容量 2

    const url1 = registry.create(new Blob(['1']), 's')
    const url2 = registry.create(new Blob(['2']), 's')
    // 容量满，再加一个应 evict url1（最久未用）
    registry.create(new Blob(['3']), 's')

    expect(revokedUrls).toContain(url1)
    expect(revokedUrls).not.toContain(url2)
    expect(registry.size).toBe(2)
  })

  it('touch() prevents eviction of recently used URL', async () => {
    const { BlobURLRegistry } = await loadModule()
    const registry = new BlobURLRegistry(2)

    const url1 = registry.create(new Blob(['1']), 's')
    const url2 = registry.create(new Blob(['2']), 's')

    // touch url1，使其变为最近使用
    registry.touch(url1)

    // 再加一个，应 evict url2（现在是最久未用）
    registry.create(new Blob(['3']), 's')

    expect(revokedUrls).toContain(url2)
    expect(revokedUrls).not.toContain(url1)
  })
})

// ── ProcessHandleRegistry ─────────────────────────────────────────────────────

describe('ProcessHandleRegistry', () => {
  function makeFakeWorker(): Worker {
    const terminated: boolean[] = []
    const w = {
      terminate: () => { terminated.push(true) },
      _terminated: terminated,
    } as unknown as Worker
    // instanceof 检查绕不过去；通过 spy 代替
    Object.setPrototypeOf(w, Worker.prototype)
    return w
  }

  it('register() returns an ID', async () => {
    const { ProcessHandleRegistry } = await loadModule()
    const reg = new ProcessHandleRegistry()
    const id = reg.register(makeFakeWorker(), 'proc')
    expect(typeof id).toBe('string')
    expect(id).toContain('proc')
    expect(reg.size).toBe(1)
  })

  it('terminate() removes the handle and calls worker.terminate()', async () => {
    const { ProcessHandleRegistry } = await loadModule()
    const reg = new ProcessHandleRegistry()
    const w = makeFakeWorker()
    const id = reg.register(w, 'proc')
    const ok = reg.terminate(id)
    expect(ok).toBe(true)
    expect(reg.size).toBe(0)
    expect((w as unknown as { _terminated: boolean[] })._terminated.length).toBe(1)
  })

  it('terminate() returns false for unknown ID', async () => {
    const { ProcessHandleRegistry } = await loadModule()
    const reg = new ProcessHandleRegistry()
    expect(reg.terminate('unknown-999')).toBe(false)
  })

  it('listIds() returns all registered IDs', async () => {
    const { ProcessHandleRegistry } = await loadModule()
    const reg = new ProcessHandleRegistry()
    const id1 = reg.register(makeFakeWorker(), 'a')
    const id2 = reg.register(makeFakeWorker(), 'b')
    expect(reg.listIds()).toContain(id1)
    expect(reg.listIds()).toContain(id2)
  })

  it('dispose() terminates all workers', async () => {
    const { ProcessHandleRegistry } = await loadModule()
    const reg = new ProcessHandleRegistry()
    const w1 = makeFakeWorker()
    const w2 = makeFakeWorker()
    reg.register(w1, 'a')
    reg.register(w2, 'b')
    reg.dispose()
    expect(reg.size).toBe(0)
    expect((w1 as unknown as { _terminated: boolean[] })._terminated.length).toBe(1)
    expect((w2 as unknown as { _terminated: boolean[] })._terminated.length).toBe(1)
  })
})

// ── MemoryGC ──────────────────────────────────────────────────────────────────

describe('MemoryGC', () => {
  it('snapshot() reflects current resource counts', async () => {
    const { MemoryGC } = await loadModule()
    const gc = new MemoryGC(10)
    gc.blobURLs.create(new Blob(['x']), 'script')
    gc.blobURLs.create(new Blob(['y']), 'script')
    expect(gc.snapshot().blobURLs).toBe(2)
    expect(gc.snapshot().processHandles).toBe(0)
  })

  it('dispose() cleans all resources', async () => {
    const { MemoryGC } = await loadModule()
    const gc = new MemoryGC(10)
    const url = gc.blobURLs.create(new Blob(['z']), 'module')
    gc.dispose()
    expect(gc.snapshot().blobURLs).toBe(0)
    expect(revokedUrls).toContain(url)
  })
})
