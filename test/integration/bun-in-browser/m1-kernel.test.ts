import { describe, expect, test } from 'bun:test'
import { Kernel } from '../../../packages/bun-web-kernel/src/kernel'
import { VFS } from '../../../packages/bun-web-vfs/src/overlay-fs'
import { bootstrapProcessWorker } from '../../../packages/bun-web-runtime/src/process-bootstrap'
import { createProcess, installProcessGlobal } from '../../../packages/bun-web-node/src/process'
import { TypedEventEmitter } from '../../../packages/bun-web-shared/src/event-emitter'
import { createBridge, createBridgeWithCapability, supportsSyncSyscall } from '../../../packages/bun-web-kernel/src/async-fallback'
import { SYSCALL_OP } from '../../../packages/bun-web-kernel/src/syscall-bridge'
import { SyncSyscallUnavailableError } from '../../../packages/bun-web-kernel/src/errors'

describe('bun-web M1 kernel + vfs smoke', () => {
  test('kernel boot and spawn returns pid', async () => {
    const vfs = new VFS()
    const kernel = await Kernel.boot({ maxProcesses: 4 }, vfs)
    const proc = await kernel.spawn({ argv: ['bun', 'run', 'index.ts'] })

    expect(proc.pid).toBeGreaterThan(0)
    expect(kernel.processes.list().length).toBe(1)

    await Kernel.shutdown()
  })

  test('vfs read write and readdir works', () => {
    const vfs = new VFS()
    vfs.mkdirSync('/app', { recursive: true })
    vfs.writeFileSync('/app/a.txt', 'hello')

    expect(vfs.readFileSync('/app/a.txt').toString()).toBe('hello')

    const names = vfs.readdirSync('/app') as string[]
    expect(names).toContain('a.txt')
  })

  test('process bootstrap stores context', async () => {
    const kernel = await Kernel.boot()
    const proc = await kernel.spawn({ argv: ['bun', 'run', 'script.ts'] })

    await bootstrapProcessWorker({
      kernel,
      pid: proc.pid,
      argv: proc.argv,
      env: proc.env,
      cwd: proc.cwd,
      sabBuffer: null,
    })

    const scope = globalThis as typeof globalThis & {
      __BUN_WEB_PROCESS_CONTEXT__?: {
        pid: number
      }
    }

    expect(scope.__BUN_WEB_PROCESS_CONTEXT__?.pid).toBe(proc.pid)

    await Kernel.shutdown()
  })

  test('node process shape works in m1', () => {
    const proc = createProcess({
      pid: 123,
      argv: ['bun', 'run', 'index.ts'],
      env: { NODE_ENV: 'test' },
      cwd: '/app',
      version: '1.0.0-web',
    })

    installProcessGlobal(proc)

    expect(proc.pid).toBe(123)
    expect(proc.platform).toBe('browser')
    expect(proc.cwd()).toBe('/app')

    proc.chdir('/workspace')
    expect(proc.cwd()).toBe('/workspace')
    expect(proc.env.NODE_ENV).toBe('test')
  })

  test('node process events and nextTick work in m1', async () => {
    const proc = createProcess({
      pid: 321,
      argv: [],
      env: {},
      cwd: '/',
      version: '1.0.0-web',
    })

    let received = ''
    const onData = (value: unknown) => {
      received = String(value)
    }

    proc.on('data', onData)
    const emitted = proc.emit('data', 'ok')
    expect(emitted).toBe(true)
    expect(received).toBe('ok')

    proc.off('data', onData)
    expect(proc.emit('data', 'nope')).toBe(false)

    let onceCount = 0
    proc.once('ready', () => {
      onceCount += 1
    })
    proc.emit('ready')
    proc.emit('ready')
    expect(onceCount).toBe(1)

    let tickValue = ''
    await new Promise<void>((resolve) => {
      proc.nextTick((value) => {
        tickValue = String(value)
        resolve()
      }, 'microtask')
    })

    expect(tickValue).toBe('microtask')
  })

  test('node process aliases and signal behavior work in m1', () => {
    const proc = createProcess({
      pid: 456,
      argv: [],
      env: {},
      cwd: '/',
    })

    let signalValue = ''
    const onSignal = (value: unknown) => {
      signalValue = String(value)
    }

    proc.addListener('SIGINT', onSignal)
    expect(proc.listenerCount('SIGINT')).toBe(1)
    expect(proc.listeners('SIGINT').length).toBe(1)

    expect(proc.kill(456, 'SIGINT')).toBe(true)
    expect(signalValue).toBe('SIGINT')

    proc.removeListener('SIGINT', onSignal)
    expect(proc.listenerCount('SIGINT')).toBe(0)

    proc.addListener('event-a', () => {})
    proc.addListener('event-b', () => {})
    proc.removeAllListeners()
    expect(proc.listenerCount('event-a')).toBe(0)
    expect(proc.listenerCount('event-b')).toBe(0)

    expect(proc).toBeInstanceOf(TypedEventEmitter)
  })

  test('m1-7 async fallback reports sync support by capability', () => {
    expect(
      supportsSyncSyscall({
        hasSharedArrayBuffer: true,
        hasAtomicsWait: true,
      }),
    ).toBe(true)

    expect(
      supportsSyncSyscall({
        hasSharedArrayBuffer: false,
        hasAtomicsWait: true,
      }),
    ).toBe(false)
  })

  test('m1-7 async fallback disables sync syscall but keeps async syscall', async () => {
    const bridge = createBridgeWithCapability({
      hasSharedArrayBuffer: false,
      hasAtomicsWait: true,
    })

    expect(bridge.isAsync).toBe(true)
    expect(() => bridge.callSync(SYSCALL_OP.FS_READ, new Uint8Array([1, 2]))).toThrow('Synchronous syscall is unavailable in async fallback mode')

    const response = await bridge.callAsync(SYSCALL_OP.FS_READ, new Uint8Array([7, 8]))
    expect(response.ok).toBe(true)
    expect(Array.from(response.payload)).toEqual([SYSCALL_OP.FS_READ, 7, 8])
  })

  test('m1-2 syscall bridge exposes stable sync-fallback error contract', () => {
    const bridge = createBridgeWithCapability({
      hasSharedArrayBuffer: false,
      hasAtomicsWait: false,
    })

    try {
      bridge.callSync(SYSCALL_OP.FS_READ, new Uint8Array())
      throw new Error('expected sync syscall to throw in async fallback mode')
    } catch (error) {
      expect(error).toBeInstanceOf(SyncSyscallUnavailableError)
      expect((error as { code?: string }).code).toBe('ERR_BUN_WEB_SYNC_UNAVAILABLE')
      expect((error as Error).name).toBe('SyncSyscallUnavailableError')
    }
  })

  test('m1-2 syscall bridge callSync succeeds when sync capability is available', () => {
    const bridge = createBridgeWithCapability({
      hasSharedArrayBuffer: true,
      hasAtomicsWait: true,
    })

    expect(bridge.isAsync).toBe(false)

    const response = bridge.callSync(SYSCALL_OP.FS_STAT, new Uint8Array([4, 2]))
    expect(response.ok).toBe(true)
    expect(Array.from(response.payload)).toEqual([SYSCALL_OP.FS_STAT, 4, 2])
  })

  test('m1-2 syscall bridge seq increases across sync and async calls', async () => {
    const syncBridge = createBridgeWithCapability({
      hasSharedArrayBuffer: true,
      hasAtomicsWait: true,
    })

    const s1 = syncBridge.callSync(SYSCALL_OP.FS_READ, new Uint8Array())
    const s2 = syncBridge.callSync(SYSCALL_OP.FS_WRITE, new Uint8Array())
    expect([s1.seq, s2.seq]).toEqual([0, 1])

    const asyncBridge = createBridgeWithCapability({
      hasSharedArrayBuffer: false,
      hasAtomicsWait: false,
    })
    const a1 = await asyncBridge.callAsync(SYSCALL_OP.FS_READ, new Uint8Array())
    const a2 = await asyncBridge.callAsync(SYSCALL_OP.FS_WRITE, new Uint8Array())
    expect([a1.seq, a2.seq]).toEqual([0, 1])
  })

  test('m1-7 createBridge defaults to async fallback when SAB is unavailable', () => {
    const scope = globalThis as typeof globalThis & {
      SharedArrayBuffer?: typeof SharedArrayBuffer
      Atomics: {
        wait?: typeof Atomics.wait
      }
    }

    const originalSharedArrayBuffer = scope.SharedArrayBuffer
    const originalWait = Atomics.wait

    Object.defineProperty(scope, 'SharedArrayBuffer', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(Atomics, 'wait', {
      configurable: true,
      value: undefined,
    })

    try {
      const bridge = createBridge({} as MessagePort)
      expect(bridge.isAsync).toBe(true)
      expect(() => bridge.callSync(SYSCALL_OP.FS_READ, new Uint8Array([9]))).toThrow(
        'Synchronous syscall is unavailable in async fallback mode',
      )
    } finally {
      Object.defineProperty(scope, 'SharedArrayBuffer', {
        configurable: true,
        value: originalSharedArrayBuffer,
      })
      Object.defineProperty(Atomics, 'wait', {
        configurable: true,
        value: originalWait,
      })
    }
  })
})
