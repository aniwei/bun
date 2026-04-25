import type { MarsWebProcessShape, ProcessChunk } from '@mars/web-node'

type VFSLike = {
  readFileSync(path: string): Buffer
  writeFileSync(path: string, data: Buffer | string): void
}

type BunFileLike = {
  arrayBuffer(): Promise<ArrayBuffer>
  bytes(): Promise<Uint8Array>
  text(): Promise<string>
}

export interface BunGlobalShape {
  argv: string[]
  cwd(): string
  env: Record<string, string>
  file(path: string): BunFileLike
  nanoseconds(): bigint
  sleep(ms: number): Promise<void>
  stderr: MarsWebProcessShape['stderr']
  stdin: MarsWebProcessShape['stdin']
  stdout: MarsWebProcessShape['stdout']
  version: string
  write(path: string, data: Buffer | string | Uint8Array): Promise<number>
}

function nowNanoseconds(): bigint {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return BigInt(Math.round(performance.now() * 1_000_000))
  }

  return BigInt(Date.now()) * 1_000_000n
}

function toUint8Array(data: Buffer | string | Uint8Array): Uint8Array {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data)
  }

  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

function decodeChunk(chunk: ProcessChunk | null): string {
  if (chunk == null) {
    return ''
  }

  return typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
}

function createBunFile(vfs: VFSLike, path: string): BunFileLike {
  return {
    async arrayBuffer() {
      const bytes = vfs.readFileSync(path)
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
    async bytes() {
      return new Uint8Array(vfs.readFileSync(path))
    },
    async text() {
      return new TextDecoder().decode(vfs.readFileSync(path))
    },
  }
}

export function installBunGlobals(
  proc: MarsWebProcessShape,
  options: {
    argv: string[]
    cwd: string
    env: Record<string, string>
    vfs?: VFSLike | null
  },
): BunGlobalShape {
  const scope = globalThis as Record<string, unknown>
  const existing = (scope.Bun ?? {}) as Record<string, unknown>

  const bun = {
    ...existing,
    argv: options.argv,
    cwd: () => options.cwd,
    env: options.env,
    file: (path: string) => {
      if (!options.vfs) {
        throw new Error('Bun.file requires VFS in bun-web-runtime')
      }
      return createBunFile(options.vfs, path)
    },
    nanoseconds: () => nowNanoseconds(),
    sleep(ms: number) {
      return new Promise(resolve => {
        setTimeout(resolve, Math.max(0, ms))
      })
    },
    stderr: proc.stderr,
    stdin: {
      ...proc.stdin,
      read(size?: number) {
        return decodeChunk(proc.stdin.read(size))
      },
    },
    stdout: proc.stdout,
    version: proc.version,
    async write(path: string, data: Buffer | string | Uint8Array) {
      if (!options.vfs) {
        throw new Error('Bun.write requires VFS in bun-web-runtime')
      }

      const bytes = toUint8Array(data)
      options.vfs.writeFileSync(path, bytes)
      return bytes.byteLength
    },
  } satisfies BunGlobalShape

  scope.__BUN_WEB_BUN__ = bun

  if (scope.Bun && typeof scope.Bun === 'object') {
    for (const [key, value] of Object.entries(bun)) {
      try {
        ;(scope.Bun as Record<string, unknown>)[key] = value
      } catch {
        // Host Bun exposes several readonly members; keep the bun-web mirror on
        // __BUN_WEB_BUN__ and patch only the properties that are writable.
      }
    }

    return scope.Bun as BunGlobalShape
  }

  Object.defineProperty(scope, 'Bun', {
    value: bun,
    writable: true,
    configurable: true,
    enumerable: true,
  })

  return bun
}