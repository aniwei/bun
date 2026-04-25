// @mars/web-hooks – 公共导出

// 类型
export type {
  HookTiming,
  InterceptorTiming,
  ObserverTiming,
  HookInput,
  HookOutput,
  HookHandle,
  HookSpec,
  InterceptorRuntimeHook,
  ObserverRuntimeHook,
  RuntimeHook,
  RegisteredHookInfo,
  HookBuckets,
} from './hooks.types'

// 工厂
export { defineHook } from './define-hook'

// 预设
export { getPresetHooks, type HookPreset } from './presets'

// 核心容器
export { HookRegistry, type HookRegistryOptions } from './hook'

// 时序常量
export {
  HOOK_TIMINGS,
  INTERCEPTOR_TIMINGS,
  OBSERVER_TIMINGS,
  createHookBuckets,
} from './timings'
