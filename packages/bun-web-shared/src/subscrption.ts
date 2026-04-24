import { TypedEventEmitter } from '../event-emitter'
import type { Events } from '../event-emitter'

type UnSubscribe = () => void
type SubscribeEvent = Events

export class Subscription<T extends SubscribeEvent = SubscribeEvent> extends TypedEventEmitter<T> {
  publish(event: Record<string, unknown[]>): void {
    const emit = (type: string, ...args: unknown[]) =>
      (this.emit as unknown as (event: string, ...args: unknown[]) => void)(type, ...args)
    for (const [type, args] of Object.entries(event)) {
      emit(type, ...args)
      emit('*', type, ...args)
    }
  }

  subscribe<K extends keyof T>(type: K, callback: T[K], once: boolean = false): UnSubscribe {
    return once ? this.once(type, callback) : this.on(type, callback)
  }

  subscribeAll(callback: (...args: unknown[]) => void): UnSubscribe {
    return this.subscribe('*', callback as unknown as T[keyof T])
  }
}
