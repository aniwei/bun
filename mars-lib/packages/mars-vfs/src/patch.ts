import { dirname } from "./path"

import type { MarsVFSInterface } from "./types"

export type MarsVFSPatch =
  | MarsVFSWriteFilePatch
  | MarsVFSDeleteFilePatch

export interface MarsVFSWriteFilePatch {
  op: "writeFile"
  path: string
  data: MarsVFSPatchData
}

export interface MarsVFSDeleteFilePatch {
  op: "deleteFile"
  path: string
}

export type MarsVFSPatchData =
  | { encoding: "utf8"; text: string }
  | { encoding: "base64"; data: string }

export function createWriteFilePatch(path: string, data: string | Uint8Array): MarsVFSWriteFilePatch {
  return {
    op: "writeFile",
    path,
    data: typeof data === "string"
      ? { encoding: "utf8", text: data }
      : { encoding: "base64", data: toBase64(data) },
  }
}

export function createDeleteFilePatch(path: string): MarsVFSDeleteFilePatch {
  return {
    op: "deleteFile",
    path,
  }
}

export async function applyVFSPatches(vfs: MarsVFSInterface, patches: readonly MarsVFSPatch[]): Promise<void> {
  for (const patch of patches) {
    await applyVFSPatch(vfs, patch)
  }
}

export async function applyVFSPatch(vfs: MarsVFSInterface, patch: MarsVFSPatch): Promise<void> {
  if (patch.op === "writeFile") {
    const parentDirectory = dirname(patch.path)
    if (!vfs.existsSync(parentDirectory)) await vfs.mkdir(parentDirectory, { recursive: true })
    await vfs.writeFile(patch.path, patchDataToBytes(patch.data))
    return
  }

  if (vfs.existsSync(patch.path)) await vfs.unlink(patch.path)
}

export function patchDataToBytes(data: MarsVFSPatchData): Uint8Array {
  if (data.encoding === "utf8") return new TextEncoder().encode(data.text)
  return fromBase64(data.data)
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}
