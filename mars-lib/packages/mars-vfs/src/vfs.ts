import { defaultWorkspaceRoot, dirname, normalizePath, resolvePath } from "./path"
import { MemLayer } from "./mem-layer"

import type {
  BufferEncoding,
  Disposable,
  FileTree,
  MarsDirent,
  MarsStats,
  MkdirOptions,
  ReaddirOptions,
  VFSLayer,
  VFSWatchListener,
  MarsVFSInterface,
  WriteFileOptions,
} from "./types"

export interface MarsVFSOptions {
  cwd?: string
  initialFiles?: FileTree
}

export class MarsVFS implements MarsVFSInterface {
  readonly #memLayer: MemLayer
  readonly #mounts = new Map<string, VFSLayer>()
  readonly #watchers = new Map<string, Set<VFSWatchListener>>()
  #cwd: string

  constructor(options: MarsVFSOptions = {}) {
    this.#cwd = normalizePath(options.cwd ?? defaultWorkspaceRoot)
    this.#memLayer = new MemLayer(options.initialFiles)
    this.#memLayer.mkdirSync(this.#cwd, true)
  }

  cwd(): string {
    return this.#cwd
  }

  chdir(path: string): void {
    const targetPath = this.#resolve(path)
    const stats = this.#memLayer.statSync(targetPath)
    if (!stats.isDirectory()) throw new Error(`Not a directory: ${targetPath}`)

    this.#cwd = targetPath
  }

  existsSync(path: string): boolean {
    return this.#memLayer.existsSync(this.#resolve(path))
  }

  readFileSync(path: string, encoding?: BufferEncoding): Uint8Array | string {
    const data = this.#memLayer.readSync(this.#resolve(path))
    return encoding ? new TextDecoder().decode(data) : data
  }

  writeFileSync(path: string, data: string | Uint8Array, _options?: WriteFileOptions): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
    const targetPath = this.#resolve(path)

    this.#memLayer.writeSync(targetPath, bytes)
    this.#emit("change", targetPath)
  }

  statSync(path: string): MarsStats {
    return this.#memLayer.statSync(this.#resolve(path))
  }

  lstatSync(path: string): MarsStats {
    return this.#memLayer.lstatSync(this.#resolve(path))
  }

  readdirSync(path: string, options: ReaddirOptions = {}): string[] | MarsDirent[] {
    return this.#memLayer.readdirSync(this.#resolve(path), options.withFileTypes)
  }

  mkdirSync(path: string, options: MkdirOptions = {}): void {
    const targetPath = this.#resolve(path)
    this.#memLayer.mkdirSync(targetPath, options.recursive)
    this.#emit("create", targetPath)
  }

  unlinkSync(path: string): void {
    const targetPath = this.#resolve(path)
    this.#memLayer.unlinkSync(targetPath)
    this.#emit("delete", targetPath)
  }

  renameSync(from: string, to: string): void {
    const fromPath = this.#resolve(from)
    const toPath = this.#resolve(to)
    this.#memLayer.renameSync(fromPath, toPath)
    this.#emit("rename", toPath)
  }

  symlinkSync(target: string, path: string): void {
    const linkPath = this.#resolve(path)
    const targetPath = normalizePath(target, dirname(linkPath))
    this.#memLayer.symlinkSync(targetPath, linkPath)
    this.#emit("create", linkPath)
  }

  readlinkSync(path: string): string {
    return this.#memLayer.readlinkSync(this.#resolve(path))
  }

  async readFile(path: string, encoding?: BufferEncoding): Promise<Uint8Array | string> {
    return this.readFileSync(path, encoding)
  }

  async writeFile(
    path: string,
    data: string | Uint8Array,
    options?: WriteFileOptions,
  ): Promise<void> {
    this.writeFileSync(path, data, options)
  }

  async stat(path: string): Promise<MarsStats> {
    return this.statSync(path)
  }

  async lstat(path: string): Promise<MarsStats> {
    return this.lstatSync(path)
  }

  async readdir(path: string, options?: ReaddirOptions): Promise<string[] | MarsDirent[]> {
    return this.readdirSync(path, options)
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.mkdirSync(path, options)
  }

  async unlink(path: string): Promise<void> {
    this.unlinkSync(path)
  }

  async rename(from: string, to: string): Promise<void> {
    this.renameSync(from, to)
  }

  async symlink(target: string, path: string): Promise<void> {
    this.symlinkSync(target, path)
  }

  async readlink(path: string): Promise<string> {
    return this.readlinkSync(path)
  }

  watch(path: string, listener: VFSWatchListener): Disposable {
    const watchPath = this.#resolve(path)
    const watchers = this.#watchers.get(watchPath) ?? new Set()

    watchers.add(listener)
    this.#watchers.set(watchPath, watchers)

    return {
      dispose: () => {
        watchers.delete(listener)
      },
    }
  }

  mount(path: string, layer: VFSLayer): void {
    this.#mounts.set(this.#resolve(path), layer)
  }

  async snapshot(path = "/"): Promise<FileTree> {
    return this.#memLayer.snapshotSync(this.#resolve(path))
  }

  async restore(tree: FileTree, root = this.#cwd): Promise<void> {
    this.#memLayer.restoreSync(tree, this.#resolve(root))
  }

  #resolve(path: string | URL): string {
    return resolvePath(this.#cwd, path)
  }

  #emit(event: "create" | "change" | "delete" | "rename", path: string): void {
    for (const [watchPath, watchers] of this.#watchers) {
      if (path === watchPath || path.startsWith(`${watchPath}/`)) {
        for (const watcher of watchers) watcher(event, path)
      }
    }
  }
}

export function createMarsVFS(options?: MarsVFSOptions): MarsVFS {
  return new MarsVFS(options)
}