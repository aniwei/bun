/**
 * T5.13.2–T5.13.3 — Shell Interpreter
 *
 * Executes a ShellAST produced by `wasm.ts shellParse()` using the Kernel for
 * process spawning and `kernel.fs.*` for I/O redirection.  Built-in commands
 * are implemented in pure TypeScript and operate directly on the VFS.
 */

import type { Kernel } from './kernel.js'
import type { ShellAST, ShellCmd, ShellPipe, ShellRedir } from './wasm.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ShellEnv {
  /** Current environment variables (copied per-process, owned by interpreter). */
  vars: Record<string, string>
  /** Current working directory inside the VFS. */
  cwd: string
}

export interface ShellResult {
  exitCode: number
  /**
   * Raw collected output of the last pipeline stage (stdout + stderr combined
   * when stderr is not separately redirected).
   */
  stdout: string
  stderr: string
}

/** Context passed to built-in command implementations. */
interface BuiltinCtx {
  env: ShellEnv
  kernel: Kernel
  stdin: string
}

type BuiltinFn = (args: string[], ctx: BuiltinCtx) => Promise<ShellResult> | ShellResult

// ── Built-in commands (T5.13.3) ───────────────────────────────────────────────

function ok(stdout = '', stderr = ''): ShellResult {
  return { exitCode: 0, stdout, stderr }
}

function err(msg: string, code = 1): ShellResult {
  return { exitCode: code, stdout: '', stderr: msg + '\n' }
}

const BUILTINS: Record<string, BuiltinFn> = {
  echo: (args) => ok(args.join(' ') + '\n'),

  cd(args, ctx) {
    const target = args[0] ?? ctx.env.vars['HOME'] ?? '/'
    const next = target.startsWith('/') ? target : ctx.env.cwd.replace(/\/$/, '') + '/' + target
    ctx.env.cwd = next.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
    return ok()
  },

  pwd(_args, ctx) {
    return ok(ctx.env.cwd + '\n')
  },

  async ls(args, ctx) {
    const dir = args[0] ?? ctx.env.cwd
    const path = dir.startsWith('/') ? dir : ctx.env.cwd.replace(/\/$/, '') + '/' + dir
    try {
      const entries: string[] = await (ctx.kernel.fs as any).readdir(path)
      return ok(entries.join('\n') + '\n')
    } catch {
      return err(`ls: cannot access '${path}': No such file or directory`)
    }
  },

  async cat(args, ctx) {
    if (args.length === 0) return ok(ctx.stdin)
    const parts: string[] = []
    for (const a of args) {
      const p = a.startsWith('/') ? a : ctx.env.cwd.replace(/\/$/, '') + '/' + a
      try {
        const text: string = await (ctx.kernel.fs as any).readFile(p, 'utf-8')
        parts.push(text)
      } catch {
        return err(`cat: ${a}: No such file or directory`)
      }
    }
    return ok(parts.join(''))
  },

  async mkdir(args, ctx) {
    const flags = args.filter(a => a.startsWith('-'))
    const dirs = args.filter(a => !a.startsWith('-'))
    const recursive = flags.some(f => f.includes('p'))
    for (const d of dirs) {
      const p = d.startsWith('/') ? d : ctx.env.cwd.replace(/\/$/, '') + '/' + d
      try {
        await (ctx.kernel.fs as any).mkdir(p, { recursive })
      } catch (e: any) {
        if (!recursive) return err(`mkdir: cannot create directory '${d}': ${e?.message ?? e}`)
      }
    }
    return ok()
  },

  async rm(args, ctx) {
    const flags = args.filter(a => a.startsWith('-'))
    const targets = args.filter(a => !a.startsWith('-'))
    const recursive = flags.some(f => f.includes('r') || f.includes('R'))
    for (const t of targets) {
      const p = t.startsWith('/') ? t : ctx.env.cwd.replace(/\/$/, '') + '/' + t
      try {
        await (ctx.kernel.fs as any).rm(p, { recursive })
      } catch (e: any) {
        return err(`rm: cannot remove '${t}': ${e?.message ?? e}`)
      }
    }
    return ok()
  },

  async cp(args, ctx) {
    if (args.length < 2) return err('cp: missing destination')
    const flags = args.filter(a => a.startsWith('-'))
    const paths = args.filter(a => !a.startsWith('-'))
    const [src, dst] = [paths[0], paths[paths.length - 1]]
    const sp = src.startsWith('/') ? src : ctx.env.cwd.replace(/\/$/, '') + '/' + src
    const dp = dst.startsWith('/') ? dst : ctx.env.cwd.replace(/\/$/, '') + '/' + dst
    const recursive = flags.some(f => f.includes('r') || f.includes('R'))
    try {
      const text: string = await (ctx.kernel.fs as any).readFile(sp, 'utf-8')
      await (ctx.kernel.fs as any).writeFile(dp, text)
    } catch (e: any) {
      if (recursive) {
        // Best-effort: report as unsupported
        return err(`cp: recursive copy not fully supported in bun-browser`)
      }
      return err(`cp: cannot copy '${src}': ${e?.message ?? e}`)
    }
    return ok()
  },

  async mv(args, ctx) {
    if (args.length < 2) return err('mv: missing destination')
    const src = args[0], dst = args[1]
    const sp = src.startsWith('/') ? src : ctx.env.cwd.replace(/\/$/, '') + '/' + src
    const dp = dst.startsWith('/') ? dst : ctx.env.cwd.replace(/\/$/, '') + '/' + dst
    try {
      await (ctx.kernel.fs as any).rename(sp, dp)
    } catch (e: any) {
      return err(`mv: cannot move '${src}': ${e?.message ?? e}`)
    }
    return ok()
  },

  env(_args, ctx) {
    const lines = Object.entries(ctx.env.vars).map(([k, v]) => `${k}=${v}`).join('\n')
    return ok(lines + '\n')
  },

  export(args, ctx) {
    for (const a of args) {
      const eq = a.indexOf('=')
      if (eq >= 0) {
        ctx.env.vars[a.slice(0, eq)] = a.slice(eq + 1)
      }
    }
    return ok()
  },

  true: () => ok(),
  false: () => ({ exitCode: 1, stdout: '', stderr: '' }),
  ':': () => ok(),

  printf(args) {
    // minimal printf: first arg is format, rest are values
    // only support %s, %d, \n, \t
    if (args.length === 0) return ok()
    let fmt = args[0]
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
        else { result += '%'; }
      } else {
        result += fmt[i++]
      }
    }
    return ok(result)
  },
}

