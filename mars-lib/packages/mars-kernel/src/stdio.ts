export type MarsStdioChunk = string | Uint8Array

export interface MarsStdioBridgeOptions {
  stdout?: WritableStream<Uint8Array>
  stderr?: WritableStream<Uint8Array>
}

export interface MarsStdioBridge {
  readonly stdin: ReadableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  writeStdin(chunk: MarsStdioChunk): Promise<void>
  pipeStdin(stream: ReadableStream<Uint8Array>): Promise<void>
  writeStdout(chunk: MarsStdioChunk): Promise<void>
  writeStderr(chunk: MarsStdioChunk): Promise<void>
  closeStdin(): void
  closeOutput(): void
}

export function createMarsStdioBridge(options: MarsStdioBridgeOptions = {}): MarsStdioBridge {
  const stdin = new MarsStdioChannel()
  const stdout = new MarsStdioChannel(options.stdout)
  const stderr = new MarsStdioChannel(options.stderr)

  return {
    stdin: stdin.readable,
    stdout: stdout.readable,
    stderr: stderr.readable,
    writeStdin: chunk => stdin.write(chunk),
    pipeStdin: stream => pipeReadableToChannel(stream, stdin),
    writeStdout: chunk => stdout.write(chunk),
    writeStderr: chunk => stderr.write(chunk),
    closeStdin: () => stdin.close(),
    closeOutput: () => {
      stdout.close()
      stderr.close()
    },
  }
}

class MarsStdioChannel {
  readonly readable: ReadableStream<Uint8Array>
  readonly #mirrorWriter: WritableStreamDefaultWriter<Uint8Array> | null
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null
  #closed = false

  constructor(mirror?: WritableStream<Uint8Array>) {
    this.#mirrorWriter = mirror?.getWriter() ?? null
    this.readable = new ReadableStream<Uint8Array>({
      start: controller => {
        this.#controller = controller
      },
    })
  }

  async write(chunk: MarsStdioChunk): Promise<void> {
    if (this.#closed) throw new Error("Stdio channel is closed")

    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk.slice()
    this.#controller?.enqueue(bytes)
    await this.#mirrorWriter?.write(bytes)
  }

  close(): void {
    if (this.#closed) return

    this.#closed = true
    this.#controller?.close()
    void this.#mirrorWriter?.close()
  }
}

async function pipeReadableToChannel(
  stream: ReadableStream<Uint8Array>,
  channel: MarsStdioChannel,
): Promise<void> {
  const reader = stream.getReader()

  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      await channel.write(result.value)
    }
  } finally {
    channel.close()
    reader.releaseLock()
  }
}
