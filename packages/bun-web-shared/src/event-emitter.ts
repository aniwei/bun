export type Events = {
  [event: string]: (...args: unknown[]) => void
}

export class TypedEventEmitter<T extends Events> {
  private readonly listenersMap: Partial<{ [K in keyof T]: Set<T[K]> }> = {}

  on<K extends keyof T>(event: K, listener: T[K]): this {
    let current = this.listenersMap[event] as Set<T[K]> | undefined
    if (!current) {
      current = new Set<T[K]>()
      this.listenersMap[event] = current
    }

    current.add(listener)
    return this
  }

  addListener<K extends keyof T>(event: K, listener: T[K]): this {
    return this.on(event, listener)
  }

  off<K extends keyof T>(event: K, listener: T[K]): this {
    this.listenersMap[event]?.delete(listener)
    return this
  }

  removeListener<K extends keyof T>(event: K, listener: T[K]): this {
    return this.off(event, listener)
  }

  emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): boolean {
    const current = this.listenersMap[event]
    if (!current || current.size === 0) {
      return false
    }

    for (const listener of current) {
      ;(listener as (...listenerArgs: Parameters<T[K]>) => void)(...args)
    }

    return true
  }

  once<K extends keyof T>(event: K, listener: T[K]): this {
    const onceListener = ((...args: Parameters<T[K]>) => {
      this.off(event, onceListener as T[K])
      ;(listener as (...listenerArgs: Parameters<T[K]>) => void)(...args)
    }) as T[K]

    return this.on(event, onceListener)
  }

  removeAllListeners<K extends keyof T>(event?: K): this {
    if (event !== undefined) {
      delete this.listenersMap[event]
      return this
    }

    for (const key of Object.keys(this.listenersMap) as Array<keyof T>) {
      delete this.listenersMap[key]
    }

    return this
  }

  listeners<K extends keyof T>(event: K): T[K][] {
    const current = this.listenersMap[event]
    if (!current) {
      return []
    }

    return Array.from(current)
  }

  listenerCount<K extends keyof T>(event: K): number {
    return this.listeners(event).length
  }
}
