// Blob / File Bun extension attribute patch (RFC §8.3)
// Browser-native Blob/File are already available.  Bun adds a few extra
// properties that scripts may rely on:
//   - `Blob.prototype.writer()` — writable-stream helper
//   - `File.prototype.lastModifiedDate` — legacy Date getter
//
// We patch these onto the prototypes if they are missing.

export function installBlobFilePatch(): void {
  if (typeof globalThis.Blob === 'undefined') return

  // Blob.prototype.writer() — returns a writable stream backed by the blob
  // In M2 we provide a minimal writable sink that collects chunks.
  if (!('writer' in Blob.prototype)) {
    ;(Blob.prototype as Record<string, unknown>)['writer'] = function blobWriter(
      this: Blob
    ): WritableStreamDefaultWriter<Uint8Array> {
      const chunks: Uint8Array[] = []
      const stream = new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer))
        },
      })
      return stream.getWriter()
    }
  }

  if (typeof globalThis.File === 'undefined') return

  // File.prototype.lastModifiedDate — deprecated but used by legacy code
  if (!Object.getOwnPropertyDescriptor(File.prototype, 'lastModifiedDate')) {
    Object.defineProperty(File.prototype, 'lastModifiedDate', {
      get(this: File) {
        return new Date(this.lastModified)
      },
      configurable: true,
    })
  }
}
