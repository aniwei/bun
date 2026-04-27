function normalizePath(path: string): string {
  if (!path || path === '/') return '/'
  return '/' + path.split('/').filter(Boolean).join('/')
}

function splitPath(path: string): string[] {
  return normalizePath(path).split('/').filter(Boolean)
}

function createErr(code: string, message: string): Error {
  const error = new Error(message)
  ;(error as NodeJS.ErrnoException).code = code
  return error
}

type NativeFile = {
  arrayBuffer(): Promise<ArrayBuffer>
}

type NativeSyncAccessHandle = {
  write(data: BufferSource, options?: { at?: number }): number
  flush?(): void
  close(): void
}

type NativeWritable = {
  write(data: BufferSource): Promise<void>
  close(): Promise<void>
}

type NativeFileHandle = {
  kind: 'file'
  name: string
  getFile(): Promise<NativeFile>
  createSyncAccessHandle?(): Promise<NativeSyncAccessHandle>
  createWritable?(): Promise<NativeWritable>
}

type NativeDirectoryHandle = {
  kind: 'directory'
  name: string
  entries(): AsyncIterable<[string, NativeDirectoryHandle | NativeFileHandle]>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<NativeDirectoryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<NativeFileHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
}

type StorageManagerLike = {
  getDirectory?: () => Promise<NativeDirectoryHandle>
}

type NavigatorLike = {
  storage?: StorageManagerLike
}

export interface NativePersistenceStats {
  nativeEnabled: boolean
  attempts: number
  successes: number
  failures: number
  syncFallbacks: number
  lastErrorCode: string | null
  lastErrorMessage: string | null
}

export class OPFSAdapter {
  private readonly files = new Map<string, Uint8Array>()
  private readonly directories = new Set<string>(['/'])
  private nativeRoot: NativeDirectoryHandle | null = null
  private nativeStats: NativePersistenceStats = {
    nativeEnabled: false,
    attempts: 0,
    successes: 0,
    failures: 0,
    syncFallbacks: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
  }

  static async open(root = '/'): Promise<OPFSAdapter> {
    const adapter = new OPFSAdapter()
    const nativeRoot = await adapter.resolveNativeRoot(root)
    if (nativeRoot) {
      adapter.nativeRoot = nativeRoot
      adapter.nativeStats.nativeEnabled = true
      await adapter.hydrateFromNative(nativeRoot, '/')
    }
    return adapter
  }

  getNativePersistenceStats(): NativePersistenceStats {
    return { ...this.nativeStats }
  }

  resetNativePersistenceStats(): void {
    this.nativeStats = {
      nativeEnabled: this.nativeRoot !== null,
      attempts: 0,
      successes: 0,
      failures: 0,
      syncFallbacks: 0,
      lastErrorCode: null,
      lastErrorMessage: null,
    }
  }

  readSync(path: string): Uint8Array {
    const normalized = normalizePath(path)
    const found = this.files.get(normalized)
    if (!found) {
      throw createErr('ENOENT', `File not found: ${normalized}`)
    }

    return found
  }

  writeSync(path: string, data: Uint8Array): void {
    const normalized = normalizePath(path)
    const parent = this.parentDir(normalized)
    if (!this.directories.has(parent)) {
      throw createErr('ENOENT', `Directory not found: ${parent}`)
    }

    this.ensureAncestorDirs(normalized)
    const bytes = Uint8Array.from(data)
    this.files.set(normalized, bytes)
    this.persistNative(async () => {
      const directory = await this.getNativeDirectoryHandle(parent, true)
      const fileName = this.baseName(normalized)
      const fileHandle = await directory.getFileHandle(fileName, { create: true })
      await this.writeNativeFileWithRecovery(fileHandle, bytes)
    })
  }

  unlinkSync(path: string): void {
    const normalized = normalizePath(path)
    if (!this.files.delete(normalized)) {
      throw createErr('ENOENT', `File not found: ${normalized}`)
    }

    this.persistNative(async () => {
      const parent = this.parentDir(normalized)
      const directory = await this.getNativeDirectoryHandle(parent, false)
      await directory.removeEntry(this.baseName(normalized))
    })
  }

