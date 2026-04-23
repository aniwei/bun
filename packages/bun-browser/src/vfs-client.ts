/**
 * VFS client —— UI 线程侧辅助，用于构造要发送到 Worker 的 VFS snapshot 缓冲区。
 *
 * Snapshot 二进制格式（小端）：
 *   [u32 file_count]
 *   { [u32 path_len][u8[] path][u32 data_len][u8[] data][u16 mode] } × file_count
 *
 * 必须与 `src/sys_wasm/vfs.zig` 的 `loadSnapshot` / `exportSnapshot` 保持一致。
 */

export interface VfsFile {
  path: string
  data: Uint8Array | string
  /** POSIX mode bits（例如 0o644），缺省 0o644。 */
  mode?: number
}

const encoder = new TextEncoder()

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? encoder.encode(data) : data
}

/** 计算 snapshot 所需字节数。 */
export function snapshotSize(files: readonly VfsFile[]): number {
  let total = 4 // u32 file_count
  for (const f of files) {
    const pathBytes = encoder.encode(f.path).byteLength
    const dataBytes = toBytes(f.data).byteLength
    total += 4 + pathBytes + 4 + dataBytes + 2
  }
  return total
}

/** 序列化一组文件为 snapshot 缓冲区（返回 transferable ArrayBuffer）。 */
export function buildSnapshot(files: readonly VfsFile[]): ArrayBuffer {
  const buf = new ArrayBuffer(snapshotSize(files))
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  let off = 0

  view.setUint32(off, files.length, true)
  off += 4

  for (const f of files) {
    const path = encoder.encode(f.path)
    const data = toBytes(f.data)
    const mode = f.mode ?? 0o644

    view.setUint32(off, path.byteLength, true)
    off += 4
    bytes.set(path, off)
    off += path.byteLength

    view.setUint32(off, data.byteLength, true)
    off += 4
    bytes.set(data, off)
    off += data.byteLength

    view.setUint16(off, mode & 0xffff, true)
    off += 2
  }

  return buf
}

/** 解析 snapshot（主要用于测试/调试）。 */
export function parseSnapshot(buf: ArrayBuffer): VfsFile[] {
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  const decoder = new TextDecoder('utf-8')
  let off = 0
  const count = view.getUint32(off, true)
  off += 4
  const out: VfsFile[] = []
  for (let i = 0; i < count; i++) {
    const pathLen = view.getUint32(off, true)
    off += 4
    const path = decoder.decode(bytes.subarray(off, off + pathLen))
    off += pathLen
    const dataLen = view.getUint32(off, true)
    off += 4
    const data = bytes.slice(off, off + dataLen)
    off += dataLen
    const mode = view.getUint16(off, true)
    off += 2
    out.push({ path, data, mode })
  }
  return out
}

// ---------------------------------------------------------------------------
// WebContainer 兼容的 FileSystemTree 格式转换
// ---------------------------------------------------------------------------

/** 文件节点（WebContainer FileSystemTree 兼容格式）。 */
export type FileNode = FileLeaf | DirectoryNode

export interface FileLeaf {
  file: {
    contents: string | Uint8Array
  }
}

export interface DirectoryNode {
  directory: FileSystemTree
}

/**
 * WebContainer 兼容的文件系统树。
 *
 * 键为文件/目录名（不含路径分隔符），值为 FileNode。
 * 等同于 `@webcontainer/api` 的 `FileSystemTree` 类型。
 */
export type FileSystemTree = {
  [name: string]: FileNode
}

/**
 * 将 WebContainer `FileSystemTree` 递归展平为 `VfsFile[]` 列表。
 *
 * @param tree  要展平的文件系统树
 * @param prefix  挂载前缀（绝对路径，默认 "/"），不含末尾斜线
 */
export function fileSystemTreeToVfsFiles(tree: FileSystemTree, prefix = ''): VfsFile[] {
  const out: VfsFile[] = []
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix

  function walk(node: FileSystemTree, dir: string): void {
    for (const [name, child] of Object.entries(node)) {
      const fullPath = `${dir}/${name}`
      if ('file' in child) {
        out.push({ path: fullPath, data: child.file.contents })
      } else if ('directory' in child) {
        walk(child.directory, fullPath)
      }
    }
  }

  walk(tree, base)
  return out
}

/**
 * 将 `VfsFile[]` 列表还原为 `FileSystemTree`。
 *
 * @param files  VFS 文件列表（通常来自 `parseSnapshot()`）。
 * @param prefix  仅包含此前缀下的文件（绝对路径，默认 "/"），不含末尾斜线。
 *                传入 "/" 代表全部文件。
 */
export function vfsFilesToFileSystemTree(files: readonly VfsFile[], prefix = '/'): FileSystemTree {
  const base = prefix === '/' ? '' : prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  const root: FileSystemTree = {}

  for (const f of files) {
    if (!f.path.startsWith(base + '/') && base !== '') continue
    const rel = base === '' ? f.path : f.path.slice(base.length)
    // rel starts with '/'
    const parts = rel.split('/').filter(Boolean)
    if (parts.length === 0) continue

    let node: FileSystemTree = root
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (!(part in node)) {
        node[part] = { directory: {} }
      }
      const child = node[part]
      if (!('directory' in child)) {
        // Conflict: a file exists where a dir is expected — skip
        break
      }
      node = child.directory
    }

    const fileName = parts[parts.length - 1]
    const data = f.data
    node[fileName] = {
      file: { contents: typeof data === 'string' ? data : (data as Uint8Array) },
    }
  }

  return root
}
