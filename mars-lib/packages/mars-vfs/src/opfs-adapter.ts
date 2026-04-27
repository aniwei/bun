export interface MarsPersistenceAdapter {
  readonly kind: "opfs" | "memory"
  open(): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  set(key: string, value: string | Uint8Array): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
  close(): Promise<void>
}

export interface OPFSPersistenceAdapterOptions {
  namespace?: string
  scope?: typeof globalThis
  fallback?: "memory" | "error"
}

interface OPFSScope {
  navigator?: {
    storage?: {
      getDirectory?: () => Promise<OPFSDirectoryHandle>
    }
  }
}

interface OPFSDirectoryHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OPFSFileHandle>
  removeEntry(name: string): Promise<void>
  keys?(): AsyncIterableIterator<string>
}

interface OPFSFileHandle {
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>
  createWritable(): Promise<OPFSWritableFileStream>
}

interface OPFSWritableFileStream {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
}

export function createOPFSPersistenceAdapter(
  options: OPFSPersistenceAdapterOptions = {},
): MarsPersistenceAdapter {
  const scope = options.scope ?? globalThis
  const getDirectory = (scope as OPFSScope).navigator?.storage?.getDirectory

  if (typeof getDirectory === "function") {
    return new BrowserOPFSPersistenceAdapter(getDirectory, options.namespace ?? "mars-vfs")
  }

  if (options.fallback === "error") {
    throw new Error("OPFS is not available in this browser profile")
  }

  return new MemoryPersistenceAdapter()
}

class BrowserOPFSPersistenceAdapter implements MarsPersistenceAdapter {
  readonly kind = "opfs"
  readonly #getDirectory: () => Promise<OPFSDirectoryHandle>
  readonly #namespace: string
  #directory: OPFSDirectoryHandle | null = null

  constructor(getDirectory: () => Promise<OPFSDirectoryHandle>, namespace: string) {
    this.#getDirectory = getDirectory
    this.#namespace = namespace
  }

  async open(): Promise<void> {
    this.#directory = await this.#getDirectory()
  }

  async get(key: string): Promise<Uint8Array | null> {
    const directory = await this.#requireDirectory()

    try {
      const file = await (await directory.getFileHandle(this.#storageKey(key))).getFile()
      return new Uint8Array(await file.arrayBuffer())
    } catch {
      return null
    }
  }

  async set(key: string, value: string | Uint8Array): Promise<void> {
    const directory = await this.#requireDirectory()
    const fileHandle = await directory.getFileHandle(this.#storageKey(key), { create: true })
    const writable = await fileHandle.createWritable()

    await writable.write(toBytes(value))
    await writable.close()
  }

  async delete(key: string): Promise<void> {
    const directory = await this.#requireDirectory()

    try {
      await directory.removeEntry(this.#storageKey(key))
    } catch {
      // Removing a missing OPFS entry should be idempotent for the persistence adapter.
    }
  }

  async keys(): Promise<string[]> {
    const directory = await this.#requireDirectory()
    if (!directory.keys) return []

    const prefix = `${this.#namespace}:`
    const keys: string[] = []
    for await (const key of directory.keys()) {
      if (key.startsWith(prefix)) keys.push(key.slice(prefix.length))
    }

    return keys.sort()
  }

  async close(): Promise<void> {
    this.#directory = null
  }

  async #requireDirectory(): Promise<OPFSDirectoryHandle> {
    if (!this.#directory) await this.open()
    if (!this.#directory) throw new Error("OPFS adapter is not open")

    return this.#directory
  }

  #storageKey(key: string): string {
    return `${this.#namespace}:${key}`
  }
}

class MemoryPersistenceAdapter implements MarsPersistenceAdapter {
  readonly kind = "memory"
  readonly #entries = new Map<string, Uint8Array>()
  #open = false

  async open(): Promise<void> {
    this.#open = true
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.#assertOpen()
    return this.#entries.get(key)?.slice() ?? null
  }

  async set(key: string, value: string | Uint8Array): Promise<void> {
    this.#assertOpen()
    this.#entries.set(key, toBytes(value))
  }

  async delete(key: string): Promise<void> {
    this.#assertOpen()
    this.#entries.delete(key)
  }

  async keys(): Promise<string[]> {
    this.#assertOpen()
    return [...this.#entries.keys()].sort()
  }

  async close(): Promise<void> {
    this.#open = false
  }

  #assertOpen(): void {
    if (!this.#open) throw new Error("Persistence adapter is not open")
  }
}

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value.slice()
}
