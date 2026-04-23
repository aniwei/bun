/**
 * Kernel worker 入口 —— 在专用 Web Worker 里拉起 bun-core.wasm + JSI Host。
 *
 * 注意：此文件假定运行在 Web Worker 上下文（`self` 为 `DedicatedWorkerGlobalScope`）。
 * 浏览器端需通过 `new Worker(new URL("./kernel-worker.ts", import.meta.url), { type: "module" })` 加载。
 */

import { PROTOCOL_VERSION, type HostRequest, type KernelEvent, type FsDirEntry, type FsWatchRequest, type FsUnwatchRequest } from './protocol'
import { createWasmRuntime, type WasmRuntime } from './wasm'
import { buildSnapshot, parseSnapshot } from './vfs-client'
import { detectThreadCapability, createSharedMemory } from './thread-capability'
import { ThreadPool } from './thread-pool'
import { ProcessManager } from './process-manager'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const self: any

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

type HostRequestOfKind<K extends HostRequest['kind']> = Extract<HostRequest, { kind: K }>

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

class KernelWorkerHost {
  private rt: WasmRuntime | undefined
  private tickTimer: number | undefined
  private tickRunning = false
  private tickRequested = false
  private tickNotifyView: Int32Array | undefined
  private readonly watches = new Map<string, { path: string; recursive: boolean }>()
  private processManager: ProcessManager | undefined

  private post(event: KernelEvent, transfer: Transferable[] = []): void {
    self.postMessage(event, transfer)
  }

  private requireRuntime(): WasmRuntime {
    if (!this.rt) throw new Error('not initialized')
    return this.rt
  }

  /**
   * 在 self.__bun_routes 上安装 Proxy，当 Bun.serve({ port }) 将路由
   * 处理器写入 globalThis.__bun_routes[port] 时，立即向 UI 线程 post PortEvent。
   */
  private installBunServeHook(): void {
    const existing = (self as Record<string, unknown>).__bun_routes
    if (existing && typeof existing === 'object') return
    ;(self as Record<string, unknown>).__bun_routes = new Proxy({} as Record<number, unknown>, {
      set: (target, prop, value) => {
        ;(target as Record<PropertyKey, unknown>)[prop] = value
        const portNum = typeof prop === 'string' ? parseInt(prop, 10) : Number(prop)
        if (Number.isInteger(portNum) && portNum > 0 && portNum <= 0xffff) {
          this.post({ kind: 'port', port: portNum })
        }
        return true
      },
      // server.stop() 时 delete __bun_routes[port] → port:close 事件
      deleteProperty: (target, prop) => {
        const portNum = typeof prop === 'string' ? parseInt(prop, 10) : Number(prop)
        const existed = Object.prototype.hasOwnProperty.call(target, prop)
        delete (target as Record<PropertyKey, unknown>)[prop]
        if (existed && Number.isInteger(portNum) && portNum > 0 && portNum <= 0xffff) {
          this.post({ kind: 'port:close', port: portNum })
        }
        return true
      },
    })
  }

  private clearTickTimer(): void {
    if (this.tickTimer !== undefined) {
      clearTimeout(this.tickTimer)
      this.tickTimer = undefined
    }
  }

  private scheduleTick(delayMs: number): void {
    this.clearTickTimer()
    this.tickTimer = self.setTimeout(
      () => {
        this.tickTimer = undefined
        this.driveTickLoop()
      },
      Math.max(0, delayMs),
    )
  }

  private driveTickLoop(): void {
    const runtime = this.rt
    if (!runtime) return

    const tick = runtime.instance.exports.bun_tick as (() => number) | undefined
    if (!tick) return

    if (this.tickRunning) {
      this.tickRequested = true
      return
    }

    this.tickRunning = true
    try {
      while (this.rt) {
        this.tickRequested = false
        const nextMs = tick()
        if (nextMs > 0) {
          this.scheduleTick(nextMs)
          return
        }
        if (!this.tickRequested) return
      }
    } finally {
      this.tickRunning = false
    }
  }

