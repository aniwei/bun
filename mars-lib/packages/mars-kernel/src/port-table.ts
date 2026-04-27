import type { Pid, VirtualServer } from "./types"

export interface PortRecord {
  pid: Pid
  port: number
  server: VirtualServer
}

export class PortTable {
  readonly #ports = new Map<number, PortRecord>()
  #nextEphemeralPort = 49_152

  allocate(preferredPort: number): number {
    if (preferredPort > 0) {
      if (this.#ports.has(preferredPort)) throw new Error(`Port already registered: ${preferredPort}`)
      return preferredPort
    }

    while (this.#ports.has(this.#nextEphemeralPort)) {
      this.#nextEphemeralPort += 1
    }

    return this.#nextEphemeralPort++
  }

  register(pid: Pid, port: number, server: VirtualServer): void {
    if (this.#ports.has(port)) throw new Error(`Port already registered: ${port}`)

    this.#ports.set(port, { pid, port, server })
  }

  unregister(port: number): void {
    this.#ports.delete(port)
  }

  resolve(port: number): Pid | null {
    return this.#ports.get(port)?.pid ?? null
  }

  get(port: number): PortRecord | null {
    return this.#ports.get(port) ?? null
  }

  list(): PortRecord[] {
    return [...this.#ports.values()]
  }

  clear(): void {
    this.#ports.clear()
    this.#nextEphemeralPort = 49_152
  }
}