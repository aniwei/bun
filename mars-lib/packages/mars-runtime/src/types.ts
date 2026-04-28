import type { MarsKernel, ProcessHandle } from "@mars/kernel"
import type { MarsVFS } from "@mars/vfs"
import type { BuildOptions, BuildResult } from "@mars/bundler"
import type { MarsCryptoHasher, MarsPasswordFacade } from "@mars/crypto"
import type { MarsSQLFacade } from "@mars/sqlite"

export interface RuntimeFeatures {
  esbuild: boolean
  swc: boolean
  sql: boolean
}

export interface RuntimeContext {
  vfs: MarsVFS
  kernel: MarsKernel
  pid?: number
  cwd?: string
  argv?: string[]
  env?: Record<string, string>
  scope?: typeof globalThis
  forceGlobals?: boolean
  runtimeFeatures?: RuntimeFeatures
  spawn?(options: MarsBunSpawnOptions): Promise<ProcessHandle>
  spawnSync?(options: MarsBunSpawnOptions): MarsBunSpawnSyncResult
}

export interface MarsBunSpawnOptions {
  cmd: string[]
  cwd?: string
  env?: Record<string, string>
  stdin?: ReadableStream<Uint8Array> | string
  stdout?: WritableStream<Uint8Array>
  stderr?: WritableStream<Uint8Array>
}

export interface MarsBunSpawnSyncResult {
  success: boolean
  exitCode: number
  stdout: Uint8Array
  stderr: Uint8Array
  error?: Error
}

export interface MarsBunFile {
  readonly path: string
  readonly size: number
  readonly type: string
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
  arrayBuffer(): Promise<ArrayBuffer>
  stream(): ReadableStream<Uint8Array>
}

export interface WebSocketHandlerOptions<T = undefined> {
  open?(ws: import("./websocket-pair").MarsServerWebSocket<T>): void
  message?(ws: import("./websocket-pair").MarsServerWebSocket<T>, message: string | Uint8Array): void
  close?(ws: import("./websocket-pair").MarsServerWebSocket<T>, code: number, reason: string): void
  drain?(ws: import("./websocket-pair").MarsServerWebSocket<T>): void
  error?(ws: import("./websocket-pair").MarsServerWebSocket<T>, error: Error): void
}

export interface ServeOptions<T = undefined> {
  port?: number
  hostname?: string
  fetch(request: Request, server: Server): Response | Promise<Response>
  error?(error: unknown): Response | Promise<Response>
  websocket?: WebSocketHandlerOptions<T>
}

export interface Server {
  readonly port: number
  readonly hostname: string
  readonly url: URL
  fetch(request: Request): Promise<Response>
  stop(closeActiveConnections?: boolean): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reload(options: Partial<ServeOptions<any>>): void
  upgrade(request: Request, options?: { data?: unknown }): boolean
}

export interface MarsBun {
  version: string
  env: Record<string, string>
  CryptoHasher: typeof MarsCryptoHasher
  password: MarsPasswordFacade
  sql: MarsSQLFacade
  file(path: string | URL, options?: BlobPropertyBag): MarsBunFile
  write(destination: string | URL | MarsBunFile, input: BlobPart | Response | Request): Promise<number>
  serve(options: ServeOptions): Server
  build(options: BuildOptions): Promise<BuildResult>
  spawn(options: MarsBunSpawnOptions | string[]): Promise<ProcessHandle>
  spawnSync(options: MarsBunSpawnOptions | string[]): MarsBunSpawnSyncResult
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}