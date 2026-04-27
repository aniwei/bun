export type Pid = number
export type Fd = number

export interface KernelConfig {
  maxProcesses?: number
  sabSize?: number
  asyncFallback?: boolean
  tunnelUrl?: string
}

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
