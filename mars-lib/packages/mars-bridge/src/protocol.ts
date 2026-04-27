export type MarsMessageSource = "client" | "sw" | "kernel" | "process" | "wasm"

export type MarsMessageTarget = "client" | "sw" | "kernel" | "process" | "wasm"

export type MarsMessageType =
  | "kernel.boot"
  | "kernel.shutdown"
  | "kernel.spawn"
  | "kernel.kill"
  | "kernel.waitpid"
  | "kernel.stdio"
  | "server.listen"
  | "server.close"
  | "server.request"
  | "vfs.read"
  | "vfs.write"
  | "vfs.stat"
  | "vfs.readdir"
  | "vfs.watch"
  | "module.resolve"
  | "module.load"
  | "module.transform"
  | "shell.run"
  | "shell.complete"
  | "hook.call"
  | string

export interface MarsMessage<T = unknown> {
  id: string
  type: MarsMessageType
  source: MarsMessageSource
  target: MarsMessageTarget
  pid?: number
  traceId?: string
  payload: T
}

export interface MarsResponse<T = unknown> {
  id: string
  ok: boolean
  payload?: T
  error?: SerializedError
}

export interface SerializedError {
  name: string
  message: string
  stack?: string
  code?: string
  cause?: unknown
}

export interface Disposable {
  dispose(): void
}

export interface BridgeRequestOptions {
  target?: MarsMessageTarget
  pid?: number
  traceId?: string
  signal?: AbortSignal
  timeoutMs?: number
  transfer?: Transferable[]
}

export interface MarsBridgeEndpoint {
  request<TReq, TRes>(
    type: string,
    payload: TReq,
    options?: BridgeRequestOptions,
  ): Promise<TRes>

  notify<T>(type: string, payload: T): void

  on<T>(
    type: string,
    listener: (payload: T, message: MarsMessage<T>) => void,
  ): Disposable

  close(): void
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
      ...("cause" in error ? { cause: error.cause } : {}),
    }
  }

  return {
    name: "Error",
    message: String(error),
  }
}