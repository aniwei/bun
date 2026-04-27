import type { MarsKernel, ProcessHandle } from "@mars/kernel"
import type { MarsVFS } from "@mars/vfs"
import type { BuildOptions, BuildResult } from "@mars/bundler"
import type { MarsCryptoHasher, MarsPasswordFacade } from "@mars/crypto"
import type { MarsSQLFacade } from "@mars/sqlite"

export interface RuntimeContext {
  vfs: MarsVFS
  kernel: MarsKernel
  pid?: number
  cwd?: string
  argv?: string[]
  env?: Record<string, string>
  scope?: typeof globalThis
  spawn?(options: MarsBunSpawnOptions): Promise<ProcessHandle>
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

export interface ServeOptions {
  port?: number
  hostname?: string
  fetch(request: Request, server: Server): Response | Promise<Response>
  error?(error: unknown): Response | Promise<Response>
}

export interface Server {
  readonly port: number
  readonly hostname: string
  readonly url: URL
  fetch(request: Request): Promise<Response>
  stop(closeActiveConnections?: boolean): void
  reload(options: Partial<ServeOptions>): void
  upgrade(request: Request, options?: unknown): boolean
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