  readdirSync(path: string): string[] {
    const normalized = normalizePath(path)
    if (!this.directories.has(normalized)) {
      if (this.files.has(normalized)) {
        throw createErr('ENOTDIR', `Not a directory: ${normalized}`)
      }
      throw createErr('ENOENT', `Directory not found: ${normalized}`)
    }

    const prefix = normalized === '/' ? '/' : normalized + '/'
    const output = new Set<string>()

    for (const dir of this.directories) {
      if (!dir.startsWith(prefix) || dir === normalized) continue
      const rest = dir.slice(prefix.length)
      const [name] = rest.split('/')
      if (name) output.add(name)
    }

    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue
      const rest = file.slice(prefix.length)
      const [name] = rest.split('/')
      if (name) output.add(name)
    }

    return Array.from(output)
  }

  mkdirSync(path: string): void {
    const normalized = normalizePath(path)
    this.ensureAncestorDirs(normalized)
    this.directories.add(normalized)
    this.persistNative(async () => {
      await this.getNativeDirectoryHandle(normalized, true)
    })
  }

  private async resolveNativeRoot(root: string): Promise<NativeDirectoryHandle | null> {
    const navigatorLike = (globalThis as { navigator?: NavigatorLike }).navigator
    const storage = navigatorLike?.storage
    if (!storage?.getDirectory) {
      return null
    }

    let directory = await storage.getDirectory()
    for (const part of splitPath(root)) {
      directory = await directory.getDirectoryHandle(part, { create: true })
    }
    return directory
  }

  private async hydrateFromNative(directory: NativeDirectoryHandle, logicalPath: string): Promise<void> {
    this.directories.add(logicalPath)

    for await (const [name, handle] of directory.entries()) {
      const childPath = logicalPath === '/' ? `/${name}` : `${logicalPath}/${name}`
      if (handle.kind === 'directory') {
        this.directories.add(childPath)
        await this.hydrateFromNative(handle, childPath)
        continue
      }

      const file = await handle.getFile()
      this.files.set(childPath, new Uint8Array(await file.arrayBuffer()))
    }
  }

  private persistNative(task: () => Promise<void>): void {
    if (!this.nativeRoot) return
    this.nativeStats.attempts += 1
    void task()
      .then(() => {
        this.nativeStats.successes += 1
      })
      .catch((error: unknown) => {
        this.nativeStats.failures += 1
        if (error && typeof error === 'object') {
          const e = error as { code?: unknown; message?: unknown }
          this.nativeStats.lastErrorCode = typeof e.code === 'string' ? e.code : null
          this.nativeStats.lastErrorMessage = typeof e.message === 'string' ? e.message : String(error)
        } else {
          this.nativeStats.lastErrorCode = null
          this.nativeStats.lastErrorMessage = String(error)
        }
        // M1 keeps sync mirror as source of truth; native persistence is best-effort.
      })
  }

  private async getNativeDirectoryHandle(path: string, create: boolean): Promise<NativeDirectoryHandle> {
    if (!this.nativeRoot) {
      throw createErr('ENOENT', 'Native OPFS root is unavailable')
    }

    let directory = this.nativeRoot
    for (const part of splitPath(path)) {
      directory = await directory.getDirectoryHandle(part, { create })
    }
    return directory
  }

  private async writeNativeFileWithRecovery(fileHandle: NativeFileHandle, bytes: Uint8Array): Promise<void> {
    const payloadBuffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(payloadBuffer).set(bytes)
    const payload = new Uint8Array(payloadBuffer)

    if (fileHandle.createSyncAccessHandle) {
      try {
        const accessHandle = await fileHandle.createSyncAccessHandle()
        accessHandle.write(payload)
        accessHandle.flush?.()
        accessHandle.close()
        return
      } catch {
        // Recovery path: some browsers may expose the API but fail at runtime.
        this.nativeStats.syncFallbacks += 1
      }
    }

    if (fileHandle.createWritable) {
      const writable = await fileHandle.createWritable()
      await writable.write(payload)
      await writable.close()
      return
    }

    throw createErr('EIO', `No writable path for native file handle: ${fileHandle.name}`)
  }

  private ensureAncestorDirs(path: string): void {
    const parts = normalizePath(path).split('/').filter(Boolean)
    let current = ''
    for (let i = 0; i < parts.length - 1; i++) {
      current += '/' + parts[i]
      this.directories.add(current)
    }
  }

  private parentDir(path: string): string {
    const normalized = normalizePath(path)
    if (normalized === '/') return '/'
    const lastSlash = normalized.lastIndexOf('/')
    return lastSlash <= 0 ? '/' : normalized.slice(0, lastSlash)
  }

  private baseName(path: string): string {
    const normalized = normalizePath(path)
    if (normalized === '/') return '/'
    return normalized.slice(normalized.lastIndexOf('/') + 1)
  }
}
