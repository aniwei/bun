import { basename, dirname, normalizePath } from "./path"

import { isFileTreeSymlink } from "./types"

import type { FileTree, MarsDirent, MarsStats, VFSEntry, VFSLayer } from "./types"

type VFSNode = DirectoryNode | FileNode | SymlinkNode

interface BaseNode {
  path: string
  mode: number
  atime: Date
  mtime: Date
  ctime: Date
}

interface DirectoryNode extends BaseNode {
  kind: "directory"
  children: Set<string>
}

interface FileNode extends BaseNode {
  kind: "file"
  data: Uint8Array
}

interface SymlinkNode extends BaseNode {
  kind: "symlink"
  target: string
}

export class BasicMarsStats implements MarsStats {
  readonly size: number
  readonly mode: number
  readonly mtime: Date
  readonly atime: Date
  readonly ctime: Date
  readonly #kind: "file" | "directory" | "symlink"

  constructor(node: VFSNode) {
    this.#kind = node.kind
    this.size = node.kind === "file" ? node.data.byteLength : node.kind === "directory" ? node.children.size : node.target.length
    this.mode = node.mode
    this.mtime = node.mtime
    this.atime = node.atime
    this.ctime = node.ctime
  }

  isFile(): boolean {
    return this.#kind === "file"
  }

  isDirectory(): boolean {
    return this.#kind === "directory"
  }

  isSymbolicLink(): boolean {
    return this.#kind === "symlink"
  }
}

export class BasicMarsDirent implements MarsDirent {
  readonly name: string
  readonly #kind: "file" | "directory" | "symlink"

  constructor(name: string, node: VFSNode) {
    this.name = name
    this.#kind = node.kind
  }

  isFile(): boolean {
    return this.#kind === "file"
  }

  isDirectory(): boolean {
    return this.#kind === "directory"
  }

  isSymbolicLink(): boolean {
    return this.#kind === "symlink"
  }
}

export class MemLayer implements VFSLayer {
  readonly name = "mem"
  readonly #nodes = new Map<string, VFSNode>()

  constructor(initialFiles: FileTree = {}) {
    this.#nodes.set("/", createDirectoryNode("/"))
    this.restoreSync(initialFiles)
  }

  existsSync(path: string): boolean {
    return this.#nodes.has(this.#resolveSymlinks(path))
  }

  readSync(path: string): Uint8Array {
    const node = this.#getNode(path)
    if (node.kind !== "file") throw new Error(`Not a file: ${path}`)

    node.atime = new Date()
    return node.data.slice()
  }

