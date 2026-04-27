type VirtualMessage = string | ArrayBuffer | Uint8Array

interface BridgeSocket {
  onMessage(data: VirtualMessage): void
  onClose(): void
}

export class VirtualWebSocketBridge {
  private channels = new Map<string, Set<BridgeSocket>>()

  join(channel: string, socket: BridgeSocket): void {
    const sockets = this.channels.get(channel) ?? new Set<BridgeSocket>()
    sockets.add(socket)
    this.channels.set(channel, sockets)
  }

  leave(channel: string, socket: BridgeSocket): void {
    const sockets = this.channels.get(channel)
    if (!sockets) return

    sockets.delete(socket)
    if (sockets.size === 0) {
      this.channels.delete(channel)
    }
  }

  publish(channel: string, sender: BridgeSocket, data: VirtualMessage): void {
    const sockets = this.channels.get(channel)
    if (!sockets) return

    for (const socket of sockets) {
      if (socket === sender) continue
      socket.onMessage(data)
    }
  }

  closeChannel(channel: string): void {
    const sockets = this.channels.get(channel)
    if (!sockets) return

    for (const socket of sockets) {
      socket.onClose()
    }
    this.channels.delete(channel)
  }
}

const globalBridge = new VirtualWebSocketBridge()

export class VirtualWebSocket extends EventTarget implements BridgeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = VirtualWebSocket.OPEN

  constructor(
    readonly url: string,
    private readonly bridge: VirtualWebSocketBridge = globalBridge,
  ) {
    super()
    this.bridge.join(url, this)
    queueMicrotask(() => {
      this.dispatchEvent(new Event('open'))
    })
  }

  send(data: VirtualMessage): void {
    if (this.readyState !== VirtualWebSocket.OPEN) {
      throw new Error('VirtualWebSocket is not open')
    }

    this.bridge.publish(this.url, this, data)
  }

  close(): void {
    if (this.readyState >= VirtualWebSocket.CLOSING) return

    this.readyState = VirtualWebSocket.CLOSING
    this.bridge.leave(this.url, this)
    this.readyState = VirtualWebSocket.CLOSED
    if (typeof CloseEvent === 'function') {
      this.dispatchEvent(new CloseEvent('close'))
      return
    }
    this.dispatchEvent(new Event('close'))
  }

  onMessage(data: VirtualMessage): void {
    if (this.readyState !== VirtualWebSocket.OPEN) return

    this.dispatchEvent(new MessageEvent('message', { data }))
  }

  onClose(): void {
    this.close()
  }
}

export function createVirtualWebSocket(url: string): VirtualWebSocket {
  return new VirtualWebSocket(url)
}
