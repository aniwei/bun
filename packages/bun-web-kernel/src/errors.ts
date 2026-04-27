export class MarsWebError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'MarsWebError'
    this.code = code
  }
}

export class KernelStateError extends MarsWebError {
  constructor(message: string) {
    super(message, 'ERR_BUN_WEB_KERNEL_STATE')
    this.name = 'KernelStateError'
  }
}

export class ProcessNotFoundError extends MarsWebError {
  constructor(pid: number) {
    super(`Process not found: ${pid}`, 'ERR_BUN_WEB_PROCESS_NOT_FOUND')
    this.name = 'ProcessNotFoundError'
  }
}

export class SyncSyscallUnavailableError extends MarsWebError {
  constructor() {
    super('Synchronous syscall is unavailable in async fallback mode', 'ERR_BUN_WEB_SYNC_UNAVAILABLE')
    this.name = 'SyncSyscallUnavailableError'
  }
}
