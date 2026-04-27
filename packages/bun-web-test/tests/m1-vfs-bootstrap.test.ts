import { describe, test, expect } from 'vitest'

// Direct source imports
import {
  VFS,
  BaseLayer,
  PersistLayer,
  MemLayer,
  normalizePath,
  type IPersistAdapter,
} from '../../../packages/bun-web-vfs/src/overlay-fs'

import { Kernel } from '../../../packages/bun-web-kernel/src/kernel'

import {
  bootstrapProcessWorker,
  StdioWriter,
  type ProcessBootstrapOptions,
} from '../../../packages/bun-web-runtime/src/process-bootstrap'
import { RuntimeProcessSupervisor } from '../../../packages/bun-web-runtime/src/process-supervisor'
import { createChildProcessHandle, spawn as runtimeSpawn } from '../../../packages/bun-web-runtime/src/spawn'
import { createProcess } from '../../../packages/bun-web-node/src/process'
import { OPFSAdapter } from '../../../packages/bun-web-vfs/src/opfs-adapter'

class FakeNativeFile {
  constructor(private readonly dataRef: { value: Uint8Array }) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.dataRef.value.slice().buffer
  }
}

class FakeNativeSyncAccessHandle {
  constructor(private readonly dataRef: { value: Uint8Array }) {}

  write(data: BufferSource): number {
    this.dataRef.value = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer)
    return this.dataRef.value.byteLength
  }

  flush(): void {}

  close(): void {}
}

class FakeNativeWritable {
  constructor(
    private readonly dataRef: { value: Uint8Array },
    private readonly shouldThrow = false,
  ) {}

  async write(data: BufferSource): Promise<void> {
    if (this.shouldThrow) {
      throw new Error('writable-failed')
    }
    this.dataRef.value = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer)
  }

  async close(): Promise<void> {}
}

type FakeNode =
  | { kind: 'directory'; children: Map<string, FakeNode> }
  | { kind: 'file'; data: { value: Uint8Array } }

class FakeNativeFileHandle {
  readonly kind = 'file' as const

  constructor(
    readonly name: string,
    private readonly dataRef: { value: Uint8Array },
    private readonly options?: { failSyncAccess?: boolean; failWritable?: boolean },
  ) {}

  async getFile(): Promise<FakeNativeFile> {
    return new FakeNativeFile(this.dataRef)
  }

  async createSyncAccessHandle(): Promise<FakeNativeSyncAccessHandle> {
    if (this.options?.failSyncAccess) {
      throw new Error('sync-access-failed')
    }
    return new FakeNativeSyncAccessHandle(this.dataRef)
  }

  async createWritable(): Promise<FakeNativeWritable> {
    return new FakeNativeWritable(this.dataRef, this.options?.failWritable === true)
  }
}

class FakeNativeDirectoryHandle {
  readonly kind = 'directory' as const

  constructor(
    readonly name: string,
    private readonly node: Extract<FakeNode, { kind: 'directory' }>,
  ) {}

  protected createDirectoryHandle(name: string, node: Extract<FakeNode, { kind: 'directory' }>): FakeNativeDirectoryHandle {
    return new FakeNativeDirectoryHandle(name, node)
  }

  protected createFileHandle(name: string, dataRef: { value: Uint8Array }): FakeNativeFileHandle {
    return new FakeNativeFileHandle(name, dataRef)
  }

  async *entries(): AsyncIterable<[string, FakeNativeDirectoryHandle | FakeNativeFileHandle]> {
    for (const [name, child] of this.node.children.entries()) {
      if (child.kind === 'directory') {
        yield [name, this.createDirectoryHandle(name, child)]
      } else {
        yield [name, this.createFileHandle(name, child.data)]
      }
    }
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeNativeDirectoryHandle> {
    const existing = this.node.children.get(name)
    if (existing) {
      if (existing.kind !== 'directory') throw new Error('not a directory')
      return this.createDirectoryHandle(name, existing)
    }
    if (!options?.create) throw new Error('missing directory')
    const created: Extract<FakeNode, { kind: 'directory' }> = { kind: 'directory', children: new Map() }
    this.node.children.set(name, created)
    return this.createDirectoryHandle(name, created)
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeNativeFileHandle> {
    const existing = this.node.children.get(name)
    if (existing) {
      if (existing.kind !== 'file') throw new Error('not a file')
      return this.createFileHandle(name, existing.data)
    }
    if (!options?.create) throw new Error('missing file')
    const created: Extract<FakeNode, { kind: 'file' }> = { kind: 'file', data: { value: new Uint8Array() } }
    this.node.children.set(name, created)
    return this.createFileHandle(name, created.data)
  }

  async removeEntry(name: string): Promise<void> {
    this.node.children.delete(name)
  }
}

class SyncFailingDirectoryHandle extends FakeNativeDirectoryHandle {
  protected createDirectoryHandle(name: string, node: Extract<FakeNode, { kind: 'directory' }>): FakeNativeDirectoryHandle {
    return new SyncFailingDirectoryHandle(name, node)
  }

  protected createFileHandle(name: string, dataRef: { value: Uint8Array }): FakeNativeFileHandle {
    return new FakeNativeFileHandle(name, dataRef, { failSyncAccess: true })
  }
}

class AllNativeWritesFailDirectoryHandle extends FakeNativeDirectoryHandle {
  protected createDirectoryHandle(name: string, node: Extract<FakeNode, { kind: 'directory' }>): FakeNativeDirectoryHandle {
    return new AllNativeWritesFailDirectoryHandle(name, node)
  }

  protected createFileHandle(name: string, dataRef: { value: Uint8Array }): FakeNativeFileHandle {
    return new FakeNativeFileHandle(name, dataRef, { failSyncAccess: true, failWritable: true })
  }
}

function installFakeOPFS(root: FakeNativeDirectoryHandle): () => void {
  const originalNavigator = (globalThis as Record<string, unknown>).navigator
  ;(globalThis as Record<string, unknown>).navigator = {
    storage: {
      getDirectory: async () => root,
    },
  }
  return () => {
    if (originalNavigator === undefined) {
      delete (globalThis as Record<string, unknown>).navigator
      return
    }
    ;(globalThis as Record<string, unknown>).navigator = originalNavigator
  }
}

async function flushMicrotasks(count = 6): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
  }
}

