import type { Kernel, KernelModuleRequestHandler, KernelProcessExecutor } from '@mars/web-kernel'

export type BunContainerWorkerScriptDescriptor = {
  source: string
  specifier?: string
  packageName?: string
  packageType?: 'module' | 'commonjs'
  /**
   * 优先级最高：
   * - 'esm' / 'cjs' 直接覆盖扩展名与 packageType 推断
   * - 'auto' 时按扩展名(.mjs/.mts/.cjs/.cts) -> packageType -> packageName -> esm 默认值
   */
  moduleFormat?: 'auto' | 'esm' | 'cjs'
}

export type BunContainerWorkerScriptRecord = string | BunContainerWorkerScriptDescriptor

export type BunContainerWorkerScriptProcessor = {
  /**
   * 仅在命中 serviceWorkerScripts 的 pathname 时触发。
   * 未提供 processor 时，SW 将返回原始 source（包括 CJS 原文）。
   */
  process(input: {
    pathname: string
    descriptor: BunContainerWorkerScriptDescriptor
    detectedModuleType: 'esm' | 'cjs'
  }):
    | { source: string; contentType?: string }
    | Promise<{ source: string; contentType?: string }>
}

// ── 文件树 ────────────────────────────────────────────────────────────────────

/** VFS 文件树：路径 → 文件内容（字符串、二进制或嵌套目录） */
export interface FileTree {
  [path: string]: string | Uint8Array | FileTree
}

// ── spawn 选项 ─────────────────────────────────────────────────────────────────

export interface SpawnOpts {
  /** 工作目录（默认 '/'） */
  cwd?: string
  /** 环境变量（合并到容器默认 env） */
  env?: Record<string, string>
  /** 命令行参数（包含命令本身） */
  argv: string[]
}

// ── 进程句柄 ───────────────────────────────────────────────────────────────────

export interface ContainerProcess {
  readonly pid: number
  /** 对齐 WebContainer/Bun 风格的标准输出流 */
  readonly output: ReadableStream<Uint8Array>
  /** 等待进程退出，返回退出码 */
  waitForExit(): Promise<number>
  /** 对齐 WebContainer/Bun 风格的退出 promise */
  readonly exited: Promise<number>
  /** 向进程写入 stdin */
  write(data: string | Uint8Array): void
  /** 对齐 WebContainer/Bun 风格的输入流 */
  readonly input: WritableStream<Uint8Array>
  /** 终止进程 */
  kill(signal?: number): void
  /** 进程 stdout（只读流） */
  readonly stdout: ReadableStream<Uint8Array>
  /** 进程 stderr（只读流） */
  readonly stderr: ReadableStream<Uint8Array>
}

// ── 终端句柄 ───────────────────────────────────────────────────────────────────

export interface TerminalHandle {
  /** 将终端附加到 DOM 容器（依赖 xterm.js 但此处类型解耦） */
  attach(container: HTMLElement): void
  /** 写入终端输出 */
  write(data: string): void
  /** 关闭终端 */
  dispose(): void
}

// ── 事件类型 ───────────────────────────────────────────────────────────────────

export interface ServerReadyEvent {
  url: string
  host: string
  port: number
  protocol: 'http' | 'https'
}

export interface ProcessExitEvent {
  pid: number
  exitCode: number
}

export interface FileChangeEvent {
  path: string
  type: 'create' | 'modify' | 'delete'
}

// ── 容器事件映射 ───────────────────────────────────────────────────────────────

export interface ContainerEventMap {
  'server-ready': ServerReadyEvent
  'process-exit': ProcessExitEvent
  filechange: FileChangeEvent
}

export type ContainerEventName = keyof ContainerEventMap

// ── 容器状态 ───────────────────────────────────────────────────────────────────

export type ContainerStatus = 'booting' | 'ready' | 'error' | 'disposed'

// ── Boot 选项 ─────────────────────────────────────────────────────────────────

export interface BunContainerBootOptions {
  /** 可选 TCP/TLS 隧道地址（RFC §5.4） */
  tunnelUrl?: string
  /** 是否自动注入 COOP/COEP 头 */
  coopCoepHeaders?: boolean
  /** Worker 类型 */
  workerType?: 'shared' | 'dedicated'
  /** 初始文件树（启动时挂载） */
  files?: FileTree
  /** 容器 ID（唯一标识，用于 devtools 等） */
  id?: string
  /** 自定义 Worker 入口 URL */
  workerUrl?: string
  /** 容器 scope（用于多实例隔离） */
  scope?: string
  /** 可选执行器注入（用于 runtime 接管 executeProcess） */
  processExecutor?: KernelProcessExecutor
  /** 选择执行哪些 kernel 初始化器（默认 'all'） */
  initializers?: 'all' | string[]
  /** 主线程注册 Service Worker 的脚本 URL（默认使用 @mars/web-sw 提供的地址，兜底 '/sw.js'） */
  serviceWorkerUrl?: string
  /** 主线程注册 Service Worker 时透传给 register() 的选项 */
  serviceWorkerRegisterOptions?: RegistrationOptions
  /** 覆盖默认的 serve handler 解析器（默认读取 @mars/web-runtime serve registry） */
  serveHandlerRegistry?: {
    getHandler(port: number): ((request: Request) => Promise<Response> | Response) | null
  }
  /** 模块命名空间请求处理器（对应 /__bun__/modules/*） */
  moduleRequestHandler?: KernelModuleRequestHandler
  /**
   * 可选：SW 拦截返回的 worker 脚本表（key 必须是绝对 pathname）。
   * 例如："/__bun__/worker/bun-process.js"、"/__bun__/worker/pkg.js"。
   */
  serviceWorkerScripts?:
    | Map<string, BunContainerWorkerScriptRecord>
    | Record<string, BunContainerWorkerScriptRecord>
  /**
   * 可选：SW worker 脚本处理器（常用于 CJS -> ESM 转译）。
   * 缺省时走原文返回策略，不会自动转译。
   */
  serviceWorkerScriptProcessor?: BunContainerWorkerScriptProcessor
  /** 插件 hook 回调（由 kernel 在启动阶段发布） */
  hooks?: {
    boot?: Array<(payload: { kernel: Kernel; serviceWorkerUrl: string }) => void | Promise<void>>
    serviceWorkerBeforeRegister?: Array<(
      payload: { kernel: Kernel; serviceWorkerUrl: string }
    ) => void | Promise<void>>
    serviceWorkerRegister?: Array<(
      payload: { kernel: Kernel; serviceWorkerUrl: string; registered: boolean }
    ) => void | Promise<void>>
  }
}

export type BunContainerOptions = BunContainerBootOptions
