import type { HMRChannel, HMRPayload } from "./types"

export class MemoryHMRChannel implements HMRChannel {
  readonly #listeners = new Set<(payload: HMRPayload) => void>()

  send(payload: HMRPayload): void {
    for (const listener of this.#listeners) {
      listener(payload)
    }
  }

  onMessage(listener: (payload: HMRPayload) => void) {
    this.#listeners.add(listener)

    return {
      dispose: () => {
        this.#listeners.delete(listener)
      },
    }
  }
}

export function createHMRChannel(): HMRChannel {
  return new MemoryHMRChannel()
}