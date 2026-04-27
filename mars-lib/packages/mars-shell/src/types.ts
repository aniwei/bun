import type { Disposable } from "@mars/bridge"
import type { MarsKernel } from "@mars/kernel"
import type { MarsVFS } from "@mars/vfs"

export interface ShellRunOptions {
  cwd?: string
  env?: Record<string, string>
  structured?: boolean
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
  json?: unknown
}

export interface ShellChunk {
  stream: "stdout" | "stderr"
  chunk: string
}

export interface ShellHistoryEntry {
  command: string
  cwd: string
  code: number
  startedAt: number
  endedAt: number
}

export interface CompletionItem {
  label: string
  detail?: string
}

export interface CompletionResult {
  items: CompletionItem[]
}

export interface CompletionContext {
  input: string
  cursor: number
  cwd: string
}

export interface CommandContext {
  argv: string[]
  cwd: string
  env: Record<string, string>
  stdin: ReadableStream<Uint8Array>
  stdout: WritableStream<Uint8Array>
  stderr: WritableStream<Uint8Array>
  vfs: MarsVFS
  kernel: MarsKernel
}

export interface ShellCommand {
  name: string
  description?: string
  usage?: string
  run(context: CommandContext): Promise<CommandResult> | CommandResult
  complete?(context: CompletionContext): Promise<CompletionItem[]> | CompletionItem[]
}

export interface MarsShellInterface {
  cwd(): string
  cd(path: string): Promise<void>
  run(command: string, options?: ShellRunOptions): Promise<CommandResult>
  stream(command: string, options?: ShellRunOptions): AsyncIterable<ShellChunk>
  registerCommand(command: ShellCommand): Disposable
  complete(input: string, cursor: number): Promise<CompletionResult>
  history(): ShellHistoryEntry[]
}