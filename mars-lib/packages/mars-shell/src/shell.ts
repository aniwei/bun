import { createFSCommands } from "./commands/fs"
import { parseCommandLine } from "./parser"

import type { Disposable } from "@mars/bridge"
import type { MarsKernel } from "@mars/kernel"
import type { MarsVFS } from "@mars/vfs"
import type {
  CommandContext,
  CommandResult,
  CompletionResult,
  MarsShellInterface,
  ShellChunk,
  ShellCommand,
  ShellHistoryEntry,
  ShellRunOptions,
} from "./types"

export interface MarsShellOptions {
  vfs: MarsVFS
  kernel: MarsKernel
  env?: Record<string, string>
}

export class MarsShell implements MarsShellInterface {
  readonly #vfs: MarsVFS
  readonly #kernel: MarsKernel
  readonly #env: Record<string, string>
  readonly #commands = new Map<string, ShellCommand>()
  readonly #history: ShellHistoryEntry[] = []
  #cwd: string

  constructor(options: MarsShellOptions) {
    this.#vfs = options.vfs
    this.#kernel = options.kernel
    this.#env = options.env ?? {}
    this.#cwd = this.#vfs.cwd()

    for (const command of createFSCommands(path => {
      this.#cwd = path
    })) {
      this.registerCommand(command)
    }
  }

  cwd(): string {
    return this.#cwd
  }

  async cd(path: string): Promise<void> {
    const command = this.#commands.get("cd")
    if (!command) throw new Error("cd command is not registered")

    const result = await command.run(this.#createContext(["cd", path], {}))
    if (result.code !== 0) throw new Error(result.stderr)
  }

  async run(commandLine: string, options: ShellRunOptions = {}): Promise<CommandResult> {
    const startedAt = Date.now()
    const parsed = parseCommandLine(commandLine)
    let stdout = ""
    let stderr = ""
    let json: unknown
    let code = 0

    for (const command of parsed.commands) {
      const shellCommand = this.#commands.get(command.argv[0])
      if (!shellCommand) {
        code = 127
        stderr += `${command.argv[0]}: command not found\n`
        break
      }

      const result = await shellCommand.run(this.#createContext(command.argv, options))
      stdout += result.stdout
      stderr += result.stderr
      json = result.json ?? json
      code = result.code

      if (result.code !== 0) break
    }

    this.#history.push({
      command: commandLine,
      cwd: options.cwd ?? this.#cwd,
      code,
      startedAt,
      endedAt: Date.now(),
    })

    return { code, stdout, stderr, ...(json === undefined ? {} : { json }) }
  }

  async *stream(command: string, options?: ShellRunOptions): AsyncIterable<ShellChunk> {
    const result = await this.run(command, options)
    if (result.stdout) yield { stream: "stdout", chunk: result.stdout }
    if (result.stderr) yield { stream: "stderr", chunk: result.stderr }
  }

  registerCommand(command: ShellCommand): Disposable {
    this.#commands.set(command.name, command)

    return {
      dispose: () => {
        this.#commands.delete(command.name)
      },
    }
  }

  async complete(input: string, cursor: number): Promise<CompletionResult> {
    const prefix = input.slice(0, cursor).trim()

    return {
      items: [...this.#commands.keys()]
        .filter(command => command.startsWith(prefix))
        .map(command => ({ label: command })),
    }
  }

  history(): ShellHistoryEntry[] {
    return [...this.#history]
  }

  #createContext(argv: string[], options: ShellRunOptions): CommandContext {
    return {
      argv,
      cwd: options.cwd ?? this.#cwd,
      env: { ...this.#env, ...options.env },
      stdin: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
      stdout: new WritableStream<Uint8Array>(),
      stderr: new WritableStream<Uint8Array>(),
      vfs: this.#vfs,
      kernel: this.#kernel,
    }
  }
}

export function createMarsShell(options: MarsShellOptions): MarsShell {
  return new MarsShell(options)
}