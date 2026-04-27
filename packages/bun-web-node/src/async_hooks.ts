export interface Hook {
  enable(): Hook
  disable(): Hook
}

let activeHook = false

export function createHook(): Hook {
  return {
    enable() {
      activeHook = true
      return this
    },
    disable() {
      activeHook = false
      return this
    },
  }
}

export function executionAsyncId(): number {
  return activeHook ? 1 : 0
}

export function triggerAsyncId(): number {
  return activeHook ? 1 : 0
}

export class AsyncResource {
  constructor(readonly type: string) {}

  runInAsyncScope<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
    thisArg: unknown,
    ...args: TArgs
  ): TResult {
    return fn.apply(thisArg, args)
  }

  emitDestroy(): void {}
}

export class AsyncLocalStorage<T> {
  private store: T | undefined
  private enabled = true

  disable(): void {
    this.enabled = false
    this.store = undefined
  }

  enterWith(store: T): void {
    if (!this.enabled) return
    this.store = store
  }

  run<TResult, TArgs extends unknown[]>(store: T, callback: (...args: TArgs) => TResult, ...args: TArgs): TResult {
    if (!this.enabled) {
      return callback(...args)
    }

    const previous = this.store
    this.store = store
    try {
      return callback(...args)
    } finally {
      this.store = previous
    }
  }

  exit<TResult, TArgs extends unknown[]>(callback: (...args: TArgs) => TResult, ...args: TArgs): TResult {
    const previous = this.store
    this.store = undefined
    try {
      return callback(...args)
    } finally {
      this.store = previous
    }
  }

  getStore(): T | undefined {
    return this.store
  }

  bind<TFn extends (...args: any[]) => any>(fn: TFn): TFn {
    const captured = this.store
    return ((...args: unknown[]) => {
      const previous = this.store
      this.store = captured
      try {
        return fn(...args)
      } finally {
        this.store = previous
      }
    }) as TFn
  }
}
