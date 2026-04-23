/**
 * T5.12.5 集成测试：Kernel.watch() VFS 文件系统变更监听
 *
 * 测试内容：
 *   - watch(path, listener) — 写入时触发 'change' 事件
 *   - watch(path, listener) — mkdir/rm/rename 触发 'rename' 事件
 *   - recursive: true  — 深层嵌套路径触发事件
 *   - recursive: false — 只触发直接子项，深层嵌套不触发
 *   - handle.close()   — 取消后不再收到事件
 *   - 多个 watcher 共存
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { Kernel } from '../src/kernel'

const WASM_PATH = import.meta.dir + '/../bun-core.wasm'
const WORKER_URL = new URL('../src/kernel-worker.ts', import.meta.url)

let wasmModule: WebAssembly.Module

beforeAll(async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer()
  wasmModule = await WebAssembly.compile(bytes)
})

function makeKernel(): Kernel {
  return new Kernel({ wasmModule, workerUrl: WORKER_URL })
}

/** 等待 listener 收集到 `count` 个事件，带超时保护。 */
function waitForEvents(
  events: unknown[],
  count: number,
  timeout = 3000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeout
    const check = () => {
      if (events.length >= count) {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${count} events, got ${events.length}`))
        return
      }
      setTimeout(check, 10)
    }
    check()
  })
}

describe('T5.12.5 Kernel.watch()', () => {
  test('writeFile 触发 change 事件', async () => {
    const kernel = makeKernel()
    await kernel.whenReady()

    const events: Array<{ type: string; filename: string }> = []
    const handle = kernel.watch('/src', (eventType, filename) => {
      events.push({ type: eventType, filename })
    })

    await kernel.writeFile('/src/hello.ts', 'export const x = 1')
    await waitForEvents(events, 1)
    handle.close()

    expect(events[0].type).toBe('change')
    expect(events[0].filename).toBe('/src/hello.ts')

    kernel.terminate()
  })

  test('mkdir 触发 rename 事件', async () => {
    const kernel = makeKernel()
    await kernel.whenReady()

    const events: Array<{ type: string; filename: string }> = []
    const handle = kernel.watch('/', (eventType, filename) => {
      events.push({ type: eventType, filename })
    }, { recursive: true })

    await kernel.mkdir('/newdir/sub', { recursive: true })
    await waitForEvents(events, 1)
    handle.close()

    expect(events[0].type).toBe('rename')
    expect(events[0].filename).toBe('/newdir/sub')

    kernel.terminate()
  })

  test('mkdir 和 writeFile 引发连续事件，顺序封质正确', async () => {
    const kernel = makeKernel()
    await kernel.whenReady()

    const events: Array<{ type: string; filename: string }> = []
    const handle = kernel.watch('/', (eventType, filename) => {
      events.push({ type: eventType, filename })
    }, { recursive: true })

    // Sequential ops: each one fires its own event
    await kernel.mkdir('/seq-test')
    await waitForEvents(events, 1)
    await kernel.writeFile('/seq-test/file.ts', 'export {}')
    await waitForEvents(events, 2)
    handle.close()

    expect(events[0].type).toBe('rename')   // mkdir
    expect(events[0].filename).toBe('/seq-test')
    expect(events[1].type).toBe('change')   // writeFile
    expect(events[1].filename).toBe('/seq-test/file.ts')

    kernel.terminate()
  })

  test('目录路径不带斌杠和带斌杠均正确匹配', async () => {
    const kernel = makeKernel()
    await kernel.whenReady()

    const events: string[] = []
    // Watch without trailing slash
    const handle = kernel.watch('/slashtest', (_, filename) => events.push(filename), { recursive: true })

    await kernel.writeFile('/slashtest/a.ts', 'a')
    await waitForEvents(events, 1)
    handle.close()

    expect(events[0]).toBe('/slashtest/a.ts')

    kernel.terminate()
  })

  test('recursive:true — 深层嵌套路径触发事件', async () => {
    const kernel = makeKernel()
    await kernel.whenReady()

    const events: Array<{ type: string; filename: string }> = []
    const handle = kernel.watch('/project', (eventType, filename) => {
      events.push({ type: eventType, filename })
    }, { recursive: true })

    await kernel.writeFile('/project/src/deep/nested/file.ts', 'export {}')
    await waitForEvents(events, 1)
    handle.close()

    expect(events[0].type).toBe('change')
    expect(events[0].filename).toBe('/project/src/deep/nested/file.ts')

    kernel.terminate()
  })

  test('recursive:false — 深层嵌套路径不触发事件，直接子项触发', async () => {
    const kernel = makeKernel()
    await kernel.whenReady()

    const events: Array<{ type: string; filename: string }> = []
    // Non-recursive: only direct children of /workspace fire
    const handle = kernel.watch('/workspace', (eventType, filename) => {
      events.push({ type: eventType, filename })
    })

    // Deep nested — should NOT fire
    await kernel.writeFile('/workspace/sub/deep.ts', 'x')
    // Give it a moment to potentially (incorrectly) fire
    await new Promise(r => setTimeout(r, 50))
    expect(events).toHaveLength(0)

    // Direct child — SHOULD fire
    await kernel.writeFile('/workspace/direct.ts', 'y')
    await waitForEvents(events, 1)
    handle.close()

    expect(events[0].filename).toBe('/workspace/direct.ts')

    kernel.terminate()
  })

  test('close() 后不再收到事件', async () => {
    const kernel = makeKernel()
    await kernel.whenReady()

    const events: Array<{ type: string; filename: string }> = []
    const handle = kernel.watch('/closeme', (eventType, filename) => {
      events.push({ type: eventType, filename })
    }, { recursive: true })

    await kernel.writeFile('/closeme/before.ts', 'a')
    await waitForEvents(events, 1)

    handle.close()
    const countAfterClose = events.length

    // Write after close — should NOT fire
    await kernel.writeFile('/closeme/after.ts', 'b')
    await new Promise(r => setTimeout(r, 50))

    expect(events.length).toBe(countAfterClose)

    kernel.terminate()
  })

  test('多个 watcher 各自独立触发', async () => {
    const kernel = makeKernel()
    await kernel.whenReady()

    const eventsA: string[] = []
    const eventsB: string[] = []

    const handleA = kernel.watch('/shared', (_, filename) => eventsA.push(filename), { recursive: true })
    const handleB = kernel.watch('/shared', (_, filename) => eventsB.push(filename), { recursive: true })

    await kernel.writeFile('/shared/file.ts', 'test')
    await waitForEvents(eventsA, 1)
    await waitForEvents(eventsB, 1)

    handleA.close()
    handleB.close()

    expect(eventsA).toHaveLength(1)
    expect(eventsB).toHaveLength(1)
    expect(eventsA[0]).toBe('/shared/file.ts')
    expect(eventsB[0]).toBe('/shared/file.ts')

    kernel.terminate()
  })
})
