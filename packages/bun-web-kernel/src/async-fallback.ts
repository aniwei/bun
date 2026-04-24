import { SyscallBridge } from './syscall-bridge'

export type BridgeCapability = {
  hasSharedArrayBuffer: boolean
  hasAtomicsWait: boolean
}

export function getBridgeCapability(): BridgeCapability {
  return {
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hasAtomicsWait: typeof Atomics.wait === 'function',
  }
}

export function supportsSyncSyscall(capability: BridgeCapability): boolean {
  return capability.hasSharedArrayBuffer && capability.hasAtomicsWait
}

export function detectSABSupport(): boolean {
  return supportsSyncSyscall(getBridgeCapability())
}

export function createBridgeWithCapability(capability: BridgeCapability): SyscallBridge {
  if (supportsSyncSyscall(capability)) {
    return new SyscallBridge(new SharedArrayBuffer(1024))
  }

  return new SyscallBridge(null)
}

export function createBridge(port: MessagePort): SyscallBridge {
  void port
  return createBridgeWithCapability(getBridgeCapability())
}
