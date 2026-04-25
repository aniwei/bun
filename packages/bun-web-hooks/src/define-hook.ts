import type {
  HookHandle,
  HookSpec,
  HookTiming,
  InterceptorRuntimeHook,
  InterceptorTiming,
  ObserverRuntimeHook,
  ObserverTiming,
} from './hooks.types'
import { INTERCEPTOR_TIMINGS } from './timings'

function isInterceptorTiming(timing: HookTiming): timing is InterceptorTiming {
  return (INTERCEPTOR_TIMINGS as readonly string[]).includes(timing)
}

export function defineHook<T extends InterceptorTiming>(spec: {
  name: string
  timing: T
  handle: HookHandle<T>
  priority?: number
  enabled?: boolean
}): InterceptorRuntimeHook

export function defineHook<T extends ObserverTiming>(spec: {
  name: string
  timing: T
  handle: HookHandle<T>
  priority?: number
  enabled?: boolean
}): ObserverRuntimeHook

export function defineHook(spec: {
  name: string
  timing: HookTiming
  handle: (input: unknown, output?: unknown) => void | Promise<void>
  priority?: number
  enabled?: boolean
}): HookSpec {
  const kind: 'interceptor' | 'observer' = isInterceptorTiming(spec.timing)
    ? 'interceptor'
    : 'observer'

  return {
    kind,
    name: spec.name,
    timing: spec.timing as never,
    priority: spec.priority ?? 50,
    enabled: spec.enabled ?? true,
    handle: spec.handle as never,
  }
}
