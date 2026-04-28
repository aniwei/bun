export const HOOK_TIMINGS = [
  // Runtime lifecycle
  "runtime.boot.start",
  "runtime.boot.end",
  "runtime.dispose.start",
  "runtime.dispose.end",

  // Global context installation
  "globals.install",
  "globals.installed",

  // Features loading (esbuild, swc, sql, etc.)
  "features.load.start",
  "features.load.end",

  // VFS events
  "vfs.file.created",
  "vfs.file.changed",
  "vfs.file.deleted",
  "vfs.synced",

  // Script execution
  "script.run.start",
  "script.run.end",
  "script.run.error",

  // Process/Kernel lifecycle
  "process.created",
  "process.spawned",
  "process.exited",
  "process.error",

  // Shell operations
  "shell.command.run",
  "shell.command.end",
  "shell.command.error",

  // Package management
  "install.start",
  "install.end",
  "install.error",

  // Service Worker
  "sw.registered",
  "sw.unregistered",
  "sw.error",

  // VFS restore/snapshot
  "vfs.restore.start",
  "vfs.restore.end",
  "vfs.snapshot.start",
  "vfs.snapshot.end",
] as const

export type HookTiming = (typeof HOOK_TIMINGS)[number]

export const INTERCEPTOR_TIMINGS = [
  // Global context installation interception
  "globals.install",

  // VFS file write interception
  "vfs.file.created",
  "vfs.file.changed",

  // Script execution parameter modification
  "script.run.start",

  // Process creation interception
  "process.created",

  // Shell command modification
  "shell.command.run",

  // Install parameter modification
  "install.start",
] as const

export type InterceptorTiming = (typeof INTERCEPTOR_TIMINGS)[number]
export type ObserverTiming = Exclude<HookTiming, InterceptorTiming>

export type HookInput<_T extends HookTiming> = unknown
export type HookOutput<_T extends HookTiming> = unknown

export type InterceptorHookHandle<T extends InterceptorTiming> = (
  input: HookInput<T>,
  output: HookOutput<T>,
) => void | Promise<void>

export type ObserverHookHandle<T extends ObserverTiming> = (
  input: HookInput<T>,
) => void | Promise<void>

export type HookHandle<T extends HookTiming> = T extends InterceptorTiming
  ? InterceptorHookHandle<T>
  : T extends ObserverTiming
    ? ObserverHookHandle<T>
    : never

interface HookBase<T extends HookTiming> {
  name: string
  timing: T
  priority: number
  enabled: boolean
}

export type InterceptorHookSpec<T extends InterceptorTiming = InterceptorTiming> = HookBase<T> & {
  kind: "interceptor"
  handle: InterceptorHookHandle<T>
}

export type ObserverHookSpec<T extends ObserverTiming = ObserverTiming> = HookBase<T> & {
  kind: "observer"
  handle: ObserverHookHandle<T>
}

export type HookSpec = InterceptorHookSpec | ObserverHookSpec

export type HookPreset = "default" | "strict" | "minimal" | "none"

export interface HookRegistryOptions {
  preset?: HookPreset
}

export interface RegisteredHookInfo {
  name: string
  timing: HookTiming
  priority: number
  enabled: boolean
}

function createHookBuckets(): Record<HookTiming, HookSpec[]> {
  return {
    // Runtime lifecycle
    "runtime.boot.start": [],
    "runtime.boot.end": [],
    "runtime.dispose.start": [],
    "runtime.dispose.end": [],

    // Global context installation
    "globals.install": [],
    "globals.installed": [],

    // Features loading
    "features.load.start": [],
    "features.load.end": [],

    // VFS events
    "vfs.file.created": [],
    "vfs.file.changed": [],
    "vfs.file.deleted": [],
    "vfs.synced": [],

    // Script execution
    "script.run.start": [],
    "script.run.end": [],
    "script.run.error": [],

    // Process/Kernel lifecycle
    "process.created": [],
    "process.spawned": [],
    "process.exited": [],
    "process.error": [],

    // Shell operations
    "shell.command.run": [],
    "shell.command.end": [],
    "shell.command.error": [],

    // Package management
    "install.start": [],
    "install.end": [],
    "install.error": [],

    // Service Worker
    "sw.registered": [],
    "sw.unregistered": [],
    "sw.error": [],

    // VFS restore/snapshot
    "vfs.restore.start": [],
    "vfs.restore.end": [],
    "vfs.snapshot.start": [],
    "vfs.snapshot.end": [],
  }
}

