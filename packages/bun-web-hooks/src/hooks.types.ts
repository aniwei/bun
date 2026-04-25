// ── Timing 枚举 ──────────────────────────────────────────────────────────────

export type InterceptorTiming =
  | 'resolve:beforeResolve'
  | 'loader:load'
  | 'loader:transform'
  | 'net:fetch'
  | 'shell:beforeCommand'

export type ObserverTiming =
  | 'kernel:boot'
  | 'kernel:shutdown'
  | 'vfs:read'
  | 'vfs:write'
  | 'vfs:stat'
  | 'vfs:watch'
  | 'resolve:afterResolve'
  | 'loader:source-map'
  | 'process:beforeSpawn'
  | 'process:afterSpawn'
  | 'process:onExit'
  | 'net:websocket'
  | 'net:serve'
  | 'shell:registerBuiltin'
  | 'shell:afterCommand'
  | 'test:beforeEach'
  | 'test:afterEach'

export type HookTiming = InterceptorTiming | ObserverTiming

// ── Hook 输入/输出占位（各 timing 的具体类型可在此扩展） ───────────────────

export type HookInput<T extends HookTiming> = T extends 'loader:load'
  ? { path: string; namespace: string }
  : T extends 'loader:transform'
    ? { path: string; contents: string; loader: string }
    : T extends 'resolve:beforeResolve'
      ? { specifier: string; importer: string }
      : T extends 'net:fetch'
        ? { request: Request }
        : T extends 'shell:beforeCommand'
          ? { argv: string[]; cwd: string }
          : Record<string, unknown>

export type HookOutput<T extends InterceptorTiming> = T extends 'loader:load'
  ? { contents?: string; loader?: string }
  : T extends 'loader:transform'
    ? { contents?: string }
    : T extends 'resolve:beforeResolve'
      ? { resolved?: string }
      : T extends 'net:fetch'
        ? { response?: Response }
        : T extends 'shell:beforeCommand'
          ? { skip?: boolean }
          : Record<string, unknown>

// ── 内部运行时 hook 结构 ────────────────────────────────────────────────────

export interface InterceptorRuntimeHook {
  readonly kind: 'interceptor'
  readonly name: string
  readonly timing: InterceptorTiming
  readonly priority: number
  readonly enabled: boolean
  readonly handle: (input: HookInput<InterceptorTiming>, output: HookOutput<InterceptorTiming>) => void | Promise<void>
}

export interface ObserverRuntimeHook {
  readonly kind: 'observer'
  readonly name: string
  readonly timing: ObserverTiming
  readonly priority: number
  readonly enabled: boolean
  readonly handle: (input: HookInput<ObserverTiming>) => void | Promise<void>
}

export type RuntimeHook = InterceptorRuntimeHook | ObserverRuntimeHook

// HookSpec 是用户侧注册结构（kind 与 handle 在 defineHook 时确定）
export type HookSpec = InterceptorRuntimeHook | ObserverRuntimeHook

export type HookHandle<T extends HookTiming> = T extends InterceptorTiming
  ? (input: HookInput<T>, output: HookOutput<T>) => void | Promise<void>
  : T extends ObserverTiming
    ? (input: HookInput<T>) => void | Promise<void>
    : never

export interface RegisteredHookInfo {
  readonly name: string
  readonly timing: HookTiming
  readonly priority: number
  readonly enabled: boolean
}

export type HookPreset = 'none' | 'minimal' | 'default'

// ── Hook bucket 类型 ────────────────────────────────────────────────────────

export type HookBuckets = {
  [T in HookTiming]: RuntimeHook[]
}
