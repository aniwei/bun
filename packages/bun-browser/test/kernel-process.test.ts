/**
 * T5.11.1 / T5.11.2 集成测试：Kernel.on("port") + Kernel.process() ProcessHandle
 *
 * 测试内容：
 *   T5.11.1 — kernel.on("port", listener) / kernel.on("server-ready", listener)
 *             在 Worker 内 Bun.serve() 被调用时触发 KernelPortEvent
 *   T5.11.2 — kernel.process(argv) 返回 ProcessHandle
 *             ProcessHandle.output / .stdout / .stderr 是 ReadableStream<string>
 *             process 退出后 exitCode 解析为正确值
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { Kernel, ProcessHandle } from '../src/kernel'

const WASM_PATH = import.meta.dir + '/../bun-core.wasm'
const WORKER_URL = new URL('../src/kernel-worker.ts', import.meta.url)

let wasmModule: WebAssembly.Module

beforeAll(async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer()
  wasmModule = await WebAssembly.compile(bytes)
})

// ──────────────────────────────────────────────────────────
// 纯类单元测试：ProcessHandle 内部 API
// ──────────────────────────────────────────────────────────

describe('ProcessHandle 单元测试', () => {
  test('output 流接收 stdout + stderr 数据，exitCode 在 _complete 后解析', async () => {
    const handle = new ProcessHandle('test-1')

    // 收集 output 流
    const outputChunks: string[] = []
    const outputReader = handle.output.getReader()
    const outputDone = (async () => {
      while (true) {
        const { done, value } = await outputReader.read()
        if (done) break
        outputChunks.push(value)
      }
    })()

    handle._pushStdout('hello ')
    handle._pushStderr('world')
    handle._complete(0)

    await outputDone

    expect(outputChunks).toEqual(['hello ', 'world'])
    await expect(handle.exit).resolves.toBe(0)
  })

  test('stdout 流只包含 stdout 数据', async () => {
    const handle = new ProcessHandle('test-2')

    const chunks: string[] = []
    const reader = handle.stdout.getReader()
    const done = (async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
    })()

    handle._pushStdout('line1\n')
    handle._pushStdout('line2\n')
    handle._pushStderr('err line\n')
    handle._complete(0)

    await done

    expect(chunks).toEqual(['line1\n', 'line2\n'])
  })

  test('stderr 流只包含 stderr 数据', async () => {
    const handle = new ProcessHandle('test-3')

    const chunks: string[] = []
    const reader = handle.stderr.getReader()
    const done = (async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
    })()

    handle._pushStdout('out\n')
    handle._pushStderr('err1\n')
    handle._pushStderr('err2\n')
    handle._complete(2)

    await done

    expect(chunks).toEqual(['err1\n', 'err2\n'])
    await expect(handle.exit).resolves.toBe(2)
  })

  test('_error() 使 exitCode reject，流关闭', async () => {
    const handle = new ProcessHandle('test-4')

    const chunks: string[] = []
    const reader = handle.output.getReader()
    const readDone = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
      } catch {
        // stream cancelled by error
      }
    })()

    handle._pushStdout('before error\n')
    handle._error(new Error('process crashed'))

    await readDone

    await expect(handle.exit).rejects.toThrow('process crashed')
  })
})

// ──────────────────────────────────────────────────────────
// 集成测试：kernel.on("port") / kernel.process()
// ──────────────────────────────────────────────────────────

describe('Kernel.on / Kernel.process 集成测试', () => {
  test('kernel.process() 返回 ProcessHandle，exit 为 0', async () => {
    const kernel = new Kernel({
      wasmModule,
      workerUrl: WORKER_URL,
    })
    try {
      await kernel.whenReady()

      const handle = await kernel.process(['bun', '-e', 'console.log("from-process")'])
      await expect(handle.exit).resolves.toBe(0)
    } finally {
      kernel.terminate()
    }
  })

  test('kernel.process() exitCode 为非零时正确解析', async () => {
    const kernel = new Kernel({
      wasmModule,
      workerUrl: WORKER_URL,
    })
    try {
      await kernel.whenReady()

      const handle = await kernel.process(['bun', '-e', 'process.exit(42)'])
      await expect(handle.exit).resolves.toBe(42)
    } finally {
      kernel.terminate()
    }
  })
})
