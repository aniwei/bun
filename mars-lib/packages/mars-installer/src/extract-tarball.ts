import { isFileTreeSymlink } from "@mars/vfs"

import type { FileTree } from "@mars/vfs"

const tarBlockSize = 512
const gzipMagicByte0 = 0x1f
const gzipMagicByte1 = 0x8b

export async function extractPackageTarball(data: Uint8Array): Promise<FileTree> {
  const tarBytes = await maybeGunzip(data)
  const files: FileTree = {}
  let offset = 0
  let nextPaxPath: string | null = null
  let nextPaxLinkPath: string | null = null

  while (offset + tarBlockSize <= tarBytes.byteLength) {
    const header = tarBytes.subarray(offset, offset + tarBlockSize)
    offset += tarBlockSize
    if (isEmptyBlock(header)) break

    const headerName = readHeaderString(header, 0, 100)
    const headerPrefix = readHeaderString(header, 345, 155)
    const headerLinkName = readHeaderString(header, 157, 100)
    const size = readOctal(header, 124, 12)
    const typeFlag = header[156]
    const content = tarBytes.subarray(offset, offset + size)
    offset += Math.ceil(size / tarBlockSize) * tarBlockSize

    if (typeFlag === 120) {
      const paxAttributes = readPaxAttributes(content)
      nextPaxPath = paxAttributes.path ?? nextPaxPath
      nextPaxLinkPath = paxAttributes.linkpath ?? nextPaxLinkPath
      continue
    }

    const entryName = normalizeTarEntryPath(
      nextPaxPath ?? headerName,
      nextPaxPath ? "" : headerPrefix,
    )
    const linkTarget = entryName ? normalizeTarLinkTarget(entryName, nextPaxLinkPath ?? headerLinkName) : null
    nextPaxPath = null
    nextPaxLinkPath = null

    if (!entryName || typeFlag === 53) continue
    if (typeFlag === 50) {
      if (linkTarget) setSymlink(files, entryName, linkTarget)
      continue
    }
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
  const value = readHeaderString(block, offset, length)
  return value ? Number.parseInt(value, 8) : 0
}

function readPaxAttributes(content: Uint8Array): Record<string, string> {
  const text = new TextDecoder().decode(content)
  const attributes: Record<string, string> = {}

  for (const line of text.split("\n")) {
    const match = /^\d+ ([^=]+)=(.*)$/.exec(line)
    if (match) attributes[match[1]] = match[2]
  }

  return attributes
}

function normalizeTarEntryPath(name: string, prefix: string): string | null {
  const fullPath = [prefix, name].filter(Boolean).join("/").replace(/^\.\/+/, "")
  if (fullPath.startsWith("/")) return null

  const withoutPackagePrefix = fullPath.startsWith("package/")
    ? fullPath.slice("package/".length)
    : fullPath
  const pathParts = withoutPackagePrefix.split("/")
  if (pathParts.some(part => part === "..")) return null

  const cleanPath = withoutPackagePrefix
    .split("/")
    .filter(part => part && part !== ".")
    .join("/")

  if (!cleanPath) return null
  return cleanPath
}

function normalizeTarLinkTarget(entryName: string, target: string): string | null {
  const normalizedTarget = target.replaceAll("\\", "/").replace(/^\.\/+/, "")
  if (!normalizedTarget || normalizedTarget.startsWith("/")) return null

  const entryParentParts = entryName.split("/").slice(0, -1)
  const resolvedParts = [...entryParentParts]
  const targetParts = normalizedTarget.split("/").filter(part => part && part !== ".")

  for (const part of targetParts) {
    if (part === "..") {
      if (!resolvedParts.length) return null
      resolvedParts.pop()
      continue
    }

    resolvedParts.push(part)
  }

  if (!resolvedParts.length) return null

  return targetParts.join("/") || null
}

function setFile(tree: FileTree, path: string, data: Uint8Array): void {
  const cursor = ensureDirectory(tree, path)
  const fileName = path.split("/").at(-1)
  if (fileName) cursor[fileName] = data
}

function setSymlink(tree: FileTree, path: string, target: string): void {
  const cursor = ensureDirectory(tree, path)
  const fileName = path.split("/").at(-1)
  if (fileName) cursor[fileName] = { kind: "symlink", target }
}

function ensureDirectory(tree: FileTree, path: string): FileTree {
  const parts = path.split("/")
  let cursor = tree

  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    if (next && typeof next === "object" && !(next instanceof Uint8Array) && !isFileTreeSymlink(next)) {
      cursor = next
      continue
    }

    const directory: FileTree = {}
    cursor[part] = directory
    cursor = directory
  }

  return cursor
}
