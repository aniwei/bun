// @mars/web-plugin-api – 公共导出

// 类型
export type {
  MarsWebPlugin,
  PluginContext,
  PluginLogger,
  PluginScope,
  LoaderPattern,
  LoaderArgs,
  LoaderResult,
  SupportedLoader,
  RegisteredPlugin,
  BunPluginDescriptor,
  BunBuildContext,
} from './plugin.types'

// loader-pattern 工具
export { matchesLoaderPattern, dispatchLoader } from './loader-pattern'

// PluginContext 实现
export { PluginContextImpl } from './plugin-context'

// sandbox
export {
  runWithBudget,
  PluginBudgetExceededError,
  type PluginBudget,
} from './sandbox'

// 主注册容器
export { PluginRegistry } from './plugin-registry'
