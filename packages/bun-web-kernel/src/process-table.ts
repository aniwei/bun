import type { Pid, ProcessDescriptor } from './kernel.types'

export class ProcessTable {
  private readonly table = new Map<Pid, ProcessDescriptor>()

  get(pid: Pid): ProcessDescriptor | undefined {
    return this.table.get(pid)
  }

  add(desc: ProcessDescriptor): void {
    this.table.set(desc.pid, desc)
  }

  remove(pid: Pid): void {
    this.table.delete(pid)
  }

  list(): ProcessDescriptor[] {
    return Array.from(this.table.values())
  }
}
