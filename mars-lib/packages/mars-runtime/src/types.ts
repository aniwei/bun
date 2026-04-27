import type { MarsKernel } from "@mars/kernel"
import type { MarsVFS } from "@mars/vfs"
import type { BuildOptions, BuildResult } from "@mars/bundler"

export interface RuntimeContext {
  vfs: MarsVFS
  kernel: MarsKernel
  pid?: number
  env?: Record<string, string>
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
  file(path: string | URL, options?: BlobPropertyBag): MarsBunFile
  write(destination: string | URL | MarsBunFile, input: BlobPart | Response | Request): Promise<number>
  serve(options: ServeOptions): Server
  build(options: BuildOptions): Promise<BuildResult>
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}