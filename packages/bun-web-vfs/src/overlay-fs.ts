import type { Dirent, FileStat } from './vfs.types'

type Entry = {
  kind: 'file' | 'dir'
  data?: Uint8Array
  mtime: Date
  atime: Date
  ctime: Date
}

function normalizePath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return '/' + parts.join('/')
}

function toDirent(name: string, kind: Entry['kind']): Dirent {
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

export class VFS {
  private readonly entries = new Map<string, Entry>()

  constructor() {
    const now = new Date()
    this.entries.set('/', {
      kind: 'dir',
      mtime: now,
      atime: now,
      ctime: now,
    })
  }

  existsSync(path: string): boolean {
    return this.entries.has(normalizePath(path))
  }

  mkdirSync(path: string, opts?: { recursive?: boolean }): void {
    const normalized = normalizePath(path)
    const now = new Date()
    if (opts?.recursive) {
      let current = ''
      for (const part of normalized.split('/').filter(Boolean)) {
        current = `${current}/${part}`
        if (!this.entries.has(current)) {
          this.entries.set(current, {
            kind: 'dir',
            mtime: now,
            atime: now,
            ctime: now,
          })
        }
      }
      return
    }

    this.entries.set(normalized, {
      kind: 'dir',
      mtime: now,
      atime: now,
      ctime: now,
    })
  }

  writeFileSync(path: string, data: Buffer | string): void {
    const normalized = normalizePath(path)
    const now = new Date()
    this.entries.set(normalized, {
      kind: 'file',
      data: typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data),
      mtime: now,
      atime: now,
      ctime: now,
    })
  }

  readFileSync(path: string): Buffer {
    const normalized = normalizePath(path)
    const entry = this.entries.get(normalized)
    if (!entry || entry.kind !== 'file') {
      throw new Error(`File not found: ${normalized}`)
    }

    return Buffer.from(entry.data ?? new Uint8Array())
  }

  statSync(path: string): FileStat {
    const normalized = normalizePath(path)
    const entry = this.entries.get(normalized)
    if (!entry) {
      throw new Error(`Path not found: ${normalized}`)
    }

    return toStat(entry)
  }

  readdirSync(path: string, opts?: { withFileTypes?: boolean }): string[] | Dirent[] {
    const normalized = normalizePath(path)
    if (!this.entries.has(normalized)) {
      throw new Error(`Path not found: ${normalized}`)
    }

    const prefix = normalized === '/' ? '/' : normalized + '/'
    const children = new Map<string, Entry['kind']>()

    for (const [key, value] of this.entries.entries()) {
      if (!key.startsWith(prefix) || key === normalized) {
        continue
      }

      const rest = key.slice(prefix.length)
      const [name] = rest.split('/')
      if (!name) {
        continue
      }
      children.set(name, rest.includes('/') ? 'dir' : value.kind)
    }

    if (opts?.withFileTypes) {
      return Array.from(children.entries()).map(([name, kind]) => toDirent(name, kind))
    }

    return Array.from(children.keys())
  }

  unlinkSync(path: string): void {
    const normalized = normalizePath(path)
    this.entries.delete(normalized)
  }

  renameSync(oldPath: string, newPath: string): void {
    const oldNormalized = normalizePath(oldPath)
    const newNormalized = normalizePath(newPath)
    const entry = this.entries.get(oldNormalized)
    if (!entry) {
      throw new Error(`Path not found: ${oldNormalized}`)
    }

    this.entries.set(newNormalized, entry)
    this.entries.delete(oldNormalized)
  }
}