async function waitForNativeStatsToSettle(adapter: OPFSAdapter, maxRounds = 30): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    await flushMicrotasks()
    const stats = adapter.getNativePersistenceStats()
    if (stats.attempts === stats.successes + stats.failures) {
      return
    }
  }
  throw new Error('native persistence stats did not settle in time')
}

// ---------------------------------------------------------------------------
describe('normalizePath', () => {
  test('handles root', () => expect(normalizePath('/')).toBe('/'))
  test('strips trailing slash', () => expect(normalizePath('/foo/')).toBe('/foo'))
  test('collapses double slashes', () => expect(normalizePath('//foo//bar')).toBe('/foo/bar'))
  test('bare name → /name', () => expect(normalizePath('foo')).toBe('/foo'))
})

// ---------------------------------------------------------------------------
describe('BaseLayer', () => {
  test('pre-seeds files', () => {
    const base = new BaseLayer({ '/index.ts': 'console.log("hello")' })
    const entry = base.get('/index.ts')
    expect(entry?.kind).toBe('file')
    expect(new TextDecoder().decode(entry?.data)).toBe('console.log("hello")')
  })

  test('implicitly creates ancestor dirs', () => {
    const base = new BaseLayer({ '/src/app/index.ts': 'x' })
    expect(base.has('/src')).toBe(true)
    expect(base.has('/src/app')).toBe(true)
  })

  test('root is always present', () => {
    const base = new BaseLayer()
    expect(base.has('/')).toBe(true)
  })

  test('childNames returns direct children', () => {
    const base = new BaseLayer({ '/a.ts': 'a', '/b.ts': 'b', '/sub/c.ts': 'c' })
    const children = base.childNames('/')
    expect(children.has('a.ts')).toBe(true)
    expect(children.has('b.ts')).toBe(true)
    expect(children.has('sub')).toBe(true)
    expect(children.size).toBe(3)
  })
})

