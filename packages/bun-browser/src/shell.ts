/**
 * T5.13.4–T5.13.5 — `Bun.$` template-string shell tag for bun-browser.
 *
 * Usage (inside bun-browser host code):
 *
 *   import { createShell } from 'bun-browser/shell'
 *   const $ = createShell(kernel, wasmRuntime)
 *
 *   const output = await $`ls /src`.text()
 *   const files  = await $`ls /src`.lines()
 *   const json   = await $`cat /src/package.json`.json()
 *   const res    = await $`echo hello | cat`      // ShellResult
 */

import type { Kernel } from './kernel.js'
import type { WasmRuntime } from './wasm.js'
import { ShellInterpreter } from './shell-interpreter.js'
import type { ShellResult, ShellEnv } from './shell-interpreter.js'

export type { ShellResult, ShellEnv }

// ── ShellPromise (T5.13.5) ────────────────────────────────────────────────────

/**
 * A Promise<ShellResult> with convenience accessors.
 *
 * `.text()`  — resolves with trimmed stdout
 * `.lines()` — resolves with non-empty stdout lines
 * `.json()`  — parses stdout as JSON
 */
export class ShellPromise extends Promise<ShellResult> {
  // ShellPromise is a proper subclass of Promise. The constructor signature must
  // accept an executor OR a resolved-value factory (for internal use).
  constructor(executor: (resolve: (v: ShellResult | PromiseLike<ShellResult>) => void, reject: (r?: unknown) => void) => void) {
    super(executor)
  }

  /** Trimmed stdout string. */
  text(): Promise<string> {
    return this.then(r => r.stdout.trimEnd())
  }

  /** Non-empty stdout lines (trailing newlines stripped). */
  lines(): Promise<string[]> {
    return this.then(r =>
      r.stdout.split('\n').filter(l => l.length > 0)
    )
  }

  /** Parse stdout as JSON. */
  json<T = unknown>(): Promise<T> {
    return this.then(r => JSON.parse(r.stdout) as T)
  }

  /** @override Make `.then()` / `.catch()` return a plain Promise (not ShellPromise). */
  override then<TResult1 = ShellResult, TResult2 = never>(
    onfulfilled?: ((value: ShellResult) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): Promise<TResult1 | TResult2> {
    return super.then(onfulfilled, onrejected)
  }
}

// ── Shell factory ───────────────────────────────────────────────────────────

export interface ShellOptions {
  /** Initial environment variables merged into every command's env. */
  env?: Record<string, string>
  /** Initial working directory (defaults to '/'). */
  cwd?: string
}

/**
 * Create a `$` template-string tag backed by `kernel` for process spawning.
 *
 * @param kernel  bun-browser Kernel instance
 * @param rt      WasmRuntime used for shell parsing (`bun_shell_parse`)
 * @param opts    Default environment and CWD for spawned commands
 */
export function createShell(
  kernel: Kernel,
  rt: WasmRuntime,
  opts: ShellOptions = {},
): (template: TemplateStringsArray, ...substitutions: unknown[]) => ShellPromise {
  const interpreter = new ShellInterpreter(kernel)

  const defaultEnv: ShellEnv = {
    vars: { ...opts.env },
    cwd: opts.cwd ?? '/',
  }

  return function $(template: TemplateStringsArray, ...subs: unknown[]): ShellPromise {
    // Build the shell source string from the template + substitutions
    let src = ''
    for (let i = 0; i < template.raw.length; i++) {
      src += template.raw[i]
      if (i < subs.length) {
        src += String(subs[i])
      }
    }

    return new ShellPromise((resolve, reject) => {
      // Parse via WASM
      let ast
      try {
        ast = rt.shellParse(src)
      } catch (e) {
        reject(e)
        return
      }
      if (!ast) {
        reject(new Error(`bun-browser shell: bun_shell_parse not available`))
        return
      }

      // Run with a fresh copy of the default env (so mutations don't leak)
      const env: ShellEnv = {
        vars: { ...defaultEnv.vars },
        cwd: defaultEnv.cwd,
      }

      interpreter.run(ast, env).then(resolve, reject)
    })
  }
}
