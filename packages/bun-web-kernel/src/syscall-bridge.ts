export const SYSCALL_OP = {
  FS_READ: 0x01,
  FS_WRITE: 0x02,
  FS_STAT: 0x03,
  FS_READDIR: 0x04,
  FS_MKDIR: 0x05,
  FS_UNLINK: 0x06,
  FS_RENAME: 0x07,
  FS_WATCH: 0x08,
  NET_CONNECT: 0x20,
  NET_LISTEN: 0x21,
  PROCESS_SPAWN: 0x30,
  PROCESS_WAIT: 0x31,
} as const

export type SyscallOp = (typeof SYSCALL_OP)[keyof typeof SYSCALL_OP]

export interface SyscallRequest {
  op: SyscallOp
  seq: number
  payload: Uint8Array
}

export interface SyscallResponse {
  seq: number
  ok: boolean
  payload: Uint8Array
  errorCode?: number
}

export class SyscallBridge {
  readonly isAsync: boolean

  constructor(private readonly sab: SharedArrayBuffer | null) {
    this.isAsync = sab == null || typeof Atomics.wait !== 'function'
  }

  callSync(op: SyscallOp, payload: Uint8Array): SyscallResponse {
    if (this.isAsync) {
      throw new Error('Synchronous syscall is unavailable in async fallback mode')
    }

    return {
      seq: 0,
      ok: true,
      payload: new Uint8Array([op, ...payload]),
    }
  }

  async callAsync(op: SyscallOp, payload: Uint8Array): Promise<SyscallResponse> {
    return {
      seq: 0,
      ok: true,
      payload: new Uint8Array([op, ...payload]),
    }
  }
}
