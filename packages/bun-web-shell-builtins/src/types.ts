export type FileNode = {
  kind: 'file'
  content: string
}

export type DirectoryNode = {
  kind: 'dir'
  children: Record<string, FSNode>
}

export type FSNode = FileNode | DirectoryNode

export interface BuiltinFS {
  readFile(path: string): string
  listDir(path: string): string[]
  isDirectory(path: string): boolean
  walk(path: string): string[]
}

export interface BuiltinContext {
  cwd: string
  stdin: string
  env: Record<string, string>
  setCwd(next: string): void
  fs?: BuiltinFS
}

export interface BuiltinResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type BuiltinCommand = (
  args: string[],
  context: BuiltinContext,
) => BuiltinResult

export interface ShellCommandRegistry {
  register(name: string, command: BuiltinCommand): void
  unregister(name: string): boolean
  has(name: string): boolean
  tryExecute(name: string, args: string[], context: BuiltinContext): BuiltinResult | null
  execute(name: string, args: string[], context: BuiltinContext): BuiltinResult
}

export type ShellCommandRegisterHook = (registry: ShellCommandRegistry) => void
