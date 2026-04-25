import type { ShellCommandRegistry } from './types'

type BuiltinFSLike = {
  readFile(path: string): string
}

type BuiltinContextLike = {
  cwd: string
  stdin: string
  setCwd(next: string): void
  fs?: BuiltinFSLike
}

function resolvePath(cwd: string, path: string): string {
  if (path.startsWith('/')) return path
  if (cwd === '/') return `/${path}`
  return `${cwd}/${path}`
}

function readMaybeFromFS(context: BuiltinContextLike, path: string): string {
  if (!context.fs) {
    throw new Error('cat requires fs in shell context')
  }
  return context.fs.readFile(resolvePath(context.cwd, path))
}

function runSimpleJq(selector: string, input: string): string {
  const trimmed = selector.trim()
  if (!trimmed.startsWith('.')) {
    throw new Error(`Unsupported jq selector: ${selector}`)
  }

  const path = trimmed
    .slice(1)
    .split('.')
    .filter(Boolean)

  const root = JSON.parse(input)
  let current: unknown = root

  for (const key of path) {
    if (current && typeof current === 'object' && key in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[key]
    } else {
      current = null
      break
    }
  }

  return JSON.stringify(current)
}

export function registerBuiltinCommands(
  registry: ShellCommandRegistry,
): ShellCommandRegistry {
  registry.register('cd', (args, context) => {
    const target = args[0] ?? '/'
    const next = target.startsWith('/')
      ? target
      : context.cwd === '/'
        ? `/${target}`
        : `${context.cwd}/${target}`
    context.setCwd(next)
    return {
      stdout: '',
      stderr: '',
      exitCode: 0,
    }
  })

  registry.register('cat', (args, context) => {
    const ctx = context as BuiltinContextLike
    if (args.length === 0) {
      return {
        stdout: ctx.stdin,
        stderr: '',
        exitCode: 0,
      }
    }

    const chunks: string[] = []
    try {
      for (const path of args) {
        chunks.push(readMaybeFromFS(ctx, path))
      }
    } catch (error) {
      return {
        stdout: '',
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      }
    }

    return {
      stdout: chunks.join('\n'),
      stderr: '',
      exitCode: 0,
    }
  })

  registry.register('grep', (args, context) => {
    const needle = args[0] ?? ''
    const lines = context.stdin.split('\n').filter(Boolean)
    const matched = lines.filter(line => line.includes(needle))
    return {
      stdout: matched.join('\n'),
      stderr: '',
      exitCode: matched.length > 0 ? 0 : 1,
    }
  })

  registry.register('jq', (args, context) => {
    const selector = args[0] ?? '.'
    try {
      const out = runSimpleJq(selector, context.stdin)
      return {
        stdout: out,
        stderr: '',
        exitCode: 0,
      }
    } catch (error) {
      return {
        stdout: '',
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      }
    }
  })

  registry.register('echo', args => ({
    stdout: `${args.join(' ')}\n`,
    stderr: '',
    exitCode: 0,
  }))

  registry.register('sleep', () => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
  }))

  return registry
}

export const registerKernelBuiltinCommands = registerBuiltinCommands
