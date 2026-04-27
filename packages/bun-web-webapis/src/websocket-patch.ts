// VirtualWebSocket polyfill for Process Workers (RFC §8.3)
// In M4, this will be replaced by a full VirtualWebSocket that routes through
// the BroadcastChannel ↔ Kernel bridge.  For M2 we provide the *shape* of the
// class and a stub that clearly signals it needs M4.

export const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const

type ReadyState = (typeof WS_READY_STATE)[keyof typeof WS_READY_STATE]

const ERR_M4_REQUIRED =
  'VirtualWebSocket requires the bun-web-sw Service Worker bridge (available in M4). ' +
  'Use the native globalThis.WebSocket for external connections in the meantime.'

export class VirtualWebSocket extends EventTarget {
  readonly url: string
  readonly protocol: string = ''
  readonly bufferedAmount: number = 0
  readonly readyState: ReadyState = WS_READY_STATE.CONNECTING

  onopen: ((ev: Event) => unknown) | null = null
  onclose: ((ev: CloseEvent) => unknown) | null = null
  onmessage: ((ev: MessageEvent) => unknown) | null = null
  onerror: ((ev: Event) => unknown) | null = null

  static readonly CONNECTING = WS_READY_STATE.CONNECTING
  static readonly OPEN = WS_READY_STATE.OPEN
  static readonly CLOSING = WS_READY_STATE.CLOSING
  static readonly CLOSED = WS_READY_STATE.CLOSED

  constructor(url: string | URL, _protocols?: string | string[]) {
    super()
    this.url = String(url)
    // Immediately error — M4 bridge not yet available
    queueMicrotask(() => {
      const err = new Event('error')
      this.dispatchEvent(err)
      if (typeof this.onerror === 'function') this.onerror(err)
    })
  }

  send(_data: string | Blob | ArrayBufferView): void {
    throw new Error(ERR_M4_REQUIRED)
  }

  close(_code?: number, _reason?: string): void {
    // no-op: already closed/errored
  }
}

let _wsPolyfillInstalled = false

/**
 * Install VirtualWebSocket as globalThis.WebSocket in Process Workers.
 * Should only be called inside a worker context where the SW bridge is
 * available (M4+).  In M2 it installs the stub so shape is always present.
 */
export function installWebSocketPolyfill(): void {
  if (_wsPolyfillInstalled) return
  if (typeof globalThis.WebSocket === 'undefined') {
    ;(globalThis as Record<string, unknown>).WebSocket = VirtualWebSocket
    _wsPolyfillInstalled = true
  }
}

export function isWebSocketPolyfillInstalled(): boolean {
  return _wsPolyfillInstalled
}
