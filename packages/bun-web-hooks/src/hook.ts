import type {
  HookBuckets,
  HookHandle,
  HookInput,
  HookOutput,
  HookSpec,
  HookTiming,
  InterceptorRuntimeHook,
  InterceptorTiming,
  ObserverRuntimeHook,
  ObserverTiming,
  RegisteredHookInfo,
} from './hooks.types'
import { HOOK_TIMINGS, INTERCEPTOR_TIMINGS, createHookBuckets } from './timings'
import { defineHook } from './define-hook'
import { type HookPreset, getPresetHooks } from './presets'

export interface HookRegistryOptions {
  preset?: HookPreset
}

function toHookInfo(hook: HookSpec): RegisteredHookInfo {
  return {
    name: hook.name,
    timing: hook.timing,
    priority: hook.priority,
    enabled: hook.enabled,
  }
}

function isInterceptorTiming(timing: HookTiming): timing is InterceptorTiming {
  return (INTERCEPTOR_TIMINGS as readonly string[]).includes(timing)
}

export class HookRegistry {
  private readonly hooks: HookBuckets = createHookBuckets()
  private readonly disabled = new Set<string>()

  constructor(options?: HookRegistryOptions) {
    if (options?.preset && options.preset !== 'none') {
      this.applyPreset(options.preset)
    }
  }

  // ── 注册 ────────────────────────────────────────────────────────────────────

  register(spec: HookSpec): void {
    this.hooks[spec.timing].push(spec as never)
  }

  registerAll(specs: HookSpec[]): void {
    for (const spec of specs) {
      this.register(spec)
    }
  }

  on<T extends HookTiming>(
    timing: T,
    name: string,
    handle: HookHandle<T>,
    priority = 50,
  ): this {
    this.register(
      defineHook({ name, timing: timing as never, handle: handle as never, priority }),
    )
    return this
  }

  // ── 查询 ────────────────────────────────────────────────────────────────────

  has(name: string): boolean {
    return this.getRegistered().some(h => h.name === name)
  }

  // ── 移除 ────────────────────────────────────────────────────────────────────

  unregister(name: string): boolean {
    let removed = false
    for (const timing of HOOK_TIMINGS) {
      const list = this.hooks[timing]
      const filtered = list.filter(h => h.name !== name)
      if (filtered.length < list.length) {
        ;(this.hooks[timing] as HookSpec[]) = filtered
        removed = true
      }
    }
    return removed
  }

  // ── 启用/屏蔽（不删 bucket，便于快速恢复） ────────────────────────────────

  disable(name: string): void {
    this.disabled.add(name)
  }

  enable(name: string): void {
    this.disabled.delete(name)
  }

  // ── 清空 ────────────────────────────────────────────────────────────────────

  clear(): void {
    for (const timing of HOOK_TIMINGS) {
      ;(this.hooks[timing] as HookSpec[]) = []
    }
    this.disabled.clear()
  }

  // ── 查询已注册 ──────────────────────────────────────────────────────────────

  getRegistered(timing?: HookTiming): RegisteredHookInfo[] {
    if (timing) {
      return this.hooks[timing].map(toHookInfo)
    }
    const all: RegisteredHookInfo[] = []
    for (const key of HOOK_TIMINGS) {
      all.push(...this.hooks[key].map(toHookInfo))
    }
    return all
  }

  // ── 执行（interceptor：有输出；observer：无输出） ─────────────────────────

  async execute<T extends InterceptorTiming>(
    timing: T,
    input: HookInput<T>,
    output: HookOutput<T>,
  ): Promise<void> {
    const hooks = this.getSortedInterceptorHooks(timing)
    for (const hook of hooks) {
      try {
        await hook.handle(input as never, output as never)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[HookRegistry] hook "${hook.name}" (${timing}) failed: ${message}`)
      }
    }
  }

  async emit<T extends ObserverTiming>(
    timing: T,
    input: HookInput<T>,
  ): Promise<void> {
    const hooks = this.getSortedObserverHooks(timing)
    for (const hook of hooks) {
      try {
        await hook.handle(input as never)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[HookRegistry] hook "${hook.name}" (${timing}) failed: ${message}`)
      }
    }
  }

  // ── 内部工具 ────────────────────────────────────────────────────────────────

  private getSortedInterceptorHooks(timing: InterceptorTiming): InterceptorRuntimeHook[] {
    return (this.hooks[timing] as HookSpec[])
      .filter(
        (h): h is InterceptorRuntimeHook =>
          h.kind === 'interceptor' && h.enabled && !this.disabled.has(h.name),
      )
      .sort((a, b) => a.priority - b.priority)
  }

  private getSortedObserverHooks(timing: ObserverTiming): ObserverRuntimeHook[] {
    return (this.hooks[timing] as HookSpec[])
      .filter(
        (h): h is ObserverRuntimeHook =>
          h.kind === 'observer' && h.enabled && !this.disabled.has(h.name),
      )
      .sort((a, b) => a.priority - b.priority)
  }

  private applyPreset(preset: HookPreset): void {
    this.registerAll(getPresetHooks(preset))
  }
}
