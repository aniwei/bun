import type { ShellCommandRegisterHook, ShellCommandRegistry } from './types'

export function applyShellCommandRegisterHooks(
  registry: ShellCommandRegistry,
  hooks: ShellCommandRegisterHook[] = [],
): ShellCommandRegistry {
  for (const hook of hooks) {
    hook(registry)
  }
  return registry
}
