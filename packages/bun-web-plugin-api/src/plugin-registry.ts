import type { HookRegistry } from '@mars/web-hooks'
import type {
  BunPluginDescriptor,
  MarsWebPlugin,
  PluginScope,
  RegisteredPlugin,
} from './plugin.types'
import { PluginContextImpl } from './plugin-context'
import { PluginBudgetExceededError, runWithBudget, type PluginBudget } from './sandbox'

// ── 内部追踪记录 ───────────────────────────────────────────────────────────────

interface PluginEntry {
  meta: RegisteredPlugin
  ctx: PluginContextImpl
}

// ── PluginRegistry ────────────────────────────────────────────────────────────

/**
 * 统一插件注册容器。
 *
 * 职责：
 * - 接受 MarsWebPlugin 或 Bun.plugin 兼容描述符（BunPluginDescriptor）
 * - 调用 `setup()` 并将 loader 映射到 HookRegistry 的 `loader:load` timing
 * - 暴露运行时 enable/disable/unregister，支持副作用回滚
 * - 防止同名插件重复注册
 */
export class PluginRegistry {
  private readonly entries = new Map<string, PluginEntry>()
  private readonly registry: HookRegistry
  private readonly budget: PluginBudget
  private readonly abortController: AbortController

  constructor(registry: HookRegistry, budget?: PluginBudget) {
    this.registry = registry
    this.budget = budget ?? {}
    this.abortController = new AbortController()
  }

  // ── 注册接口 ────────────────────────────────────────────────────────────────

  /**
   * 注册 MarsWebPlugin 描述符。
   * 若同名插件已存在则跳过（不覆盖、不抛错）。
   */
  async register(plugin: MarsWebPlugin): Promise<void> {
    if (this.entries.has(plugin.name)) {
      console.warn(`[PluginRegistry] Plugin "${plugin.name}" is already registered – skipping.`)
      return
    }

    const ctx = new PluginContextImpl(
      plugin.name,
      this.registry,
      this.abortController.signal,
    )

    try {
      await runWithBudget(
        plugin.name,
        () => Promise.resolve(plugin.setup(ctx)),
        this.budget,
      )
    } catch (error) {
      // setup 失败 → 回滚所有副作用，不污染 HookRegistry
      ctx.rollback()
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[PluginRegistry] Plugin "${plugin.name}" setup failed: ${msg}`)
      // 不重新抛出：一个插件失败不阻断其他插件
      return
    }

    const entry: PluginEntry = {
      meta: {
        name: plugin.name,
        version: plugin.version,
        scopes: plugin.scopes ?? [],
        enabled: true,
      },
      ctx,
    }
    this.entries.set(plugin.name, entry)
  }

  /**
   * 注册 Bun.plugin 兼容描述符。
   * 映射规则：`setup(build)` 中的 `build.onLoad(...)` → `loader:load` timing
   */
  async registerBunPlugin(descriptor: BunPluginDescriptor): Promise<void> {
    const marsPlugin: MarsWebPlugin = {
      name: descriptor.name,
      setup(ctx) {
        return descriptor.setup((ctx as PluginContextImpl).asBunBuildContext())
      },
    }
    return this.register(marsPlugin)
  }

  // ── 运行时控制 ──────────────────────────────────────────────────────────────

  enable(name: string): boolean {
    const entry = this.entries.get(name)
    if (!entry) return false
    entry.meta.enabled = true
    entry.ctx.enableHooks()
    return true
  }

  disable(name: string): boolean {
    const entry = this.entries.get(name)
    if (!entry) return false
    entry.meta.enabled = false
    entry.ctx.disableHooks()
    return true
  }

  /**
   * 彻底卸载插件：从 HookRegistry 移除所有 hook（副作用回滚），
   * 并从 PluginRegistry 内部表删除记录。
   */
  unregister(name: string): boolean {
    const entry = this.entries.get(name)
    if (!entry) return false
    entry.ctx.rollback()
    this.entries.delete(name)
    return true
  }

  // ── 查询 ────────────────────────────────────────────────────────────────────

  has(name: string): boolean {
    return this.entries.has(name)
  }

  get(name: string): RegisteredPlugin | undefined {
    return this.entries.get(name)?.meta
  }

  list(): RegisteredPlugin[] {
    return Array.from(this.entries.values()).map(e => e.meta)
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────────

  /** 卸载所有插件并 abort 生命周期信号 */
  dispose(): void {
    for (const name of [...this.entries.keys()]) {
      this.unregister(name)
    }
    this.abortController.abort()
  }
}
