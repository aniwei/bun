import type { Dirent, FileStat, WatchHandle, WatchListener } from './vfs.types'
import { WatchBus } from './watch-bus'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export function normalizePath(path: string): string {
  if (!path || path === '/') return '/'
  const parts = path.split('/').filter(Boolean)
  return '/' + parts.join('/')
}

type EntryKind = 'file' | 'dir'

interface Entry {
  kind: EntryKind
  data?: Uint8Array
  mtime: Date
  atime: Date
  ctime: Date
}

function makeEntry(kind: EntryKind, data?: Uint8Array): Entry {
  const now = new Date()
  return { kind, data, mtime: now, atime: now, ctime: now }
}

function toDirent(name: string, kind: EntryKind): Dirent {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
  }
}

function toStat(entry: Entry): FileStat {
  return {
    isFile: () => entry.kind === 'file',
    isDirectory: () => entry.kind === 'dir',
    isSymbolicLink: () => false,
    size: entry.data?.byteLength ?? 0,
    mtime: entry.mtime,
    atime: entry.atime,
    ctime: entry.ctime,
  }
}

function pathBasename(path: string): string {
  const normalized = normalizePath(path)
  if (normalized === '/') return '/'
  return normalized.split('/').filter(Boolean).at(-1) ?? normalized
}

function pathDirname(path: string): string {
  const normalized = normalizePath(path)
  if (normalized === '/') return '/'
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 1) return '/'
  return '/' + parts.slice(0, -1).join('/')
}

// ---------------------------------------------------------------------------
// BaseLayer — read-only static file tree (e.g. pre-seeded CDN snapshot)
// ---------------------------------------------------------------------------

export class BaseLayer {
  private readonly entries: ReadonlyMap<string, Entry>

