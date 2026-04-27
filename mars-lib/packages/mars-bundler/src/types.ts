import type { Disposable } from "@mars/bridge"
import type { Loader, TransformResult } from "@mars/transpiler"

export type BuildFormat = "esm" | "cjs" | "iife"

export interface BuildOptions {
  entrypoints: string[]
  cwd?: string
  outfile?: string
  outdir?: string
  format?: BuildFormat
  target?: "browser" | "bun" | "node"
  define?: Record<string, string>
  sourcemap?: boolean
}

export interface BuildLog {
  level: "error" | "warning" | "info"
  message: string
}

export interface BuildOutputArtifact {
  path: string
  kind: "entry-point"
  loader: Loader
  size: number
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface BuildResult {
  success: boolean
  outputs: BuildOutputArtifact[]
  logs: BuildLog[]
}

export interface DevServer {
  config(): Promise<ViteConfigShape>
  listen(port?: number): Promise<void>
  close(): Promise<void>
  transformRequest(url: string): Promise<TransformResult | null>
  loadModule(url: string): Promise<Response>
  handleHMRUpdate(file: string): Promise<HMRUpdate[]>
}

export interface HMRUpdate {
  type: "update"
  path: string
  acceptedPath: string
  timestamp: number
}

export interface HMRPayload {
  type: "connected" | "update" | "full-reload"
  updates?: HMRUpdate[]
  path?: string
  timestamp?: number
}

export interface HMRChannel {
  send(payload: HMRPayload): void
  onMessage(listener: (payload: HMRPayload) => void): Disposable
}

export interface ModuleGraphEntry {
  path: string
  imports: string[]
  importers: string[]
  invalidated: boolean
  transformedAt: number
}

export interface ViteConfigShape {
  root: string
  define: Record<string, string>
  resolve: {
    alias: Record<string, string>
  }
  server: {
    hmr: boolean
  }
}