import type {
  BuiltinCommand,
  BuiltinContext,
  BuiltinResult,
  ShellCommandRegistry,
} from './types'

function unknownCommandResult(name: string): BuiltinResult {
  return {
    stdout: '',
    stderr: `Unknown command: ${name}`,
    exitCode: 127,
  }
}

export class BuiltinCommandRegistry implements ShellCommandRegistry {
  private readonly commands = new Map<string, BuiltinCommand>()

  constructor(initialCommands?: Record<string, BuiltinCommand>) {
    if (initialCommands) {
      for (const [name, command] of Object.entries(initialCommands)) {
        this.register(name, command)
      }
    }
  }

  register(name: string, command: BuiltinCommand): void {
    this.commands.set(name, command)
  }

  unregister(name: string): boolean {
    return this.commands.delete(name)
  }

  has(name: string): boolean {
    return this.commands.has(name)
  }

  tryExecute(
    name: string,
    args: string[],
    context: BuiltinContext,
  ): BuiltinResult | null {
    const command = this.commands.get(name)
    if (!command) {
      return null
    }
    return command(args, context)
  }

  execute(name: string, args: string[], context: BuiltinContext): BuiltinResult {
    return this.tryExecute(name, args, context) ?? unknownCommandResult(name)
  }
}

export function createBuiltinCommandRegistry(
  initialCommands?: Record<string, BuiltinCommand>,
): ShellCommandRegistry {
  return new BuiltinCommandRegistry(initialCommands)
}
