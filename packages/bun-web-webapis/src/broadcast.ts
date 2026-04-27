// BroadcastChannel cross-Worker routing polyfill (RFC §8.3)
// In the browser runtime, globalThis.BroadcastChannel is already available.
// This module re-exports it for explicit import in Process Workers and adds a
// thin wrapper that:
//   1. Provides the same interface as native BroadcastChannel
//   2. Tracks active channels per-origin for debuggability
//   3. Handles the case where BroadcastChannel is unavailable (Node.js env)

const _channels = new Map<string, Set<BroadcastChannelShim>>()

class BroadcastChannelShim extends EventTarget {
  readonly name: string

  onmessage: ((ev: MessageEvent) => unknown) | null = null
  onmessageerror: ((ev: MessageEvent) => unknown) | null = null

  constructor(name: string) {
    super()
    this.name = name
    let group = _channels.get(name)
    if (!group) {
      group = new Set()
      _channels.set(name, group)
    }
    group.add(this)
  }

  postMessage(message: unknown): void {
    const group = _channels.get(this.name)
    if (!group) return
    for (const ch of group) {
      if (ch === this) continue
      const ev = new MessageEvent('message', { data: message })
      ch.dispatchEvent(ev)
      if (typeof ch.onmessage === 'function') ch.onmessage(ev)
    }
  }

  close(): void {
    const group = _channels.get(this.name)
    if (group) {
      group.delete(this)
      if (group.size === 0) _channels.delete(this.name)
    }
  }
}

// Use native BroadcastChannel if available, otherwise fallback to shim
export const BroadcastChannelImpl: typeof BroadcastChannel =
  typeof globalThis.BroadcastChannel !== 'undefined'
    ? globalThis.BroadcastChannel
    : (BroadcastChannelShim as unknown as typeof BroadcastChannel)

export function installBroadcastChannel(): void {
  if (typeof globalThis.BroadcastChannel === 'undefined') {
    ;(globalThis as Record<string, unknown>).BroadcastChannel = BroadcastChannelShim
  }
}
