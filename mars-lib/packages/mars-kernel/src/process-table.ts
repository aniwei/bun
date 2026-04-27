import type { Pid, ProcessDescriptor, ProcessStatus, SpawnOptions } from "./types"

export class ProcessTable {
  readonly #processes = new Map<Pid, ProcessDescriptor>()
  #nextPid = 1

  create(options: SpawnOptions, ppid = 0): ProcessDescriptor {
    const pid = this.#nextPid++
    const descriptor: ProcessDescriptor = {
      pid,
      ppid,
      cwd: options.cwd ?? "/workspace",
      env: options.env ?? {},
      argv: options.argv,
      status: "starting",
      exitCode: null,
      startedAt: Date.now(),
    }

    this.#processes.set(pid, descriptor)
    return descriptor
  }

  get(pid: Pid): ProcessDescriptor | null {
    return this.#processes.get(pid) ?? null
  }

  update(pid: Pid, changes: Partial<ProcessDescriptor>): ProcessDescriptor {
    const descriptor = this.#processes.get(pid)
    if (!descriptor) throw new Error(`Unknown pid: ${pid}`)

    Object.assign(descriptor, changes)
    return descriptor
  }

  setStatus(pid: Pid, status: ProcessStatus, exitCode: number | null = null): void {
    this.update(pid, {
      status,
      exitCode,
      ...(status === "exited" || status === "killed" ? { exitedAt: Date.now() } : {}),
    })
  }

  list(): ProcessDescriptor[] {
    return [...this.#processes.values()].map(process => ({ ...process }))
  }

  clear(): void {
    this.#processes.clear()
  }
}