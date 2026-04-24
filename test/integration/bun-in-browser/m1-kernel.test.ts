import { describe, expect, test } from 'bun:test'
import { Kernel } from '../../../packages/bun-web-kernel/src/kernel'
import { VFS } from '../../../packages/bun-web-vfs/src/overlay-fs'
import { bootstrapProcessWorker } from '../../../packages/bun-web-runtime/src/process-bootstrap'

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
})
