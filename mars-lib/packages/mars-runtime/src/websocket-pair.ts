import type { WebSocketHandlerOptions } from "./types"

export interface MarsServerWebSocket<T = undefined> {
  readonly data: T
  readonly readyState: 0 | 1 | 2 | 3
  send(message: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

export interface MarsWebSocketPair<T = undefined> {
  serverWs: MarsServerWebSocket<T>
  clientWs: MarsClientWebSocket
}

export class MarsClientWebSocket extends EventTarget {
  static readonly CONNECTING = 0 as const
  static readonly OPEN = 1 as const
  static readonly CLOSING = 2 as const
  static readonly CLOSED = 3 as const

  readonly CONNECTING = 0 as const
  readonly OPEN = 1 as const
  readonly CLOSING = 2 as const
  readonly CLOSED = 3 as const

  readonly url: string
  readonly protocol = ""
  readonly extensions = ""

  #readyState: 0 | 1 | 2 | 3 = 0
  #serverRef: MarsServerWebSocketImpl<unknown> | null = null

  onopen: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string | URL, _protocols?: string | string[]) {
    super()
    this.url = url instanceof URL ? url.toString() : url
  }

  get readyState(): 0 | 1 | 2 | 3 {
    return this.#readyState
  }

  /** @internal Called by the pair factory to wire up the connection. */
  _connect(serverWs: MarsServerWebSocketImpl<unknown>): void {
    this.#serverRef = serverWs
    this.#readyState = 1
  }

  /** @internal Invoked by the server when it sends a message to the client. */
  _receiveMessage(data: string | Uint8Array): void {
    if (this.#readyState !== 1) return

    const event = new MessageEvent("message", { data })
    this.onmessage?.(event)
    this.dispatchEvent(event)
  }

  /** @internal Invoked by the server when it closes the connection. */
  _receiveClose(code: number, reason: string): void {
    if (this.#readyState >= 2) return

    this.#readyState = 3
    const event = new CloseEvent("close", { code, reason, wasClean: true })
    this.onclose?.(event)
    this.dispatchEvent(event)
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.#readyState !== 1) return

    this.#serverRef?._receiveClientMessage(data as string | Uint8Array)
  }

  close(code = 1000, reason = ""): void {
    if (this.#readyState >= 2) return

    this.#readyState = 2
    this.#serverRef?._receiveClientClose(code, reason)
    this.#readyState = 3

    const event = new CloseEvent("close", { code, reason, wasClean: true })
    this.onclose?.(event)
    this.dispatchEvent(event)
  }
}

export class MarsServerWebSocketImpl<T> implements MarsServerWebSocket<T> {
  readonly data: T
  #readyState: 0 | 1 | 2 | 3 = 0
  #clientRef: MarsClientWebSocket | null = null
  #onMessageListeners = new Set<(msg: string | Uint8Array) => void>()
  #onCloseListeners = new Set<(code: number, reason: string) => void>()

  constructor(data: T) {
    this.data = data
  }

  get readyState(): 0 | 1 | 2 | 3 {
    return this.#readyState
  }

  /** @internal Called by the pair factory. */
  _connect(clientWs: MarsClientWebSocket): void {
    this.#clientRef = clientWs
    this.#readyState = 1
  }

  /** @internal Called by client.send() */
  _receiveClientMessage(message: string | Uint8Array): void {
    for (const listener of this.#onMessageListeners) {
      listener(message)
    }
  }

  /** @internal Called by client.close() */
  _receiveClientClose(code: number, reason: string): void {
    for (const listener of this.#onCloseListeners) {
      listener(code, reason)
    }
  }

  onClientMessage(listener: (msg: string | Uint8Array) => void): void {
    this.#onMessageListeners.add(listener)
  }

  onClientClose(listener: (code: number, reason: string) => void): void {
    this.#onCloseListeners.add(listener)
  }

  send(message: string | Uint8Array): void {
    if (this.#readyState !== 1) return

    this.#clientRef?._receiveMessage(message)
  }

  close(code = 1000, reason = ""): void {
    if (this.#readyState >= 2) return

    this.#readyState = 2
    this.#clientRef?._receiveClose(code, reason)
    this.#readyState = 3
  }
}

export function createWebSocketPair<T = undefined>(data: T): MarsWebSocketPair<T> {
  const serverWs = new MarsServerWebSocketImpl<T>(data)
  const clientWs = new MarsClientWebSocket("ws://mars.localhost/")

  serverWs._connect(clientWs)
  clientWs._connect(serverWs as MarsServerWebSocketImpl<unknown>)

  return { serverWs, clientWs }
}

export function upgradeToWebSocket<T = undefined>(
  options: WebSocketHandlerOptions<T> | undefined,
  data: T,
): MarsClientWebSocket | null {
  if (!options) return null

  const { serverWs, clientWs } = createWebSocketPair<T>(data)
  const impl = serverWs as MarsServerWebSocketImpl<T>

  options.open?.(serverWs)

  impl.onClientMessage(msg => {
    options.message?.(serverWs, msg)
  })

  impl.onClientClose((code, reason) => {
    options.close?.(serverWs, code, reason)
  })

  return clientWs
}