  writeSync(path: string, data: Uint8Array): void {
    const normalizedPath = this.#resolveSymlinks(path)
    const parentPath = dirname(normalizedPath)
    const parentNode = this.#getDirectory(parentPath)
    const now = new Date()

    this.#nodes.set(normalizedPath, {
      kind: "file",
      path: normalizedPath,
      data: data.slice(),
      mode: 0o644,
      atime: now,
      mtime: now,
      ctime: now,
    })

    parentNode.children.add(basename(normalizedPath))
    parentNode.mtime = now
  }

  mkdirSync(path: string, recursive = false): void {
    const normalizedPath = this.#resolveSymlinks(path)
    if (this.#nodes.has(normalizedPath)) return

    const parentPath = dirname(normalizedPath)
    if (!this.#nodes.has(parentPath)) {
      if (!recursive) throw new Error(`Parent directory does not exist: ${parentPath}`)
      this.mkdirSync(parentPath, true)
    }

    const parentNode = this.#getDirectory(parentPath)
    this.#nodes.set(normalizedPath, createDirectoryNode(normalizedPath))
    parentNode.children.add(basename(normalizedPath))
    parentNode.mtime = new Date()
  }

  statSync(path: string): MarsStats {
    return new BasicMarsStats(this.#getNode(path))
  }

  lstatSync(path: string): MarsStats {
    return new BasicMarsStats(this.#getNode(path, false))
  }

  readdirSync(path: string, withFileTypes = false): string[] | MarsDirent[] {
    const directoryNode = this.#getDirectory(path)
    const names = [...directoryNode.children].sort()

    if (!withFileTypes) return names

    return names.map(name => {
      const childPath = normalizePath(name, directoryNode.path)
      return new BasicMarsDirent(name, this.#getNode(childPath, false))
    })
  }

  unlinkSync(path: string): void {
    const normalizedPath = normalizePath(path)
    const node = this.#getNode(normalizedPath, false)

    if (node.kind === "directory" && node.children.size > 0) {
      throw new Error(`Directory is not empty: ${normalizedPath}`)
    }

    this.#nodes.delete(normalizedPath)
    const parentNode = this.#getDirectory(dirname(normalizedPath))
    parentNode.children.delete(basename(normalizedPath))
    parentNode.mtime = new Date()
  }

  renameSync(from: string, to: string): void {
    const fromPath = normalizePath(from)
    const toPath = this.#resolveSymlinks(to)
    const node = this.#getNode(fromPath, false)
    const parentNode = this.#getDirectory(dirname(toPath))

    this.#nodes.delete(fromPath)
    this.#nodes.set(toPath, { ...node, path: toPath, mtime: new Date() } as VFSNode)
    this.#getDirectory(dirname(fromPath)).children.delete(basename(fromPath))
    parentNode.children.add(basename(toPath))
  }

  symlinkSync(target: string, path: string): void {
    const linkPath = normalizePath(path)
    const parentPath = dirname(linkPath)
    const parentNode = this.#getDirectory(parentPath)
    const now = new Date()

    this.#nodes.set(linkPath, {
      kind: "symlink",
      path: linkPath,
      target: normalizePath(target, parentPath),
      mode: 0o777,
      atime: now,
      mtime: now,
      ctime: now,
    })

    parentNode.children.add(basename(linkPath))
    parentNode.mtime = now
  }

  readlinkSync(path: string): string {
    const node = this.#getNode(path, false)
    if (node.kind !== "symlink") throw new Error(`Not a symbolic link: ${path}`)

    return node.target
  }

  snapshotSync(root = "/"): FileTree {
    const rootPath = normalizePath(root)
    const node = this.#getNode(rootPath, false)

    if (node.kind === "file") {
      return {
        [basename(rootPath)]: node.data.slice(),
      }
    }

    if (node.kind === "symlink") {
      return {
        [basename(rootPath)]: { kind: "symlink", target: node.target },
      }
    }

    const tree: FileTree = {}
    for (const childName of node.children) {
      const childPath = normalizePath(childName, rootPath)
      const childNode = this.#getNode(childPath, false)
      tree[childName] = childNode.kind === "file"
        ? childNode.data.slice()
        : childNode.kind === "symlink"
          ? { kind: "symlink", target: childNode.target }
          : this.snapshotSync(childPath)
    }

    return tree
  }

  restoreSync(tree: FileTree, root = "/workspace"): void {
    const rootPath = normalizePath(root)
    this.mkdirSync(rootPath, true)

    for (const [name, value] of Object.entries(tree)) {
      const targetPath = normalizePath(name, rootPath)
      if (typeof value === "string") {
        this.writeSync(targetPath, new TextEncoder().encode(value))
        continue
      }

      if (value instanceof Uint8Array) {
        this.writeSync(targetPath, value)
        continue
      }

      if (isFileTreeSymlink(value)) {
        this.symlinkSync(value.target, targetPath)
        continue
      }

      this.mkdirSync(targetPath, true)
      this.restoreSync(value, targetPath)
    }
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.existsSync(path) ? this.readSync(path) : null
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.writeSync(path, data)
  }

  async delete(path: string): Promise<void> {
    this.unlinkSync(path)
  }

  async list(path: string): Promise<VFSEntry[]> {
    const directoryPath = normalizePath(path)
    const names = this.readdirSync(directoryPath) as string[]

    return names.map(name => {
      const childPath = normalizePath(name, directoryPath)
      const stats = this.statSync(childPath)

      return {
        path: childPath,
        name,
        kind: stats.isFile() ? "file" : stats.isSymbolicLink() ? "symlink" : "directory",
        size: stats.size,
      }
    })
  }

  async stat(path: string): Promise<MarsStats | null> {
    return this.existsSync(path) ? this.statSync(path) : null
  }

  #getNode(path: string, followSymlinks = true): VFSNode {
    const normalizedPath = followSymlinks ? this.#resolveSymlinks(path) : normalizePath(path)
    const node = this.#nodes.get(normalizedPath)
    if (!node) throw new Error(`Path does not exist: ${normalizedPath}`)

    return node
  }

  #getDirectory(path: string): DirectoryNode {
    const node = this.#getNode(path)
    if (node.kind !== "directory") throw new Error(`Not a directory: ${path}`)

    return node
  }

  #resolveSymlinks(path: string, seen = new Set<string>()): string {
    const normalizedPath = normalizePath(path)
    if (normalizedPath === "/") return normalizedPath

    const parts = normalizedPath.slice(1).split("/")
    let currentPath = "/"

    for (const [index, part] of parts.entries()) {
      currentPath = normalizePath(part, currentPath)
      const node = this.#nodes.get(currentPath)
      if (node?.kind !== "symlink") continue
      if (seen.has(currentPath)) throw new Error(`Symbolic link cycle: ${currentPath}`)

      seen.add(currentPath)
      const rest = parts.slice(index + 1).join("/")
      const nextPath = rest ? normalizePath(rest, node.target) : node.target
      return this.#resolveSymlinks(nextPath, seen)
    }

    return normalizedPath
  }
}

function createDirectoryNode(path: string): DirectoryNode {
  const now = new Date()

  return {
    kind: "directory",
    path,
    children: new Set(),
    mode: 0o755,
    atime: now,
    mtime: now,
    ctime: now,
  }
}