  private wakeTickLoop(): void {
    this.tickRequested = true
    this.clearTickTimer()
    if (this.tickNotifyView) {
      Atomics.store(this.tickNotifyView, 0, 1)
      Atomics.notify(this.tickNotifyView, 0, 1)
    }
    queueMicrotask(() => this.driveTickLoop())
  }

  /**
   * Notify all matching watchers that `changedPath` has changed.
   * - Fires for exact-path matches.
   * - Fires for direct children (non-recursive) or any descendant (recursive).
   */
  private fireWatchEvents(changedPath: string, eventType: 'rename' | 'change'): void {
    if (this.watches.size === 0) return
    const norm = changedPath.startsWith('/') ? changedPath : '/' + changedPath
    for (const [watchId, { path: watchPath, recursive }] of this.watches) {
      const watchDir = watchPath.endsWith('/') ? watchPath : watchPath + '/'
      if (norm === watchPath) {
        this.post({ kind: 'fs:watch:event', id: watchId, eventType, filename: norm })
      } else if (norm.startsWith(watchDir)) {
        if (recursive) {
          this.post({ kind: 'fs:watch:event', id: watchId, eventType, filename: norm })
        } else {
          const rel = norm.slice(watchDir.length)
          if (!rel.includes('/')) {
            this.post({ kind: 'fs:watch:event', id: watchId, eventType, filename: norm })
          }
        }
      }
    }
  }