  constructor(files: Record<string, string | Uint8Array> = {}) {
    const m = new Map<string, Entry>()
    m.set('/', makeEntry('dir'))
    for (const [rawPath, content] of Object.entries(files)) {
      const path = normalizePath(rawPath)
      const data =
        typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content)
      m.set(path, makeEntry('file', data))
      // ensure ancestor dirs exist
      const parts = path.split('/').filter(Boolean)
      let cur = ''
      for (let i = 0; i < parts.length - 1; i++) {
        cur += '/' + parts[i]
        if (!m.has(cur)) m.set(cur, makeEntry('dir'))
      }
    }
    this.entries = m
  }

  get(path: string): Entry | undefined {
    return this.entries.get(normalizePath(path))
  }

  has(path: string): boolean {
    return this.entries.has(normalizePath(path))
  }

  childNames(dirPath: string): Map<string, EntryKind> {
    const normalized = normalizePath(dirPath)
    const prefix = normalized === '/' ? '/' : normalized + '/'
    const out = new Map<string, EntryKind>()
    for (const [key, value] of this.entries) {
      if (!key.startsWith(prefix) || key === normalized) continue
      const rest = key.slice(prefix.length)
      const [name] = rest.split('/')
      if (name) out.set(name, rest.includes('/') ? 'dir' : value.kind)
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// PersistLayer — wraps OPFSAdapter (write-through persistence)
// Currently uses an in-memory fallback so the same interface works in tests
// without a real OPFS. The OPFSAdapter provided to OverlayFS provides the
// actual storage backend.
// ---------------------------------------------------------------------------

export interface IPersistAdapter {
  readSync(path: string): Uint8Array
  writeSync(path: string, data: Uint8Array): void
  unlinkSync(path: string): void
  readdirSync(path: string): string[]
  mkdirSync(path: string): void
  existsSync?(path: string): boolean
}

export class PersistLayer {
  // In-memory index mirrors what's in the adapter for fast membership checks
  private readonly index = new Map<string, EntryKind>()

  constructor(private readonly adapter: IPersistAdapter) {
    this.index.set('/', 'dir')
  }

  has(path: string): boolean {
    return this.index.has(normalizePath(path))
  }

  get(path: string): Entry | undefined {
    const normalized = normalizePath(path)
    const kind = this.index.get(normalized)
    if (!kind) return undefined
    if (kind === 'dir') return makeEntry('dir')
    try {
      const data = this.adapter.readSync(normalized)
      return makeEntry('file', data)
    } catch {
      return undefined
    }
  }

  writeFile(path: string, data: Uint8Array): void {
    const normalized = normalizePath(path)
    this.adapter.writeSync(normalized, data)
    this.index.set(normalized, 'file')
    // ensure parent dirs in index
    const parts = normalized.split('/').filter(Boolean)
    let cur = ''
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i]
      if (!this.index.has(cur)) {
        this.index.set(cur, 'dir')
        try { this.adapter.mkdirSync(cur) } catch { /* ignore */ }
      }
    }
  }

  mkdir(path: string, recursive?: boolean): void {
    const normalized = normalizePath(path)
    if (recursive) {
      const parts = normalized.split('/').filter(Boolean)
      let cur = ''
      for (const part of parts) {
        cur += '/' + part
        if (!this.index.has(cur)) {
          this.index.set(cur, 'dir')
          try { this.adapter.mkdirSync(cur) } catch { /* ignore */ }
        }
      }
    } else {
      this.index.set(normalized, 'dir')
      try { this.adapter.mkdirSync(normalized) } catch { /* ignore */ }
    }
  }

  unlink(path: string): void {
    const normalized = normalizePath(path)
    this.index.delete(normalized)
    try { this.adapter.unlinkSync(normalized) } catch { /* ignore */ }
  }

  childNames(dirPath: string): Map<string, EntryKind> {
    const normalized = normalizePath(dirPath)
    const prefix = normalized === '/' ? '/' : normalized + '/'
    const out = new Map<string, EntryKind>()
    for (const [key, kind] of this.index) {
      if (!key.startsWith(prefix) || key === normalized) continue
      const rest = key.slice(prefix.length)
      const [name] = rest.split('/')
      if (name) out.set(name, rest.includes('/') ? 'dir' : kind)
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// MemLayer — ephemeral in-memory top layer (/tmp, /proc, etc.)
// ---------------------------------------------------------------------------

export class MemLayer {
  private readonly entries = new Map<string, Entry>()

  constructor() {
    this.entries.set('/', makeEntry('dir'))
  }

  has(path: string): boolean {
    return this.entries.has(normalizePath(path))
  }

  get(path: string): Entry | undefined {
    return this.entries.get(normalizePath(path))
  }

  set(path: string, entry: Entry): void {
    this.entries.set(normalizePath(path), entry)
  }

  delete(path: string): void {
    this.entries.delete(normalizePath(path))
  }

  mkdir(path: string, recursive?: boolean): void {
    const normalized = normalizePath(path)
    if (recursive) {
      const parts = normalized.split('/').filter(Boolean)
      let cur = ''
      for (const part of parts) {
        cur += '/' + part
        if (!this.entries.has(cur)) this.entries.set(cur, makeEntry('dir'))
      }
    } else {
      if (!this.entries.has(normalized)) this.entries.set(normalized, makeEntry('dir'))
    }
  }

  childNames(dirPath: string): Map<string, EntryKind> {
    const normalized = normalizePath(dirPath)
    const prefix = normalized === '/' ? '/' : normalized + '/'
    const out = new Map<string, EntryKind>()
    for (const [key, value] of this.entries) {
      if (!key.startsWith(prefix) || key === normalized) continue
      const rest = key.slice(prefix.length)
      const [name] = rest.split('/')
      if (name) out.set(name, rest.includes('/') ? 'dir' : value.kind)
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// OverlayFS / VFS — three-layer overlay
// Read: Mem → Persist → Base (first found wins)
// Write: goes to MemLayer by default; pass writeToPersist:true to also persist
// ---------------------------------------------------------------------------

export interface OverlayFSOptions {
  base?: BaseLayer
  persist?: PersistLayer
  mem?: MemLayer
}

export class VFS {
  readonly layers: { base: BaseLayer; persist: PersistLayer; mem: MemLayer }
  private readonly watchBus = new WatchBus()

  constructor(opts: OverlayFSOptions = {}) {
    this.layers = {
      base: opts.base ?? new BaseLayer(),
      persist: opts.persist ?? new PersistLayer({ readSync: () => { throw new Error('no persist') }, writeSync() {}, unlinkSync() {}, readdirSync: () => [], mkdirSync() {} }),
      mem: opts.mem ?? new MemLayer(),
    }
  }

  private _lookup(path: string): Entry | undefined {
    const { mem, persist, base } = this.layers
    return mem.get(path) ?? persist.get(path) ?? base.get(path)
  }

  existsSync(path: string): boolean {
    const { mem, persist, base } = this.layers
    return mem.has(path) || persist.has(path) || base.has(path)
  }

  mkdirSync(path: string, opts?: { recursive?: boolean }): void {
    this.layers.mem.mkdir(path, opts?.recursive)
    this.emitWatchEvent(normalizePath(path), 'rename')
  }

  writeFileSync(path: string, data: Buffer | string): void {
    const bytes =
      typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data as Buffer)
    this.layers.mem.set(path, makeEntry('file', bytes))
    this.emitWatchEvent(normalizePath(path), 'change')
  }

  readFileSync(path: string): Buffer {
    const entry = this._lookup(path)
    if (!entry || entry.kind !== 'file') {
      const err = new Error(`ENOENT: no such file or directory, open '${normalizePath(path)}'`)
      ;(err as NodeJS.ErrnoException).code = 'ENOENT'
      throw err
    }
    return Buffer.from(entry.data ?? new Uint8Array())
  }

  statSync(path: string): FileStat {
    const entry = this._lookup(path)
    if (!entry) {
      const err = new Error(`ENOENT: no such file or directory, stat '${normalizePath(path)}'`)
      ;(err as NodeJS.ErrnoException).code = 'ENOENT'
      throw err
    }
    return toStat(entry)
  }

  readdirSync(path: string, opts?: { withFileTypes?: boolean }): string[] | Dirent[] {
    if (!this.existsSync(path)) {
      const err = new Error(`ENOENT: no such file or directory, scandir '${normalizePath(path)}'`)
      ;(err as NodeJS.ErrnoException).code = 'ENOENT'
      throw err
    }
    // Merge child names from all three layers
    const merged = new Map<string, EntryKind>()
    for (const [name, kind] of this.layers.base.childNames(path)) merged.set(name, kind)
    for (const [name, kind] of this.layers.persist.childNames(path)) merged.set(name, kind)
    for (const [name, kind] of this.layers.mem.childNames(path)) merged.set(name, kind)

    if (opts?.withFileTypes) {
      return Array.from(merged.entries()).map(([name, kind]) => toDirent(name, kind))
    }
    return Array.from(merged.keys())
  }

  unlinkSync(path: string): void {
    const normalized = normalizePath(path)
    this.layers.mem.delete(normalized)
    this.emitWatchEvent(normalized, 'rename')
  }

  renameSync(oldPath: string, newPath: string): void {
    const entry = this._lookup(oldPath)
    if (!entry) {
      const err = new Error(`ENOENT: no such file or directory, rename '${normalizePath(oldPath)}'`)
      ;(err as NodeJS.ErrnoException).code = 'ENOENT'
      throw err
    }
    const normalizedOldPath = normalizePath(oldPath)
    const normalizedNewPath = normalizePath(newPath)
    this.layers.mem.set(normalizedNewPath, entry)
    this.layers.mem.delete(normalizedOldPath)
    this.emitWatchEvent(normalizedOldPath, 'rename')
    this.emitWatchEvent(normalizedNewPath, 'rename')
  }

  watch(path: string, listener: WatchListener): WatchHandle {
    return this.watchBus.subscribe(normalizePath(path), listener)
  }

  // Async wrappers
  async readFile(path: string): Promise<Buffer> {
    return this.readFileSync(path)
  }

  async writeFile(path: string, data: Buffer | string): Promise<void> {
    this.writeFileSync(path, data)
  }

  async stat(path: string): Promise<FileStat> {
    return this.statSync(path)
  }

  async readdir(path: string): Promise<string[]> {
    return this.readdirSync(path) as string[]
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    this.mkdirSync(path, opts)
  }

  async unlink(path: string): Promise<void> {
    this.unlinkSync(path)
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.renameSync(oldPath, newPath)
  }

  private emitWatchEvent(path: string, event: 'change' | 'rename'): void {
    const normalized = normalizePath(path)
    const filename = pathBasename(normalized)

    this.watchBus.emit(normalized, event, filename)

    const parent = pathDirname(normalized)
    if (parent !== normalized) {
      this.watchBus.emit(parent, event, filename)
    }
  }
}
