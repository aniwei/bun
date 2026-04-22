/**
 * Kernel worker 入口 —— 在专用 Web Worker 里拉起 bun-core.wasm + JSI Host。
 *
 * 注意：此文件假定运行在 Web Worker 上下文（`self` 为 `DedicatedWorkerGlobalScope`）。
 * 浏览器端需通过 `new Worker(new URL("./kernel-worker.ts", import.meta.url), { type: "module" })` 加载。
 */

import { PROTOCOL_VERSION, type HostRequest, type KernelEvent, type FsDirEntry } from './protocol'
import { createWasmRuntime, type WasmRuntime } from './wasm'
import { buildSnapshot, parseSnapshot } from './vfs-client'
import { detectThreadCapability, createSharedMemory } from './thread-capability'
import { ThreadPool } from './thread-pool'
import { ProcessManager } from './process-manager'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const self: any

function post(event: KernelEvent, transfer: Transferable[] = []): void {
  self.postMessage(event, transfer)
}

let rt: WasmRuntime | undefined
let tickTimer: number | undefined
let tickRunning = false
let tickRequested = false
/** 独立 WASM 子进程管理器（仅在 HandshakeRequest 提供 spawnWorkerUrl 时初始化）。 */
let processManager: ProcessManager | undefined

/**
 * T5.11.1: 在 self.__bun_routes 上安装 Proxy，当 Bun.serve({ port }) 将路由
 * 处理器写入 globalThis.__bun_routes[port] 时，立即向 UI 线程 post PortEvent。
 *
 * 必须在 createWasmRuntime（内部执行 setupGlobals）之前调用，因为：
 *   setupGlobals 中：globalThis.__bun_routes = globalThis.__bun_routes || {}
 * 预先放置非 nullish 的 Proxy 后，|| {} 短路，Proxy 保留。
 */
function installBunServeHook(): void {
  const existing = (self as Record<string, unknown>).__bun_routes
  if (existing && typeof existing === 'object') return // 已安装过
  ;(self as Record<string, unknown>).__bun_routes = new Proxy({} as Record<number, unknown>, {
    set(target, prop, value) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(target as any)[prop] = value
      const portNum = typeof prop === 'string' ? parseInt(prop, 10) : Number(prop)
      if (Number.isInteger(portNum) && portNum > 0 && portNum <= 0xffff) {
        post({ kind: 'port', port: portNum })
      }
      return true
    },
  })
}

function clearTickTimer(): void {
  if (tickTimer !== undefined) {
    clearTimeout(tickTimer)
    tickTimer = undefined
  }
}

function scheduleTick(delayMs: number): void {
  clearTickTimer()
  tickTimer = self.setTimeout(
    () => {
      tickTimer = undefined
      driveTickLoop()
    },
    Math.max(0, delayMs),
  )
}

function driveTickLoop(): void {
  if (!rt) return
  const tick = rt.instance.exports.bun_tick as (() => number) | undefined
  if (!tick) return

  if (tickRunning) {
    tickRequested = true
    return
  }

  tickRunning = true
  try {
    while (rt) {
      tickRequested = false
      const nextMs = tick()
      if (nextMs > 0) {
        scheduleTick(nextMs)
        return
      }
      if (!tickRequested) return
    }
  } finally {
    tickRunning = false
  }
}

function wakeTickLoop(): void {
  tickRequested = true
  clearTickTimer()
  queueMicrotask(driveTickLoop)
}

function evalScript(runtime: WasmRuntime, source: string, filename: string): number {
  const evalFn = runtime.instance.exports.bun_browser_eval as
    | ((srcPtr: number, srcLen: number, filePtr: number, fileLen: number) => number)
    | undefined
  if (!evalFn) throw new Error('bun_browser_eval export missing')

  let code = -1
  runtime.withString(source, (srcPtr, srcLen) => {
    runtime.withString(filename, (filePtr, fileLen) => {
      code = evalFn(srcPtr, srcLen, filePtr, fileLen)
    })
  })
  return code
}

function pathDirname(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return '/'
  return path.slice(0, idx)
}

