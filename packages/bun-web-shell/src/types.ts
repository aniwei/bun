export interface ShellCommandContext {
  cwd: string
  stdin: string
  env: Record<string, string>
  setCwd(next: string): void
  [key: string]: unknown
}

export interface ShellCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type ShellCommand = (
  args: string[],
  context: ShellCommandContext,
) => ShellCommandResult | Promise<ShellCommandResult>

export interface ShellCommandRegistry {
  register(name: string, command: ShellCommand): void
  unregister(name: string): boolean
  has(name: string): boolean
  tryExecute(name: string, args: string[], context: ShellCommandContext): ShellCommandResult | null
  execute(name: string, args: string[], context: ShellCommandContext): ShellCommandResult
  tryExecuteAsync(name: string, args: string[], context: ShellCommandContext): Promise<ShellCommandResult | null>
  executeAsync(name: string, args: string[], context: ShellCommandContext): Promise<ShellCommandResult>
}

export type ShellCommandRegisterHook = (registry: ShellCommandRegistry) => void