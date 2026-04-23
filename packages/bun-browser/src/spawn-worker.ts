/**
 * Spawn Worker 入口 — 每个 `bun_spawn` 请求在此独立 Worker 中获得自己的
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
 * **已实现**:
 * - 子进程 VFS 包含父进程通过 `bun_vfs_load_snapshot` 加载的文件；
 * - 父进程脚本内 `Bun.write()` 等运行期写入的文件通过 `bun_vfs_dump_snapshot` 捕获并传入
 *   子进程（kernel-worker 在每次 spawn 前 dump live VFS 作为 extraSnapshots）。
 *
 * 注意：本文件只在 Worker 上下文中运行，不要引入任何主线程 API。
 */

import { createWasmRuntime } from './wasm'
import { SabRingProducer, type SabRingHandle } from './sab-ring'

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
  /**
   * T5.12.2: stdout SAB ring 句柄（当 SharedArrayBuffer 可用时由 ProcessManager 提供）。
   * spawn-worker 向此 ring 写入 stdout 字节，而非 postMessage；消费者使用
   * `SabRingConsumer` 读取并在收到 `spawn:flush` 通知时 drain。
   * 未提供时退回传统 `spawn:stdout` postMessage 路径。
   */
  stdoutRing?: SabRingHandle | undefined
  /**
   * T5.12.2: stderr SAB ring 句柄（同 stdoutRing）。
   */
  stderrRing?: SabRingHandle | undefined
  /**
   * T5.12.3: 信号缓冲区 (SharedArrayBuffer | ArrayBuffer, Int32[0])。
   * 非零值表示已收到信号（15=SIGTERM, 9=SIGKILL, 2=SIGINT 等）。
   * ProcessManager.kill() 写入此 buffer；spawn-worker 在 WASM 执行间隙检查。
   */
  signalBuffer?: SharedArrayBuffer | ArrayBuffer | undefined
}

/** SpawnWorker → ProcessManager：标准输出数据（无 SAB ring 时的 postMessage 回退路径）。 */
export interface SpawnStdoutMessage {
  type: 'spawn:stdout'
  data: string
}

/** SpawnWorker → ProcessManager：标准错误数据（无 SAB ring 时的 postMessage 回退路径）。 */
export interface SpawnStderrMessage {
  type: 'spawn:stderr'
  data: string
}

/**
 * T5.12.2: SpawnWorker → ProcessManager：SAB ring 已写入新数据，请求消费者 drain。
 * 仅在 stdoutRing/stderrRing 存在时发送；消费者调用 SabRingConsumer.read() drain。
 */
export interface SpawnFlushMessage {
  type: 'spawn:flush'
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

function postMsg(msg: SpawnStdoutMessage | SpawnStderrMessage | SpawnFlushMessage | SpawnErrorMessage | SpawnExitMessage): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  self.postMessage(msg)
}

const _encoder = new TextEncoder()

self.addEventListener('message', async (ev: MessageEvent<SpawnInitMessage>) => {
  const msg = ev.data
  if (msg.type !== 'spawn:init') return

  let exitCode = 0

  // T5.12.2: 若 init 消息携带 SAB ring 句柄，使用 SabRingProducer 写 stdout/stderr。
  const stdoutProducer = msg.stdoutRing ? new SabRingProducer(msg.stdoutRing) : undefined
  const stderrProducer = msg.stderrRing ? new SabRingProducer(msg.stderrRing) : undefined
  // T5.12.3: 信号缓冲区（Int32Array[0]）：非零 = 已收到信号
  const signalView = msg.signalBuffer ? new Int32Array(msg.signalBuffer) : undefined

  /** 检查信号缓冲区，若已收到非零信号则抛出特殊错误触发提前退出。 */
  function checkSignal(): void {
    if (!signalView) return
    const sig = Atomics.load(signalView, 0)
    if (sig !== 0) throw Object.assign(new Error(`signal:${sig}`), { __signal: sig })
  }

  try {
    // ── 1. 创建独立 WasmRuntime ──────────────────────────────────────────
    const rt = await createWasmRuntime(msg.module, {
      onPrint: (data, kind) => {
        const bytes = _encoder.encode(data)
        if (kind === 'stderr') {
          if (stderrProducer) {
            // SAB ring 路径：写入环形缓冲，发送 flush 通知
            stderrProducer.write(bytes)
            postMsg({ type: 'spawn:flush' })
          } else {
            postMsg({ type: 'spawn:stderr', data })
          }
        } else {
          if (stdoutProducer) {
            stdoutProducer.write(bytes)
            postMsg({ type: 'spawn:flush' })
          } else {
            postMsg({ type: 'spawn:stdout', data })
          }
        }
      },
    })

    // ── 2. 按序加载父进程 VFS 快照 ────────────────────────────────────────
    const loader = rt.instance.exports.bun_vfs_load_snapshot as ((ptr: number, len: number) => number) | undefined
    if (loader) {
      for (const snap of msg.vfsSnapshots) {
        checkSignal()
        rt.withBytes(new Uint8Array(snap), (ptr, len) => loader(ptr, len))
      }
    }

    // ── 3. 应用进程状态 ───────────────────────────────────────────────────
    checkSignal()
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
    checkSignal()
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
    // T5.12.3: 信号触发的受控退出，不作为错误上报
    const sig = (e as { __signal?: number }).__signal
    if (sig !== undefined) {
      exitCode = 128 + sig // 遵循 POSIX：kill 信号退出码 = 128 + signal
    } else {
      postMsg({ type: 'spawn:error', message: e.message, stack: e.stack })
      exitCode = 1
    }
  } finally {
    // T5.12.2: 关闭 SAB ring，通知消费者此端已关闭（drain 循环终止条件）
    stdoutProducer?.close()
    stderrProducer?.close()
  }

  postMsg({ type: 'spawn:exit', code: exitCode })
})
