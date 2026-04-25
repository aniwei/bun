// ── Plugin 类型（对齐 RFC §6.2 MarsWebPlugin / PluginContext） ─────────────────

export type PluginScope = 'kernel' | 'process' | 'sw' | 'shell'

export interface MarsWebPlugin {
  name: string
  version?: string
  scopes?: PluginScope[]
  setup(ctx: PluginContext): void | Promise<void>
}

// ── Loader 模式（对齐 RFC §20 LoaderPattern） ──────────────────────────────────

export type SupportedLoader = 'ts' | 'tsx' | 'js' | 'jsx' | 'json' | 'css' | 'text' | 'file'

export interface LoaderArgs {
  /** 被加载文件的绝对路径 */
  path: string
  /** esbuild namespace（例如 "file"、"http-url"） */
  namespace: string
  /** 发起此次导入的文件路径 */
  importer: string
}

export interface LoaderResult {
  contents: string | Uint8Array
  loader?: SupportedLoader
}

export interface LoaderPattern {
  /** 匹配文件路径的正则 */
  filter: RegExp
  /** 可选：限制 namespace */
  namespace?: string
  loader(args: LoaderArgs): LoaderResult | Promise<LoaderResult>
}

// ── 插件上下文（PluginContext 公共接口） ───────────────────────────────────────

export interface PluginContext {
  /**
   * 注册一个 loader 回调，对齐 Bun.plugin({ setup(build) { build.onLoad(...) } })
   * 内部映射到 HookRegistry 的 loader:load / loader:transform timing
   */
  registerLoader(opts: LoaderPattern): void
  /** 记录日志（scope = plugin name） */
  readonly logger: PluginLogger
  /** 插件生命周期终止信号（Kernel 熔断时 abort） */
  readonly abortSignal: AbortSignal
}

export interface PluginLogger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

// ── 已注册插件快照（用于 disable/enable/rollback） ───────────────────────────

export interface RegisteredPlugin {
  readonly name: string
  readonly version: string | undefined
  readonly scopes: PluginScope[]
  /** 运行时是否处于激活状态 */
  enabled: boolean
}

// ── Bun.plugin 兼容入口参数（对齐原生 Bun API） ───────────────────────────────

export interface BunPluginDescriptor {
  name: string
  target?: 'bun' | 'browser' | 'node'
  setup(build: BunBuildContext): void | Promise<void>
}

/**
 * Bun.plugin({ setup(build) {} }) 中 build 对象的最小接口
 * 仅暴露 loader 注册能力，与 bun-types 中同名 API 对齐
 */
export interface BunBuildContext {
  onLoad(
    opts: { filter: RegExp; namespace?: string },
    callback: (args: { path: string; namespace: string; importer?: string }) => LoaderResult | Promise<LoaderResult>,
  ): void
}
