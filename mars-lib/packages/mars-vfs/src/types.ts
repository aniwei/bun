export type BufferEncoding = "utf8" | "utf-8"

export interface FileTree {
  [path: string]: string | Uint8Array | FileTree
}

export interface Disposable {
  dispose(): void
}

export interface WriteFileOptions {
  encoding?: BufferEncoding
}

export interface ReaddirOptions {
  withFileTypes?: boolean
}

export interface MkdirOptions {
  recursive?: boolean
}

export interface MarsStats {
  size: number
  mode: number
  mtime: Date
  atime: Date
  ctime: Date
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface MarsDirent {
  name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface VFSEntry {
  path: string
  name: string
  kind: "file" | "directory"
  size: number
}

export interface VFSLayer {
  readonly name: string
  readonly readonly?: boolean
  read(path: string): Promise<Uint8Array | null>
  write(path: string, data: Uint8Array): Promise<void>
  delete(path: string): Promise<void>
  list(path: string): Promise<VFSEntry[]>
  stat(path: string): Promise<MarsStats | null>
}

export type VFSWatchEvent = "create" | "change" | "delete" | "rename"

export type VFSWatchListener = (event: VFSWatchEvent, path: string) => void

export interface MarsVFSInterface {
  cwd(): string
  chdir(path: string): void
  existsSync(path: string): boolean
  readFileSync(path: string, encoding?: BufferEncoding): Uint8Array | string
  writeFileSync(path: string, data: string | Uint8Array, options?: WriteFileOptions): void
  statSync(path: string): MarsStats
  readdirSync(path: string, options?: ReaddirOptions): string[] | MarsDirent[]
  mkdirSync(path: string, options?: MkdirOptions): void
  unlinkSync(path: string): void
  renameSync(from: string, to: string): void
  readFile(path: string, encoding?: BufferEncoding): Promise<Uint8Array | string>
  writeFile(path: string, data: string | Uint8Array, options?: WriteFileOptions): Promise<void>
  stat(path: string): Promise<MarsStats>
  readdir(path: string, options?: ReaddirOptions): Promise<string[] | MarsDirent[]>
  mkdir(path: string, options?: MkdirOptions): Promise<void>
  unlink(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  watch(path: string, listener: VFSWatchListener): Disposable
  mount(path: string, layer: VFSLayer): void
  snapshot(path?: string): Promise<FileTree>
  restore(tree: FileTree, root?: string): Promise<void>
}