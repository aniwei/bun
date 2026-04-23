/**
 *
 * 提供与 `@webcontainer/api ^1.x` 形状对齐的 `WebContainer` 工厂类，
 * 内部包装 bun-browser `Kernel`，使现有 WebContainer 应用
 * 只需修改 3–5 行 import 即可切换到 bun-browser。
 *
 * ## 快速迁移
 *
 * ```diff
 * - import { WebContainer } from '@webcontainer/api'
 * + import { WebContainer } from 'bun-browser/webcontainer'
 * ```
 *
 * `WebContainer.boot(options)` 接受与原版相同的 `options`，以
 * `wasmModule` 取代原版的 `coep`/`coop` 头配置。
 */

import {
  Kernel,
  ProcessHandle,
  type KernelOptions,
  type KernelPortEvent,
  type KernelPreviewMessageEvent,
  type ServiceWorkerOptions,
} from './kernel'
import type { FileSystemTree } from './vfs-client'
import type { FsDirEntry, FsStatInfo } from './protocol'

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** `WebContainer.boot()` 的配置选项（对齐 @webcontainer/api `BootOptions`）。 */
export interface WebContainerBootOptions extends Omit<KernelOptions, 'workerUrl'> {
  /**
   * kernel-worker.ts（或打包产物）的 URL。
   *
   * 省略时自动从 `import.meta.url` 相对解析。
   */
  workerUrl?: string | URL | undefined
  /**
   * ServiceWorker 预览桥接配置（可选）。
   *
   * 提供后 `WebContainer.boot()` 会自动调用 `kernel.attachServiceWorker()`
   * 将 WASM Bun.serve 的 HTTP 响应路由到 `/__bun_preview__/` 路径。
   */
  serviceWorker?: ServiceWorkerOptions | undefined
}

/** 进程句柄别名（对齐 @webcontainer/api `WebContainerProcess`）。 */
export type WebContainerProcess = ProcessHandle

/** 文件系统 API（对齐 @webcontainer/api `FileSystemAPI`）。 */
export interface FileSystemAPI {
  readFile(path: string): Promise<ArrayBuffer>
  readFile(path: string, encoding: 'utf-8' | 'utf8'): Promise<string>
  readdir(path: string): Promise<FsDirEntry[]>
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>
  stat(path: string): Promise<FsStatInfo>
}

// ---------------------------------------------------------------------------
// WebContainer
// ---------------------------------------------------------------------------

/**
 * WebContainer-compatible API surface backed by bun-browser `Kernel`.
 *
 * 完整 API shape 对标 `@webcontainer/api ^1.x`。
 *
 * @example
 * ```ts
 * import { WebContainer } from 'bun-browser/webcontainer-compat'
 *
 * const wc = await WebContainer.boot({ wasmModule })
 * await wc.mount({ 'index.ts': { file: { contents: 'console.log("hi")' } } })
 * const p = await wc.spawn('bun', ['run', 'index.ts'])
 * p.output.pipeTo(new WritableStream({ write: chunk => process.stdout.write(chunk) }))
 * const code = await p.exit
 * ```
 */
export class WebContainer {
  /** 底层 Kernel 实例（需直接访问时使用）。 */
  readonly kernel: Kernel

  private constructor(kernel: Kernel) {
    this.kernel = kernel
  }

  // ---------------------------------------------------------------------------
  // 工厂
  // ---------------------------------------------------------------------------

  /**
   * 启动 bun-browser 内核，返回可用的 `WebContainer` 实例。
   *
   * 对齐 `@webcontainer/api WebContainer.boot(options)`。
   */
  static async boot(options: WebContainerBootOptions): Promise<WebContainer> {
    const { serviceWorker, ...kernelOptions } = options
    const workerUrl = kernelOptions.workerUrl ?? new URL('./kernel-worker.ts', import.meta.url)
    const kernel = new Kernel({ ...kernelOptions, workerUrl })
    await kernel.whenReady()
    if (serviceWorker) {
      await kernel.attachServiceWorker(serviceWorker)
    }
    return new WebContainer(kernel)
  }

  // ---------------------------------------------------------------------------
  // 文件系统
  // ---------------------------------------------------------------------------

  /** 文件系统 API（对齐 `@webcontainer/api FileSystemAPI`）。 */
  get fs(): FileSystemAPI {
    const k = this.kernel
    const readFile: FileSystemAPI['readFile'] = ((path: string, encoding?: 'utf-8' | 'utf8') => {
      if (encoding === 'utf-8' || encoding === 'utf8') {
        return k.readFile(path, 'utf8')
      }
      return k.readFile(path)
    }) as FileSystemAPI['readFile']

    return {
      readFile,
      readdir: (path: string) => k.readdir(path),
      writeFile: (path: string, data: string | Uint8Array) => k.writeFile(path, data),
      mkdir: (path: string, opts?: { recursive?: boolean }) => k.mkdir(path, opts),
      rm: (path: string, opts?: { recursive?: boolean }) => k.rm(path, opts),
      rename: (from: string, to: string) => k.rename(from, to),
      stat: (path: string) => k.stat(path),
    }
  }

  // ---------------------------------------------------------------------------
  // 文件树挂载
  // ---------------------------------------------------------------------------

  /**
   * 挂载 WebContainer `FileSystemTree` 格式的文件树到 VFS。
   *
   * 对齐 `@webcontainer/api WebContainer.mount(tree, options)`。
   */
  async mount(tree: FileSystemTree, options?: { mountPoint?: string }): Promise<void> {
    return this.kernel.mount(tree, options?.mountPoint)
  }

  /**
   * 将 VFS（或指定子路径）导出为 `FileSystemTree`。
   *
   * （@webcontainer/api 无此方法，bun-browser 扩展 API。）
   */
  async export(path = '/'): Promise<FileSystemTree> {
    return this.kernel.exportFs(path)
  }

  // ---------------------------------------------------------------------------
  // 进程
  // ---------------------------------------------------------------------------

  /**
   * 在 bun WASM 内核中执行命令，返回进程句柄。
   *
   * 对齐 `@webcontainer/api WebContainer.spawn(command, args?, options?)`。
   *
   * @example
   * ```ts
   * const p = await wc.spawn('bun', ['run', 'index.ts'])
   * p.output.pipeTo(new WritableStream({ write: chunk => console.log(chunk) }))
   * const code = await p.exit
   * ```
   */
  async spawn(
    command: string,
    args: string[] = [],
    options?: { env?: Record<string, string>; cwd?: string },
  ): Promise<WebContainerProcess> {
    return this.kernel.process([command, ...args], options)
  }

  // ---------------------------------------------------------------------------
  // 事件
  // ---------------------------------------------------------------------------

  on(event: 'port', listener: (ev: KernelPortEvent) => void): void
  on(event: 'server-ready', listener: (ev: KernelPortEvent) => void): void
  on(event: 'preview-message', listener: (ev: KernelPreviewMessageEvent) => void): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (ev: any) => void): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.kernel.on(event as any, listener)
  }

  off(event: 'port', listener: (ev: KernelPortEvent) => void): void
  off(event: 'server-ready', listener: (ev: KernelPortEvent) => void): void
  off(event: 'preview-message', listener: (ev: KernelPreviewMessageEvent) => void): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, listener: (ev: any) => void): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.kernel.off(event as any, listener)
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  /**
   * 销毁内核 Worker，释放资源。
   *
   * 对齐 `@webcontainer/api WebContainer.teardown()`。
   */
  teardown(): void {
    this.kernel.terminate()
  }
}
