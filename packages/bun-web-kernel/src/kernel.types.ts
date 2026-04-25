import type {
  ShellCommand,
  ShellCommandContext,
  ShellCommandRegisterHook,
  ShellCommandRegistry,
  ShellCommandResult,
} from '@mars/web-shell'
import type { InitializerTask } from '@mars/web-shared'
import type { Kernel } from './kernel'
import type { KernelServiceWorkerController } from './service-worker-controller'

export type Pid = number
export type Fd = number

export type KernelShellContext = ShellCommandContext

export type KernelShellResult = ShellCommandResult

export type KernelShellCommand = ShellCommand

export type KernelShellCommandRegistry = ShellCommandRegistry

export type KernelShellCommandHook = ShellCommandRegisterHook
export type KernelShellPlugin = KernelShellCommandHook

export interface KernelInitializerContext {
  kernel: Kernel
  serviceWorkerUrl: string
}

export type KernelServiceWorker = KernelServiceWorkerController

export type KernelModuleRequest = {
  requestId: string
  pathname: string
  method: string
  headers: Array<[string, string]>
}

export type KernelModuleResponse = {
  requestId: string
  status: number
  headers: Array<[string, string]>
  contentType?: string
  buffer?: ArrayBuffer
  error?: string
}

export type KernelModuleRequestHandler = (
  request: KernelModuleRequest,
) => Promise<KernelModuleResponse> | KernelModuleResponse

export type KernelInitializerTask = InitializerTask<KernelInitializerContext>

export type KernelBootHook = (payload: {
  kernel: Kernel
  serviceWorkerUrl: string
}) => void | Promise<void>

export type KernelServiceWorkerBeforeRegisterHook = (payload: {
  kernel: Kernel
  serviceWorkerUrl: string
}) => void | Promise<void>

export type KernelServiceWorkerRegisterHook = (payload: {
  kernel: Kernel
  serviceWorkerUrl: string
  registered: boolean
}) => void | Promise<void>

export interface KernelPortRegistration {
  host?: string
  protocol?: 'http' | 'https'
}

export interface KernelConfig {
  maxProcesses?: number
  sabSize?: number
  tunnelUrl?: string
  // Process-worker execution path. Kernel-owned command registry delegates
  // `bun` (and unknown command fallback) through this executor.
  processExecutor?: KernelProcessExecutor
  shellHooks?: KernelShellCommandHook[]
  initializers?: KernelInitializerTask[]
  bootHooks?: KernelBootHook[]
  moduleRequestHandler?: KernelModuleRequestHandler
  serviceWorkerBeforeRegisterHooks?: KernelServiceWorkerBeforeRegisterHook[]
  serviceWorkerRegisterHooks?: KernelServiceWorkerRegisterHook[]
}

export interface KernelProcessExecutionRequest {
  pid: Pid
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  registerPort?(port: number, registration?: KernelPortRegistration): void
  readMountedFile(path: string): string | Uint8Array | undefined
}

export interface KernelProcessExecutionResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type KernelProcessExecutor = (
  request: KernelProcessExecutionRequest,
) => Promise<KernelProcessExecutionResult> | KernelProcessExecutionResult

export interface ProcessDescriptor {
  pid: Pid
  cwd: string
  env: Record<string, string>
  argv: string[]
  stdio: {
    stdin: Fd
    stdout: Fd
    stderr: Fd
  }
  status: 'running' | 'exited' | 'zombie'
  exitCode: number | null
  port: MessagePort
}

export interface SpawnOptions {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
}

export type KernelMountFile = {
  path: string
  content: string | Uint8Array
}

export type KernelControlCommand =
  | {
      type: 'spawn'
      options: SpawnOptions
    }
  | {
      type: 'mount'
      files: KernelMountFile[]
    }
  | {
      type: 'kill'
      pid: Pid
      signal?: number
    }
  | {
      type: 'registerPort'
      pid: Pid
      port: number
      host?: string
      protocol?: 'http' | 'https'
    }
  | {
      type: 'unregisterPort'
      port: number
    }
  | {
      type: 'stdio'
      pid: Pid
      kind: 'stdout' | 'stderr'
      data: string
    }
  | {
      type: 'exit'
      pid: Pid
      code: number
    }
  | {
      type: 'executeProcess'
      pid: Pid
      argv: string[]
      cwd?: string
      env?: Record<string, string>
      stdin?: string
    }

export type KernelControlResult =
  | {
      ok: true
      type: 'spawn'
      process: ProcessDescriptor
    }
  | {
      ok: true
      type: 'mount'
      changedPaths: string[]
    }
  | {
      ok: true
      type: 'kill'
    }
  | {
      ok: true
      type: 'registerPort'
    }
  | {
      ok: true
      type: 'unregisterPort'
    }
  | {
      ok: true
      type: 'stdio'
    }
  | {
      ok: true
      type: 'exit'
    }
  | {
      ok: true
      type: 'executeProcess'
    }
