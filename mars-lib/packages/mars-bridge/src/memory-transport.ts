import type { MarsBridgeTransport } from "./endpoint"
import type { MarsMessage, MarsResponse } from "./protocol"

export interface MarsMemoryBridgePair {
  left: MarsBridgeTransport
  right: MarsBridgeTransport
}

type BridgeEnvelope = MarsMessage | MarsResponse

type BridgeMessageListener = (event: MessageEvent<BridgeEnvelope>) => void

export function createMarsMemoryBridgePair(): MarsMemoryBridgePair {
  const left = new MemoryBridgeTransport()
  const right = new MemoryBridgeTransport()

  left.connect(right)
  right.connect(left)

  return { left, right }
}

class MemoryBridgeTransport implements MarsBridgeTransport {
  readonly #listeners = new Set<BridgeMessageListener>()
  #peer: MemoryBridgeTransport | null = null

  connect(peer: MemoryBridgeTransport): void {
    this.#peer = peer
  }

  postMessage(message: BridgeEnvelope): void {
    queueMicrotask(() => {
      this.#peer?.dispatch(message)
    })
  }

  addEventListener(type: "message", listener: BridgeMessageListener): void {
    if (type === "message") this.#listeners.add(listener)
  }

  removeEventListener(type: "message", listener: BridgeMessageListener): void {
    if (type === "message") this.#listeners.delete(listener)
  }

  dispatch(message: BridgeEnvelope): void {
    const event = new MessageEvent("message", { data: message })

    for (const listener of this.#listeners) listener(event)
  }
}
