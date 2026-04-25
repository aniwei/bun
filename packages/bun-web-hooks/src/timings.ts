import type {
  HookBuckets,
  HookTiming,
  InterceptorTiming,
  ObserverTiming,
} from './hooks.types'

export const INTERCEPTOR_TIMINGS: readonly InterceptorTiming[] = [
  'resolve:beforeResolve',
  'loader:load',
  'loader:transform',
  'net:fetch',
  'shell:beforeCommand',
]

export const OBSERVER_TIMINGS: readonly ObserverTiming[] = [
  'kernel:boot',
  'kernel:shutdown',
  'vfs:read',
  'vfs:write',
  'vfs:stat',
  'vfs:watch',
  'resolve:afterResolve',
  'loader:source-map',
  'process:beforeSpawn',
  'process:afterSpawn',
  'process:onExit',
  'net:websocket',
  'net:serve',
  'shell:registerBuiltin',
  'shell:afterCommand',
  'test:beforeEach',
  'test:afterEach',
]

export const HOOK_TIMINGS: readonly HookTiming[] = [
  ...INTERCEPTOR_TIMINGS,
  ...OBSERVER_TIMINGS,
]

export function createHookBuckets(): HookBuckets {
  const buckets: Partial<HookBuckets> = {}
  for (const timing of HOOK_TIMINGS) {
    buckets[timing] = []
  }
  return buckets as HookBuckets
}
