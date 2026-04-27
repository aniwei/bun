import { dirname } from "@mars/vfs"

import type { MarsVFS } from "@mars/vfs"
import type { BuildOutputArtifact } from "./types"
import type { Loader } from "@mars/transpiler"

export interface PendingBuildOutput {
  path: string
  code: string
  loader: Loader
}

export async function writeBuildOutputs(
  vfs: MarsVFS,
  outputs: PendingBuildOutput[],
): Promise<BuildOutputArtifact[]> {
  const artifacts: BuildOutputArtifact[] = []

  for (const output of outputs) {
    await vfs.mkdir(dirname(output.path), { recursive: true })
    await vfs.writeFile(output.path, output.code)
    artifacts.push(createBuildOutputArtifact(output))
  }

  return artifacts
}

function createBuildOutputArtifact(output: PendingBuildOutput): BuildOutputArtifact {
  const bytes = new TextEncoder().encode(output.code)

  return {
    path: output.path,
    kind: "entry-point",
    loader: output.loader,
    size: bytes.byteLength,
    text: async () => output.code,
    arrayBuffer: async () => {
      const arrayBuffer = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(arrayBuffer).set(bytes)

      return arrayBuffer
    },
  }
}