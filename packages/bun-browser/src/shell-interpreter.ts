/**
 * Shell Interpreter
 *
 * Executes a ShellAST produced by `wasm.ts shellParse()` using the Kernel for
 * process spawning.  Built-in commands are resolved through a `CommandRegistry`
 * (default: `createDefaultRegistry()` from `shell-command-registry.ts`) allowing
 * runtime extension and sandbox restriction.
 */

import type { Kernel } from './kernel.js'
import type { ShellAST, ShellCmd, ShellPipe, ShellRedir } from './wasm.js'
import { type CommandRegistry, createDefaultRegistry } from './shell-command-registry.js'

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
  constructor(
    private readonly kernel: Kernel,
    private readonly registry: CommandRegistry = createDefaultRegistry(),
  ) {}

  /** Run a shell source string.  `env` overrides are merged into a fresh env. */
  async run(ast: ShellAST, env?: Partial<ShellEnv>): Promise<ShellResult> {
    const shellEnv: ShellEnv = {
      vars: { ...(env?.vars ?? {}) },
      cwd: env?.cwd ?? '/',
    }
    return this.execute(ast, shellEnv, '')
  }

  private async execute(
    node: ShellAST | ShellCmd | ShellPipe,
    env: ShellEnv,
    stdin: string,
  ): Promise<ShellResult> {
    if (node.t === 'seq') {
      let last: ShellResult = { exitCode: 0, stdout: '', stderr: '' }

      for (const stmt of node.stmts) {
        last = await this.execute(stmt, env, stdin)
      }
      return last
    }

    if (node.t === 'pipe') {
      return this.pipe(node, env)
    }

    return this.executeCommand(node, env, stdin)
  }

  private async pipe(node: ShellPipe, env: ShellEnv): Promise<ShellResult> {
    let input = ''
    let lastResult: ShellResult = { exitCode: 0, stdout: '', stderr: '' }
    for (const cmd of node.cmds) {
      lastResult = await this.executeCommand(cmd, env, input)
      input = lastResult.stdout
    }
    return lastResult
  }

  private async executeCommand(cmd: ShellCmd, env: ShellEnv, stdin: string): Promise<ShellResult> {
    const argv = expandArgs(cmd.argv, env)
    if (argv.length === 0) return { exitCode: 0, stdout: '', stderr: '' }

    const cmdName = argv[0]!
    const args = argv.slice(1)

    // Built-in check
    const builtin = this.registry.resolve(cmdName)
    if (builtin) {
      const result = await builtin(args, { env, kernel: this.kernel, stdin })
      // Apply output redirections for built-ins
      await this._applyRedirs(cmd.redirs, result.stdout, env)
      return result
    }

    // External process via kernel.process()
    try {
      const handle = await this.kernel.process(argv, {
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
            try { existing = await this.kernel.readFile(path, 'utf8') } catch { /* ignore */ }
            await this.kernel.writeFile(path, existing + stdout)
          } else {
            await this.kernel.writeFile(path, stdout)
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