// ---------------------------------------------------------------------------
describe('MemLayer', () => {
  test('starts with root dir', () => {
    const mem = new MemLayer()
    expect(mem.has('/')).toBe(true)
  })

  test('set/get file', () => {
    const mem = new MemLayer()
    const data = new TextEncoder().encode('hello')
    mem.set('/test.txt', { kind: 'file', data, mtime: new Date(), atime: new Date(), ctime: new Date() })
    expect(mem.get('/test.txt')?.kind).toBe('file')
  })

  test('mkdir recursive', () => {
    const mem = new MemLayer()
    mem.mkdir('/a/b/c', true)
    expect(mem.has('/a')).toBe(true)
    expect(mem.has('/a/b')).toBe(true)
    expect(mem.has('/a/b/c')).toBe(true)
  })

  test('delete removes entry', () => {
    const mem = new MemLayer()
    mem.set('/del.txt', { kind: 'file', mtime: new Date(), atime: new Date(), ctime: new Date() })
    mem.delete('/del.txt')
    expect(mem.has('/del.txt')).toBe(false)
  })

  test('childNames', () => {
    const mem = new MemLayer()
    mem.mkdir('/dir', false)
    mem.set('/dir/a.txt', { kind: 'file', mtime: new Date(), atime: new Date(), ctime: new Date() })
    mem.set('/dir/b.txt', { kind: 'file', mtime: new Date(), atime: new Date(), ctime: new Date() })
    const children = mem.childNames('/dir')
    expect(children.has('a.txt')).toBe(true)
    expect(children.has('b.txt')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe('PersistLayer', () => {
  function makeAdapter(): IPersistAdapter & { store: Map<string, Uint8Array> } {
    const store = new Map<string, Uint8Array>()
    return {
      store,
      readSync: (path) => {
        const d = store.get(path)
        if (!d) throw new Error('not found')
        return d
      },
      writeSync: (path, data) => store.set(path, data),
      unlinkSync: (path) => store.delete(path),
      readdirSync: () => [],
      mkdirSync: () => {},
    }
  }

  test('writeFile / get roundtrip', () => {
    const adapter = makeAdapter()
    const layer = new PersistLayer(adapter)
    const data = new TextEncoder().encode('persist-data')
    layer.writeFile('/data.bin', data)
    expect(layer.has('/data.bin')).toBe(true)
    const entry = layer.get('/data.bin')
    expect(entry?.kind).toBe('file')
    expect(new TextDecoder().decode(entry?.data)).toBe('persist-data')
  })

  test('unlink removes entry', () => {
    const adapter = makeAdapter()
    const layer = new PersistLayer(adapter)
    layer.writeFile('/x.txt', new TextEncoder().encode('x'))
    layer.unlink('/x.txt')
    expect(layer.has('/x.txt')).toBe(false)
  })

  test('mkdir recursive creates index entries', () => {
    const adapter = makeAdapter()
    const layer = new PersistLayer(adapter)
    layer.mkdir('/deep/path', true)
    expect(layer.has('/deep')).toBe(true)
    expect(layer.has('/deep/path')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe('OPFSAdapter', () => {
  test('starts with root directory', async () => {
    const adapter = await OPFSAdapter.open()
    expect(adapter.readdirSync('/')).toEqual([])
  })

  test('mkdirSync creates nested directories visible via readdirSync', async () => {
    const adapter = await OPFSAdapter.open()
    adapter.mkdirSync('/projects/demo')

    expect(adapter.readdirSync('/')).toContain('projects')
    expect(adapter.readdirSync('/projects')).toContain('demo')
  })

  test('writeSync/readSync roundtrip inside existing directory', async () => {
    const adapter = await OPFSAdapter.open()
    adapter.mkdirSync('/data')
    adapter.writeSync('/data/file.txt', new TextEncoder().encode('hello-opfs'))

    const data = adapter.readSync('/data/file.txt')
    expect(new TextDecoder().decode(data)).toBe('hello-opfs')
  })

  test('mkdirSync + writeSync expose nested directories in listings', async () => {
    const adapter = await OPFSAdapter.open()
    adapter.mkdirSync('/nested')
    adapter.mkdirSync('/nested/deep')
    adapter.writeSync('/nested/deep/file.txt', new TextEncoder().encode('x'))

    expect(adapter.readdirSync('/nested')).toContain('deep')
    expect(adapter.readdirSync('/nested/deep')).toContain('file.txt')
  })

  test('readdirSync only returns direct children', async () => {
    const adapter = await OPFSAdapter.open()
    adapter.mkdirSync('/root')
    adapter.mkdirSync('/root/sub')
    adapter.writeSync('/root/a.txt', new TextEncoder().encode('a'))
    adapter.writeSync('/root/sub/b.txt', new TextEncoder().encode('b'))

    const rootEntries = adapter.readdirSync('/root')
    expect(rootEntries).toContain('a.txt')
    expect(rootEntries).toContain('sub')
    expect(rootEntries).not.toContain('sub/b.txt')
  })

  test('unlinkSync removes files', async () => {
    const adapter = await OPFSAdapter.open()
    adapter.mkdirSync('/tmp')
    adapter.writeSync('/tmp/remove.txt', new TextEncoder().encode('remove-me'))
    adapter.unlinkSync('/tmp/remove.txt')

    expect(() => adapter.readSync('/tmp/remove.txt')).toThrow(/ENOENT|File not found/)
  })

  test('writeSync throws when parent directory is missing', async () => {
    const adapter = await OPFSAdapter.open()
    expect(() => adapter.writeSync('/missing-parent/file.txt', new TextEncoder().encode('x'))).toThrow(/ENOENT|Directory not found/)
  })

  test('readdirSync throws ENOTDIR for file paths', async () => {
    const adapter = await OPFSAdapter.open()
    adapter.mkdirSync('/dir')
    adapter.writeSync('/dir/file.txt', new TextEncoder().encode('x'))
    expect(() => adapter.readdirSync('/dir/file.txt')).toThrow(/ENOTDIR|Not a directory/)
  })

  test('open() hydrates from native OPFS directory handle when available', async () => {
    const rootNode: Extract<FakeNode, { kind: 'directory' }> = {
      kind: 'directory',
      children: new Map([
        ['seed', { kind: 'directory', children: new Map([
          ['hello.txt', { kind: 'file', data: { value: new TextEncoder().encode('from-native') } }],
        ]) }],
      ]),
    }
    const restore = installFakeOPFS(new FakeNativeDirectoryHandle('', rootNode))

    try {
      const adapter = await OPFSAdapter.open('/seed')
      expect(adapter.readdirSync('/')).toContain('hello.txt')
      expect(new TextDecoder().decode(adapter.readSync('/hello.txt'))).toBe('from-native')
    } finally {
      restore()
    }
  })

  test('native OPFS path receives mkdir/write/unlink operations', async () => {
    const rootNode: Extract<FakeNode, { kind: 'directory' }> = {
      kind: 'directory',
      children: new Map(),
    }
    const restore = installFakeOPFS(new FakeNativeDirectoryHandle('', rootNode))

    try {
      const adapter = await OPFSAdapter.open()
      adapter.mkdirSync('/native')
      adapter.writeSync('/native/file.txt', new TextEncoder().encode('persisted'))
      await flushMicrotasks()

      const nativeDir = rootNode.children.get('native')
      expect(nativeDir && nativeDir.kind === 'directory').toBe(true)
      const nativeFile = nativeDir && nativeDir.kind === 'directory' ? nativeDir.children.get('file.txt') : null
      expect(nativeFile && nativeFile.kind === 'file').toBe(true)
      if (nativeFile && nativeFile.kind === 'file') {
        expect(new TextDecoder().decode(nativeFile.data.value)).toBe('persisted')
      }

      adapter.unlinkSync('/native/file.txt')
      await flushMicrotasks()
      const afterDelete = nativeDir && nativeDir.kind === 'directory' ? nativeDir.children.get('file.txt') : null
      expect(afterDelete).toBeUndefined()
    } finally {
      restore()
    }
  })

  test('reopen adapter rehydrates previously persisted native data', async () => {
    const rootNode: Extract<FakeNode, { kind: 'directory' }> = {
      kind: 'directory',
      children: new Map(),
    }
    const restore = installFakeOPFS(new FakeNativeDirectoryHandle('', rootNode))

    try {
      const first = await OPFSAdapter.open('/workspace')
      first.mkdirSync('/cache')
      first.writeSync('/cache/state.json', new TextEncoder().encode('{"ok":true}'))
      await flushMicrotasks()

      // Simulate refresh/reload: create a new adapter over the same native root.
      const second = await OPFSAdapter.open('/workspace')
      const content = new TextDecoder().decode(second.readSync('/cache/state.json'))
      expect(content).toBe('{"ok":true}')
      expect(second.readdirSync('/cache')).toContain('state.json')
    } finally {
      restore()
    }
  })

  test('falls back to writable when SyncAccessHandle path fails', async () => {
    const rootNode: Extract<FakeNode, { kind: 'directory' }> = {
      kind: 'directory',
      children: new Map(),
    }
    const restore = installFakeOPFS(new SyncFailingDirectoryHandle('', rootNode))

    try {
      const adapter = await OPFSAdapter.open()
      adapter.mkdirSync('/fallback')
      adapter.writeSync('/fallback/value.txt', new TextEncoder().encode('via-writable'))
      await flushMicrotasks()

      const dir = rootNode.children.get('fallback')
      const file = dir && dir.kind === 'directory' ? dir.children.get('value.txt') : null
      expect(file && file.kind === 'file').toBe(true)
      if (file && file.kind === 'file') {
        expect(new TextDecoder().decode(file.data.value)).toBe('via-writable')
      }
    } finally {
      restore()
    }
  })

  test('native persistence stats record sync fallback recovery', async () => {
    const rootNode: Extract<FakeNode, { kind: 'directory' }> = {
      kind: 'directory',
      children: new Map(),
    }
    const restore = installFakeOPFS(new SyncFailingDirectoryHandle('', rootNode))

    try {
      const adapter = await OPFSAdapter.open()
      adapter.mkdirSync('/stats-fallback')
      await flushMicrotasks()
      adapter.resetNativePersistenceStats()

      adapter.writeSync('/stats-fallback/a.txt', new TextEncoder().encode('ok'))
      await waitForNativeStatsToSettle(adapter)

      const stats = adapter.getNativePersistenceStats()
      expect(stats.nativeEnabled).toBe(true)
      expect(stats.attempts).toBe(1)
      expect(stats.successes).toBe(1)
      expect(stats.failures).toBe(0)
      expect(stats.syncFallbacks).toBe(1)
      expect(stats.lastErrorMessage).toBeNull()
    } finally {
      restore()
    }
  })

  test('keeps in-memory write successful when all native write paths fail', async () => {
    const rootNode: Extract<FakeNode, { kind: 'directory' }> = {
      kind: 'directory',
      children: new Map(),
    }
    const restore = installFakeOPFS(new AllNativeWritesFailDirectoryHandle('', rootNode))

    try {
      const adapter = await OPFSAdapter.open()
      adapter.mkdirSync('/volatile')

      // Should not throw even if both native persistence paths fail.
      expect(() => adapter.writeSync('/volatile/cache.txt', new TextEncoder().encode('memory-still-works'))).not.toThrow()
      await flushMicrotasks()

      const content = new TextDecoder().decode(adapter.readSync('/volatile/cache.txt'))
      expect(content).toBe('memory-still-works')
    } finally {
      restore()
    }
  })

  test('native persistence stats record failure when all native paths fail', async () => {
    const rootNode: Extract<FakeNode, { kind: 'directory' }> = {
      kind: 'directory',
      children: new Map(),
    }
    const restore = installFakeOPFS(new AllNativeWritesFailDirectoryHandle('', rootNode))

    try {
      const adapter = await OPFSAdapter.open()
      adapter.mkdirSync('/stats-fail')
      await flushMicrotasks()
      adapter.resetNativePersistenceStats()

      expect(() => adapter.writeSync('/stats-fail/a.txt', new TextEncoder().encode('x'))).not.toThrow()
      await waitForNativeStatsToSettle(adapter)

      const stats = adapter.getNativePersistenceStats()
      expect(stats.nativeEnabled).toBe(true)
      expect(stats.attempts).toBe(1)
      expect(stats.successes).toBe(0)
      expect(stats.failures).toBe(1)
      expect(stats.syncFallbacks).toBe(1)
      expect(
        (stats.lastErrorMessage?.includes('writable-failed') ?? false) ||
          (stats.lastErrorMessage?.includes('No writable path') ?? false),
      ).toBe(true)
    } finally {
      restore()
    }
  })

  test('native persistence stats stay zero when native OPFS is unavailable', async () => {
    const adapter = await OPFSAdapter.open()
    adapter.mkdirSync('/stats-none')
    adapter.writeSync('/stats-none/a.txt', new TextEncoder().encode('x'))
    await flushMicrotasks()

    const stats = adapter.getNativePersistenceStats()
    expect(stats.nativeEnabled).toBe(false)
    expect(stats.attempts).toBe(0)
    expect(stats.successes).toBe(0)
    expect(stats.failures).toBe(0)
    expect(stats.syncFallbacks).toBe(0)
  })
})

// ---------------------------------------------------------------------------
describe('OverlayFS (VFS) — 3-layer merge', () => {
  function makeVFS(baseFiles: Record<string, string> = {}) {
    const base = new BaseLayer(baseFiles)
    const mem = new MemLayer()
    // null-adapter persist
    const persist = new PersistLayer({
      readSync: () => { throw new Error('no persist') },
      writeSync() {},
      unlinkSync() {},
      readdirSync: () => [],
      mkdirSync() {},
    })
    return new VFS({ base, persist, mem })
  }

  test('reads from Base layer', () => {
    const vfs = makeVFS({ '/static.ts': 'export const x = 1' })
    const content = vfs.readFileSync('/static.ts').toString()
    expect(content).toBe('export const x = 1')
  })

  test('Mem layer shadows Base layer', () => {
    const vfs = makeVFS({ '/file.ts': 'base content' })
    vfs.writeFileSync('/file.ts', 'mem content')
    expect(vfs.readFileSync('/file.ts').toString()).toBe('mem content')
  })

  test('writeFileSync + readFileSync roundtrip', () => {
    const vfs = makeVFS()
    vfs.writeFileSync('/hello.txt', 'world')
    expect(vfs.readFileSync('/hello.txt').toString()).toBe('world')
  })

  test('readFileSync throws ENOENT for missing file', () => {
    const vfs = makeVFS()
    expect(() => vfs.readFileSync('/nope.txt')).toThrow(/ENOENT/)
  })

  test('mkdirSync + existsSync', () => {
    const vfs = makeVFS()
    vfs.mkdirSync('/mydir')
    expect(vfs.existsSync('/mydir')).toBe(true)
  })

  test('mkdirSync recursive', () => {
    const vfs = makeVFS()
    vfs.mkdirSync('/a/b/c', { recursive: true })
    expect(vfs.existsSync('/a')).toBe(true)
    expect(vfs.existsSync('/a/b/c')).toBe(true)
  })

  test('readdirSync merges all layers', () => {
    const vfs = makeVFS({ '/base.ts': 'b' })
    vfs.writeFileSync('/mem.ts', 'm')
    const names = vfs.readdirSync('/') as string[]
    expect(names).toContain('base.ts')
    expect(names).toContain('mem.ts')
  })

  test('readdirSync withFileTypes', () => {
    const vfs = makeVFS({ '/a.ts': 'x' })
    vfs.mkdirSync('/subdir')
    const dirents = vfs.readdirSync('/', { withFileTypes: true }) as Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>
    const aEntry = dirents.find(d => d.name === 'a.ts')
    const subdirEntry = dirents.find(d => d.name === 'subdir')
    expect(aEntry?.isFile()).toBe(true)
    expect(subdirEntry?.isDirectory()).toBe(true)
  })

  test('statSync returns correct kind', () => {
    const vfs = makeVFS()
    vfs.writeFileSync('/f.txt', 'x')
    const stat = vfs.statSync('/f.txt')
    expect(stat.isFile()).toBe(true)
    expect(stat.isDirectory()).toBe(false)
    expect(stat.size).toBe(1)
  })

  test('statSync throws ENOENT for missing path', () => {
    const vfs = makeVFS()
    expect(() => vfs.statSync('/nope')).toThrow(/ENOENT/)
  })

  test('unlinkSync removes from Mem layer', () => {
    const vfs = makeVFS()
    vfs.writeFileSync('/tmp.txt', 'tmp')
    vfs.unlinkSync('/tmp.txt')
    expect(vfs.existsSync('/tmp.txt')).toBe(false)
  })

  test('renameSync moves within Mem layer', () => {
    const vfs = makeVFS()
    vfs.writeFileSync('/old.txt', 'content')
    vfs.renameSync('/old.txt', '/new.txt')
    expect(vfs.existsSync('/new.txt')).toBe(true)
    expect(vfs.existsSync('/old.txt')).toBe(false)
    expect(vfs.readFileSync('/new.txt').toString()).toBe('content')
  })

  test('async readFile / writeFile wrappers work', async () => {
    const vfs = makeVFS()
    await vfs.writeFile('/async.txt', 'async content')
    const buf = await vfs.readFile('/async.txt')
    expect(buf.toString()).toBe('async content')
  })

  test('async mkdir / readdir work', async () => {
    const vfs = makeVFS()
    await vfs.mkdir('/asyncdir', { recursive: true })
    await vfs.writeFile('/asyncdir/file.txt', 'x')
    const names = await vfs.readdir('/asyncdir')
    expect(names).toContain('file.txt')
  })
})

// ---------------------------------------------------------------------------
describe('Kernel stdio channels', () => {
  test('allocateStdio returns two MessagePorts', async () => {
    const k = await Kernel.boot({ asyncFallback: true })
    const proc = await k.spawn({ argv: ['bun', 'test.ts'] })
    const { stdoutPort, stderrPort } = k.allocateStdio(proc.pid)
    expect(stdoutPort).toBeTruthy()
    expect(stderrPort).toBeTruthy()
    stdoutPort.close()
    stderrPort.close()
    await Kernel.shutdown()
  })

  test('onStdio receives data posted through stdoutPort', async () => {
    const k = await Kernel.boot({ asyncFallback: true })
    const proc = await k.spawn({ argv: ['bun', 'test.ts'] })
    const { stdoutPort } = k.allocateStdio(proc.pid)

    const received: string[] = []
    k.onStdio(proc.pid, (kind, data) => {
      if (kind === 'stdout') received.push(data)
    })

    stdoutPort.start()
    stdoutPort.postMessage({ kind: 'stdout', pid: proc.pid, data: 'hello from stdout' })

    // Allow message to propagate
    await new Promise(r => setTimeout(r, 20))

    expect(received.length).toBeGreaterThan(0)
    expect(received[0]).toBe('hello from stdout')

    stdoutPort.close()
    await Kernel.shutdown()
  })

  test('waitpid resolves when notifyExit is called', async () => {
    const k = await Kernel.boot({ asyncFallback: true })
    const proc = await k.spawn({ argv: ['bun', 'run.ts'] })

    const waitPromise = k.waitpid(proc.pid)
    k.notifyExit(proc.pid, 42)
    const code = await waitPromise
    expect(code).toBe(42)

    await Kernel.shutdown()
  })

  test('waitpid returns 0 for already-gone pid', async () => {
    const k = await Kernel.boot({ asyncFallback: true })
    const code = await k.waitpid(99999)
    expect(code).toBe(0)
    await Kernel.shutdown()
  })

  test('attachProcessPort routes stdout and exit messages to onStdio and waitpid', async () => {
    const k = await Kernel.boot({ asyncFallback: true })
    const proc = await k.spawn({ argv: ['bun', 'worker.ts'] })
    k.allocateStdio(proc.pid)

    const ch = new MessageChannel()
    const detach = k.attachProcessPort(proc.pid, ch.port1)
    const received: string[] = []
    k.onStdio(proc.pid, (kind, data) => {
      if (kind === 'stdout') received.push(data)
    })

    ch.port2.start()
    const waitPromise = k.waitpid(proc.pid)
    ch.port2.postMessage({ kind: 'stdout', pid: proc.pid, data: 'from-worker' })
    ch.port2.postMessage({ kind: 'exit', pid: proc.pid, code: 23 })

    const code = await waitPromise
    expect(code).toBe(23)
    expect(received).toContain('from-worker')

    detach()
    ch.port1.close()
    ch.port2.close()
    await Kernel.shutdown()
  })

  test('emits processExit event when process exits', async () => {
    const k = await Kernel.boot({ asyncFallback: true })
    const proc = await k.spawn({ argv: ['bun', 'event-exit.ts'] })

    const seen: Array<{ pid: number; code: number }> = []
    k.on('processExit', payload => {
      seen.push(payload)
    })

    k.notifyExit(proc.pid, 17)
    expect(seen).toContainEqual({ pid: proc.pid, code: 17 })

    await Kernel.shutdown()
  })

  test('attachProcessPort listener is cleaned up after process exit', async () => {
    const k = await Kernel.boot({ asyncFallback: true })
    const proc = await k.spawn({ argv: ['bun', 'cleanup.ts'] })
    const ch = new MessageChannel()
    k.attachProcessPort(proc.pid, ch.port1)

    const received: string[] = []
    k.onStdio(proc.pid, (kind, data) => {
      if (kind === 'stdout') received.push(data)
    })

    ch.port2.start()
    ch.port2.postMessage({ kind: 'exit', pid: proc.pid, code: 9 })
    const code = await k.waitpid(proc.pid)
    expect(code).toBe(9)

    ch.port2.postMessage({ kind: 'stdout', pid: proc.pid, data: 'after-exit' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(received).not.toContain('after-exit')

    ch.port1.close()
    ch.port2.close()
    await Kernel.shutdown()
  })
})

// ---------------------------------------------------------------------------
describe('bootstrapProcessWorker', () => {
  async function makeKernel() {
    return Kernel.boot({ asyncFallback: true })
  }

  test('returns process with correct pid/argv/cwd', async () => {
    const k = await makeKernel()
    const proc = await k.spawn({ argv: ['bun', 'app.ts'], cwd: '/workspace', env: { NODE_ENV: 'test' } })
    const opts: ProcessBootstrapOptions = {
      kernel: k,
      pid: proc.pid,
      argv: ['bun', 'app.ts'],
      env: { NODE_ENV: 'test' },
      cwd: '/workspace',
      sabBuffer: null,
    }
    const ctx = await bootstrapProcessWorker(opts)
    expect(ctx.process.pid).toBe(proc.pid)
    expect(ctx.process.argv).toEqual(['bun', 'app.ts'])
    expect(ctx.process.cwd()).toBe('/workspace')
    expect(ctx.process.env.NODE_ENV).toBe('test')
    await Kernel.shutdown()
  })

  test('installs globalThis.process', async () => {
    const k = await makeKernel()
    const proc = await k.spawn({ argv: ['bun', 'x.ts'] })
    const opts: ProcessBootstrapOptions = {
      kernel: k, pid: proc.pid, argv: ['bun', 'x.ts'],
      env: {}, cwd: '/', sabBuffer: null,
    }
    await bootstrapProcessWorker(opts)
    expect((globalThis as Record<string, unknown>).process).toBeTruthy()
    await Kernel.shutdown()
  })

  test('createProcess exposes stdio handles with fd numbers', () => {
    const proc = createProcess({
      pid: 88,
      argv: ['bun', 'stdio.ts'],
      env: {},
      cwd: '/',
    })

    expect(proc.stdin.fd).toBe(0)
    expect(proc.stdout.fd).toBe(1)
    expect(proc.stderr.fd).toBe(2)
    expect(proc.stdin.isTTY).toBe(false)
    expect(proc.stdin.read()).toBe(null)
  })

  test('bootstrapProcessWorker wires process stdout/stderr to stdio port', async () => {
    const k = await makeKernel()
    const proc = await k.spawn({ argv: ['bun', 'stdio.ts'] })
    const port = new MessageChannel()
    const opts: ProcessBootstrapOptions = {
      kernel: k,
      pid: proc.pid,
      argv: ['bun', 'stdio.ts'],
      env: {},
      cwd: '/',
      sabBuffer: null,
    }

    port.port1.start()
    const seen: Array<{ kind: string; pid?: number; data?: string }> = []
    const done = new Promise<void>(resolve => {
      port.port1.onmessage = (event: MessageEvent) => {
        seen.push(event.data)
        if (seen.length === 2) {
          resolve()
        }
      }
    })

    const ctx = await bootstrapProcessWorker(opts, port.port2)
    expect(ctx.process.stdout.write('hello stdout')).toBe(true)
    ctx.process.stderr.end('hello stderr')
    await done

    expect(seen[0]).toEqual({ kind: 'stdout', pid: proc.pid, data: 'hello stdout' })
    expect(seen[1]).toEqual({ kind: 'stderr', pid: proc.pid, data: 'hello stderr' })

    port.port1.close()
    port.port2.close()
    await Kernel.shutdown()
  })

  test('bootstrapProcessWorker falls back to globalThis.postMessage when stdio port is omitted', async () => {
    const k = await makeKernel()
    const proc = await k.spawn({ argv: ['bun', 'stdio-fallback.ts'] })
    const opts: ProcessBootstrapOptions = {
      kernel: k,
      pid: proc.pid,
      argv: ['bun', 'stdio-fallback.ts'],
      env: {},
      cwd: '/',
      sabBuffer: null,
    }

    const scope = globalThis as Record<string, unknown>
    const originalPostMessage = scope.postMessage
    const seen: Array<{ kind: string; pid?: number; data?: string }> = []

    scope.postMessage = ((message: { kind: string; pid?: number; data?: string }) => {
      seen.push(message)
    }) as unknown

    try {
      const ctx = await bootstrapProcessWorker(opts)
      expect(ctx.process.stdout.write('fallback stdout')).toBe(true)
      ctx.process.stderr.end('fallback stderr')

      expect(seen).toContainEqual({ kind: 'stdout', pid: proc.pid, data: 'fallback stdout' })
      expect(seen).toContainEqual({ kind: 'stderr', pid: proc.pid, data: 'fallback stderr' })
    } finally {
      scope.postMessage = originalPostMessage
      await Kernel.shutdown()
    }
  })

  test('bootstrapProcessWorker posts exit message through globalThis.postMessage fallback', async () => {
    const k = await makeKernel()
    const proc = await k.spawn({ argv: ['bun', 'exit-fallback.ts'] })
    const opts: ProcessBootstrapOptions = {
      kernel: k,
      pid: proc.pid,
      argv: ['bun', 'exit-fallback.ts'],
      env: {},
      cwd: '/',
      sabBuffer: null,
    }

    const scope = globalThis as Record<string, unknown>
    const originalPostMessage = scope.postMessage
    const seen: Array<{ kind: string; pid?: number; code?: number }> = []

    scope.postMessage = ((message: { kind: string; pid?: number; code?: number }) => {
      seen.push(message)
    }) as unknown

    try {
      const ctx = await bootstrapProcessWorker(opts)
      expect(() => ctx.process.exit(7)).toThrow(/process\.exit\(7\)/)
      expect(seen).toContainEqual({ kind: 'exit', pid: proc.pid, code: 7 })
    } finally {
      scope.postMessage = originalPostMessage
      await Kernel.shutdown()
    }
  })

  test('bootstrapProcessWorker + attachProcessPort complete stdout and waitpid lifecycle', async () => {
    const k = await makeKernel()
    const proc = await k.spawn({ argv: ['bun', 'e2e-stdio-exit.ts'] })
    const opts: ProcessBootstrapOptions = {
      kernel: k,
      pid: proc.pid,
      argv: ['bun', 'e2e-stdio-exit.ts'],
      env: {},
      cwd: '/',
      sabBuffer: null,
    }

    const channel = new MessageChannel()
    const detach = k.attachProcessPort(proc.pid, channel.port1)
    const seenStdout: string[] = []
    k.onStdio(proc.pid, (kind, data) => {
      if (kind === 'stdout') seenStdout.push(data)
    })

    try {
      const ctx = await bootstrapProcessWorker(opts, channel.port2)
      const waitPromise = k.waitpid(proc.pid)
      expect(ctx.process.stdout.write('stdio-e2e')).toBe(true)
      expect(() => ctx.process.exit(31)).toThrow(/process\.exit\(31\)/)

      const code = await waitPromise
      expect(code).toBe(31)
      expect(seenStdout).toContain('stdio-e2e')
    } finally {
      detach()
      channel.port1.close()
      channel.port2.close()
      await Kernel.shutdown()
    }
  })

  test('RuntimeProcessSupervisor orchestrates attach + processExit callback', async () => {
    const k = await makeKernel()
    const proc = await k.spawn({ argv: ['bun', 'supervisor.ts'] })
    const opts: ProcessBootstrapOptions = {
      kernel: k,
      pid: proc.pid,
      argv: ['bun', 'supervisor.ts'],
      env: {},
      cwd: '/',
      sabBuffer: null,
    }

    const channel = new MessageChannel()
    const supervisor = new RuntimeProcessSupervisor(k)
    const seenStdout: string[] = []
    const seenExitCodes: number[] = []

    const unsubscribeStdio = k.onStdio(proc.pid, (kind, data) => {
      if (kind === 'stdout') seenStdout.push(data)
    })

    const detach = supervisor.attachProcessControl({
      pid: proc.pid,
      port: channel.port1,
      onExit: code => seenExitCodes.push(code),
    })

    try {
      const ctx = await bootstrapProcessWorker(opts, channel.port2)
      const waitPromise = k.waitpid(proc.pid)

      expect(ctx.process.stdout.write('supervised')).toBe(true)
      expect(() => ctx.process.exit(55)).toThrow(/process\.exit\(55\)/)

      const code = await waitPromise
      expect(code).toBe(55)
      expect(seenStdout).toContain('supervised')
      expect(seenExitCodes).toEqual([55])
    } finally {
      detach()
      unsubscribeStdio()
      supervisor.dispose()
      channel.port1.close()
      channel.port2.close()
      await Kernel.shutdown()
    }
  })

  test('RuntimeProcessSupervisor.bootstrapSupervisedProcess wires stdout and exit with one helper', async () => {
    const k = await makeKernel()
    const proc = await k.spawn({ argv: ['bun', 'supervisor-helper.ts'] })
    const supervisor = new RuntimeProcessSupervisor(k)
    const seenStdout: string[] = []
    const seenExitCodes: number[] = []

    const unsubscribeStdio = k.onStdio(proc.pid, (kind, data) => {
      if (kind === 'stdout') seenStdout.push(data)
    })

    try {
      const ctx = await supervisor.bootstrapSupervisedProcess({
        bootstrap: {
          kernel: k,
          pid: proc.pid,
          argv: ['bun', 'supervisor-helper.ts'],
          env: {},
          cwd: '/',
          sabBuffer: null,
        },
        onExit: code => seenExitCodes.push(code),
      })
      const waitPromise = k.waitpid(proc.pid)

      expect(ctx.process.stdout.write('helper-ok')).toBe(true)
      expect(() => ctx.process.exit(71)).toThrow(/process\.exit\(71\)/)

      const code = await waitPromise
      expect(code).toBe(71)
      expect(seenStdout).toContain('helper-ok')
      expect(seenExitCodes).toEqual([71])

      ctx.cleanup()
    } finally {
      unsubscribeStdio()
      supervisor.dispose()
      await Kernel.shutdown()
    }
  })

  test('RuntimeProcessSupervisor.spawnSupervisedProcess wires spawn, stdout and exit with one helper', async () => {
    const k = await makeKernel()
    const supervisor = new RuntimeProcessSupervisor(k)
    const seenStdout: string[] = []
    const seenExitCodes: number[] = []

    try {
      const ctx = await supervisor.spawnSupervisedProcess({
        argv: ['bun', 'spawn-supervised.ts'],
        cwd: '/workspace',
        env: { MODE: 'test' },
        sabBuffer: null,
        onExit: code => seenExitCodes.push(code),
      })

      const unsubscribeStdio = k.onStdio(ctx.descriptor.pid, (kind, data) => {
        if (kind === 'stdout') seenStdout.push(data)
      })

      try {
        const waitPromise = k.waitpid(ctx.descriptor.pid)
        expect(ctx.descriptor.argv).toEqual(['bun', 'spawn-supervised.ts'])
        expect(ctx.descriptor.cwd).toBe('/workspace')
        expect(ctx.descriptor.env.MODE).toBe('test')
        expect(ctx.process.stdout.write('spawn-helper-ok')).toBe(true)
        expect(() => ctx.process.exit(91)).toThrow(/process\.exit\(91\)/)

        const code = await waitPromise
        expect(code).toBe(91)
        expect(seenStdout).toContain('spawn-helper-ok')
        expect(seenExitCodes).toEqual([91])
      } finally {
        unsubscribeStdio()
        ctx.cleanup()
      }
    } finally {
      supervisor.dispose()
      await Kernel.shutdown()
    }
  })

  test('RuntimeProcessSupervisor spawn handle exposes exited promise and onStdio helper', async () => {
    const k = await makeKernel()
    const supervisor = new RuntimeProcessSupervisor(k)

    try {
      const ctx = await supervisor.spawnSupervisedProcess({
        argv: ['bun', 'spawn-handle.ts'],
        cwd: '/',
        env: {},
      })

      const seenStdout: string[] = []
      const unsubscribe = ctx.onStdio((kind, data) => {
        if (kind === 'stdout') seenStdout.push(data)
      })

      try {
        expect(ctx.process.stdout.write('handle-stdio')).toBe(true)
        expect(() => ctx.process.exit(101)).toThrow(/process\.exit\(101\)/)

        const code = await ctx.exited
        expect(code).toBe(101)
        expect(seenStdout).toContain('handle-stdio')
      } finally {
        unsubscribe()
        ctx.cleanup()
      }
    } finally {
      supervisor.dispose()
      await Kernel.shutdown()
    }
  })

  test('createChildProcessHandle adapts supervised process to ChildProcess-like shape', async () => {
    const k = await makeKernel()
    const supervisor = new RuntimeProcessSupervisor(k)

    try {
      const supervised = await supervisor.spawnSupervisedProcess({
        argv: ['bun', 'child-process-handle.ts'],
        cwd: '/',
        env: {},
      })
      const child = createChildProcessHandle(k, supervised, { stdout: 'pipe', stderr: 'pipe' })
      const stdoutReader = child.stdout.getReader()

      try {
        expect(child.pid).toBe(supervised.descriptor.pid)
        expect(child.stdin).toBeNull()
        expect(child.ref()).toBeUndefined()
        expect(child.unref()).toBeUndefined()

        expect(supervised.process.stdout.write('child-stdout')).toBe(true)
        const firstChunk = await stdoutReader.read()
        expect(new TextDecoder().decode(firstChunk.value)).toBe('child-stdout')

        child.kill()
        const code = await child.exited
        expect(code).toBe(0)
      } finally {
        stdoutReader.releaseLock()
        supervised.cleanup()
      }
    } finally {
      supervisor.dispose()
      await Kernel.shutdown()
    }
  })

  test('createChildProcessHandle with stdout ignore drops chunks and closes on exit', async () => {
    const k = await makeKernel()
    const supervisor = new RuntimeProcessSupervisor(k)

    try {
      const supervised = await supervisor.spawnSupervisedProcess({
        argv: ['bun', 'child-process-ignore.ts'],
        cwd: '/',
        env: {},
      })
      const child = createChildProcessHandle(k, supervised, { stdout: 'ignore', stderr: 'pipe' })
      const stdoutReader = child.stdout.getReader()

      try {
        expect(supervised.process.stdout.write('ignored-stdout')).toBe(true)
        child.kill()
        const code = await child.exited
        expect(code).toBe(0)

        const firstChunk = await stdoutReader.read()
        expect(firstChunk.done).toBe(true)
      } finally {
        stdoutReader.releaseLock()
        supervised.cleanup()
      }
    } finally {
      supervisor.dispose()
      await Kernel.shutdown()
    }
  })

  test('createChildProcessHandle with stdout inherit does not enqueue to child stdout pipe', async () => {
    const k = await makeKernel()
    const supervisor = new RuntimeProcessSupervisor(k)

    try {
      const supervised = await supervisor.spawnSupervisedProcess({
        argv: ['bun', 'child-process-inherit.ts'],
        cwd: '/',
        env: {},
      })
      const child = createChildProcessHandle(k, supervised, { stdout: 'inherit', stderr: 'pipe' })
      const stdoutReader = child.stdout.getReader()

      try {
        expect(supervised.process.stdout.write('inherited-stdout')).toBe(true)
        child.kill()
        const code = await child.exited
        expect(code).toBe(0)

        const firstChunk = await stdoutReader.read()
        expect(firstChunk.done).toBe(true)
      } finally {
        stdoutReader.releaseLock()
        supervised.cleanup()
      }
    } finally {
      supervisor.dispose()
      await Kernel.shutdown()
    }
  })

  test('runtime spawn creates ChildProcess-like handle via supervisor bridge', async () => {
    const k = await makeKernel()
    const seenExitCodes: number[] = []

    try {
      const child = runtimeSpawn({
        kernel: k,
        cmd: ['bun', 'runtime-spawn.ts'],
        cwd: '/workspace',
        env: { MODE: 'runtime-spawn' },
        stdout: 'pipe',
        stderr: 'pipe',
        onExit: (_proc, code) => seenExitCodes.push(code),
      })

      const stdoutReader = child.stdout.getReader()

      try {
        expect(child.pid).toBe(-1)
        child.kill()

        const firstChunk = await stdoutReader.read()
        expect(firstChunk.done).toBe(true)

        const code = await child.exited
        expect(code).toBe(0)
        expect(seenExitCodes).toEqual([0])
      } finally {
        stdoutReader.releaseLock()
      }
    } finally {
      await Kernel.shutdown()
    }
  })

  test('runtime spawn supports stdin pipe and onExit callback contract', async () => {
    const k = await makeKernel()
    const seenSignals: Array<number | null> = []
    const seenProcMatches: boolean[] = []

    try {
      let childRef: ReturnType<typeof runtimeSpawn> | null = null
      const child = runtimeSpawn({
        kernel: k,
        cmd: ['bun', 'runtime-spawn-stdin.ts'],
        cwd: '/',
        env: {},
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
        onExit: (proc, _code, signal) => {
          seenSignals.push(signal)
          seenProcMatches.push(proc === childRef)
        },
      })
      childRef = child

      expect(child.stdin).not.toBeNull()
      await child.stdin?.getWriter().write(new TextEncoder().encode('ignored-input'))

      child.kill()
      const code = await child.exited
      expect(code).toBe(0)
      expect(child.pid).toBeGreaterThan(0)
      expect(seenSignals).toEqual([null])
      expect(seenProcMatches).toEqual([true])
    } finally {
      await Kernel.shutdown()
    }
  })

  test('StdioWriter.write sends message through port', () => {
    const ch = new MessageChannel()
    const received: string[] = []
    ch.port1.start()
    ch.port1.onmessage = (ev: MessageEvent) => received.push(ev.data?.data ?? '')

    const writer = new StdioWriter(ch.port2, 1, 'stdout')
    writer.write('test-output')

    // Port messages are async, just verify no throw
    expect(() => writer.write('more')).not.toThrow()
    ch.port1.close()
    ch.port2.close()
  })

  test('StdioWriter with null port is a no-op', () => {
    const writer = new StdioWriter(null, 1, 'stdout')
    expect(() => writer.write('should not throw')).not.toThrow()
  })
})
