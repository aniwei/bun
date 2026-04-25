export type WatchEvent = 'change' | 'rename'
export type WatchListener = (event: WatchEvent, filename: string) => void

export interface WatchHandle {
  close(): void
}

type WatchMessage = {
  event: WatchEvent
  filename: string
  path: string
}

type BroadcastChannelLike = {
  close(): void
  onmessage: ((event: MessageEvent<WatchMessage>) => void) | null
  postMessage(message: WatchMessage): void
}

function getBroadcastChannelCtor():
  | (new (name: string) => BroadcastChannelLike)
  | null {
  if (typeof globalThis.BroadcastChannel !== 'function') {
    return null
  }

  return globalThis.BroadcastChannel as unknown as new (name: string) => BroadcastChannelLike
}

export class WatchBus {
  private readonly listeners = new Map<string, Set<WatchListener>>()
  private readonly channel: BroadcastChannelLike | null

  constructor(channelName = 'mars-web-vfs-watch') {
    const BroadcastChannelCtor = getBroadcastChannelCtor()
    this.channel = BroadcastChannelCtor ? new BroadcastChannelCtor(channelName) : null

    if (this.channel) {
      this.channel.onmessage = event => {
        const payload = event.data
        if (!payload) {
          return
        }
        this.notifyLocal(payload.path, payload.event, payload.filename)
      }
    }
  }

  subscribe(path: string, listener: WatchListener): WatchHandle {
    if (!this.listeners.has(path)) {
      this.listeners.set(path, new Set())
    }

    const set = this.listeners.get(path)!
    set.add(listener)

    return {
      close: () => {
        set.delete(listener)
        if (set.size === 0) {
          this.listeners.delete(path)
        }
      },
    }
  }

  emit(path: string, event: WatchEvent, filename: string): void {
    this.notifyLocal(path, event, filename)
    this.channel?.postMessage({ path, event, filename })
  }

  private notifyLocal(path: string, event: WatchEvent, filename: string): void {
    this.listeners.get(path)?.forEach(listener => {
      listener(event, filename)
    })
  }
}