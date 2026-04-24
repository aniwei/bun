import {
  applyShellCommandRegisterHooks,
  builtinCommands,
  createBuiltinCommandRegistry,
  type BuiltinContext,
  type BuiltinFS,
  type BuiltinResult,
  type ShellCommandRegisterHook,
  type ShellCommandRegistry,
} from '@mars/web-shell-builtins'
import { parseShellPipeline } from './parser'

export interface ShellRunOptions {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  fs?: BuiltinFS
  registry?: ShellCommandRegistry
  hooks?: ShellCommandRegisterHook[]
}

export interface ShellRunResult extends BuiltinResult {
  cwd: string
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`)
}

function expandArgument(arg: string, cwd: string, fs?: BuiltinFS): string[] {
  if (!fs || !arg.includes('*')) {
    return [arg]
  }

  try {
    const names = fs.listDir(cwd)
    const matcher = wildcardToRegex(arg)
    const matches = names.filter(name => matcher.test(name)).sort()
    return matches.length > 0 ? matches : [arg]
  } catch {
    return [arg]
  }
}

export function runShellCommandSync(
  commandLine: string,
  options: ShellRunOptions = {},
): ShellRunResult {
  const parsed = parseShellPipeline(commandLine)
  const registry = options.registry ?? createBuiltinCommandRegistry(builtinCommands)
  applyShellCommandRegisterHooks(registry, options.hooks)

  let cwd = options.cwd ?? '/'
  let stdin = options.stdin ?? ''
  let lastResult: BuiltinResult = { stdout: '', stderr: '', exitCode: 0 }

  const context: BuiltinContext = {
    cwd,
    stdin,
    env: options.env ?? {},
    setCwd(next: string) {
      cwd = next
      context.cwd = next
    },
    fs: options.fs,
  }

  for (const command of parsed.commands) {
    const expandedArgs = command.args.flatMap(arg => expandArgument(arg, cwd, options.fs))
    context.stdin = stdin
    lastResult = registry.execute(command.command, expandedArgs, context)
    stdin = lastResult.stdout
    if (lastResult.exitCode !== 0) {
      break
    }
  }

  return {
    ...lastResult,
    cwd,
  }
}
