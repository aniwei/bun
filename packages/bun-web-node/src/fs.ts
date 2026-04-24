/** Normalise a POSIX path, resolving . and .. without the path module dependency */
function posixNormalize(p: string): string {
  const isAbs = p.startsWith('/')
  const segments = p.split('/')
  const stack: string[] = []
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (stack.length > 0) stack.pop()
    } else {
      stack.push(seg)
    }
  }
  const result = (isAbs ? '/' : '') + stack.join('/')
  return result || '/'
}

import type { Dirent, VFS } from '@mars/web-vfs'

export type NodeFsStat = ReturnType<VFS['statSync']>
export type NodeFsDirent = Dirent
export interface NodeFsReaddirOptions {
  withFileTypes?: boolean
}

export interface NodeFsPromises {
  readFile(path: string, encoding?: BufferEncoding): Promise<Buffer | string>
  writeFile(path: string, data: Buffer | string): Promise<void>
  appendFile(path: string, data: Buffer | string): Promise<void>
  access(path: string): Promise<void>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  readdir(path: string): Promise<string[]>
  readdir(path: string, opts: { withFileTypes: true }): Promise<NodeFsDirent[]>
  readdir(path: string, opts?: NodeFsReaddirOptions): Promise<string[] | NodeFsDirent[]>
  stat(path: string): Promise<NodeFsStat>
  lstat(path: string): Promise<NodeFsStat>
  realpath(path: string): Promise<string>
  unlink(path: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  copyFile(src: string, dest: string): Promise<void>
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>
}

export interface NodeFsBridge {
  readFileSync(path: string, encoding?: BufferEncoding): Buffer | string
  writeFileSync(path: string, data: Buffer | string): void
  appendFileSync(path: string, data: Buffer | string): void
  existsSync(path: string): boolean
  mkdirSync(path: string, opts?: { recursive?: boolean }): void
  readdirSync(path: string, opts: { withFileTypes: true }): NodeFsDirent[]
  readdirSync(path: string): string[]
  readdirSync(path: string, opts?: NodeFsReaddirOptions): string[] | NodeFsDirent[]
  statSync(path: string): NodeFsStat
  lstatSync(path: string): NodeFsStat
  realpathSync(path: string): string
  unlinkSync(path: string): void
  renameSync(oldPath: string, newPath: string): void
  copyFileSync(src: string, dest: string): void
  rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void
  promises: NodeFsPromises
}

function createFsError(message: string, code: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

function joinPath(parent: string, child: string): string {
  return parent.endsWith('/') ? `${parent}${child}` : `${parent}/${child}`
}

class MarsWebNodeFs implements NodeFsBridge {
  readonly promises: NodeFsPromises

  constructor(private readonly vfs: VFS) {
    this.promises = {
      readFile: async (path: string, encoding?: BufferEncoding) => this.readFileSync(path, encoding),
      writeFile: async (path: string, data: Buffer | string) => this.writeFileSync(path, data),
      appendFile: async (path: string, data: Buffer | string) => this.appendFileSync(path, data),
      access: async (path: string) => {
        if (!this.existsSync(path)) {
          throw createFsError(`ENOENT: no such file or directory, access '${path}'`, 'ENOENT')
        }
      },
      mkdir: async (path: string, opts?: { recursive?: boolean }) => this.mkdirSync(path, opts),
      readdir: async (path: string, opts?: NodeFsReaddirOptions) => this.readdirSync(path, opts),
      stat: async (path: string) => this.statSync(path),
      lstat: async (path: string) => this.lstatSync(path),
      realpath: async (path: string) => this.realpathSync(path),
      unlink: async (path: string) => this.unlinkSync(path),
      rename: async (oldPath: string, newPath: string) => this.renameSync(oldPath, newPath),
      copyFile: async (src: string, dest: string) => this.copyFileSync(src, dest),
      rm: async (path: string, opts?: { recursive?: boolean; force?: boolean }) => this.rmSync(path, opts),
    }
  }
  // lstatSync: In the VFS there are no symlinks, so lstat behaves identically to stat
  lstatSync(path: string): NodeFsStat {
    return this.statSync(path)
  }

  // realpathSync: VFS has no symlinks, so the real path is the normalised path itself
  realpathSync(path: string): string {
    // Resolve dot segments with a segment-by-segment approach
    const normalized = posixNormalize(path)
    if (!this.existsSync(normalized)) {
      throw createFsError(`ENOENT: no such file or directory, realpath '${path}'`, 'ENOENT')
    }
    return normalized
  }

  readFileSync(path: string, encoding?: BufferEncoding): Buffer | string {
    const data = this.vfs.readFileSync(path)
    if (!encoding) {
      return data
    }

    return data.toString(encoding)
  }

  writeFileSync(path: string, data: Buffer | string): void {
    this.vfs.writeFileSync(path, data)
  }

  appendFileSync(path: string, data: Buffer | string): void {
    const nextChunk = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
    if (!this.existsSync(path)) {
      this.vfs.writeFileSync(path, nextChunk)
      return
    }

    const current = this.vfs.readFileSync(path)
    this.vfs.writeFileSync(path, Buffer.concat([Buffer.from(current), nextChunk]))
  }

  existsSync(path: string): boolean {
    return this.vfs.existsSync(path)
  }

  mkdirSync(path: string, opts?: { recursive?: boolean }): void {
    this.vfs.mkdirSync(path, opts)
  }

  readdirSync(path: string, opts?: NodeFsReaddirOptions): string[] | NodeFsDirent[] {
    return this.vfs.readdirSync(path, opts) as string[] | NodeFsDirent[]
  }

  statSync(path: string): NodeFsStat {
    return this.vfs.statSync(path)
  }

  unlinkSync(path: string): void {
    this.vfs.unlinkSync(path)
  }

  renameSync(oldPath: string, newPath: string): void {
    this.vfs.renameSync(oldPath, newPath)
  }

  copyFileSync(src: string, dest: string): void {
    try {
      const data = this.vfs.readFileSync(src)
      this.vfs.writeFileSync(dest, data)
    } catch {
      throw createFsError(`ENOENT: no such file or directory, copyfile '${src}'`, 'ENOENT')
    }
  }

  rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void {
    if (!this.existsSync(path)) {
      if (opts?.force) {
        return
      }
      throw createFsError(`ENOENT: no such file or directory, rm '${path}'`, 'ENOENT')
    }

    const stat = this.statSync(path)
    if (stat.isDirectory()) {
      if (!opts?.recursive) {
        throw createFsError(`EISDIR: illegal operation on a directory, rm '${path}'`, 'EISDIR')
      }

      const children = this.readdirSync(path)
      for (const child of children) {
        this.rmSync(joinPath(path, child), { recursive: true, force: opts?.force })
      }
      this.vfs.unlinkSync(path)
      return
    }

    this.vfs.unlinkSync(path)
  }
}

export function createNodeFs(vfs: VFS): NodeFsBridge {
  return new MarsWebNodeFs(vfs)
}