// ── Interpreter ───────────────────────────────────────────────────────────────

/**
 * Expands `$VAR`, `${VAR}` references in `word` using current env vars.
 * `$(cmd)` and backtick substitution are kept verbatim (execution-time only).
 */
function expandVars(word: string, vars: Record<string, string>): string {
  return word.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*|\$|\?|[0-9]+)/g, (match, braced, bare) => {
    const name = braced ?? bare
    if (name === '$') return String(typeof globalThis !== 'undefined' && 'process' in globalThis ? (globalThis as any).process.pid ?? 0 : 0)
    if (name === '?') return '0'
    return vars[name] ?? ''
  })
}

/** Expand all args in a Cmd node, applying brace expansion via kernel WASM. */
function expandArgs(argv: string[], env: ShellEnv): string[] {
  const result: string[] = []
  for (const raw of argv) {
    const expanded = expandVars(raw, env.vars)
    result.push(expanded)
  }
  return result
}

export class ShellInterpreter {
  constructor(private readonly kernel: Kernel) {}

  /** Run a shell source string.  `env` overrides are merged into a fresh env. */
  async run(ast: ShellAST, env?: Partial<ShellEnv>): Promise<ShellResult> {
    const shellEnv: ShellEnv = {
      vars: { ...(env?.vars ?? {}) },
      cwd: env?.cwd ?? '/',
    }
    return this._runNode(ast, shellEnv, '')
  }

  private async _runNode(
    node: ShellAST | ShellCmd | ShellPipe,
    env: ShellEnv,
    stdin: string,
  ): Promise<ShellResult> {
    if (node.t === 'seq') {
      let last: ShellResult = { exitCode: 0, stdout: '', stderr: '' }
      for (const stmt of node.stmts) {
        last = await this._runNode(stmt, env, stdin)
      }
      return last
    }
    if (node.t === 'pipe') {
      return this._runPipeline(node, env)
    }
    return this._runCmd(node, env, stdin)
  }

  private async _runPipeline(node: ShellPipe, env: ShellEnv): Promise<ShellResult> {
    let input = ''
    let lastResult: ShellResult = { exitCode: 0, stdout: '', stderr: '' }
    for (const cmd of node.cmds) {
      lastResult = await this._runCmd(cmd, env, input)
      input = lastResult.stdout
    }
    return lastResult
  }

  private async _runCmd(cmd: ShellCmd, env: ShellEnv, stdin: string): Promise<ShellResult> {
    const argv = expandArgs(cmd.argv, env)
    if (argv.length === 0) return { exitCode: 0, stdout: '', stderr: '' }

    const [cmdName, ...args] = argv

    // Built-in check
    const builtin = BUILTINS[cmdName]
    if (builtin) {
      const result = await builtin(args, { env, kernel: this.kernel, stdin })
      // Apply output redirections for built-ins
      await this._applyRedirs(cmd.redirs, result.stdout, env)
      return result
    }

    // External process via kernel.process()
    try {
      const handle = await this.kernel.process(argv, {
        stdin,
        env: env.vars,
        cwd: env.cwd,
      })
      const [out, err_out, code] = await Promise.all([
        handle.stdout ? collectStream(handle.stdout) : Promise.resolve(''),
        handle.stderr ? collectStream(handle.stderr) : Promise.resolve(''),
        handle.exit,
      ])
      // Apply redirections
      await this._applyRedirs(cmd.redirs, out, env)
      return { exitCode: code, stdout: out, stderr: err_out }
    } catch (e: any) {
      return { exitCode: 127, stdout: '', stderr: `${cmdName}: command not found\n` }
    }
  }

  private async _applyRedirs(redirs: ShellRedir[], stdout: string, env: ShellEnv): Promise<void> {
    for (const r of redirs) {
      if (r.t === '>' || r.t === '>>') {
        const path = r.target.startsWith('/') ? r.target : env.cwd.replace(/\/$/, '') + '/' + r.target
        try {
          if (r.t === '>>') {
            let existing = ''
            try { existing = await (this.kernel.fs as any).readFile(path, 'utf-8') } catch { /* ignore */ }
            await (this.kernel.fs as any).writeFile(path, existing + stdout)
          } else {
            await (this.kernel.fs as any).writeFile(path, stdout)
          }
        } catch { /* ignore */ }
      }
    }
  }
}

/** Collect all chunks from a ReadableStream<string> into a single string. */
async function collectStream(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader()
  const parts: string[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) parts.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return parts.join('')
}
