import type { MarsBridgeTransport } from "./endpoint"
import type { MarsMessage, MarsResponse } from "./protocol"

type BridgeEnvelope = MarsMessage | MarsResponse

type BridgeMessageListener = (event: MessageEvent<BridgeEnvelope>) => void

export interface MarsPostMessageTarget {
  postMessage(message: BridgeEnvelope, transfer?: Transferable[]): void
  addEventListener(
    type: "message",
    listener: BridgeMessageListener,
  ): void
  removeEventListener(
    type: "message",
    listener: BridgeMessageListener,
  ): void
  start?(): void
}

export function createMarsPostMessageBridgeTransport(
  target: MarsPostMessageTarget,
): MarsBridgeTransport {
  target.start?.()

  return {
    postMessage: (message, transfer) => {
      target.postMessage(message, transfer)
    },
    addEventListener: (type, listener) => {
      target.addEventListener(type, listener)
    },
    removeEventListener: (type, listener) => {
      target.removeEventListener(type, listener)
    },
  }
}
