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

type StatsNumeric = number | bigint

type NodeStatsShape = {
  dev: StatsNumeric
  mode: StatsNumeric
  nlink: StatsNumeric
  uid: StatsNumeric
  gid: StatsNumeric
  rdev: StatsNumeric
  blksize: StatsNumeric
  ino: StatsNumeric
  size: StatsNumeric
  blocks: StatsNumeric
  atimeMs: StatsNumeric
  mtimeMs: StatsNumeric
  ctimeMs: StatsNumeric
  birthtimeMs: StatsNumeric
  atime: Date
  mtime: Date
  ctime: Date
  birthtime: Date
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

type StatsCtor = {
  (...args: Array<number | bigint>): NodeStatsShape
  new (...args: Array<number | bigint>): NodeStatsShape
  prototype: NodeStatsShape
}

const STATS_FIELD_ORDER = [
  'dev',
  'mode',
  'nlink',
  'uid',
  'gid',
  'rdev',
  'blksize',
  'ino',
  'size',
  'blocks',
  'atimeMs',
  'mtimeMs',
  'ctimeMs',
  'birthtimeMs',
] as const

type StatsFieldName = (typeof STATS_FIELD_ORDER)[number]

function buildStatsObject(target: any, values: Array<StatsNumeric>, kind: 'file' | 'dir' = 'file'): NodeStatsShape {
  const statsValues = values.length >= STATS_FIELD_ORDER.length ? values : [...values, ...new Array(STATS_FIELD_ORDER.length - values.length).fill(0)]
  for (let index = 0; index < STATS_FIELD_ORDER.length; index++) {
    const field = STATS_FIELD_ORDER[index] as StatsFieldName
    target[field] = statsValues[index]
  }

  const toDate = (input: StatsNumeric): Date => new Date(typeof input === 'bigint' ? Number(input) : input)
  target.atime = toDate(target.atimeMs)
  target.mtime = toDate(target.mtimeMs)
  target.ctime = toDate(target.ctimeMs)
  target.birthtime = toDate(target.birthtimeMs)
  target._kind = kind

  return target as NodeStatsShape
}

function createStatsCtor(kind: 'Stats' | 'BigIntStats'): StatsCtor {
  const ctor = function (this: any, ...args: Array<number | bigint>): NodeStatsShape {
    const receiver = this instanceof (ctor as any) ? this : Object.create((ctor as any).prototype)
    return buildStatsObject(receiver, args, 'file')
  } as unknown as StatsCtor

  Object.defineProperty(ctor, 'name', { value: kind })
  ;(ctor as any).prototype = {
    constructor: ctor,
    isFile(this: any) {
      return this._kind === 'file'
    },
    isDirectory(this: any) {
      return this._kind === 'dir'
    },
    isSymbolicLink() {
      return false
    },
  }

  return ctor
}

export const Stats = createStatsCtor('Stats')
export const BigIntStats = createStatsCtor('BigIntStats')

function fromVfsStat(stat: NodeFsStat, big: boolean): NodeStatsShape {
  const toNumeric = (value: number): StatsNumeric => (big ? BigInt(Math.trunc(value)) : value)
  const values: StatsNumeric[] = [
    toNumeric(0),
    toNumeric(stat.isDirectory() ? 0o040000 : 0o100000),
    toNumeric(1),
    toNumeric(0),
    toNumeric(0),
    toNumeric(0),
    toNumeric(0),
    toNumeric(0),
    toNumeric(stat.size),
    toNumeric(0),
    toNumeric(stat.atime.getTime()),
    toNumeric(stat.mtime.getTime()),
    toNumeric(stat.ctime.getTime()),
    toNumeric(stat.ctime.getTime()),
  ]

  const ctor = big ? BigIntStats : Stats
  const stats = (ctor as any)(...values) as NodeStatsShape
  ;(stats as any)._kind = stat.isDirectory() ? 'dir' : 'file'
  return stats
}

export function createStatsForIno(ino: bigint, big: boolean): NodeStatsShape {
  const inoValue = big ? BigInt.asIntN(64, ino) : Number(ino)
  const zero = big ? 0n : 0
  const ctor = big ? BigIntStats : Stats
  return (ctor as any)(
    zero,
    zero,
    zero,
    zero,
    zero,
    zero,
    zero,
    inoValue,
    zero,
    zero,
    zero,
    zero,
    zero,
    zero,
  ) as NodeStatsShape
}

type FsAbortOptions = {
  signal?: AbortSignal
}

type NodeFsReadFileOptions = FsAbortOptions & {
  encoding?: BufferEncoding
}

function createAbortError(): Error & { code: string; name: string } {
  const err = new Error('The operation was aborted') as Error & { code: string; name: string }
  err.name = 'AbortError'
  err.code = 'ABORT_ERR'
  return err
}

function throwIfAborted(options?: FsAbortOptions): void {
  if (options?.signal?.aborted) {
    throw createAbortError()
  }
}

function parseReadOptions(encodingOrOptions?: BufferEncoding | NodeFsReadFileOptions): {
  encoding?: BufferEncoding
  options?: NodeFsReadFileOptions
} {
  if (!encodingOrOptions) {
    return { encoding: undefined, options: undefined }
  }

  if (typeof encodingOrOptions === 'string') {
    return { encoding: encodingOrOptions, options: undefined }
  }

  return { encoding: encodingOrOptions.encoding, options: encodingOrOptions }
}

export interface NodeFsReaddirOptions {
  withFileTypes?: boolean
}

export interface NodeFsPromises {
  readFile(path: string, encoding?: BufferEncoding): Promise<Buffer | string>
  readFile(path: string, options?: NodeFsReadFileOptions): Promise<Buffer | string>
  writeFile(path: string, data: Buffer | string, options?: FsAbortOptions): Promise<void>
  appendFile(path: string, data: Buffer | string, options?: FsAbortOptions): Promise<void>
  access(path: string): Promise<void>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  readdir(path: string): Promise<string[]>
  readdir(path: string, opts: { withFileTypes: true }): Promise<NodeFsDirent[]>
  readdir(path: string, opts?: NodeFsReaddirOptions): Promise<string[] | NodeFsDirent[]>
  stat(path: string): Promise<NodeStatsShape>
  stat(path: string, opts: { bigint: true }): Promise<NodeStatsShape>
  lstat(path: string): Promise<NodeStatsShape>
  lstat(path: string, opts: { bigint: true }): Promise<NodeStatsShape>
  realpath(path: string): Promise<string>
  unlink(path: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  copyFile(src: string, dest: string): Promise<void>
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>
}

export interface NodeFsBridge {
  Stats: StatsCtor
  BigIntStats: StatsCtor
  readFileSync(path: string, encoding?: BufferEncoding): Buffer | string
  readFileSync(path: string, options?: NodeFsReadFileOptions): Buffer | string
  writeFileSync(path: string, data: Buffer | string, options?: FsAbortOptions): void
  appendFileSync(path: string, data: Buffer | string, options?: FsAbortOptions): void
  existsSync(path: string): boolean
  mkdirSync(path: string, opts?: { recursive?: boolean }): void
  readdirSync(path: string, opts: { withFileTypes: true }): NodeFsDirent[]
  readdirSync(path: string): string[]
  readdirSync(path: string, opts?: NodeFsReaddirOptions): string[] | NodeFsDirent[]
  statSync(path: string): NodeStatsShape
  statSync(path: string, opts: { bigint: true }): NodeStatsShape
  lstatSync(path: string): NodeStatsShape
  lstatSync(path: string, opts: { bigint: true }): NodeStatsShape
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
  readonly Stats = Stats
  readonly BigIntStats = BigIntStats
  readonly promises: NodeFsPromises

  constructor(private readonly vfs: VFS) {
    this.promises = {
      readFile: (async (path: string, encodingOrOptions?: BufferEncoding | NodeFsReadFileOptions) =>
        this.readFileSync(path, encodingOrOptions as any)) as NodeFsPromises['readFile'],
      writeFile: async (path: string, data: Buffer | string, options?: FsAbortOptions) => this.writeFileSync(path, data, options),
      appendFile: async (path: string, data: Buffer | string, options?: FsAbortOptions) => this.appendFileSync(path, data, options),
      access: async (path: string) => {
        if (!this.existsSync(path)) {
          throw createFsError(`ENOENT: no such file or directory, access '${path}'`, 'ENOENT')
        }
      },
      mkdir: async (path: string, opts?: { recursive?: boolean }) => this.mkdirSync(path, opts),
      readdir: (async (path: string, opts?: NodeFsReaddirOptions) =>
        opts?.withFileTypes ? this.readdirSync(path, { withFileTypes: true }) : this.readdirSync(path)) as NodeFsPromises['readdir'],
      stat: (async (path: string, opts?: { bigint: true }) => this.statSync(path, opts as any)) as NodeFsPromises['stat'],
      lstat: (async (path: string, opts?: { bigint: true }) => this.lstatSync(path, opts as any)) as NodeFsPromises['lstat'],
      realpath: async (path: string) => this.realpathSync(path),
      unlink: async (path: string) => this.unlinkSync(path),
      rename: async (oldPath: string, newPath: string) => this.renameSync(oldPath, newPath),
      copyFile: async (src: string, dest: string) => this.copyFileSync(src, dest),
      rm: async (path: string, opts?: { recursive?: boolean; force?: boolean }) => this.rmSync(path, opts),
    }
  }
  // lstatSync: In the VFS there are no symlinks, so lstat behaves identically to stat
  lstatSync(path: string): NodeStatsShape
  lstatSync(path: string, opts: { bigint: true }): NodeStatsShape
  lstatSync(path: string, opts?: { bigint: true }): NodeStatsShape {
    return this.statSync(path, opts as any)
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

  readFileSync(path: string, encoding?: BufferEncoding): Buffer | string
  readFileSync(path: string, options?: NodeFsReadFileOptions): Buffer | string
  readFileSync(path: string, encodingOrOptions?: BufferEncoding | NodeFsReadFileOptions): Buffer | string {
    const { encoding, options } = parseReadOptions(encodingOrOptions)
    throwIfAborted(options)
    const data = this.vfs.readFileSync(path)
    if (!encoding) {
      return data
    }

    return data.toString(encoding)
  }

  writeFileSync(path: string, data: Buffer | string, options?: FsAbortOptions): void {
    throwIfAborted(options)
    this.vfs.writeFileSync(path, data)
  }

  appendFileSync(path: string, data: Buffer | string, options?: FsAbortOptions): void {
    throwIfAborted(options)
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

  readdirSync(path: string): string[]
  readdirSync(path: string, opts: { withFileTypes: true }): NodeFsDirent[]
  readdirSync(path: string, opts?: NodeFsReaddirOptions): string[] | NodeFsDirent[] {
    return this.vfs.readdirSync(path, opts) as string[] | NodeFsDirent[]
  }

  statSync(path: string): NodeStatsShape
  statSync(path: string, opts: { bigint: true }): NodeStatsShape
  statSync(path: string, opts?: { bigint: true }): NodeStatsShape {
    return fromVfsStat(this.vfs.statSync(path), Boolean(opts?.bigint))
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
