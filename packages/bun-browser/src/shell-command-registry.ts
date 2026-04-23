/**
 * Shell CommandRegistry
 *
 * 将内置命令从静态 Record 升级为可运行时扩展的注册表。
 * 外部模块可通过 `defaultRegistry.register(...)` 添加或替换命令；
 * `ShellInterpreter` 接受可选的 `CommandRegistry` 依赖注入，
 * 便于沙箱模式、插件系统与单元测试。
 */
import type { Kernel } from './kernel.js'
import type { ShellResult } from './shell-interpreter.js'
import { registerBuiltinShellCommands } from './shell-builtin-command.js'

// ── Public types ──────────────────────────────────────────────────────────────

/** Context passed to every built-in command implementation. */
export interface BuiltinContext {
  env: {
    vars: Record<string, string>
    cwd: string
  }
  kernel: Kernel
  stdin: string
}

export type BuiltinHandle = (args: string[], ctx: BuiltinContext) => Promise<ShellResult> | ShellResult

/** Optional metadata attached to a registered command. */
export interface CommandMeta {
  /** One-line usage string, e.g. `"ls [dir]"`. */
  usage?: string
  /** Short human-readable description shown by `help`. */
  description?: string
}

export interface CommandEntry {
  fn: BuiltinHandle
  meta: CommandMeta
}

// ── CommandRegistry ───────────────────────────────────────────────────────────
export class CommandRegistry {
  private readonly commands = new Map<string, CommandEntry>()

  /**
   * Register (or overwrite) a command.
   * Returns `this` for chaining.
   */
  register(name: string, fn: BuiltinHandle, meta: CommandMeta = {}): this {
    this.commands.set(name, { fn, meta })
    return this
  }

  /**
   * Remove a command by name.
   * Returns `true` if the command existed.
   */
  unregister(name: string): boolean {
    return this.commands.delete(name)
  }

  /** Resolve a command name to its implementation, or `undefined` if unknown. */
  resolve(name: string): BuiltinHandle | undefined {
    return this.commands.get(name)?.fn
  }

  /** Iterate all registered commands (name → entry). */
  list(): ReadonlyMap<string, CommandEntry> {
    return this.commands
  }
}

/** @deprecated Use BuiltinHandle instead. */
export type BuiltinFn = BuiltinHandle
/** @deprecated Use BuiltinContext instead. */
export type BuiltinCtx = BuiltinContext

// ── Default registry with all built-in commands ───────────────────────────────
export const createDefaultRegistry = (): CommandRegistry => {
  const registry = new CommandRegistry()
  registerBuiltinShellCommands(registry)
  return registry
}

/** Singleton default registry pre-loaded with all built-in commands. */
export const defaultRegistry: CommandRegistry = createDefaultRegistry()

