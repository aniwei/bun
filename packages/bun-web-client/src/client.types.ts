import type {
  Kernel,
  KernelModuleRequestHandler,
  KernelProcessExecutor,
  KernelBootHook,
  KernelServiceWorkerBeforeRegisterHook,
  KernelServiceWorkerRegisterHook,
  KernelServiceWorkerRegisterErrorHook,
} from '@mars/web-kernel'
import { Events } from '@mars/web-shared'

export type BunContainerWorkerScriptDescriptor = {
  source: string
  specifier?: string
  packageName?: string
  packageType?: 'module' | 'commonjs'
  moduleFormat?: 'auto' | 'esm' | 'cjs'
}

export type BunContainerWorkerScriptRecord = string | BunContainerWorkerScriptDescriptor

export type BunContainerWorkerScriptProcessor = {
  process(input: {
    pathname: string
    descriptor: BunContainerWorkerScriptDescriptor
    detectedModuleType: 'esm' | 'cjs'
  }): { source: string; contentType?: string } | Promise<{ source: string; contentType?: string }>
}

// ── 文件树 ────────────────────────────────────────────────────────────────────

export interface FileTree {
  [path: string]: string | Uint8Array | FileTree
}

// ── spawn 选项 ─────────────────────────────────────────────────────────────────

export interface SpawnOpts {
  cwd?: string
  env?: Record<string, string>
  argv: string[]
}

// ── 进程句柄 ───────────────────────────────────────────────────────────────────

export interface ContainerProcess {
  readonly pid: number
  readonly output: ReadableStream<Uint8Array>
  waitForExit(): Promise<number>
  readonly exited: Promise<number>
  write(data: string | Uint8Array): void
  readonly input: WritableStream<Uint8Array>
  kill(signal?: number): void
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
}

// ── 终端句柄 ───────────────────────────────────────────────────────────────────

export interface TerminalHandle {
  attach(container: HTMLElement): void
  write(data: string): void
  dispose(): void
}

// ── 事件类型 ───────────────────────────────────────────────────────────────────

export interface ServerReadyEvent {
  url: string
  host: string
  port: number
  protocol: 'http' | 'https'
}

export interface ProcessExitEvent {
  pid: number
  exitCode: number
}

export interface FileChangeEvent {
  path: string
  type: 'create' | 'modify' | 'delete'
}

export interface ContainerEvents extends Events {
  'server-ready': (event: ServerReadyEvent) => void
  'process-exit': (event: ProcessExitEvent) => void
  'filechange': (event: FileChangeEvent) => void
}

export interface ContainerEventMap {
  'server-ready': ServerReadyEvent
  'process-exit': ProcessExitEvent
  'filechange': FileChangeEvent
}

export type ContainerEventName = keyof ContainerEventMap

export type ContainerStatus = 'booting' | 'ready' | 'error' | 'disposed'

// ── Boot 选项 ─────────────────────────────────────────────────────────────────

export interface BunContainerBootOptions {
  tunnelUrl?: string
  coopCoepHeaders?: boolean
  workerType?: 'shared' | 'dedicated'
  files?: FileTree
  id?: string
  workerUrl?: string
  processExecutor?: KernelProcessExecutor
  moduleRequestHandler?: KernelModuleRequestHandler
  serviceWorkerUrl?: string
  serviceWorkerRegisterOptions?: RegistrationOptions
  initializers?: 'all' | string[]
  scope?: string
  serveHandlerRegistry?: {
    getHandler(port: number): ((request: Request) => Promise<Response> | Response) | null
  }
  serviceWorkerScripts?: Map<string, BunContainerWorkerScriptRecord> | Record<string, BunContainerWorkerScriptRecord>
  serviceWorkerScriptProcessor?: BunContainerWorkerScriptProcessor
  hooks?: {
    boot?: KernelBootHook[]
    serviceWorkerBeforeRegister?: KernelServiceWorkerBeforeRegisterHook[]
    serviceWorkerRegister?: KernelServiceWorkerRegisterHook[]
    serviceWorkerRegisterError?: KernelServiceWorkerRegisterErrorHook[]
  }
}

export type BunContainerOptions = BunContainerBootOptions