function applyProcessState(runtime: WasmRuntime, argv?: string[], env?: Record<string, string>, cwd?: string): void {
  if (argv === undefined && env === undefined && cwd === undefined) return

  const nextArgv = ['bun', ...(argv ?? [])]
  const nextEnv = env ?? {}
  const nextCwd = cwd ?? '/'
  const code = evalScript(
    runtime,
    `if (globalThis.process && typeof globalThis.process === 'object') { globalThis.process.argv = ${JSON.stringify(nextArgv)}; globalThis.process.env = ${JSON.stringify(nextEnv)}; globalThis.__bun_cwd = ${JSON.stringify(nextCwd)}; }`,
    '<kernel:process-state>',
  )
  if (code !== 0) {
    throw new Error(`failed to apply process state: ${code}`)
  }
}

self.addEventListener('message', async (ev: MessageEvent<HostRequest>) => {
  const msg = ev.data
  try {
    switch (msg.kind) {
      case 'handshake': {
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error(`Protocol version mismatch: host=${msg.protocolVersion}, kernel=${PROTOCOL_VERSION}`)
        }

        // T5.11.1: 在 WASM init 之前安装 Bun.serve() 端口拦截 Proxy。
        installBunServeHook()

        // 若内核侧已传入 threads 模块，尝试以多线程模式启动。
        let threadMode: 'threaded' | 'single' = 'single'
        let pool: ThreadPool | undefined

        if (msg.threadsWasmModule) {
          const cap = detectThreadCapability()
          if (cap.threadsReady) {
            // 优先使用内核侧预分配的共享 Memory，保证两端 Atomics 视图一致。
            const memory = msg.sharedMemory ?? createSharedMemory()
            if (memory) {
              pool = new ThreadPool({
                memory,
                module: msg.threadsWasmModule,
                factory: () => new Worker(self.location.href, { type: 'module' }),
              })
              rt = await createWasmRuntime(msg.threadsWasmModule, {
                onPrint: (data, kind) => post({ kind, data }),
                sharedMemory: memory,
                spawnThread: pool.spawn.bind(pool),
                threadId: 0,
              })
              threadMode = 'threaded'
            }
          }
        }

        // 回退：单线程模式。
        if (!rt) {
          rt = await createWasmRuntime(msg.wasmModule, {
            onPrint: (data, kind) => post({ kind, data }),
          })
        }

        post({ kind: 'handshake:ack', protocolVersion: PROTOCOL_VERSION, engine: 'browser', threadMode })

        const initialCwd = msg.entry ? pathDirname(msg.entry) : undefined
        applyProcessState(rt, msg.argv, msg.env, initialCwd)

        if (msg.vfsSnapshot) {
          const loader = rt.instance.exports.bun_vfs_load_snapshot as ((ptr: number, len: number) => number) | undefined
          if (loader) {
            rt.withBytes(new Uint8Array(msg.vfsSnapshot), (ptr, len) => loader(ptr, len))
          }
        }

        // 若 UI 侧传入了 spawnWorkerUrl，初始化 ProcessManager。
        if (msg.spawnWorkerUrl) {
          // threaded 模式使用 threads wasm module，单线程模式使用 wasmModule
          const spawnModule =
            threadMode === 'threaded' && msg.threadsWasmModule ? msg.threadsWasmModule : msg.wasmModule
          processManager = new ProcessManager({
            workerUrl: msg.spawnWorkerUrl,
            module: spawnModule,
            initialSnapshot: msg.vfsSnapshot,
          })
        }

        post({ kind: 'ready' })

        if (msg.entry) {
          const runner = rt.instance.exports.bun_browser_run as
            | ((entryPtr: number, entryLen: number) => number)
            | undefined
          if (runner) {
            rt.withString(msg.entry, (ptr, len) => {
              const code = runner(ptr, len)
              post({ kind: 'exit', code })
            })
            wakeTickLoop()
          }
        }
        break
      }

      case 'run': {
        if (!rt) throw new Error('not initialized')
        applyProcessState(rt, msg.argv, msg.env, pathDirname(msg.entry))

        const runner = rt.instance.exports.bun_browser_run as
          | ((entryPtr: number, entryLen: number) => number)
          | undefined
        if (!runner) throw new Error('bun_browser_run export missing')
        rt.withString(msg.entry, (ptr, len) => {
          const code = runner(ptr, len)
          post({ kind: 'exit', code })
        })
        wakeTickLoop()
        break
      }

      case 'vfs:snapshot': {
        if (!rt) throw new Error('not initialized')
        const loader = rt.instance.exports.bun_vfs_load_snapshot as ((ptr: number, len: number) => number) | undefined
        if (loader) {
          rt.withBytes(new Uint8Array(msg.snapshot), (ptr, len) => loader(ptr, len))
        }

        processManager?.trackVfsSnapshot(msg.snapshot)
        break
      }

      case 'eval': {
        if (!rt) throw new Error('not initialized')
        let evalErr: string | undefined
        const code = evalScript(rt, msg.source, msg.filename ?? '<eval>')
        if (code !== 0) evalErr = `eval returned exit code ${code}`
        post({ kind: 'eval:result', id: msg.id, error: evalErr })
        wakeTickLoop()
        break
      }

      case 'spawn': {
        if (!rt) throw new Error('not initialized')

        // 若 ProcessManager 已初始化，在独立 WASM Worker 中执行子进程。
        if (processManager) {
          // 在每次 spawn 前 dump 父进程当前 live VFS 状态，确保子进程能看到运行期写入的文件。
          const liveSnapshot = rt.dumpVfsSnapshot()
          // T5.11.2: streamOutput=true 时以带 id 的 spawn:stdout/stderr 事件发送，
          // 否则发送全局 stdout/stderr（向后兼容）。
          const emitOut = msg.streamOutput
            ? (data: string) => post({ kind: 'spawn:stdout', id: msg.id, data })
            : (data: string) => post({ kind: 'stdout', data })
          const emitErr = msg.streamOutput
            ? (data: string) => post({ kind: 'spawn:stderr', id: msg.id, data })
            : (data: string) => post({ kind: 'stderr', data })
          void processManager
            .spawn({
              id: msg.id,
              argv: msg.argv,
              env: msg.env,
              cwd: msg.cwd,
              extraSnapshots: liveSnapshot ? [liveSnapshot.buffer as ArrayBuffer] : undefined,
              onStdout: emitOut,
              onStderr: emitErr,
            })
            .then(code => {
              post({ kind: 'spawn:exit', id: msg.id, code })
              wakeTickLoop()
            })
            .catch((err: unknown) => {
              const e = err instanceof Error ? err : new Error(String(err))
              emitErr(`[spawn] ${e.message}\n`)
              post({ kind: 'spawn:exit', id: msg.id, code: 1 })
            })
          break
        }

        // 回退：in-process spawn（无 spawnWorkerUrl 时向后兼容）。
        if (msg.env !== undefined || msg.cwd !== undefined) {
          applyProcessState(rt, msg.argv, msg.env, msg.cwd)
        }
        const spawnFn = rt.instance.exports.bun_spawn as ((cmdPtr: number, cmdLen: number) => number) | undefined
        if (!spawnFn) throw new Error('bun_spawn export missing')
        let exitCode = 0
        rt.withString(JSON.stringify(msg.argv), (ptr, len) => {
          exitCode = spawnFn(ptr, len)
        })
        post({ kind: 'spawn:exit', id: msg.id, code: exitCode })
        wakeTickLoop()
        break
      }

      case 'serve:fetch': {
        if (!rt) throw new Error('not initialized')
        // `Bun.serve()` 把路由写到 `globalThis.__bun_routes[port]`，这里直接读。
        const routes = (self as Record<string, unknown>).__bun_routes as
          | Record<number, { fetch: (req: Request) => Response | Promise<Response> }>
          | undefined
        const route = routes?.[msg.port]
        if (!route) {
          post({
            kind: 'serve:fetch:response',
            id: msg.id,
            status: 502,
            headers: {},
            body: '',
            error: `no route registered for port ${msg.port}`,
          })
          break
        }
        // 异步派发；响应到达后再 post。注意不要 await —— onMessage 是同步回调。
        void (async () => {
          try {
            const init: RequestInit = { method: msg.method ?? 'GET' }
            if (msg.headers) init.headers = msg.headers
            if (msg.body !== undefined) init.body = msg.body as BodyInit
            const req = new Request(msg.url, init)
            const res = await route.fetch(req)
            const body = await res.text()
            const headers: Record<string, string> = {}
            res.headers.forEach((v, k) => {
              headers[k] = v
            })
            post({
              kind: 'serve:fetch:response',
              id: msg.id,
              status: res.status,
              statusText: res.statusText,
              headers,
              body,
            })
          } catch (err) {
            post({
              kind: 'serve:fetch:response',
              id: msg.id,
              status: 500,
              headers: {},
              body: '',
              error: (err as Error).message,
            })
          }
          wakeTickLoop()
        })()
        break
      }

      case 'stop': {
        clearTickTimer()
        post({ kind: 'exit', code: msg.code ?? 130 })
        break
      }

      case 'install:request': {
        if (!rt) throw new Error('not initialized')
        // 不阻塞 onmessage，用 void + async IIFE。
        void (async () => {
          try {
            const { installPackages } = await import('./installer')
            const result = await installPackages(msg.deps, {
              ...(msg.opts?.registry !== undefined ? { registry: msg.opts.registry } : {}),
              ...(msg.opts?.installRoot !== undefined ? { installRoot: msg.opts.installRoot } : {}),
              wasmRuntime: rt,
              onProgress: p => {
                post({
                  kind: 'install:progress',
                  id: msg.id,
                  name: p.name,
                  ...(p.version !== undefined ? { version: p.version } : {}),
                  phase: p.phase,
                })
              },
            })

            // 直接在 Worker 内把文件写入 WASM VFS。
            if (result.files.length > 0 && rt) {
              const loader = rt.instance.exports.bun_vfs_load_snapshot as
                | ((ptr: number, len: number) => number)
                | undefined
              if (loader) {
                const snap = buildSnapshot(result.files)
                rt.withBytes(new Uint8Array(snap), (ptr, len) => loader(ptr, len))
              }
            }

            post({
              kind: 'install:result',
              id: msg.id,
              result: {
                packages: result.packages,
                lockfile: result.lockfile,
              },
            })
          } catch (err) {
            post({
              kind: 'install:result',
              id: msg.id,
              error: (err as Error).message,
            })
          }
          wakeTickLoop()
        })()
        break
      }

      case 'fs:read': {
        if (!rt) throw new Error('not initialized')
        let fileError: string | undefined
        let fileData: ArrayBuffer | undefined
        let fileText: string | undefined
        const snap = rt.dumpVfsSnapshot()
        if (!snap) {
          fileError = 'ENOENT'
        } else {
          const files = parseSnapshot(snap.buffer as ArrayBuffer)
          const normPath = msg.path.startsWith('/') ? msg.path : '/' + msg.path
          const found = files.find(f => f.path === normPath)
          if (!found) {
            fileError = 'ENOENT'
          } else if (msg.encoding === 'utf8') {
            const bytes = found.data
            fileText = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes as Uint8Array)
          } else {
            const bytes =
              typeof found.data === 'string' ? new TextEncoder().encode(found.data) : (found.data as Uint8Array)
            fileData = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
          }
        }
        if (fileData !== undefined) {
          post({ kind: 'fs:read:response', id: msg.id, data: fileData, error: fileError }, [fileData])
        } else {
          post({
            kind: 'fs:read:response',
            id: msg.id,
            ...(fileText !== undefined ? { text: fileText } : {}),
            error: fileError,
          })
        }
        break
      }

      case 'fs:readdir': {
        if (!rt) throw new Error('not initialized')
        const snap = rt.dumpVfsSnapshot()
        if (!snap) {
          post({ kind: 'fs:readdir:response', id: msg.id, entries: [] })
          break
        }
        const files = parseSnapshot(snap.buffer as ArrayBuffer)
        const dir = msg.path.endsWith('/') ? msg.path : msg.path + '/'
        const normDir = dir.startsWith('/') ? dir : '/' + dir
        const seen = new Map<string, FsDirEntry>()
        for (const f of files) {
          if (!f.path.startsWith(normDir)) continue
          const rel = f.path.slice(normDir.length)
          if (!rel) continue
          const slash = rel.indexOf('/')
          if (slash === -1) {
            // direct file child
            if (!seen.has(rel)) seen.set(rel, { name: rel, type: 'file' })
          } else {
            // nested — first segment is a directory
            const dirName = rel.slice(0, slash)
            if (!seen.has(dirName)) seen.set(dirName, { name: dirName, type: 'directory' })
          }
        }
        post({ kind: 'fs:readdir:response', id: msg.id, entries: [...seen.values()] })
        break
      }

      case 'fs:stat': {
        if (!rt) throw new Error('not initialized')
        const snap = rt.dumpVfsSnapshot()
        if (!snap) {
          post({ kind: 'fs:stat:response', id: msg.id, error: 'ENOENT' })
          break
        }
        const files = parseSnapshot(snap.buffer as ArrayBuffer)
        const normPath = msg.path.startsWith('/') ? msg.path : '/' + msg.path
        // Check if it's a file
        const file = files.find(f => f.path === normPath)
        if (file) {
          const bytes = typeof file.data === 'string' ? new TextEncoder().encode(file.data) : (file.data as Uint8Array)
          post({
            kind: 'fs:stat:response',
            id: msg.id,
            stat: { type: 'file', size: bytes.byteLength, mode: file.mode ?? 0o644 },
          })
          break
        }
        // Check if it's a directory (any file starts with path + '/')
        const dirPrefix = normPath.endsWith('/') ? normPath : normPath + '/'
        const isDir = files.some(f => f.path.startsWith(dirPrefix))
        if (isDir) {
          post({ kind: 'fs:stat:response', id: msg.id, stat: { type: 'directory', size: 0, mode: 0o755 } })
        } else {
          post({ kind: 'fs:stat:response', id: msg.id, error: 'ENOENT' })
        }
        break
      }

      case 'fs:mkdir': {
        if (!rt) throw new Error('not initialized')
        // Use evalScript to call the VFS-backed fs.mkdirSync
        let mkdirErr: string | undefined
        try {
          const code = evalScript(
            rt,
            `try { require('node:fs').mkdirSync(${JSON.stringify(msg.path)}, { recursive: true }); } catch(e) { throw e; }`,
            '<kernel:fs:mkdir>',
          )
          if (code !== 0) mkdirErr = `mkdir failed (code ${code})`
        } catch (e) {
          mkdirErr = (e as Error).message
        }
        post({ kind: 'fs:mkdir:response', id: msg.id, error: mkdirErr })
        break
      }

      case 'fs:rm': {
        if (!rt) throw new Error('not initialized')
        let rmErr: string | undefined
        try {
          const rmCode = msg.recursive
            ? `require('node:fs').rmSync(${JSON.stringify(msg.path)}, { recursive: true, force: true })`
            : `require('node:fs').unlinkSync(${JSON.stringify(msg.path)})`
          const code = evalScript(rt, `try { ${rmCode}; } catch(e) { throw e; }`, '<kernel:fs:rm>')
          if (code !== 0) rmErr = `rm failed (code ${code})`
        } catch (e) {
          rmErr = (e as Error).message
        }
        post({ kind: 'fs:rm:response', id: msg.id, error: rmErr })
        break
      }

      case 'fs:rename': {
        if (!rt) throw new Error('not initialized')
        let renameErr: string | undefined
        try {
          const code = evalScript(
            rt,
            `try { require('node:fs').renameSync(${JSON.stringify(msg.from)}, ${JSON.stringify(msg.to)}); } catch(e) { throw e; }`,
            '<kernel:fs:rename>',
          )
          if (code !== 0) renameErr = `rename failed (code ${code})`
        } catch (e) {
          renameErr = (e as Error).message
        }
        post({ kind: 'fs:rename:response', id: msg.id, error: renameErr })
        break
      }

      default:
        break
    }
  } catch (e) {
    const err = e as Error
    post({ kind: 'error', message: err.message, stack: err.stack })
  }
})
