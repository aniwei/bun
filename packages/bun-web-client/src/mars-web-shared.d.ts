declare module '@mars/web-shared' {
  export type Events = Record<string, (...args: any[]) => void>

  export class TypedEventEmitter<T extends Events = Events> {
    on<K extends keyof T>(event: K, listener: T[K]): this
    off<K extends keyof T>(event: K, listener: T[K]): this
    once<K extends keyof T>(event: K, listener: T[K]): this
    emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): boolean
  }

  export class Subscription<T extends Events = Events> extends TypedEventEmitter<T> {
    subscribe<K extends keyof T>(type: K, callback: T[K], once?: boolean): () => void
    publish(event: Partial<{ [K in keyof T]: Parameters<T[K]> }>): void
  }
}
