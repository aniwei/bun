import type { RuntimeContext, MarsBunFile } from "./types"

export async function bunWrite(
  context: RuntimeContext,
  destination: string | URL | MarsBunFile,
  input: BlobPart | Response | Request,
): Promise<number> {
  const targetPath = typeof destination === "string"
    ? destination
    : destination instanceof URL
      ? destination.pathname
      : destination.path
  const bytes = await inputToBytes(input)

  await context.vfs.writeFile(targetPath, bytes)
  return bytes.byteLength
}

async function inputToBytes(input: BlobPart | Response | Request): Promise<Uint8Array> {
  if (typeof input === "string") return new TextEncoder().encode(input)
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (input instanceof Blob) return new Uint8Array(await input.arrayBuffer())
  if (input instanceof Response || input instanceof Request) {
    return new Uint8Array(await input.arrayBuffer())
  }

  return new TextEncoder().encode(String(input))
}