import type { HookRegistry } from '@mars/web-hooks'
import { defineHook } from '@mars/web-hooks'
import type {
  BunBuildContext,
  LoaderArgs,
  LoaderPattern,
  PluginContext,
  PluginLogger,
} from './plugin.types'

// ── 默认 logger ───────────────────────────────────────────────────────────────

function createLogger(name: string): PluginLogger {
  const prefix = `[Plugin:${name}]`
  return {
    info: (msg: string) => console.info(`${prefix} ${msg}`),
    warn: (msg: string) => console.warn(`${prefix} ${msg}`),
    error: (msg: string) => console.error(`${prefix} ${msg}`),
  }
}

// ── PluginContextImpl ─────────────────────────────────────────────────────────

/**
 * `PluginContext` 的内部实现。
 *
 * 每个插件调用 `setup(ctx)` 时获得独立的 PluginContextImpl 实例。
 * 通过 `registerLoader` 注册的 loader 模式会：
 *   1. 追加到本实例的 `_patterns` 列表（用于副作用回滚）
 *   2. 同时在 HookRegistry 的 `loader:load` timing 注册一个 hook，
 *      hook name = `<pluginName>:loader:<index>`
 *
 * 当插件被 disable 时，调用 disableHooks() 将所有关联 hook 屏蔽；
 * 当插件被 enable 时，调用 enableHooks() 恢复；
 * 当插件被 unregister 时，调用 rollback() 彻底从 HookRegistry 移除所有 hook。
 */
export class PluginContextImpl implements PluginContext {
  readonly logger: PluginLogger
  readonly abortSignal: AbortSignal

  private readonly registry: HookRegistry
  private readonly pluginName: string
  private readonly registeredHookNames: string[] = []
  private readonly patterns: LoaderPattern[] = []
  private loaderIndex = 0

  constructor(
    pluginName: string,
    registry: HookRegistry,
    abortSignal: AbortSignal,
  ) {
    this.pluginName = pluginName
    this.registry = registry
    this.abortSignal = abortSignal
    this.logger = createLogger(pluginName)
  }

  // ── PluginContext 公共接口 ────────────────────────────────────────────────

  registerLoader(opts: LoaderPattern): void {
    this.patterns.push(opts)

    const hookName = `${this.pluginName}:loader:${this.loaderIndex++}`
    this.registeredHookNames.push(hookName)

    this.registry.register(
      defineHook({
        name: hookName,
        timing: 'loader:load',
        priority: 50,
        handle: async (input, output) => {
          const args = input as LoaderArgs & { importer?: string }
          const loaderArgs: LoaderArgs = {
            path: args.path,
            namespace: args.namespace,
            importer: args.importer ?? '',
          }

          // 检查此 pattern 是否匹配
          if (!this.patternMatches(opts, loaderArgs)) {
            return
          }

          const result = await opts.loader(loaderArgs)
          if (result) {
            const out = output as { contents?: string | Uint8Array; loader?: string }
            out.contents = result.contents
            if (result.loader) {
              out.loader = result.loader
            }
          }
        },
      }),
    )
  }

  // ── 副作用管理（供 PluginRegistry 调用） ────────────────────────────────

  disableHooks(): void {
    for (const name of this.registeredHookNames) {
      this.registry.disable(name)
    }
  }

  enableHooks(): void {
    for (const name of this.registeredHookNames) {
      this.registry.enable(name)
    }
  }

  rollback(): void {
    for (const name of this.registeredHookNames) {
      this.registry.unregister(name)
    }
    this.registeredHookNames.length = 0
    this.patterns.length = 0
  }

  // ── 供 BunBuildContext adapter 使用 ─────────────────────────────────────

  asBunBuildContext(): BunBuildContext {
    return {
      onLoad: (opts, callback) => {
        this.registerLoader({
          filter: opts.filter,
          namespace: opts.namespace,
          loader: args => callback({ path: args.path, namespace: args.namespace, importer: args.importer }),
        })
      },
    }
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private patternMatches(pattern: LoaderPattern, args: LoaderArgs): boolean {
    if (pattern.namespace !== undefined && pattern.namespace !== args.namespace) {
      return false
    }
    return pattern.filter.test(args.path)
  }
}
