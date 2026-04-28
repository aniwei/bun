import type { FileTree } from "@mars/vfs"

const tarBlockSize = 512
const gzipMagicByte0 = 0x1f
const gzipMagicByte1 = 0x8b

export async function extractPackageTarball(data: Uint8Array): Promise<FileTree> {
  const tarBytes = await maybeGunzip(data)
  const files: FileTree = {}
  let offset = 0

  while (offset + tarBlockSize <= tarBytes.byteLength) {
    const header = tarBytes.subarray(offset, offset + tarBlockSize)
    offset += tarBlockSize
    if (isEmptyBlock(header)) break

    const entryName = normalizeTarEntryPath(readHeaderString(header, 0, 100), readHeaderString(header, 345, 155))
    const size = readOctal(header, 124, 12)
    const typeFlag = header[156]
    const content = tarBytes.subarray(offset, offset + size)
    offset += Math.ceil(size / tarBlockSize) * tarBlockSize

    if (!entryName || typeFlag === 53) continue
    if (typeFlag !== 0 && typeFlag !== 48) continue

    setFile(files, entryName, content.slice())
  }

  return files
}

async function maybeGunzip(data: Uint8Array): Promise<Uint8Array> {
  if (data[0] !== gzipMagicByte0 || data[1] !== gzipMagicByte1) return data
  if (typeof DecompressionStream !== "function") {
    throw new Error("gzip tarball extraction requires DecompressionStream")
  }

  const stream = new Blob([toArrayBuffer(data)]).stream().pipeThrough(new DecompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

function isEmptyBlock(block: Uint8Array): boolean {
  return block.every(byte => byte === 0)
}

function readHeaderString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end)).trim()
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const value = readHeaderString(block, offset, length).replace(/\0.*$/, "").trim()
  return value ? Number.parseInt(value, 8) : 0
}

function normalizeTarEntryPath(name: string, prefix: string): string | null {
  const fullPath = [prefix, name].filter(Boolean).join("/").replace(/^\.\/+/, "")
  const withoutPackagePrefix = fullPath.startsWith("package/")
    ? fullPath.slice("package/".length)
    : fullPath
  const cleanPath = withoutPackagePrefix
    .split("/")
    .filter(part => part && part !== ".")
    .join("/")

  if (!cleanPath || cleanPath.startsWith("../") || cleanPath.includes("/../")) return null
  return cleanPath
}

function setFile(tree: FileTree, path: string, data: Uint8Array): void {
  const parts = path.split("/")
  let cursor = tree

  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    if (next && typeof next === "object" && !(next instanceof Uint8Array)) {
      cursor = next
      continue
    }

    const directory: FileTree = {}
    cursor[part] = directory
    cursor = directory
  }

  const fileName = parts.at(-1)
  if (fileName) cursor[fileName] = data
}
