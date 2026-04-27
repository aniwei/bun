import type { Disposable } from "@mars/bridge"

export type Pid = number

export type ProcessStatus = "starting" | "running" | "exited" | "killed" | "zombie"

export interface ProcessDescriptor {
  pid: Pid
  ppid: Pid
  cwd: string
  env: Record<string, string>
  argv: string[]
  status: ProcessStatus
  exitCode: number | null
  startedAt: number
  exitedAt?: number
}

export interface SpawnOptions {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  stdin?: ReadableStream<Uint8Array> | string
  stdout?: WritableStream<Uint8Array>
  stderr?: WritableStream<Uint8Array>
  kind?: "script" | "shell" | "server" | "worker"
}

export interface ProcessHandle {
  readonly pid: Pid
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  write(input: string | Uint8Array): Promise<void>
  kill(signal?: string | number): Promise<void>
}

export interface VirtualServer {
  readonly port: number
  readonly hostname: string
  fetch(request: Request): Promise<Response>
  stop?(closeActiveConnections?: boolean): void
}

export interface KernelEvents {
  "process:start": (payload: { pid: Pid; argv: string[] }) => void
  "process:exit": (payload: { pid: Pid; code: number }) => void
  "stdio": (payload: { pid: Pid; fd: 1 | 2; chunk: Uint8Array }) => void
  "server:listen": (payload: { pid: Pid; port: number; protocol: "http" | "ws" }) => void
  "server:close": (payload: { pid: Pid; port: number }) => void
}

export interface MarsKernelInterface {
  boot(): Promise<void>
  shutdown(): Promise<void>
  spawn(options: SpawnOptions): Promise<ProcessHandle>
  kill(pid: Pid, signal?: string | number): Promise<void>
  writeStdio(pid: Pid, fd: 1 | 2, chunk: string | Uint8Array): void
  waitpid(pid: Pid): Promise<number>
  ps(): ProcessDescriptor[]
  registerPort(pid: Pid, port: number, server: VirtualServer): void
  unregisterPort(port: number): void
  resolvePort(port: number): Pid | null
  dispatchToPort(port: number, request: Request): Promise<Response>
  on<K extends keyof KernelEvents>(event: K, listener: KernelEvents[K]): Disposable
}