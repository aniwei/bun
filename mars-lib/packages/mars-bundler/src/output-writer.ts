import { dirname } from "@mars/vfs"

import type { MarsVFS } from "@mars/vfs"
import type { BuildOutputArtifact } from "./types"
import type { Loader } from "@mars/transpiler"

export interface PendingBuildOutput {
  path: string
  code: string
  loader: Loader
  map?: string
  mapPath?: string
}

export async function writeBuildOutputs(
  vfs: MarsVFS,
  outputs: PendingBuildOutput[],
): Promise<BuildOutputArtifact[]> {
  const artifacts: BuildOutputArtifact[] = []

  for (const output of outputs) {
    await vfs.mkdir(dirname(output.path), { recursive: true })
    await vfs.writeFile(output.path, output.code)
    artifacts.push(await createBuildOutputArtifact(output))

    if (output.map && output.mapPath) {
      await vfs.writeFile(output.mapPath, output.map)
      artifacts.push(await createSourceMapArtifact(output.mapPath, output.map))
    }
  }

  return artifacts
}

async function createSourceMapArtifact(path: string, sourceMap: string): Promise<BuildOutputArtifact> {
  const bytes = new TextEncoder().encode(sourceMap)
  const hash = await computeHash(bytes)

  return {
    path,
    kind: "source-map",
    loader: "json",
    size: bytes.byteLength,
    hash,
    text: async () => sourceMap,
    arrayBuffer: async () => {
      const arrayBuffer = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(arrayBuffer).set(bytes)

      return arrayBuffer
    },
  }
}

async function createBuildOutputArtifact(output: PendingBuildOutput): Promise<BuildOutputArtifact> {
  const bytes = new TextEncoder().encode(output.code)
  const hash = await computeHash(bytes)

  return {
    path: output.path,
    kind: "entry-point",
    loader: output.loader,
    size: bytes.byteLength,
    hash,
    text: async () => output.code,
    arrayBuffer: async () => {
      const arrayBuffer = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(arrayBuffer).set(bytes)

      return arrayBuffer
    },
  }
}

async function computeHash(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const hashBuffer = await crypto.subtle.digest("SHA-256", input)
  const hashBytes = new Uint8Array(hashBuffer)

  return Array.from(hashBytes, byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 16)
}