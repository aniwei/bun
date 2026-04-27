import type { RuntimeContext, MarsBunFile } from "./types"

export class VFSBunFile implements MarsBunFile {
  readonly path: string
  readonly type: string
  readonly #context: RuntimeContext

  constructor(context: RuntimeContext, path: string | URL, options: BlobPropertyBag = {}) {
    this.#context = context
    this.path = path instanceof URL ? path.pathname : path
    this.type = options.type ?? contentTypeForPath(this.path)
  }

  get size(): number {
    try {
      return this.#context.vfs.statSync(this.path).size
    } catch {
      return 0
    }
  }

  async text(): Promise<string> {
    return this.#context.vfs.readFile(this.path, "utf8") as Promise<string>
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const data = await this.#context.vfs.readFile(this.path)
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data

    const arrayBuffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(arrayBuffer).set(bytes)

    return arrayBuffer
  }

  stream(): ReadableStream<Uint8Array> {
    const file = this

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const buffer = await file.arrayBuffer()
        controller.enqueue(new Uint8Array(buffer))
        controller.close()
      },
    })
  }
}

export function createBunFile(
  context: RuntimeContext,
  path: string | URL,
  options?: BlobPropertyBag,
): MarsBunFile {
  return new VFSBunFile(context, path, options)
}

export function contentTypeForPath(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8"
  if (path.endsWith(".json")) return "application/json; charset=utf-8"
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript; charset=utf-8"
  if (path.endsWith(".css")) return "text/css; charset=utf-8"
  if (path.endsWith(".svg")) return "image/svg+xml"

  return "text/plain; charset=utf-8"
}