import type { FileTree, MarsVFSInterface } from "./types"

export type MarsSerializedFileTree = Record<string, MarsSerializedFileTreeEntry>

export type MarsSerializedFileTreeEntry =
  | { kind: "file"; encoding: "base64"; data: string }
  | { kind: "directory"; children: MarsSerializedFileTree }

export async function snapshotVFS(
  vfs: MarsVFSInterface,
  path = "/",
): Promise<MarsSerializedFileTree> {
  return serializeFileTree(await vfs.snapshot(path))
}

export async function restoreVFSSnapshot(
  vfs: MarsVFSInterface,
  snapshot: MarsSerializedFileTree,
  root?: string,
): Promise<void> {
  await vfs.restore(deserializeFileTree(snapshot), root)
}

export function serializeFileTree(tree: FileTree): MarsSerializedFileTree {
  const serializedTree: MarsSerializedFileTree = {}

  for (const [path, value] of Object.entries(tree)) {
    if (typeof value === "string" || value instanceof Uint8Array) {
      serializedTree[path] = {
        kind: "file",
        encoding: "base64",
        data: toBase64(typeof value === "string" ? new TextEncoder().encode(value) : value),
      }
      continue
    }

    serializedTree[path] = {
      kind: "directory",
      children: serializeFileTree(value),
    }
  }

  return serializedTree
}

export function deserializeFileTree(snapshot: MarsSerializedFileTree): FileTree {
  const tree: FileTree = {}

  for (const [path, value] of Object.entries(snapshot)) {
    tree[path] = value.kind === "file"
      ? fromBase64(value.data)
      : deserializeFileTree(value.children)
  }

  return tree
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