export function defineHook<T extends HookTiming>(spec: {
  name: string
  timing: T
  handle: HookHandle<T>
  priority?: number
  enabled?: boolean
}): HookSpec {
  const kind = isInterceptorTiming(spec.timing) ? "interceptor" : "observer"

  return {
    name: spec.name,
    timing: spec.timing,
    handle: spec.handle,
    kind,
    priority: spec.priority ?? 50,
    enabled: spec.enabled ?? true,
  } as HookSpec
}

export class HookRegistry {
  private readonly hooks = createHookBuckets()
  private readonly disabled = new Set<string>()

  constructor(options?: HookRegistryOptions) {
    if (options?.preset && options.preset !== "none") {
      this.applyPreset(options.preset)
    }
  }

  register(spec: HookSpec): void {
    this.hooks[spec.timing].push(spec)
  }

  registerAll(specs: HookSpec[]): void {
    for (const spec of specs) this.register(spec)
  }

  on<T extends HookTiming>(timing: T, name: string, handle: HookHandle<T>, priority = 50): this {
    this.register(defineHook({ name, timing, handle, priority }))
    return this
  }

  has(name: string): boolean {
    return this.getRegistered().some(hook => hook.name === name)
  }

  unregister(name: string): boolean {
    let removed = false

    for (const timing of HOOK_TIMINGS) {
      const list = this.hooks[timing]
      const filtered = list.filter(hook => hook.name !== name)
      if (filtered.length < list.length) {
        this.hooks[timing] = filtered
        removed = true
      }
    }

    return removed
  }

  disable(name: string): void {
    this.disabled.add(name)
  }

  enable(name: string): void {
    this.disabled.delete(name)
  }

  getRegistered(timing?: HookTiming): RegisteredHookInfo[] {
    if (timing) return this.hooks[timing].map(toHookInfo)

    const all: RegisteredHookInfo[] = []
    for (const key of HOOK_TIMINGS) {
      all.push(...this.hooks[key].map(toHookInfo))
    }

    return all
  }

  async execute<T extends InterceptorTiming>(
    timing: T,
    input: HookInput<T>,
    output: HookOutput<T>,
  ): Promise<void> {
    const hooks = this.getSortedInterceptorHooks(timing)
    for (const hook of hooks) {
      try {
        await hook.handle(input, output)
      } catch {
        // hook failures are isolated and should not break runtime flow
      }
    }
  }

  async emit<T extends ObserverTiming>(timing: T, input: HookInput<T>): Promise<void> {
    const hooks = this.getSortedObserverHooks(timing)
    for (const hook of hooks) {
      try {
        await hook.handle(input)
      } catch {
        // hook failures are isolated and should not break runtime flow
      }
    }
  }

  clear(): void {
    for (const timing of HOOK_TIMINGS) {
      this.hooks[timing] = []
    }
    this.disabled.clear()
  }

  private getSortedInterceptorHooks(timing: InterceptorTiming): InterceptorHookSpec[] {
    return this.hooks[timing]
      .filter(
        (hook): hook is InterceptorHookSpec =>
          hook.kind === "interceptor" && hook.enabled && !this.disabled.has(hook.name),
      )
      .sort((a, b) => a.priority - b.priority)
  }

  private getSortedObserverHooks(timing: ObserverTiming): ObserverHookSpec[] {
    return this.hooks[timing]
      .filter(
        (hook): hook is ObserverHookSpec =>
          hook.kind === "observer" && hook.enabled && !this.disabled.has(hook.name),
      )
      .sort((a, b) => a.priority - b.priority)
  }

  private applyPreset(preset: HookPreset): void {
    this.registerAll(getPresetHooks(preset))
  }
}

function isInterceptorTiming(timing: HookTiming): timing is InterceptorTiming {
  return (INTERCEPTOR_TIMINGS as readonly string[]).includes(timing)
}

function toHookInfo(hook: HookSpec): RegisteredHookInfo {
  return {
    name: hook.name,
    timing: hook.timing,
    priority: hook.priority,
    enabled: hook.enabled,
  }
}

function getPresetHooks(preset: HookPreset): HookSpec[] {
  switch (preset) {
    case "default":
      return getDefaultPresetHooks()
    case "strict":
      return getStrictPresetHooks()
    case "minimal":
      return getMinimalPresetHooks()
    default:
      return []
  }
}

function getDefaultPresetHooks(): HookSpec[] {
  return []
}

function getStrictPresetHooks(): HookSpec[] {
  return []
}

function getMinimalPresetHooks(): HookSpec[] {
  return []
}
