import { registerBuiltinCommands } from './register-builtin-commands'
import type {
  ShellCommand,
  ShellCommandContext,
  ShellCommandRegistry,
  ShellCommandResult,
} from './types'

function unknownCommandResult(name: string): ShellCommandResult {
  return {
    stdout: '',
    stderr: `Unknown command: ${name}`,
    exitCode: 127,
  }
}

export class CommandRegistry implements ShellCommandRegistry {
  private readonly commands = new Map<string, ShellCommand>()

  constructor(initialCommands?: Record<string, ShellCommand>) {
    if (initialCommands) {
      for (const [name, command] of Object.entries(initialCommands)) {
        this.register(name, command)
      }
    }
  }

  register(name: string, command: ShellCommand): void {
    this.commands.set(name, command)
  }

  unregister(name: string): boolean {
    return this.commands.delete(name)
  }

  has(name: string): boolean {
    return this.commands.has(name)
  }

  tryExecute(name: string, args: string[], context: ShellCommandContext): ShellCommandResult | null {
    const command = this.commands.get(name)
    if (!command) {
      return null
    }

    const result = command(args, context)
    if (result instanceof Promise) {
      throw new Error(`Command '${name}' is async; use executeAsync()`)
    }

    return result
  }

  execute(name: string, args: string[], context: ShellCommandContext): ShellCommandResult {
    return this.tryExecute(name, args, context) ?? unknownCommandResult(name)
  }

  async tryExecuteAsync(
    name: string,
    args: string[],
    context: ShellCommandContext,
  ): Promise<ShellCommandResult | null> {
    const command = this.commands.get(name)
    if (!command) {
      return null
    }

    return await command(args, context)
  }

  async executeAsync(
    name: string,
    args: string[],
    context: ShellCommandContext,
  ): Promise<ShellCommandResult> {
    return (await this.tryExecuteAsync(name, args, context)) ?? unknownCommandResult(name)
  }
}

export function createCommandRegistry(
  initialCommands?: Record<string, ShellCommand>,
): ShellCommandRegistry {
  const registry = new CommandRegistry(initialCommands)

  registerBuiltinCommands(registry)

  return registry
}

export function createBuiltinCommandRegistry(
  initialCommands?: Record<string, ShellCommand>,
): ShellCommandRegistry {
  return createCommandRegistry(initialCommands)
}