import type { BuiltinCommand, BuiltinContext, BuiltinResult } from './types'

function ok(stdout = '', stderr = ''): BuiltinResult {
  return { stdout, stderr, exitCode: 0 }
}

function fail(stderr: string, code = 1): BuiltinResult {
  return { stdout: '', stderr, exitCode: code }
}

function resolvePath(cwd: string, input: string): string {
  if (input.startsWith('/')) return input
  if (cwd === '/') return `/${input}`
  return `${cwd}/${input}`
}

export const cdCommand: BuiltinCommand = (args, context) => {
  const next = args[0] ?? '/'
  const target = resolvePath(context.cwd, next)

  if (!context.fs) {
    context.setCwd(target)
    return ok()
  }

  try {
    if (!context.fs.isDirectory(target)) {
      return fail(`cd: not a directory: ${next}`)
    }
    context.setCwd(target)
    return ok()
  } catch {
    return fail(`cd: no such file or directory: ${next}`)
  }
}

export const lsCommand: BuiltinCommand = (args, context) => {
  if (!context.fs) {
    return ok('')
  }

  const target = resolvePath(context.cwd, args[0] ?? '.')
  try {
    return ok(context.fs.listDir(target).join('\n'))
  } catch (error) {
    return fail(error instanceof Error ? `ls: ${error.message}` : 'ls failed')
  }
}

export const catCommand: BuiltinCommand = (args, context) => {
  if (args.length === 0) {
    return ok(context.stdin)
  }

  if (!context.fs) {
    return fail('cat: filesystem unavailable')
  }

  try {
    const out = args.map(path => context.fs!.readFile(resolvePath(context.cwd, path))).join('\n')
    return ok(out)
  } catch (error) {
    return fail(error instanceof Error ? `cat: ${error.message}` : 'cat failed')
  }
}

export const grepCommand: BuiltinCommand = (args, context) => {
  const pattern = args[0]
  if (!pattern) {
    return fail('grep: missing pattern')
  }

  const lines = context.stdin.split(/\r?\n/)
  const matched = lines.filter(line => line.includes(pattern))
  return ok(matched.join('\n'))
}

export const findCommand: BuiltinCommand = (args, context) => {
  if (!context.fs) {
    return fail('find: filesystem unavailable')
  }

  const target = resolvePath(context.cwd, args[0] ?? '.')
  try {
    return ok(context.fs.walk(target).join('\n'))
  } catch (error) {
    return fail(error instanceof Error ? `find: ${error.message}` : 'find failed')
  }
}

function readPathValue(value: unknown, path: string[]): unknown {
  let current: unknown = value
  for (const segment of path) {
    if (!segment) continue
    if (typeof current !== 'object' || current === null) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export const jqCommand: BuiltinCommand = (args, context) => {
  const expression = args[0] ?? '.'

  try {
    const value = JSON.parse(context.stdin || 'null')
    if (expression === '.') {
      return ok(JSON.stringify(value))
    }
    if (!expression.startsWith('.')) {
      return fail('jq: expression must start with .')
    }

    const result = readPathValue(value, expression.split('.'))
    return ok(JSON.stringify(result))
  } catch (error) {
    return fail(error instanceof Error ? `jq: ${error.message}` : 'jq failed')
  }
}

export const builtinCommands: Record<string, BuiltinCommand> = {
  cd: cdCommand,
  ls: lsCommand,
  cat: catCommand,
  grep: grepCommand,
  find: findCommand,
  jq: jqCommand,
}

export function runBuiltin(
  name: string,
  args: string[],
  context: BuiltinContext,
): BuiltinResult {
  const command = builtinCommands[name]
  if (!command) {
    return fail(`Unknown command: ${name}`, 127)
  }
  return command(args, context)
}
