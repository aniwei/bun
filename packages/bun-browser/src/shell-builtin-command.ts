import type { CommandRegistry } from './shell-command-registry'
import type { ShellResult } from './shell-interpreter'

export enum BuiltinCommand {
  Echo = 'echo',
  Cd = 'cd',
  Pwd = 'pwd',
  Ls = 'ls',
  Cat = 'cat',
  Mkdir = 'mkdir',
  Rm = 'rm',
  Cp = 'cp',
  Mv = 'mv',
  Env = 'env',
  Export = 'export',
  True = 'true',
  False = 'false',
  Noop = ':',
  Printf = 'printf',
  Help = 'help',
}

function ok(stdout = '', stderr = ''): ShellResult {
  return { exitCode: 0, stdout, stderr }
}

function fail(msg: string, code = 1): ShellResult {
  return { exitCode: code, stdout: '', stderr: msg + '\n' }
}

function resolvePath(p: string, cwd: string): string {
  return p.startsWith('/') ? p : cwd.replace(/\/$/, '') + '/' + p
}


export const registerBuiltinShellCommands = (registry: CommandRegistry): void => {
  registry
    .register(BuiltinCommand.Echo, args => ok(args.join(' ') + '\n'), {
      usage: 'echo [args...]',
      description: 'Print arguments to stdout',
    })
    .register(BuiltinCommand.Cd, (args, ctx) => {
      const target = args[0] ?? ctx.env.vars['HOME'] ?? '/'
      const next = target.startsWith('/') ? target : ctx.env.cwd.replace(/\/$/, '') + '/' + target

      ctx.env.cwd = next.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
      return ok()
    }, { usage: 'cd [dir]', description: 'Change working directory' })
    .register(BuiltinCommand.Pwd, (_args, ctx) => ok(ctx.env.cwd + '\n'), {
      usage: 'pwd',
      description: 'Print working directory',
    })
    .register(BuiltinCommand.Ls, async (args, ctx) => {
      const dir = args[0] ?? ctx.env.cwd
      const path = resolvePath(dir, ctx.env.cwd)
      try {
        const entries = await ctx.kernel.readdir(path)
        return ok(entries.map(e => e.name).join('\n') + '\n')
      } catch {
        return fail(`ls: cannot access '${path}': No such file or directory`)
      }
    }, { usage: 'ls [dir]', description: 'List directory contents' })
    .register(BuiltinCommand.Cat, async (args, ctx) => {
      if (args.length === 0) return ok(ctx.stdin)
      const parts: string[] = []
      for (const a of args) {
        const p = resolvePath(a, ctx.env.cwd)
        try {
          const text = await ctx.kernel.readFile(p, 'utf8')
          parts.push(text)
        } catch {
          return fail(`cat: ${a}: No such file or directory`)
        }
      }
      return ok(parts.join(''))
    }, { usage: 'cat [file...]', description: 'Concatenate and print files' })
    .register(BuiltinCommand.Mkdir, async (args, ctx) => {
      const flags = args.filter(a => a.startsWith('-'))
      const dirs = args.filter(a => !a.startsWith('-'))
      const recursive = flags.some(f => f.includes('p'))
      for (const d of dirs) {
        const p = resolvePath(d, ctx.env.cwd)
        try {
          await ctx.kernel.mkdir(p, { recursive })
        } catch (e: any) {
          if (!recursive) return fail(`mkdir: cannot create directory '${d}': ${e?.message ?? e}`)
        }
      }
      return ok()
    }, { usage: 'mkdir [-p] dir...', description: 'Create directories' })
    .register(BuiltinCommand.Rm, async (args, ctx) => {
      const flags = args.filter(a => a.startsWith('-'))
      const targets = args.filter(a => !a.startsWith('-'))
      const recursive = flags.some(f => f.includes('r') || f.includes('R'))
      for (const t of targets) {
        const p = resolvePath(t, ctx.env.cwd)
        try {
          await ctx.kernel.rm(p, { recursive })
        } catch (e: any) {
          return fail(`rm: cannot remove '${t}': ${e?.message ?? e}`)
        }
      }
      return ok()
    }, { usage: 'rm [-r] target...', description: 'Remove files or directories' })
    .register(BuiltinCommand.Cp, async (args, ctx) => {
      if (args.length < 2) return fail('cp: missing destination')
      const flags = args.filter(a => a.startsWith('-'))
      const paths = args.filter(a => !a.startsWith('-'))
      const src = paths[0]
      const dst = paths[paths.length - 1]
      if (!src || !dst) return fail('cp: missing destination')
      const sp = resolvePath(src, ctx.env.cwd)
      const dp = resolvePath(dst, ctx.env.cwd)
      const recursive = flags.some(f => f.includes('r') || f.includes('R'))
      try {
        const text = await ctx.kernel.readFile(sp, 'utf8')
        await ctx.kernel.writeFile(dp, text)
      } catch (e: any) {
        if (recursive) return fail('cp: recursive copy not fully supported in bun-browser')
        return fail(`cp: cannot copy '${src}': ${e?.message ?? e}`)
      }
      return ok()
    }, { usage: 'cp [-r] src dst', description: 'Copy files' })
  
    .register(BuiltinCommand.Mv, async (args, ctx) => {
      if (args.length < 2) return fail('mv: missing destination')
      const src = args[0]
      const dst = args[1]
      if (!src || !dst) return fail('mv: missing destination')
      const sp = resolvePath(src, ctx.env.cwd)
      const dp = resolvePath(dst, ctx.env.cwd)
      try {
        await ctx.kernel.rename(sp, dp)
      } catch (e: any) {
        return fail(`mv: cannot move '${src}': ${e?.message ?? e}`)
      }
      return ok()
    }, { usage: 'mv src dst', description: 'Move or rename files' })
  
    .register(BuiltinCommand.Env, (_args, ctx) => {
      const lines = Object.entries(ctx.env.vars).map(([k, v]) => `${k}=${v}`).join('\n')
      return ok(lines + '\n')
    }, { usage: 'env', description: 'Print environment variables' })
  
    .register(BuiltinCommand.Export, (args, ctx) => {
      for (const a of args) {
        const eq = a.indexOf('=')
        if (eq >= 0) {
          ctx.env.vars[a.slice(0, eq)] = a.slice(eq + 1)
        }
      }
      return ok()
    }, { usage: 'export NAME=VALUE...', description: 'Set environment variables' })
  
    .register(BuiltinCommand.True, () => ok(), {
      usage: 'true',
      description: 'Return exit code 0',
    })
  
    .register(BuiltinCommand.False, () => ({ exitCode: 1, stdout: '', stderr: '' }), {
      usage: 'false',
      description: 'Return exit code 1',
    })
  
    .register(BuiltinCommand.Noop, () => ok(), {
      usage: ':',
      description: 'No-op (true alias)',
    })
  
    .register(BuiltinCommand.Printf, args => {
      if (args.length === 0) return ok()
      const fmt = args[0] ?? ''
      let idx = 1
      let result = ''
      let i = 0
      while (i < fmt.length) {
        if (fmt[i] === '\\') {
          i++
          if (fmt[i] === 'n') result += '\n'
          else if (fmt[i] === 't') result += '\t'
          else result += fmt[i] ?? ''
          i++
        } else if (fmt[i] === '%') {
          i++
          if (fmt[i] === 's') { result += args[idx++] ?? ''; i++ }
          else if (fmt[i] === 'd') { result += parseInt(args[idx++] ?? '0', 10); i++ }
          else { result += '%' }
        } else {
          result += fmt[i++]
        }
      }
      return ok(result)
    }, { usage: 'printf format [args...]', description: 'Formatted output' })
  
    .register(BuiltinCommand.Help, () => {
      const lines = [
        ...registry.list().entries()
      ].map(([name, e]) => `${name.padEnd(14)}${e.meta.description ?? ''}`)

      return ok(lines.join('\n') + '\n')
    }, { usage: 'help', description: 'List available commands' })
}

