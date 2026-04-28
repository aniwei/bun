import { createFSCommands } from "./commands/fs"
import { parseCommandLine } from "./parser"
import { normalizePath } from "@mars/vfs"

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
        const pathResult = await this.#runPathCommand(command.argv, options)
        if (!pathResult) {
          code = 127
          stderr += `${command.argv[0]}: command not found\n`
          break
        }

        stdout += pathResult.stdout
        stderr += pathResult.stderr
        json = pathResult.json ?? json
        code = pathResult.code
        if (pathResult.code !== 0) break

        continue
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

  async #runPathCommand(argv: string[], options: ShellRunOptions): Promise<CommandResult | null> {
    const executablePath = this.#resolvePathCommand(argv[0], options)
    if (!executablePath) return null

    const script = String(this.#vfs.readFileSync(executablePath, "utf8"))
      .replace(/^#!.*(?:\n|$)/, "")
      .trim()
    if (!script) return { code: 0, stdout: "", stderr: "" }

    const forwardedArgs = argv.slice(1).map(quoteShellArg).join(" ")
    return this.run(forwardedArgs ? `${script} ${forwardedArgs}` : script, options)
  }

  #resolvePathCommand(command: string, options: ShellRunOptions): string | null {
    if (command.includes("/")) {
      const commandPath = normalizePath(command, options.cwd ?? this.#cwd)
      return this.#isExecutableFile(commandPath) ? commandPath : null
    }

    for (const pathEntry of (options.env?.PATH ?? this.#env.PATH ?? "").split(":")) {
      if (!pathEntry) continue

      const commandPath = normalizePath(command, pathEntry)
      if (this.#isExecutableFile(commandPath)) return commandPath
    }

    return null
  }

  #isExecutableFile(path: string): boolean {
    if (!this.#vfs.existsSync(path)) return false

    try {
      return this.#vfs.statSync(path).isFile()
    } catch {
      return false
    }
  }

  #createContext(argv: string[], options: ShellRunOptions): CommandContext {
    return {
      argv,
      cwd: options.cwd ?? this.#cwd,
      env: { ...this.#env, ...options.env },
      stdin: createShellStdin(options.stdin),
      stdout: new WritableStream<Uint8Array>(),
      stderr: new WritableStream<Uint8Array>(),
      vfs: this.#vfs,
      kernel: this.#kernel,
    }
  }
}

function createShellStdin(input: ReadableStream<Uint8Array> | string | undefined): ReadableStream<Uint8Array> {
  if (typeof input === "string") {
    const bytes = new TextEncoder().encode(input)

    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
  }

  if (input) return input

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value

  return `"${value.replace(/"/g, "")}"`
}

export function createMarsShell(options: MarsShellOptions): MarsShell {
  return new MarsShell(options)
}