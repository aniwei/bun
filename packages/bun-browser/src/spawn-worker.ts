/**
 * T5.6.1 Spawn Worker 入口 — 每个 `bun_spawn` 请求在此独立 Worker 中获得自己的
 * WebAssembly Instance，实现进程隔离与独立 JSI handle 空间。
 *
 * 收到 `spawn:init` 消息后：
 *   1. 用传入的 module 创建全新的 `WasmRuntime`（独立线性内存 + JSI handle 空间）
 *   2. 按序加载父进程积累的 VFS 快照（COW 语义：子进程只读父进程 VFS 状态，
 *      写入仅在子进程内存中生效，不影响父进程）
 *   3. 应用 argv / env / cwd 进程状态
 *   4. 按 argv 路由执行：`bun run <path>` / `bun -e <code>` / 其他命令
 *   5. 执行完毕后 post `spawn:exit` 通知父 Worker（ProcessManager）
 *
 * stdout/stderr 通过 `spawn:stdout` / `spawn:stderr` 消息转发，不经过 fd_write 劫持
 * (那套留给主运行时)。
 *
 * **已实现**（T5.6.1 完整链路）:
 * - 子进程 VFS 包含父进程通过 `bun_vfs_load_snapshot` 加载的文件；
 * - 父进程脚本内 `Bun.write()` 等运行期写入的文件通过 `bun_vfs_dump_snapshot` 捕获并传入
 *   子进程（kernel-worker 在每次 spawn 前 dump live VFS 作为 extraSnapshots）。
 *
 * 注意：本文件只在 Worker 上下文中运行，不要引入任何主线程 API。
 */

import { createWasmRuntime } from './wasm'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const self: any

// ---------------------------------------------------------------------------
// Message types（内部 Worker↔ProcessManager 协议，不对外暴露）
// ---------------------------------------------------------------------------

/** ProcessManager → SpawnWorker：初始化并运行命令。 */
export interface SpawnInitMessage {
  type: 'spawn:init'
  /** 与父进程共享同一编译 Module，每个 Worker 独立 Instance。 */
  module: WebAssembly.Module
  /**
   * 父进程积累的 VFS 快照列表（按时间顺序）。子进程按序全部加载，
   * 以重建与父进程相同的文件系统状态（快照时间点）。
   */
  vfsSnapshots: ArrayBuffer[]
  /** 完整命令行参数，argv[0] = "bun"。 */
  argv: string[]
  /** 进程环境变量（可选）。 */
  env?: Record<string, string> | undefined
  /** 工作目录（可选，默认 "/"）。 */
  cwd?: string | undefined
}

/** SpawnWorker → ProcessManager：标准输出数据。 */
export interface SpawnStdoutMessage {
  type: 'spawn:stdout'
  data: string
}

/** SpawnWorker → ProcessManager：标准错误数据。 */
export interface SpawnStderrMessage {
  type: 'spawn:stderr'
  data: string
}

/** SpawnWorker → ProcessManager：运行时错误（对应 spawn:exit code=1）。 */
export interface SpawnErrorMessage {
  type: 'spawn:error'
  message: string
  stack?: string | undefined
}

/** SpawnWorker → ProcessManager：进程退出。 */
export interface SpawnExitMessage {
  type: 'spawn:exit'
  code: number
}

// ---------------------------------------------------------------------------
// Worker main loop
// ---------------------------------------------------------------------------

function postMsg(msg: SpawnStdoutMessage | SpawnStderrMessage | SpawnErrorMessage | SpawnExitMessage): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  self.postMessage(msg)
}

self.addEventListener('message', async (ev: MessageEvent<SpawnInitMessage>) => {
  const msg = ev.data
  if (msg.type !== 'spawn:init') return

  let exitCode = 0

  try {
    // ── 1. 创建独立 WasmRuntime ──────────────────────────────────────────
    const rt = await createWasmRuntime(msg.module, {
      onPrint: (data, kind) => {
        postMsg(kind === 'stderr' ? { type: 'spawn:stderr', data } : { type: 'spawn:stdout', data })
      },
    })

    // ── 2. 按序加载父进程 VFS 快照 ────────────────────────────────────────
    const loader = rt.instance.exports.bun_vfs_load_snapshot as ((ptr: number, len: number) => number) | undefined
    if (loader) {
      for (const snap of msg.vfsSnapshots) {
        rt.withBytes(new Uint8Array(snap), (ptr, len) => loader(ptr, len))
      }
    }

    // ── 3. 应用进程状态 ───────────────────────────────────────────────────
    const argv = msg.argv ?? ['bun']
    const env = msg.env ?? {}
    const cwd = msg.cwd ?? '/'

    const evalFn = rt.instance.exports.bun_browser_eval as
      | ((srcPtr: number, srcLen: number, filePtr: number, fileLen: number) => number)
      | undefined

    const applyState = (code: string, filename: string): void => {
      evalFn &&
        rt.withString(code, (srcPtr, srcLen) => {
          rt.withString(filename, (filePtr, fileLen) => {
            evalFn(srcPtr, srcLen, filePtr, fileLen)
          })
        })
    }

    applyState(
      `if (globalThis.process && typeof globalThis.process === "object") {` +
        `globalThis.process.argv = ${JSON.stringify(['bun', ...argv.slice(1)])};` +
        `globalThis.process.env = ${JSON.stringify(env)};` +
        `globalThis.__bun_cwd = ${JSON.stringify(cwd)};` +
        `}`,
      '<spawn:init>',
    )

    // ── 4. 运行命令 ───────────────────────────────────────────────────────
    // argv 格式：["bun", "run", "<entry>"] / ["bun", "-e", "<code>"] / other
    const sub = argv[1]

    if (sub === 'run' && argv[2]) {
      // bun run <entry>
      const runner = rt.instance.exports.bun_browser_run as ((entryPtr: number, entryLen: number) => number) | undefined
      if (!runner) throw new Error('bun_browser_run export missing')
      rt.withString(argv[2], (ptr, len) => {
        exitCode = runner(ptr, len)
      })
    } else if (sub === '-e' && argv[2]) {
      // bun -e <inline code>
      if (!evalFn) throw new Error('bun_browser_eval export missing')
      rt.withString(argv[2], (srcPtr, srcLen) => {
        rt.withString('<spawn:-e>', (filePtr, fileLen) => {
          exitCode = evalFn(srcPtr, srcLen, filePtr, fileLen)
        })
      })
    } else {
      // 其他子命令 → 尝试 bun_spawn（在子 instance 内继续降级处理）
      const spawnFn = rt.instance.exports.bun_spawn as ((cmdPtr: number, cmdLen: number) => number) | undefined
      if (spawnFn) {
        rt.withString(JSON.stringify(argv), (ptr, len) => {
          exitCode = spawnFn(ptr, len)
        })
      } else {
        postMsg({ type: 'spawn:stderr', data: `spawn: unknown subcommand "${sub ?? ''}\n` })
        exitCode = 127
      }
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    postMsg({ type: 'spawn:error', message: e.message, stack: e.stack })
    exitCode = 1
  }

  postMsg({ type: 'spawn:exit', code: exitCode })
})
