import { SyscallBridge } from './syscall-bridge'

export function detectSABSupport(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && typeof Atomics.wait === 'function'
}

export function createBridge(port: MessagePort): SyscallBridge {
  void port

  if (detectSABSupport()) {
    return new SyscallBridge(new SharedArrayBuffer(1024))
  }

  return new SyscallBridge(null)
}
