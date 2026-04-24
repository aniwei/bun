export class BunWebError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'BunWebError'
    this.code = code
  }
}

export class KernelStateError extends BunWebError {
  constructor(message: string) {
    super(message, 'ERR_BUN_WEB_KERNEL_STATE')
    this.name = 'KernelStateError'
  }
}

export class ProcessNotFoundError extends BunWebError {
  constructor(pid: number) {
    super(`Process not found: ${pid}`, 'ERR_BUN_WEB_PROCESS_NOT_FOUND')
    this.name = 'ProcessNotFoundError'
  }
}