  private async handleHandshake(msg: HostRequestOfKind<'handshake'>): Promise<void> {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`Protocol version mismatch: host=${msg.protocolVersion}, kernel=${PROTOCOL_VERSION}`)
    }

    this.installBunServeHook()

    let threadMode: 'threaded' | 'single' = 'single'
    let pool: ThreadPool | undefined
    let runtimeModule: WebAssembly.Module | undefined
    this.tickNotifyView = undefined

    if (msg.threadsWasmModule) {
      const cap = detectThreadCapability()
      if (cap.threadsReady) {
        const memory = msg.sharedMemory ?? createSharedMemory()
        if (memory) {
          pool = new ThreadPool({
            memory,
            module: msg.threadsWasmModule,
            factory: () => new Worker(self.location.href, { type: 'module' }),
          })
          this.rt = await createWasmRuntime(msg.threadsWasmModule, {
            onPrint: (data, kind) => this.post({ kind, data }),
            sharedMemory: memory,
            spawnThread: pool.spawn.bind(pool),
            threadId: 0,
          })
          runtimeModule = msg.threadsWasmModule
          threadMode = 'threaded'
        }
      }
    }

    if (!this.rt) {
      const singleWasmModule = msg.wasmModule as WebAssembly.Module | undefined
      if (singleWasmModule === undefined) {
        throw new Error('handshake.wasmModule is undefined; provide a non-thread bun-core.wasm module for single-thread fallback')
      }
      this.rt = await createWasmRuntime(singleWasmModule, {
        onPrint: (data, kind) => this.post({ kind, data }),
      })
      runtimeModule = singleWasmModule
    }

    const runtime = this.requireRuntime()
    this.post({ kind: 'handshake:ack', protocolVersion: PROTOCOL_VERSION, engine: 'browser', threadMode })

    if (threadMode === 'threaded') {
      const notifyPtrFn = runtime.instance.exports.bun_tick_notify_ptr as (() => number) | undefined
      if (notifyPtrFn) {
        const byteOff = notifyPtrFn()
        const memBuf = (runtime.instance.exports.memory as WebAssembly.Memory | undefined)?.buffer
        if (memBuf instanceof SharedArrayBuffer) {
          this.tickNotifyView = new Int32Array(memBuf, byteOff, 1)
        }
      }
    }

    const initialCwd = msg.entry ? pathDirname(msg.entry) : undefined
    applyProcessState(runtime, msg.argv, msg.env, initialCwd)

    if (msg.vfsSnapshot) {
      const loader = runtime.instance.exports.bun_vfs_load_snapshot as ((ptr: number, len: number) => number) | undefined
      if (loader) {
        runtime.withBytes(new Uint8Array(msg.vfsSnapshot), (ptr, len) => loader(ptr, len))
      }
    }

    if (msg.spawnWorkerUrl) {
      if (!runtimeModule) {
        throw new Error('missing wasm module for spawn worker initialization')
      }
      this.processManager = new ProcessManager({
        workerUrl: msg.spawnWorkerUrl,
        module: runtimeModule,
        initialSnapshot: msg.vfsSnapshot,
      })
    }

    this.post({ kind: 'ready' })

    if (msg.entry) {
      const runner = runtime.instance.exports.bun_browser_run as ((entryPtr: number, entryLen: number) => number) | undefined
      if (runner) {
        runtime.withString(msg.entry, (ptr, len) => {
          const code = runner(ptr, len)
          this.post({ kind: 'exit', code })
        })
        this.wakeTickLoop()
      }
    }
  }

  private handleRun(msg: HostRequestOfKind<'run'>): void {
    const runtime = this.requireRuntime()
    applyProcessState(runtime, msg.argv, msg.env, pathDirname(msg.entry))

    const runner = runtime.instance.exports.bun_browser_run as ((entryPtr: number, entryLen: number) => number) | undefined
    if (!runner) throw new Error('bun_browser_run export missing')
    runtime.withString(msg.entry, (ptr, len) => {
      const code = runner(ptr, len)
      this.post({ kind: 'exit', code })
    })
    this.wakeTickLoop()
  }

  private handleVfsSnapshot(msg: HostRequestOfKind<'vfs:snapshot'>): void {
    const runtime = this.requireRuntime()
    const loader = runtime.instance.exports.bun_vfs_load_snapshot as ((ptr: number, len: number) => number) | undefined
    if (loader) {
      runtime.withBytes(new Uint8Array(msg.snapshot), (ptr, len) => loader(ptr, len))
    }

    this.processManager?.trackVfsSnapshot(msg.snapshot)
  }

  private handleEval(msg: HostRequestOfKind<'eval'>): void {
    const runtime = this.requireRuntime()
    const code = evalScript(runtime, msg.source, msg.filename ?? '<eval>')
    this.post({
      kind: 'eval:result',
      id: msg.id,
      ...(code !== 0 ? { error: `eval returned exit code ${code}` } : {}),
    })
    this.wakeTickLoop()
  }

  private handleSpawn(msg: HostRequestOfKind<'spawn'>): void {
    const runtime = this.requireRuntime()

    if (this.processManager) {
      const liveSnapshot = runtime.dumpVfsSnapshot()
      const emitOut = msg.streamOutput
        ? (data: string) => this.post({ kind: 'spawn:stdout', id: msg.id, data })
        : (data: string) => this.post({ kind: 'stdout', data })
      const emitErr = msg.streamOutput
        ? (data: string) => this.post({ kind: 'spawn:stderr', id: msg.id, data })
        : (data: string) => this.post({ kind: 'stderr', data })
      void this.processManager
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
          this.post({ kind: 'spawn:exit', id: msg.id, code })
          this.wakeTickLoop()
        })
        .catch((err: unknown) => {
          const spawnError = toError(err)
          emitErr(`[spawn] ${spawnError.message}\n`)
          this.post({ kind: 'spawn:exit', id: msg.id, code: 1 })
        })
      return
    }

    if (msg.env !== undefined || msg.cwd !== undefined) {
      applyProcessState(runtime, msg.argv, msg.env, msg.cwd)
    }

    const spawnFn = runtime.instance.exports.bun_spawn as ((cmdPtr: number, cmdLen: number) => number) | undefined
    if (!spawnFn) throw new Error('bun_spawn export missing')

    let exitCode = 0
    runtime.withString(JSON.stringify(msg.argv), (ptr, len) => {
      exitCode = spawnFn(ptr, len)
    })
    this.post({ kind: 'spawn:exit', id: msg.id, code: exitCode })
    this.wakeTickLoop()
  }

  private handleSpawnKill(msg: HostRequestOfKind<'spawn:kill'>): void {
    if (this.processManager) {
      this.processManager.kill(msg.id, msg.signal ?? 15)
    }
  }

  private handleServeFetch(msg: HostRequestOfKind<'serve:fetch'>): void {
    this.requireRuntime()

    const routes = (self as Record<string, unknown>).__bun_routes as
      | Record<number, { fetch: (req: Request) => Response | Promise<Response> }>
      | undefined
    const route = routes?.[msg.port]

    if (!route) {
      this.post({
        kind: 'serve:fetch:response',
        id: msg.id,
        status: 502,
        headers: {},
        body: '',
        error: `no route registered for port ${msg.port}`,
      })
      return
    }

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
        this.post({
          kind: 'serve:fetch:response',
          id: msg.id,
          status: res.status,
          statusText: res.statusText,
          headers,
          body,
        })
      } catch (err: unknown) {
        this.post({
          kind: 'serve:fetch:response',
          id: msg.id,
          status: 500,
          headers: {},
          body: '',
          error: toError(err).message,
        })
      }
      this.wakeTickLoop()
    })()
  }

  private handleStop(msg: HostRequestOfKind<'stop'>): void {
    this.clearTickTimer()
    this.post({ kind: 'exit', code: msg.code ?? 130 })
  }

  private handleInstallRequest(msg: HostRequestOfKind<'install:request'>): void {
    const runtime = this.requireRuntime()
    void (async () => {
      try {
        const { installPackages } = await import('./installer')
        const result = await installPackages(msg.deps, {
          ...(msg.opts?.registry !== undefined ? { registry: msg.opts.registry } : {}),
          ...(msg.opts?.installRoot !== undefined ? { installRoot: msg.opts.installRoot } : {}),
          wasmRuntime: runtime,
          onProgress: p => {
            this.post({
              kind: 'install:progress',
              id: msg.id,
              name: p.name,
              ...(p.version !== undefined ? { version: p.version } : {}),
              phase: p.phase,
            })
          },
        })

        if (result.files.length > 0) {
          const loader = runtime.instance.exports.bun_vfs_load_snapshot as ((ptr: number, len: number) => number) | undefined
          if (loader) {
            const snap = buildSnapshot(result.files)
            runtime.withBytes(new Uint8Array(snap), (ptr, len) => loader(ptr, len))
          }
        }

        this.post({
          kind: 'install:result',
          id: msg.id,
          result: {
            packages: result.packages,
            lockfile: result.lockfile,
          },
        })
      } catch (err: unknown) {
        this.post({
          kind: 'install:result',
          id: msg.id,
          error: toError(err).message,
        })
      }
      this.wakeTickLoop()
    })()
  }

  private handleFsRead(msg: HostRequestOfKind<'fs:read'>): void {
    const runtime = this.requireRuntime()
    let fileError: string | undefined
    let fileData: ArrayBuffer | undefined
    let fileText: string | undefined
    const snap = runtime.dumpVfsSnapshot()
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
        const bytes = typeof found.data === 'string' ? new TextEncoder().encode(found.data) : (found.data as Uint8Array)
        fileData = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      }
    }

    if (fileData !== undefined) {
      this.post(
        {
          kind: 'fs:read:response',
          id: msg.id,
          data: fileData,
          ...(fileError !== undefined ? { error: fileError } : {}),
        },
        [fileData],
      )
      return
    }

    this.post({
      kind: 'fs:read:response',
      id: msg.id,
      ...(fileText !== undefined ? { text: fileText } : {}),
      ...(fileError !== undefined ? { error: fileError } : {}),
    })
  }

  private handleFsReaddir(msg: HostRequestOfKind<'fs:readdir'>): void {
    const runtime = this.requireRuntime()
    const snap = runtime.dumpVfsSnapshot()
    if (!snap) {
      this.post({ kind: 'fs:readdir:response', id: msg.id, entries: [] })
      return
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
        if (!seen.has(rel)) seen.set(rel, { name: rel, type: 'file' })
      } else {
        const dirName = rel.slice(0, slash)
        if (!seen.has(dirName)) seen.set(dirName, { name: dirName, type: 'directory' })
      }
    }
    this.post({ kind: 'fs:readdir:response', id: msg.id, entries: [...seen.values()] })
  }

  private handleFsStat(msg: HostRequestOfKind<'fs:stat'>): void {
    const runtime = this.requireRuntime()
    const snap = runtime.dumpVfsSnapshot()
    if (!snap) {
      this.post({ kind: 'fs:stat:response', id: msg.id, error: 'ENOENT' })
      return
    }
    const files = parseSnapshot(snap.buffer as ArrayBuffer)
    const normPath = msg.path.startsWith('/') ? msg.path : '/' + msg.path
    const file = files.find(f => f.path === normPath)
    if (file) {
      const bytes = typeof file.data === 'string' ? new TextEncoder().encode(file.data) : (file.data as Uint8Array)
      this.post({
        kind: 'fs:stat:response',
        id: msg.id,
        stat: { type: 'file', size: bytes.byteLength, mode: file.mode ?? 0o644 },
      })
      return
    }
    const dirPrefix = normPath.endsWith('/') ? normPath : normPath + '/'
    const isDir = files.some(f => f.path.startsWith(dirPrefix))
    if (isDir) {
      this.post({ kind: 'fs:stat:response', id: msg.id, stat: { type: 'directory', size: 0, mode: 0o755 } })
    } else {
      this.post({ kind: 'fs:stat:response', id: msg.id, error: 'ENOENT' })
    }
  }

  private handleFsMkdir(msg: HostRequestOfKind<'fs:mkdir'>): void {
    const runtime = this.requireRuntime()
    let mkdirErr: string | undefined
    try {
      const code = evalScript(
        runtime,
        `try { require('node:fs').mkdirSync(${JSON.stringify(msg.path)}, { recursive: true }); } catch(e) { throw e; }`,
        '<kernel:fs:mkdir>',
      )
      if (code !== 0) mkdirErr = `mkdir failed (code ${code})`
    } catch (err: unknown) {
      mkdirErr = toError(err).message
    }
    // Protocol-level mutation: kernel.ts fires local watch events via _fireLocalWatchEvents.
    this.post({
      kind: 'fs:mkdir:response',
      id: msg.id,
      ...(mkdirErr !== undefined ? { error: mkdirErr } : {}),
    })
  }

  private handleFsRm(msg: HostRequestOfKind<'fs:rm'>): void {
    const runtime = this.requireRuntime()
    let rmErr: string | undefined
    try {
      const rmCode = msg.recursive
        ? `require('node:fs').rmSync(${JSON.stringify(msg.path)}, { recursive: true, force: true })`
        : `require('node:fs').unlinkSync(${JSON.stringify(msg.path)})`
      const code = evalScript(runtime, `try { ${rmCode}; } catch(e) { throw e; }`, '<kernel:fs:rm>')
      if (code !== 0) rmErr = `rm failed (code ${code})`
    } catch (err: unknown) {
      rmErr = toError(err).message
    }
    // Protocol-level mutation: kernel.ts fires local watch events via _fireLocalWatchEvents.
    this.post({
      kind: 'fs:rm:response',
      id: msg.id,
      ...(rmErr !== undefined ? { error: rmErr } : {}),
    })
  }

  private handleFsRename(msg: HostRequestOfKind<'fs:rename'>): void {
    const runtime = this.requireRuntime()
    let renameErr: string | undefined
    try {
      const code = evalScript(
        runtime,
        `try { require('node:fs').renameSync(${JSON.stringify(msg.from)}, ${JSON.stringify(msg.to)}); } catch(e) { throw e; }`,
        '<kernel:fs:rename>',
      )
      if (code !== 0) renameErr = `rename failed (code ${code})`
    } catch (err: unknown) {
      renameErr = toError(err).message
    }
    // Protocol-level mutation: kernel.ts fires local watch events via _fireLocalWatchEvents.
    this.post({
      kind: 'fs:rename:response',
      id: msg.id,
      ...(renameErr !== undefined ? { error: renameErr } : {}),
    })
  }

  private async handleHostRequest(msg: HostRequest): Promise<void> {
    switch (msg.kind) {
      case 'handshake':
        await this.handleHandshake(msg)
        return
      case 'run':
        this.handleRun(msg)
        return
      case 'vfs:snapshot':
        this.handleVfsSnapshot(msg)
        return
      case 'eval':
        this.handleEval(msg)
        return
      case 'spawn':
        this.handleSpawn(msg)
        return
      case 'spawn:kill':
        this.handleSpawnKill(msg)
        return
      case 'serve:fetch':
        this.handleServeFetch(msg)
        return
      case 'stop':
        this.handleStop(msg)
        return
      case 'install:request':
        this.handleInstallRequest(msg)
        return
      case 'fs:read':
        this.handleFsRead(msg)
        return
      case 'fs:readdir':
        this.handleFsReaddir(msg)
        return
      case 'fs:stat':
        this.handleFsStat(msg)
        return
      case 'fs:mkdir':
        this.handleFsMkdir(msg)
        return
      case 'fs:rm':
        this.handleFsRm(msg)
        return
      case 'fs:rename':
        this.handleFsRename(msg)
        return
      case 'fs:watch': {
        const watchRequest = msg as unknown as FsWatchRequest
        this.watches.set(watchRequest.id, {
          path: watchRequest.path.startsWith('/') ? watchRequest.path : '/' + watchRequest.path,
          recursive: watchRequest.recursive ?? false,
        })
        return
      }
      case 'fs:unwatch': {
        const unwatchRequest = msg as unknown as FsUnwatchRequest
        this.watches.delete(unwatchRequest.id)
        return
      }
      default:
        return
    }
  }

  async onHostMessage(ev: MessageEvent<HostRequest>): Promise<void> {
    try {
      await this.handleHostRequest(ev.data)
    } catch (err: unknown) {
      const error = toError(err)
      this.post({
        kind: 'error',
        message: error.message,
        ...(error.stack !== undefined ? { stack: error.stack } : {}),
      })
    }
  }
}

const hostWorker = new KernelWorkerHost()
self.addEventListener('message', (ev: MessageEvent<HostRequest>) => {
  void hostWorker.onHostMessage(ev)
})

// T5.12.4: Thread Worker entry point — handle 'thread:start' messages from ThreadPool.
// Fires when kernel-worker.ts is spawned as a thread Worker (not as main kernel).
self.addEventListener('message', async (ev: MessageEvent<{ type?: string }>) => {
  if (!ev.data || (ev.data as Record<string, unknown>).type !== 'thread:start') return
  const msg = ev.data as {
    type: 'thread:start'
    tid: number
    arg: number
    memory: WebAssembly.Memory
    module: WebAssembly.Module
  }
  try {
    const threadRt = await createWasmRuntime(msg.module, {
      onPrint: () => {},
      sharedMemory: msg.memory,
      threadId: msg.tid,
    })
    const entryFn = threadRt.instance.exports.bun_thread_entry as ((a: number) => void) | undefined
    if (entryFn) entryFn(msg.arg)
    self.postMessage({ type: 'thread:exit', tid: msg.tid, code: 0 })
  } catch (e) {
    self.postMessage({ type: 'thread:error', tid: msg.tid, message: (e as Error).message })
  }
})
