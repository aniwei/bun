import type { Pid, VirtualServer } from "./types"

export interface PortRecord {
  pid: Pid
  port: number
  server: VirtualServer
}

export class PortTable {
  readonly #ports = new Map<number, PortRecord>()

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
  }
}